use crate::{
    activities::{
        ActivityHost, ActivityKind, ActivityLaunchSpec, ActivityOrigin, ActivityRecord,
        ActivityRetention, ActivityStatus, ActivitySupervisor, ActivityTitleSource,
        ActivityWorkspaceScope, SpawnActivityRequest,
    },
    agent_packages::{self, AgentRunPlan, AgentRunRequest},
    launchers::{
        self, AgentDefinition, DetectedAgent, LauncherKind, LauncherPreset, ResolvedLaunch,
        WorkingDirectory,
    },
    persistence::{
        load_json_optional_quarantining, write_bytes_atomic, write_json_atomic, QuarantinedLoad,
    },
    routines::{
        load_catalog, reconcile_tick, source_revision, validate_definition, RoutineCatalog,
        RoutineDefinition, RoutineDiagnostic, RoutineOverlap, RoutinePlannerState, RoutineSkip,
        RoutineSource, RoutineTick,
    },
};
use chrono::{DateTime, Utc};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Mutex, MutexGuard,
    },
    thread,
    time::Duration,
};
use tauri::Emitter;
use uuid::Uuid;

pub const ROUTINES_CHANGED_EVENT: &str = "mimir://routines-changed";
const DEFAULT_MCP_URL: &str = "http://127.0.0.1:17532/mcp";
const ROUTINE_COLS: u16 = 100;
const ROUTINE_ROWS: u16 = 30;
const MEETING_TRANSCRIPT_PATH_ENV: &str = "MIMIR_MEETING_TRANSCRIPT_PATH";
const MEETING_OUTPUT_PATH_ENV: &str = "MIMIR_MEETING_OUTPUT_PATH";

#[derive(Debug, Clone)]
pub struct RoutineRuntimeConfig {
    pub routines_dir: PathBuf,
    pub planner_state_path: PathBuf,
    pub launcher_config_path: PathBuf,
    pub home_path: PathBuf,
    pub default_shell: PathBuf,
    pub tick_interval: Duration,
    pub mcp_url: String,
}

impl Default for RoutineRuntimeConfig {
    fn default() -> Self {
        let home_path = dirs::home_dir().unwrap_or_else(std::env::temp_dir);
        let mimir_dir = home_path.join(".mimir");
        Self {
            routines_dir: mimir_dir.join("routines"),
            planner_state_path: mimir_dir.join("routines-state.json"),
            launcher_config_path: mimir_dir.join("launchers.json"),
            home_path,
            default_shell: launchers::default_shell_path(),
            tick_interval: Duration::from_secs(1),
            mcp_url: std::env::var("MIMIR_MCP_URL").unwrap_or_else(|_| DEFAULT_MCP_URL.into()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineRuntimeEntry {
    #[serde(flatten)]
    pub definition: RoutineDefinition,
    pub available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_fire: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<String>,
    #[serde(default)]
    pub running_activity_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    pub path: String,
    pub source_revision: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineRuntimeCatalog {
    pub directory: String,
    pub state_path: String,
    pub revision: u64,
    pub routines: Vec<RoutineRuntimeEntry>,
    pub diagnostics: Vec<RoutineDiagnostic>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_tick: Option<RoutineTick>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineRunResult {
    pub activity: ActivityRecord,
    pub scheduled_for: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPackageRunResult {
    pub activity: ActivityRecord,
}

/// Exact, durable Activity launch requested by a finalized meeting job.
///
/// The transcript is never interpolated into a shell command. The prompt is
/// one argv item produced by the existing headless agent adapter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MeetingHookLaunch {
    pub meeting_id: String,
    pub hook_id: String,
    pub transcript_revision: u64,
    pub title: String,
    pub prompt: String,
    pub preset_id: Option<String>,
    pub workspace: String,
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineChangedEvent {
    pub catalog: RoutineRuntimeCatalog,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tick: Option<RoutineTick>,
}

pub trait RoutineEventSink: Send + Sync + 'static {
    fn publish(&self, event: &RoutineChangedEvent);
}

impl RoutineEventSink for mpsc::Sender<RoutineChangedEvent> {
    fn publish(&self, event: &RoutineChangedEvent) {
        let _ = self.send(event.clone());
    }
}

pub struct TauriRoutineSink {
    app: tauri::AppHandle,
}

impl TauriRoutineSink {
    pub fn install(app: &tauri::AppHandle, runtime: &RoutineRuntime) -> u64 {
        runtime.subscribe(Arc::new(Self { app: app.clone() }))
    }
}

impl RoutineEventSink for TauriRoutineSink {
    fn publish(&self, event: &RoutineChangedEvent) {
        let _ = self.app.emit(ROUTINES_CHANGED_EVENT, event);
    }
}

#[derive(Clone)]
pub struct RoutineRuntime {
    inner: Arc<RoutineRuntimeInner>,
}

struct RoutineRuntimeInner {
    config: RoutineRuntimeConfig,
    supervisor: ActivitySupervisor,
    state: Mutex<RuntimeState>,
    launching: Mutex<HashMap<String, usize>>,
    sinks: Mutex<BTreeMap<u64, Arc<dyn RoutineEventSink>>>,
    next_sink_id: AtomicU64,
    worker_stop: Mutex<Option<mpsc::Sender<()>>>,
}

struct RuntimeState {
    catalog: RoutineCatalog,
    resolved: BTreeMap<String, ResolvedRoutine>,
    unavailable: BTreeMap<String, String>,
    planner: RoutinePlannerState,
    revision: u64,
    fingerprint: String,
    last_tick: Option<RoutineTick>,
    last_errors: BTreeMap<String, String>,
}

#[derive(Debug, Clone)]
struct ResolvedRoutine {
    definition: RoutineDefinition,
    launch: ResolvedLaunch,
    args: Vec<String>,
    workspace_scope: ActivityWorkspaceScope,
}

struct LaunchReservation {
    inner: Arc<RoutineRuntimeInner>,
    routine_id: String,
}

impl Drop for LaunchReservation {
    fn drop(&mut self) {
        let mut launching = lock(&self.inner.launching);
        if let Some(count) = launching.get_mut(&self.routine_id) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                launching.remove(&self.routine_id);
            }
        }
    }
}

impl RoutineRuntime {
    pub fn new(
        config: RoutineRuntimeConfig,
        supervisor: ActivitySupervisor,
    ) -> Result<Self, String> {
        fs::create_dir_all(&config.routines_dir).map_err(|error| {
            format!(
                "Could not create routines directory {}: {error}",
                config.routines_dir.display()
            )
        })?;

        let (planner, planner_diagnostic) = match load_json_optional_quarantining::<
            RoutinePlannerState,
        >(&config.planner_state_path)
        .map_err(|error| error.to_string())?
        {
            QuarantinedLoad::Loaded(planner) => (planner, None),
            QuarantinedLoad::Missing => (RoutinePlannerState::default(), None),
            QuarantinedLoad::Quarantined { path, reason } => (
                RoutinePlannerState::default(),
                Some(RoutineDiagnostic {
                    path: config.planner_state_path.to_string_lossy().into_owned(),
                    field: None,
                    message: format!(
                        "Invalid planner state was moved to {}: {reason}",
                        path.display()
                    ),
                }),
            ),
        };

        let (mut catalog, resolved, unavailable, fingerprint) = load_consistent_inputs(&config)?;
        if let Some(diagnostic) = planner_diagnostic {
            catalog.diagnostics.push(diagnostic);
        }

        Ok(Self {
            inner: Arc::new(RoutineRuntimeInner {
                config,
                supervisor,
                state: Mutex::new(RuntimeState {
                    catalog,
                    resolved,
                    unavailable,
                    planner,
                    revision: 1,
                    fingerprint,
                    last_tick: None,
                    last_errors: BTreeMap::new(),
                }),
                launching: Mutex::new(HashMap::new()),
                sinks: Mutex::new(BTreeMap::new()),
                next_sink_id: AtomicU64::new(1),
                worker_stop: Mutex::new(None),
            }),
        })
    }

    pub fn start(&self) -> Result<(), String> {
        let (stop_tx, stop_rx) = mpsc::channel();
        {
            let mut worker_stop = lock(&self.inner.worker_stop);
            if worker_stop.is_some() {
                return Ok(());
            }
            *worker_stop = Some(stop_tx);
        }

        let runtime = self.clone();
        thread::Builder::new()
            .name("mimir-routine-runtime".into())
            .spawn(move || runtime.worker_loop(stop_rx))
            .map_err(|error| {
                lock(&self.inner.worker_stop).take();
                format!("Could not start routine runtime: {error}")
            })?;
        Ok(())
    }

    pub fn stop_background(&self) {
        if let Some(stop) = lock(&self.inner.worker_stop).take() {
            let _ = stop.send(());
        }
    }

    pub fn subscribe(&self, sink: Arc<dyn RoutineEventSink>) -> u64 {
        let id = self.inner.next_sink_id.fetch_add(1, Ordering::Relaxed);
        lock(&self.inner.sinks).insert(id, sink);
        id
    }

    pub fn unsubscribe(&self, id: u64) -> bool {
        lock(&self.inner.sinks).remove(&id).is_some()
    }

    pub fn catalog(&self) -> RoutineRuntimeCatalog {
        self.catalog_snapshot()
    }

    pub fn reload(&self) -> Result<RoutineRuntimeCatalog, String> {
        self.reload_at(Utc::now())
    }

    pub fn create_definition(
        &self,
        definition: RoutineDefinition,
    ) -> Result<RoutineRuntimeCatalog, String> {
        validate_definition(&definition).map_err(definition_error)?;
        self.refresh_if_changed()?;
        let path = self
            .inner
            .config
            .routines_dir
            .join(format!("{}.toml", definition.id));
        {
            let state = lock(&self.inner.state);
            if state.catalog.sources.contains_key(&definition.id) || path.exists() {
                return Err(format!("Routine '{}' already exists.", definition.id));
            }
        }
        write_new_definition(&path, &definition)?;
        self.reload()
    }

    pub fn update_definition(
        &self,
        routine_id: &str,
        expected_revision: &str,
        definition: RoutineDefinition,
    ) -> Result<RoutineRuntimeCatalog, String> {
        if definition.id != routine_id {
            return Err(
                "A routine id cannot be changed in place. Duplicate it with a new id instead."
                    .into(),
            );
        }
        validate_definition(&definition).map_err(definition_error)?;
        let source = self.checked_source(routine_id, expected_revision)?;
        write_definition(Path::new(&source.path), &definition)?;
        self.reload()
    }

    pub fn duplicate_definition(
        &self,
        routine_id: &str,
        expected_revision: &str,
        new_id: String,
        title: Option<String>,
    ) -> Result<RoutineRuntimeCatalog, String> {
        self.checked_source(routine_id, expected_revision)?;
        let mut definition = {
            let state = lock(&self.inner.state);
            state
                .catalog
                .routines
                .iter()
                .find(|routine| routine.id == routine_id)
                .cloned()
                .ok_or_else(|| format!("Routine '{routine_id}' was not found."))?
        };
        // Copies are deliberately paused: duplicating a scheduled definition must
        // never create an accidental second automatic fire.
        definition.id = new_id;
        definition.title = title
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| format!("{} copy", definition.title));
        definition.enabled = false;
        self.create_definition(definition)
    }

    pub fn trash_definition(
        &self,
        routine_id: &str,
        expected_revision: &str,
    ) -> Result<RoutineRuntimeCatalog, String> {
        self.trash_definition_with(routine_id, expected_revision, |path| {
            trash::delete(path).map_err(|error| {
                format!(
                    "Could not move routine definition {} to the Trash: {error}",
                    path.display()
                )
            })
        })
    }

    fn trash_definition_with(
        &self,
        routine_id: &str,
        expected_revision: &str,
        move_to_trash: impl FnOnce(&Path) -> Result<(), String>,
    ) -> Result<RoutineRuntimeCatalog, String> {
        let source = self.checked_source(routine_id, expected_revision)?;
        move_to_trash(Path::new(&source.path))?;
        self.reload()
    }

    pub fn reveal(&self, routine_id: Option<&str>) -> Result<(), String> {
        self.refresh_if_changed()?;
        let target = match routine_id {
            Some(routine_id) => PathBuf::from(self.source_for(routine_id)?.path),
            None => self.inner.config.routines_dir.clone(),
        };
        reveal_path(&target, routine_id.is_some())
    }

    pub(crate) fn reload_at(
        &self,
        observed_at: DateTime<Utc>,
    ) -> Result<RoutineRuntimeCatalog, String> {
        self.reload_inputs()?;
        self.tick_at(observed_at)?;
        Ok(self.catalog_snapshot())
    }

    pub fn run_now(&self, routine_id: &str) -> Result<RoutineRunResult, String> {
        self.refresh_if_changed()?;
        let resolved = {
            let state = lock(&self.inner.state);
            state
                .resolved
                .get(routine_id)
                .cloned()
                .ok_or_else(|| unavailable_message(&state, routine_id))?
        };
        let scheduled_for = Utc::now().to_rfc3339();
        let _reservation = self
            .reserve_launch(&resolved.definition)
            .ok_or_else(|| format!("Routine '{routine_id}' already has an active run."))?;

        match self.spawn_routine(&resolved, &scheduled_for) {
            Ok(activity) => {
                self.set_last_error(routine_id, None);
                self.publish(None);
                Ok(RoutineRunResult {
                    activity,
                    scheduled_for,
                })
            }
            Err(error) => {
                self.set_last_error(routine_id, Some(error.clone()));
                self.publish(None);
                Err(error)
            }
        }
    }

    pub fn run_agent_package(
        &self,
        request: AgentRunRequest,
    ) -> Result<AgentPackageRunResult, String> {
        let plan = agent_packages::resolve(&self.inner.config.home_path, &request)?;
        let loaded = launchers::load_config(&self.inner.config.launcher_config_path)?;
        let presets = loaded
            .presets
            .into_iter()
            .map(|preset| (preset.id.clone(), preset))
            .collect::<BTreeMap<_, _>>();
        let definition = RoutineDefinition {
            id: format!("agent-{}", plan.name),
            title: plan.title.clone(),
            enabled: true,
            schedule: None,
            timezone: "UTC".into(),
            agent: Some(plan.name.clone()),
            preset: String::new(),
            prompt: String::new(),
            overlap: RoutineOverlap::Parallel,
            missed: Default::default(),
            workspace: Some(plan.workspace.to_string_lossy().into_owned()),
            interactive: plan.interactive,
        };
        let resolved = resolve_agent_plan(definition, plan, &presets, &self.inner.config)
            .map_err(definition_error)?;
        self.spawn_agent_package(&resolved)
            .map(|activity| AgentPackageRunResult { activity })
    }

    /// Launch a one-shot meeting follow-up through the same exact-argv,
    /// executable-resolution, PTY, and durable persistence path as Routines.
    pub fn launch_meeting_hook(
        &self,
        request: MeetingHookLaunch,
    ) -> Result<ActivityRecord, String> {
        validate_meeting_hook(&request)?;
        let loaded = launchers::load_config(&self.inner.config.launcher_config_path)?;
        let presets = loaded
            .presets
            .into_iter()
            .map(|preset| (preset.id.clone(), preset))
            .collect::<BTreeMap<_, _>>();
        let resolved = if let Some(preset_id) = request
            .preset_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            resolve_meeting_hook(&request, preset_id, &presets, &self.inner.config)?
        } else {
            presets
                .values()
                .filter(|preset| {
                    preset.kind == LauncherKind::Agent
                        && preset.agent_id.as_deref().is_some_and(|agent| {
                            matches!(agent, "codex" | "claude" | "pi")
                        })
                })
                .find_map(|preset| {
                    resolve_meeting_hook(&request, &preset.id, &presets, &self.inner.config).ok()
                })
                .ok_or_else(|| {
                    "No installed headless Codex, Claude, or Pi launcher is available for the meeting follow-up. Configure one under CLI tools."
                        .to_string()
                })?
        };
        self.spawn_meeting_hook(&resolved, &request)
    }

    pub(crate) fn tick_at(&self, observed_at: DateTime<Utc>) -> Result<RoutineTick, String> {
        let running = self.running_routine_ids();
        let (mut tick, resolved, planner_changed) = {
            let mut state = lock(&self.inner.state);
            let previous_planner = state.planner.clone();
            let catalog = state.catalog.clone();
            let mut next_planner = state.planner.clone();
            let mut tick = reconcile_tick(&catalog, &mut next_planner, observed_at, &running);

            let mut unavailable_fires = Vec::new();
            tick.fires.retain(|fire| {
                if state.resolved.contains_key(&fire.routine_id) {
                    true
                } else {
                    unavailable_fires.push(fire.clone());
                    false
                }
            });
            tick.skips
                .extend(unavailable_fires.into_iter().map(|fire| RoutineSkip {
                    routine_id: fire.routine_id,
                    scheduled_for: fire.scheduled_for,
                    reason: "routine-unavailable".into(),
                }));

            let planner_changed = previous_planner != next_planner;
            if planner_changed {
                write_json_atomic(&self.inner.config.planner_state_path, &next_planner)
                    .map_err(|error| error.to_string())?;
                state.planner = next_planner;
                state.revision = state.revision.saturating_add(1);
            }

            let resolved = tick
                .fires
                .iter()
                .filter_map(|fire| {
                    state
                        .resolved
                        .get(&fire.routine_id)
                        .cloned()
                        .map(|resolved| (fire.clone(), resolved))
                })
                .collect::<Vec<_>>();
            (tick, resolved, planner_changed)
        };

        for (fire, routine) in resolved {
            let Some(_reservation) = self.reserve_launch(&routine.definition) else {
                tick.skips.push(RoutineSkip {
                    routine_id: fire.routine_id.clone(),
                    scheduled_for: fire.scheduled_for.clone(),
                    reason: "previous-run-active".into(),
                });
                tick.fires
                    .retain(|candidate| candidate.routine_id != fire.routine_id);
                continue;
            };
            match self.spawn_routine(&routine, &fire.scheduled_for) {
                Ok(_) => self.set_last_error(&routine.definition.id, None),
                Err(error) => self.set_last_error(&routine.definition.id, Some(error)),
            }
        }

        let has_outcome = !tick.fires.is_empty() || !tick.skips.is_empty();
        if has_outcome {
            let mut state = lock(&self.inner.state);
            state.last_tick = Some(tick.clone());
            state.revision = state.revision.saturating_add(1);
        }
        if planner_changed || has_outcome {
            self.publish(Some(tick.clone()));
        }
        Ok(tick)
    }

    fn worker_loop(&self, stop_rx: mpsc::Receiver<()>) {
        loop {
            if let Err(error) = self.poll_once(Utc::now()) {
                self.record_runtime_error(error);
            }
            match stop_rx.recv_timeout(self.inner.config.tick_interval) {
                Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        }
    }

    fn poll_once(&self, observed_at: DateTime<Utc>) -> Result<(), String> {
        let changed = {
            let fingerprint = input_fingerprint(&self.inner.config)?;
            fingerprint != lock(&self.inner.state).fingerprint
        };
        if changed {
            self.reload_inputs()?;
        }
        self.tick_at(observed_at)?;
        Ok(())
    }

    fn refresh_if_changed(&self) -> Result<(), String> {
        let fingerprint = input_fingerprint(&self.inner.config)?;
        if fingerprint != lock(&self.inner.state).fingerprint {
            self.reload_inputs()?;
        }
        Ok(())
    }

    fn source_for(&self, routine_id: &str) -> Result<RoutineSource, String> {
        lock(&self.inner.state)
            .catalog
            .sources
            .get(routine_id)
            .cloned()
            .ok_or_else(|| format!("Routine '{routine_id}' was not found."))
    }

    fn checked_source(
        &self,
        routine_id: &str,
        expected_revision: &str,
    ) -> Result<RoutineSource, String> {
        self.refresh_if_changed()?;
        let source = self.source_for(routine_id)?;
        if expected_revision.trim().is_empty() {
            return Err(format!(
                "Routine '{routine_id}' is missing its source revision. Reload before changing it."
            ));
        }
        let contents = fs::read(&source.path).map_err(|error| {
            format!("Could not read routine definition {}: {error}", source.path)
        })?;
        let current_revision = source_revision(&contents);
        if current_revision != expected_revision {
            return Err(format!(
                "Routine '{routine_id}' changed on disk. Reload it before saving your changes."
            ));
        }
        Ok(source)
    }

    fn reload_inputs(&self) -> Result<(), String> {
        let (catalog, resolved, unavailable, fingerprint) =
            load_consistent_inputs(&self.inner.config)?;
        let valid_ids = catalog
            .routines
            .iter()
            .map(|routine| routine.id.clone())
            .collect::<HashSet<_>>();
        {
            let mut state = lock(&self.inner.state);
            state.catalog = catalog;
            state.resolved = resolved;
            state.unavailable = unavailable;
            state
                .last_errors
                .retain(|routine_id, _| valid_ids.contains(routine_id));
            state.fingerprint = fingerprint;
            state.revision = state.revision.saturating_add(1);
        }
        self.publish(None);
        Ok(())
    }

    fn reserve_launch(&self, routine: &RoutineDefinition) -> Option<LaunchReservation> {
        let running_in_supervisor = self
            .inner
            .supervisor
            .list()
            .into_iter()
            .any(|record| is_live_routine(&record, &routine.id));
        let mut launching = lock(&self.inner.launching);
        let in_flight = launching.get(&routine.id).copied().unwrap_or(0);
        if routine.overlap == RoutineOverlap::Skip && (running_in_supervisor || in_flight > 0) {
            return None;
        }
        *launching.entry(routine.id.clone()).or_default() += 1;
        Some(LaunchReservation {
            inner: self.inner.clone(),
            routine_id: routine.id.clone(),
        })
    }

    fn running_routine_ids(&self) -> HashSet<String> {
        let mut ids = self
            .inner
            .supervisor
            .list()
            .into_iter()
            .filter_map(|record| {
                let routine_id = record.source.routine_id.clone()?;
                is_live_routine(&record, &routine_id).then_some(routine_id)
            })
            .collect::<HashSet<_>>();
        ids.extend(
            lock(&self.inner.launching)
                .iter()
                .filter(|(_, count)| **count > 0)
                .map(|(routine_id, _)| routine_id.clone()),
        );
        ids
    }

    fn spawn_routine(
        &self,
        resolved: &ResolvedRoutine,
        scheduled_for: &str,
    ) -> Result<ActivityRecord, String> {
        let refreshed;
        let resolved = if resolved.definition.agent.is_some() {
            let loaded = launchers::load_config(&self.inner.config.launcher_config_path)?;
            let presets = loaded
                .presets
                .into_iter()
                .map(|preset| (preset.id.clone(), preset))
                .collect::<BTreeMap<_, _>>();
            refreshed = resolve_routine(&resolved.definition, &presets, &self.inner.config)
                .map_err(definition_error)?;
            &refreshed
        } else {
            resolved
        };
        let activity_id = format!("routine:{}:{}", resolved.definition.id, Uuid::new_v4());
        let now = Utc::now().to_rfc3339();
        let agent_id = resolved.launch.agent_id.as_deref();
        let mcp_url = activity_mcp_url(
            &self.inner.config.mcp_url,
            &activity_id,
            agent_id.unwrap_or(&resolved.launch.preset_id),
            &resolved.launch.cwd,
        );
        let mut env = resolved.launch.env.clone();
        env.insert("MIMIR_ACTIVITY_ID".into(), activity_id.clone());
        env.insert(
            "MIMIR_AGENT_ID".into(),
            agent_id.unwrap_or(&resolved.launch.preset_id).into(),
        );
        env.insert("MIMIR_MCP_URL".into(), mcp_url.clone());
        env.insert("MIMIR_ROUTINE_ID".into(), resolved.definition.id.clone());
        env.insert("MIMIR_ROUTINE_SCHEDULED_FOR".into(), scheduled_for.into());
        let args = resolved
            .args
            .iter()
            .map(|argument| argument.replace(&self.inner.config.mcp_url, &mcp_url))
            .collect();

        let record = ActivityRecord {
            id: activity_id,
            kind: ActivityKind::Routine,
            title: resolved.definition.title.clone(),
            title_source: ActivityTitleSource::Manual,
            legacy_auto_title_eligible: None,
            workspace_path: match resolved.workspace_scope {
                ActivityWorkspaceScope::Workspace => resolved.definition.workspace.clone(),
                ActivityWorkspaceScope::Global => None,
            },
            status: ActivityStatus::Ready,
            created_at: now.clone(),
            updated_at: now,
            last_viewed_at: None,
            archived_at: None,
            close_requested_at: None,
            retention: ActivityRetention::Durable,
            source: ActivityOrigin {
                launcher_id: resolved.launch.agent_id.clone(),
                preset_id: Some(resolved.launch.preset_id.clone()),
                workspace_scope: Some(resolved.workspace_scope),
                routine_id: Some(resolved.definition.id.clone()),
                scheduled_for: Some(scheduled_for.into()),
                ..ActivityOrigin::default()
            },
            host: ActivityHost::pty(resolved.launch.agent_id.clone()),
            launch: Some(ActivityLaunchSpec {
                command: resolved.launch.command.clone(),
                args,
                cwd: Some(resolved.launch.cwd.clone()),
                env,
            }),
            session: None,
            error: None,
        };
        self.inner
            .supervisor
            .spawn(
                SpawnActivityRequest::new(record, ROUTINE_COLS, ROUTINE_ROWS)
                    .with_cli_session_id(resolved.launch.cli_session_id.clone()),
            )
            .map(|snapshot| snapshot.record)
            .map_err(|error| {
                format!(
                    "Could not launch routine '{}': {error}",
                    resolved.definition.title
                )
            })
    }

    fn spawn_agent_package(&self, resolved: &ResolvedRoutine) -> Result<ActivityRecord, String> {
        let activity_id = format!(
            "agent:{}:{}",
            resolved.definition.agent.as_deref().unwrap_or("package"),
            Uuid::new_v4()
        );
        let now = Utc::now().to_rfc3339();
        let agent_id = resolved.launch.agent_id.as_deref();
        let mcp_url = activity_mcp_url(
            &self.inner.config.mcp_url,
            &activity_id,
            agent_id.unwrap_or(&resolved.launch.preset_id),
            &resolved.launch.cwd,
        );
        let mut env = resolved.launch.env.clone();
        env.insert("MIMIR_ACTIVITY_ID".into(), activity_id.clone());
        env.insert(
            "MIMIR_AGENT_ID".into(),
            agent_id.unwrap_or(&resolved.launch.preset_id).into(),
        );
        env.insert("MIMIR_MCP_URL".into(), mcp_url.clone());
        env.insert(
            "MIMIR_AGENT_PACKAGE".into(),
            resolved.definition.agent.clone().unwrap_or_default(),
        );
        let args = resolved
            .args
            .iter()
            .map(|argument| argument.replace(&self.inner.config.mcp_url, &mcp_url))
            .collect();
        let record = ActivityRecord {
            id: activity_id,
            kind: ActivityKind::Agent,
            title: resolved.definition.title.clone(),
            title_source: ActivityTitleSource::Manual,
            legacy_auto_title_eligible: None,
            workspace_path: resolved.definition.workspace.clone(),
            status: ActivityStatus::Ready,
            created_at: now.clone(),
            updated_at: now,
            last_viewed_at: None,
            archived_at: None,
            close_requested_at: None,
            retention: ActivityRetention::Durable,
            source: ActivityOrigin {
                launcher_id: resolved.launch.agent_id.clone(),
                preset_id: Some(resolved.launch.preset_id.clone()),
                workspace_scope: Some(resolved.workspace_scope),
                ..ActivityOrigin::default()
            },
            host: ActivityHost::pty(resolved.launch.agent_id.clone()),
            launch: Some(ActivityLaunchSpec {
                command: resolved.launch.command.clone(),
                args,
                cwd: Some(resolved.launch.cwd.clone()),
                env,
            }),
            session: None,
            error: None,
        };
        self.inner
            .supervisor
            .spawn(
                SpawnActivityRequest::new(record, ROUTINE_COLS, ROUTINE_ROWS)
                    .with_cli_session_id(resolved.launch.cli_session_id.clone()),
            )
            .map(|snapshot| snapshot.record)
            .map_err(|error| format!("Could not launch agent package: {error}"))
    }

    fn spawn_meeting_hook(
        &self,
        resolved: &ResolvedRoutine,
        request: &MeetingHookLaunch,
    ) -> Result<ActivityRecord, String> {
        let activity_id = format!(
            "meeting:{}:{}:{}",
            request.meeting_id,
            request.hook_id,
            Uuid::new_v4()
        );
        let now = Utc::now().to_rfc3339();
        let agent_id = resolved.launch.agent_id.as_deref();
        let mut env = resolved.launch.env.clone();
        env.extend(request.env.clone());
        // Meeting hooks operate through controlled files. General Mimir tool
        // access would let transcript-driven output bypass KG review and
        // mutate native state.
        env.remove("MIMIR_MCP_URL");
        env.insert("MIMIR_ACTIVITY_ID".into(), activity_id.clone());
        env.insert(
            "MIMIR_AGENT_ID".into(),
            agent_id.unwrap_or(&resolved.launch.preset_id).into(),
        );
        env.insert("MIMIR_MEETING_ID".into(), request.meeting_id.clone());
        env.insert("MIMIR_MEETING_HOOK_ID".into(), request.hook_id.clone());
        env.insert(
            "MIMIR_MEETING_TRANSCRIPT_REVISION".into(),
            request.transcript_revision.to_string(),
        );
        let args = without_mimir_tool_connection(
            agent_id.unwrap_or(&resolved.launch.preset_id),
            &resolved.args,
        );
        let record = ActivityRecord {
            id: activity_id,
            kind: ActivityKind::Routine,
            title: request.title.trim().to_string(),
            title_source: ActivityTitleSource::Manual,
            legacy_auto_title_eligible: None,
            workspace_path: match resolved.workspace_scope {
                ActivityWorkspaceScope::Workspace => Some(request.workspace.clone()),
                ActivityWorkspaceScope::Global => None,
            },
            status: ActivityStatus::Ready,
            created_at: now.clone(),
            updated_at: now,
            last_viewed_at: None,
            archived_at: None,
            close_requested_at: None,
            retention: ActivityRetention::Durable,
            source: ActivityOrigin {
                launcher_id: resolved.launch.agent_id.clone(),
                preset_id: Some(resolved.launch.preset_id.clone()),
                workspace_scope: Some(resolved.workspace_scope),
                meeting_id: Some(request.meeting_id.clone()),
                meeting_hook_id: Some(request.hook_id.clone()),
                meeting_transcript_revision: Some(request.transcript_revision),
                ..ActivityOrigin::default()
            },
            host: ActivityHost::pty(resolved.launch.agent_id.clone()),
            launch: Some(ActivityLaunchSpec {
                command: resolved.launch.command.clone(),
                args,
                cwd: Some(resolved.launch.cwd.clone()),
                env,
            }),
            session: None,
            error: None,
        };
        self.inner
            .supervisor
            .spawn(
                SpawnActivityRequest::new(record, ROUTINE_COLS, ROUTINE_ROWS)
                    .with_cli_session_id(resolved.launch.cli_session_id.clone()),
            )
            .map(|snapshot| snapshot.record)
            .map_err(|error| format!("Could not launch meeting follow-up: {error}"))
    }

    fn set_last_error(&self, routine_id: &str, error: Option<String>) {
        let mut state = lock(&self.inner.state);
        let changed = match error {
            Some(error) => {
                if state.last_errors.get(routine_id) == Some(&error) {
                    false
                } else {
                    state.last_errors.insert(routine_id.into(), error);
                    true
                }
            }
            None => state.last_errors.remove(routine_id).is_some(),
        };
        if changed {
            state.revision = state.revision.saturating_add(1);
        }
    }

    fn record_runtime_error(&self, error: String) {
        let diagnostic = RoutineDiagnostic {
            path: self
                .inner
                .config
                .routines_dir
                .to_string_lossy()
                .into_owned(),
            field: None,
            message: format!("Routine runtime: {error}"),
        };
        {
            let mut state = lock(&self.inner.state);
            if !state.catalog.diagnostics.contains(&diagnostic) {
                state.catalog.diagnostics.push(diagnostic);
                state.revision = state.revision.saturating_add(1);
            } else {
                return;
            }
        }
        self.publish(None);
    }

    fn catalog_snapshot(&self) -> RoutineRuntimeCatalog {
        let running = self.running_activity_ids();
        let state = lock(&self.inner.state);
        RoutineRuntimeCatalog {
            directory: state.catalog.directory.clone(),
            state_path: self
                .inner
                .config
                .planner_state_path
                .to_string_lossy()
                .into_owned(),
            revision: state.revision,
            routines: state
                .catalog
                .routines
                .iter()
                .cloned()
                .map(|definition| {
                    let routine_id = definition.id.clone();
                    let source = state.catalog.sources.get(&routine_id);
                    RoutineRuntimeEntry {
                        available: state.resolved.contains_key(&routine_id),
                        next_fire: state.planner.next_fires.get(&routine_id).cloned(),
                        diagnostic: state.unavailable.get(&routine_id).cloned(),
                        running_activity_ids: running.get(&routine_id).cloned().unwrap_or_default(),
                        last_error: state.last_errors.get(&routine_id).cloned(),
                        path: source.map(|source| source.path.clone()).unwrap_or_default(),
                        source_revision: source
                            .map(|source| source.revision.clone())
                            .unwrap_or_default(),
                        definition,
                    }
                })
                .collect(),
            diagnostics: state.catalog.diagnostics.clone(),
            last_tick: state.last_tick.clone(),
        }
    }

    fn running_activity_ids(&self) -> BTreeMap<String, Vec<String>> {
        let mut running = BTreeMap::<String, Vec<String>>::new();
        for record in self.inner.supervisor.list() {
            let Some(routine_id) = record.source.routine_id.clone() else {
                continue;
            };
            if is_live_routine(&record, &routine_id) {
                running
                    .entry(routine_id)
                    .or_default()
                    .push(record.id.clone());
            }
        }
        for ids in running.values_mut() {
            ids.sort();
        }
        running
    }

    fn publish(&self, tick: Option<RoutineTick>) {
        let event = RoutineChangedEvent {
            catalog: self.catalog_snapshot(),
            tick,
        };
        let sinks = lock(&self.inner.sinks)
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for sink in sinks {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                sink.publish(&event);
            }));
        }
    }
}

fn activity_mcp_url(base: &str, activity_id: &str, agent_id: &str, cwd: &str) -> String {
    let Ok(mut url) = url::Url::parse(base) else {
        return base.to_string();
    };
    let mut pairs = url
        .query_pairs()
        .filter(|(key, _)| key != "activityId" && key != "agentId" && key != "cwd")
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    pairs.push(("activityId".into(), activity_id.into()));
    pairs.push(("agentId".into(), agent_id.into()));
    pairs.push(("cwd".into(), cwd.into()));
    url.set_query(None);
    url.query_pairs_mut().extend_pairs(pairs);
    url.into()
}

fn definition_error((field, message): (String, String)) -> String {
    format!("Invalid routine {field}: {message}")
}

fn write_definition(path: &Path, definition: &RoutineDefinition) -> Result<(), String> {
    let contents = definition_contents(definition)?;
    write_bytes_atomic(path, &contents).map_err(|error| {
        format!(
            "Could not save routine definition {}: {error}",
            path.display()
        )
    })
}

fn write_new_definition(path: &Path, definition: &RoutineDefinition) -> Result<(), String> {
    let contents = definition_contents(definition)?;
    let parent = path
        .parent()
        .ok_or_else(|| "The routines directory could not be resolved.".to_string())?;
    fs::create_dir_all(parent).map_err(|error| {
        format!(
            "Could not create routines directory {}: {error}",
            parent.display()
        )
    })?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "The routine definition filename is not valid UTF-8.".to_string())?;
    let pending = parent.join(format!(".{name}.new-{}", Uuid::new_v4()));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&pending)
            .map_err(|error| format!("Could not stage routine definition: {error}"))?;
        file.write_all(&contents)
            .map_err(|error| format!("Could not stage routine definition: {error}"))?;
        file.flush()
            .map_err(|error| format!("Could not flush routine definition: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("Could not sync routine definition: {error}"))?;
        fs::hard_link(&pending, path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                format!("Routine '{}' already exists.", definition.id)
            } else {
                format!(
                    "Could not publish routine definition {}: {error}",
                    path.display()
                )
            }
        })?;
        #[cfg(unix)]
        fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| {
                format!(
                    "Could not sync routines directory {}: {error}",
                    parent.display()
                )
            })?;
        Ok(())
    })();
    let _ = fs::remove_file(&pending);
    result
}

fn definition_contents(definition: &RoutineDefinition) -> Result<Vec<u8>, String> {
    let mut contents = toml::to_string_pretty(definition)
        .map_err(|error| format!("Could not serialize routine '{}': {error}", definition.id))?
        .into_bytes();
    contents.push(b'\n');
    Ok(contents)
}

fn reveal_path(target: &Path, select_file: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        if select_file {
            command.arg("-R");
        }
        command.arg(target);
        command
    };
    #[cfg(target_os = "linux")]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(if select_file {
            target.parent().unwrap_or(target)
        } else {
            target
        });
        command
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("explorer");
        if select_file {
            command.arg("/select,");
        }
        command.arg(target);
        command
    };

    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not reveal {}: {error}", target.display()))
}

fn unavailable_message(state: &RuntimeState, routine_id: &str) -> String {
    if let Some(message) = state.unavailable.get(routine_id) {
        return format!("Routine '{routine_id}' is unavailable: {message}");
    }
    format!("Routine '{routine_id}' was not found.")
}

fn is_live_routine(record: &ActivityRecord, routine_id: &str) -> bool {
    record.source.routine_id.as_deref() == Some(routine_id)
        && record
            .session
            .as_ref()
            .is_some_and(|session| session.exit.is_none())
}

type ResolvedCatalog = (
    RoutineCatalog,
    BTreeMap<String, ResolvedRoutine>,
    BTreeMap<String, String>,
);

type ConsistentInputs = (
    RoutineCatalog,
    BTreeMap<String, ResolvedRoutine>,
    BTreeMap<String, String>,
    String,
);

fn load_and_resolve(config: &RoutineRuntimeConfig) -> Result<ResolvedCatalog, String> {
    let mut catalog = load_catalog(&config.routines_dir);
    let presets = match launchers::load_config(&config.launcher_config_path) {
        Ok(response) => {
            if let Some(message) = response.diagnostic {
                catalog.diagnostics.push(RoutineDiagnostic {
                    path: config.launcher_config_path.to_string_lossy().into_owned(),
                    field: None,
                    message,
                });
            }
            response.presets
        }
        Err(message) => {
            catalog.diagnostics.push(RoutineDiagnostic {
                path: config.launcher_config_path.to_string_lossy().into_owned(),
                field: None,
                message: format!(
                    "Launcher configuration is invalid; routine resolution is using defaults: {message}"
                ),
            });
            launchers::default_config().presets
        }
    }
    .into_iter()
        .map(|preset| (preset.id.clone(), preset))
        .collect::<BTreeMap<_, _>>();
    let mut resolved = BTreeMap::new();
    let mut unavailable = BTreeMap::new();

    for routine in &catalog.routines {
        match resolve_routine(routine, &presets, config) {
            Ok(value) => {
                resolved.insert(routine.id.clone(), value);
            }
            Err((field, message)) => {
                unavailable.insert(routine.id.clone(), message.clone());
                catalog.diagnostics.push(RoutineDiagnostic {
                    path: format!("routine:{}", routine.id),
                    field: Some(field),
                    message,
                });
            }
        }
    }
    Ok((catalog, resolved, unavailable))
}

fn load_consistent_inputs(config: &RoutineRuntimeConfig) -> Result<ConsistentInputs, String> {
    let mut recovery_diagnostics = Vec::new();
    for _ in 0..3 {
        let before = input_fingerprint(config)?;
        let (mut catalog, resolved, unavailable) = load_and_resolve(config)?;
        let after = input_fingerprint(config)?;
        if before == after {
            for diagnostic in recovery_diagnostics {
                if !catalog.diagnostics.contains(&diagnostic) {
                    catalog.diagnostics.push(diagnostic);
                }
            }
            return Ok((catalog, resolved, unavailable, after));
        }
        recovery_diagnostics.extend(
            catalog
                .diagnostics
                .into_iter()
                .filter(|diagnostic| diagnostic.message.contains("was moved to")),
        );
    }
    Err("Routine definitions kept changing while they were being loaded; retry shortly.".into())
}

fn resolve_routine(
    definition: &RoutineDefinition,
    presets: &BTreeMap<String, LauncherPreset>,
    config: &RoutineRuntimeConfig,
) -> Result<ResolvedRoutine, (String, String)> {
    if let Some(agent) = definition
        .agent
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let workspace = definition
            .workspace
            .as_deref()
            .map(PathBuf::from)
            .unwrap_or_else(|| config.home_path.clone());
        let plan = agent_packages::resolve(
            &config.home_path,
            &AgentRunRequest {
                name: agent.to_string(),
                workspace: workspace.to_string_lossy().into_owned(),
                args: Vec::new(),
                preset: None,
                interactive: definition.interactive,
                follow: false,
            },
        )
        .map_err(|message| ("agent".into(), message))?;
        return resolve_agent_plan(definition.clone(), plan, presets, config);
    }
    resolve_effective_routine(definition, &[], presets, config)
}

fn resolve_agent_plan(
    mut definition: RoutineDefinition,
    plan: AgentRunPlan,
    presets: &BTreeMap<String, LauncherPreset>,
    config: &RoutineRuntimeConfig,
) -> Result<ResolvedRoutine, (String, String)> {
    definition.preset = plan.preset.unwrap_or_else(|| default_agent_preset(presets));
    definition.prompt = plan.prompt;
    definition.interactive = plan.interactive;
    definition.workspace = Some(plan.workspace.to_string_lossy().into_owned());
    resolve_effective_routine(&definition, &plan.args, presets, config)
}

fn default_agent_preset(presets: &BTreeMap<String, LauncherPreset>) -> String {
    if presets
        .get("codex")
        .is_some_and(|preset| preset.enabled && preset.kind == LauncherKind::Agent)
    {
        return "codex".into();
    }
    for agent in launchers::agent_catalog() {
        if let Some(preset) = presets.values().find(|preset| {
            preset.enabled
                && preset.kind == LauncherKind::Agent
                && preset.agent_id.as_deref() == Some(agent.id.as_str())
        }) {
            return preset.id.clone();
        }
    }
    presets
        .values()
        .find(|preset| preset.enabled && preset.kind == LauncherKind::Agent)
        .map(|preset| preset.id.clone())
        .unwrap_or_else(|| "codex".into())
}

fn resolve_effective_routine(
    definition: &RoutineDefinition,
    extra_args: &[String],
    presets: &BTreeMap<String, LauncherPreset>,
    config: &RoutineRuntimeConfig,
) -> Result<ResolvedRoutine, (String, String)> {
    let preset = presets.get(&definition.preset).ok_or_else(|| {
        (
            "preset".into(),
            format!("Launcher preset '{}' does not exist.", definition.preset),
        )
    })?;
    let workspace_scope = if matches!(&preset.cwd, WorkingDirectory::Workspace) {
        ActivityWorkspaceScope::Workspace
    } else {
        ActivityWorkspaceScope::Global
    };
    if preset.kind != LauncherKind::Agent {
        return Err((
            "preset".into(),
            format!(
                "Launcher preset '{}' is a terminal; routines require an agent preset.",
                definition.preset
            ),
        ));
    }

    let agent_id = preset.agent_id.as_deref().ok_or_else(|| {
        (
            "preset".into(),
            format!("Launcher preset '{}' has no agent id.", definition.preset),
        )
    })?;
    let agent = launchers::agent_catalog()
        .into_iter()
        .find(|agent| agent.id == agent_id)
        .ok_or_else(|| {
            (
                "preset".into(),
                format!(
                    "Agent '{agent_id}' has no routine adapter; use codex, claude, pi, or gemini."
                ),
            )
        })?;

    let detected = if preset.binary.is_some() {
        Vec::new()
    } else {
        vec![detect_definition(agent.clone())]
    };
    let mut launch = launchers::resolve_launch(
        preset,
        &detected,
        definition.workspace.as_deref(),
        &config.home_path,
        &config.default_shell,
        &config.mcp_url,
    )
    .map_err(|message| {
        // "Open workspace" is workbench phrasing; a routine has no open
        // workspace, it carries its own. Reword so the fix is obvious.
        if message.contains("open workspace") {
            return (
                "workspace".into(),
                format!(
                    "Set a workspace for this routine — launcher '{}' runs inside one.",
                    preset.title
                ),
            );
        }
        let field = if message.contains("Working directory") {
            "workspace"
        } else {
            "binary"
        };
        (field.into(), message)
    })?;
    launch.command = resolve_executable(&launch.command, Path::new(&launch.cwd))
        .map_err(|message| ("binary".into(), message))?;
    launch.args.extend(extra_args.iter().cloned());
    let args = if definition.interactive {
        interactive_argv(agent_id, &launch.args, &definition.prompt)
    } else {
        headless_argv(agent_id, &launch.args, &definition.prompt)
    }
    .map_err(|message| ("preset".into(), message))?;

    Ok(ResolvedRoutine {
        definition: definition.clone(),
        launch,
        args,
        workspace_scope,
    })
}

fn validate_meeting_hook(request: &MeetingHookLaunch) -> Result<(), String> {
    for (label, value, maximum) in [
        ("meeting id", request.meeting_id.as_str(), 200),
        ("hook id", request.hook_id.as_str(), 80),
        ("activity title", request.title.as_str(), 200),
    ] {
        let value = value.trim();
        if value.is_empty() || value.chars().count() > maximum {
            return Err(format!(
                "Meeting follow-up {label} must contain 1 to {maximum} characters."
            ));
        }
        if label != "activity title"
            && !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        {
            return Err(format!(
                "Meeting follow-up {label} contains unsupported characters."
            ));
        }
    }
    if request.prompt.trim().is_empty() || request.prompt.len() > 200_000 {
        return Err("Meeting follow-up prompt must contain 1 to 200000 UTF-8 bytes.".to_string());
    }
    let workspace = Path::new(&request.workspace);
    if !workspace.is_absolute() || !workspace.is_dir() {
        return Err(
            "Meeting follow-up workspace must be an existing absolute directory.".to_string(),
        );
    }
    if request.env.keys().any(|key| {
        !matches!(
            key.as_str(),
            MEETING_TRANSCRIPT_PATH_ENV | MEETING_OUTPUT_PATH_ENV
        )
    }) || request.env.values().any(|value| value.contains('\0'))
    {
        return Err("Meeting follow-up environment contains an invalid key or value.".into());
    }
    Ok(())
}

fn resolve_meeting_hook(
    request: &MeetingHookLaunch,
    preset_id: &str,
    presets: &BTreeMap<String, LauncherPreset>,
    config: &RoutineRuntimeConfig,
) -> Result<ResolvedRoutine, String> {
    let definition = RoutineDefinition {
        id: format!("meeting-{}", request.hook_id),
        title: request.title.clone(),
        enabled: true,
        schedule: None,
        timezone: "UTC".into(),
        agent: None,
        preset: preset_id.into(),
        prompt: request.prompt.clone(),
        overlap: RoutineOverlap::Parallel,
        missed: Default::default(),
        workspace: Some(request.workspace.clone()),
        interactive: false,
    };
    let mut resolved = resolve_routine(&definition, presets, config)
        .map_err(|(field, message)| format!("Meeting follow-up {field}: {message}"))?;
    reject_shell_meeting_hook(&resolved.launch.command)?;
    let agent_id = resolved.launch.agent_id.as_deref().unwrap_or_default();
    resolved.args = confined_meeting_hook_args(agent_id, &resolved.args)?;
    reject_unconfined_meeting_hook(agent_id, &resolved.args)?;
    Ok(resolved)
}

fn reject_shell_meeting_hook(command: &str) -> Result<(), String> {
    let executable = Path::new(command)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if matches!(
        executable.as_str(),
        "sh" | "bash"
            | "zsh"
            | "fish"
            | "dash"
            | "ksh"
            | "csh"
            | "tcsh"
            | "pwsh"
            | "powershell"
            | "powershell.exe"
            | "cmd"
            | "cmd.exe"
            | "env"
    ) {
        return Err(
            "Meeting follow-up binary must be a direct agent executable, not a shell or command interpreter."
                .into(),
        );
    }
    Ok(())
}

fn reject_unconfined_meeting_hook(agent_id: &str, arguments: &[String]) -> Result<(), String> {
    let unsafe_flag = arguments.iter().enumerate().any(|(index, argument)| {
        let following = arguments.get(index + 1).map(String::as_str);
        match agent_id {
            "codex" => {
                matches!(
                    argument.as_str(),
                    "--yolo" | "--dangerously-bypass-approvals-and-sandbox" | "--add-dir" | "-C"
                ) || argument.starts_with("--add-dir=")
                    || argument.starts_with("--cd=")
                    || matches!(argument.as_str(), "--sandbox" | "-s")
                        && following == Some("danger-full-access")
                    || argument == "--sandbox=danger-full-access"
            }
            "claude" => {
                matches!(
                    argument.as_str(),
                    "--dangerously-skip-permissions" | "--add-dir"
                ) || argument.starts_with("--add-dir=")
                    || argument == "--permission-mode=bypassPermissions"
                    || argument == "--permission-mode" && following == Some("bypassPermissions")
            }
            _ => false,
        }
    });
    if unsafe_flag {
        return Err(
            "Meeting follow-up preset disables confinement or grants access outside its private job directory. Use a sandboxed preset for Scribe hooks."
                .into(),
        );
    }
    Ok(())
}

/// Build a hook-only argv from an ordinary launcher preset.
///
/// Launcher presets are user-facing terminal defaults and commonly include
/// `--yolo`. A meeting transcript is untrusted input, so a durable hook must
/// not inherit those authority-expanding flags. Codex hooks instead run in an
/// ephemeral workspace-write sandbox rooted at the private job directory. We
/// preserve only an explicit model choice; auth remains available even while
/// user configuration, hooks, MCP servers, and extra writable roots are not.
fn confined_meeting_hook_args(agent_id: &str, arguments: &[String]) -> Result<Vec<String>, String> {
    let arguments = without_mimir_tool_connection(agent_id, arguments);
    if agent_id != "codex" {
        reject_unconfined_meeting_hook(agent_id, &arguments)?;
        return Ok(arguments);
    }
    let (prompt, options) = arguments
        .split_last()
        .ok_or_else(|| "Meeting follow-up is missing its prompt argument.".to_string())?;
    if options.first().map(String::as_str) != Some("exec") {
        return Err("Meeting follow-up Codex adapter did not select exec mode.".into());
    }

    let mut model = None;
    let mut index = 1;
    while index < options.len() {
        match options[index].as_str() {
            "-m" | "--model" => {
                let value = options.get(index + 1).ok_or_else(|| {
                    "Meeting follow-up Codex model option is missing its value.".to_string()
                })?;
                model = Some(value.clone());
                index += 2;
            }
            value if value.starts_with("--model=") => {
                model = value.strip_prefix("--model=").map(str::to_string);
                index += 1;
            }
            _ => index += 1,
        }
    }

    let mut confined = vec![
        "exec".into(),
        "--ignore-user-config".into(),
        "--sandbox".into(),
        "workspace-write".into(),
        "--skip-git-repo-check".into(),
        "--ephemeral".into(),
        "--color".into(),
        "never".into(),
    ];
    if let Some(model) = model {
        confined.extend(["--model".into(), model]);
    }
    confined.push(prompt.clone());
    Ok(confined)
}

fn without_mimir_tool_connection(agent_id: &str, arguments: &[String]) -> Vec<String> {
    let mut filtered = Vec::with_capacity(arguments.len());
    let mut index = 0;
    while index < arguments.len() {
        let argument = &arguments[index];
        let following = arguments.get(index + 1);
        let remove_pair = match agent_id {
            "codex" => {
                argument == "-c"
                    && following.is_some_and(|value| value.contains("mcp_servers.mimir_workbench."))
            }
            "claude" => {
                argument == "--mcp-config"
                    && following.is_some_and(|value| value.contains("\"mimir_workbench\""))
            }
            "pi" => {
                argument == "--extension"
                    && following.is_some_and(|value| {
                        value
                            .replace('\\', "/")
                            .ends_with("/.mimir/pi/mimir-tools.ts")
                    })
            }
            _ => false,
        };
        if remove_pair {
            index += 2;
            continue;
        }
        if argument.contains("mcp_servers.mimir_workbench.") {
            index += 1;
            continue;
        }
        filtered.push(argument.clone());
        index += 1;
    }
    filtered
}

fn detect_definition(definition: AgentDefinition) -> DetectedAgent {
    match launchers::detect_binary(&definition.binary) {
        Ok(path) => DetectedAgent {
            definition,
            installed: true,
            binary_path: Some(path),
            version: None,
            diagnostic: None,
        },
        Err(diagnostic) => DetectedAgent {
            definition,
            installed: false,
            binary_path: None,
            version: None,
            diagnostic: Some(diagnostic),
        },
    }
}

fn resolve_executable(command: &str, cwd: &Path) -> Result<String, String> {
    if command.trim().is_empty() || command.contains('\0') {
        return Err("Routine binary must be a non-empty executable path.".into());
    }
    let path = Path::new(command);
    if path.is_absolute() {
        validate_executable(path)?;
        return Ok(path.to_string_lossy().into_owned());
    }

    let has_path_component = path
        .components()
        .any(|component| !matches!(component, Component::Normal(_)));
    if has_path_component || path.components().count() > 1 {
        let candidate = cwd.join(path);
        validate_executable(&candidate)?;
        return Ok(candidate.to_string_lossy().into_owned());
    }

    launchers::detect_binary(command)
}

fn validate_executable(path: &Path) -> Result<(), String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Routine binary {} is unavailable: {error}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!("Routine binary {} is not a file.", path.display()));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return Err(format!(
                "Routine binary {} is not executable.",
                path.display()
            ));
        }
    }
    Ok(())
}

pub(crate) fn headless_argv(
    agent_id: &str,
    preset_args: &[String],
    prompt: &str,
) -> Result<Vec<String>, String> {
    let mut args = preset_args.to_vec();
    match agent_id {
        "codex" => {
            if args.first().map(String::as_str) != Some("exec") {
                args.insert(0, "exec".into());
            }
        }
        "claude" | "pi" => {
            if !args
                .iter()
                .any(|argument| matches!(argument.as_str(), "--print" | "-p"))
            {
                args.insert(0, "--print".into());
            }
        }
        other => {
            return Err(format!(
                "Agent '{other}' has no headless routine adapter; use codex, claude, or pi."
            ))
        }
    }
    args.push(prompt.into());
    Ok(args)
}

/// Argv for an interactive routine run: the agent opens its ordinary live
/// session with the routine prompt as the opening message, so the user can
/// keep talking to it in the terminal surface.
pub(crate) fn interactive_argv(
    agent_id: &str,
    preset_args: &[String],
    prompt: &str,
) -> Result<Vec<String>, String> {
    let mut args = preset_args.to_vec();
    match agent_id {
        // These CLIs treat a positional argument as the opening message of
        // an interactive session.
        "codex" | "claude" | "pi" => {}
        // Gemini one-shots a positional prompt; --prompt-interactive keeps
        // the session open after answering it. Pushed last so it wins over
        // any conflicting preset flag.
        "gemini" => args.push("--prompt-interactive".into()),
        other => {
            let message = format!(
                "Agent '{other}' has no interactive routine adapter; use codex, claude, pi, or gemini."
            );
            return Err(message);
        }
    }
    args.push(prompt.into());
    Ok(args)
}

/// Fingerprint the routine inputs from file metadata (path, mtime, size)
/// instead of file contents. This runs on every planner tick, so a quiet tick
/// must not read and hash every routine file. Tradeoff: an edit that preserves
/// both the size and the mtime (below the filesystem's timestamp granularity)
/// is not detected until an explicit reload; every ordinary save changes the
/// mtime and therefore still changes the fingerprint.
fn input_fingerprint(config: &RoutineRuntimeConfig) -> Result<String, String> {
    let mut hasher = Sha256::new();
    hasher.update(b"mimir-routine-inputs-v2\0");

    let mut routine_paths = fs::read_dir(&config.routines_dir)
        .map_err(|error| {
            format!(
                "Could not inspect routines directory {}: {error}",
                config.routines_dir.display()
            )
        })?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("toml"))
        .collect::<Vec<_>>();
    routine_paths.sort();
    for path in routine_paths {
        hasher.update(path.to_string_lossy().as_bytes());
        hasher.update(b"\0");
        let metadata = fs::metadata(&path).map_err(|error| {
            format!("Could not fingerprint routine {}: {error}", path.display())
        })?;
        hash_file_signature(&mut hasher, &metadata);
        hasher.update(b"\0");
    }

    hasher.update(config.launcher_config_path.to_string_lossy().as_bytes());
    match fs::metadata(&config.launcher_config_path) {
        Ok(metadata) => hash_file_signature(&mut hasher, &metadata),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            hasher.update(b"<default-launchers>")
        }
        Err(error) => {
            return Err(format!(
                "Could not fingerprint launcher configuration {}: {error}",
                config.launcher_config_path.display()
            ))
        }
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn hash_file_signature(hasher: &mut Sha256, metadata: &fs::Metadata) {
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .unwrap_or_default();
    hasher.update(modified.as_secs().to_le_bytes());
    hasher.update(modified.subsec_nanos().to_le_bytes());
    hasher.update(metadata.len().to_le_bytes());
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[tauri::command]
pub fn routine_catalog(runtime: tauri::State<'_, RoutineRuntime>) -> RoutineRuntimeCatalog {
    runtime.catalog()
}

#[tauri::command]
pub async fn routine_reload(
    runtime: tauri::State<'_, RoutineRuntime>,
) -> Result<RoutineRuntimeCatalog, String> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || runtime.reload())
        .await
        .map_err(|error| format!("Routine reload task failed: {error}"))?
}

#[tauri::command]
pub async fn routine_run_now(
    runtime: tauri::State<'_, RoutineRuntime>,
    routine_id: String,
) -> Result<RoutineRunResult, String> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || runtime.run_now(&routine_id))
        .await
        .map_err(|error| format!("Routine launch task failed: {error}"))?
}

#[tauri::command]
pub async fn agent_run(
    runtime: tauri::State<'_, RoutineRuntime>,
    request: AgentRunRequest,
) -> Result<AgentPackageRunResult, String> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || runtime.run_agent_package(request))
        .await
        .map_err(|error| format!("Agent package launch task failed: {error}"))?
}

#[tauri::command]
pub async fn agent_list(
    runtime: tauri::State<'_, RoutineRuntime>,
    workspace: String,
) -> Result<Vec<agent_packages::AgentPackageDescriptor>, String> {
    let home = runtime.inner().inner.config.home_path.clone();
    tauri::async_runtime::spawn_blocking(move || agent_packages::list(&home, Path::new(&workspace)))
        .await
        .map_err(|error| format!("Agent package list task failed: {error}"))?
}

#[tauri::command]
pub async fn scope_inventory(
    runtime: tauri::State<'_, RoutineRuntime>,
    workspace: String,
) -> Result<Vec<agent_packages::ScopeInventoryEntry>, String> {
    let home = runtime.inner().inner.config.home_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        agent_packages::inventory(&home, Path::new(&workspace))
    })
    .await
    .map_err(|error| format!("Scope inventory task failed: {error}"))?
}

#[tauri::command]
pub async fn routine_create(
    runtime: tauri::State<'_, RoutineRuntime>,
    definition: RoutineDefinition,
) -> Result<RoutineRuntimeCatalog, String> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || runtime.create_definition(definition))
        .await
        .map_err(|error| format!("Routine creation task failed: {error}"))?
}

#[tauri::command]
pub async fn routine_update(
    runtime: tauri::State<'_, RoutineRuntime>,
    routine_id: String,
    expected_revision: String,
    definition: RoutineDefinition,
) -> Result<RoutineRuntimeCatalog, String> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        runtime.update_definition(&routine_id, &expected_revision, definition)
    })
    .await
    .map_err(|error| format!("Routine update task failed: {error}"))?
}

#[tauri::command]
pub async fn routine_duplicate(
    runtime: tauri::State<'_, RoutineRuntime>,
    routine_id: String,
    expected_revision: String,
    new_id: String,
    title: Option<String>,
) -> Result<RoutineRuntimeCatalog, String> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        runtime.duplicate_definition(&routine_id, &expected_revision, new_id, title)
    })
    .await
    .map_err(|error| format!("Routine duplication task failed: {error}"))?
}

#[tauri::command]
pub async fn routine_trash(
    runtime: tauri::State<'_, RoutineRuntime>,
    routine_id: String,
    expected_revision: String,
) -> Result<RoutineRuntimeCatalog, String> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        runtime.trash_definition(&routine_id, &expected_revision)
    })
    .await
    .map_err(|error| format!("Routine trash task failed: {error}"))?
}

#[tauri::command]
pub fn routine_reveal(
    runtime: tauri::State<'_, RoutineRuntime>,
    routine_id: Option<String>,
) -> Result<(), String> {
    runtime.reveal(routine_id.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        activities::{ActivitySupervisorConfig, SessionExitReason},
        launchers::{LauncherPreset, WorkingDirectory},
        routines::MissedFirePolicy,
    };
    use chrono::TimeZone;
    use std::time::{Duration, Instant};
    use tempfile::TempDir;

    struct Harness {
        root: TempDir,
        workspace: PathBuf,
        binary: PathBuf,
        supervisor: ActivitySupervisor,
        config: RoutineRuntimeConfig,
    }

    impl Harness {
        #[cfg(unix)]
        fn new() -> Self {
            use std::os::unix::fs::PermissionsExt;

            let root = tempfile::tempdir().unwrap();
            let workspace = root.path().join("workspace");
            fs::create_dir_all(&workspace).unwrap();
            let binary = root.path().join("fake-agent");
            fs::write(
                &binary,
                b"#!/bin/sh\nprintf 'arg=%s\\n' \"$@\"\nprintf 'mcp=%s\\n' \"$MIMIR_MCP_URL\"\n",
            )
            .unwrap();
            fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).unwrap();

            let supervisor = ActivitySupervisor::new(ActivitySupervisorConfig::new(
                root.path().join("activities"),
            ))
            .unwrap();
            let config = RoutineRuntimeConfig {
                routines_dir: root.path().join("routines"),
                planner_state_path: root.path().join("routines-state.json"),
                launcher_config_path: root.path().join("launchers.json"),
                home_path: root.path().to_path_buf(),
                default_shell: PathBuf::from("/bin/sh"),
                tick_interval: Duration::from_secs(60),
                mcp_url: "http://127.0.0.1:29999/mcp".into(),
            };
            fs::create_dir_all(&config.routines_dir).unwrap();
            Self {
                root,
                workspace,
                binary,
                supervisor,
                config,
            }
        }

        fn routine(&self) -> RoutineDefinition {
            RoutineDefinition {
                id: "daily-review".into(),
                title: "Daily review".into(),
                enabled: true,
                schedule: Some("* * * * *".into()),
                timezone: "UTC".into(),
                agent: None,
                preset: "review-agent".into(),
                prompt: "Review the work tree and report sharp findings.".into(),
                overlap: RoutineOverlap::Skip,
                missed: MissedFirePolicy::RunOnce,
                workspace: Some(self.workspace.to_string_lossy().into_owned()),
                interactive: false,
            }
        }

        fn preset(&self) -> LauncherPreset {
            LauncherPreset {
                id: "review-agent".into(),
                title: "Review agent".into(),
                kind: LauncherKind::Agent,
                enabled: true,
                agent_id: Some("codex".into()),
                binary: Some(self.binary.to_string_lossy().into_owned()),
                args: vec!["--model".into(), "gpt 5".into()],
                env: BTreeMap::from([("MIMIR_TEST_ENV".into(), "kept exactly".into())]),
                cwd: WorkingDirectory::Workspace,
            }
        }

        fn write_routine(&self, routine: &RoutineDefinition) {
            fs::write(
                self.config.routines_dir.join("daily-review.toml"),
                toml::to_string_pretty(routine).unwrap(),
            )
            .unwrap();
        }

        fn write_presets(&self, presets: Vec<LauncherPreset>) {
            launchers::save_config(&self.config.launcher_config_path, presets).unwrap();
        }

        fn runtime(&self) -> RoutineRuntime {
            RoutineRuntime::new(self.config.clone(), self.supervisor.clone()).unwrap()
        }
    }

    #[test]
    fn input_fingerprint_tracks_file_set_size_and_mtime_changes() {
        use std::time::SystemTime;

        let root = tempfile::tempdir().unwrap();
        let config = RoutineRuntimeConfig {
            routines_dir: root.path().join("routines"),
            planner_state_path: root.path().join("routines-state.json"),
            launcher_config_path: root.path().join("launchers.json"),
            home_path: root.path().to_path_buf(),
            default_shell: PathBuf::from("/bin/sh"),
            tick_interval: Duration::from_secs(60),
            mcp_url: "http://127.0.0.1:29999/mcp".into(),
        };
        fs::create_dir_all(&config.routines_dir).unwrap();
        let empty = input_fingerprint(&config).unwrap();

        // A new routine file changes the fingerprint; non-toml files do not count.
        fs::write(config.routines_dir.join("notes.txt"), "ignored").unwrap();
        assert_eq!(input_fingerprint(&config).unwrap(), empty);
        let routine = config.routines_dir.join("daily.toml");
        fs::write(&routine, "one").unwrap();
        let with_routine = input_fingerprint(&config).unwrap();
        assert_ne!(with_routine, empty);

        // A size change is detected.
        fs::write(&routine, "one plus more").unwrap();
        let grown = input_fingerprint(&config).unwrap();
        assert_ne!(grown, with_routine);

        // A pure mtime change (identical size) is detected.
        let file = fs::File::options().write(true).open(&routine).unwrap();
        file.set_modified(SystemTime::now() + Duration::from_secs(7))
            .unwrap();
        drop(file);
        let touched = input_fingerprint(&config).unwrap();
        assert_ne!(touched, grown);

        // Quiet ticks are stable, and the launcher config participates too.
        assert_eq!(input_fingerprint(&config).unwrap(), touched);
        fs::write(&config.launcher_config_path, "{\"presets\":[]}").unwrap();
        assert_ne!(input_fingerprint(&config).unwrap(), touched);
    }

    #[test]
    fn headless_adapters_preserve_flags_and_keep_prompt_one_argv_item() {
        let prompt = "Review this tree; do not split me";
        assert_eq!(
            headless_argv("codex", &["--full-auto".into()], prompt).unwrap(),
            ["exec", "--full-auto", prompt]
        );
        assert_eq!(
            headless_argv("codex", &["exec".into(), "--json".into()], prompt).unwrap(),
            ["exec", "--json", prompt]
        );
        assert_eq!(
            headless_argv("claude", &["--model".into(), "opus".into()], prompt).unwrap(),
            ["--print", "--model", "opus", prompt]
        );
        assert_eq!(
            headless_argv("claude", &["-p".into(), "--verbose".into()], prompt).unwrap(),
            ["-p", "--verbose", prompt]
        );
        assert_eq!(
            headless_argv(
                "pi",
                &["--print".into(), "--provider".into(), "x".into()],
                prompt
            )
            .unwrap(),
            ["--print", "--provider", "x", prompt]
        );
        assert!(headless_argv("unknown", &[], prompt)
            .unwrap_err()
            .contains("no headless routine adapter"));
    }

    #[test]
    fn interactive_adapters_seed_the_live_session_with_one_prompt_argv_item() {
        let prompt = "Morning briefing; do not split me";
        assert_eq!(
            interactive_argv("codex", &["--full-auto".into()], prompt).unwrap(),
            ["--full-auto", prompt]
        );
        assert_eq!(
            interactive_argv("claude", &["--model".into(), "opus".into()], prompt).unwrap(),
            ["--model", "opus", prompt]
        );
        assert_eq!(interactive_argv("pi", &[], prompt).unwrap(), [prompt]);
        assert_eq!(
            interactive_argv("gemini", &[], prompt).unwrap(),
            ["--prompt-interactive", prompt]
        );
        assert!(interactive_argv("unknown", &[], prompt)
            .unwrap_err()
            .contains("no interactive routine adapter"));
    }

    #[test]
    fn agent_packages_fall_back_in_launcher_catalog_order() {
        let mut presets = launchers::default_config().presets;
        presets.retain(|preset| preset.kind == LauncherKind::Agent);
        presets
            .iter_mut()
            .find(|preset| preset.id == "codex")
            .unwrap()
            .enabled = false;
        presets
            .iter_mut()
            .find(|preset| preset.id == "claude")
            .unwrap()
            .enabled = false;
        let presets = presets
            .into_iter()
            .map(|preset| (preset.id.clone(), preset))
            .collect::<BTreeMap<_, _>>();

        assert_eq!(default_agent_preset(&presets), "pi");
    }

    #[test]
    fn agent_routine_resolves_the_current_package_at_launch_time() {
        let fixture = Harness::new();
        let package = fixture
            .root
            .path()
            .join(".mimir/private/agents/evidence-sweep");
        fs::create_dir_all(&package).unwrap();
        fs::write(
            package.join("AGENT.md"),
            "---\npreset: review-agent\nargs: [--package-flag]\n---\nFirst mission.\n",
        )
        .unwrap();
        let mut routine = fixture.routine();
        routine.agent = Some("evidence-sweep".into());
        routine.preset.clear();
        routine.prompt.clear();
        fixture.write_routine(&routine);
        fixture.write_presets(vec![fixture.preset()]);
        let runtime = fixture.runtime();

        fs::write(
            package.join("AGENT.md"),
            "---\npreset: review-agent\nargs: [--package-flag]\n---\nUpdated mission.\n",
        )
        .unwrap();
        let result = runtime.run_now("daily-review").unwrap();
        let launch = result.activity.launch.unwrap();

        assert_eq!(launch.args.first().map(String::as_str), Some("exec"));
        assert_eq!(launch.args[launch.args.len() - 2], "--package-flag");
        assert!(launch.args.last().unwrap().contains("Updated mission."));
        assert!(!launch.args.last().unwrap().contains("First mission."));
    }

    #[cfg(unix)]
    #[test]
    fn missing_preset_and_binary_are_visible_and_cannot_run() {
        let harness = Harness::new();
        let mut missing_preset = harness.routine();
        missing_preset.preset = "does-not-exist".into();
        harness.write_routine(&missing_preset);
        let runtime = harness.runtime();

        let catalog = runtime.catalog();
        assert_eq!(catalog.routines.len(), 1);
        assert!(!catalog.routines[0].available);
        assert!(catalog.routines[0]
            .diagnostic
            .as_deref()
            .unwrap()
            .contains("does not exist"));
        assert!(runtime
            .run_now("daily-review")
            .unwrap_err()
            .contains("unavailable"));

        let missing_binary = harness.root.path().join("never-installed-agent");
        let mut preset = harness.preset();
        preset.binary = Some(missing_binary.to_string_lossy().into_owned());
        harness.write_presets(vec![preset]);
        harness.write_routine(&harness.routine());
        runtime.reload().unwrap();

        let entry = &runtime.catalog().routines[0];
        assert!(!entry.available);
        assert!(entry.diagnostic.as_deref().unwrap().contains("unavailable"));
        assert!(runtime.run_now("daily-review").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn interactive_routine_launches_the_live_session_without_headless_flags() {
        let harness = Harness::new();
        harness.write_presets(vec![harness.preset()]);
        let mut routine = harness.routine();
        routine.interactive = true;
        harness.write_routine(&routine);
        let runtime = harness.runtime();

        let result = runtime.run_now("daily-review").unwrap();
        let launch = result.activity.launch.as_ref().unwrap();
        assert!(launch
            .args
            .iter()
            .all(|argument| argument != "exec" && argument != "--print" && argument != "-p"));
        assert_eq!(
            launch.args.last().map(String::as_str),
            Some("Review the work tree and report sharp findings.")
        );
    }

    #[test]
    fn workspace_preset_without_routine_workspace_reports_actionable_diagnostic() {
        let harness = Harness::new();
        harness.write_presets(vec![harness.preset()]);
        let mut routine = harness.routine();
        routine.workspace = None;
        harness.write_routine(&routine);
        let runtime = harness.runtime();

        let entry = &runtime.catalog().routines[0];
        assert!(!entry.available);
        let diagnostic = entry.diagnostic.as_deref().unwrap();
        assert!(diagnostic.contains("Set a workspace for this routine"));
        assert!(diagnostic.contains("Review agent"));
    }

    #[cfg(unix)]
    #[test]
    fn run_now_spawns_a_durable_routine_with_exact_argv_origin_and_mcp_env() {
        let harness = Harness::new();
        harness.write_presets(vec![harness.preset()]);
        harness.write_routine(&harness.routine());
        let runtime = harness.runtime();

        let result = runtime.run_now("daily-review").unwrap();
        assert_eq!(result.activity.kind, ActivityKind::Routine);
        assert_eq!(result.activity.retention, ActivityRetention::Durable);
        assert_eq!(
            result.activity.source.routine_id.as_deref(),
            Some("daily-review")
        );
        assert_eq!(
            result.activity.source.preset_id.as_deref(),
            Some("review-agent")
        );
        assert_eq!(result.activity.source.launcher_id.as_deref(), Some("codex"));
        assert_eq!(
            result.activity.source.workspace_scope,
            Some(ActivityWorkspaceScope::Workspace)
        );
        assert_eq!(
            result.activity.workspace_path.as_deref(),
            harness.workspace.to_str()
        );
        assert_eq!(
            result.activity.source.scheduled_for.as_deref(),
            Some(result.scheduled_for.as_str())
        );

        let launch = result.activity.launch.as_ref().unwrap();
        assert_eq!(launch.command, harness.binary.to_string_lossy());
        assert_eq!(&launch.args[..4], ["exec", "--model", "gpt 5", "-c"]);
        let scoped_mcp_url = activity_mcp_url(
            "http://127.0.0.1:29999/mcp",
            &result.activity.id,
            "codex",
            harness.workspace.to_str().unwrap(),
        );
        assert_eq!(
            launch.args[4],
            format!(
                "mcp_servers.mimir_workbench.url={}",
                serde_json::to_string(&scoped_mcp_url).unwrap()
            )
        );
        assert_eq!(
            &launch.args[5..7],
            ["-c", r#"notify=["mimir","internal","codex-notify"]"#]
        );
        assert_eq!(
            launch.args[7],
            "Review the work tree and report sharp findings."
        );
        assert_eq!(
            launch.env.get("MIMIR_TEST_ENV").map(String::as_str),
            Some("kept exactly")
        );
        assert_eq!(
            launch.env.get("MIMIR_MCP_URL").map(String::as_str),
            Some(scoped_mcp_url.as_str())
        );
        assert_eq!(
            launch.env.get("MIMIR_AGENT_ID").map(String::as_str),
            Some("codex")
        );
        assert_eq!(
            launch.env.get("MIMIR_ROUTINE_ID").map(String::as_str),
            Some("daily-review")
        );

        let ended = wait_for_end(
            &harness.supervisor,
            &result.activity.id,
            Duration::from_secs(3),
        );
        assert_eq!(
            ended.record.session.unwrap().exit.unwrap().reason,
            SessionExitReason::Completed
        );
        let output = ended
            .scrollback
            .chunks
            .iter()
            .flat_map(|chunk| chunk.bytes.iter().copied())
            .collect::<Vec<_>>();
        let output = String::from_utf8_lossy(&output);
        assert!(output.contains("arg=exec"));
        assert!(output.contains("arg=gpt 5"));
        assert!(output.contains("mcp=http://127.0.0.1:29999/mcp"));
    }

    #[cfg(unix)]
    #[test]
    fn agent_package_run_reaches_pty_output_and_clean_exit() {
        let harness = Harness::new();
        let package = harness.workspace.join("agents/evidence-sweep");
        fs::create_dir_all(&package).unwrap();
        fs::write(
            package.join("AGENT.md"),
            "---\npreset: review-agent\nargs: [--package-flag]\n---\nReview this evidence package.\n",
        )
        .unwrap();
        harness.write_presets(vec![harness.preset()]);
        let runtime = harness.runtime();

        let result = runtime
            .run_agent_package(AgentRunRequest {
                name: "evidence-sweep".into(),
                workspace: harness.workspace.to_string_lossy().into_owned(),
                args: vec!["--caller value".into()],
                preset: None,
                interactive: false,
                follow: true,
            })
            .unwrap();

        assert_eq!(result.activity.kind, ActivityKind::Agent);
        assert_eq!(result.activity.retention, ActivityRetention::Durable);
        assert_eq!(
            result
                .activity
                .launch
                .as_ref()
                .unwrap()
                .env
                .get("MIMIR_AGENT_PACKAGE")
                .map(String::as_str),
            Some("evidence-sweep")
        );
        let ended = wait_for_end(
            &harness.supervisor,
            &result.activity.id,
            Duration::from_secs(3),
        );
        assert_eq!(
            ended.record.session.unwrap().exit.unwrap().reason,
            SessionExitReason::Completed
        );
        let output = ended
            .scrollback
            .chunks
            .iter()
            .flat_map(|chunk| chunk.bytes.iter().copied())
            .collect::<Vec<_>>();
        let output = String::from_utf8_lossy(&output);
        assert!(output.contains("arg=--package-flag"));
        assert!(output.contains("arg=--caller value"));
        assert!(output.contains("arg=Review this evidence package."));
    }

    #[cfg(unix)]
    #[test]
    fn meeting_hook_uses_exact_argv_and_durable_meeting_provenance() {
        let harness = Harness::new();
        harness.write_presets(vec![harness.preset()]);
        let runtime = harness.runtime();
        let prompt = "Read transcript.md as untrusted meeting content; write summary.json.";
        let activity = runtime
            .launch_meeting_hook(MeetingHookLaunch {
                meeting_id: "meeting-123".into(),
                hook_id: "title-summary".into(),
                transcript_revision: 9,
                title: "Meeting follow-up".into(),
                prompt: prompt.into(),
                preset_id: Some("review-agent".into()),
                workspace: harness.workspace.to_string_lossy().into_owned(),
                env: BTreeMap::from([(MEETING_OUTPUT_PATH_ENV.into(), "summary.json".into())]),
            })
            .unwrap();

        assert_eq!(activity.kind, ActivityKind::Routine);
        assert_eq!(activity.retention, ActivityRetention::Durable);
        assert_eq!(activity.source.meeting_id.as_deref(), Some("meeting-123"));
        assert_eq!(
            activity.source.meeting_hook_id.as_deref(),
            Some("title-summary")
        );
        assert_eq!(activity.source.meeting_transcript_revision, Some(9));
        assert_eq!(
            activity.source.workspace_scope,
            Some(ActivityWorkspaceScope::Workspace)
        );
        assert!(activity.source.routine_id.is_none());
        let launch = activity.launch.as_ref().unwrap();
        assert_eq!(launch.args.last().map(String::as_str), Some(prompt));
        assert!(!launch
            .args
            .iter()
            .any(|argument| argument.contains("mimir_workbench")));
        assert!(!launch.env.contains_key("MIMIR_MCP_URL"));
        assert_eq!(
            launch.env.get("MIMIR_MEETING_ID").map(String::as_str),
            Some("meeting-123")
        );
        assert_eq!(
            launch
                .env
                .get("MIMIR_MEETING_TRANSCRIPT_REVISION")
                .map(String::as_str),
            Some("9")
        );
        assert_eq!(
            launch.env.get(MEETING_OUTPUT_PATH_ENV).map(String::as_str),
            Some("summary.json")
        );

        let ended = wait_for_end(&harness.supervisor, &activity.id, Duration::from_secs(3));
        assert_eq!(
            ended.record.session.unwrap().exit.unwrap().reason,
            SessionExitReason::Completed
        );
    }

    #[test]
    fn meeting_hook_strips_mimir_tools_and_refuses_shell_or_environment_injection() {
        let prompt = "Write one controlled output file";
        let args = vec![
            "exec".into(),
            "-c".into(),
            r#"mcp_servers.mimir_workbench.url="http://127.0.0.1:17532/mcp""#.into(),
            "--model".into(),
            "gpt-5".into(),
            prompt.into(),
        ];
        assert_eq!(
            without_mimir_tool_connection("codex", &args),
            ["exec", "--model", "gpt-5", prompt]
        );
        assert!(reject_shell_meeting_hook("/bin/sh").is_err());
        assert!(reject_shell_meeting_hook("/usr/bin/env").is_err());
        assert!(reject_shell_meeting_hook("/opt/mimir/codex").is_ok());
        assert!(reject_unconfined_meeting_hook(
            "codex",
            &["exec".into(), "--sandbox=danger-full-access".into()]
        )
        .is_err());
        assert!(reject_unconfined_meeting_hook(
            "claude",
            &["--print".into(), "--dangerously-skip-permissions".into()]
        )
        .is_err());
        assert!(
            reject_unconfined_meeting_hook("codex", &["exec".into(), "--full-auto".into()]).is_ok()
        );

        let confined = confined_meeting_hook_args(
            "codex",
            &[
                "exec".into(),
                "--yolo".into(),
                "-C".into(),
                "/tmp/outside".into(),
                "-c".into(),
                "sandbox_workspace_write.writable_roots=[\"/tmp\"]".into(),
                "--model".into(),
                "gpt-5".into(),
                prompt.into(),
            ],
        )
        .unwrap();
        assert_eq!(confined.first().map(String::as_str), Some("exec"));
        assert_eq!(confined.last().map(String::as_str), Some(prompt));
        assert!(confined
            .windows(2)
            .any(|pair| pair == ["--sandbox", "workspace-write"]));
        assert!(confined.windows(2).any(|pair| pair == ["--model", "gpt-5"]));
        assert!(confined
            .iter()
            .any(|argument| argument == "--ignore-user-config"));
        assert!(!confined.iter().any(|argument| {
            argument == "--yolo"
                || argument == "-C"
                || argument.contains("writable_roots")
                || argument == "/tmp/outside"
        }));

        let workspace = tempfile::tempdir().unwrap();
        let request = MeetingHookLaunch {
            meeting_id: "meeting-1".into(),
            hook_id: "title-summary".into(),
            transcript_revision: 1,
            title: "Meeting follow-up".into(),
            prompt: prompt.into(),
            preset_id: None,
            workspace: workspace.path().to_string_lossy().into_owned(),
            env: BTreeMap::from([("LD_PRELOAD".into(), "/tmp/injected".into())]),
        };
        assert!(validate_meeting_hook(&request).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn manual_routine_runs_on_demand_and_never_fires_from_ticks() {
        let harness = Harness::new();
        harness.write_presets(vec![harness.preset()]);
        let mut manual = harness.routine();
        manual.schedule = None;
        harness.write_routine(&manual);
        let runtime = harness.runtime();

        let catalog = runtime.catalog();
        assert!(catalog.diagnostics.is_empty());
        assert!(catalog.routines[0].available);
        assert!(catalog.routines[0].next_fire.is_none());

        let far_future = Utc::now() + chrono::Duration::days(365);
        let tick = runtime.tick_at(far_future).unwrap();
        assert!(tick.fires.is_empty());
        assert!(tick.next_fires.is_empty());

        let result = runtime.run_now("daily-review").unwrap();
        assert_eq!(result.activity.kind, ActivityKind::Routine);
        assert_eq!(
            result.activity.source.routine_id.as_deref(),
            Some("daily-review")
        );
    }

    #[cfg(unix)]
    #[test]
    fn planner_state_survives_restart_and_due_fire_is_not_duplicated() {
        let harness = Harness::new();
        harness.write_presets(vec![harness.preset()]);
        harness.write_routine(&harness.routine());
        let start = Utc.with_ymd_and_hms(2026, 7, 25, 10, 0, 10).unwrap();

        let first_runtime = harness.runtime();
        let armed = first_runtime.tick_at(start).unwrap();
        assert!(armed.fires.is_empty());
        let scheduled = DateTime::parse_from_rfc3339(
            first_runtime.catalog().routines[0]
                .next_fire
                .as_deref()
                .unwrap(),
        )
        .unwrap()
        .with_timezone(&Utc);
        assert!(harness.config.planner_state_path.is_file());
        drop(first_runtime);

        let restarted = harness.runtime();
        assert_eq!(
            restarted.catalog().routines[0].next_fire.as_deref(),
            Some(scheduled.to_rfc3339().as_str())
        );
        let due = restarted.tick_at(scheduled).unwrap();
        assert_eq!(due.fires.len(), 1);
        assert_eq!(due.fires[0].scheduled_for, scheduled.to_rfc3339());
        let repeated = restarted.tick_at(scheduled).unwrap();
        assert!(repeated.fires.is_empty());

        let records = harness
            .supervisor
            .list()
            .into_iter()
            .filter(|record| record.source.routine_id.as_deref() == Some("daily-review"))
            .collect::<Vec<_>>();
        assert_eq!(records.len(), 1);
        let _ = wait_for_end(&harness.supervisor, &records[0].id, Duration::from_secs(3));
    }

    #[cfg(unix)]
    #[test]
    fn reload_detects_definition_changes_and_arms_the_new_catalog() {
        let harness = Harness::new();
        harness.write_presets(vec![harness.preset()]);
        harness.write_routine(&harness.routine());
        let runtime = harness.runtime();
        let original_revision = runtime.catalog().revision;

        let mut edited = harness.routine();
        edited.title = "A much sharper review".into();
        edited.prompt = "Find the three highest-leverage changes.".into();
        harness.write_routine(&edited);
        let catalog = runtime
            .reload_at(Utc.with_ymd_and_hms(2026, 7, 25, 10, 0, 10).unwrap())
            .unwrap();

        assert!(catalog.revision > original_revision);
        assert_eq!(catalog.routines[0].definition.title, edited.title);
        assert_eq!(catalog.routines[0].definition.prompt, edited.prompt);
        assert!(catalog.routines[0].next_fire.is_some());
    }

    #[cfg(unix)]
    #[test]
    fn file_backed_crud_is_atomic_source_aware_and_duplicates_start_paused() {
        let harness = Harness::new();
        harness.write_presets(vec![harness.preset()]);
        let runtime = harness.runtime();

        let created = runtime.create_definition(harness.routine()).unwrap();
        let created_entry = &created.routines[0];
        assert!(Path::new(&created_entry.path).is_file());
        assert!(!created_entry.source_revision.is_empty());
        assert_eq!(
            created_entry.source_revision,
            source_revision(&fs::read(&created_entry.path).unwrap())
        );

        let mut edited = created_entry.definition.clone();
        edited.title = "Sharper daily review".into();
        let updated = runtime
            .update_definition(
                "daily-review",
                &created_entry.source_revision,
                edited.clone(),
            )
            .unwrap();
        assert_eq!(updated.routines[0].definition.title, edited.title);
        assert_ne!(
            updated.routines[0].source_revision,
            created_entry.source_revision
        );

        let duplicated = runtime
            .duplicate_definition(
                "daily-review",
                &updated.routines[0].source_revision,
                "daily-review-copy".into(),
                Some("Daily review copy".into()),
            )
            .unwrap();
        let copy = duplicated
            .routines
            .iter()
            .find(|routine| routine.definition.id == "daily-review-copy")
            .unwrap();
        assert_eq!(copy.definition.title, "Daily review copy");
        assert!(!copy.definition.enabled);
        assert!(Path::new(&copy.path).is_file());

        let copy_revision = copy.source_revision.clone();
        let without_copy = runtime
            .trash_definition_with("daily-review-copy", &copy_revision, |path| {
                fs::remove_file(path).map_err(|error| error.to_string())
            })
            .unwrap();
        assert!(without_copy
            .routines
            .iter()
            .all(|routine| routine.definition.id != "daily-review-copy"));
    }

    #[cfg(unix)]
    #[test]
    fn stale_definition_edits_are_rejected_without_overwriting_disk() {
        let harness = Harness::new();
        harness.write_presets(vec![harness.preset()]);
        harness.write_routine(&harness.routine());
        let runtime = harness.runtime();
        let original = runtime.catalog().routines[0].clone();

        let mut external = original.definition.clone();
        external.title = "Edited outside Mimir".into();
        harness.write_routine(&external);

        let mut stale_edit = original.definition.clone();
        stale_edit.title = "Stale UI edit".into();
        let error = runtime
            .update_definition("daily-review", &original.source_revision, stale_edit)
            .unwrap_err();

        assert!(error.contains("changed on disk"));
        let persisted: RoutineDefinition =
            toml::from_str(&fs::read_to_string(&original.path).unwrap()).unwrap();
        assert_eq!(persisted.title, "Edited outside Mimir");
    }

    #[cfg(unix)]
    #[test]
    fn background_worker_arms_and_publishes_definition_changes() {
        let harness = Harness::new();
        harness.write_presets(vec![harness.preset()]);
        harness.write_routine(&harness.routine());
        let mut config = harness.config.clone();
        config.tick_interval = Duration::from_millis(10);
        let runtime = RoutineRuntime::new(config, harness.supervisor.clone()).unwrap();
        let (tx, rx) = mpsc::channel();
        runtime.subscribe(Arc::new(tx));
        runtime.start().unwrap();

        let armed = receive_until(&rx, Duration::from_secs(2), |event| {
            event.catalog.routines[0].next_fire.is_some()
        });
        assert!(armed.catalog.routines[0].next_fire.is_some());

        let mut edited = harness.routine();
        edited.title = "Background change detected".into();
        harness.write_routine(&edited);
        let changed = receive_until(&rx, Duration::from_secs(2), |event| {
            event.catalog.routines[0].definition.title == "Background change detected"
        });
        runtime.stop_background();
        assert_eq!(
            changed.catalog.routines[0].definition.title,
            "Background change detected"
        );
    }

    #[cfg(unix)]
    #[test]
    fn corrupt_planner_state_is_quarantined_without_hiding_routines() {
        let harness = Harness::new();
        harness.write_presets(vec![harness.preset()]);
        harness.write_routine(&harness.routine());
        fs::write(&harness.config.planner_state_path, "{ definitely broken").unwrap();

        let runtime = harness.runtime();
        let catalog = runtime.catalog();
        assert_eq!(catalog.routines.len(), 1);
        assert!(catalog
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.message.contains("planner state was moved")));
        assert!(!harness.config.planner_state_path.exists());
        assert!(fs::read_dir(harness.root.path()).unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("routines-state.json.corrupt-")));
    }

    #[cfg(unix)]
    #[test]
    fn skip_overlap_blocks_a_second_run_and_normal_activity_stop_cancels_first() {
        use std::os::unix::fs::PermissionsExt;

        let harness = Harness::new();
        fs::write(&harness.binary, b"#!/bin/sh\nsleep 20\n").unwrap();
        fs::set_permissions(&harness.binary, fs::Permissions::from_mode(0o755)).unwrap();
        harness.write_presets(vec![harness.preset()]);
        harness.write_routine(&harness.routine());
        let runtime = harness.runtime();

        let first = runtime.run_now("daily-review").unwrap();
        let second = runtime.run_now("daily-review").unwrap_err();
        assert!(second.contains("active run"));
        harness.supervisor.stop(&first.activity.id).unwrap();
        let ended = wait_for_end(
            &harness.supervisor,
            &first.activity.id,
            Duration::from_secs(3),
        );
        assert_eq!(
            ended.record.session.unwrap().exit.unwrap().reason,
            SessionExitReason::Stopped
        );
    }

    #[cfg(unix)]
    #[test]
    fn event_sink_receives_catalog_reload_and_run_updates() {
        let harness = Harness::new();
        harness.write_presets(vec![harness.preset()]);
        harness.write_routine(&harness.routine());
        let runtime = harness.runtime();
        let (tx, rx) = mpsc::channel();
        runtime.subscribe(Arc::new(tx));

        runtime
            .reload_at(Utc.with_ymd_and_hms(2026, 7, 25, 10, 0, 10).unwrap())
            .unwrap();
        let event = rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(event.catalog.routines[0].definition.id, "daily-review");

        let result = runtime.run_now("daily-review").unwrap();
        assert!(rx.recv_timeout(Duration::from_secs(1)).is_ok());
        let _ = wait_for_end(
            &harness.supervisor,
            &result.activity.id,
            Duration::from_secs(3),
        );
    }

    fn wait_for_end(
        supervisor: &ActivitySupervisor,
        activity_id: &str,
        timeout: Duration,
    ) -> crate::activities::ActivitySnapshot {
        let started = Instant::now();
        loop {
            let snapshot = supervisor.snapshot(activity_id, None).unwrap();
            if snapshot
                .record
                .session
                .as_ref()
                .and_then(|session| session.exit.as_ref())
                .is_some()
            {
                return snapshot;
            }
            assert!(
                started.elapsed() < timeout,
                "activity {activity_id} did not end before timeout"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn receive_until(
        rx: &mpsc::Receiver<RoutineChangedEvent>,
        timeout: Duration,
        predicate: impl Fn(&RoutineChangedEvent) -> bool,
    ) -> RoutineChangedEvent {
        let started = Instant::now();
        loop {
            let remaining = timeout
                .checked_sub(started.elapsed())
                .expect("routine event was not published before timeout");
            let event = rx.recv_timeout(remaining).unwrap();
            if predicate(&event) {
                return event;
            }
        }
    }
}
