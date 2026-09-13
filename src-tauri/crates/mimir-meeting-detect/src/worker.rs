use crate::{
    unix_millis, AppEvidence, CandidateEndReason, DetectError, DetectionConfig, DetectionEvent,
    DetectionPolicy, DetectorSnapshot, DetectorStatus, PermissionSnapshot, PermissionState,
};
use std::{
    collections::BTreeSet,
    panic::{catch_unwind, AssertUnwindSafe},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Condvar, Mutex, MutexGuard, RwLock, RwLockReadGuard, RwLockWriteGuard,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

const INITIALIZATION_TIMEOUT: Duration = Duration::from_secs(5);

pub(crate) struct WakeSignal {
    sequence: AtomicU64,
    mutex: Mutex<()>,
    condition: Condvar,
}

impl WakeSignal {
    pub(crate) fn new() -> Self {
        Self {
            sequence: AtomicU64::new(0),
            mutex: Mutex::new(()),
            condition: Condvar::new(),
        }
    }

    pub(crate) fn wake(&self) {
        self.sequence.fetch_add(1, Ordering::AcqRel);
        self.condition.notify_all();
    }

    fn wait(&self, previous: u64, timeout: Duration) -> u64 {
        if self.sequence.load(Ordering::Acquire) != previous {
            return self.sequence.load(Ordering::Acquire);
        }
        let guard = mutex_lock(&self.mutex);
        if self.sequence.load(Ordering::Acquire) == previous {
            let _guard = match self.condition.wait_timeout(guard, timeout) {
                Ok((guard, _)) => guard,
                Err(poisoned) => poisoned.into_inner().0,
            };
        }
        self.sequence.load(Ordering::Acquire)
    }
}

pub(crate) struct Observation {
    pub permission: PermissionSnapshot,
    pub active_apps: Vec<AppEvidence>,
    pub diagnostic: Option<String>,
}

pub(crate) trait ObservationSource {
    fn observe(&mut self, include_active_apps: bool) -> Observation;

    fn shutdown(&mut self) -> Result<(), DetectError> {
        Ok(())
    }
}

type DetectionCallback = dyn Fn(DetectionEvent) + Send + Sync + 'static;

struct Shared {
    enabled: AtomicBool,
    ignored_bundle_ids: RwLock<BTreeSet<String>>,
    running: AtomicBool,
    wake: Arc<WakeSignal>,
    policy: Mutex<DetectionPolicy>,
    snapshot: RwLock<DetectorSnapshot>,
    callback: Arc<DetectionCallback>,
    started_at: Instant,
}

/// Owned background detector.
///
/// The worker is joined on `stop`/drop. Native Core Audio listeners live
/// inside the worker source and are explicitly removed before that join
/// completes.
pub struct DetectionMonitor {
    shared: Arc<Shared>,
    worker_id: thread::ThreadId,
    shutdown: Mutex<WorkerShutdown>,
}

struct WorkerShutdown {
    worker: Option<JoinHandle<Result<(), DetectError>>>,
    // Read only after the worker is joined, while holding the shutdown lock.
    result: Result<(), DetectError>,
}

impl std::fmt::Debug for DetectionMonitor {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("DetectionMonitor")
            .field("snapshot", &self.snapshot())
            .finish_non_exhaustive()
    }
}

impl DetectionMonitor {
    pub fn start(
        config: DetectionConfig,
        callback: impl Fn(DetectionEvent) + Send + Sync + 'static,
    ) -> Result<Self, DetectError> {
        #[cfg(target_os = "macos")]
        {
            Self::start_with_factory(config, callback, |wake| {
                crate::macos::MacObservationSource::new(wake)
            })
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (config, callback);
            Err(DetectError::UnsupportedPlatform)
        }
    }

    pub fn start_without_callback(config: DetectionConfig) -> Result<Self, DetectError> {
        Self::start(config, |_| {})
    }

    pub fn snapshot(&self) -> DetectorSnapshot {
        rw_read(&self.shared.snapshot).clone()
    }

    pub fn set_enabled(&self, enabled: bool) {
        let previous = self.shared.enabled.swap(enabled, Ordering::AcqRel);
        if enabled && !previous {
            // Configuration commands return a snapshot immediately after this
            // call. Do not let that reply carry the worker's previous normal
            // Disabled state as an application error while the wake is still
            // crossing threads.
            let mut snapshot = rw_write(&self.shared.snapshot);
            snapshot.status = status_for(&snapshot.permission, None);
            if snapshot.diagnostic.as_deref() == Some("Meeting detection is disabled in settings") {
                snapshot.diagnostic = None;
            }
            snapshot.generation = snapshot.generation.saturating_add(1);
            snapshot.observed_at_unix_millis = Some(unix_millis());
        }
        self.shared.wake.wake();
    }

    /// Apply exclusions on the worker so suggestion/end callbacks stay ordered.
    pub fn set_ignored_bundle_ids(&self, ids: BTreeSet<String>) {
        *rw_write(&self.shared.ignored_bundle_ids) = ids;
        self.shared.wake.wake();
    }

    pub fn dismiss_candidate(&self, candidate_id: &str) -> Result<bool, DetectError> {
        let now_millis = elapsed_millis(self.shared.started_at);
        let event = {
            let mut policy = mutex_lock(&self.shared.policy);
            let event = policy.dismiss(candidate_id, now_millis)?;
            let candidates = policy.candidates();
            drop(policy);
            let mut snapshot = rw_write(&self.shared.snapshot);
            snapshot.candidates = candidates;
            snapshot.generation = snapshot.generation.saturating_add(1);
            snapshot.observed_at_unix_millis = Some(unix_millis());
            event
        };
        if let Some(event) = event {
            invoke_callback(&self.shared, event);
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// Stops and joins the worker, retaining its cleanup result for later callers.
    /// A call from a worker callback requests stop but returns `WorkerSelfJoin`;
    /// an external caller must wait for completion.
    pub fn stop(&self) -> Result<(), DetectError> {
        self.shared.running.store(false, Ordering::Release);
        self.shared.wake.wake();
        // Check before taking the lock: an external caller can hold it while
        // joining this thread, whose current callback may also request stop.
        if self.worker_id == thread::current().id() {
            return Err(DetectError::WorkerSelfJoin);
        }
        let mut shutdown = mutex_lock(&self.shutdown);
        if let Some(worker) = shutdown.worker.take() {
            shutdown.result = worker.join().unwrap_or(Err(DetectError::WorkerPanicked));
        }
        shutdown.result.clone()
    }

    fn start_with_factory<S, F>(
        config: DetectionConfig,
        callback: impl Fn(DetectionEvent) + Send + Sync + 'static,
        factory: F,
    ) -> Result<Self, DetectError>
    where
        S: ObservationSource + 'static,
        F: FnOnce(Arc<WakeSignal>) -> S + Send + 'static,
    {
        config.validate()?;
        let enabled = config.enabled;
        let poll_interval = config.poll_interval;
        let wake = Arc::new(WakeSignal::new());
        let shared = Arc::new(Shared {
            enabled: AtomicBool::new(enabled),
            ignored_bundle_ids: RwLock::new(config.ignored_bundle_ids.clone()),
            running: AtomicBool::new(true),
            wake: wake.clone(),
            policy: Mutex::new(DetectionPolicy::new(config)?),
            snapshot: RwLock::new(DetectorSnapshot {
                permission: PermissionSnapshot::unsupported(),
                status: if enabled {
                    DetectorStatus::Degraded
                } else {
                    DetectorStatus::Disabled
                },
                active_apps: Vec::new(),
                candidates: Vec::new(),
                generation: 0,
                observed_at_unix_millis: None,
                diagnostic: Some("Meeting detection is initializing".into()),
            }),
            callback: Arc::new(callback),
            started_at: Instant::now(),
        });
        let worker_shared = shared.clone();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let worker = thread::Builder::new()
            .name("mimir-meeting-detect".into())
            .spawn(move || {
                let source = factory(wake);
                run_worker(source, worker_shared, poll_interval, ready_tx)
            })
            .map_err(|error| DetectError::WorkerStart(error.to_string()))?;

        if ready_rx.recv_timeout(INITIALIZATION_TIMEOUT).is_err() {
            shared.running.store(false, Ordering::Release);
            shared.wake.wake();
            let _ = worker.join();
            return Err(DetectError::WorkerInitializationTimeout);
        }

        Ok(Self {
            shared,
            worker_id: worker.thread().id(),
            shutdown: Mutex::new(WorkerShutdown {
                worker: Some(worker),
                result: Ok(()),
            }),
        })
    }
}

impl Drop for DetectionMonitor {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

fn run_worker(
    mut source: impl ObservationSource,
    shared: Arc<Shared>,
    poll_interval: Duration,
    ready: mpsc::SyncSender<()>,
) -> Result<(), DetectError> {
    let mut wake_sequence = 0;
    let mut ready = Some(ready);

    while shared.running.load(Ordering::Acquire) {
        update_once(&mut source, &shared);
        if let Some(ready) = ready.take() {
            let _ = ready.send(());
        }
        wake_sequence = shared.wake.wait(wake_sequence, poll_interval);
    }

    let result = source.shutdown();
    if let Err(error) = &result {
        let mut snapshot = rw_write(&shared.snapshot);
        snapshot.status = DetectorStatus::Degraded;
        snapshot.diagnostic = Some(format!(
            "Meeting detection stopped, but a native listener could not be removed: {error}"
        ));
        snapshot.generation = snapshot.generation.saturating_add(1);
    }
    result
}

fn update_once(source: &mut impl ObservationSource, shared: &Shared) {
    let enabled = shared.enabled.load(Ordering::Acquire);
    let mut observation = source.observe(enabled);
    if !enabled {
        let events = mutex_lock(&shared.policy).reset(CandidateEndReason::DetectionDisabled);
        replace_snapshot(
            shared,
            observation.permission,
            DetectorStatus::Disabled,
            Vec::new(),
            Vec::new(),
            Some("Meeting detection is disabled in settings".into()),
        );
        for event in events {
            invoke_callback(shared, event);
        }
        return;
    }

    let mut events = mutex_lock(&shared.policy)
        .set_ignored_bundle_ids(rw_read(&shared.ignored_bundle_ids).clone());
    observation
        .active_apps
        .retain(|app| !mutex_lock(&shared.policy).config_excludes(app));
    if observation.permission.state != PermissionState::Granted {
        observation.active_apps.clear();
    }
    observation.active_apps.sort_by(|left, right| {
        left.bundle_id
            .cmp(&right.bundle_id)
            .then_with(|| left.process_id.cmp(&right.process_id))
    });

    let now_millis = elapsed_millis(shared.started_at);
    let (observation_events, candidates) = {
        let mut policy = mutex_lock(&shared.policy);
        let events = match observation.permission.state {
            PermissionState::Granted => {
                match policy.observe(now_millis, observation.active_apps.clone()) {
                    Ok(events) => events,
                    Err(error) => {
                        observation.diagnostic = Some(error.to_string());
                        Vec::new()
                    }
                }
            }
            _ => policy.reset(CandidateEndReason::PermissionLost),
        };
        (events, policy.candidates())
    };

    events.extend(observation_events);
    let status = status_for(&observation.permission, observation.diagnostic.as_deref());
    replace_snapshot(
        shared,
        observation.permission,
        status,
        observation.active_apps,
        candidates,
        observation.diagnostic,
    );
    for event in events {
        invoke_callback(shared, event);
    }
}

fn status_for(permission: &PermissionSnapshot, diagnostic: Option<&str>) -> DetectorStatus {
    match permission.state {
        PermissionState::Granted if diagnostic.is_some() => DetectorStatus::Degraded,
        PermissionState::Granted => DetectorStatus::Healthy,
        PermissionState::NotDetermined => DetectorStatus::PermissionRequired,
        PermissionState::Denied | PermissionState::Restricted => DetectorStatus::PermissionDenied,
        PermissionState::Unavailable => DetectorStatus::Unsupported,
        PermissionState::Error => DetectorStatus::Failed,
    }
}

fn replace_snapshot(
    shared: &Shared,
    permission: PermissionSnapshot,
    status: DetectorStatus,
    active_apps: Vec<AppEvidence>,
    candidates: Vec<crate::DetectionCandidate>,
    diagnostic: Option<String>,
) {
    let mut snapshot = rw_write(&shared.snapshot);
    let changed = snapshot.permission != permission
        || snapshot.status != status
        || snapshot.active_apps != active_apps
        || snapshot.candidates != candidates
        || snapshot.diagnostic != diagnostic;
    snapshot.permission = permission;
    snapshot.status = status;
    snapshot.active_apps = active_apps;
    snapshot.candidates = candidates;
    snapshot.diagnostic = diagnostic;
    snapshot.observed_at_unix_millis = Some(unix_millis());
    if changed {
        snapshot.generation = snapshot.generation.saturating_add(1);
    }
}

fn invoke_callback(shared: &Shared, event: DetectionEvent) {
    if catch_unwind(AssertUnwindSafe(|| (shared.callback)(event))).is_err() {
        let mut snapshot = rw_write(&shared.snapshot);
        snapshot.status = DetectorStatus::Degraded;
        snapshot.diagnostic =
            Some("A meeting detection event consumer panicked; detection remains active".into());
        snapshot.generation = snapshot.generation.saturating_add(1);
    }
}

fn elapsed_millis(started_at: Instant) -> u64 {
    started_at.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
}

fn mutex_lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn rw_read<T>(lock: &RwLock<T>) -> RwLockReadGuard<'_, T> {
    lock.read().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn rw_write<T>(lock: &RwLock<T>) -> RwLockWriteGuard<'_, T> {
    lock.write()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    struct FakeSource {
        shutdowns: Arc<AtomicUsize>,
        drops: Arc<AtomicUsize>,
    }

    impl ObservationSource for FakeSource {
        fn observe(&mut self, include_active_apps: bool) -> Observation {
            Observation {
                permission: PermissionSnapshot {
                    state: PermissionState::Granted,
                    can_request: false,
                    remediation: None,
                },
                active_apps: if include_active_apps {
                    vec![AppEvidence {
                        process_id: 42,
                        bundle_id: Some("us.zoom.xos".into()),
                        app_name: "Zoom".into(),
                    }]
                } else {
                    Vec::new()
                },
                diagnostic: None,
            }
        }

        fn shutdown(&mut self) -> Result<(), DetectError> {
            self.shutdowns.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    struct DeniedSource;

    impl ObservationSource for DeniedSource {
        fn observe(&mut self, _include_active_apps: bool) -> Observation {
            Observation {
                permission: PermissionSnapshot {
                    state: PermissionState::Denied,
                    can_request: false,
                    remediation: Some(
                        "Enable Mimir in System Settings > Privacy & Security > Microphone".into(),
                    ),
                },
                // A buggy source must still not create candidates when TCC is
                // denied; the worker gates policy transitions on permission.
                active_apps: vec![AppEvidence {
                    process_id: 42,
                    bundle_id: Some("us.zoom.xos".into()),
                    app_name: "Zoom".into(),
                }],
                diagnostic: None,
            }
        }
    }

    impl Drop for FakeSource {
        fn drop(&mut self) {
            self.drops.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[test]
    fn exclusion_updates_wake_worker_and_end_then_restore_suggestions() {
        let (send, receive) = mpsc::channel();
        let monitor = DetectionMonitor::start_with_factory(
            DetectionConfig {
                sustained_use: Duration::ZERO,
                poll_interval: Duration::from_secs(30),
                ..DetectionConfig::default()
            },
            move |event| {
                send.send(event).unwrap();
            },
            |_| FakeSource {
                shutdowns: Arc::new(AtomicUsize::new(0)),
                drops: Arc::new(AtomicUsize::new(0)),
            },
        )
        .unwrap();
        let DetectionEvent::CandidateSuggested(first) =
            receive.recv_timeout(Duration::from_secs(2)).unwrap()
        else {
            panic!("expected suggestion")
        };
        monitor.set_ignored_bundle_ids(BTreeSet::from(["us.zoom.xos".into()]));
        assert_eq!(
            receive.recv_timeout(Duration::from_secs(2)).unwrap(),
            DetectionEvent::CandidateEnded {
                candidate_id: first.id.clone(),
                reason: CandidateEndReason::Ignored,
            }
        );
        assert!(monitor.snapshot().candidates.is_empty());
        assert!(monitor.snapshot().active_apps.is_empty());
        monitor.set_ignored_bundle_ids(BTreeSet::new());
        let DetectionEvent::CandidateSuggested(next) =
            receive.recv_timeout(Duration::from_secs(2)).unwrap()
        else {
            panic!("expected restored suggestion")
        };
        assert_ne!(first.id, next.id);
        monitor.stop().unwrap();
    }

    #[test]
    fn stop_joins_worker_after_source_shutdown() {
        let shutdowns = Arc::new(AtomicUsize::new(0));
        let drops = Arc::new(AtomicUsize::new(0));
        let shutdown_counter = shutdowns.clone();
        let drop_counter = drops.clone();
        let monitor = DetectionMonitor::start_with_factory(
            DetectionConfig {
                sustained_use: Duration::ZERO,
                poll_interval: Duration::from_millis(100),
                ..DetectionConfig::default()
            },
            |_| {},
            move |_| FakeSource {
                shutdowns: shutdown_counter,
                drops: drop_counter,
            },
        )
        .unwrap();

        assert_eq!(monitor.snapshot().candidates.len(), 1);
        monitor.stop().unwrap();
        assert_eq!(shutdowns.load(Ordering::SeqCst), 1);
        assert_eq!(drops.load(Ordering::SeqCst), 1);
        monitor.stop().unwrap();
        assert_eq!(shutdowns.load(Ordering::SeqCst), 1);
    }

    struct ShutdownSource {
        result: Result<(), DetectError>,
        panic: bool,
        shutdowns: Arc<AtomicUsize>,
        entered: Option<mpsc::Sender<()>>,
        release: Option<mpsc::Receiver<()>>,
    }

    impl ObservationSource for ShutdownSource {
        fn observe(&mut self, _: bool) -> Observation {
            Observation {
                permission: PermissionSnapshot {
                    state: PermissionState::Granted,
                    can_request: false,
                    remediation: None,
                },
                active_apps: Vec::new(),
                diagnostic: None,
            }
        }

        fn shutdown(&mut self) -> Result<(), DetectError> {
            self.shutdowns.fetch_add(1, Ordering::SeqCst);
            if let Some(entered) = self.entered.take() {
                entered.send(()).unwrap();
            }
            if let Some(release) = self.release.take() {
                release.recv_timeout(Duration::from_secs(5)).unwrap();
            }
            assert!(!self.panic, "injected shutdown panic");
            self.result.clone()
        }
    }

    #[test]
    fn failed_shutdown_and_worker_panic_are_retained_for_repeated_stop() {
        for panic in [false, true] {
            let shutdowns = Arc::new(AtomicUsize::new(0));
            let count = shutdowns.clone();
            let monitor = DetectionMonitor::start_with_factory(
                DetectionConfig::default(),
                |_| {},
                move |_| ShutdownSource {
                    result: Err(DetectError::Native("injected removal failure".into())),
                    panic,
                    shutdowns: count,
                    entered: None,
                    release: None,
                },
            )
            .unwrap();

            for _ in 0..2 {
                let error = monitor.stop().unwrap_err();
                if panic {
                    assert!(matches!(error, DetectError::WorkerPanicked));
                } else {
                    assert!(
                        matches!(error, DetectError::Native(ref message) if message == "injected removal failure")
                    );
                    assert!(monitor
                        .snapshot()
                        .diagnostic
                        .unwrap()
                        .contains("injected removal failure"));
                }
            }
            drop(monitor);
            assert_eq!(shutdowns.load(Ordering::SeqCst), 1);
        }
    }

    #[test]
    fn concurrent_stop_waits_for_cleanup_and_returns_the_same_result() {
        for fail in [false, true] {
            let shutdowns = Arc::new(AtomicUsize::new(0));
            let count = shutdowns.clone();
            let (entered_tx, entered_rx) = mpsc::channel();
            let (release_tx, release_rx) = mpsc::channel();
            let monitor = Arc::new(
                DetectionMonitor::start_with_factory(
                    DetectionConfig::default(),
                    |_| {},
                    move |_| ShutdownSource {
                        result: if fail {
                            Err(DetectError::Native("injected removal failure".into()))
                        } else {
                            Ok(())
                        },
                        panic: false,
                        shutdowns: count,
                        entered: Some(entered_tx),
                        release: Some(release_rx),
                    },
                )
                .unwrap(),
            );
            let first_monitor = monitor.clone();
            let first = thread::spawn(move || first_monitor.stop());
            entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();

            let (attempt_tx, attempt_rx) = mpsc::channel();
            let (result_tx, result_rx) = mpsc::channel();
            let second_monitor = monitor.clone();
            let second = thread::spawn(move || {
                attempt_tx.send(()).unwrap();
                result_tx.send(second_monitor.stop()).unwrap();
            });
            attempt_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            let early_result = result_rx.recv_timeout(Duration::from_millis(100));
            // Release cleanup before assertions so a failed test cannot strand it.
            release_tx.send(()).unwrap();
            let first_result = first.join().unwrap().map_err(|error| error.to_string());
            second.join().unwrap();
            assert!(matches!(early_result, Err(mpsc::RecvTimeoutError::Timeout)));
            let second_result = result_rx
                .recv_timeout(Duration::from_secs(5))
                .unwrap()
                .map_err(|error| error.to_string());
            assert_eq!(first_result.is_err(), fail);
            assert_eq!(first_result, second_result);
            assert_eq!(shutdowns.load(Ordering::SeqCst), 1);
        }
    }

    #[test]
    fn worker_callback_cannot_deadlock_an_external_stop() {
        let owner = Arc::new(Mutex::new(None::<std::sync::Weak<DetectionMonitor>>));
        let callback_owner = owner.clone();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let release_rx = Mutex::new(release_rx);
        let (callback_tx, callback_rx) = mpsc::channel();
        let monitor = Arc::new(
            DetectionMonitor::start_with_factory(
                DetectionConfig {
                    enabled: false,
                    sustained_use: Duration::ZERO,
                    ..DetectionConfig::default()
                },
                move |event| {
                    if matches!(event, DetectionEvent::CandidateSuggested(_)) {
                        entered_tx.send(()).unwrap();
                        release_rx
                            .lock()
                            .unwrap()
                            .recv_timeout(Duration::from_secs(5))
                            .unwrap();
                        let monitor = callback_owner
                            .lock()
                            .unwrap()
                            .as_ref()
                            .unwrap()
                            .upgrade()
                            .unwrap();
                        callback_tx.send(monitor.stop()).unwrap();
                    }
                },
                |_| FakeSource {
                    shutdowns: Arc::new(AtomicUsize::new(0)),
                    drops: Arc::new(AtomicUsize::new(0)),
                },
            )
            .unwrap(),
        );
        *owner.lock().unwrap() = Some(Arc::downgrade(&monitor));
        monitor.set_enabled(true);
        entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let external_monitor = monitor.clone();
        let (external_tx, external_rx) = mpsc::channel();
        let external = thread::spawn(move || {
            external_tx.send(external_monitor.stop()).unwrap();
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        while monitor.shutdown.try_lock().is_ok() && Instant::now() < deadline {
            thread::yield_now();
        }
        let joining = monitor.shutdown.try_lock().is_err();
        release_tx.send(()).unwrap();

        assert!(
            joining,
            "external caller must be joining before the callback requests stop"
        );
        assert!(matches!(
            callback_rx.recv_timeout(Duration::from_secs(5)).unwrap(),
            Err(DetectError::WorkerSelfJoin)
        ));
        external_rx
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap();
        external.join().unwrap();
        monitor.stop().unwrap();
    }

    #[test]
    fn callback_panic_degrades_without_killing_worker() {
        let monitor = DetectionMonitor::start_with_factory(
            DetectionConfig {
                sustained_use: Duration::ZERO,
                ..DetectionConfig::default()
            },
            |_| panic!("consumer bug"),
            |_| FakeSource {
                shutdowns: Arc::new(AtomicUsize::new(0)),
                drops: Arc::new(AtomicUsize::new(0)),
            },
        )
        .unwrap();

        let snapshot = monitor.snapshot();
        assert_eq!(snapshot.status, DetectorStatus::Degraded);
        assert!(snapshot
            .diagnostic
            .as_deref()
            .unwrap()
            .contains("consumer panicked"));
        monitor.stop().unwrap();
    }

    #[test]
    fn disabling_resets_candidates_without_stopping_owned_worker() {
        let monitor = DetectionMonitor::start_with_factory(
            DetectionConfig {
                sustained_use: Duration::ZERO,
                ..DetectionConfig::default()
            },
            |_| {},
            |_| FakeSource {
                shutdowns: Arc::new(AtomicUsize::new(0)),
                drops: Arc::new(AtomicUsize::new(0)),
            },
        )
        .unwrap();
        assert_eq!(monitor.snapshot().candidates.len(), 1);

        monitor.set_enabled(false);
        for _ in 0..50 {
            if monitor.snapshot().status == DetectorStatus::Disabled {
                break;
            }
            thread::sleep(Duration::from_millis(2));
        }
        assert_eq!(monitor.snapshot().status, DetectorStatus::Disabled);
        assert!(monitor.snapshot().candidates.is_empty());
        monitor.stop().unwrap();
    }

    #[test]
    fn enabling_detection_synchronously_clears_disabled_snapshot() {
        let monitor = DetectionMonitor::start_with_factory(
            DetectionConfig {
                enabled: false,
                poll_interval: Duration::from_millis(100),
                ..DetectionConfig::default()
            },
            |_| {},
            |_| FakeSource {
                shutdowns: Arc::new(AtomicUsize::new(0)),
                drops: Arc::new(AtomicUsize::new(0)),
            },
        )
        .unwrap();
        assert_eq!(monitor.snapshot().status, DetectorStatus::Disabled);

        monitor.set_enabled(true);

        let snapshot = monitor.snapshot();
        assert_ne!(snapshot.status, DetectorStatus::Disabled);
        assert!(!snapshot
            .diagnostic
            .as_deref()
            .is_some_and(|message| message.contains("disabled in settings")));
        monitor.stop().unwrap();
    }

    #[test]
    fn tcc_denial_is_actionable_and_never_creates_candidates() {
        let monitor = DetectionMonitor::start_with_factory(
            DetectionConfig::default(),
            |_| {},
            |_| DeniedSource,
        )
        .unwrap();

        let snapshot = monitor.snapshot();
        assert_eq!(snapshot.status, DetectorStatus::PermissionDenied);
        assert!(snapshot.candidates.is_empty());
        assert!(snapshot.active_apps.is_empty());
        assert!(snapshot
            .permission
            .remediation
            .as_deref()
            .unwrap()
            .contains("System Settings"));
        monitor.stop().unwrap();
    }
}
