use super::{
    engine::TrackerEngine,
    import,
    model::{
        ActivityCategory, ActivityPage, ArgusImportRequest, Classification, ClassificationUpdate,
        ImportPreview, ImportReport, RuntimeState, TrackerConfig, TrackerMode, TrackerQuery,
        TrackerReport, TrackerStatus,
    },
    platform, report,
    store::{AiUsageRecord, TrackerStore},
};
use crate::ai::{self, AiGenerateRequest, AiGenerateResponse, AiMessage};
use chrono::{DateTime, LocalResult, TimeZone, Timelike, Utc};
use chrono_tz::Tz;
use serde::Deserialize;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering},
        mpsc, Arc, Mutex, MutexGuard,
    },
    thread,
    time::Duration,
};
use tauri::{Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

pub const TRACKER_CHANGED_EVENT: &str = "mimir://tracker-changed";
pub const TRACKER_OPEN_EVENT: &str = "mimir://tracker-open";

#[derive(Debug, Clone)]
pub struct TrackerRuntimeConfig {
    pub database_path: PathBuf,
}

impl Default for TrackerRuntimeConfig {
    fn default() -> Self {
        let root = dirs::home_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join(".mimir")
            .join("tracker");
        Self {
            database_path: root.join("tracker.sqlite"),
        }
    }
}

#[derive(Clone)]
pub struct TrackerRuntimeState {
    runtime: Option<TrackerRuntime>,
    unavailable: Option<String>,
}

impl TrackerRuntimeState {
    pub fn new(config: TrackerRuntimeConfig) -> Self {
        let path = config.database_path.clone();
        match TrackerRuntime::new(config) {
            Ok(runtime) => Self {
                runtime: Some(runtime),
                unavailable: None,
            },
            Err(error) => {
                let diagnostic = format!(
                    "Tracker storage is unavailable at {}. Tracker remains off and Mimir can continue: {error}",
                    path.display()
                );
                log::error!("{diagnostic}");
                Self {
                    runtime: None,
                    unavailable: Some(diagnostic),
                }
            }
        }
    }

    pub fn install(&self, app: &tauri::AppHandle) -> Result<(), String> {
        let Some(runtime) = self.runtime.as_ref() else {
            return Ok(());
        };
        runtime.install(app).map_err(|error| {
            runtime.set_diagnostic(format!("Tracker could not start: {error}"));
            error
        })
    }

    pub fn shutdown(&self) -> Result<(), String> {
        match self.runtime.as_ref() {
            Some(runtime) => runtime.shutdown(),
            None => Ok(()),
        }
    }

    pub fn background_launch_enabled(&self) -> bool {
        self.runtime.as_ref().is_some_and(|runtime| {
            let config = lock(&runtime.inner.config);
            config.enabled && config.launch_at_login
        })
    }

    fn runtime(&self) -> Result<&TrackerRuntime, String> {
        self.runtime.as_ref().ok_or_else(|| {
            self.unavailable
                .clone()
                .unwrap_or_else(|| "Tracker is unavailable.".into())
        })
    }

    fn status(&self) -> Result<TrackerStatus, String> {
        if let Some(runtime) = self.runtime.as_ref() {
            return runtime.status();
        }
        let config = TrackerConfig::default();
        Ok(TrackerStatus {
            mode: TrackerMode::Error,
            permissions: platform::permission_status(&config),
            config,
            current: None,
            break_remaining_seconds: None,
            queued_classifications: 0,
            today_cost_usd: 0.0,
            launch_at_login_active: false,
            autostart_diagnostic: None,
            diagnostic: self.unavailable.clone(),
            revision: 1,
        })
    }
}

#[derive(Clone)]
pub struct TrackerRuntime {
    inner: Arc<TrackerRuntimeInner>,
}

struct TrackerRuntimeInner {
    store: Mutex<TrackerStore>,
    engine: Mutex<TrackerEngine>,
    config: Mutex<TrackerConfig>,
    runtime_state: Mutex<RuntimeState>,
    app: Mutex<Option<tauri::AppHandle>>,
    #[cfg(target_os = "macos")]
    tray: Mutex<Option<tauri::tray::TrayIcon>>,
    worker: Mutex<Option<TrackerWorker>>,
    mimir_context: Mutex<Option<String>>,
    diagnostic: Mutex<Option<String>>,
    autostart_diagnostic: Mutex<Option<String>>,
    revision: AtomicU64,
    last_classification_ms: AtomicI64,
    classification_running: AtomicBool,
    nudge_running: AtomicBool,
    sampling_allowed: AtomicBool,
}

struct TrackerWorker {
    stop: mpsc::Sender<()>,
    join: thread::JoinHandle<()>,
}

struct NudgeWindow {
    day_start_ms: i64,
    leisure_minutes: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClassificationBatch {
    #[serde(default)]
    classifications: Vec<ClassificationAnswer>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClassificationAnswer {
    key: String,
    activity: String,
    subcategory: Option<String>,
}

impl TrackerRuntime {
    pub fn new(config: TrackerRuntimeConfig) -> Result<Self, String> {
        let store = TrackerStore::open(&config.database_path)?;
        let startup_diagnostic = store.startup_diagnostic().map(str::to_string);
        let stored_config = store.config()?;
        let tracker_config = stored_config.clone().with_system_timezone();
        if tracker_config != stored_config {
            store.save_config(&tracker_config)?;
        }
        let sampling_allowed = tracker_config.enabled && tracker_config.armed;
        let runtime_state = store.runtime_state()?;
        Ok(Self {
            inner: Arc::new(TrackerRuntimeInner {
                store: Mutex::new(store),
                // Never blindly hydrate the last historical block. Imported data
                // and a previous clean shutdown are both closed intervals.
                engine: Mutex::new(TrackerEngine::default()),
                config: Mutex::new(tracker_config),
                runtime_state: Mutex::new(runtime_state),
                app: Mutex::new(None),
                #[cfg(target_os = "macos")]
                tray: Mutex::new(None),
                worker: Mutex::new(None),
                mimir_context: Mutex::new(None),
                diagnostic: Mutex::new(startup_diagnostic),
                autostart_diagnostic: Mutex::new(None),
                revision: AtomicU64::new(1),
                last_classification_ms: AtomicI64::new(0),
                classification_running: AtomicBool::new(false),
                nudge_running: AtomicBool::new(false),
                sampling_allowed: AtomicBool::new(sampling_allowed),
            }),
        })
    }

    pub fn database_path(&self) -> PathBuf {
        lock(&self.inner.store).path().to_path_buf()
    }

    pub fn install(&self, app: &tauri::AppHandle) -> Result<(), String> {
        *lock(&self.inner.app) = Some(app.clone());
        self.recover_gap_if_needed()?;
        self.sync_autostart();
        if lock(&self.inner.config).enabled {
            if let Err(error) = self.ensure_tray() {
                self.set_diagnostic(format!("Tracker menu-bar control is unavailable: {error}"));
            }
            if lock(&self.inner.config).nudges_enabled {
                self.request_notification_permission();
            }
            self.start()?;
        }
        Ok(())
    }

    pub fn start(&self) -> Result<(), String> {
        if !lock(&self.inner.config).enabled {
            return Ok(());
        }
        let (stop_tx, stop_rx) = mpsc::channel();
        {
            let mut worker = lock(&self.inner.worker);
            if worker.is_some() {
                return Ok(());
            }
            let runtime = self.clone();
            let join = thread::Builder::new()
                .name("mimir-tracker-runtime".into())
                .spawn(move || runtime.worker_loop(stop_rx))
                .map_err(|error| format!("Could not start Tracker runtime: {error}"))?;
            *worker = Some(TrackerWorker {
                stop: stop_tx,
                join,
            });
        }
        Ok(())
    }

    fn start_with_diagnostic(&self) -> Result<(), String> {
        self.start().map_err(|error| {
            self.set_diagnostic(format!("Tracker could not start: {error}"));
            error
        })
    }

    pub fn shutdown(&self) -> Result<(), String> {
        self.inner.sampling_allowed.store(false, Ordering::Release);
        self.stop_worker()?;
        let now = now_ms();
        {
            let store = lock(&self.inner.store);
            lock(&self.inner.engine).close(&store, now)?;
            let mut state = lock(&self.inner.runtime_state);
            state.last_shutdown_ms = Some(now);
            store.save_runtime_state(&state)?;
            store.checkpoint()?;
        }
        Ok(())
    }

    fn stop_worker(&self) -> Result<(), String> {
        let worker = lock(&self.inner.worker).take();
        if let Some(worker) = worker {
            let _ = worker.stop.send(());
            worker
                .join
                .join()
                .map_err(|_| "Tracker runtime worker panicked during shutdown.".to_string())?;
        }
        Ok(())
    }

    pub fn status(&self) -> Result<TrackerStatus, String> {
        let config = lock(&self.inner.config).clone();
        let mut permissions = platform::permission_status(&config);
        permissions.notifications = self.notification_permission();
        let now = now_ms();
        let diagnostic = lock(&self.inner.diagnostic).clone();
        let day_start = local_day_start_ms(now, &config.timezone)?;
        let store = lock(&self.inner.store);
        // Runtime mutations persist while holding the store and then update
        // runtime_state. Preserve that ordering here as well.
        let state = lock(&self.inner.runtime_state).clone();
        let current = store.current_block()?;
        let mode = if !config.enabled {
            TrackerMode::Disabled
        } else if !permissions.platform_supported {
            TrackerMode::Unsupported
        } else if state.break_end_ms.is_some_and(|end| end > now) {
            TrackerMode::Break
        } else if !config.armed {
            TrackerMode::Paused
        } else if permissions.accessibility_required && !permissions.accessibility {
            TrackerMode::NeedsAccess
        } else if diagnostic.is_some() {
            TrackerMode::Error
        } else {
            TrackerMode::Armed
        };
        Ok(TrackerStatus {
            mode,
            config,
            permissions,
            current,
            break_remaining_seconds: state
                .break_end_ms
                .filter(|end| *end > now)
                .map(|end| (end - now + 999) / 1000),
            queued_classifications: store.queued_classification_count()?,
            today_cost_usd: store.ai_cost_since(day_start)?,
            launch_at_login_active: self.autostart_active(),
            autostart_diagnostic: lock(&self.inner.autostart_diagnostic).clone(),
            diagnostic,
            revision: self.inner.revision.load(Ordering::Relaxed),
        })
    }

    pub fn update_config(&self, config: TrackerConfig) -> Result<TrackerStatus, String> {
        let previous = lock(&self.inner.config).clone();
        let config = config.with_system_timezone();
        let should_sample = config.enabled && config.armed;
        if !should_sample {
            self.inner.sampling_allowed.store(false, Ordering::Release);
        }
        let config = match lock(&self.inner.store).save_config(&config) {
            Ok(saved) => saved,
            Err(error) => {
                self.inner
                    .sampling_allowed
                    .store(previous.enabled && previous.armed, Ordering::Release);
                return Err(error);
            }
        };
        *lock(&self.inner.config) = config.clone();
        self.inner
            .sampling_allowed
            .store(should_sample, Ordering::Release);
        self.clear_diagnostic();
        let should_prompt_for_accessibility = config.enabled
            && config.collect_window_titles
            && (!previous.enabled || !previous.collect_window_titles)
            && !platform::permission_status(&config).accessibility;
        if should_prompt_for_accessibility {
            platform::prompt_accessibility();
        }
        if config.enabled
            && config.nudges_enabled
            && (!previous.enabled || !previous.nudges_enabled)
        {
            self.request_notification_permission();
        }
        self.sync_autostart();
        if previous.enabled && !config.enabled {
            self.stop_worker()?;
            self.clear_break_state()?;
            self.pause_at(now_ms(), "disabled")?;
            self.remove_tray();
        } else if !previous.enabled && config.enabled {
            self.recover_gap_if_needed()?;
            if let Err(error) = self.ensure_tray() {
                self.set_diagnostic(format!("Tracker menu-bar control is unavailable: {error}"));
            }
            self.start_with_diagnostic()?;
        } else if config.enabled {
            self.start_with_diagnostic()?;
            if previous.armed && !config.armed {
                self.pause_at(now_ms(), "paused")?;
            }
        }
        self.publish();
        self.status()
    }

    pub fn set_enabled(&self, enabled: bool) -> Result<TrackerStatus, String> {
        let mut config = lock(&self.inner.config).clone();
        config.enabled = enabled;
        self.update_config(config)
    }

    pub fn set_armed(&self, armed: bool) -> Result<TrackerStatus, String> {
        let mut config = lock(&self.inner.config).clone();
        config.armed = armed;
        self.update_config(config)
    }

    pub fn start_break(&self, minutes: u64) -> Result<TrackerStatus, String> {
        if !lock(&self.inner.config).enabled {
            return Err("Enable Tracker before starting a tracked break.".into());
        }
        let minutes = minutes.clamp(1, 240);
        let now = now_ms();
        {
            let store = lock(&self.inner.store);
            lock(&self.inner.engine).start_break(&store, now, minutes)?;
            let mut state = lock(&self.inner.runtime_state);
            state.break_started_ms = Some(now);
            state.break_duration_minutes = Some(minutes);
            state.break_end_ms = Some(now.saturating_add((minutes as i64) * 60_000));
            store.save_runtime_state(&state)?;
        }
        self.publish();
        self.status()
    }

    pub fn end_break(&self) -> Result<TrackerStatus, String> {
        self.finish_break(false)?;
        self.status()
    }

    pub fn query(&self, query: TrackerQuery) -> Result<ActivityPage, String> {
        lock(&self.inner.store).query(&query)
    }

    pub fn report(
        &self,
        start_ms: i64,
        end_ms: i64,
        _timezone: Option<String>,
    ) -> Result<TrackerReport, String> {
        let timezone = lock(&self.inner.config).timezone.clone();
        report::build_report(&lock(&self.inner.store), start_ms, end_ms, &timezone)
    }

    pub fn classifications(&self) -> Result<Vec<Classification>, String> {
        lock(&self.inner.store).classifications()
    }

    pub fn update_classification(
        &self,
        update: ClassificationUpdate,
    ) -> Result<Classification, String> {
        let result = lock(&self.inner.store).save_classification(
            &update.key,
            update.activity,
            update.subcategory.as_deref(),
            "manual",
            true,
            update.apply_history,
        )?;
        self.publish();
        Ok(result)
    }

    pub fn import_preview(&self, request: ArgusImportRequest) -> Result<ImportPreview, String> {
        let directory = import_directory(request.source_directory.as_deref())?;
        import::preview(&lock(&self.inner.store), &directory)
    }

    pub fn import_argus(&self, request: ArgusImportRequest) -> Result<ImportReport, String> {
        let config = lock(&self.inner.config).clone();
        let timezone = request.timezone.as_deref().unwrap_or(&config.timezone);
        let directory = import_directory(request.source_directory.as_deref())?;
        let report = import::import(&mut lock(&self.inner.store), &directory, timezone)?;
        self.publish();
        Ok(report)
    }

    pub fn set_mimir_context(&self, context: Option<String>) {
        *lock(&self.inner.mimir_context) = context
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
    }

    pub fn request_accessibility(&self) -> Result<TrackerStatus, String> {
        if !lock(&self.inner.config).enabled {
            return Err("Enable Tracker before opening Accessibility settings.".into());
        }
        platform::request_accessibility()?;
        self.status()
    }

    fn worker_loop(&self, stop: mpsc::Receiver<()>) {
        loop {
            let config = lock(&self.inner.config).clone();
            if !config.enabled {
                break;
            }
            if let Err(error) = self.tick(&config) {
                self.set_diagnostic(format!("Tracker collection is waiting to retry: {error}"));
            }
            match stop.recv_timeout(Duration::from_secs(config.poll_interval_seconds)) {
                Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        }
    }

    fn tick(&self, config: &TrackerConfig) -> Result<(), String> {
        if !platform::supported() {
            return Ok(());
        }
        let now = now_ms();
        let break_end = lock(&self.inner.runtime_state).break_end_ms;
        if let Some(end) = break_end {
            if end > now {
                let store = lock(&self.inner.store);
                if lock(&self.inner.engine).extend_break(&store, now)? {
                    self.publish();
                }
                return Ok(());
            }
            self.finish_break(true)?;
        }
        if !self.inner.sampling_allowed.load(Ordering::Acquire) {
            return Ok(());
        }
        let permissions = platform::permission_status(config);
        if permissions.accessibility_required && !permissions.accessibility {
            self.pause_at(now, "accessibility-unavailable")?;
            return Ok(());
        }
        let context = lock(&self.inner.mimir_context).clone();
        let observation = match platform::sample(config, context.as_deref()) {
            Ok(observation) => observation,
            Err(error) => {
                self.pause_at(now, "sampling-unavailable")?;
                return Err(error);
            }
        };
        if !self.inner.sampling_allowed.load(Ordering::Acquire) {
            return Ok(());
        }
        let changed = {
            let store = lock(&self.inner.store);
            lock(&self.inner.engine).observe(&store, config, observation)?
        };
        self.clear_diagnostic_prefix("Tracker collection is waiting to retry:");
        if changed {
            self.publish();
        }
        self.maybe_classify(config, now);
        self.maybe_nudge(config, now)?;
        Ok(())
    }

    fn pause_at(&self, at_ms: i64, reason: &str) -> Result<(), String> {
        let changed = {
            let store = lock(&self.inner.store);
            lock(&self.inner.engine).pause(&store, at_ms, reason)?
        };
        if changed {
            self.publish();
        }
        Ok(())
    }

    fn finish_break(&self, notify: bool) -> Result<(), String> {
        let now = now_ms();
        {
            let store = lock(&self.inner.store);
            lock(&self.inner.engine).pause(&store, now, "break-ended")?;
            let mut state = lock(&self.inner.runtime_state);
            state.break_started_ms = None;
            state.break_end_ms = None;
            state.break_duration_minutes = None;
            store.save_runtime_state(&state)?;
        }
        if notify {
            self.notify("Break finished", "Ready when you are.");
        }
        self.publish();
        Ok(())
    }

    fn clear_break_state(&self) -> Result<(), String> {
        let store = lock(&self.inner.store);
        let mut state = lock(&self.inner.runtime_state);
        state.break_started_ms = None;
        state.break_end_ms = None;
        state.break_duration_minutes = None;
        store.save_runtime_state(&state)
    }

    fn recover_gap_if_needed(&self) -> Result<(), String> {
        let config = lock(&self.inner.config).clone();
        if !config.enabled {
            return Ok(());
        }
        let now = now_ms();
        let last_end = lock(&self.inner.store)
            .current_block()?
            .map(|block| block.end_ms)
            .or_else(|| lock(&self.inner.runtime_state).last_shutdown_ms);
        let Some(last_end) = last_end.filter(|last| *last <= now) else {
            return Ok(());
        };
        let state = lock(&self.inner.runtime_state).clone();
        let store = lock(&self.inner.store);
        let mut engine = lock(&self.inner.engine);
        if let Some(break_end) = state.break_end_ms {
            let break_minutes = state.break_duration_minutes.unwrap_or(20);
            let break_until = break_end.min(now);
            engine.recover_break(
                &store,
                last_end.min(break_until),
                break_until,
                break_minutes,
            )?;
            if break_end > now {
                return Ok(());
            }
            let mut next_state = state;
            next_state.break_started_ms = None;
            next_state.break_end_ms = None;
            next_state.break_duration_minutes = None;
            store.save_runtime_state(&next_state)?;
            *lock(&self.inner.runtime_state) = next_state;
            if break_until < now {
                engine.recover_off_gap(&store, break_until, now, "app-not-running")?;
            }
        } else if last_end < now {
            engine.recover_off_gap(&store, last_end, now, "app-not-running")?;
        }
        Ok(())
    }

    fn maybe_classify(&self, config: &TrackerConfig, now: i64) {
        if !config.classification_enabled
            || self.inner.classification_running.load(Ordering::Relaxed)
        {
            return;
        }
        let jobs = match self.classification_batch(config, now) {
            Ok(jobs) if !jobs.is_empty() => jobs,
            Ok(_) => return,
            Err(error) => {
                self.set_diagnostic(error);
                return;
            }
        };
        let day_start = match local_day_start_ms(now, &config.timezone) {
            Ok(value) => value,
            Err(error) => {
                self.set_diagnostic(error);
                return;
            }
        };
        let current_cost = lock(&self.inner.store)
            .ai_cost_since(day_start)
            .unwrap_or(config.daily_cost_cap_usd);
        if current_cost >= config.daily_cost_cap_usd {
            return;
        }
        if self
            .inner
            .classification_running
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Relaxed)
            .is_err()
        {
            return;
        }

        let runtime = self.clone();
        let config = config.clone();
        tauri::async_runtime::spawn(async move {
            let result = runtime.classify_jobs(&config, &jobs).await;
            if let Err(error) = result {
                let keys = jobs.iter().map(|job| job.key.clone()).collect::<Vec<_>>();
                let retry = now.saturating_add((config.classification_retry_seconds as i64) * 1000);
                let _ = lock(&runtime.inner.store).defer_classification_jobs(&keys, retry);
                runtime.set_diagnostic(format!("AI classification is waiting to retry: {error}"));
            } else {
                runtime.clear_diagnostic_prefix("AI classification is waiting to retry:");
                runtime.publish();
            }
            runtime
                .inner
                .classification_running
                .store(false, Ordering::Release);
        });
    }

    fn classification_batch(
        &self,
        config: &TrackerConfig,
        now: i64,
    ) -> Result<Vec<super::model::ClassificationJob>, String> {
        if now.saturating_sub(self.inner.last_classification_ms.load(Ordering::Relaxed))
            < (config.classification_batch_seconds as i64) * 1000
        {
            return Ok(Vec::new());
        }
        let jobs = lock(&self.inner.store).due_classification_jobs(now, 25)?;
        // An empty startup scan must not make the first unknown application
        // wait through a complete batching interval.
        if !jobs.is_empty() {
            self.inner
                .last_classification_ms
                .store(now, Ordering::Relaxed);
        }
        Ok(jobs)
    }

    async fn classify_jobs(
        &self,
        config: &TrackerConfig,
        jobs: &[super::model::ClassificationJob],
    ) -> Result<(), String> {
        let items = jobs
            .iter()
            .map(|job| {
                let mut value = serde_json::json!({
                    "key": job.key,
                    "app": job.app_name,
                    "domain": job.domain,
                });
                if config.include_window_titles_in_ai {
                    value["windowTitle"] = serde_json::json!(job.window_title);
                }
                value
            })
            .collect::<Vec<_>>();
        let request = AiGenerateRequest {
            correlation_id: None,
            feature: "extract".into(),
            model_id: concrete_model(&config.classification_model),
            workspace_id: None,
            document_id: None,
            system: Some(
                "Classify desktop activities. Return JSON with a `classifications` array. \
                 Each item must repeat `key`, choose activity from Work, Leisure, or Other, \
                 and provide a concise subcategory. Work means deliberate professional or \
                 creative effort; Leisure means entertainment/social browsing; Other means \
                 utilities or ambiguous activity. Never invent keys."
                    .into(),
            ),
            messages: vec![AiMessage {
                role: "user".into(),
                content: serde_json::to_string(&items)
                    .map_err(|error| format!("Could not encode classification batch: {error}"))?,
            }],
            response_format: Some("json".into()),
            stream: Some(false),
            max_output_tokens: Some(1200),
            temperature: Some(0.0),
            metadata: Some(serde_json::json!({ "source": "tracker" })),
            provider_options: None,
        };
        let response = ai::generate_internal(request).await?;
        let batch = decode_classification_batch(&response)?;
        let valid_keys = jobs
            .iter()
            .map(|job| job.key.as_str())
            .collect::<std::collections::HashSet<_>>();
        let mut saved_keys = std::collections::HashSet::new();
        {
            let store = lock(&self.inner.store);
            for answer in batch.classifications {
                if !valid_keys.contains(answer.key.as_str()) {
                    continue;
                }
                let Ok(activity) = answer.activity.parse::<ActivityCategory>() else {
                    continue;
                };
                if !matches!(
                    activity,
                    ActivityCategory::Work | ActivityCategory::Leisure | ActivityCategory::Other
                ) {
                    continue;
                }
                store.save_classification(
                    &answer.key,
                    activity,
                    answer.subcategory.as_deref(),
                    &format!("ai:{}", response.model_id),
                    false,
                    true,
                )?;
                saved_keys.insert(answer.key);
            }
            store.record_ai_usage(AiUsageRecord {
                feature: "tracker-classification",
                model_id: &response.model_id,
                provider: &response.provider,
                estimated_cost: response.usage.estimated_cost,
                input_tokens: response.usage.input_tokens,
                output_tokens: response.usage.output_tokens,
                created_at_ms: now_ms(),
            })?;
            if !saved_keys.is_empty() {
                let unresolved = jobs
                    .iter()
                    .filter(|job| !saved_keys.contains(&job.key))
                    .map(|job| job.key.clone())
                    .collect::<Vec<_>>();
                if !unresolved.is_empty() {
                    let retry = now_ms()
                        .saturating_add((config.classification_retry_seconds as i64) * 1000);
                    store.defer_classification_jobs(&unresolved, retry)?;
                }
            }
        }
        if saved_keys.is_empty() {
            return Err("The model returned no usable classifications.".into());
        }
        Ok(())
    }

    fn maybe_nudge(&self, config: &TrackerConfig, now: i64) -> Result<(), String> {
        if !config.nudges_enabled || self.inner.nudge_running.load(Ordering::Relaxed) {
            return Ok(());
        }
        let current = match lock(&self.inner.store).current_block()? {
            Some(block)
                if block.activity == ActivityCategory::Leisure
                    || (config.nudge_other && block.activity == ActivityCategory::Other) =>
            {
                block
            }
            _ => return Ok(()),
        };

        let session_key = format!("block:{}", current.id);
        let nudges = lock(&self.inner.store).session_nudges(&session_key)?;
        let history_start = local_day_start_ms(now, &config.timezone)?;
        let history = lock(&self.inner.store).blocks_in_range(history_start, now)?;
        let Some(window) = eligible_nudge_window(config, now, &current, &nudges, &history)? else {
            return Ok(());
        };
        if self
            .inner
            .nudge_running
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Relaxed)
            .is_err()
        {
            return Ok(());
        }
        let runtime = self.clone();
        let config = config.clone();
        let allow_ai = config.daily_cost_cap_usd > 0.0
            && lock(&self.inner.store).ai_cost_since(window.day_start_ms)?
                < config.daily_cost_cap_usd;
        tauri::async_runtime::spawn(async move {
            let message = if allow_ai {
                runtime
                    .generate_nudge(
                        &config,
                        &current,
                        window.leisure_minutes,
                        nudges.len() + 1,
                        &history,
                    )
                    .await
            } else {
                Err("The Tracker AI cost cap is reached.".into())
            };
            let (message, source) = match message {
                Ok(value) => value,
                Err(_) => fallback_nudge(nudges.len()),
            };
            runtime.notify("Tracker", &message);
            let _ = lock(&runtime.inner.store).record_nudge(
                &session_key,
                Some(current.id),
                &message,
                &source,
                now_ms(),
            );
            runtime.inner.nudge_running.store(false, Ordering::Release);
            runtime.publish();
        });
        Ok(())
    }

    async fn generate_nudge(
        &self,
        config: &TrackerConfig,
        current: &super::model::ActivityBlock,
        minutes: i64,
        number: usize,
        history: &[super::model::ActivityBlock],
    ) -> Result<(String, String), String> {
        let recent = history
            .iter()
            .rev()
            .filter(|block| {
                !matches!(
                    block.activity,
                    ActivityCategory::Afk | ActivityCategory::Off
                )
            })
            .take(5)
            .map(|block| {
                serde_json::json!({
                    "activity": block.activity,
                    "subcategory": block.subcategory,
                    "app": block.app_name,
                    "minutes": block.duration_seconds / 60,
                })
            })
            .collect::<Vec<_>>();
        let window_title = config
            .include_window_titles_in_ai
            .then(|| current.window_title.clone())
            .flatten();
        let prompt = serde_json::json!({
            "current": {
                "app": current.app_name,
                "domain": current.domain,
                "windowTitle": window_title,
                "minutes": minutes,
            },
            "nudgeNumber": number,
            "recent": recent,
        });
        let response = ai::generate_internal(AiGenerateRequest {
            correlation_id: None,
            feature: "extract".into(),
            model_id: concrete_model(&config.nudge_model),
            workspace_id: None,
            document_id: None,
            system: Some(
                "Write one warm, specific desktop notification that gently helps the user \
                 return from unintended leisure. Be a friend, never a boss; no guilt, no \
                 labels or preamble; one or two short sentences; suggest one easy next step."
                    .into(),
            ),
            messages: vec![AiMessage {
                role: "user".into(),
                content: prompt.to_string(),
            }],
            response_format: None,
            stream: Some(false),
            max_output_tokens: Some(120),
            temperature: Some(0.7),
            metadata: Some(serde_json::json!({ "source": "tracker" })),
            provider_options: None,
        })
        .await?;
        let message = response.text.trim().trim_matches('"').to_string();
        if message.is_empty() || message.len() > 240 {
            return Err("The nudge model returned an unusable message.".into());
        }
        lock(&self.inner.store).record_ai_usage(AiUsageRecord {
            feature: "tracker-nudge",
            model_id: &response.model_id,
            provider: &response.provider,
            estimated_cost: response.usage.estimated_cost,
            input_tokens: response.usage.input_tokens,
            output_tokens: response.usage.output_tokens,
            created_at_ms: now_ms(),
        })?;
        Ok((message, format!("ai:{}", response.model_id)))
    }

    fn notify(&self, title: &str, body: &str) {
        let Some(app) = lock(&self.inner.app).clone() else {
            return;
        };
        if let Err(error) = app.notification().builder().title(title).body(body).show() {
            log::warn!("Could not show Tracker notification: {error}");
        }
    }

    fn notification_permission(&self) -> Option<String> {
        lock(&self.inner.app).as_ref().and_then(|app| {
            app.notification()
                .permission_state()
                .ok()
                .map(|state| state.to_string())
        })
    }

    fn request_notification_permission(&self) {
        let Some(app) = lock(&self.inner.app).clone() else {
            return;
        };
        match app.notification().request_permission() {
            Ok(tauri::plugin::PermissionState::Denied) => self.set_diagnostic(
                "Tracker nudges are enabled, but notifications are denied in system settings."
                    .into(),
            ),
            Ok(_) => {}
            Err(error) => self.set_diagnostic(format!(
                "Tracker could not check notification permission: {error}"
            )),
        }
    }

    fn sync_autostart(&self) {
        use tauri_plugin_autostart::ManagerExt;

        let Some(app) = lock(&self.inner.app).clone() else {
            return;
        };
        let config = lock(&self.inner.config).clone();
        let manager = app.autolaunch();
        let result = if config.enabled && config.launch_at_login {
            manager
                .enable()
                .map_err(|error| format!("Could not enable launch at login: {error}"))
        } else {
            manager
                .disable()
                .map_err(|error| format!("Could not disable launch at login: {error}"))
        };
        let mut diagnostic = lock(&self.inner.autostart_diagnostic);
        *diagnostic = result.err();
        if let Some(error) = diagnostic.as_deref() {
            log::warn!("{error}");
        }
    }

    fn autostart_active(&self) -> bool {
        use tauri_plugin_autostart::ManagerExt;

        lock(&self.inner.app)
            .as_ref()
            .and_then(|app| app.autolaunch().is_enabled().ok())
            .unwrap_or(false)
    }

    #[cfg(target_os = "macos")]
    fn ensure_tray(&self) -> Result<(), String> {
        use tauri::{
            menu::{Menu, MenuItem},
            tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
        };

        let mut tray = lock(&self.inner.tray);
        if tray.is_some() {
            return Ok(());
        }
        let app = lock(&self.inner.app)
            .clone()
            .ok_or_else(|| "Tracker cannot create its menu-bar item before setup.".to_string())?;
        let open = MenuItem::with_id(&app, "tracker-open", "Open Tracker", true, None::<&str>)
            .map_err(|error| format!("Could not create Tracker menu item: {error}"))?;
        let toggle = MenuItem::with_id(
            &app,
            "tracker-toggle",
            "Pause / resume tracking",
            true,
            None::<&str>,
        )
        .map_err(|error| format!("Could not create Tracker menu item: {error}"))?;
        let take_break = MenuItem::with_id(
            &app,
            "tracker-break",
            "Start 20-minute break",
            true,
            None::<&str>,
        )
        .map_err(|error| format!("Could not create Tracker menu item: {error}"))?;
        let quit = MenuItem::with_id(&app, "tracker-quit", "Quit Mimir", true, None::<&str>)
            .map_err(|error| format!("Could not create Tracker menu item: {error}"))?;
        let menu = Menu::with_items(&app, &[&open, &toggle, &take_break, &quit])
            .map_err(|error| format!("Could not create Tracker menu: {error}"))?;
        let icon = app
            .default_window_icon()
            .cloned()
            .ok_or_else(|| "Mimir has no application icon for its menu-bar item.".to_string())?;
        let builder = TrayIconBuilder::with_id("mimir-tracker")
            .menu(&menu)
            .show_menu_on_left_click(false)
            .tooltip("Mimir Tracker")
            .icon(icon)
            .icon_as_template(false)
            .on_menu_event(|app, event| match event.id.as_ref() {
                "tracker-open" => open_tracker(app),
                "tracker-toggle" => {
                    let state = app.state::<TrackerRuntimeState>();
                    let Ok(runtime) = state.runtime() else {
                        return;
                    };
                    let armed = lock(&runtime.inner.config).armed;
                    if let Err(error) = runtime.set_armed(!armed) {
                        log::error!("Could not toggle Tracker from the menu bar: {error}");
                    }
                }
                "tracker-break" => {
                    let state = app.state::<TrackerRuntimeState>();
                    let result = state.runtime().and_then(|runtime| runtime.start_break(20));
                    if let Err(error) = result {
                        log::error!("Could not start Tracker break from the menu bar: {error}");
                    }
                }
                "tracker-quit" => {
                    if let Some(main) = app.get_webview_window("main") {
                        let _ = main.show();
                        let _ = main.set_focus();
                        let _ = main.emit("mimir://quit-requested", ());
                    }
                }
                _ => {}
            })
            .on_tray_icon_event(|tray, event| {
                if matches!(
                    event,
                    TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    }
                ) {
                    open_tracker(tray.app_handle());
                }
            });
        *tray = Some(
            builder
                .build(&app)
                .map_err(|error| format!("Could not create Tracker menu-bar item: {error}"))?,
        );
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    fn ensure_tray(&self) -> Result<(), String> {
        Ok(())
    }

    #[cfg(target_os = "macos")]
    fn remove_tray(&self) {
        lock(&self.inner.tray).take();
    }

    #[cfg(not(target_os = "macos"))]
    fn remove_tray(&self) {}

    fn set_diagnostic(&self, diagnostic: String) {
        let mut current = lock(&self.inner.diagnostic);
        if current.as_deref() == Some(diagnostic.as_str()) {
            return;
        }
        *current = Some(diagnostic);
        drop(current);
        self.publish();
    }

    fn clear_diagnostic(&self) {
        let mut current = lock(&self.inner.diagnostic);
        if current.take().is_some() {
            drop(current);
            self.publish();
        }
    }

    fn clear_diagnostic_prefix(&self, prefix: &str) {
        let mut current = lock(&self.inner.diagnostic);
        if current
            .as_deref()
            .is_some_and(|value| value.starts_with(prefix))
        {
            *current = None;
            drop(current);
            self.publish();
        }
    }

    fn publish(&self) {
        let revision = self.inner.revision.fetch_add(1, Ordering::Relaxed) + 1;
        let Some(app) = lock(&self.inner.app).clone() else {
            return;
        };
        let payload = serde_json::json!({
            "revision": revision,
            "status": self.status().ok(),
        });
        let _ = app.emit(TRACKER_CHANGED_EVENT, payload);
    }
}

#[cfg(target_os = "macos")]
fn open_tracker(app: &tauri::AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
        let _ = main.emit(TRACKER_OPEN_EVENT, ());
    }
}

fn eligible_nudge_window(
    config: &TrackerConfig,
    now: i64,
    current: &super::model::ActivityBlock,
    nudges: &[i64],
    history: &[super::model::ActivityBlock],
) -> Result<Option<NudgeWindow>, String> {
    let leisure_minutes = now.saturating_sub(current.start_ms) / 60_000;
    if leisure_minutes < config.nudge_grace_minutes as i64
        || nudges.len() >= config.nudge_max_per_session as usize
        || nudges.last().is_some_and(|last| {
            now.saturating_sub(*last) < (config.nudge_interval_minutes as i64) * 60_000
        })
    {
        return Ok(None);
    }

    let timezone = config
        .timezone
        .parse::<Tz>()
        .map_err(|_| format!("Tracker timezone '{}' is invalid.", config.timezone))?;
    let local = DateTime::<Utc>::from_timestamp_millis(now)
        .ok_or_else(|| "Current timestamp is outside the supported range.".to_string())?
        .with_timezone(&timezone);
    let clock_minutes = (local.hour() * 60 + local.minute()) as u16;
    if clock_minutes >= config.lunch_start_minutes && clock_minutes <= config.lunch_end_minutes {
        return Ok(None);
    }

    let day_start_ms = local_day_start_ms(now, &config.timezone)?;
    let work_today = history
        .iter()
        .filter(|block| block.activity == ActivityCategory::Work)
        .map(|block| (block.end_ms.min(now) - block.start_ms.max(day_start_ms)).max(0) / 60_000)
        .sum::<i64>();
    if clock_minutes >= config.end_of_day_minutes
        && work_today >= config.end_of_day_work_minutes as i64
    {
        return Ok(None);
    }
    if let Some(last_work) = history
        .iter()
        .rev()
        .find(|block| block.activity == ActivityCategory::Work)
    {
        let work_minutes = last_work.duration_seconds / 60;
        if work_minutes >= config.deep_work_minutes as i64
            && leisure_minutes < config.earned_break_minutes as i64
        {
            return Ok(None);
        }
    }

    Ok(Some(NudgeWindow {
        day_start_ms,
        leisure_minutes,
    }))
}

fn decode_classification_batch(
    response: &AiGenerateResponse,
) -> Result<ClassificationBatch, String> {
    if let Some(json) = &response.json {
        return serde_json::from_value(json.clone())
            .map_err(|error| format!("Classification response JSON is invalid: {error}"));
    }
    serde_json::from_str(response.text.trim())
        .map_err(|error| format!("Classification response text is not JSON: {error}"))
}

fn concrete_model(value: &str) -> Option<String> {
    (!value.trim().is_empty() && value != "auto").then(|| value.to_string())
}

fn fallback_nudge(index: usize) -> (String, String) {
    const MESSAGES: &[&str] = &[
        "Quick check-in: ready to return to the thing you meant to finish?",
        "Finish this one, then make the switch back. One small step is enough.",
        "This break has run a little long. Open the work again and start anywhere.",
        "Whenever you’re ready, the next useful step can be tiny.",
    ];
    (MESSAGES[index % MESSAGES.len()].into(), "fallback".into())
}

fn import_directory(value: Option<&str>) -> Result<PathBuf, String> {
    match value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
    {
        Some(value) => Ok(value),
        None => import::default_argus_directory(),
    }
}

fn local_day_start_ms(now_ms: i64, timezone: &str) -> Result<i64, String> {
    let timezone = timezone
        .parse::<Tz>()
        .map_err(|_| format!("Tracker timezone '{timezone}' is invalid."))?;
    let now = DateTime::<Utc>::from_timestamp_millis(now_ms)
        .ok_or_else(|| "Current timestamp is outside the supported range.".to_string())?;
    let midnight = now
        .with_timezone(&timezone)
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .ok_or_else(|| "Could not construct local midnight.".to_string())?;
    let local = match timezone.from_local_datetime(&midnight) {
        LocalResult::Single(value) => value,
        LocalResult::Ambiguous(left, right) => left.min(right),
        LocalResult::None => {
            return Err(format!(
                "Local midnight does not exist in timezone {timezone}."
            ))
        }
    };
    Ok(local.with_timezone(&Utc).timestamp_millis())
}

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[tauri::command]
pub fn tracker_status(
    state: tauri::State<'_, TrackerRuntimeState>,
) -> Result<TrackerStatus, String> {
    state.status()
}

#[tauri::command]
pub fn tracker_config_update(
    state: tauri::State<'_, TrackerRuntimeState>,
    config: TrackerConfig,
) -> Result<TrackerStatus, String> {
    state.runtime()?.update_config(config)
}

#[tauri::command]
pub fn tracker_set_enabled(
    state: tauri::State<'_, TrackerRuntimeState>,
    enabled: bool,
) -> Result<TrackerStatus, String> {
    state.runtime()?.set_enabled(enabled)
}

#[tauri::command]
pub fn tracker_set_armed(
    state: tauri::State<'_, TrackerRuntimeState>,
    armed: bool,
) -> Result<TrackerStatus, String> {
    state.runtime()?.set_armed(armed)
}

#[tauri::command]
pub fn tracker_start_break(
    state: tauri::State<'_, TrackerRuntimeState>,
    minutes: u64,
) -> Result<TrackerStatus, String> {
    state.runtime()?.start_break(minutes)
}

#[tauri::command]
pub fn tracker_end_break(
    state: tauri::State<'_, TrackerRuntimeState>,
) -> Result<TrackerStatus, String> {
    state.runtime()?.end_break()
}

#[tauri::command]
pub fn tracker_query(
    state: tauri::State<'_, TrackerRuntimeState>,
    query: TrackerQuery,
) -> Result<ActivityPage, String> {
    state.runtime()?.query(query)
}

#[tauri::command]
pub fn tracker_report(
    state: tauri::State<'_, TrackerRuntimeState>,
    start_ms: i64,
    end_ms: i64,
    timezone: Option<String>,
) -> Result<TrackerReport, String> {
    state.runtime()?.report(start_ms, end_ms, timezone)
}

#[tauri::command]
pub fn tracker_classifications(
    state: tauri::State<'_, TrackerRuntimeState>,
) -> Result<Vec<Classification>, String> {
    state.runtime()?.classifications()
}

#[tauri::command]
pub fn tracker_classification_update(
    state: tauri::State<'_, TrackerRuntimeState>,
    update: ClassificationUpdate,
) -> Result<Classification, String> {
    state.runtime()?.update_classification(update)
}

#[tauri::command]
pub fn tracker_import_preview(
    state: tauri::State<'_, TrackerRuntimeState>,
    request: ArgusImportRequest,
) -> Result<ImportPreview, String> {
    state.runtime()?.import_preview(request)
}

#[tauri::command]
pub fn tracker_import_argus(
    state: tauri::State<'_, TrackerRuntimeState>,
    request: ArgusImportRequest,
) -> Result<ImportReport, String> {
    state.runtime()?.import_argus(request)
}

#[tauri::command]
pub fn tracker_accessibility_request(
    state: tauri::State<'_, TrackerRuntimeState>,
) -> Result<TrackerStatus, String> {
    state.runtime()?.request_accessibility()
}

#[tauri::command]
pub fn tracker_context_update(
    state: tauri::State<'_, TrackerRuntimeState>,
    context: Option<String>,
) -> Result<(), String> {
    state.runtime()?.set_mimir_context(context);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tracker::ActivityBlock;
    use tempfile::TempDir;

    fn runtime() -> (TempDir, TrackerRuntime) {
        let directory = TempDir::new().unwrap();
        let runtime = TrackerRuntime::new(TrackerRuntimeConfig {
            database_path: directory.path().join("tracker.sqlite"),
        })
        .unwrap();
        (directory, runtime)
    }

    #[test]
    fn disabled_is_the_default_and_does_not_create_blocks() {
        let (_directory, runtime) = runtime();
        let status = runtime.status().unwrap();
        assert_eq!(status.mode, TrackerMode::Disabled);
        assert!(status.current.is_none());
        assert!(runtime.start_break(20).is_err());
        assert!(runtime.request_accessibility().is_err());
        runtime.start().unwrap();
        assert!(lock(&runtime.inner.worker).is_none());
    }

    #[test]
    fn unavailable_tracker_storage_does_not_prevent_managed_state_construction() {
        let directory = TempDir::new().unwrap();
        let blocker = directory.path().join("not-a-directory");
        std::fs::write(&blocker, b"keep me").unwrap();

        let state = TrackerRuntimeState::new(TrackerRuntimeConfig {
            database_path: blocker.join("tracker.sqlite"),
        });
        let status = state.status().unwrap();

        assert!(state.runtime.is_none());
        assert!(!state.background_launch_enabled());
        assert_eq!(status.mode, TrackerMode::Error);
        assert!(!status.config.enabled);
        assert!(status
            .diagnostic
            .as_deref()
            .is_some_and(|value| value.contains("Mimir can continue")));
        assert_eq!(std::fs::read(&blocker).unwrap(), b"keep me");
    }

    #[test]
    fn newer_tracker_schema_stays_untouched_while_mimir_can_continue() {
        let directory = TempDir::new().unwrap();
        let path = directory.path().join("tracker.sqlite");
        let connection = rusqlite::Connection::open(&path).unwrap();
        connection
            .pragma_update(
                None,
                "user_version",
                super::super::model::TRACKER_SCHEMA_VERSION + 1,
            )
            .unwrap();
        drop(connection);

        let state = TrackerRuntimeState::new(TrackerRuntimeConfig {
            database_path: path.clone(),
        });

        assert!(state.runtime.is_none());
        assert!(state
            .status()
            .unwrap()
            .diagnostic
            .unwrap()
            .contains("newer"));
        let version = rusqlite::Connection::open(path)
            .unwrap()
            .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap();
        assert_eq!(version, super::super::model::TRACKER_SCHEMA_VERSION + 1);
    }

    #[test]
    fn break_state_survives_runtime_reopen() {
        let (directory, runtime) = runtime();
        let mut config = lock(&runtime.inner.config).clone();
        config.enabled = true;
        lock(&runtime.inner.store).save_config(&config).unwrap();
        *lock(&runtime.inner.config) = config;
        runtime.start_break(20).unwrap();
        drop(runtime);
        let reopened = TrackerRuntime::new(TrackerRuntimeConfig {
            database_path: directory.path().join("tracker.sqlite"),
        })
        .unwrap();
        assert!(lock(&reopened.inner.runtime_state).break_end_ms.is_some());
    }

    #[test]
    fn active_break_gap_reopens_as_break_instead_of_off() {
        let directory = TempDir::new().unwrap();
        let path = directory.path().join("tracker.sqlite");
        let now = now_ms();
        {
            let store = TrackerStore::open(&path).unwrap();
            store
                .save_config(&TrackerConfig {
                    enabled: true,
                    timezone: "UTC".into(),
                    ..TrackerConfig::default()
                })
                .unwrap();
            store
                .insert_block(super::super::store::NewActivityBlock {
                    start_ms: now - 120_000,
                    end_ms: now - 60_000,
                    activity: ActivityCategory::Break,
                    subcategory: Some("20min break"),
                    app_name: None,
                    bundle_id: None,
                    domain: None,
                    window_title: None,
                    classification_key: None,
                    source: "manual",
                    off_reason: None,
                })
                .unwrap();
            store
                .save_runtime_state(&RuntimeState {
                    break_started_ms: Some(now - 120_000),
                    break_end_ms: Some(now + 600_000),
                    break_duration_minutes: Some(20),
                    last_shutdown_ms: Some(now - 60_000),
                })
                .unwrap();
        }
        let runtime = TrackerRuntime::new(TrackerRuntimeConfig {
            database_path: path,
        })
        .unwrap();
        runtime.recover_gap_if_needed().unwrap();

        let current = lock(&runtime.inner.store).current_block().unwrap().unwrap();
        assert_eq!(current.activity, ActivityCategory::Break);
        assert_eq!(current.source, "recovery");
        assert!(current.end_ms >= now);
    }

    #[test]
    fn local_day_start_handles_berlin_summer_time() {
        let now = "2026-07-30T10:00:00Z"
            .parse::<DateTime<Utc>>()
            .unwrap()
            .timestamp_millis();
        let start = local_day_start_ms(now, "Europe/Berlin").unwrap();
        assert_eq!(
            DateTime::<Utc>::from_timestamp_millis(start)
                .unwrap()
                .to_rfc3339(),
            "2026-07-29T22:00:00+00:00"
        );
    }

    #[test]
    fn empty_scan_does_not_delay_the_first_classification_job() {
        let (_directory, runtime) = runtime();
        let config = TrackerConfig::default();
        let first_scan = 1_000_000;
        assert!(runtime
            .classification_batch(&config, first_scan)
            .unwrap()
            .is_empty());
        assert_eq!(
            runtime.inner.last_classification_ms.load(Ordering::Relaxed),
            0
        );

        let observation = super::super::model::Observation {
            observed_at_ms: first_scan + 1,
            idle_seconds: 0,
            app_name: "Ghostty".into(),
            bundle_id: Some("com.mitchellh.ghostty".into()),
            domain: None,
            window_title: None,
            mimir_context: None,
        };
        lock(&runtime.inner.store)
            .queue_classification(&observation)
            .unwrap();
        let jobs = runtime
            .classification_batch(&config, first_scan + 1)
            .unwrap();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].key, "com.mitchellh.ghostty");
    }

    fn nudge_block(
        id: i64,
        start_ms: i64,
        end_ms: i64,
        activity: ActivityCategory,
    ) -> ActivityBlock {
        ActivityBlock {
            id,
            start_ms,
            end_ms,
            duration_seconds: (end_ms - start_ms) / 1_000,
            activity,
            subcategory: None,
            app_name: Some("Example".into()),
            bundle_id: Some("com.example.App".into()),
            domain: None,
            window_title: None,
            classification_key: Some("com.example.App".into()),
            source: "test".into(),
            off_reason: None,
        }
    }

    #[test]
    fn nudge_window_enforces_grace_spacing_and_maximum() {
        let now = "2026-07-30T15:00:00Z"
            .parse::<DateTime<Utc>>()
            .unwrap()
            .timestamp_millis();
        let config = TrackerConfig {
            timezone: "UTC".into(),
            ..TrackerConfig::default()
        };
        let eligible = nudge_block(1, now - 10 * 60_000, now, ActivityCategory::Leisure);
        assert!(eligible_nudge_window(&config, now, &eligible, &[], &[])
            .unwrap()
            .is_some());

        let too_soon = nudge_block(1, now - 2 * 60_000, now, ActivityCategory::Leisure);
        assert!(eligible_nudge_window(&config, now, &too_soon, &[], &[])
            .unwrap()
            .is_none());
        assert!(
            eligible_nudge_window(&config, now, &eligible, &[now - 60_000], &[])
                .unwrap()
                .is_none()
        );
        assert!(eligible_nudge_window(
            &config,
            now,
            &eligible,
            &[now - 30 * 60_000, now - 20 * 60_000, now - 10 * 60_000,],
            &[],
        )
        .unwrap()
        .is_none());
    }

    #[test]
    fn nudge_window_protects_earned_breaks_and_completed_days() {
        let now = "2026-07-30T15:00:00Z"
            .parse::<DateTime<Utc>>()
            .unwrap()
            .timestamp_millis();
        let config = TrackerConfig {
            timezone: "UTC".into(),
            ..TrackerConfig::default()
        };
        let leisure = nudge_block(2, now - 10 * 60_000, now, ActivityCategory::Leisure);
        let deep_work = nudge_block(
            1,
            leisure.start_ms - 90 * 60_000,
            leisure.start_ms,
            ActivityCategory::Work,
        );
        assert!(
            eligible_nudge_window(&config, now, &leisure, &[], &[deep_work])
                .unwrap()
                .is_none()
        );

        let after_earned_break = nudge_block(2, now - 25 * 60_000, now, ActivityCategory::Leisure);
        let deep_work = nudge_block(
            1,
            after_earned_break.start_ms - 90 * 60_000,
            after_earned_break.start_ms,
            ActivityCategory::Work,
        );
        assert!(
            eligible_nudge_window(&config, now, &after_earned_break, &[], &[deep_work])
                .unwrap()
                .is_some()
        );

        let end_of_day = "2026-07-30T18:00:00Z"
            .parse::<DateTime<Utc>>()
            .unwrap()
            .timestamp_millis();
        let leisure = nudge_block(
            4,
            end_of_day - 30 * 60_000,
            end_of_day,
            ActivityCategory::Leisure,
        );
        let completed_work = nudge_block(
            3,
            end_of_day - 8 * 60 * 60_000,
            end_of_day - 2 * 60 * 60_000,
            ActivityCategory::Work,
        );
        assert!(
            eligible_nudge_window(&config, end_of_day, &leisure, &[], &[completed_work])
                .unwrap()
                .is_none()
        );
    }
}
