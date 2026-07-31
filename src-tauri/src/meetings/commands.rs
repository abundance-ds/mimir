//! Tauri IPC boundary for the meeting runtime.
//!
//! Command names and camel-cased arguments intentionally mirror
//! `src/services/meetings.js`. Potentially blocking native work is moved off
//! Tauri's command task before entering the serialized runtime.

use super::platform::MeetingPlatformChangeSink;
use super::runtime::{
    MeetingConfigPatch, MeetingDeleteMode, MeetingEvent, MeetingEventSink, MeetingExport,
    MeetingExportFormat, MeetingLibraryCursor, MeetingLibraryPage, MeetingRuntime, MeetingSnapshot,
    MeetingStartConsentContext, MeetingTranscriptCursor, MeetingTranscriptPage, MeetingUpdatePatch,
    StartMeetingRequest, MEETING_EVENT,
};
use super::transcriber::TranscriptionChangeSink;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::Emitter;
use uuid::Uuid;

pub const MEETING_PLATFORM_CHANGED_EVENT: &str = "mimir://meeting-platform-changed";
const TRANSCRIPT_EVENT_INTERVAL: Duration = Duration::from_millis(100);
const MAIN_WINDOW_LABEL: &str = "main";
const START_CONSENT_TTL: Duration = Duration::from_secs(45);
const MAX_CONSENT_RECORDS: usize = 32;
const SYSTEM_AUDIO_SETTINGS_URL: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

/// Renderer declaration of the disclosure currently on screen.
///
/// The native command compares this with the authoritative platform
/// projection before issuing any grant. A renderer refresh/config race
/// therefore produces a review-again error, not authority for unseen terms.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingStartDisclosureRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidate_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidate_app_name: Option<String>,
    pub transcription_mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destination: Option<String>,
    pub model: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingStartConsentDisclosure {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidate_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidate_app_name: Option<String>,
    pub transcription_mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destination: Option<String>,
    pub model: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingStartConsentGrant {
    token: String,
    request_id: String,
    expires_in_ms: u64,
    disclosure: MeetingStartConsentDisclosure,
}

impl std::fmt::Debug for MeetingStartConsentGrant {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("MeetingStartConsentGrant")
            .field("token", &"<redacted>")
            .field("request_id", &self.request_id)
            .field("expires_in_ms", &self.expires_in_ms)
            .field("disclosure", &self.disclosure)
            .finish()
    }
}

#[cfg(test)]
impl MeetingStartConsentGrant {
    pub(crate) fn fixture(
        token: impl Into<String>,
        request_id: impl Into<String>,
        expires_in_ms: u64,
        disclosure: MeetingStartConsentDisclosure,
    ) -> Self {
        Self {
            token: token.into(),
            request_id: request_id.into(),
            expires_in_ms,
            disclosure,
        }
    }
}

#[derive(Clone)]
pub struct MeetingStartConsentAuthority {
    inner: Arc<Mutex<ConsentAuthorityState>>,
    ttl: Duration,
}

#[derive(Default)]
struct ConsentAuthorityState {
    records: HashMap<String, ConsentRecord>,
    order: VecDeque<String>,
}

struct ConsentRecord {
    request_id: String,
    window_label: String,
    context: MeetingStartConsentContext,
    expires_at: Instant,
    state: ConsentRecordState,
}

enum ConsentRecordState {
    Issued,
    InFlight,
    Completed { meeting_id: String },
}

#[derive(Debug)]
struct ConsentUse {
    digest: String,
}

#[derive(Debug)]
enum ConsentStart {
    Fresh(ConsentUse),
    CompletedReplay { meeting_id: String },
}

impl Default for MeetingStartConsentAuthority {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(ConsentAuthorityState::default())),
            ttl: START_CONSENT_TTL,
        }
    }
}

impl MeetingStartConsentAuthority {
    fn issue(
        &self,
        window_label: &str,
        context: MeetingStartConsentContext,
        disclosed: &MeetingStartDisclosureRequest,
    ) -> Result<MeetingStartConsentGrant, String> {
        self.issue_at(window_label, context, disclosed, Instant::now())
    }

    fn issue_at(
        &self,
        window_label: &str,
        context: MeetingStartConsentContext,
        disclosed: &MeetingStartDisclosureRequest,
        now: Instant,
    ) -> Result<MeetingStartConsentGrant, String> {
        require_main_window(window_label)?;
        if !disclosure_matches(disclosed, &context) {
            return Err(
                "Recording settings or the selected meeting suggestion changed. Review the disclosure and confirm again."
                    .into(),
            );
        }

        // Two UUIDv4 values provide 244 random bits. Only a SHA-256 digest is
        // retained natively, so the bearer value cannot be recovered from
        // memory after it has crossed IPC.
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let request_id = format!("scribe-start-{}", Uuid::new_v4());
        let digest = consent_digest(&token);
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "meeting consent authority is unavailable".to_string())?;
        prune_consent_records(&mut state, now);

        // The main window has one consent surface. Opening/confirming it again
        // revokes any prior unused grant, preventing a hidden token stockpile.
        let stale = state
            .records
            .iter()
            .filter(|(_, record)| {
                record.window_label == window_label
                    && matches!(record.state, ConsentRecordState::Issued)
            })
            .map(|(digest, _)| digest.clone())
            .collect::<Vec<_>>();
        for digest in stale {
            state.records.remove(&digest);
            state.order.retain(|value| value != &digest);
        }
        while state.records.len() >= MAX_CONSENT_RECORDS {
            let Some(oldest) = state.order.pop_front() else {
                return Err("too many meeting consent requests are active".into());
            };
            if matches!(
                state.records.get(&oldest).map(|record| &record.state),
                Some(ConsentRecordState::InFlight)
            ) {
                state.order.push_back(oldest);
                if state.order.iter().all(|digest| {
                    matches!(
                        state.records.get(digest).map(|record| &record.state),
                        Some(ConsentRecordState::InFlight)
                    )
                }) {
                    return Err("too many meeting consent requests are active".into());
                }
                continue;
            }
            state.records.remove(&oldest);
        }
        state.records.insert(
            digest.clone(),
            ConsentRecord {
                request_id: request_id.clone(),
                window_label: window_label.into(),
                context: context.clone(),
                expires_at: now + self.ttl,
                state: ConsentRecordState::Issued,
            },
        );
        state.order.push_back(digest);
        Ok(MeetingStartConsentGrant {
            token,
            request_id,
            expires_in_ms: self.ttl.as_millis().try_into().unwrap_or(u64::MAX),
            disclosure: disclosure_from_context(&context),
        })
    }

    fn begin_start(
        &self,
        window_label: &str,
        request_id: Option<&str>,
        token: Option<&str>,
        context: &MeetingStartConsentContext,
    ) -> Result<ConsentStart, String> {
        self.begin_start_at(window_label, request_id, token, context, Instant::now())
    }

    fn begin_start_at(
        &self,
        window_label: &str,
        request_id: Option<&str>,
        token: Option<&str>,
        context: &MeetingStartConsentContext,
        now: Instant,
    ) -> Result<ConsentStart, String> {
        let token = token
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                "Recording consent confirmation is missing. Review the disclosure and confirm again."
                    .to_string()
            })?;
        let request_id = request_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "Native recording consent request ID is missing".to_string())?;
        let digest = consent_digest(token);
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "meeting consent authority is unavailable".to_string())?;
        let Some(mut record) = state.records.remove(&digest) else {
            prune_consent_records(&mut state, now);
            return Err(
                "Recording consent is invalid or has already been used. Review the disclosure and confirm again."
                    .into(),
            );
        };
        state.order.retain(|value| value != &digest);
        prune_consent_records(&mut state, now);

        // Mismatches consume the grant. This prevents an attacker from probing
        // its bindings and then replaying it with corrected values.
        require_main_window(window_label)?;
        if record.window_label != window_label {
            return Err("Recording consent belongs to a different Mimir window".into());
        }
        if record.expires_at <= now {
            return Err(
                "Recording consent expired. Review the disclosure and confirm again.".into(),
            );
        }
        if record.request_id != request_id {
            return Err("Recording consent request ID does not match".into());
        }
        if &record.context != context {
            return Err(
                "Recording settings or the selected meeting suggestion changed. Review the disclosure and confirm again."
                    .into(),
            );
        }

        match record.state {
            ConsentRecordState::Issued => {
                record.state = ConsentRecordState::InFlight;
                state.records.insert(digest.clone(), record);
                state.order.push_back(digest.clone());
                Ok(ConsentStart::Fresh(ConsentUse { digest }))
            }
            ConsentRecordState::InFlight => {
                state.records.insert(digest.clone(), record);
                state.order.push_back(digest);
                Err("Recording start is already in progress".into())
            }
            ConsentRecordState::Completed { ref meeting_id } => {
                let meeting_id = meeting_id.clone();
                state.records.insert(digest.clone(), record);
                state.order.push_back(digest);
                Ok(ConsentStart::CompletedReplay { meeting_id })
            }
        }
    }

    fn complete(&self, consent: &ConsentUse, meeting_id: &str) {
        if let Ok(mut state) = self.inner.lock() {
            if let Some(record) = state.records.get_mut(&consent.digest) {
                if matches!(record.state, ConsentRecordState::InFlight) {
                    record.state = ConsentRecordState::Completed {
                        meeting_id: meeting_id.into(),
                    };
                }
            }
        }
    }

    fn fail(&self, consent: &ConsentUse) {
        if let Ok(mut state) = self.inner.lock() {
            state.records.remove(&consent.digest);
            state.order.retain(|value| value != &consent.digest);
        }
    }
}

fn require_main_window(window_label: &str) -> Result<(), String> {
    if window_label == MAIN_WINDOW_LABEL {
        Ok(())
    } else {
        Err("Recording may only be started from the main Mimir window".into())
    }
}

fn disclosure_matches(
    disclosed: &MeetingStartDisclosureRequest,
    context: &MeetingStartConsentContext,
) -> bool {
    disclosed.candidate_id == context.candidate_id
        && disclosed.candidate_app_name == context.candidate_app_name
        && disclosed.transcription_mode == context.transcription_mode
        && disclosed.destination == context.destination
        && disclosed.model == context.model
}

fn disclosure_from_context(context: &MeetingStartConsentContext) -> MeetingStartConsentDisclosure {
    MeetingStartConsentDisclosure {
        candidate_id: context.candidate_id.clone(),
        candidate_app_name: context.candidate_app_name.clone(),
        transcription_mode: context.transcription_mode.clone(),
        destination: context.destination.clone(),
        model: context.model.clone(),
    }
}

fn prune_consent_records(state: &mut ConsentAuthorityState, now: Instant) {
    state.records.retain(|_, record| record.expires_at > now);
    state
        .order
        .retain(|digest| state.records.contains_key(digest));
}

fn consent_digest(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}

pub struct TauriMeetingEventSink {
    app: tauri::AppHandle,
}

impl TauriMeetingEventSink {
    pub fn new(app: &tauri::AppHandle) -> Arc<Self> {
        Arc::new(Self { app: app.clone() })
    }
}

impl MeetingEventSink for TauriMeetingEventSink {
    fn publish(&self, event: &MeetingEvent) -> Result<(), String> {
        self.app
            .emit(MEETING_EVENT, event)
            .map_err(|error| format!("could not emit {MEETING_EVENT}: {error}"))
    }
}

pub struct TauriMeetingPlatformChangeSink {
    app: tauri::AppHandle,
    transcript_events: Arc<Mutex<TranscriptEventState>>,
}

#[derive(Default)]
struct TranscriptEventState {
    meeting_id: String,
    last_emit: Option<Instant>,
    trailing_pending: bool,
}

impl TauriMeetingPlatformChangeSink {
    pub fn new(app: &tauri::AppHandle) -> Arc<Self> {
        Arc::new(Self {
            app: app.clone(),
            transcript_events: Arc::new(Mutex::new(TranscriptEventState::default())),
        })
    }
}

impl MeetingPlatformChangeSink for TauriMeetingPlatformChangeSink {
    fn changed(&self, kind: &'static str) {
        let _ = self.app.emit(
            MEETING_PLATFORM_CHANGED_EVENT,
            serde_json::json!({ "kind": kind }),
        );
    }
}

impl TranscriptionChangeSink for TauriMeetingPlatformChangeSink {
    fn changed(&self, meeting_id: &str) {
        let now = Instant::now();
        let mut state = match self.transcript_events.lock() {
            Ok(state) => state,
            Err(_) => return,
        };
        if state.meeting_id != meeting_id {
            *state = TranscriptEventState {
                meeting_id: meeting_id.into(),
                last_emit: None,
                trailing_pending: false,
            };
        }
        let elapsed = state
            .last_emit
            .map(|last| now.saturating_duration_since(last))
            .unwrap_or(TRANSCRIPT_EVENT_INTERVAL);
        if elapsed >= TRANSCRIPT_EVENT_INTERVAL {
            state.last_emit = Some(now);
            state.trailing_pending = false;
            drop(state);
            emit_transcript_changed(&self.app, meeting_id);
            return;
        }
        if state.trailing_pending {
            return;
        }
        state.trailing_pending = true;
        let delay = TRANSCRIPT_EVENT_INTERVAL.saturating_sub(elapsed);
        let app = self.app.clone();
        let transcript_events = Arc::clone(&self.transcript_events);
        let reset_on_spawn_failure = Arc::clone(&self.transcript_events);
        let meeting_id = meeting_id.to_string();
        let failure_meeting_id = meeting_id.clone();
        drop(state);
        if std::thread::Builder::new()
            .name("mimir-transcript-event".into())
            .spawn(move || {
                std::thread::sleep(delay);
                let should_emit = transcript_events
                    .lock()
                    .map(|mut state| {
                        if state.meeting_id != meeting_id || !state.trailing_pending {
                            return false;
                        }
                        state.trailing_pending = false;
                        state.last_emit = Some(Instant::now());
                        true
                    })
                    .unwrap_or(false);
                if should_emit {
                    emit_transcript_changed(&app, &meeting_id);
                }
            })
            .is_err()
        {
            if let Ok(mut state) = reset_on_spawn_failure.lock() {
                if state.meeting_id == failure_meeting_id {
                    state.trailing_pending = false;
                }
            }
        }
    }
}

fn emit_transcript_changed(app: &tauri::AppHandle, meeting_id: &str) {
    let _ = app.emit(
        MEETING_PLATFORM_CHANGED_EVENT,
        serde_json::json!({
            "kind": "transcript",
            "meetingId": meeting_id,
        }),
    );
}

async fn run_blocking<T, F>(operation: &'static str, callback: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(callback)
        .await
        .map_err(|error| format!("{operation} task failed: {error}"))?
}

#[tauri::command]
pub async fn meetings_snapshot(
    runtime: tauri::State<'_, MeetingRuntime>,
) -> Result<MeetingSnapshot, String> {
    let runtime = runtime.inner().clone();
    run_blocking("meeting snapshot", move || {
        runtime.snapshot().map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
pub async fn meetings_transcript_page(
    runtime: tauri::State<'_, MeetingRuntime>,
    meeting_id: String,
    before: Option<MeetingTranscriptCursor>,
    limit: Option<u32>,
) -> Result<MeetingTranscriptPage, String> {
    let runtime = runtime.inner().clone();
    run_blocking("meeting transcript page", move || {
        runtime
            .transcript_page(&meeting_id, before, limit)
            .map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
pub async fn meetings_library_page(
    runtime: tauri::State<'_, MeetingRuntime>,
    before: Option<MeetingLibraryCursor>,
    limit: Option<u32>,
) -> Result<MeetingLibraryPage, String> {
    let runtime = runtime.inner().clone();
    run_blocking("meeting library page", move || {
        runtime
            .library_page(before, limit)
            .map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
pub async fn meetings_request_microphone_permission(
    runtime: tauri::State<'_, MeetingRuntime>,
) -> Result<MeetingSnapshot, String> {
    let runtime = runtime.inner().clone();
    run_blocking("microphone permission request", move || {
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        mimir_meeting_detect::request_microphone_permission(move |permission| {
            let _ = send.send(permission);
        })
        .map_err(|error| error.to_string())?;
        let permission = receive
            .recv_timeout(Duration::from_secs(90))
            .map_err(|_| "macOS did not complete the microphone permission request".to_string())?;
        if permission.state != mimir_meeting_detect::PermissionState::Granted {
            return Err(permission
                .remediation
                .unwrap_or_else(|| "Microphone access is required to record a meeting".into()));
        }
        runtime.snapshot().map_err(|error| error.to_string())
    })
    .await
}

/// Open the one macOS privacy pane that can repair process-tap permission.
///
/// This command deliberately takes no URL or pane identifier from the
/// renderer, so it cannot become a general-purpose process launcher.
#[tauri::command]
pub async fn meetings_open_system_audio_settings() -> Result<(), String> {
    run_blocking(
        "system audio permission settings",
        open_system_audio_settings,
    )
    .await
}

#[cfg(target_os = "macos")]
fn open_system_audio_settings() -> Result<(), String> {
    let status = std::process::Command::new("/usr/bin/open")
        .arg(SYSTEM_AUDIO_SETTINGS_URL)
        .status()
        .map_err(|error| format!("Could not open macOS System Settings: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "macOS System Settings exited before opening Screen & System Audio Recording ({status})"
        ))
    }
}

#[cfg(not(target_os = "macos"))]
fn open_system_audio_settings() -> Result<(), String> {
    Err("Screen & System Audio Recording settings are available only on macOS".into())
}

#[tauri::command]
pub async fn meetings_dismiss_candidate(
    runtime: tauri::State<'_, MeetingRuntime>,
    candidate_id: String,
) -> Result<MeetingSnapshot, String> {
    let runtime = runtime.inner().clone();
    run_blocking("meeting candidate dismissal", move || {
        runtime
            .dismiss_candidate(&candidate_id)
            .map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
pub async fn meetings_issue_start_consent(
    window: tauri::WebviewWindow,
    runtime: tauri::State<'_, MeetingRuntime>,
    authority: tauri::State<'_, MeetingStartConsentAuthority>,
    disclosure: MeetingStartDisclosureRequest,
) -> Result<MeetingStartConsentGrant, String> {
    let window_label = window.label().to_string();
    let runtime = runtime.inner().clone();
    let authority = authority.inner().clone();
    run_blocking("meeting consent issue", move || {
        let context = runtime
            .start_consent_context(disclosure.candidate_id.as_deref())
            .map_err(|error| error.to_string())?;
        authority.issue(&window_label, context, &disclosure)
    })
    .await
}

#[tauri::command]
pub async fn meetings_start(
    window: tauri::WebviewWindow,
    runtime: tauri::State<'_, MeetingRuntime>,
    authority: tauri::State<'_, MeetingStartConsentAuthority>,
    request: StartMeetingRequest,
) -> Result<MeetingSnapshot, String> {
    let window_label = window.label().to_string();
    let runtime = runtime.inner().clone();
    let authority = authority.inner().clone();
    run_blocking("meeting start", move || {
        let mut request = request;
        let context = runtime
            .start_consent_context(request.candidate_id.as_deref())
            .map_err(|error| error.to_string())?;
        let consent = authority.begin_start(
            &window_label,
            request.request_id.as_deref(),
            request.consent_token.as_deref(),
            &context,
        )?;
        match consent {
            ConsentStart::CompletedReplay { meeting_id } => {
                let snapshot = runtime.snapshot().map_err(|error| error.to_string())?;
                if snapshot.active_meeting_id.as_deref() == Some(meeting_id.as_str()) {
                    Ok(snapshot)
                } else {
                    Err(
                        "Recording consent has already been used and cannot start another meeting"
                            .into(),
                    )
                }
            }
            ConsentStart::Fresh(consent) => {
                // The bearer token is consumed before the runtime sees the
                // request. Only this non-deserializable context crosses the
                // native boundary into capture orchestration.
                request.consent_token = None;
                request.authorized_consent = Some(context);
                match runtime.start(request) {
                    Ok(snapshot) => {
                        let Some(meeting_id) = snapshot.active_meeting_id.as_deref() else {
                            authority.fail(&consent);
                            return Err("meeting started without an active durable session".into());
                        };
                        authority.complete(&consent, meeting_id);
                        Ok(snapshot)
                    }
                    Err(error) => {
                        authority.fail(&consent);
                        Err(error.to_string())
                    }
                }
            }
        }
    })
    .await
}

#[tauri::command]
pub async fn meetings_stop(
    runtime: tauri::State<'_, MeetingRuntime>,
    meeting_id: String,
) -> Result<MeetingSnapshot, String> {
    let runtime = runtime.inner().clone();
    run_blocking("meeting stop", move || {
        runtime.stop(&meeting_id).map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
pub async fn meetings_set_mic_muted(
    runtime: tauri::State<'_, MeetingRuntime>,
    meeting_id: String,
    muted: bool,
) -> Result<MeetingSnapshot, String> {
    let runtime = runtime.inner().clone();
    run_blocking("meeting microphone mute", move || {
        runtime
            .set_microphone_muted(&meeting_id, muted)
            .map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
pub async fn meetings_update(
    runtime: tauri::State<'_, MeetingRuntime>,
    meeting_id: String,
    patch: MeetingUpdatePatch,
) -> Result<MeetingSnapshot, String> {
    let runtime = runtime.inner().clone();
    run_blocking("meeting update", move || {
        runtime
            .update_meeting(&meeting_id, patch)
            .map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
pub async fn meetings_decide_kg(
    runtime: tauri::State<'_, MeetingRuntime>,
    meeting_id: String,
    decision: String,
) -> Result<MeetingSnapshot, String> {
    let runtime = runtime.inner().clone();
    run_blocking("meeting knowledge-graph decision", move || {
        runtime
            .decide_kg(&meeting_id, &decision)
            .map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
pub async fn meetings_retry_job(
    runtime: tauri::State<'_, MeetingRuntime>,
    meeting_id: String,
    job_kind: String,
) -> Result<MeetingSnapshot, String> {
    let runtime = runtime.inner().clone();
    run_blocking("meeting job retry", move || {
        runtime
            .retry_job(&meeting_id, &job_kind)
            .map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
pub async fn meetings_delete(
    runtime: tauri::State<'_, MeetingRuntime>,
    meeting_id: String,
    mode: String,
) -> Result<MeetingSnapshot, String> {
    let mode = MeetingDeleteMode::parse(&mode).map_err(|error| error.to_string())?;
    let runtime = runtime.inner().clone();
    run_blocking("meeting deletion", move || {
        runtime
            .delete(&meeting_id, mode)
            .map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
pub async fn meetings_export(
    runtime: tauri::State<'_, MeetingRuntime>,
    meeting_id: String,
    format: String,
) -> Result<MeetingExport, String> {
    let format = MeetingExportFormat::parse(&format).map_err(|error| error.to_string())?;
    let runtime = runtime.inner().clone();
    run_blocking("meeting export", move || {
        runtime
            .export(&meeting_id, format)
            .map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
pub async fn meetings_update_config(
    runtime: tauri::State<'_, MeetingRuntime>,
    patch: MeetingConfigPatch,
) -> Result<MeetingSnapshot, String> {
    let runtime = runtime.inner().clone();
    run_blocking("meeting config update", move || {
        runtime
            .update_config(patch)
            .map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
pub async fn meetings_set_api_key(
    runtime: tauri::State<'_, MeetingRuntime>,
    api_key: String,
) -> Result<MeetingSnapshot, String> {
    let runtime = runtime.inner().clone();
    run_blocking("meeting API key update", move || {
        runtime
            .set_api_key(&api_key)
            .map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
pub async fn meetings_clear_api_key(
    runtime: tauri::State<'_, MeetingRuntime>,
) -> Result<MeetingSnapshot, String> {
    let runtime = runtime.inner().clone();
    run_blocking("meeting API key removal", move || {
        runtime.clear_api_key().map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
pub async fn meetings_install_model(
    runtime: tauri::State<'_, MeetingRuntime>,
    model_id: String,
) -> Result<MeetingSnapshot, String> {
    let runtime = runtime.inner().clone();
    run_blocking("meeting model install", move || {
        runtime
            .install_model(&model_id)
            .map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
pub async fn meetings_delete_model(
    runtime: tauri::State<'_, MeetingRuntime>,
    model_id: String,
) -> Result<MeetingSnapshot, String> {
    let runtime = runtime.inner().clone();
    run_blocking("meeting model deletion", move || {
        runtime
            .delete_model(&model_id)
            .map_err(|error| error.to_string())
    })
    .await
}

#[cfg(test)]
mod consent_tests {
    use super::*;

    fn local_context() -> MeetingStartConsentContext {
        MeetingStartConsentContext {
            candidate_id: None,
            candidate_app_id: None,
            candidate_app_name: None,
            transcription_mode: "local".into(),
            destination: None,
            model: "whisper-small".into(),
        }
    }

    fn disclosure(context: &MeetingStartConsentContext) -> MeetingStartDisclosureRequest {
        MeetingStartDisclosureRequest {
            candidate_id: context.candidate_id.clone(),
            candidate_app_name: context.candidate_app_name.clone(),
            transcription_mode: context.transcription_mode.clone(),
            destination: context.destination.clone(),
            model: context.model.clone(),
        }
    }

    #[test]
    fn missing_forged_and_replayed_tokens_never_authorize_a_second_start() {
        let authority = MeetingStartConsentAuthority::default();
        let context = local_context();
        assert!(authority
            .begin_start(MAIN_WINDOW_LABEL, None, None, &context)
            .unwrap_err()
            .contains("missing"));
        assert!(authority
            .begin_start(
                MAIN_WINDOW_LABEL,
                Some("forged-request"),
                Some("forged-token"),
                &context,
            )
            .unwrap_err()
            .contains("invalid"));

        let grant = authority
            .issue(MAIN_WINDOW_LABEL, context.clone(), &disclosure(&context))
            .unwrap();
        let first = authority
            .begin_start(
                MAIN_WINDOW_LABEL,
                Some(&grant.request_id),
                Some(&grant.token),
                &context,
            )
            .unwrap();
        let ConsentStart::Fresh(first) = first else {
            panic!("new grant must authorize exactly one fresh start");
        };
        authority.complete(&first, "meeting-one");
        assert!(matches!(
            authority
                .begin_start(
                    MAIN_WINDOW_LABEL,
                    Some(&grant.request_id),
                    Some(&grant.token),
                    &context,
                )
                .unwrap(),
            ConsentStart::CompletedReplay { ref meeting_id } if meeting_id == "meeting-one"
        ));
        // A completed replay can only return the already-started meeting in the
        // command; it is never converted back into Fresh capture authority.
    }

    #[test]
    fn expired_wrong_window_and_changed_context_tokens_are_consumed() {
        let context = local_context();
        let now = Instant::now();

        let authority = MeetingStartConsentAuthority::default();
        let expired = authority
            .issue_at(
                MAIN_WINDOW_LABEL,
                context.clone(),
                &disclosure(&context),
                now,
            )
            .unwrap();
        assert!(authority
            .begin_start_at(
                MAIN_WINDOW_LABEL,
                Some(&expired.request_id),
                Some(&expired.token),
                &context,
                now + START_CONSENT_TTL,
            )
            .unwrap_err()
            .contains("expired"));

        let wrong_window = authority
            .issue_at(
                MAIN_WINDOW_LABEL,
                context.clone(),
                &disclosure(&context),
                now,
            )
            .unwrap();
        assert!(authority
            .begin_start_at(
                "meeting-popout",
                Some(&wrong_window.request_id),
                Some(&wrong_window.token),
                &context,
                now,
            )
            .unwrap_err()
            .contains("main Mimir window"));
        assert!(authority
            .begin_start_at(
                MAIN_WINDOW_LABEL,
                Some(&wrong_window.request_id),
                Some(&wrong_window.token),
                &context,
                now,
            )
            .unwrap_err()
            .contains("invalid"));

        let changed = authority
            .issue_at(
                MAIN_WINDOW_LABEL,
                context.clone(),
                &disclosure(&context),
                now,
            )
            .unwrap();
        let mut hosted = context.clone();
        hosted.transcription_mode = "custom".into();
        hosted.destination = Some("https://speech.example.test/v1/listen".into());
        hosted.model = "meeting-v2".into();
        assert!(authority
            .begin_start_at(
                MAIN_WINDOW_LABEL,
                Some(&changed.request_id),
                Some(&changed.token),
                &hosted,
                now,
            )
            .unwrap_err()
            .contains("changed"));
        assert!(authority
            .begin_start_at(
                MAIN_WINDOW_LABEL,
                Some(&changed.request_id),
                Some(&changed.token),
                &context,
                now,
            )
            .unwrap_err()
            .contains("invalid"));
    }

    #[test]
    fn authority_binds_candidate_and_custom_provider_disclosure() {
        let authority = MeetingStartConsentAuthority::default();
        let context = MeetingStartConsentContext {
            candidate_id: Some("candidate-zoom".into()),
            candidate_app_id: Some("us.zoom.xos".into()),
            candidate_app_name: Some("Zoom".into()),
            transcription_mode: "custom".into(),
            destination: Some("https://speech.example.test/v1/listen".into()),
            model: "meeting-v2".into(),
        };
        let mut stale_disclosure = disclosure(&context);
        stale_disclosure.destination = Some("https://old.example.test/v1/listen".into());
        assert!(authority
            .issue(MAIN_WINDOW_LABEL, context.clone(), &stale_disclosure)
            .err()
            .unwrap()
            .contains("changed"));
        assert!(authority
            .issue("meeting-popout", context.clone(), &disclosure(&context))
            .err()
            .unwrap()
            .contains("main Mimir window"));

        let grant = authority
            .issue(MAIN_WINDOW_LABEL, context.clone(), &disclosure(&context))
            .unwrap();
        assert_eq!(grant.disclosure.candidate_app_name.as_deref(), Some("Zoom"));
        assert_eq!(
            grant.disclosure.destination.as_deref(),
            Some("https://speech.example.test/v1/listen")
        );
    }

    #[test]
    fn system_audio_repair_target_is_fixed_to_the_macos_privacy_pane() {
        assert_eq!(
            SYSTEM_AUDIO_SETTINGS_URL,
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        );
        assert!(!SYSTEM_AUDIO_SETTINGS_URL.contains(' '));
        assert!(!SYSTEM_AUDIO_SETTINGS_URL.contains("://"));
    }
}
