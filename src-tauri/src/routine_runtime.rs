use crate::{
    activities::{
        ActivityHost, ActivityKind, ActivityLaunchSpec, ActivityOrigin, ActivityRecord,
        ActivityRetention, ActivityStatus, ActivitySupervisor, SpawnActivityRequest,
    },
    launchers::{
        self, AgentDefinition, DetectedAgent, LauncherKind, LauncherPreset, ResolvedLaunch,
    },
    persistence::{load_json_optional_quarantining, write_json_atomic, QuarantinedLoad},
    routines::{
        load_catalog, reconcile_tick, RoutineCatalog, RoutineDefinition, RoutineDiagnostic,
        RoutineOverlap, RoutinePlannerState, RoutineSkip, RoutineTick,
    },
};
use chrono::{DateTime, Utc};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Mutex, MutexGuard,
    },
    thread,
    time::Duration,
};
use tauri::Emitter;
use uuid::Uuid;

pub const ROUTINES_CHANGED_EVENT: &str = "mim://routines-changed";
const DEFAULT_MCP_URL: &str = "http://127.0.0.1:17532/mcp";
const ROUTINE_COLS: u16 = 100;
const ROUTINE_ROWS: u16 = 30;

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
        let mim_dir = home_path.join(".mim");
        Self {
            routines_dir: mim_dir.join("routines"),
            planner_state_path: mim_dir.join("routines-state.json"),
            launcher_config_path: mim_dir.join("launchers.json"),
            home_path,
            default_shell: launchers::default_shell_path(),
            tick_interval: Duration::from_secs(1),
            mcp_url: std::env::var("MIMX_MCP_URL").unwrap_or_else(|_| DEFAULT_MCP_URL.into()),
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
            .name("mim-routine-runtime".into())
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
        let activity_id = format!("routine:{}:{}", resolved.definition.id, Uuid::new_v4());
        let now = Utc::now().to_rfc3339();
        let mut env = resolved.launch.env.clone();
        env.insert("MIM_ACTIVITY_ID".into(), activity_id.clone());
        env.insert("MIMX_MCP_URL".into(), self.inner.config.mcp_url.clone());
        env.insert("MIM_ROUTINE_ID".into(), resolved.definition.id.clone());
        env.insert("MIM_ROUTINE_SCHEDULED_FOR".into(), scheduled_for.into());

        let record = ActivityRecord {
            id: activity_id,
            kind: ActivityKind::Routine,
            title: resolved.definition.title.clone(),
            workspace_path: Some(resolved.launch.cwd.clone()),
            status: ActivityStatus::Ready,
            created_at: now.clone(),
            updated_at: now,
            last_viewed_at: None,
            archived_at: None,
            retention: ActivityRetention::Durable,
            source: ActivityOrigin {
                launcher_id: resolved.launch.agent_id.clone(),
                preset_id: Some(resolved.launch.preset_id.clone()),
                routine_id: Some(resolved.definition.id.clone()),
                scheduled_for: Some(scheduled_for.into()),
                ..ActivityOrigin::default()
            },
            host: ActivityHost::pty(resolved.launch.agent_id.clone()),
            launch: Some(ActivityLaunchSpec {
                command: resolved.launch.command.clone(),
                args: resolved.args.clone(),
                cwd: Some(resolved.launch.cwd.clone()),
                env,
            }),
            session: None,
            error: None,
        };
        self.inner
            .supervisor
            .spawn(SpawnActivityRequest::new(
                record,
                ROUTINE_COLS,
                ROUTINE_ROWS,
            ))
            .map(|snapshot| snapshot.record)
            .map_err(|error| {
                format!(
                    "Could not launch routine '{}': {error}",
                    resolved.definition.title
                )
            })
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
                    RoutineRuntimeEntry {
                        available: state.resolved.contains_key(&routine_id),
                        next_fire: state.planner.next_fires.get(&routine_id).cloned(),
                        diagnostic: state.unavailable.get(&routine_id).cloned(),
                        running_activity_ids: running.get(&routine_id).cloned().unwrap_or_default(),
                        last_error: state.last_errors.get(&routine_id).cloned(),
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

fn load_and_resolve(
    config: &RoutineRuntimeConfig,
) -> Result<
    (
        RoutineCatalog,
        BTreeMap<String, ResolvedRoutine>,
        BTreeMap<String, String>,
    ),
    String,
> {
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

fn load_consistent_inputs(
    config: &RoutineRuntimeConfig,
) -> Result<
    (
        RoutineCatalog,
        BTreeMap<String, ResolvedRoutine>,
        BTreeMap<String, String>,
        String,
    ),
    String,
> {
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
    let preset = presets.get(&definition.preset).ok_or_else(|| {
        (
            "preset".into(),
            format!("Launcher preset '{}' does not exist.", definition.preset),
        )
    })?;
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
                    "Agent '{agent_id}' has no headless routine adapter; use codex, claude, or pi."
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
    )
    .map_err(|message| {
        let field = if message.contains("Working directory") || message.contains("open workspace") {
            "workspace"
        } else {
            "binary"
        };
        (field.into(), message)
    })?;
    launch.command = resolve_executable(&launch.command, Path::new(&launch.cwd))
        .map_err(|message| ("binary".into(), message))?;
    let args = headless_argv(agent_id, &launch.args, &definition.prompt)
        .map_err(|message| ("preset".into(), message))?;

    Ok(ResolvedRoutine {
        definition: definition.clone(),
        launch,
        args,
    })
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

fn input_fingerprint(config: &RoutineRuntimeConfig) -> Result<String, String> {
    let mut hasher = Sha256::new();
    hasher.update(b"mim-routine-inputs-v1\0");

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
        hasher.update(fs::read(&path).map_err(|error| {
            format!("Could not fingerprint routine {}: {error}", path.display())
        })?);
        hasher.update(b"\0");
    }

    hasher.update(config.launcher_config_path.to_string_lossy().as_bytes());
    match fs::read(&config.launcher_config_path) {
        Ok(contents) => hasher.update(contents),
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
                b"#!/bin/sh\nprintf 'arg=%s\\n' \"$@\"\nprintf 'mcp=%s\\n' \"$MIMX_MCP_URL\"\n",
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
                schedule: "* * * * *".into(),
                timezone: "UTC".into(),
                preset: "review-agent".into(),
                prompt: "Review the work tree and report sharp findings.".into(),
                overlap: RoutineOverlap::Skip,
                missed: MissedFirePolicy::RunOnce,
                workspace: Some(self.workspace.to_string_lossy().into_owned()),
            }
        }

        fn preset(&self) -> LauncherPreset {
            LauncherPreset {
                id: "review-agent".into(),
                title: "Review agent".into(),
                kind: LauncherKind::Agent,
                agent_id: Some("codex".into()),
                binary: Some(self.binary.to_string_lossy().into_owned()),
                args: vec!["--model".into(), "gpt 5".into()],
                env: BTreeMap::from([("MIM_TEST_ENV".into(), "kept exactly".into())]),
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
            result.activity.source.scheduled_for.as_deref(),
            Some(result.scheduled_for.as_str())
        );

        let launch = result.activity.launch.as_ref().unwrap();
        assert_eq!(launch.command, harness.binary.to_string_lossy());
        assert_eq!(
            launch.args,
            [
                "exec",
                "--model",
                "gpt 5",
                "Review the work tree and report sharp findings."
            ]
        );
        assert_eq!(
            launch.env.get("MIM_TEST_ENV").map(String::as_str),
            Some("kept exactly")
        );
        assert_eq!(
            launch.env.get("MIMX_MCP_URL").map(String::as_str),
            Some("http://127.0.0.1:29999/mcp")
        );
        assert_eq!(
            launch.env.get("MIM_ROUTINE_ID").map(String::as_str),
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
