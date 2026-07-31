//! Production composition root for Mimir Scribe.
//!
//! This module is intentionally the only place that wires native capture,
//! detection, persistence, transcription, model management, and Tauri event
//! sinks together. Domain modules remain constructible with deterministic
//! seams; application setup receives one owned lifecycle handle whose drop
//! cooperatively stops every background worker started here.

#[cfg(any(test, target_os = "macos"))]
use super::platform::MeetingEnvironmentProjection;
#[cfg(not(target_os = "macos"))]
use super::platform::UnavailableMeetingEnvironment;
#[cfg(any(test, target_os = "macos"))]
use super::runtime::{MeetingCandidate, MeetingPermissions};
use super::{
    capture::NativeMeetingCapture,
    commands::{TauriMeetingEventSink, TauriMeetingPlatformChangeSink},
    local_whisper::ManagedWhisperTranscriber,
    platform::{
        builtin_model_catalog, MeetingEnvironmentProbe, MeetingPlatformChangeSink,
        MeetingPlatformPaths, NativeMeetingPlatform,
    },
    runtime::{
        MeetingCapturePort, MeetingClock, MeetingEventSink, MeetingPlatformPort, MeetingRuntime,
        MeetingTranscriptionPort, SystemMeetingClock,
    },
    transcriber::{
        MeetingCredentialResolver, NativeMeetingTranscriber, RuntimeRouteResolver,
        TranscriptionChangeSink, TranscriptionProviderResolver,
    },
    MeetingStore,
};
use crate::persistence::{ensure_private_directory, ensure_private_subdirectory};
use chrono::Utc;
use mimir_meeting_detect::DetectionMonitor;
#[cfg(test)]
use mimir_meeting_detect::PermissionState;
#[cfg(any(test, target_os = "macos"))]
use mimir_meeting_detect::{DetectionCandidate, DetectorSnapshot};
#[cfg(target_os = "macos")]
use mimir_meeting_detect::{DetectionConfig, DetectionEvent};
#[cfg(target_os = "macos")]
use std::collections::HashSet;
use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex, MutexGuard,
    },
    thread::{self, JoinHandle},
    time::Duration,
};
#[cfg(target_os = "macos")]
use tauri_plugin_notification::NotificationExt;

const STORE_FILE_NAME: &str = "meetings.sqlite";
const RETENTION_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

/// Fully assembled native meeting subsystem.
///
/// Application setup should manage `runtime()` as Tauri state and retain this
/// owner as state as well:
///
/// ```ignore
/// let meetings = bootstrap_native_meeting_engine(app.handle(), mimir_root)?;
/// app.manage(meetings.runtime());
/// app.manage(meetings);
/// ```
pub struct NativeMeetingEngine {
    paths: MeetingPlatformPaths,
    runtime: MeetingRuntime,
    store: Arc<MeetingStore>,
    platform: Arc<NativeMeetingPlatform>,
    capture: Arc<NativeMeetingCapture>,
    transcription: Arc<NativeMeetingTranscriber>,
    lifecycle: NativeMeetingLifecycle,
}

/// Assemble Scribe in the current user's canonical `~/.mimir` directory.
pub fn bootstrap_native_meeting_engine_for_user(
    app: &tauri::AppHandle,
) -> Result<NativeMeetingEngine, String> {
    let root = dirs::home_dir()
        .ok_or_else(|| "Could not locate the home directory for Scribe data".to_string())?
        .join(".mimir");
    bootstrap_native_meeting_engine(app, root)
}

impl NativeMeetingEngine {
    pub fn paths(&self) -> MeetingPlatformPaths {
        self.paths.clone()
    }

    pub fn runtime(&self) -> MeetingRuntime {
        self.runtime.clone()
    }

    pub fn store(&self) -> Arc<MeetingStore> {
        Arc::clone(&self.store)
    }

    pub fn platform(&self) -> Arc<NativeMeetingPlatform> {
        Arc::clone(&self.platform)
    }

    pub fn capture_port(&self) -> Arc<dyn MeetingCapturePort> {
        self.capture.clone()
    }

    pub fn transcription_port(&self) -> Arc<dyn MeetingTranscriptionPort> {
        self.transcription.clone()
    }

    /// Idempotently stops maintenance and native detector listeners.
    pub fn shutdown(&self) -> Result<(), String> {
        self.lifecycle.shutdown()
    }
}

impl Drop for NativeMeetingEngine {
    fn drop(&mut self) {
        if let Err(error) = self.lifecycle.shutdown() {
            log::error!("Scribe native lifecycle did not stop cleanly: {error}");
        }
    }
}

/// Assemble the production engine under the provided `~/.mimir` equivalent.
///
/// The explicit path keeps tests and future profile support deterministic; the
/// caller remains responsible for choosing the user-scoped Mimir root.
pub fn bootstrap_native_meeting_engine(
    app: &tauri::AppHandle,
    mimir_root: impl AsRef<Path>,
) -> Result<NativeMeetingEngine, String> {
    let mimir_root = mimir_root.as_ref();
    let paths = MeetingPlatformPaths::from_mimir_root(mimir_root);
    ensure_private_directory(mimir_root)
        .map_err(|error| format!("Could not secure Mimir's private data directory: {error}"))?;
    ensure_private_subdirectory(mimir_root, "meetings")
        .map_err(|error| format!("Could not secure Scribe data directory: {error}"))?;
    let store = Arc::new(
        MeetingStore::open(paths.meetings_root.join(STORE_FILE_NAME))
            .map_err(|error| error.to_string())?,
    );

    let changes = TauriMeetingPlatformChangeSink::new(app);
    #[cfg(target_os = "macos")]
    let (detector, environment): (
        Option<Arc<DetectionMonitor>>,
        Arc<dyn MeetingEnvironmentProbe>,
    ) = {
        let callback_changes = Arc::clone(&changes);
        let notification_app = app.clone();
        let notified_candidates = Arc::new(Mutex::new(HashSet::<String>::new()));
        let callback_notified_candidates = Arc::clone(&notified_candidates);
        match DetectionMonitor::start(
            DetectionConfig {
                // The durable native config is applied by platform
                // construction before this bootstrap returns.
                enabled: false,
                ..DetectionConfig::default()
            },
            move |event| {
                handle_detection_notification(
                    &notification_app,
                    &callback_notified_candidates,
                    &event,
                );
                MeetingPlatformChangeSink::changed(callback_changes.as_ref(), "detection");
            },
        ) {
            Ok(detector) => {
                let detector = Arc::new(detector);
                (
                    Some(Arc::clone(&detector)),
                    Arc::new(DetectionEnvironment::new(detector)),
                )
            }
            Err(error) => {
                // Detection is an assistive suggestion, not a prerequisite
                // for deliberate manual capture. A Core Audio listener
                // failure must not prevent Mimir (or Scribe) from launching.
                let diagnostic =
                    format!("Meeting detection is unavailable in this launch: {error}");
                log::error!("{diagnostic}");
                (None, Arc::new(DegradedDetectionEnvironment { diagnostic }))
            }
        }
    };
    #[cfg(not(target_os = "macos"))]
    let (detector, environment): (
        Option<Arc<DetectionMonitor>>,
        Arc<dyn MeetingEnvironmentProbe>,
    ) = (None, Arc::new(UnavailableMeetingEnvironment));

    let catalog = builtin_model_catalog()?;
    let manifests = catalog
        .iter()
        .map(|entry| entry.manifest.clone())
        .collect::<Vec<_>>();
    let platform = Arc::new(NativeMeetingPlatform::production(
        paths.clone(),
        Arc::clone(&store),
        catalog,
        environment,
        changes.clone(),
    )?);

    let local = Arc::new(ManagedWhisperTranscriber::production(
        platform.clone(),
        manifests,
    )?);
    let credentials = Arc::new(EndpointBoundMeetingCredentialResolver::new(
        platform.clone(),
    ));
    let transcription = Arc::new(NativeMeetingTranscriber::new(
        Arc::clone(&store),
        paths.meetings_root.clone(),
        Arc::new(RuntimeRouteResolver) as Arc<dyn TranscriptionProviderResolver>,
        credentials,
        local,
        changes.clone() as Arc<dyn TranscriptionChangeSink>,
    )?);
    let capture = Arc::new(NativeMeetingCapture::new(
        Arc::clone(&store),
        paths.meetings_root.clone(),
    )?);
    let runtime = MeetingRuntime::new(
        Arc::clone(&store),
        capture.clone() as Arc<dyn MeetingCapturePort>,
        transcription.clone() as Arc<dyn MeetingTranscriptionPort>,
        platform.clone() as Arc<dyn MeetingPlatformPort>,
        Arc::new(SystemMeetingClock) as Arc<dyn MeetingClock>,
        TauriMeetingEventSink::new(app) as Arc<dyn MeetingEventSink>,
    )
    .map_err(|error| error.to_string())?;
    capture.install_failure_sink(runtime.capture_failure_sink())?;
    let recovered_deletions = platform.recover_pending_deletions()?;
    if !recovered_deletions.is_empty() {
        MeetingPlatformChangeSink::changed(changes.as_ref(), "deletion-recovery");
    }
    let retention = RetentionMaintenance::start(
        Arc::clone(&platform),
        changes as Arc<dyn MeetingPlatformChangeSink>,
        RETENTION_INTERVAL,
    )?;

    Ok(NativeMeetingEngine {
        paths,
        runtime,
        store,
        platform,
        capture,
        transcription,
        lifecycle: NativeMeetingLifecycle {
            detector,
            retention,
            stopped: AtomicBool::new(false),
        },
    })
}

#[cfg(target_os = "macos")]
fn handle_detection_notification(
    app: &tauri::AppHandle,
    notified: &Mutex<HashSet<String>>,
    event: &DetectionEvent,
) {
    let Ok(mut notified) = notified.lock() else {
        log::warn!("Scribe candidate-notification state was poisoned");
        return;
    };
    match event {
        DetectionEvent::CandidateEnded { candidate_id, .. } => {
            notified.remove(candidate_id);
        }
        DetectionEvent::CandidateSuggested(candidate) => {
            if !notified.insert(candidate.id.clone()) {
                return;
            }
            let app_name = candidate.app_name.chars().take(120).collect::<String>();
            if let Err(error) = app
                .notification()
                .builder()
                .title("Meeting detected")
                .body(format!(
                    "{app_name} is using the microphone. Open Scribe to record."
                ))
                .show()
            {
                // Notification permission is independent of capture permission.
                // The in-app candidate remains authoritative and actionable.
                log::debug!("Scribe meeting notification was not shown: {error}");
            }
        }
    }
}

#[cfg(target_os = "macos")]
struct DetectionEnvironment {
    monitor: Arc<DetectionMonitor>,
}

#[cfg(target_os = "macos")]
impl DetectionEnvironment {
    fn new(monitor: Arc<DetectionMonitor>) -> Self {
        Self { monitor }
    }
}

#[cfg(target_os = "macos")]
impl MeetingEnvironmentProbe for DetectionEnvironment {
    fn projection(&self) -> Result<MeetingEnvironmentProjection, String> {
        Ok(map_detector_snapshot(self.monitor.snapshot()))
    }

    fn set_detection_enabled(&self, enabled: bool) -> Result<(), String> {
        self.monitor.set_enabled(enabled);
        Ok(())
    }

    fn dismiss_candidate(&self, candidate_id: &str) -> Result<(), String> {
        self.monitor
            .dismiss_candidate(candidate_id)
            .map(|_| ())
            .map_err(|error| format!("Could not dismiss meeting candidate: {error}"))
    }
}

#[cfg(target_os = "macos")]
struct DegradedDetectionEnvironment {
    diagnostic: String,
}

#[cfg(target_os = "macos")]
impl MeetingEnvironmentProbe for DegradedDetectionEnvironment {
    fn projection(&self) -> Result<MeetingEnvironmentProjection, String> {
        let permission = mimir_meeting_detect::microphone_permission();
        let identity = super::permissions::current_permission_runtime_identity();
        Ok(MeetingEnvironmentProjection {
            permissions: MeetingPermissions {
                microphone: identity.project_microphone(permission.state).into(),
                system_audio: identity.project_system_audio().into(),
            },
            candidates: Vec::new(),
            diagnostic: Some(
                permission
                    .remediation
                    .map(|remediation| format!("{} {remediation}", self.diagnostic))
                    .unwrap_or_else(|| self.diagnostic.clone()),
            ),
        })
    }

    fn set_detection_enabled(&self, enabled: bool) -> Result<(), String> {
        if enabled {
            Err(self.diagnostic.clone())
        } else {
            Ok(())
        }
    }

    fn dismiss_candidate(&self, _candidate_id: &str) -> Result<(), String> {
        Err(self.diagnostic.clone())
    }
}

#[cfg(any(test, target_os = "macos"))]
fn map_detector_snapshot(snapshot: DetectorSnapshot) -> MeetingEnvironmentProjection {
    let identity = super::permissions::current_permission_runtime_identity();
    let diagnostic = snapshot
        .diagnostic
        .or_else(|| snapshot.permission.remediation.clone());
    MeetingEnvironmentProjection {
        permissions: MeetingPermissions {
            microphone: identity
                .project_microphone(snapshot.permission.state)
                .into(),
            // The process-tap permission has no non-prompting preflight API.
            // Capture reports a precise actionable failure when opening it.
            system_audio: if cfg!(target_os = "macos") {
                identity.project_system_audio().into()
            } else {
                "unavailable".into()
            },
        },
        candidates: snapshot.candidates.into_iter().map(map_candidate).collect(),
        diagnostic,
    }
}

#[cfg(any(test, target_os = "macos"))]
fn map_candidate(candidate: DetectionCandidate) -> MeetingCandidate {
    MeetingCandidate {
        id: candidate.id,
        app_id: candidate.app_id,
        app_name: candidate.app_name,
        // The detector intentionally exposes monotonic elapsed time for policy
        // decisions, not a fabricated wall-clock timestamp.
        detected_at: None,
        confidence: candidate.confidence,
    }
}

/// Source of the currently configured custom endpoint and its native secret.
///
/// Kept narrow so endpoint-binding behavior can be tested without touching a
/// real keychain.
pub trait MeetingCredentialAuthority: Send + Sync {
    fn custom_credential_for(
        &self,
        endpoint: &super::config::CustomSttEndpoint,
    ) -> Result<Option<String>, String>;
}

impl MeetingCredentialAuthority for NativeMeetingPlatform {
    fn custom_credential_for(
        &self,
        endpoint: &super::config::CustomSttEndpoint,
    ) -> Result<Option<String>, String> {
        self.custom_api_key_for(endpoint)
    }
}

/// Releases a custom-provider secret only to the exact endpoint currently
/// selected in native configuration.
pub struct EndpointBoundMeetingCredentialResolver {
    authority: Arc<dyn MeetingCredentialAuthority>,
}

impl EndpointBoundMeetingCredentialResolver {
    pub fn new(authority: Arc<dyn MeetingCredentialAuthority>) -> Self {
        Self { authority }
    }
}

impl MeetingCredentialResolver for EndpointBoundMeetingCredentialResolver {
    fn bearer_token(
        &self,
        endpoint: &super::config::CustomSttEndpoint,
    ) -> Result<Option<String>, String> {
        self.authority.custom_credential_for(endpoint)
    }
}

struct NativeMeetingLifecycle {
    detector: Option<Arc<DetectionMonitor>>,
    retention: RetentionMaintenance,
    stopped: AtomicBool,
}

impl NativeMeetingLifecycle {
    fn shutdown(&self) -> Result<(), String> {
        if self.stopped.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        let retention = self.retention.shutdown();
        let detector = self
            .detector
            .as_ref()
            .map(|detector| {
                detector
                    .stop()
                    .map_err(|error| format!("Could not stop native meeting detection: {error}"))
            })
            .unwrap_or(Ok(()));
        match (retention, detector) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(first), Ok(())) | (Ok(()), Err(first)) => Err(first),
            (Err(first), Err(second)) => Err(format!("{first}; {second}")),
        }
    }
}

struct RetentionMaintenance {
    signal: Arc<(Mutex<bool>, Condvar)>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl Drop for RetentionMaintenance {
    fn drop(&mut self) {
        if let Err(error) = self.shutdown() {
            log::error!("Scribe retention maintenance did not stop cleanly: {error}");
        }
    }
}

impl RetentionMaintenance {
    fn start(
        platform: Arc<NativeMeetingPlatform>,
        changes: Arc<dyn MeetingPlatformChangeSink>,
        interval: Duration,
    ) -> Result<Self, String> {
        if interval.is_zero() {
            return Err("Scribe retention interval cannot be zero".into());
        }
        let signal = Arc::new((Mutex::new(false), Condvar::new()));
        let worker_signal = Arc::clone(&signal);
        let worker = thread::Builder::new()
            .name("mimir-scribe-retention".into())
            .spawn(move || retention_loop(platform, changes, worker_signal, interval))
            .map_err(|error| format!("Could not start Scribe retention maintenance: {error}"))?;
        Ok(Self {
            signal,
            worker: Mutex::new(Some(worker)),
        })
    }

    fn shutdown(&self) -> Result<(), String> {
        {
            let mut stopping = lock(&self.signal.0, "retention stop flag")?;
            *stopping = true;
            self.signal.1.notify_all();
        }
        let Some(worker) = lock(&self.worker, "retention worker")?.take() else {
            return Ok(());
        };
        if worker.thread().id() == thread::current().id() {
            return Err("Scribe retention worker cannot join itself".into());
        }
        worker
            .join()
            .map_err(|_| "Scribe retention worker panicked during shutdown".into())
    }
}

fn retention_loop(
    platform: Arc<NativeMeetingPlatform>,
    changes: Arc<dyn MeetingPlatformChangeSink>,
    signal: Arc<(Mutex<bool>, Condvar)>,
    interval: Duration,
) {
    loop {
        match platform.enforce_retention(Utc::now()) {
            Ok(removed) if !removed.is_empty() => changes.changed("retention"),
            Ok(_) => {}
            Err(error) => log::error!("Scribe retention maintenance failed: {error}"),
        }

        let Ok(stopping) = signal.0.lock() else {
            log::error!("Scribe retention stop flag was poisoned");
            return;
        };
        if *stopping {
            return;
        }
        let Ok((stopping, _)) = signal.1.wait_timeout(stopping, interval) else {
            log::error!("Scribe retention wait state was poisoned");
            return;
        };
        if *stopping {
            return;
        }
    }
}

fn lock<'a, T>(mutex: &'a Mutex<T>, label: &'static str) -> Result<MutexGuard<'a, T>, String> {
    mutex
        .lock()
        .map_err(|_| format!("Scribe {label} mutex was poisoned"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use mimir_meeting_detect::{DetectionCandidate, DetectorStatus, PermissionSnapshot};
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn endpoint(url: &str) -> super::super::config::CustomSttEndpoint {
        let parsed = url::Url::parse(url).unwrap();
        super::super::config::CustomSttEndpoint::new(url, parsed.host_str().unwrap()).unwrap()
    }

    struct FakeAuthority {
        endpoint: Option<super::super::config::CustomSttEndpoint>,
        secret: Option<String>,
        reads: AtomicUsize,
    }

    impl MeetingCredentialAuthority for FakeAuthority {
        fn custom_credential_for(
            &self,
            endpoint: &super::super::config::CustomSttEndpoint,
        ) -> Result<Option<String>, String> {
            let configured = self.endpoint.as_ref().ok_or_else(|| {
                "Custom meeting transcription is not selected; refusing credential access"
                    .to_string()
            })?;
            if configured != endpoint {
                return Err(
                    "Custom meeting transcription endpoint changed; refusing credential access"
                        .into(),
                );
            }
            self.reads.fetch_add(1, Ordering::SeqCst);
            Ok(self.secret.clone())
        }
    }

    #[test]
    fn detector_snapshot_never_attributes_test_host_permission_to_mimir() {
        let projection = map_detector_snapshot(DetectorSnapshot {
            permission: PermissionSnapshot {
                state: PermissionState::Granted,
                can_request: false,
                remediation: None,
            },
            status: DetectorStatus::Healthy,
            active_apps: Vec::new(),
            candidates: vec![DetectionCandidate {
                id: "candidate-1".into(),
                app_id: "us.zoom.xos".into(),
                app_name: "Zoom".into(),
                detected_at_millis: 2_000,
                confidence: 0.92,
                process_ids: vec![42],
            }],
            generation: 3,
            observed_at_unix_millis: Some(1_800_000_000_000),
            diagnostic: None,
        });

        assert_eq!(projection.permissions.microphone, "development-host");
        assert_eq!(projection.candidates.len(), 1);
        assert_eq!(projection.candidates[0].app_id, "us.zoom.xos");
        assert_eq!(projection.candidates[0].confidence, 0.92);
        assert_eq!(projection.candidates[0].detected_at, None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn degraded_detector_keeps_manual_capture_projection_available() {
        let environment = DegradedDetectionEnvironment {
            diagnostic: "Meeting detection listener could not start".into(),
        };
        let projection = environment.projection().unwrap();

        assert!(projection.candidates.is_empty());
        assert!(projection
            .diagnostic
            .as_deref()
            .unwrap()
            .contains("could not start"));
        assert!(environment.set_detection_enabled(false).is_ok());
        assert!(environment.set_detection_enabled(true).is_err());
    }

    #[test]
    fn credential_is_released_only_for_the_exact_configured_endpoint() {
        let configured = endpoint("wss://stt.example.com/v1/listen");
        let authority = Arc::new(FakeAuthority {
            endpoint: Some(configured.clone()),
            secret: Some("native-secret".into()),
            reads: AtomicUsize::new(0),
        });
        let resolver = EndpointBoundMeetingCredentialResolver::new(authority.clone());

        assert_eq!(
            resolver.bearer_token(&configured).unwrap().as_deref(),
            Some("native-secret")
        );
        assert_eq!(authority.reads.load(Ordering::SeqCst), 1);

        let other = endpoint("wss://other.example.com/v1/listen");
        assert!(resolver
            .bearer_token(&other)
            .unwrap_err()
            .contains("refusing"));
        assert_eq!(authority.reads.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn credential_is_not_read_when_custom_mode_is_not_selected() {
        let authority = Arc::new(FakeAuthority {
            endpoint: None,
            secret: Some("native-secret".into()),
            reads: AtomicUsize::new(0),
        });
        let resolver = EndpointBoundMeetingCredentialResolver::new(authority.clone());

        assert!(resolver
            .bearer_token(&endpoint("wss://stt.example.com/v1/listen"))
            .unwrap_err()
            .contains("not selected"));
        assert_eq!(authority.reads.load(Ordering::SeqCst), 0);
    }
}
