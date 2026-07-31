//! Native meeting orchestration.
//!
//! `MeetingStore` remains the durable authority. Capture, transcription,
//! settings/content projection, artifacts, time, and renderer notification are
//! injected ports so the lifecycle can be tested without pretending that a
//! browser mock exercised an audio device or provider.

use super::store::{
    MeetingListCursor as StoreMeetingListCursor, TranscriptPageCursor as StoreTranscriptPageCursor,
    MAX_TRANSCRIPT_PAGE_SEGMENTS,
};
use super::{
    AudioChannelDraft, AudioChannelKind, FollowUpJob, FollowUpJobDraft, FollowUpJobKind, JobFinish,
    JobState, MeetingDeletionMode as StoreDeletionMode, MeetingDeletionStage, MeetingDraft,
    MeetingFailure, MeetingOrigin, MeetingRecord, MeetingStatus, MeetingStore, MeetingStoreError,
    RecoveryReport, TranscriptBatch, TranscriptGapRecord, TranscriptSegmentRecord,
};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, MutexGuard, Weak,
    },
};
use thiserror::Error;
use uuid::Uuid;

pub const MEETING_EVENT: &str = "mimir://meeting-event";
const DEFAULT_MEETING_LIMIT: u32 = 200;
const MAX_LIBRARY_GAPS: u32 = 100;
const MAX_SUMMARY_PREVIEW_CHARS: usize = 2_000;
const DEFAULT_JOB_ATTEMPTS: u32 = 3;

#[derive(Debug, Error)]
pub enum MeetingRuntimeError {
    #[error(transparent)]
    Store(#[from] MeetingStoreError),
    #[error("recording requires an explicit consent confirmation")]
    ConsentRequired,
    #[error(
        "recording settings or the selected meeting suggestion changed; review the disclosure and confirm again"
    )]
    ConsentContextChanged,
    #[error("microphone permission is not granted")]
    MicrophonePermissionRequired,
    #[error("meeting '{meeting_id}' is already active")]
    ActiveMeeting { meeting_id: String },
    #[error("meeting '{meeting_id}' is not the active meeting")]
    NotActiveMeeting { meeting_id: String },
    #[error("meeting runtime validation failed: {0}")]
    Validation(String),
    #[error("{operation} failed: {message}")]
    Port {
        operation: &'static str,
        message: String,
    },
    #[error("meeting runtime mutex was poisoned")]
    Poisoned,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartMeetingRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidate_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub consent_token: Option<String>,
    /// Set only by the native IPC command after consuming a window-bound,
    /// short-lived consent grant. Serde deliberately cannot populate it.
    #[serde(skip)]
    pub(crate) authorized_consent: Option<MeetingStartConsentContext>,
}

/// The exact recording disclosure protected by a native consent grant.
///
/// This never contains the grant token and is never persisted. Candidate
/// identity is included so reusing a consent grant after detector churn cannot
/// authorize a different meeting. The full custom endpoint and model are
/// included even though the UI presents the endpoint host prominently.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct MeetingStartConsentContext {
    pub candidate_id: Option<String>,
    pub candidate_app_id: Option<String>,
    pub candidate_app_name: Option<String>,
    pub transcription_mode: String,
    pub destination: Option<String>,
    pub model: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingUpdatePatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingConfigPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detection_enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_record: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcription_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary_enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary_template: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary_preset: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kg_prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kg_preset: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_nullable_patch"
    )]
    pub retention_days: Option<Option<u32>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingConfig {
    pub detection_enabled: bool,
    pub auto_record: bool,
    pub transcription_mode: String,
    pub custom_url: String,
    pub custom_model: String,
    pub api_key_configured: bool,
    pub local_model: String,
    pub summary_enabled: bool,
    pub summary_template: String,
    pub summary_preset: String,
    pub kg_prompt: String,
    pub kg_preset: String,
    pub retention_days: Option<u32>,
}

impl Default for MeetingConfig {
    fn default() -> Self {
        Self {
            detection_enabled: false,
            auto_record: false,
            transcription_mode: "local".into(),
            custom_url: String::new(),
            custom_model: String::new(),
            api_key_configured: false,
            local_model: "whisper-small".into(),
            summary_enabled: true,
            summary_template: "standard".into(),
            summary_preset: String::new(),
            kg_prompt: "ask".into(),
            kg_preset: String::new(),
            retention_days: Some(30),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MeetingHookConfig {
    pub summary_enabled: bool,
    pub summary_template: String,
    pub summary_preset: String,
    pub kg_prompt: String,
    pub kg_preset: String,
}

impl From<&MeetingConfig> for MeetingHookConfig {
    fn from(config: &MeetingConfig) -> Self {
        Self {
            summary_enabled: config.summary_enabled,
            summary_template: config.summary_template.clone(),
            summary_preset: config.summary_preset.clone(),
            kg_prompt: config.kg_prompt.clone(),
            kg_preset: config.kg_preset.clone(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingPermissions {
    pub microphone: String,
    pub system_audio: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingCandidate {
    pub id: String,
    pub app_id: String,
    pub app_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detected_at: Option<String>,
    pub confidence: f64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingModel {
    pub id: String,
    pub title: String,
    pub status: String,
    pub bytes: u64,
    pub downloaded_bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checksum: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingPlatformProjection {
    pub config: MeetingConfig,
    pub permissions: MeetingPermissions,
    #[serde(default)]
    pub candidates: Vec<MeetingCandidate>,
    #[serde(default)]
    pub models: Vec<MeetingModel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingContentProjection {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_app: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kg_decision: Option<String>,
    #[serde(default)]
    pub deleted: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MeetingDeleteMode {
    Audio,
    All,
}

impl MeetingDeleteMode {
    pub fn parse(value: &str) -> Result<Self, MeetingRuntimeError> {
        match value {
            "audio" => Ok(Self::Audio),
            "all" => Ok(Self::All),
            _ => Err(MeetingRuntimeError::Validation(
                "meeting deletion mode must be audio or all".into(),
            )),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MeetingExportFormat {
    Markdown,
    Json,
    Audio,
}

impl MeetingExportFormat {
    pub fn parse(value: &str) -> Result<Self, MeetingRuntimeError> {
        match value {
            "markdown" => Ok(Self::Markdown),
            "json" => Ok(Self::Json),
            "audio" => Ok(Self::Audio),
            _ => Err(MeetingRuntimeError::Validation(
                "meeting export format must be markdown, json, or audio".into(),
            )),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingExport {
    pub format: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureStart {
    pub meeting_id: String,
    pub run_id: String,
    pub workspace_path: Option<String>,
    pub channels: Vec<AudioChannelDraft>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureStop {
    pub meeting_id: String,
    pub run_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CaptureStopResult {
    pub duration_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranscriptionStart {
    pub meeting_id: String,
    pub run_id: String,
    pub route: String,
    pub model: String,
    /// Present only for a durable, from-sequence-zero repair pass. Live
    /// capture writes directly to the current transcript; repair output stays
    /// private until one all-final generation is atomically reconciled.
    pub repair_generation: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranscriptionFinalize {
    pub meeting_id: String,
    pub run_id: String,
    pub base_revision: u64,
    pub observed_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TranscriptionWorkerStatus {
    Initializing,
    Live,
    Delayed,
}

impl TranscriptionWorkerStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Initializing => "initializing",
            Self::Live => "live",
            Self::Delayed => "delayed",
        }
    }
}

pub trait MeetingCapturePort: Send + Sync {
    fn recover(&self, report: &RecoveryReport) -> Result<(), String>;

    fn start(&self, request: &CaptureStart) -> Result<(), String>;

    fn stop(&self, request: &CaptureStop) -> Result<CaptureStopResult, String>;

    fn set_microphone_muted(
        &self,
        meeting_id: &str,
        run_id: &str,
        muted: bool,
    ) -> Result<(), String>;
}

/// Terminal health callback from the native capture supervisor.
///
/// This is intentionally separate from renderer events: a disk/device/driver
/// failure must reach the durable runtime even when every window is closed.
pub trait MeetingCaptureFailureSink: Send + Sync {
    fn capture_failed(&self, meeting_id: &str, run_id: &str, message: &str);
}

pub trait MeetingTranscriptionPort: Send + Sync {
    fn start(&self, request: &TranscriptionStart) -> Result<(), String>;

    fn finalize(&self, request: &TranscriptionFinalize) -> Result<TranscriptBatch, String>;

    /// Current best-effort state of an owned live worker. Implementations that
    /// start synchronously retain the historical live default; native local
    /// model startup overrides this while Metal preparation is still running.
    fn status(&self, _meeting_id: &str) -> TranscriptionWorkerStatus {
        TranscriptionWorkerStatus::Live
    }
}

/// Native settings/content/artifact projection.
///
/// This port is intentionally explicit: `MeetingStore` owns lifecycle,
/// transcript revisions, and follow-up jobs, while existing settings, keychain,
/// model, Activity, file/export, and review systems keep their own authority.
pub trait MeetingPlatformPort: Send + Sync {
    fn projection(&self) -> Result<MeetingPlatformProjection, String>;
    /// Read post-meeting policy without touching credential authority,
    /// devices, models, candidate detection, or other live projections.
    fn hook_config(&self) -> Result<MeetingHookConfig, String> {
        self.projection()
            .map(|projection| MeetingHookConfig::from(&projection.config))
    }
    fn dismiss_candidate(&self, _candidate_id: &str) -> Result<(), String> {
        Ok(())
    }
    fn content(&self, meeting_id: &str) -> Result<MeetingContentProjection, String>;
    fn update_config(&self, patch: &MeetingConfigPatch) -> Result<(), String>;
    fn set_api_key(&self, api_key: &str) -> Result<(), String>;
    fn clear_api_key(&self) -> Result<(), String>;
    fn install_model(&self, model_id: &str) -> Result<(), String>;
    fn delete_model(&self, model_id: &str) -> Result<(), String>;
    fn update_content(&self, meeting_id: &str, patch: &MeetingUpdatePatch) -> Result<(), String>;
    fn set_kg_decision(&self, meeting_id: &str, decision: &str) -> Result<(), String>;
    fn delete_meeting(&self, meeting_id: &str, mode: MeetingDeleteMode) -> Result<(), String>;
    fn export_meeting(
        &self,
        meeting_id: &str,
        format: MeetingExportFormat,
    ) -> Result<MeetingExport, String>;
}

pub trait MeetingClock: Send + Sync {
    fn now(&self) -> String;
}

pub struct SystemMeetingClock;

impl MeetingClock for SystemMeetingClock {
    fn now(&self) -> String {
        Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
    }
}

pub trait MeetingEventSink: Send + Sync {
    fn publish(&self, event: &MeetingEvent) -> Result<(), String>;
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingSnapshot {
    pub revision: u64,
    pub meetings: Vec<MeetingView>,
    #[serde(default)]
    pub meetings_truncated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_meetings_before: Option<MeetingLibraryCursor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_meeting_id: Option<String>,
    #[serde(default)]
    pub candidates: Vec<MeetingCandidate>,
    pub config: MeetingConfig,
    pub permissions: MeetingPermissions,
    #[serde(default)]
    pub models: Vec<MeetingModel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingEvent {
    pub revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meeting_id: Option<String>,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<MeetingSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingView {
    pub id: String,
    pub title: String,
    pub lifecycle: String,
    pub transcription: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stopped_at: Option<String>,
    pub duration_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_app: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub mic_muted: bool,
    #[serde(default)]
    pub channels: Vec<String>,
    #[serde(default)]
    pub gaps: Vec<MeetingGapView>,
    pub gap_count: u64,
    pub transcript_revision: u64,
    pub transcript_final: bool,
    #[serde(default)]
    pub segment_count: u64,
    #[serde(default)]
    pub transcript_all_final: bool,
    #[serde(default)]
    pub segments: Vec<MeetingSegmentView>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default)]
    pub summary_truncated: bool,
    pub summary_state: String,
    pub kg_state: String,
    #[serde(default)]
    pub jobs: Vec<MeetingJobView>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingGapView {
    pub channel: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingSegmentView {
    pub id: String,
    pub text: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub channel: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speaker: Option<String>,
    #[serde(rename = "final")]
    pub is_final: bool,
    pub revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingTranscriptCursor {
    pub start_ms: u64,
    pub end_ms: u64,
    pub segment_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingTranscriptPage {
    pub meeting_id: String,
    pub revision: u64,
    pub total_segments: u64,
    pub has_more: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_before: Option<MeetingTranscriptCursor>,
    #[serde(default)]
    pub segments: Vec<MeetingSegmentView>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MeetingTranscriptSearchHit {
    pub meeting_id: String,
    pub segment_id: String,
    pub start_ms: u64,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MeetingLibrarySearchMatch {
    pub title: bool,
    pub summary: bool,
    pub tags: bool,
    pub transcript: Vec<MeetingTranscriptSearchHit>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MeetingLibrarySearchHit {
    pub meeting: MeetingView,
    pub matched: MeetingLibrarySearchMatch,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingLibraryCursor {
    pub created_at: String,
    pub meeting_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingLibraryPage {
    pub meetings: Vec<MeetingView>,
    pub has_more: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_before: Option<MeetingLibraryCursor>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingJobView {
    pub id: String,
    pub kind: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activity_id: Option<String>,
    pub attempt: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
struct ActiveCapture {
    meeting_id: String,
    run_id: String,
    request_key: Option<String>,
    mic_muted: bool,
    transcription: String,
    duration_ms: u64,
}

struct MeetingRuntimeInner {
    store: Arc<MeetingStore>,
    capture: Arc<dyn MeetingCapturePort>,
    transcription: Arc<dyn MeetingTranscriptionPort>,
    platform: Arc<dyn MeetingPlatformPort>,
    clock: Arc<dyn MeetingClock>,
    events: Arc<dyn MeetingEventSink>,
    operation: Mutex<()>,
    active: Mutex<Option<ActiveCapture>>,
    revision: AtomicU64,
    diagnostic: Mutex<Option<String>>,
}

#[derive(Clone)]
pub struct MeetingRuntime {
    inner: Arc<MeetingRuntimeInner>,
}

struct WeakMeetingRuntime {
    inner: Weak<MeetingRuntimeInner>,
}

impl MeetingRuntime {
    pub fn new(
        store: Arc<MeetingStore>,
        capture: Arc<dyn MeetingCapturePort>,
        transcription: Arc<dyn MeetingTranscriptionPort>,
        platform: Arc<dyn MeetingPlatformPort>,
        clock: Arc<dyn MeetingClock>,
        events: Arc<dyn MeetingEventSink>,
    ) -> Result<Self, MeetingRuntimeError> {
        let observed_at = clock.now();
        let recovery = store.recover_after_restart(&observed_at)?;
        let recovered = !recovery.interrupted_meeting_ids.is_empty()
            || !recovery.requeued_job_ids.is_empty()
            || !recovery.failed_job_ids.is_empty()
            || !recovery.staged_audio_chunks.is_empty();
        let runtime = Self {
            inner: Arc::new(MeetingRuntimeInner {
                store,
                capture,
                transcription,
                platform,
                clock,
                events,
                operation: Mutex::new(()),
                active: Mutex::new(None),
                revision: AtomicU64::new(u64::from(recovered)),
                diagnostic: Mutex::new(None),
            }),
        };
        let recovered_tail_meetings = recovery
            .staged_audio_chunks
            .iter()
            .map(|chunk| chunk.definition.meeting_id.clone())
            .collect::<HashSet<_>>();
        // Staged audio is authority that may have crossed the file durability
        // boundary immediately before the process died. Verify/promote it
        // before deciding whether an existing terminal transcript is complete.
        let audio_recovery_ready = match runtime.inner.capture.recover(&recovery) {
            Ok(()) => runtime.inner.store.finish_audio_recovery(&recovery)?,
            Err(error) => {
                runtime
                    .set_diagnostic(format!("Meeting audio recovery needs attention: {error}"))?;
                false
            }
        };
        if audio_recovery_ready {
            // Recovery is driven from every durable interrupted record, not
            // only meetings that crossed the live -> interrupted transition
            // during this launch. Repeated restarts therefore reuse one stable
            // capture-generation job instead of minting revision-derived
            // owners.
            for meeting_id in runtime.inner.store.interrupted_meeting_ids()? {
                let meeting = runtime.inner.store.get_meeting(&meeting_id)?;
                if !recovered_tail_meetings.contains(&meeting.id)
                    && runtime.complete_terminal_recovery_unlocked(&meeting)?
                {
                    continue;
                }
                if let Err(error) = runtime.enqueue_transcription_retry(
                    &meeting.id,
                    meeting.transcript_revision,
                    "application restarted before transcript finalization",
                ) {
                    // Recovery must never substitute today's provider selection
                    // for the route the human originally approved. Legacy or
                    // damaged records without that immutable disclosure remain
                    // safely interrupted and can still retain/export their audio.
                    runtime.set_diagnostic(format!(
                        "Meeting '{}' needs transcription recovery, but its original consented route is unavailable: {}",
                        meeting.id,
                        bounded_error(&error.to_string())
                    ))?;
                }
            }
        } else if !recovery.staged_audio_chunks.is_empty() {
            runtime.set_diagnostic(
                "Meeting audio recovery remains unresolved; transcript finalization is paused"
                    .into(),
            )?;
        }
        Ok(runtime)
    }

    pub(crate) fn capture_failure_sink(&self) -> Arc<dyn MeetingCaptureFailureSink> {
        Arc::new(WeakMeetingRuntime {
            inner: Arc::downgrade(&self.inner),
        })
    }

    pub fn snapshot(&self) -> Result<MeetingSnapshot, MeetingRuntimeError> {
        let _operation = self.operation()?;
        self.snapshot_unlocked(self.inner.revision.load(Ordering::Acquire))
    }

    pub fn revision(&self) -> u64 {
        self.inner.revision.load(Ordering::Acquire)
    }

    pub fn library_page(
        &self,
        before: Option<MeetingLibraryCursor>,
        limit: Option<u32>,
    ) -> Result<MeetingLibraryPage, MeetingRuntimeError> {
        let _operation = self.operation()?;
        self.library_page_unlocked(before, limit.unwrap_or(DEFAULT_MEETING_LIMIT))
    }

    pub fn meeting(&self, meeting_id: &str) -> Result<MeetingView, MeetingRuntimeError> {
        let _operation = self.operation()?;
        let record = self.inner.store.get_meeting(meeting_id)?;
        let content = self
            .inner
            .platform
            .content(meeting_id)
            .map_err(|message| port_error("meeting content projection", message))?;
        if content.deleted {
            return Err(MeetingRuntimeError::Validation(format!(
                "meeting '{meeting_id}' is deleted"
            )));
        }
        let active = self.active()?.clone();
        let hook_config = self.hook_config()?;
        self.meeting_view(&record, &content, active.as_ref(), &hook_config.kg_prompt)
    }

    pub fn transcript_page(
        &self,
        meeting_id: &str,
        before: Option<MeetingTranscriptCursor>,
        limit: Option<u32>,
    ) -> Result<MeetingTranscriptPage, MeetingRuntimeError> {
        let _operation = self.operation()?;
        let record = self.inner.store.get_meeting(meeting_id)?;
        let content = self
            .inner
            .platform
            .content(meeting_id)
            .map_err(|message| port_error("meeting content projection", message))?;
        if content.deleted {
            return Err(MeetingRuntimeError::Validation(format!(
                "meeting '{meeting_id}' is deleted"
            )));
        }
        let before = before
            .map(|cursor| {
                Ok::<StoreTranscriptPageCursor, MeetingRuntimeError>(StoreTranscriptPageCursor {
                    start_ms: i64::try_from(cursor.start_ms).map_err(|_| {
                        MeetingRuntimeError::Validation(
                            "transcript cursor start exceeds the durable range".into(),
                        )
                    })?,
                    end_ms: i64::try_from(cursor.end_ms).map_err(|_| {
                        MeetingRuntimeError::Validation(
                            "transcript cursor end exceeds the durable range".into(),
                        )
                    })?,
                    segment_id: cursor.segment_id,
                })
            })
            .transpose()?;
        let page = self.inner.store.transcript_page(
            meeting_id,
            before.as_ref(),
            limit.unwrap_or(MAX_TRANSCRIPT_PAGE_SEGMENTS),
        )?;
        let channel_names = record
            .channels
            .iter()
            .map(|channel| {
                (
                    channel.definition.id.as_str(),
                    channel.definition.kind.to_string(),
                )
            })
            .collect::<HashMap<_, _>>();
        Ok(MeetingTranscriptPage {
            meeting_id: page.meeting_id,
            revision: page.revision,
            total_segments: page.total_segments,
            has_more: page.has_more,
            next_before: page.next_before.map(|cursor| MeetingTranscriptCursor {
                start_ms: cursor.start_ms as u64,
                end_ms: cursor.end_ms as u64,
                segment_id: cursor.segment_id,
            }),
            segments: page
                .segments
                .iter()
                .map(|segment| segment_view(segment, &channel_names))
                .collect(),
            // The latest page doubles as the selected-meeting detail read. Do
            // not retransmit a potentially large reviewed summary on every
            // walk into older transcript pages.
            summary: before.is_none().then_some(content.summary).flatten(),
        })
    }

    pub fn transcript_slice(
        &self,
        meeting_id: &str,
        offset: u64,
        limit: u32,
    ) -> Result<MeetingTranscriptPage, MeetingRuntimeError> {
        let _operation = self.operation()?;
        let record = self.inner.store.get_meeting(meeting_id)?;
        let content = self
            .inner
            .platform
            .content(meeting_id)
            .map_err(|message| port_error("meeting content projection", message))?;
        if content.deleted {
            return Err(MeetingRuntimeError::Validation(format!(
                "meeting '{meeting_id}' is deleted"
            )));
        }
        let page = self
            .inner
            .store
            .transcript_slice(meeting_id, offset, limit)?;
        let channel_names = record
            .channels
            .iter()
            .map(|channel| {
                (
                    channel.definition.id.as_str(),
                    channel.definition.kind.to_string(),
                )
            })
            .collect::<HashMap<_, _>>();
        Ok(MeetingTranscriptPage {
            meeting_id: page.meeting_id,
            revision: page.revision,
            total_segments: page.total_segments,
            has_more: page.has_more,
            next_before: None,
            segments: page
                .segments
                .iter()
                .map(|segment| segment_view(segment, &channel_names))
                .collect(),
            summary: (offset == 0).then_some(content.summary).flatten(),
        })
    }

    pub fn search_transcript(
        &self,
        query: &str,
        limit: u32,
    ) -> Result<Vec<MeetingTranscriptSearchHit>, MeetingRuntimeError> {
        let _operation = self.operation()?;
        self.inner
            .store
            .search_transcript(query, limit)
            .map(|hits| {
                hits.into_iter()
                    .map(|hit| MeetingTranscriptSearchHit {
                        meeting_id: hit.meeting_id,
                        segment_id: hit.segment_id,
                        start_ms: hit.start_ms as u64,
                        text: hit.text,
                    })
                    .collect()
            })
            .map_err(Into::into)
    }

    /// Search the full durable library without depending on the 200-row UI
    /// snapshot. The two indexed streams each contribute enough distinct
    /// meetings to produce the newest bounded union without missing an older
    /// title/summary/tag-only or transcript-only result.
    pub fn search_library(
        &self,
        query: &str,
        limit: u32,
    ) -> Result<Vec<MeetingLibrarySearchHit>, MeetingRuntimeError> {
        let _operation = self.operation()?;
        require_nonempty(query, "meeting search query")?;
        let limit = limit.min(100);
        if limit == 0 {
            return Ok(Vec::new());
        }
        #[derive(Default)]
        struct MatchAccumulator {
            title: bool,
            summary: bool,
            tags: bool,
            transcript: Vec<MeetingTranscriptSearchHit>,
        }
        let mut candidates = HashMap::<String, MatchAccumulator>::new();
        for hit in self.inner.store.search_content(query, limit)? {
            let candidate = candidates.entry(hit.meeting_id).or_default();
            candidate.title |= hit.title_match;
            candidate.summary |= hit.summary_match;
            candidate.tags |= hit.tags_match;
        }
        for hit in self
            .inner
            .store
            .search_transcript(query, limit.saturating_mul(3))?
        {
            let meeting_id = hit.meeting_id.clone();
            candidates
                .entry(meeting_id)
                .or_default()
                .transcript
                .push(MeetingTranscriptSearchHit {
                    meeting_id: hit.meeting_id,
                    segment_id: hit.segment_id,
                    start_ms: hit.start_ms as u64,
                    text: hit.text,
                });
        }

        let active = self.active()?.clone();
        let hook_config = self.hook_config()?;
        let mut hits = Vec::with_capacity(candidates.len());
        for (meeting_id, matched) in candidates {
            let record = self.inner.store.get_meeting(&meeting_id)?;
            let content = self
                .inner
                .platform
                .content(&meeting_id)
                .map_err(|message| port_error("meeting content projection", message))?;
            if content.deleted
                || !matches!(
                    record.status,
                    MeetingStatus::Completed | MeetingStatus::Interrupted | MeetingStatus::Failed
                )
            {
                continue;
            }
            let view =
                self.meeting_view(&record, &content, active.as_ref(), &hook_config.kg_prompt)?;
            hits.push((
                record.created_at,
                record.id,
                MeetingLibrarySearchHit {
                    meeting: view,
                    matched: MeetingLibrarySearchMatch {
                        title: matched.title,
                        summary: matched.summary,
                        tags: matched.tags,
                        transcript: matched.transcript,
                    },
                },
            ));
        }
        hits.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| right.1.cmp(&left.1)));
        hits.truncate(limit as usize);
        Ok(hits.into_iter().map(|(_, _, hit)| hit).collect())
    }

    pub fn dismiss_candidate(
        &self,
        candidate_id: &str,
    ) -> Result<MeetingSnapshot, MeetingRuntimeError> {
        let _operation = self.operation()?;
        require_nonempty(candidate_id, "meeting candidate id")?;
        self.inner
            .platform
            .dismiss_candidate(candidate_id)
            .map_err(|message| port_error("meeting candidate dismissal", message))?;
        self.publish_unlocked("candidate-dismissed", None, None)
    }

    /// Resolve the exact native state a human must see before recording.
    ///
    /// The command layer uses this both when issuing a consent grant and when
    /// consuming it. `start` resolves it once more while holding the runtime
    /// operation lock, closing the settings/candidate TOCTOU window.
    pub(crate) fn start_consent_context(
        &self,
        candidate_id: Option<&str>,
    ) -> Result<MeetingStartConsentContext, MeetingRuntimeError> {
        let _operation = self.operation()?;
        let projection = self.platform_projection()?;
        validate_config(&projection.config)?;
        consent_context_for_projection(&projection, candidate_id)
    }

    pub fn start(
        &self,
        request: StartMeetingRequest,
    ) -> Result<MeetingSnapshot, MeetingRuntimeError> {
        let _operation = self.operation()?;
        let projection = self.platform_projection()?;
        validate_config(&projection.config)?;
        let current_consent =
            consent_context_for_projection(&projection, request.candidate_id.as_deref())?;
        match request.authorized_consent.as_ref() {
            None => return Err(MeetingRuntimeError::ConsentRequired),
            Some(authorized) if authorized != &current_consent => {
                return Err(MeetingRuntimeError::ConsentContextChanged);
            }
            Some(_) => {}
        }
        if !matches!(
            projection.permissions.microphone.as_str(),
            "granted" | "development-host"
        ) {
            return Err(MeetingRuntimeError::MicrophonePermissionRequired);
        }

        let request_key = stable_start_key(&request);
        // Bind the clone separately so the mutex guard is dropped before an
        // idempotent reply calls back into snapshot projection.
        let active_capture = { self.active()?.clone() };
        if let Some(active) = active_capture {
            if request_key.is_some() && request_key == active.request_key {
                return self.snapshot_unlocked(self.inner.revision.load(Ordering::Acquire));
            }
            return Err(MeetingRuntimeError::ActiveMeeting {
                meeting_id: active.meeting_id,
            });
        }

        let meeting_id = format!("meeting-{}", Uuid::new_v4());
        let run_id = format!("run-{}", Uuid::new_v4());
        let observed_at = self.inner.clock.now();
        let title = request
            .title
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("Untitled meeting")
            .to_string();
        let channels = capture_channels(&projection.permissions);
        let candidate = request.candidate_id.as_ref().and_then(|candidate_id| {
            projection
                .candidates
                .iter()
                .find(|candidate| &candidate.id == candidate_id)
        });
        if request.candidate_id.is_some() && candidate.is_none() {
            return Err(MeetingRuntimeError::Validation(
                "the selected meeting candidate is no longer available".into(),
            ));
        }
        let origin = MeetingOrigin {
            kind: if candidate.is_some() {
                "detected".into()
            } else {
                "manual".into()
            },
            external_id: request.candidate_id.clone(),
            confidence: candidate.map(|value| value.confidence),
            evidence: candidate
                .map(|value| {
                    json!({
                        "appId": value.app_id,
                        "appName": value.app_name,
                    })
                })
                .unwrap_or_else(|| json!({})),
        };
        let (transcription_route, transcription_model) = transcription_route(&projection.config);
        let metadata = json!({
            "workspacePath": request.workspace_path.clone(),
            "sourceApp": candidate.map(|value| value.app_name.clone()),
            "consentConfirmed": true,
            "consentObservedAt": observed_at.clone(),
            "transcriptionRoute": transcription_route,
            "transcriptionModel": transcription_model,
            "retentionDays": projection.config.retention_days,
            "runId": run_id.clone(),
        });
        let draft = MeetingDraft {
            id: meeting_id.clone(),
            title,
            origin,
            channels: channels.clone(),
            metadata,
        };
        let created = self.inner.store.create_meeting(&draft, &observed_at)?;
        let capture_request = CaptureStart {
            meeting_id: meeting_id.clone(),
            run_id: run_id.clone(),
            workspace_path: request.workspace_path.clone(),
            channels,
        };
        // Publish the durable Recording state before opening native streams.
        // If capture cannot start, the ordinary Recording -> Failed
        // transition closes the attempt. This ordering ensures there is no
        // fallible persistence boundary after a worker starts but before the
        // runtime owns it.
        let recording = self.inner.store.transition_meeting(
            &meeting_id,
            created.revision,
            MeetingStatus::Recording,
            &self.inner.clock.now(),
            None,
        )?;
        if let Err(message) = self.inner.capture.start(&capture_request) {
            let failure = MeetingFailure {
                code: "capture-start-failed".into(),
                message: bounded_error(&message),
                retryable: true,
            };
            self.inner.store.transition_meeting(
                &meeting_id,
                recording.revision,
                MeetingStatus::Failed,
                &self.inner.clock.now(),
                Some(&failure),
            )?;
            let _ = self.publish_unlocked("capture-failed", Some(meeting_id.clone()), Some(run_id));
            return Err(port_error("meeting capture start", message));
        }

        let route = recording
            .metadata
            .get("transcriptionRoute")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                MeetingRuntimeError::Validation(
                    "durable recording is missing its consented transcription route".into(),
                )
            })?
            .to_string();
        let model = recording
            .metadata
            .get("transcriptionModel")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                MeetingRuntimeError::Validation(
                    "durable recording is missing its consented transcription model".into(),
                )
            })?
            .to_string();
        let transcription_request = TranscriptionStart {
            meeting_id: meeting_id.clone(),
            run_id: run_id.clone(),
            route,
            model,
            repair_generation: None,
        };
        let transcription = match self.inner.transcription.start(&transcription_request) {
            Ok(()) => self.inner.transcription.status(&meeting_id).as_str().into(),
            Err(error) => {
                self.set_diagnostic(format!(
                    "Recording continues; live transcription is delayed: {}",
                    bounded_error(&error)
                ))?;
                "delayed".into()
            }
        };
        *self.active()? = Some(ActiveCapture {
            meeting_id: meeting_id.clone(),
            run_id: run_id.clone(),
            request_key,
            mic_muted: false,
            transcription,
            duration_ms: 0,
        });
        if let Some(candidate_id) = request.candidate_id.as_deref() {
            if let Err(message) = self.inner.platform.dismiss_candidate(candidate_id) {
                self.set_diagnostic(format!(
                    "Recording started, but its meeting suggestion could not be dismissed: {}",
                    bounded_error(&message)
                ))?;
            }
        }

        debug_assert_eq!(recording.status, MeetingStatus::Recording);
        self.publish_unlocked("capture-started", Some(meeting_id), Some(run_id))
    }

    pub fn stop(&self, meeting_id: &str) -> Result<MeetingSnapshot, MeetingRuntimeError> {
        let _operation = self.operation()?;
        // Drop the guard before the idempotent branch re-enters snapshot
        // projection and acquires the same mutex.
        let active_capture = { self.active()?.clone() };
        let Some(active) = active_capture else {
            // Stop is safe to repeat after the durable meeting already reached
            // a non-live state.
            let meeting = self.inner.store.get_meeting(meeting_id)?;
            if !matches!(
                meeting.status,
                MeetingStatus::Recording | MeetingStatus::Stopping | MeetingStatus::Finalizing
            ) {
                return self.snapshot_unlocked(self.inner.revision.load(Ordering::Acquire));
            }
            return Err(MeetingRuntimeError::NotActiveMeeting {
                meeting_id: meeting_id.into(),
            });
        };
        if active.meeting_id != meeting_id {
            return Err(MeetingRuntimeError::NotActiveMeeting {
                meeting_id: meeting_id.into(),
            });
        }
        // Resolve non-secret hook policy before stopping native capture. If
        // settings authority is temporarily unavailable, no irreversible
        // lifecycle boundary has been crossed and Stop can be retried safely.
        let hook_config = self.hook_config()?;

        let recording = self.inner.store.get_meeting(meeting_id)?;
        let stopping = if recording.status == MeetingStatus::Recording {
            self.inner.store.transition_meeting(
                meeting_id,
                recording.revision,
                MeetingStatus::Stopping,
                &self.inner.clock.now(),
                None,
            )?
        } else {
            recording
        };
        let _ = self.publish_unlocked(
            "capture-stopping",
            Some(meeting_id.into()),
            Some(active.run_id.clone()),
        )?;

        let stopped = match self.inner.capture.stop(&CaptureStop {
            meeting_id: meeting_id.into(),
            run_id: active.run_id.clone(),
        }) {
            Ok(result) => result,
            Err(message) => {
                // A native worker can fail just before Stop acquires the
                // operation lock. Its retained handle then reports that
                // terminal error here, before the asynchronous callback is
                // delivered. Persist failure intent first, then drain/remove
                // the live transcriber session before recovery can be claimed
                // in this same process.
                let after_capture_failure = self.inner.store.get_meeting(meeting_id)?;
                let failure = MeetingFailure {
                    code: "capture-stop-failed".into(),
                    message: bounded_error(&message),
                    retryable: true,
                };
                let interrupted = self.inner.store.transition_meeting(
                    meeting_id,
                    after_capture_failure.revision,
                    MeetingStatus::Interrupted,
                    &self.inner.clock.now(),
                    Some(&failure),
                )?;
                *self.active()? = None;
                self.set_diagnostic(format!("capture-stop-failed: {}", bounded_error(&message)))?;
                if let Err(error) = self.publish_unlocked(
                    "meeting-interrupted",
                    Some(meeting_id.into()),
                    Some(active.run_id.clone()),
                ) {
                    log::error!("Could not publish the durable Scribe stop failure: {error}");
                }

                let finalize = self.inner.transcription.finalize(&TranscriptionFinalize {
                    meeting_id: meeting_id.into(),
                    run_id: active.run_id.clone(),
                    base_revision: interrupted.transcript_revision,
                    observed_at: self.inner.clock.now(),
                });
                let after_provider_drain = self.inner.store.get_meeting(meeting_id)?;
                let terminal_applied = match finalize {
                    Ok(batch)
                        if batch.meeting_id == meeting_id
                            && batch.base_revision == after_provider_drain.transcript_revision
                            && batch.marks_final =>
                    {
                        self.inner.store.apply_transcript_batch(&batch).is_ok()
                    }
                    _ => false,
                };
                let current = self.inner.store.get_meeting(meeting_id)?;
                if terminal_applied {
                    self.inner.store.transition_meeting(
                        meeting_id,
                        current.revision,
                        MeetingStatus::Failed,
                        &self.inner.clock.now(),
                        Some(&failure),
                    )?;
                } else {
                    self.enqueue_transcription_retry(
                        meeting_id,
                        current.transcript_revision,
                        &message,
                    )?;
                }
                return Err(port_error("meeting capture stop", message));
            }
        };

        if let Some(current) = self.active()?.as_mut() {
            current.duration_ms = stopped.duration_ms;
        }
        // Native capture joins before finalization. During device reconnect or
        // sleep recovery that join can durably append an explicit transcript
        // gap, which advances both the transcript and meeting revisions.
        // Finalization must extend that post-teardown authority rather than
        // the revision captured before Stop signalled the worker.
        debug_assert_eq!(stopping.status, MeetingStatus::Stopping);
        let after_capture_stop = self.inner.store.get_meeting(meeting_id)?;
        let finalizing = self.inner.store.transition_meeting(
            meeting_id,
            after_capture_stop.revision,
            MeetingStatus::Finalizing,
            &self.inner.clock.now(),
            None,
        )?;
        let _ = self.publish_unlocked(
            "transcript-finalizing",
            Some(meeting_id.into()),
            Some(active.run_id.clone()),
        )?;

        let transcript_request = TranscriptionFinalize {
            meeting_id: meeting_id.into(),
            run_id: active.run_id.clone(),
            base_revision: finalizing.transcript_revision,
            observed_at: self.inner.clock.now(),
        };
        let finalize_result = self.inner.transcription.finalize(&transcript_request);
        // A provider can durably commit acknowledged tail segments before
        // either completing or reporting a terminal failure.
        let after_provider_drain = self.inner.store.get_meeting(meeting_id)?;
        let batch = match finalize_result {
            Ok(batch) => batch,
            Err(message) => {
                self.enqueue_transcription_retry(
                    meeting_id,
                    after_provider_drain.transcript_revision,
                    &message,
                )?;
                self.interrupt_after_stop_failure(
                    meeting_id,
                    &active.run_id,
                    after_provider_drain.revision,
                    "transcript-finalize-failed",
                    &message,
                )?;
                return self.snapshot_unlocked(self.inner.revision.load(Ordering::Acquire));
            }
        };
        if !batch.marks_final {
            let message = "transcription finalizer returned a non-terminal batch";
            self.enqueue_transcription_retry(
                meeting_id,
                after_provider_drain.transcript_revision,
                message,
            )?;
            self.interrupt_after_stop_failure(
                meeting_id,
                &active.run_id,
                after_provider_drain.revision,
                "transcript-not-final",
                message,
            )?;
            return self.snapshot_unlocked(self.inner.revision.load(Ordering::Acquire));
        }
        // The transcription port may durably commit final live-provider
        // segments while draining its acknowledged tail. Refresh after the
        // worker joins and require the terminal marker to extend that exact
        // durable revision, not the pre-join snapshot.
        if batch.meeting_id != meeting_id
            || batch.base_revision != after_provider_drain.transcript_revision
        {
            let message =
                "transcription finalizer returned a batch for another meeting or revision";
            self.enqueue_transcription_retry(
                meeting_id,
                after_provider_drain.transcript_revision,
                message,
            )?;
            self.interrupt_after_stop_failure(
                meeting_id,
                &active.run_id,
                after_provider_drain.revision,
                "transcript-invalid-batch",
                message,
            )?;
            return self.snapshot_unlocked(self.inner.revision.load(Ordering::Acquire));
        }
        let applied = match self.inner.store.apply_transcript_batch(&batch) {
            Ok(applied) => applied,
            Err(error) => {
                let message = error.to_string();
                self.enqueue_transcription_retry(
                    meeting_id,
                    after_provider_drain.transcript_revision,
                    &message,
                )?;
                self.interrupt_after_stop_failure(
                    meeting_id,
                    &active.run_id,
                    after_provider_drain.revision,
                    "transcript-persist-failed",
                    &message,
                )?;
                return self.snapshot_unlocked(self.inner.revision.load(Ordering::Acquire));
            }
        };
        let after_transcript = self.inner.store.get_meeting(meeting_id)?;
        let overview = self.inner.store.transcript_overview(meeting_id, 1)?;
        let completed_at = self.inner.clock.now();
        let summary_job = (hook_config.summary_enabled && overview.segment_count > 0).then(|| {
            self.summary_job_draft(
                meeting_id,
                applied.revision,
                &hook_config.summary_template,
                &hook_config.summary_preset,
                &completed_at,
            )
        });
        let (completed, _) = self.inner.store.complete_meeting_with_job(
            meeting_id,
            after_transcript.revision,
            &completed_at,
            summary_job.as_ref(),
        )?;
        *self.active()? = None;

        debug_assert_eq!(completed.status, MeetingStatus::Completed);
        self.publish_unlocked(
            "meeting-finalized",
            Some(meeting_id.into()),
            Some(active.run_id),
        )
    }

    pub fn set_microphone_muted(
        &self,
        meeting_id: &str,
        muted: bool,
    ) -> Result<MeetingSnapshot, MeetingRuntimeError> {
        let _operation = self.operation()?;
        let active =
            self.active()?
                .clone()
                .ok_or_else(|| MeetingRuntimeError::NotActiveMeeting {
                    meeting_id: meeting_id.into(),
                })?;
        if active.meeting_id != meeting_id {
            return Err(MeetingRuntimeError::NotActiveMeeting {
                meeting_id: meeting_id.into(),
            });
        }
        if active.mic_muted == muted {
            return self.snapshot_unlocked(self.inner.revision.load(Ordering::Acquire));
        }
        self.inner
            .capture
            .set_microphone_muted(meeting_id, &active.run_id, muted)
            .map_err(|message| port_error("microphone mute", message))?;
        if let Some(current) = self.active()?.as_mut() {
            current.mic_muted = muted;
        }
        self.publish_unlocked(
            "microphone-muted-changed",
            Some(meeting_id.into()),
            Some(active.run_id),
        )
    }

    fn handle_capture_failure(
        &self,
        meeting_id: &str,
        run_id: &str,
        message: &str,
    ) -> Result<MeetingSnapshot, MeetingRuntimeError> {
        let _operation = self.operation()?;
        let active = self.active()?.clone();
        let Some(active) = active else {
            return self.snapshot_unlocked(self.inner.revision.load(Ordering::Acquire));
        };
        if active.meeting_id != meeting_id || active.run_id != run_id {
            // Late completion from a superseded native worker has no authority
            // over the current session.
            return self.snapshot_unlocked(self.inner.revision.load(Ordering::Acquire));
        }

        // The worker has already ended. `stop` removes and joins its retained
        // handle; its expected terminal error must not prevent transcript
        // drainage or durable lifecycle repair.
        let _ = self.inner.capture.stop(&CaptureStop {
            meeting_id: meeting_id.into(),
            run_id: run_id.into(),
        });
        let recording = self.inner.store.get_meeting(meeting_id)?;
        let failure = MeetingFailure {
            code: "capture-runtime-failed".into(),
            message: bounded_error(message),
            retryable: true,
        };
        let interrupted = self.inner.store.transition_meeting(
            meeting_id,
            recording.revision,
            MeetingStatus::Interrupted,
            &self.inner.clock.now(),
            Some(&failure),
        )?;
        *self.active()? = None;
        let _ = self.set_diagnostic(format!(
            "Recording stopped after a native capture failure: {}",
            bounded_error(message)
        ));
        // Publish the durable failure before draining a slow provider. This is
        // a renderer invalidation only; projection failure cannot delay
        // transcript repair or undo the already committed lifecycle.
        if let Err(error) = self.publish_unlocked(
            "capture-runtime-failed",
            Some(meeting_id.into()),
            Some(run_id.into()),
        ) {
            log::error!("Could not publish the durable Scribe capture failure: {error}");
        }

        let finalize = self.inner.transcription.finalize(&TranscriptionFinalize {
            meeting_id: meeting_id.into(),
            run_id: run_id.into(),
            base_revision: interrupted.transcript_revision,
            observed_at: self.inner.clock.now(),
        });

        let after_provider_drain = self.inner.store.get_meeting(meeting_id)?;
        let transcript_final = match finalize {
            Ok(batch)
                if batch.meeting_id == meeting_id
                    && batch.base_revision == after_provider_drain.transcript_revision
                    && batch.marks_final =>
            {
                self.inner.store.apply_transcript_batch(&batch).is_ok()
            }
            _ => false,
        };
        let current = self.inner.store.get_meeting(meeting_id)?;
        if transcript_final {
            self.inner.store.transition_meeting(
                meeting_id,
                current.revision,
                MeetingStatus::Failed,
                &self.inner.clock.now(),
                Some(&failure),
            )?;
            self.publish_unlocked(
                "capture-runtime-reconciled",
                Some(meeting_id.into()),
                Some(run_id.into()),
            )
        } else {
            self.enqueue_transcription_retry(
                meeting_id,
                current.transcript_revision,
                "capture ended before transcript finalization",
            )?;
            self.publish_unlocked(
                "transcription-repair-queued",
                Some(meeting_id.into()),
                Some(run_id.into()),
            )
        }
    }

    /// Persist one non-terminal real-time transcript batch emitted by the STT
    /// adapter. The run token rejects late callbacks from a prior capture, and
    /// `MeetingStore` enforces batch idempotency plus optimistic base revisions.
    pub fn ingest_transcript_batch(
        &self,
        run_id: &str,
        batch: TranscriptBatch,
    ) -> Result<MeetingSnapshot, MeetingRuntimeError> {
        let _operation = self.operation()?;
        let active = {
            self.active()?
                .clone()
                .ok_or_else(|| MeetingRuntimeError::NotActiveMeeting {
                    meeting_id: batch.meeting_id.clone(),
                })?
        };
        if active.run_id != run_id || active.meeting_id != batch.meeting_id {
            return Err(MeetingRuntimeError::Validation(
                "transcript batch belongs to a stale or different capture run".into(),
            ));
        }
        if batch.marks_final {
            return Err(MeetingRuntimeError::Validation(
                "only stop finalization may mark the transcript final".into(),
            ));
        }
        let applied = self.inner.store.apply_transcript_batch(&batch)?;
        if applied.duplicate {
            return self.snapshot_unlocked(self.inner.revision.load(Ordering::Acquire));
        }
        self.publish_unlocked(
            "transcript-batch-applied",
            Some(active.meeting_id),
            Some(active.run_id),
        )
    }

    /// Complete a crash window where the terminal transcript marker reached
    /// SQLite before lifecycle completion or job acknowledgement.
    ///
    /// No transcription provider is started. An all-final silent transcript
    /// is valid; title/summary work is queued only when at least one final
    /// speech segment exists.
    pub fn complete_terminal_recovery(
        &self,
        meeting_id: &str,
    ) -> Result<bool, MeetingRuntimeError> {
        let _operation = self.operation()?;
        let meeting = self.inner.store.get_meeting(meeting_id)?;
        self.complete_terminal_recovery_unlocked(&meeting)
    }

    pub(crate) fn durable_meeting(
        &self,
        meeting_id: &str,
    ) -> Result<MeetingRecord, MeetingRuntimeError> {
        self.inner.store.get_meeting(meeting_id).map_err(Into::into)
    }

    pub(crate) fn durable_transcript_result(
        &self,
        meeting_id: &str,
    ) -> Result<(u64, u64, bool), MeetingRuntimeError> {
        let meeting = self.inner.store.get_meeting(meeting_id)?;
        let overview = self.inner.store.transcript_overview(meeting_id, 0)?;
        Ok((
            meeting.transcript_revision,
            overview.segment_count,
            overview.is_final && overview.non_final_segment_count == 0,
        ))
    }

    pub(crate) fn has_committed_audio(
        &self,
        meeting_id: &str,
    ) -> Result<bool, MeetingRuntimeError> {
        self.inner
            .store
            .has_committed_audio(meeting_id)
            .map_err(Into::into)
    }

    fn complete_terminal_recovery_unlocked(
        &self,
        meeting: &MeetingRecord,
    ) -> Result<bool, MeetingRuntimeError> {
        let overview = self.inner.store.transcript_overview(&meeting.id, 1)?;
        if !overview.is_final || overview.non_final_segment_count != 0 {
            return Ok(false);
        }
        if matches!(
            meeting.status,
            MeetingStatus::Completed | MeetingStatus::Failed
        ) {
            return Ok(true);
        }
        if meeting.status == MeetingStatus::Interrupted {
            if let Some(failure) = meeting.failure.as_ref() {
                self.inner.store.transition_meeting(
                    &meeting.id,
                    meeting.revision,
                    MeetingStatus::Failed,
                    &self.inner.clock.now(),
                    Some(failure),
                )?;
                return Ok(true);
            }
        }
        let config = self.hook_config()?;
        let mut current = meeting.clone();
        if current.status == MeetingStatus::Interrupted {
            current = self.inner.store.transition_meeting(
                &current.id,
                current.revision,
                MeetingStatus::Finalizing,
                &self.inner.clock.now(),
                None,
            )?;
        }
        if current.status == MeetingStatus::Finalizing {
            let completed_at = self.inner.clock.now();
            let summary_job = (config.summary_enabled && overview.segment_count > 0).then(|| {
                self.summary_job_draft(
                    &current.id,
                    overview.revision,
                    &config.summary_template,
                    &config.summary_preset,
                    &completed_at,
                )
            });
            current = self
                .inner
                .store
                .complete_meeting_with_job(
                    &current.id,
                    current.revision,
                    &completed_at,
                    summary_job.as_ref(),
                )?
                .0;
        }
        if current.status != MeetingStatus::Completed {
            return Ok(false);
        }
        Ok(true)
    }

    /// Complete an interrupted meeting from a durable transcription retry.
    ///
    /// The job worker calls this before marking its transcription job
    /// succeeded. Repeating the call with an already completed meeting returns
    /// the current snapshot, which makes worker redelivery safe.
    pub fn complete_transcription_retry(
        &self,
        meeting_id: &str,
        capture_generation: &str,
        provider_run_id: &str,
        batch: TranscriptBatch,
    ) -> Result<MeetingSnapshot, MeetingRuntimeError> {
        let _operation = self.operation()?;
        let meeting = self.inner.store.get_meeting(meeting_id)?;
        if meeting.status == MeetingStatus::Completed && self.transcript_is_final(&meeting)? {
            return self.snapshot_unlocked(self.inner.revision.load(Ordering::Acquire));
        }
        let recovery_failure = meeting.failure.clone();
        let finalizing = match meeting.status {
            MeetingStatus::Interrupted if recovery_failure.is_some() => meeting,
            MeetingStatus::Interrupted => self.inner.store.transition_meeting(
                meeting_id,
                meeting.revision,
                MeetingStatus::Finalizing,
                &self.inner.clock.now(),
                None,
            )?,
            MeetingStatus::Finalizing => meeting,
            _ => {
                return Err(MeetingRuntimeError::Validation(
                    "transcription retry requires an interrupted or finalizing meeting".into(),
                ));
            }
        };
        if batch.meeting_id != meeting_id
            || batch.base_revision != finalizing.transcript_revision
            || !batch.marks_final
        {
            return Err(MeetingRuntimeError::Validation(
                "transcription retry returned a non-final batch for another meeting or revision"
                    .into(),
            ));
        }
        let config = recovery_failure
            .is_none()
            .then(|| self.hook_config())
            .transpose()?;
        let applied = self.inner.store.commit_transcript_repair(
            capture_generation,
            provider_run_id,
            &batch,
        )?;
        let persisted = self.inner.store.get_meeting(meeting_id)?;
        let overview = self.inner.store.transcript_overview(meeting_id, 1)?;
        if !overview.is_final || overview.non_final_segment_count != 0 {
            return Err(MeetingRuntimeError::Validation(
                "transcription repair did not produce an all-final terminal transcript".into(),
            ));
        }
        let completed_at = self.inner.clock.now();
        if let Some(failure) = recovery_failure.as_ref() {
            self.inner.store.transition_meeting(
                meeting_id,
                persisted.revision,
                MeetingStatus::Failed,
                &completed_at,
                Some(failure),
            )?;
        } else {
            let config = config.expect("successful recovery must resolve hook configuration");
            let summary_job = (config.summary_enabled && overview.segment_count > 0).then(|| {
                self.summary_job_draft(
                    meeting_id,
                    applied.revision,
                    &config.summary_template,
                    &config.summary_preset,
                    &completed_at,
                )
            });
            self.inner.store.complete_meeting_with_job(
                meeting_id,
                persisted.revision,
                &completed_at,
                summary_job.as_ref(),
            )?;
        }
        self.publish_unlocked("meeting-recovered", Some(meeting_id.into()), None)
    }

    pub fn update_meeting(
        &self,
        meeting_id: &str,
        patch: MeetingUpdatePatch,
    ) -> Result<MeetingSnapshot, MeetingRuntimeError> {
        let _operation = self.operation()?;
        self.inner.store.get_meeting(meeting_id)?;
        validate_update_patch(&patch)?;
        self.inner
            .platform
            .update_content(meeting_id, &patch)
            .map_err(|message| port_error("meeting content update", message))?;
        self.publish_unlocked("meeting-updated", Some(meeting_id.into()), None)
    }

    pub fn update_config(
        &self,
        patch: MeetingConfigPatch,
    ) -> Result<MeetingSnapshot, MeetingRuntimeError> {
        let _operation = self.operation()?;
        validate_config_patch(&patch)?;
        self.inner
            .platform
            .update_config(&patch)
            .map_err(|message| port_error("meeting config update", message))?;
        self.publish_unlocked("config-changed", None, None)
    }

    pub fn set_api_key(&self, api_key: &str) -> Result<MeetingSnapshot, MeetingRuntimeError> {
        let _operation = self.operation()?;
        if api_key.trim().is_empty() {
            return Err(MeetingRuntimeError::Validation(
                "transcription API key cannot be empty".into(),
            ));
        }
        self.inner
            .platform
            .set_api_key(api_key.trim())
            .map_err(|message| port_error("meeting API key update", message))?;
        self.publish_unlocked("config-changed", None, None)
    }

    pub fn clear_api_key(&self) -> Result<MeetingSnapshot, MeetingRuntimeError> {
        let _operation = self.operation()?;
        self.inner
            .platform
            .clear_api_key()
            .map_err(|message| port_error("meeting API key removal", message))?;
        self.publish_unlocked("config-changed", None, None)
    }

    pub fn install_model(&self, model_id: &str) -> Result<MeetingSnapshot, MeetingRuntimeError> {
        let _operation = self.operation()?;
        require_nonempty(model_id, "model id")?;
        self.inner
            .platform
            .install_model(model_id)
            .map_err(|message| port_error("meeting model install", message))?;
        self.publish_unlocked("model-changed", None, None)
    }

    pub fn delete_model(&self, model_id: &str) -> Result<MeetingSnapshot, MeetingRuntimeError> {
        let _operation = self.operation()?;
        require_nonempty(model_id, "model id")?;
        self.inner
            .platform
            .delete_model(model_id)
            .map_err(|message| port_error("meeting model deletion", message))?;
        self.publish_unlocked("model-changed", None, None)
    }

    pub fn decide_kg(
        &self,
        meeting_id: &str,
        decision: &str,
    ) -> Result<MeetingSnapshot, MeetingRuntimeError> {
        let _operation = self.operation()?;
        let meeting = self.inner.store.get_meeting(meeting_id)?;
        if meeting.status != MeetingStatus::Completed || !self.transcript_is_final(&meeting)? {
            return Err(MeetingRuntimeError::Validation(
                "knowledge-graph follow-up requires a completed final transcript".into(),
            ));
        }
        if summary_state(&self.inner.store.list_jobs(meeting_id)?) != "succeeded" {
            return Err(MeetingRuntimeError::Validation(
                "knowledge-graph follow-up requires a successful title and summary job".into(),
            ));
        }
        match decision {
            "create-draft" => {
                self.inner
                    .platform
                    .set_kg_decision(meeting_id, decision)
                    .map_err(|message| port_error("knowledge-graph decision", message))?;
                let config = self.platform_projection()?.config;
                self.enqueue_kg_job(meeting_id, meeting.transcript_revision, &config.kg_preset)?;
            }
            "not-now" | "never" => {
                self.inner
                    .platform
                    .set_kg_decision(meeting_id, decision)
                    .map_err(|message| port_error("knowledge-graph decision", message))?;
            }
            _ => {
                return Err(MeetingRuntimeError::Validation(
                    "knowledge-graph decision must be create-draft, not-now, or never".into(),
                ));
            }
        }
        self.publish_unlocked("kg-decision-changed", Some(meeting_id.into()), None)
    }

    pub fn claim_next_job(
        &self,
        worker_id: &str,
        lease_expires_at: &str,
    ) -> Result<Option<FollowUpJob>, MeetingRuntimeError> {
        let _operation = self.operation()?;
        let job = self.inner.store.claim_next_job(
            worker_id,
            &self.inner.clock.now(),
            lease_expires_at,
        )?;
        if let Some(job) = &job {
            let _ = self.publish_unlocked(
                "meeting-job-running",
                Some(job.definition.meeting_id.clone()),
                None,
            )?;
        }
        Ok(job)
    }

    pub fn finish_job(
        &self,
        job_id: &str,
        lease_token: &str,
        outcome: JobFinish,
    ) -> Result<MeetingSnapshot, MeetingRuntimeError> {
        let _operation = self.operation()?;
        let job =
            self.inner
                .store
                .finish_job(job_id, lease_token, &outcome, &self.inner.clock.now())?;
        if job.state == JobState::Cancelled {
            if let Some(deletion) = self
                .inner
                .store
                .deletion(&job.definition.meeting_id)?
                .filter(|deletion| {
                    deletion.mode == StoreDeletionMode::All
                        && deletion.stage == MeetingDeletionStage::FilesPending
                })
            {
                if let Err(message) = self
                    .inner
                    .platform
                    .delete_meeting(&deletion.meeting_id, MeetingDeleteMode::All)
                {
                    self.set_diagnostic(format!(
                        "Permanent deletion for meeting '{}' will resume at next launch: {message}",
                        deletion.meeting_id
                    ))?;
                }
            }
        }
        if job.state == JobState::Succeeded && job.definition.kind == FollowUpJobKind::Summary {
            let config = self.platform_projection()?.config;
            if config.kg_prompt == "always-draft" {
                let meeting = self.inner.store.get_meeting(&job.definition.meeting_id)?;
                self.enqueue_kg_job(
                    &job.definition.meeting_id,
                    meeting.transcript_revision,
                    &config.kg_preset,
                )?;
                self.inner
                    .platform
                    .set_kg_decision(&job.definition.meeting_id, "create-draft")
                    .map_err(|message| port_error("knowledge-graph decision", message))?;
            }
        }
        self.publish_unlocked("meeting-job-changed", Some(job.definition.meeting_id), None)
    }

    pub fn retry_job(
        &self,
        meeting_id: &str,
        job_kind: &str,
    ) -> Result<MeetingSnapshot, MeetingRuntimeError> {
        let _operation = self.operation()?;
        let meeting = self.inner.store.get_meeting(meeting_id)?;
        let kind = parse_renderer_job_kind(job_kind)?;
        let jobs = self.inner.store.list_jobs(meeting_id)?;
        if jobs.iter().any(|job| {
            job.definition.kind == kind
                && matches!(job.state, JobState::Pending | JobState::Running)
        }) {
            return self.snapshot_unlocked(self.inner.revision.load(Ordering::Acquire));
        }
        if kind != FollowUpJobKind::Summary
            && jobs
                .iter()
                .any(|job| job.definition.kind == kind && job.state == JobState::Succeeded)
        {
            return self.snapshot_unlocked(self.inner.revision.load(Ordering::Acquire));
        }

        let retry_prefix = format!("{meeting_id}:{job_kind}:retry:");
        let retry_number = jobs
            .iter()
            .filter_map(|job| {
                job.definition
                    .idempotency_key
                    .strip_prefix(&retry_prefix)
                    .and_then(|suffix| suffix.parse::<u64>().ok())
            })
            .max()
            .unwrap_or(0)
            .saturating_add(1);
        let now = self.inner.clock.now();
        let mut draft = if kind == FollowUpJobKind::Summary {
            let overview = self.inner.store.transcript_overview(meeting_id, 1)?;
            if meeting.status != MeetingStatus::Completed
                || !overview.is_final
                || overview.non_final_segment_count != 0
                || overview.segment_count == 0
            {
                return Err(MeetingRuntimeError::Validation(
                    "creating the summary again requires a completed, non-empty terminal transcript"
                        .into(),
                ));
            }
            let config = self.hook_config()?;
            self.summary_job_draft(
                meeting_id,
                meeting.transcript_revision,
                &config.summary_template,
                &config.summary_preset,
                &now,
            )
        } else {
            let latest = jobs.iter().rev().find(|job| job.definition.kind == kind);
            let payload = latest
                .map(|job| job.definition.payload.clone())
                .unwrap_or_else(|| {
                    json!({
                        "meetingId": meeting_id,
                        "transcriptRevision": meeting.transcript_revision,
                        "reviewRequired": true,
                    })
                });
            FollowUpJobDraft {
                id: format!("job-retry-{}", Uuid::new_v4()),
                meeting_id: meeting_id.into(),
                kind,
                idempotency_key: String::new(),
                payload,
                max_attempts: DEFAULT_JOB_ATTEMPTS,
                not_before: now.clone(),
            }
        };
        draft.id = format!("job-retry-{}", Uuid::new_v4());
        draft.idempotency_key = format!("{retry_prefix}{retry_number}");
        self.inner.store.enqueue_job(&draft, &now)?;
        self.publish_unlocked("meeting-job-retried", Some(meeting_id.into()), None)
    }

    pub fn delete(
        &self,
        meeting_id: &str,
        mode: MeetingDeleteMode,
    ) -> Result<MeetingSnapshot, MeetingRuntimeError> {
        let _operation = self.operation()?;
        let is_active = {
            self.active()?
                .as_ref()
                .is_some_and(|active| active.meeting_id == meeting_id)
        };
        if is_active {
            return Err(MeetingRuntimeError::Validation(
                "stop and finalize the active meeting before deleting it".into(),
            ));
        }
        if self.inner.store.deletion(meeting_id)?.is_none() {
            self.inner.store.get_meeting(meeting_id)?;
        }
        let deletion = self.inner.store.begin_deletion(
            meeting_id,
            match mode {
                MeetingDeleteMode::Audio => StoreDeletionMode::Audio,
                MeetingDeleteMode::All => StoreDeletionMode::All,
            },
            &self.inner.clock.now(),
        )?;
        if deletion.stage == MeetingDeletionStage::WaitingForJobs {
            return Err(MeetingStoreError::DeletionBlocked {
                meeting_id: meeting_id.into(),
                running_jobs: deletion.running_jobs,
            }
            .into());
        }
        self.inner
            .platform
            .delete_meeting(meeting_id, mode)
            .map_err(|message| port_error("meeting deletion", message))?;
        self.publish_unlocked("meeting-deleted", Some(meeting_id.into()), None)
    }

    pub fn export(
        &self,
        meeting_id: &str,
        format: MeetingExportFormat,
    ) -> Result<MeetingExport, MeetingRuntimeError> {
        let _operation = self.operation()?;
        self.inner.store.get_meeting(meeting_id)?;
        self.inner
            .platform
            .export_meeting(meeting_id, format)
            .map_err(|message| port_error("meeting export", message))
    }

    fn snapshot_unlocked(&self, revision: u64) -> Result<MeetingSnapshot, MeetingRuntimeError> {
        let projection = self.platform_projection()?;
        let active = self.active()?.clone();
        let active_meeting_id = active.as_ref().map(|value| value.meeting_id.clone());
        let candidates = if active.is_some() {
            Vec::new()
        } else {
            projection.candidates
        };
        let runtime_diagnostic = self.diagnostic()?.clone();
        let page = self.library_page_unlocked(None, DEFAULT_MEETING_LIMIT)?;
        let mut meetings = page.meetings;
        meetings.sort_by(|left, right| {
            right
                .started_at
                .as_deref()
                .unwrap_or(right.updated_at.as_deref().unwrap_or(""))
                .cmp(
                    left.started_at
                        .as_deref()
                        .unwrap_or(left.updated_at.as_deref().unwrap_or("")),
                )
                .then_with(|| left.id.cmp(&right.id))
        });

        Ok(MeetingSnapshot {
            revision,
            meetings,
            meetings_truncated: page.has_more,
            next_meetings_before: page.next_before,
            active_meeting_id,
            candidates,
            config: projection.config,
            permissions: projection.permissions,
            models: projection.models,
            diagnostic: runtime_diagnostic.or(projection.diagnostic),
        })
    }

    fn library_page_unlocked(
        &self,
        before: Option<MeetingLibraryCursor>,
        limit: u32,
    ) -> Result<MeetingLibraryPage, MeetingRuntimeError> {
        let active = self.active()?.clone();
        let before = before.map(|cursor| StoreMeetingListCursor {
            created_at: cursor.created_at,
            meeting_id: cursor.meeting_id,
        });
        let page = self
            .inner
            .store
            .list_meetings_page(before.as_ref(), limit.clamp(1, DEFAULT_MEETING_LIMIT))?;
        let hook_config = self.hook_config()?;
        let mut meetings = Vec::with_capacity(page.meetings.len());
        for record in page.meetings {
            let content = self
                .inner
                .platform
                .content(&record.id)
                .map_err(|message| port_error("meeting content projection", message))?;
            if !content.deleted {
                meetings.push(self.meeting_view(
                    &record,
                    &content,
                    active.as_ref(),
                    &hook_config.kg_prompt,
                )?);
            }
        }
        Ok(MeetingLibraryPage {
            meetings,
            has_more: page.has_more,
            next_before: page.next_before.map(|cursor| MeetingLibraryCursor {
                created_at: cursor.created_at,
                meeting_id: cursor.meeting_id,
            }),
        })
    }

    fn meeting_view(
        &self,
        record: &MeetingRecord,
        content: &MeetingContentProjection,
        active: Option<&ActiveCapture>,
        kg_prompt: &str,
    ) -> Result<MeetingView, MeetingRuntimeError> {
        let transcript = self
            .inner
            .store
            .transcript_overview(&record.id, MAX_LIBRARY_GAPS)?;
        let transcript_final = transcript.is_final;
        let jobs = self.inner.store.list_jobs(&record.id)?;
        let active = active.filter(|value| value.meeting_id == record.id);
        let full_summary = content
            .summary
            .clone()
            .or_else(|| successful_summary(&jobs, "summary"));
        let (summary, summary_truncated) = summary_preview(full_summary.as_deref());
        let generated_title = successful_summary(&jobs, "title");
        let title = content
            .title
            .clone()
            .or_else(|| {
                (record.title == "Untitled meeting")
                    .then_some(generated_title)
                    .flatten()
            })
            .unwrap_or_else(|| record.title.clone());
        let summary_state = summary_state(&jobs);
        let kg_state = kg_state(
            &jobs,
            &summary_state,
            content.kg_decision.as_deref(),
            kg_prompt,
        );
        let channels = record
            .channels
            .iter()
            .map(|channel| channel.definition.kind.to_string())
            .collect::<Vec<_>>();
        let channel_names = record
            .channels
            .iter()
            .map(|channel| {
                (
                    channel.definition.id.as_str(),
                    channel.definition.kind.to_string(),
                )
            })
            .collect::<HashMap<_, _>>();
        let transcription = if transcript_final {
            "final".into()
        } else if let Some(active) = active {
            if active.transcription == "delayed" {
                active.transcription.clone()
            } else {
                self.inner.transcription.status(&record.id).as_str().into()
            }
        } else if jobs.iter().any(|job| {
            job.definition.kind == FollowUpJobKind::Custom("transcription".into())
                && matches!(job.state, JobState::Pending | JobState::Running)
        }) {
            "batch".into()
        } else if record.transcript_revision > 0 {
            "delayed".into()
        } else {
            "idle".into()
        };
        let duration_ms = active
            .map(|value| value.duration_ms)
            .unwrap_or_else(|| duration_ms(record));

        Ok(MeetingView {
            id: record.id.clone(),
            title,
            lifecycle: lifecycle(record.status).into(),
            transcription,
            started_at: record.started_at.clone(),
            stopped_at: record.stopped_at.clone(),
            duration_ms,
            workspace_path: content
                .workspace_path
                .clone()
                .or_else(|| metadata_string(&record.metadata, "workspacePath")),
            source_app: content
                .source_app
                .clone()
                .or_else(|| metadata_string(&record.metadata, "sourceApp")),
            tags: content.tags.clone(),
            mic_muted: active.is_some_and(|value| value.mic_muted),
            channels,
            gaps: transcript
                .gaps
                .iter()
                .filter(|gap| gap.resolved_revision.is_none())
                .map(|gap| gap_view(gap, &channel_names))
                .collect(),
            gap_count: transcript.unresolved_gap_count,
            transcript_revision: transcript.revision,
            transcript_final,
            segment_count: transcript.segment_count,
            // A proven terminal transcript with no unresolved partials is
            // all-final even when it contains zero speech segments. Hook
            // eligibility separately requires non-empty speech.
            transcript_all_final: transcript_final && transcript.non_final_segment_count == 0,
            // Transcript bodies are selected-meeting detail, never library
            // snapshot data. Keeping this compatibility field empty prevents
            // accidental whole-history regressions at the IPC boundary.
            segments: Vec::new(),
            summary,
            summary_truncated,
            summary_state,
            kg_state,
            jobs: jobs.iter().map(job_view).collect(),
            error: record
                .failure
                .as_ref()
                .map(|failure| failure.message.clone())
                .or_else(|| record.interruption_reason.clone()),
            updated_at: Some(record.updated_at.clone()),
        })
    }

    fn transcript_is_final(&self, meeting: &MeetingRecord) -> Result<bool, MeetingRuntimeError> {
        Ok(self
            .inner
            .store
            .transcript_overview(&meeting.id, 1)?
            .is_final)
    }

    fn publish_unlocked(
        &self,
        kind: &str,
        meeting_id: Option<String>,
        run_id: Option<String>,
    ) -> Result<MeetingSnapshot, MeetingRuntimeError> {
        let revision = self.inner.revision.fetch_add(1, Ordering::AcqRel) + 1;
        let event = MeetingEvent {
            revision,
            run_id,
            meeting_id,
            kind: kind.into(),
            // Events are compact invalidations. The authoritative bounded
            // snapshot is read once by the renderer after coalescing bursts.
            snapshot: None,
        };
        if let Err(error) = self.inner.events.publish(&event) {
            self.set_diagnostic(format!(
                "Meeting state is durable but renderer notification failed: {}",
                bounded_error(&error)
            ))?;
        }
        self.snapshot_unlocked(revision)
    }

    fn interrupt_after_stop_failure(
        &self,
        meeting_id: &str,
        run_id: &str,
        expected_revision: u64,
        code: &str,
        message: &str,
    ) -> Result<(), MeetingRuntimeError> {
        let current = self.inner.store.get_meeting(meeting_id)?;
        let revision = if current.revision == expected_revision {
            expected_revision
        } else {
            current.revision
        };
        self.inner.store.transition_meeting(
            meeting_id,
            revision,
            MeetingStatus::Interrupted,
            &self.inner.clock.now(),
            None,
        )?;
        *self.active()? = None;
        self.set_diagnostic(format!("{code}: {}", bounded_error(message)))?;
        let _ = self.publish_unlocked(
            "meeting-interrupted",
            Some(meeting_id.into()),
            Some(run_id.into()),
        )?;
        Ok(())
    }

    fn summary_job_draft(
        &self,
        meeting_id: &str,
        transcript_revision: u64,
        template: &str,
        preset: &str,
        not_before: &str,
    ) -> FollowUpJobDraft {
        let idempotency_key = format!("{meeting_id}:title-summary:{transcript_revision}");
        FollowUpJobDraft {
            id: format!("job-summary-{}", Uuid::new_v4()),
            meeting_id: meeting_id.into(),
            kind: FollowUpJobKind::Summary,
            idempotency_key,
            payload: json!({
                "meetingId": meeting_id,
                "transcriptRevision": transcript_revision,
                "template": template,
                "preset": preset,
                "output": {
                    "title": "reviewable",
                    "summary": "reviewable"
                },
                "transcriptIsUntrusted": true
            }),
            max_attempts: DEFAULT_JOB_ATTEMPTS,
            not_before: not_before.into(),
        }
    }

    fn enqueue_kg_job(
        &self,
        meeting_id: &str,
        transcript_revision: u64,
        preset: &str,
    ) -> Result<FollowUpJob, MeetingRuntimeError> {
        let now = self.inner.clock.now();
        let idempotency_key = format!("{meeting_id}:kg-proposal:{transcript_revision}");
        if let Some(existing) = self
            .inner
            .store
            .list_jobs(meeting_id)?
            .into_iter()
            .find(|job| job.definition.idempotency_key == idempotency_key)
        {
            return Ok(existing);
        }
        let job = FollowUpJobDraft {
            id: format!("job-kg-{}", Uuid::new_v4()),
            meeting_id: meeting_id.into(),
            kind: FollowUpJobKind::KnowledgeGraph,
            idempotency_key,
            payload: json!({
                "meetingId": meeting_id,
                "transcriptRevision": transcript_revision,
                "preset": preset,
                "reviewRequired": true,
                "autoApply": false,
                "transcriptIsUntrusted": true
            }),
            max_attempts: DEFAULT_JOB_ATTEMPTS,
            not_before: now.clone(),
        };
        Ok(self.inner.store.enqueue_job(&job, &now)?.0)
    }

    fn enqueue_transcription_retry(
        &self,
        meeting_id: &str,
        transcript_revision: u64,
        failure: &str,
    ) -> Result<FollowUpJob, MeetingRuntimeError> {
        let meeting = self.inner.store.get_meeting(meeting_id)?;
        let route = meeting
            .metadata
            .get("transcriptionRoute")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                MeetingRuntimeError::Validation(
                    "meeting recovery has no immutable consented transcription route".into(),
                )
            })?;
        let model = meeting
            .metadata
            .get("transcriptionModel")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                MeetingRuntimeError::Validation(
                    "meeting recovery has no immutable consented transcription model".into(),
                )
            })?;
        let capture_generation = meeting
            .metadata
            .get("runId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                MeetingRuntimeError::Validation(
                    "meeting recovery has no immutable capture generation".into(),
                )
            })?;
        let now = self.inner.clock.now();
        let idempotency_key = format!("{meeting_id}:transcription:{capture_generation}");
        if let Some(existing) = self
            .inner
            .store
            .list_jobs(meeting_id)?
            .into_iter()
            .find(|job| job.definition.idempotency_key == idempotency_key)
        {
            return Ok(existing);
        }
        let job = FollowUpJobDraft {
            id: format!("job-transcription-{capture_generation}"),
            meeting_id: meeting_id.into(),
            kind: FollowUpJobKind::Custom("transcription".into()),
            idempotency_key,
            payload: json!({
                "meetingId": meeting_id,
                "captureGeneration": capture_generation,
                "transcriptRevision": transcript_revision,
                "transcriptionRoute": route,
                "transcriptionModel": model,
                "failure": bounded_error(failure)
            }),
            max_attempts: DEFAULT_JOB_ATTEMPTS,
            not_before: now.clone(),
        };
        Ok(self.inner.store.enqueue_job(&job, &now)?.0)
    }

    fn platform_projection(&self) -> Result<MeetingPlatformProjection, MeetingRuntimeError> {
        self.inner
            .platform
            .projection()
            .map_err(|message| port_error("meeting platform projection", message))
    }

    fn hook_config(&self) -> Result<MeetingHookConfig, MeetingRuntimeError> {
        self.inner
            .platform
            .hook_config()
            .map_err(|message| port_error("meeting hook configuration", message))
    }

    fn operation(&self) -> Result<MutexGuard<'_, ()>, MeetingRuntimeError> {
        self.inner
            .operation
            .lock()
            .map_err(|_| MeetingRuntimeError::Poisoned)
    }

    fn active(&self) -> Result<MutexGuard<'_, Option<ActiveCapture>>, MeetingRuntimeError> {
        self.inner
            .active
            .lock()
            .map_err(|_| MeetingRuntimeError::Poisoned)
    }

    fn diagnostic(&self) -> Result<MutexGuard<'_, Option<String>>, MeetingRuntimeError> {
        self.inner
            .diagnostic
            .lock()
            .map_err(|_| MeetingRuntimeError::Poisoned)
    }

    fn set_diagnostic(&self, diagnostic: String) -> Result<(), MeetingRuntimeError> {
        *self.diagnostic()? = Some(diagnostic);
        Ok(())
    }
}

impl MeetingCaptureFailureSink for MeetingRuntime {
    fn capture_failed(&self, meeting_id: &str, run_id: &str, message: &str) {
        if let Err(error) = self.handle_capture_failure(meeting_id, run_id, message) {
            log::error!(
                "Could not durably reconcile failed Scribe capture '{meeting_id}' ({run_id}): {error}"
            );
            let _ = self.set_diagnostic(format!(
                "Scribe capture failed and needs restart recovery: {}",
                bounded_error(message)
            ));
        }
    }
}

impl MeetingCaptureFailureSink for WeakMeetingRuntime {
    fn capture_failed(&self, meeting_id: &str, run_id: &str, message: &str) {
        let Some(inner) = self.inner.upgrade() else {
            return;
        };
        MeetingCaptureFailureSink::capture_failed(
            &MeetingRuntime { inner },
            meeting_id,
            run_id,
            message,
        );
    }
}

fn capture_channels(permissions: &MeetingPermissions) -> Vec<AudioChannelDraft> {
    let mut channels = vec![AudioChannelDraft {
        id: "microphone".into(),
        kind: AudioChannelKind::Microphone,
        sample_rate_hz: 16_000,
        channels: 1,
        sample_format: "f32le".into(),
        device_id: None,
    }];
    if !matches!(
        permissions.system_audio.as_str(),
        "denied" | "restricted" | "unavailable"
    ) {
        channels.push(AudioChannelDraft {
            id: "system".into(),
            kind: AudioChannelKind::System,
            sample_rate_hz: 16_000,
            channels: 1,
            sample_format: "f32le".into(),
            device_id: None,
        });
    }
    channels
}

fn transcription_route(config: &MeetingConfig) -> (String, String) {
    if config.transcription_mode == "custom" {
        (config.custom_url.clone(), config.custom_model.clone())
    } else {
        ("local".into(), config.local_model.clone())
    }
}

fn consent_context_for_projection(
    projection: &MeetingPlatformProjection,
    candidate_id: Option<&str>,
) -> Result<MeetingStartConsentContext, MeetingRuntimeError> {
    let candidate = match candidate_id {
        Some(candidate_id) => Some(
            projection
                .candidates
                .iter()
                .find(|candidate| candidate.id == candidate_id)
                .ok_or_else(|| {
                    MeetingRuntimeError::Validation(
                        "the selected meeting candidate is no longer available".into(),
                    )
                })?,
        ),
        None => None,
    };
    let (destination, model) = if projection.config.transcription_mode == "custom" {
        (
            Some(projection.config.custom_url.clone()),
            projection.config.custom_model.clone(),
        )
    } else {
        (None, projection.config.local_model.clone())
    };
    Ok(MeetingStartConsentContext {
        candidate_id: candidate.map(|value| value.id.clone()),
        candidate_app_id: candidate.map(|value| value.app_id.clone()),
        candidate_app_name: candidate.map(|value| value.app_name.clone()),
        transcription_mode: projection.config.transcription_mode.clone(),
        destination,
        model,
    })
}

fn validate_config(config: &MeetingConfig) -> Result<(), MeetingRuntimeError> {
    require_summary_template(&config.summary_template)?;
    match config.transcription_mode.as_str() {
        "local" => require_nonempty(&config.local_model, "local transcription model"),
        "custom" => {
            require_nonempty(&config.custom_url, "custom transcription URL")?;
            require_nonempty(&config.custom_model, "custom transcription model")?;
            if !config.custom_url.starts_with("https://") {
                return Err(MeetingRuntimeError::Validation(
                    "custom transcription URL must use HTTPS".into(),
                ));
            }
            if !config.api_key_configured {
                return Err(MeetingRuntimeError::Validation(
                    "custom hosted transcription requires a configured native credential".into(),
                ));
            }
            Ok(())
        }
        _ => Err(MeetingRuntimeError::Validation(
            "transcription mode must be local or custom".into(),
        )),
    }
}

fn validate_config_patch(patch: &MeetingConfigPatch) -> Result<(), MeetingRuntimeError> {
    if let Some(template) = &patch.summary_template {
        require_summary_template(template)?;
    }
    if let Some(mode) = &patch.transcription_mode {
        if !matches!(mode.as_str(), "local" | "custom") {
            return Err(MeetingRuntimeError::Validation(
                "transcription mode must be local or custom".into(),
            ));
        }
    }
    if let Some(behavior) = &patch.kg_prompt {
        if !matches!(behavior.as_str(), "ask" | "always-draft" | "never") {
            return Err(MeetingRuntimeError::Validation(
                "knowledge-graph follow-up must be ask, always-draft, or never".into(),
            ));
        }
    }
    if let Some(model) = &patch.local_model {
        require_nonempty(model, "local transcription model")?;
    }
    Ok(())
}

fn require_summary_template(value: &str) -> Result<(), MeetingRuntimeError> {
    summary_template_instructions(value).ok_or_else(|| {
        MeetingRuntimeError::Validation(
            "summary format must be standard, brief, decisions-actions, or detailed".into(),
        )
    })?;
    Ok(())
}

pub(crate) fn summary_template_instructions(value: &str) -> Option<&'static str> {
    match value {
        "standard" => Some(
            "Write a balanced meeting summary with context, decisions, action items, and open questions. Use short Markdown sections only when they improve scanning.",
        ),
        "brief" => Some(
            "Write a compact executive summary. Keep only the outcome, key decisions, named action items, and unresolved blockers.",
        ),
        "decisions-actions" => Some(
            "Prioritize decisions and action items. Use explicit Decisions, Actions, and Open questions sections; preserve owners and dates only when the transcript states them.",
        ),
        "detailed" => Some(
            "Write a detailed chronological summary that preserves important reasoning, decisions, action items, risks, disagreements, and open questions without inventing facts.",
        ),
        _ => None,
    }
}

fn validate_update_patch(patch: &MeetingUpdatePatch) -> Result<(), MeetingRuntimeError> {
    if let Some(title) = &patch.title {
        require_nonempty(title, "meeting title")?;
        if title.chars().count() > 512 {
            return Err(MeetingRuntimeError::Validation(
                "meeting title exceeds 512 characters".into(),
            ));
        }
    }
    if let Some(tags) = &patch.tags {
        if tags.len() > 64
            || tags.iter().any(|tag| {
                tag.trim().is_empty()
                    || tag.chars().count() > 80
                    || tag.len() > 160
                    || tag.chars().any(char::is_control)
            })
        {
            return Err(MeetingRuntimeError::Validation(
                "meeting tags must contain at most 64 values of 1 to 80 characters and 160 UTF-8 bytes"
                    .into(),
            ));
        }
    }
    Ok(())
}

fn stable_start_key(request: &StartMeetingRequest) -> Option<String> {
    request
        .request_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!("request:{value}"))
        .or_else(|| {
            request
                .candidate_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| format!("candidate:{value}"))
        })
        .or_else(|| {
            Some(format!(
                "request-shape:{}\u{1f}{}",
                request.title.as_deref().unwrap_or("").trim(),
                request.workspace_path.as_deref().unwrap_or("").trim(),
            ))
        })
}

fn lifecycle(status: MeetingStatus) -> &'static str {
    match status {
        MeetingStatus::Detected => "arming",
        MeetingStatus::Recording => "capturing",
        MeetingStatus::Stopping => "stopping",
        MeetingStatus::Finalizing => "finalizing",
        MeetingStatus::Completed => "ready",
        MeetingStatus::Interrupted => "interrupted",
        MeetingStatus::Failed => "failed",
        MeetingStatus::Discarded => "discarded",
    }
}

fn duration_ms(meeting: &MeetingRecord) -> u64 {
    let Some(started_at) = meeting.started_at.as_deref().and_then(parse_timestamp) else {
        return 0;
    };
    let ended_at = meeting
        .stopped_at
        .as_deref()
        .and_then(parse_timestamp)
        .or_else(|| meeting.finalized_at.as_deref().and_then(parse_timestamp))
        .unwrap_or(started_at);
    ended_at
        .signed_duration_since(started_at)
        .num_milliseconds()
        .max(0) as u64
}

fn parse_timestamp(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|value| value.with_timezone(&Utc))
}

fn metadata_string(metadata: &Value, key: &str) -> Option<String> {
    metadata
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn segment_view(
    record: &TranscriptSegmentRecord,
    channel_names: &HashMap<&str, String>,
) -> MeetingSegmentView {
    MeetingSegmentView {
        id: record.segment.id.clone(),
        text: record.segment.text.clone(),
        start_ms: record.segment.start_ms.max(0) as u64,
        end_ms: record.segment.end_ms.max(0) as u64,
        channel: record
            .segment
            .channel_id
            .as_deref()
            .and_then(|id| channel_names.get(id))
            .cloned()
            .unwrap_or_else(|| "unknown".into()),
        speaker: record.segment.speaker.clone(),
        is_final: record.segment.is_final,
        revision: record.updated_revision,
    }
}

fn gap_view(record: &TranscriptGapRecord, channel_names: &HashMap<&str, String>) -> MeetingGapView {
    MeetingGapView {
        channel: record
            .gap
            .channel_id
            .as_deref()
            .and_then(|id| channel_names.get(id))
            .cloned()
            .unwrap_or_else(|| "unknown".into()),
        start_ms: record.gap.start_ms.max(0) as u64,
        end_ms: record.gap.end_ms.max(0) as u64,
        reason: record.gap.reason.to_string(),
    }
}

fn job_view(job: &FollowUpJob) -> MeetingJobView {
    MeetingJobView {
        id: job.definition.id.clone(),
        kind: renderer_job_kind(&job.definition.kind),
        status: job.state.to_string(),
        activity_id: job
            .result
            .as_ref()
            .and_then(|result| result.get("activityId"))
            .or_else(|| job.definition.payload.get("activityId"))
            .and_then(Value::as_str)
            .map(str::to_string),
        attempt: job.attempts,
        error: job.last_error.clone(),
    }
}

fn renderer_job_kind(kind: &FollowUpJobKind) -> String {
    match kind {
        FollowUpJobKind::Summary => "title-summary".into(),
        FollowUpJobKind::KnowledgeGraph => "kg-proposal".into(),
        FollowUpJobKind::Custom(name) => name.clone(),
    }
}

fn parse_renderer_job_kind(value: &str) -> Result<FollowUpJobKind, MeetingRuntimeError> {
    match value {
        "title-summary" => Ok(FollowUpJobKind::Summary),
        "kg-proposal" => Ok(FollowUpJobKind::KnowledgeGraph),
        "transcription" => Ok(FollowUpJobKind::Custom("transcription".into())),
        _ => Err(MeetingRuntimeError::Validation(
            "job kind must be title-summary, kg-proposal, or transcription".into(),
        )),
    }
}

fn summary_state(jobs: &[FollowUpJob]) -> String {
    jobs.iter()
        .rev()
        .find(|job| job.definition.kind == FollowUpJobKind::Summary)
        .map(|job| match job.state {
            JobState::Pending => "queued",
            JobState::Running => "running",
            JobState::Succeeded => "succeeded",
            JobState::Failed => "failed",
            JobState::Cancelled => "cancelled",
        })
        .unwrap_or("not-started")
        .into()
}

fn successful_summary(jobs: &[FollowUpJob], field: &str) -> Option<String> {
    jobs.iter()
        .rev()
        .find(|job| {
            job.definition.kind == FollowUpJobKind::Summary && job.state == JobState::Succeeded
        })
        .and_then(|job| job.result.as_ref())
        .and_then(|result| result.get(field))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
}

fn summary_preview(summary: Option<&str>) -> (Option<String>, bool) {
    let Some(summary) = summary else {
        return (None, false);
    };
    let mut characters = summary.chars();
    let preview = characters
        .by_ref()
        .take(MAX_SUMMARY_PREVIEW_CHARS)
        .collect::<String>();
    let truncated = characters.next().is_some();
    (Some(preview), truncated)
}

fn kg_state(
    jobs: &[FollowUpJob],
    summary_state: &str,
    decision: Option<&str>,
    config_behavior: &str,
) -> String {
    if let Some(job) = jobs
        .iter()
        .rev()
        .find(|job| job.definition.kind == FollowUpJobKind::KnowledgeGraph)
    {
        return match job.state {
            JobState::Pending => "draft-queued",
            JobState::Running => "draft-running",
            JobState::Succeeded => "draft-ready",
            JobState::Failed => "failed",
            JobState::Cancelled => "cancelled",
        }
        .into();
    }
    match decision {
        Some("not-now") => "not-now".into(),
        Some("never") => "never".into(),
        Some("create-draft") => "draft-queued".into(),
        _ if summary_state == "succeeded" && config_behavior == "ask" => "awaiting-decision".into(),
        _ => "not-offered".into(),
    }
}

fn require_nonempty(value: &str, label: &str) -> Result<(), MeetingRuntimeError> {
    if value.trim().is_empty() {
        return Err(MeetingRuntimeError::Validation(format!(
            "{label} cannot be empty"
        )));
    }
    Ok(())
}

fn deserialize_nullable_patch<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

fn port_error(operation: &'static str, message: String) -> MeetingRuntimeError {
    MeetingRuntimeError::Port {
        operation,
        message: bounded_error(&message),
    }
}

fn bounded_error(value: &str) -> String {
    value.chars().take(4_096).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meetings::{TranscriptChange, TranscriptSegmentInput};
    use std::collections::BTreeMap;
    use std::{sync::Barrier, thread};

    const NOW: &str = "2026-07-30T10:00:00.000Z";
    const LEASE_END: &str = "2026-07-30T10:05:00.000Z";

    #[derive(Default)]
    struct FakeCapture {
        starts: Mutex<Vec<CaptureStart>>,
        stops: Mutex<Vec<CaptureStop>>,
        mute_changes: Mutex<Vec<(String, String, bool)>>,
        recoveries: Mutex<Vec<RecoveryReport>>,
        fail_start: Mutex<Option<String>>,
    }

    impl MeetingCapturePort for FakeCapture {
        fn recover(&self, report: &RecoveryReport) -> Result<(), String> {
            self.recoveries.lock().unwrap().push(report.clone());
            Ok(())
        }

        fn start(&self, request: &CaptureStart) -> Result<(), String> {
            if let Some(error) = self.fail_start.lock().unwrap().clone() {
                return Err(error);
            }
            self.starts.lock().unwrap().push(request.clone());
            Ok(())
        }

        fn stop(&self, request: &CaptureStop) -> Result<CaptureStopResult, String> {
            self.stops.lock().unwrap().push(request.clone());
            Ok(CaptureStopResult {
                duration_ms: 42_000,
            })
        }

        fn set_microphone_muted(
            &self,
            meeting_id: &str,
            run_id: &str,
            muted: bool,
        ) -> Result<(), String> {
            self.mute_changes
                .lock()
                .unwrap()
                .push((meeting_id.into(), run_id.into(), muted));
            Ok(())
        }
    }

    struct ReconnectGapOnStopCapture {
        store: Arc<MeetingStore>,
    }

    impl MeetingCapturePort for ReconnectGapOnStopCapture {
        fn recover(&self, _report: &RecoveryReport) -> Result<(), String> {
            Ok(())
        }

        fn start(&self, _request: &CaptureStart) -> Result<(), String> {
            Ok(())
        }

        fn stop(&self, request: &CaptureStop) -> Result<CaptureStopResult, String> {
            let meeting = self
                .store
                .get_meeting(&request.meeting_id)
                .map_err(|error| error.to_string())?;
            self.store
                .apply_transcript_batch(&TranscriptBatch {
                    meeting_id: request.meeting_id.clone(),
                    batch_id: format!("reconnect-gap-{}", request.run_id),
                    base_revision: meeting.transcript_revision,
                    source: "native-capture".into(),
                    observed_at: NOW.into(),
                    marks_final: false,
                    changes: vec![TranscriptChange::OpenGap {
                        gap: crate::meetings::TranscriptGapInput {
                            id: "microphone-reconnect-gap".into(),
                            start_ms: 40_000,
                            end_ms: 42_000,
                            reason: crate::meetings::TranscriptGapReason::DeviceChanged,
                            channel_id: Some("microphone".into()),
                            detail: Some(
                                "capture stopped while audio devices were reconnecting".into(),
                            ),
                        },
                    }],
                })
                .map_err(|error| error.to_string())?;
            Ok(CaptureStopResult {
                duration_ms: 42_000,
            })
        }

        fn set_microphone_muted(
            &self,
            _meeting_id: &str,
            _run_id: &str,
            _muted: bool,
        ) -> Result<(), String> {
            Ok(())
        }
    }

    struct PromotingRecoveryCapture {
        store: Arc<MeetingStore>,
    }

    impl MeetingCapturePort for PromotingRecoveryCapture {
        fn recover(&self, report: &RecoveryReport) -> Result<(), String> {
            for chunk in &report.staged_audio_chunks {
                self.store
                    .commit_audio_chunk(&chunk.definition.id, NOW)
                    .map_err(|error| error.to_string())?;
            }
            Ok(())
        }

        fn start(&self, _request: &CaptureStart) -> Result<(), String> {
            Ok(())
        }

        fn stop(&self, _request: &CaptureStop) -> Result<CaptureStopResult, String> {
            Ok(CaptureStopResult::default())
        }

        fn set_microphone_muted(
            &self,
            _meeting_id: &str,
            _run_id: &str,
            _muted: bool,
        ) -> Result<(), String> {
            Ok(())
        }
    }

    #[derive(Default)]
    struct EndedWorkerCapture {
        starts: Mutex<Vec<CaptureStart>>,
        stops: Mutex<Vec<CaptureStop>>,
    }

    impl MeetingCapturePort for EndedWorkerCapture {
        fn recover(&self, _report: &RecoveryReport) -> Result<(), String> {
            Ok(())
        }

        fn start(&self, request: &CaptureStart) -> Result<(), String> {
            self.starts.lock().unwrap().push(request.clone());
            Ok(())
        }

        fn stop(&self, request: &CaptureStop) -> Result<CaptureStopResult, String> {
            self.stops.lock().unwrap().push(request.clone());
            Err("capture worker already ended after a durable chunk failure".into())
        }

        fn set_microphone_muted(
            &self,
            _meeting_id: &str,
            _run_id: &str,
            _muted: bool,
        ) -> Result<(), String> {
            Ok(())
        }
    }

    #[derive(Default)]
    struct FakeTranscription {
        starts: Mutex<Vec<TranscriptionStart>>,
        finalizes: Mutex<Vec<TranscriptionFinalize>>,
    }

    impl MeetingTranscriptionPort for FakeTranscription {
        fn start(&self, request: &TranscriptionStart) -> Result<(), String> {
            self.starts.lock().unwrap().push(request.clone());
            Ok(())
        }

        fn finalize(&self, request: &TranscriptionFinalize) -> Result<TranscriptBatch, String> {
            self.finalizes.lock().unwrap().push(request.clone());
            Ok(TranscriptBatch {
                meeting_id: request.meeting_id.clone(),
                batch_id: format!("final-{}", request.run_id),
                base_revision: request.base_revision,
                source: "fake-stt".into(),
                observed_at: request.observed_at.clone(),
                marks_final: true,
                changes: vec![TranscriptChange::UpsertSegment {
                    segment: TranscriptSegmentInput {
                        id: "segment-1".into(),
                        start_ms: 0,
                        end_ms: 4_000,
                        text: "Production readiness is a release requirement.".into(),
                        channel_id: Some("microphone".into()),
                        speaker: Some("Speaker 1".into()),
                        confidence: Some(0.98),
                        is_final: true,
                        metadata: json!({}),
                    },
                }],
            })
        }
    }

    struct EmptyTranscription;

    impl MeetingTranscriptionPort for EmptyTranscription {
        fn start(&self, _request: &TranscriptionStart) -> Result<(), String> {
            Ok(())
        }

        fn finalize(&self, request: &TranscriptionFinalize) -> Result<TranscriptBatch, String> {
            Ok(TranscriptBatch {
                meeting_id: request.meeting_id.clone(),
                batch_id: format!("empty-final-{}", request.run_id),
                base_revision: request.base_revision,
                source: "silent-stt".into(),
                observed_at: request.observed_at.clone(),
                marks_final: true,
                changes: Vec::new(),
            })
        }
    }

    struct FailureOrderingTranscription {
        store: Arc<MeetingStore>,
        events: Arc<FakeEvents>,
        observed_interrupted_before_finalize: Mutex<bool>,
    }

    impl MeetingTranscriptionPort for FailureOrderingTranscription {
        fn start(&self, _request: &TranscriptionStart) -> Result<(), String> {
            Ok(())
        }

        fn finalize(&self, request: &TranscriptionFinalize) -> Result<TranscriptBatch, String> {
            let durable = self
                .store
                .get_meeting(&request.meeting_id)
                .map_err(|error| error.to_string())?;
            let event_was_published = self
                .events
                .published
                .lock()
                .map_err(|_| "test event mutex was poisoned".to_string())?
                .iter()
                .any(|event| event.kind == "capture-runtime-failed");
            *self
                .observed_interrupted_before_finalize
                .lock()
                .map_err(|_| "test observation mutex was poisoned".to_string())? =
                durable.status == MeetingStatus::Interrupted && event_was_published;
            Ok(TranscriptBatch {
                meeting_id: request.meeting_id.clone(),
                batch_id: format!("failure-terminal-{}", request.run_id),
                base_revision: request.base_revision,
                source: "failure-ordering-stt".into(),
                observed_at: request.observed_at.clone(),
                marks_final: true,
                changes: Vec::new(),
            })
        }
    }

    #[derive(Default)]
    struct AlwaysFailTranscription {
        starts: Mutex<Vec<TranscriptionStart>>,
        finalizes: Mutex<Vec<TranscriptionFinalize>>,
    }

    #[derive(Default)]
    struct SessionOwningFailTranscription {
        active: Mutex<bool>,
        starts: Mutex<Vec<TranscriptionStart>>,
        finalizes: Mutex<Vec<TranscriptionFinalize>>,
    }

    impl MeetingTranscriptionPort for SessionOwningFailTranscription {
        fn start(&self, request: &TranscriptionStart) -> Result<(), String> {
            let mut active = self.active.lock().unwrap();
            if *active {
                return Err("meeting already owns a transcription worker".into());
            }
            *active = true;
            self.starts.lock().unwrap().push(request.clone());
            Ok(())
        }

        fn finalize(&self, request: &TranscriptionFinalize) -> Result<TranscriptBatch, String> {
            self.finalizes.lock().unwrap().push(request.clone());
            *self.active.lock().unwrap() = false;
            Err("provider worker ended before its terminal batch".into())
        }
    }

    impl MeetingTranscriptionPort for AlwaysFailTranscription {
        fn start(&self, request: &TranscriptionStart) -> Result<(), String> {
            self.starts.lock().unwrap().push(request.clone());
            Ok(())
        }

        fn finalize(&self, request: &TranscriptionFinalize) -> Result<TranscriptBatch, String> {
            self.finalizes.lock().unwrap().push(request.clone());
            Err("provider worker ended before its terminal batch".into())
        }
    }

    struct DrainingTranscription {
        store: Arc<MeetingStore>,
    }

    impl MeetingTranscriptionPort for DrainingTranscription {
        fn start(&self, _request: &TranscriptionStart) -> Result<(), String> {
            Ok(())
        }

        fn finalize(&self, request: &TranscriptionFinalize) -> Result<TranscriptBatch, String> {
            let tail = TranscriptBatch {
                meeting_id: request.meeting_id.clone(),
                batch_id: format!("tail-{}", request.run_id),
                base_revision: request.base_revision,
                source: "draining-stt".into(),
                observed_at: request.observed_at.clone(),
                marks_final: false,
                changes: vec![TranscriptChange::UpsertSegment {
                    segment: TranscriptSegmentInput {
                        id: "drained-segment".into(),
                        start_ms: 0,
                        end_ms: 1_000,
                        text: "The acknowledged provider tail is durable.".into(),
                        channel_id: Some("system".into()),
                        speaker: Some("Them".into()),
                        confidence: Some(0.95),
                        is_final: true,
                        metadata: json!({}),
                    },
                }],
            };
            let applied = self
                .store
                .apply_transcript_batch(&tail)
                .map_err(|error| error.to_string())?;
            Ok(TranscriptBatch {
                meeting_id: request.meeting_id.clone(),
                batch_id: format!("terminal-{}", request.run_id),
                base_revision: applied.revision,
                source: "draining-stt".into(),
                observed_at: request.observed_at.clone(),
                marks_final: true,
                changes: Vec::new(),
            })
        }
    }

    struct AuthorityCheckingCapture {
        store: Arc<MeetingStore>,
        observed_status: Mutex<Option<MeetingStatus>>,
    }

    impl MeetingCapturePort for AuthorityCheckingCapture {
        fn recover(&self, _report: &RecoveryReport) -> Result<(), String> {
            Ok(())
        }

        fn start(&self, request: &CaptureStart) -> Result<(), String> {
            let status = self
                .store
                .get_meeting(&request.meeting_id)
                .map_err(|error| error.to_string())?
                .status;
            *self.observed_status.lock().unwrap() = Some(status);
            Ok(())
        }

        fn stop(&self, _request: &CaptureStop) -> Result<CaptureStopResult, String> {
            Ok(CaptureStopResult::default())
        }

        fn set_microphone_muted(
            &self,
            _meeting_id: &str,
            _run_id: &str,
            _muted: bool,
        ) -> Result<(), String> {
            Ok(())
        }
    }

    struct FakePlatformState {
        projection: MeetingPlatformProjection,
        contents: BTreeMap<String, MeetingContentProjection>,
        exports: Vec<(String, MeetingExportFormat)>,
        deleted: Vec<(String, MeetingDeleteMode)>,
        fail_export: Option<String>,
        fail_model_install: Option<String>,
        dismissed_candidates: Vec<String>,
    }

    struct FakePlatform {
        state: Mutex<FakePlatformState>,
    }

    impl Default for FakePlatform {
        fn default() -> Self {
            Self {
                state: Mutex::new(FakePlatformState {
                    projection: MeetingPlatformProjection {
                        config: MeetingConfig::default(),
                        permissions: MeetingPermissions {
                            microphone: "granted".into(),
                            system_audio: "granted".into(),
                        },
                        candidates: Vec::new(),
                        models: Vec::new(),
                        diagnostic: None,
                    },
                    contents: BTreeMap::new(),
                    exports: Vec::new(),
                    deleted: Vec::new(),
                    fail_export: None,
                    fail_model_install: None,
                    dismissed_candidates: Vec::new(),
                }),
            }
        }
    }

    impl MeetingPlatformPort for FakePlatform {
        fn projection(&self) -> Result<MeetingPlatformProjection, String> {
            Ok(self.state.lock().unwrap().projection.clone())
        }

        fn dismiss_candidate(&self, candidate_id: &str) -> Result<(), String> {
            self.state
                .lock()
                .unwrap()
                .dismissed_candidates
                .push(candidate_id.into());
            Ok(())
        }

        fn content(&self, meeting_id: &str) -> Result<MeetingContentProjection, String> {
            Ok(self
                .state
                .lock()
                .unwrap()
                .contents
                .get(meeting_id)
                .cloned()
                .unwrap_or_default())
        }

        fn update_config(&self, patch: &MeetingConfigPatch) -> Result<(), String> {
            let mut state = self.state.lock().unwrap();
            let config = &mut state.projection.config;
            if let Some(value) = patch.detection_enabled {
                config.detection_enabled = value;
            }
            if let Some(value) = patch.auto_record {
                config.auto_record = value;
            }
            if let Some(value) = &patch.transcription_mode {
                config.transcription_mode = value.clone();
            }
            if let Some(value) = &patch.custom_url {
                config.custom_url = value.clone();
            }
            if let Some(value) = &patch.custom_model {
                config.custom_model = value.clone();
            }
            if let Some(value) = &patch.local_model {
                config.local_model = value.clone();
            }
            if let Some(value) = patch.summary_enabled {
                config.summary_enabled = value;
            }
            if let Some(value) = &patch.summary_template {
                config.summary_template = value.clone();
            }
            if let Some(value) = &patch.summary_preset {
                config.summary_preset = value.clone();
            }
            if let Some(value) = &patch.kg_prompt {
                config.kg_prompt = value.clone();
            }
            if let Some(value) = &patch.kg_preset {
                config.kg_preset = value.clone();
            }
            if let Some(value) = patch.retention_days {
                config.retention_days = value;
            }
            Ok(())
        }

        fn set_api_key(&self, _api_key: &str) -> Result<(), String> {
            self.state
                .lock()
                .unwrap()
                .projection
                .config
                .api_key_configured = true;
            Ok(())
        }

        fn clear_api_key(&self) -> Result<(), String> {
            self.state
                .lock()
                .unwrap()
                .projection
                .config
                .api_key_configured = false;
            Ok(())
        }

        fn install_model(&self, model_id: &str) -> Result<(), String> {
            let mut state = self.state.lock().unwrap();
            if let Some(error) = state.fail_model_install.clone() {
                return Err(error);
            }
            state.projection.models.push(MeetingModel {
                id: model_id.into(),
                title: model_id.into(),
                status: "installed".into(),
                bytes: 1,
                downloaded_bytes: 1,
                checksum: Some("verified".into()),
                error: None,
            });
            Ok(())
        }

        fn delete_model(&self, model_id: &str) -> Result<(), String> {
            self.state
                .lock()
                .unwrap()
                .projection
                .models
                .retain(|model| model.id != model_id);
            Ok(())
        }

        fn update_content(
            &self,
            meeting_id: &str,
            patch: &MeetingUpdatePatch,
        ) -> Result<(), String> {
            let mut state = self.state.lock().unwrap();
            let content = state.contents.entry(meeting_id.into()).or_default();
            if let Some(value) = &patch.title {
                content.title = Some(value.clone());
            }
            if let Some(value) = &patch.summary {
                content.summary = Some(value.clone());
            }
            if let Some(value) = &patch.tags {
                content.tags = value.clone();
            }
            Ok(())
        }

        fn set_kg_decision(&self, meeting_id: &str, decision: &str) -> Result<(), String> {
            self.state
                .lock()
                .unwrap()
                .contents
                .entry(meeting_id.into())
                .or_default()
                .kg_decision = Some(decision.into());
            Ok(())
        }

        fn delete_meeting(&self, meeting_id: &str, mode: MeetingDeleteMode) -> Result<(), String> {
            let mut state = self.state.lock().unwrap();
            state.deleted.push((meeting_id.into(), mode));
            if mode == MeetingDeleteMode::All {
                state.contents.entry(meeting_id.into()).or_default().deleted = true;
            }
            Ok(())
        }

        fn export_meeting(
            &self,
            meeting_id: &str,
            format: MeetingExportFormat,
        ) -> Result<MeetingExport, String> {
            let mut state = self.state.lock().unwrap();
            if let Some(error) = state.fail_export.clone() {
                return Err(error);
            }
            state.exports.push((meeting_id.into(), format));
            Ok(MeetingExport {
                format: match format {
                    MeetingExportFormat::Markdown => "markdown",
                    MeetingExportFormat::Json => "json",
                    MeetingExportFormat::Audio => "audio",
                }
                .into(),
                path: format!("/tmp/{meeting_id}.export"),
            })
        }
    }

    #[derive(Default)]
    struct FakeEvents {
        published: Mutex<Vec<MeetingEvent>>,
    }

    impl MeetingEventSink for FakeEvents {
        fn publish(&self, event: &MeetingEvent) -> Result<(), String> {
            self.published.lock().unwrap().push(event.clone());
            Ok(())
        }
    }

    struct FakeClock;

    impl MeetingClock for FakeClock {
        fn now(&self) -> String {
            NOW.into()
        }
    }

    struct Fixture {
        runtime: MeetingRuntime,
        store: Arc<MeetingStore>,
        capture: Arc<FakeCapture>,
        transcription: Arc<FakeTranscription>,
        platform: Arc<FakePlatform>,
        events: Arc<FakeEvents>,
    }

    fn make_fixture() -> Fixture {
        let store = Arc::new(MeetingStore::open_in_memory().unwrap());
        let capture = Arc::new(FakeCapture::default());
        let transcription = Arc::new(FakeTranscription::default());
        let platform = Arc::new(FakePlatform::default());
        let events = Arc::new(FakeEvents::default());
        let runtime = MeetingRuntime::new(
            Arc::clone(&store),
            capture.clone(),
            transcription.clone(),
            platform.clone(),
            Arc::new(FakeClock),
            events.clone(),
        )
        .unwrap();
        Fixture {
            runtime,
            store,
            capture,
            transcription,
            platform,
            events,
        }
    }

    fn start_request(runtime: &MeetingRuntime, request_id: &str) -> StartMeetingRequest {
        start_request_for_candidate(runtime, request_id, None)
    }

    fn start_request_for_candidate(
        runtime: &MeetingRuntime,
        request_id: &str,
        candidate_id: Option<&str>,
    ) -> StartMeetingRequest {
        StartMeetingRequest {
            request_id: Some(request_id.into()),
            title: Some("Release review".into()),
            workspace_path: Some("/workspace".into()),
            candidate_id: candidate_id.map(str::to_string),
            consent_token: None,
            authorized_consent: Some(runtime.start_consent_context(candidate_id).unwrap()),
        }
    }

    #[test]
    fn explicit_consent_single_active_and_idempotent_controls() {
        let fixture = make_fixture();
        let forged: StartMeetingRequest = serde_json::from_value(json!({
            "requestId": "forged",
            "consentToken": "renderer-controlled",
            "authorizedConsent": {
                "transcriptionMode": "local",
                "model": "whisper-small"
            }
        }))
        .unwrap();
        assert!(forged.authorized_consent.is_none());
        assert!(matches!(
            fixture.runtime.start(forged).unwrap_err(),
            MeetingRuntimeError::ConsentRequired
        ));

        let error = fixture
            .runtime
            .start(StartMeetingRequest {
                authorized_consent: None,
                ..start_request(&fixture.runtime, "without-consent")
            })
            .unwrap_err();
        assert!(matches!(error, MeetingRuntimeError::ConsentRequired));
        assert!(fixture.capture.starts.lock().unwrap().is_empty());

        let context_fixture = make_fixture();
        let authorized = start_request(&context_fixture.runtime, "changed-context");
        context_fixture
            .platform
            .state
            .lock()
            .unwrap()
            .projection
            .config
            .local_model = "whisper-medium".into();
        assert!(matches!(
            context_fixture.runtime.start(authorized).unwrap_err(),
            MeetingRuntimeError::ConsentContextChanged
        ));
        assert!(context_fixture.capture.starts.lock().unwrap().is_empty());

        let first = fixture
            .runtime
            .start(start_request(&fixture.runtime, "request-1"))
            .unwrap();
        let meeting_id = first.active_meeting_id.clone().unwrap();
        let durable = fixture.store.get_meeting(&meeting_id).unwrap();
        assert_eq!(durable.metadata["transcriptionRoute"], "local");
        assert_eq!(durable.metadata["transcriptionModel"], "whisper-small");
        assert_eq!(
            fixture.transcription.starts.lock().unwrap()[0].route,
            "local"
        );
        let duplicate = fixture
            .runtime
            .start(start_request(&fixture.runtime, "request-1"))
            .unwrap();
        assert_eq!(
            duplicate.active_meeting_id.as_deref(),
            Some(meeting_id.as_str())
        );
        assert_eq!(fixture.capture.starts.lock().unwrap().len(), 1);

        let error = fixture
            .runtime
            .start(start_request(&fixture.runtime, "request-2"))
            .unwrap_err();
        assert!(matches!(error, MeetingRuntimeError::ActiveMeeting { .. }));

        let muted = fixture
            .runtime
            .set_microphone_muted(&meeting_id, true)
            .unwrap();
        let duplicate_mute = fixture
            .runtime
            .set_microphone_muted(&meeting_id, true)
            .unwrap();
        assert!(muted.meetings[0].mic_muted);
        assert_eq!(duplicate_mute.revision, muted.revision);
        assert_eq!(fixture.capture.mute_changes.lock().unwrap().len(), 1);

        // The current renderer does not supply requestId, so an identical
        // service request still has to be idempotent.
        let service_fixture = make_fixture();
        let service_request = StartMeetingRequest {
            request_id: None,
            ..start_request(&service_fixture.runtime, "ignored")
        };
        let first = service_fixture
            .runtime
            .start(service_request.clone())
            .unwrap();
        let duplicate = service_fixture.runtime.start(service_request).unwrap();
        assert_eq!(duplicate.active_meeting_id, first.active_meeting_id);
        assert_eq!(service_fixture.capture.starts.lock().unwrap().len(), 1);
    }

    #[test]
    fn detected_start_rejects_stale_candidates_and_suppresses_the_accepted_prompt() {
        let fixture = make_fixture();
        fixture.platform.state.lock().unwrap().projection.candidates = vec![MeetingCandidate {
            id: "candidate-zoom".into(),
            app_id: "us.zoom.xos".into(),
            app_name: "Zoom".into(),
            detected_at: None,
            confidence: 0.95,
        }];

        let stale = fixture
            .runtime
            .start(StartMeetingRequest {
                candidate_id: Some("missing".into()),
                ..start_request(&fixture.runtime, "stale-candidate")
            })
            .unwrap_err();
        assert!(stale.to_string().contains("no longer available"));

        let started = fixture
            .runtime
            .start(start_request_for_candidate(
                &fixture.runtime,
                "accepted-candidate",
                Some("candidate-zoom"),
            ))
            .unwrap();
        assert!(started.candidates.is_empty());
        assert_eq!(
            fixture
                .platform
                .state
                .lock()
                .unwrap()
                .dismissed_candidates
                .clone(),
            vec!["candidate-zoom"]
        );
    }

    #[test]
    fn listener_is_installed_before_snapshot_and_event_revisions_are_monotonic() {
        let fixture = make_fixture();
        let base = fixture.runtime.snapshot().unwrap();
        assert_eq!(base.revision, 0);

        let started = fixture
            .runtime
            .start(start_request(&fixture.runtime, "ordered"))
            .unwrap();
        let events = fixture.events.published.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert!(events[0].revision > base.revision);
        assert_eq!(events[0].revision, started.revision);
        assert!(events[0].snapshot.is_none());
        assert!(
            serde_json::to_vec(&events[0]).unwrap().len() < 512,
            "meeting invalidation event exceeded its 512-byte payload budget"
        );
        drop(events);

        let reconciled = fixture.runtime.snapshot().unwrap();
        assert_eq!(reconciled.revision, started.revision);
        assert_eq!(reconciled.active_meeting_id, started.active_meeting_id);
    }

    #[test]
    fn library_and_summary_projections_have_explicit_payload_budgets() {
        let fixture = make_fixture();
        for index in 0..=DEFAULT_MEETING_LIMIT {
            fixture
                .store
                .create_meeting(
                    &MeetingDraft {
                        id: format!("scale-{index:03}"),
                        title: format!("Meeting {index}"),
                        origin: MeetingOrigin::default(),
                        channels: Vec::new(),
                        metadata: json!({}),
                    },
                    NOW,
                )
                .unwrap();
        }
        fixture
            .platform
            .state
            .lock()
            .unwrap()
            .contents
            .entry("scale-200".into())
            .or_default()
            .summary = Some("s".repeat(100_000));

        let snapshot = fixture.runtime.snapshot().unwrap();
        assert_eq!(snapshot.meetings.len(), DEFAULT_MEETING_LIMIT as usize);
        assert!(snapshot.meetings_truncated);
        let meeting = snapshot
            .meetings
            .iter()
            .find(|meeting| meeting.id == "scale-200")
            .unwrap();
        assert_eq!(
            meeting.summary.as_deref().unwrap().chars().count(),
            MAX_SUMMARY_PREVIEW_CHARS
        );
        assert!(meeting.summary_truncated);
        assert!(
            serde_json::to_vec(&snapshot).unwrap().len() < 256 * 1024,
            "200-row meeting library exceeded its 256 KiB payload budget"
        );

        let detail = fixture
            .runtime
            .transcript_page("scale-200", None, None)
            .unwrap();
        assert_eq!(detail.summary.unwrap().len(), 100_000);
    }

    #[test]
    fn real_time_batches_reject_stale_runs_and_are_idempotent() {
        let fixture = make_fixture();
        let started = fixture
            .runtime
            .start(start_request(&fixture.runtime, "live-batch"))
            .unwrap();
        let meeting_id = started.active_meeting_id.unwrap();
        let run_id = fixture.capture.starts.lock().unwrap()[0].run_id.clone();
        let batch = TranscriptBatch {
            meeting_id: meeting_id.clone(),
            batch_id: "live-1".into(),
            base_revision: 0,
            source: "fake-live-stt".into(),
            observed_at: NOW.into(),
            marks_final: false,
            changes: vec![TranscriptChange::UpsertSegment {
                segment: TranscriptSegmentInput {
                    id: "live-segment".into(),
                    start_ms: 0,
                    end_ms: 1_000,
                    text: "partial".into(),
                    channel_id: Some("microphone".into()),
                    speaker: None,
                    confidence: Some(0.8),
                    is_final: false,
                    metadata: json!({
                        "transcriptionRoute": "local",
                        "transcriptionModel": "whisper-small"
                    }),
                },
            }],
        };

        let error = fixture
            .runtime
            .ingest_transcript_batch("stale-run", batch.clone())
            .unwrap_err();
        assert!(error.to_string().contains("stale"));

        let applied = fixture
            .runtime
            .ingest_transcript_batch(&run_id, batch.clone())
            .unwrap();
        let duplicate = fixture
            .runtime
            .ingest_transcript_batch(&run_id, batch)
            .unwrap();
        let meeting = applied
            .meetings
            .iter()
            .find(|meeting| meeting.id == meeting_id)
            .unwrap();
        assert_eq!(meeting.transcript_revision, 1);
        assert!(meeting.segments.is_empty());
        let page = fixture
            .runtime
            .transcript_page(&meeting_id, None, None)
            .unwrap();
        assert_eq!(page.segments[0].text, "partial");
        assert!(!page.segments[0].is_final);
        assert_eq!(duplicate.revision, applied.revision);
        assert_eq!(fixture.events.published.lock().unwrap().len(), 2);
    }

    #[test]
    fn stop_finalizes_transcript_then_summary_then_offers_and_queues_kg() {
        let fixture = make_fixture();
        let started = fixture
            .runtime
            .start(start_request(&fixture.runtime, "complete-flow"))
            .unwrap();
        let meeting_id = started.active_meeting_id.unwrap();

        let stopped = fixture.runtime.stop(&meeting_id).unwrap();
        let meeting = stopped
            .meetings
            .iter()
            .find(|meeting| meeting.id == meeting_id)
            .unwrap();
        assert_eq!(meeting.lifecycle, "ready");
        assert_eq!(meeting.transcription, "final");
        assert!(meeting.transcript_final);
        assert!(meeting.segments.is_empty());
        assert_eq!(
            fixture
                .runtime
                .transcript_page(&meeting_id, None, None)
                .unwrap()
                .segments
                .len(),
            1
        );
        assert_eq!(meeting.summary_state, "queued");
        assert_eq!(meeting.kg_state, "not-offered");
        assert_eq!(meeting.jobs[0].kind, "title-summary");

        let duplicate_stop = fixture.runtime.stop(&meeting_id).unwrap();
        assert_eq!(duplicate_stop.revision, stopped.revision);
        assert_eq!(fixture.capture.stops.lock().unwrap().len(), 1);
        assert_eq!(fixture.store.list_jobs(&meeting_id).unwrap().len(), 1);

        let summary_job = fixture
            .runtime
            .claim_next_job("summary-worker", LEASE_END)
            .unwrap()
            .unwrap();
        let lease_token = summary_job.lease_token.clone().unwrap();
        let summarized = fixture
            .runtime
            .finish_job(
                &summary_job.definition.id,
                &lease_token,
                JobFinish::Succeeded {
                    result: json!({
                        "title": "Release readiness",
                        "summary": "The team made production readiness a release gate."
                    }),
                },
            )
            .unwrap();
        let meeting = summarized
            .meetings
            .iter()
            .find(|meeting| meeting.id == meeting_id)
            .unwrap();
        assert_eq!(meeting.title, "Release review");
        assert_eq!(
            meeting.summary.as_deref(),
            Some("The team made production readiness a release gate.")
        );
        assert_eq!(meeting.summary_state, "succeeded");
        assert_eq!(meeting.kg_state, "awaiting-decision");

        let proposed = fixture
            .runtime
            .decide_kg(&meeting_id, "create-draft")
            .unwrap();
        let meeting = proposed
            .meetings
            .iter()
            .find(|meeting| meeting.id == meeting_id)
            .unwrap();
        assert_eq!(meeting.kg_state, "draft-queued");
        assert_eq!(meeting.jobs.len(), 2);
        assert!(meeting.jobs.iter().any(|job| job.kind == "kg-proposal"));

        let duplicate = fixture
            .runtime
            .decide_kg(&meeting_id, "create-draft")
            .unwrap();
        let meeting = duplicate
            .meetings
            .iter()
            .find(|meeting| meeting.id == meeting_id)
            .unwrap();
        assert_eq!(meeting.jobs.len(), 2);
    }

    #[test]
    fn stop_refreshes_revision_after_capture_records_reconnect_gap() {
        let store = Arc::new(MeetingStore::open_in_memory().unwrap());
        let capture = Arc::new(ReconnectGapOnStopCapture {
            store: Arc::clone(&store),
        });
        let runtime = MeetingRuntime::new(
            Arc::clone(&store),
            capture,
            Arc::new(FakeTranscription::default()),
            Arc::new(FakePlatform::default()),
            Arc::new(FakeClock),
            Arc::new(FakeEvents::default()),
        )
        .unwrap();
        let started = runtime
            .start(start_request(&runtime, "stop-during-reconnect"))
            .unwrap();
        let meeting_id = started.active_meeting_id.unwrap();

        let stopped = runtime
            .stop(&meeting_id)
            .expect("Stop must refresh revisions committed while capture joins");

        let meeting = store.get_meeting(&meeting_id).unwrap();
        assert_eq!(meeting.status, MeetingStatus::Completed);
        assert_eq!(stopped.active_meeting_id, None);
        let overview = store.transcript_overview(&meeting_id, 10).unwrap();
        assert!(overview.is_final);
        assert_eq!(overview.unresolved_gap_count, 1);
        assert_eq!(overview.gaps[0].gap.id, "microphone-reconnect-gap");
    }

    #[test]
    fn repeated_manual_job_retries_receive_monotonic_idempotency_generations() {
        let fixture = make_fixture();
        let started = fixture
            .runtime
            .start(start_request(&fixture.runtime, "manual-retry-generations"))
            .unwrap();
        let meeting_id = started.active_meeting_id.unwrap();
        fixture.runtime.stop(&meeting_id).unwrap();

        for expected_generation in 1..=2 {
            let claimed = fixture
                .store
                .claim_next_job("retry-worker", NOW, LEASE_END)
                .unwrap()
                .unwrap();
            fixture
                .store
                .finish_job(
                    &claimed.definition.id,
                    claimed.lease_token.as_deref().unwrap(),
                    &JobFinish::Failed {
                        error: "agent unavailable".into(),
                        retryable: false,
                        retry_at: None,
                    },
                    NOW,
                )
                .unwrap();
            fixture
                .runtime
                .retry_job(&meeting_id, "title-summary")
                .unwrap();
            let retry_key = format!("{meeting_id}:title-summary:retry:{expected_generation}");
            assert!(fixture
                .store
                .list_jobs(&meeting_id)
                .unwrap()
                .iter()
                .any(|job| job.definition.idempotency_key == retry_key));
        }
    }

    #[test]
    fn completed_summary_can_run_again_with_the_current_template_and_agent_preset() {
        let fixture = make_fixture();
        let started = fixture
            .runtime
            .start(start_request(&fixture.runtime, "regenerate-summary"))
            .unwrap();
        let meeting_id = started.active_meeting_id.unwrap();
        fixture.runtime.stop(&meeting_id).unwrap();
        let claimed = fixture
            .store
            .claim_next_job("summary-worker", NOW, LEASE_END)
            .unwrap()
            .unwrap();
        fixture
            .store
            .finish_job(
                &claimed.definition.id,
                claimed.lease_token.as_deref().unwrap(),
                &JobFinish::Succeeded {
                    result: json!({"title": "Original", "summary": "Original summary"}),
                },
                NOW,
            )
            .unwrap();
        fixture
            .runtime
            .update_config(MeetingConfigPatch {
                summary_template: Some("decisions-actions".into()),
                summary_preset: Some("codex-review".into()),
                ..MeetingConfigPatch::default()
            })
            .unwrap();

        fixture
            .runtime
            .retry_job(&meeting_id, "title-summary")
            .unwrap();

        let jobs = fixture.store.list_jobs(&meeting_id).unwrap();
        let rerun = jobs
            .iter()
            .find(|job| {
                job.definition
                    .idempotency_key
                    .ends_with("title-summary:retry:1")
            })
            .unwrap();
        assert_eq!(rerun.definition.payload["template"], "decisions-actions");
        assert_eq!(rerun.definition.payload["preset"], "codex-review");
        assert!(rerun
            .definition
            .idempotency_key
            .ends_with("title-summary:retry:1"));
    }

    #[test]
    fn silent_terminal_meeting_completes_without_summary_job() {
        let store = Arc::new(MeetingStore::open_in_memory().unwrap());
        let runtime = MeetingRuntime::new(
            Arc::clone(&store),
            Arc::new(FakeCapture::default()),
            Arc::new(EmptyTranscription),
            Arc::new(FakePlatform::default()),
            Arc::new(FakeClock),
            Arc::new(FakeEvents::default()),
        )
        .unwrap();
        let started = runtime
            .start(start_request(&runtime, "silent-meeting"))
            .unwrap();
        let meeting_id = started.active_meeting_id.unwrap();

        runtime.stop(&meeting_id).unwrap();

        let meeting = runtime.meeting(&meeting_id).unwrap();
        assert_eq!(meeting.lifecycle, "ready");
        assert_eq!(
            store.get_meeting(&meeting_id).unwrap().status,
            MeetingStatus::Completed
        );
        assert!(meeting.transcript_final);
        assert!(meeting.transcript_all_final);
        assert_eq!(meeting.segment_count, 0);
        assert!(!store
            .list_jobs(&meeting_id)
            .unwrap()
            .iter()
            .any(|job| job.definition.kind == FollowUpJobKind::Summary));
    }

    #[test]
    fn stop_accepts_a_terminal_marker_after_the_provider_durably_drains_its_tail() {
        let store = Arc::new(MeetingStore::open_in_memory().unwrap());
        let runtime = MeetingRuntime::new(
            Arc::clone(&store),
            Arc::new(FakeCapture::default()),
            Arc::new(DrainingTranscription {
                store: Arc::clone(&store),
            }),
            Arc::new(FakePlatform::default()),
            Arc::new(FakeClock),
            Arc::new(FakeEvents::default()),
        )
        .unwrap();
        let started = runtime
            .start(start_request(&runtime, "provider-tail"))
            .unwrap();
        let meeting_id = started.active_meeting_id.unwrap();

        let stopped = runtime.stop(&meeting_id).unwrap();
        let meeting = stopped
            .meetings
            .iter()
            .find(|meeting| meeting.id == meeting_id)
            .unwrap();
        assert!(meeting.transcript_final);
        assert!(meeting.segments.is_empty());
        let page = runtime.transcript_page(&meeting_id, None, None).unwrap();
        assert_eq!(page.segments.len(), 1);
        assert_eq!(
            page.segments[0].text,
            "The acknowledged provider tail is durable."
        );
    }

    #[test]
    fn recovery_interrupts_capture_and_requeues_running_work() {
        let store = Arc::new(MeetingStore::open_in_memory().unwrap());
        let created = store
            .create_meeting(
                &MeetingDraft {
                    id: "meeting-recovery".into(),
                    title: "Recovery".into(),
                    origin: MeetingOrigin::default(),
                    channels: capture_channels(&MeetingPermissions {
                        microphone: "granted".into(),
                        system_audio: "denied".into(),
                    }),
                    metadata: json!({
                        "transcriptionRoute": "local",
                        "transcriptionModel": "whisper-small",
                        "runId": "run-recovery"
                    }),
                },
                NOW,
            )
            .unwrap();
        store
            .transition_meeting(
                "meeting-recovery",
                created.revision,
                MeetingStatus::Recording,
                NOW,
                None,
            )
            .unwrap();
        store
            .enqueue_job(
                &FollowUpJobDraft {
                    id: "job-recovery".into(),
                    meeting_id: "meeting-recovery".into(),
                    kind: FollowUpJobKind::Custom("fixture-work".into()),
                    idempotency_key: "recovery-fixture-work".into(),
                    payload: json!({}),
                    max_attempts: 3,
                    not_before: NOW.into(),
                },
                NOW,
            )
            .unwrap();
        store
            .claim_next_job("worker", NOW, LEASE_END)
            .unwrap()
            .unwrap();

        let capture = Arc::new(FakeCapture::default());
        let runtime = MeetingRuntime::new(
            Arc::clone(&store),
            capture.clone(),
            Arc::new(FakeTranscription::default()),
            Arc::new(FakePlatform::default()),
            Arc::new(FakeClock),
            Arc::new(FakeEvents::default()),
        )
        .unwrap();

        let snapshot = runtime.snapshot().unwrap();
        assert_eq!(snapshot.revision, 1);
        assert_eq!(snapshot.meetings[0].lifecycle, "interrupted");
        let jobs = store.list_jobs("meeting-recovery").unwrap();
        assert_eq!(
            jobs.iter()
                .find(|job| job.definition.id == "job-recovery")
                .unwrap()
                .state,
            JobState::Pending
        );
        assert!(jobs.iter().any(|job| {
            job.definition.kind == FollowUpJobKind::Custom("transcription".into())
                && job.state == JobState::Pending
        }));
        let transcription_job = jobs
            .iter()
            .find(|job| job.definition.kind == FollowUpJobKind::Custom("transcription".into()))
            .unwrap();
        assert_eq!(
            transcription_job.definition.payload["transcriptionRoute"],
            "local"
        );
        assert_eq!(
            transcription_job.definition.payload["transcriptionModel"],
            "whisper-small"
        );
        let reports = capture.recoveries.lock().unwrap();
        assert_eq!(reports[0].interrupted_meeting_ids, vec!["meeting-recovery"]);
        assert_eq!(reports[0].requeued_job_ids, vec!["job-recovery"]);
        drop(reports);

        store
            .begin_transcript_repair(
                "meeting-recovery",
                "run-recovery",
                "repair-run-recovery",
                NOW,
            )
            .unwrap();
        store
            .stage_transcript_repair_batch(
                "run-recovery",
                "repair-run-recovery",
                &TranscriptBatch {
                    meeting_id: "meeting-recovery".into(),
                    batch_id: "recovery-segments".into(),
                    base_revision: 0,
                    source: "recovery-stt".into(),
                    observed_at: NOW.into(),
                    marks_final: false,
                    changes: vec![TranscriptChange::UpsertSegment {
                        segment: TranscriptSegmentInput {
                            id: "recovered-segment".into(),
                            start_ms: 0,
                            end_ms: 2_000,
                            text: "Recovered audio was finalized.".into(),
                            channel_id: Some("microphone".into()),
                            speaker: None,
                            confidence: Some(0.9),
                            is_final: true,
                            metadata: json!({}),
                        },
                    }],
                },
            )
            .unwrap();
        let recovered = runtime
            .complete_transcription_retry(
                "meeting-recovery",
                "run-recovery",
                "repair-run-recovery",
                TranscriptBatch {
                    meeting_id: "meeting-recovery".into(),
                    batch_id: "recovery-final".into(),
                    base_revision: 0,
                    source: "recovery-stt".into(),
                    observed_at: NOW.into(),
                    marks_final: true,
                    changes: Vec::new(),
                },
            )
            .unwrap();
        let meeting = recovered
            .meetings
            .iter()
            .find(|meeting| meeting.id == "meeting-recovery")
            .unwrap();
        assert_eq!(meeting.lifecycle, "ready");
        assert!(meeting.transcript_final);
        assert_eq!(meeting.summary_state, "queued");

        let duplicate = runtime
            .complete_transcription_retry(
                "meeting-recovery",
                "run-recovery",
                "repair-run-recovery",
                TranscriptBatch {
                    meeting_id: "meeting-recovery".into(),
                    batch_id: "ignored-redelivery".into(),
                    base_revision: 1,
                    source: "recovery-stt".into(),
                    observed_at: NOW.into(),
                    marks_final: true,
                    changes: Vec::new(),
                },
            )
            .unwrap();
        assert_eq!(duplicate.revision, recovered.revision);
    }

    #[test]
    fn recovery_keeps_the_original_consented_route_after_global_provider_changes() {
        let store = Arc::new(MeetingStore::open_in_memory().unwrap());
        let created = store
            .create_meeting(
                &MeetingDraft {
                    id: "meeting-consented-endpoint-a".into(),
                    title: "Endpoint-bound recovery".into(),
                    origin: MeetingOrigin::default(),
                    channels: capture_channels(&MeetingPermissions {
                        microphone: "granted".into(),
                        system_audio: "granted".into(),
                    }),
                    metadata: json!({
                        "transcriptionRoute": "https://endpoint-a.example/v1/listen",
                        "transcriptionModel": "consented-model-a",
                        "runId": "run-consented-a"
                    }),
                },
                NOW,
            )
            .unwrap();
        store
            .transition_meeting(
                &created.id,
                created.revision,
                MeetingStatus::Recording,
                NOW,
                None,
            )
            .unwrap();

        let platform = Arc::new(FakePlatform::default());
        {
            let mut state = platform.state.lock().unwrap();
            state.projection.config.transcription_mode = "custom".into();
            state.projection.config.custom_url = "https://endpoint-b.example/v1/listen".into();
            state.projection.config.custom_model = "current-model-b".into();
            state.projection.config.api_key_configured = true;
        }
        MeetingRuntime::new(
            Arc::clone(&store),
            Arc::new(FakeCapture::default()),
            Arc::new(FakeTranscription::default()),
            platform,
            Arc::new(FakeClock),
            Arc::new(FakeEvents::default()),
        )
        .unwrap();

        let repair = store
            .list_jobs(&created.id)
            .unwrap()
            .into_iter()
            .find(|job| job.definition.kind == FollowUpJobKind::Custom("transcription".into()))
            .expect("interrupted capture must receive one repair job");
        assert_eq!(
            repair.definition.payload["transcriptionRoute"],
            "https://endpoint-a.example/v1/listen"
        );
        assert_eq!(
            repair.definition.payload["transcriptionModel"],
            "consented-model-a"
        );
        assert_ne!(
            repair.definition.payload["transcriptionRoute"],
            "https://endpoint-b.example/v1/listen"
        );
    }

    #[test]
    fn repeated_restarts_reuse_one_capture_generation_repair_owner() {
        let store = Arc::new(MeetingStore::open_in_memory().unwrap());
        let created = store
            .create_meeting(
                &MeetingDraft {
                    id: "meeting-stable-repair".into(),
                    title: "Stable repair".into(),
                    origin: MeetingOrigin::default(),
                    channels: capture_channels(&MeetingPermissions {
                        microphone: "granted".into(),
                        system_audio: "granted".into(),
                    }),
                    metadata: json!({
                        "transcriptionRoute": "local",
                        "transcriptionModel": "whisper-small",
                        "runId": "run-stable-generation"
                    }),
                },
                NOW,
            )
            .unwrap();
        store
            .transition_meeting(
                &created.id,
                created.revision,
                MeetingStatus::Recording,
                NOW,
                None,
            )
            .unwrap();

        let make_runtime = || {
            MeetingRuntime::new(
                Arc::clone(&store),
                Arc::new(FakeCapture::default()),
                Arc::new(FakeTranscription::default()),
                Arc::new(FakePlatform::default()),
                Arc::new(FakeClock),
                Arc::new(FakeEvents::default()),
            )
            .unwrap()
        };
        let first_runtime = make_runtime();
        let first = store.list_jobs(&created.id).unwrap();
        assert_eq!(first.len(), 1);
        let stable_id = first[0].definition.id.clone();
        let stable_key = first[0].definition.idempotency_key.clone();
        assert_eq!(
            first[0].definition.payload["captureGeneration"],
            "run-stable-generation"
        );
        store
            .claim_next_job("restart-worker-1", NOW, LEASE_END)
            .unwrap()
            .unwrap();
        drop(first_runtime);

        let second_runtime = make_runtime();
        let second = store.list_jobs(&created.id).unwrap();
        assert_eq!(second.len(), 1);
        assert_eq!(second[0].definition.id, stable_id);
        assert_eq!(second[0].definition.idempotency_key, stable_key);
        assert_eq!(second[0].state, JobState::Pending);
        store
            .claim_next_job("restart-worker-2", NOW, LEASE_END)
            .unwrap()
            .unwrap();
        drop(second_runtime);

        let _third_runtime = make_runtime();
        let third = store.list_jobs(&created.id).unwrap();
        assert_eq!(third.len(), 1);
        assert_eq!(third[0].definition.id, stable_id);
        assert_eq!(third[0].definition.idempotency_key, stable_key);
        assert_eq!(third[0].state, JobState::Pending);
        assert_eq!(third[0].attempts, 2);
    }

    #[test]
    fn startup_completes_terminal_batch_before_lifecycle_without_stt_disclosure() {
        let store = Arc::new(MeetingStore::open_in_memory().unwrap());
        let created = store
            .create_meeting(
                &MeetingDraft {
                    id: "meeting-terminal-before-lifecycle".into(),
                    title: "Terminal crash window".into(),
                    origin: MeetingOrigin::default(),
                    channels: capture_channels(&MeetingPermissions {
                        microphone: "granted".into(),
                        system_audio: "denied".into(),
                    }),
                    metadata: json!({
                        "transcriptionRoute": "https://never-contact.example/listen",
                        "transcriptionModel": "never-disclose",
                        "runId": "run-terminal-crash"
                    }),
                },
                NOW,
            )
            .unwrap();
        let recording = store
            .transition_meeting(
                &created.id,
                created.revision,
                MeetingStatus::Recording,
                NOW,
                None,
            )
            .unwrap();
        let stopping = store
            .transition_meeting(
                &created.id,
                recording.revision,
                MeetingStatus::Stopping,
                NOW,
                None,
            )
            .unwrap();
        store
            .transition_meeting(
                &created.id,
                stopping.revision,
                MeetingStatus::Finalizing,
                NOW,
                None,
            )
            .unwrap();
        store
            .apply_transcript_batch(&TranscriptBatch {
                meeting_id: created.id.clone(),
                batch_id: "terminal-before-lifecycle".into(),
                base_revision: 0,
                source: "live-custom".into(),
                observed_at: NOW.into(),
                marks_final: true,
                changes: vec![TranscriptChange::UpsertSegment {
                    segment: TranscriptSegmentInput {
                        id: "terminal-segment".into(),
                        start_ms: 0,
                        end_ms: 1_000,
                        text: "The provider terminal batch was already durable.".into(),
                        channel_id: Some("microphone".into()),
                        speaker: None,
                        confidence: Some(0.99),
                        is_final: true,
                        metadata: json!({
                            "owner": "stt",
                            "providerRunId": "run-terminal-crash"
                        }),
                    },
                }],
            })
            .unwrap();
        let transcription = Arc::new(FakeTranscription::default());
        let runtime = MeetingRuntime::new(
            Arc::clone(&store),
            Arc::new(FakeCapture::default()),
            transcription.clone(),
            Arc::new(FakePlatform::default()),
            Arc::new(FakeClock),
            Arc::new(FakeEvents::default()),
        )
        .unwrap();

        let meeting = runtime.meeting(&created.id).unwrap();
        assert_eq!(meeting.lifecycle, "ready");
        assert!(meeting.transcript_final);
        assert!(meeting.transcript_all_final);
        assert!(transcription.starts.lock().unwrap().is_empty());
        let jobs = store.list_jobs(&created.id).unwrap();
        assert_eq!(
            jobs.iter()
                .filter(|job| job.definition.kind == FollowUpJobKind::Summary)
                .count(),
            1
        );
        assert!(!jobs
            .iter()
            .any(|job| { job.definition.kind == FollowUpJobKind::Custom("transcription".into()) }));
    }

    #[test]
    fn startup_preserves_capture_failure_intent_across_terminal_crash_window() {
        let store = Arc::new(MeetingStore::open_in_memory().unwrap());
        let created = store
            .create_meeting(
                &MeetingDraft {
                    id: "meeting-failed-terminal-crash".into(),
                    title: "Failure terminal crash".into(),
                    origin: MeetingOrigin::default(),
                    channels: capture_channels(&MeetingPermissions {
                        microphone: "granted".into(),
                        system_audio: "denied".into(),
                    }),
                    metadata: json!({
                        "transcriptionRoute": "local://whisper-small",
                        "transcriptionModel": "whisper-small",
                        "runId": "run-failed-terminal-crash"
                    }),
                },
                NOW,
            )
            .unwrap();
        let recording = store
            .transition_meeting(
                &created.id,
                created.revision,
                MeetingStatus::Recording,
                NOW,
                None,
            )
            .unwrap();
        let failure = MeetingFailure {
            code: "capture-runtime-failed".into(),
            message: "disk writer failed".into(),
            retryable: true,
        };
        let interrupted = store
            .transition_meeting(
                &created.id,
                recording.revision,
                MeetingStatus::Interrupted,
                NOW,
                Some(&failure),
            )
            .unwrap();
        store
            .apply_transcript_batch(&TranscriptBatch {
                meeting_id: created.id.clone(),
                batch_id: "failed-terminal-before-lifecycle".into(),
                base_revision: interrupted.transcript_revision,
                source: "live-local".into(),
                observed_at: NOW.into(),
                marks_final: true,
                changes: Vec::new(),
            })
            .unwrap();
        let transcription = Arc::new(FakeTranscription::default());
        let runtime = MeetingRuntime::new(
            Arc::clone(&store),
            Arc::new(FakeCapture::default()),
            transcription.clone(),
            Arc::new(FakePlatform::default()),
            Arc::new(FakeClock),
            Arc::new(FakeEvents::default()),
        )
        .unwrap();

        let recovered = store.get_meeting(&created.id).unwrap();
        assert_eq!(recovered.status, MeetingStatus::Failed);
        assert_eq!(
            recovered
                .failure
                .as_ref()
                .map(|failure| failure.code.as_str()),
            Some("capture-runtime-failed")
        );
        assert!(store.list_jobs(&created.id).unwrap().is_empty());
        assert!(transcription.starts.lock().unwrap().is_empty());
        assert_eq!(runtime.meeting(&created.id).unwrap().lifecycle, "failed");
    }

    #[test]
    fn startup_repairs_a_terminal_transcript_after_promoting_staged_audio_tail() {
        let store = Arc::new(MeetingStore::open_in_memory().unwrap());
        let created = store
            .create_meeting(
                &MeetingDraft {
                    id: "meeting-staged-tail".into(),
                    title: "Staged audio tail".into(),
                    origin: MeetingOrigin::default(),
                    channels: capture_channels(&MeetingPermissions {
                        microphone: "granted".into(),
                        system_audio: "denied".into(),
                    }),
                    metadata: json!({
                        "transcriptionRoute": "local://whisper-small",
                        "transcriptionModel": "whisper-small",
                        "runId": "run-staged-tail"
                    }),
                },
                NOW,
            )
            .unwrap();
        let recording = store
            .transition_meeting(
                &created.id,
                created.revision,
                MeetingStatus::Recording,
                NOW,
                None,
            )
            .unwrap();
        let stopping = store
            .transition_meeting(
                &created.id,
                recording.revision,
                MeetingStatus::Stopping,
                NOW,
                None,
            )
            .unwrap();
        store
            .transition_meeting(
                &created.id,
                stopping.revision,
                MeetingStatus::Finalizing,
                NOW,
                None,
            )
            .unwrap();
        store
            .stage_audio_chunk(
                &crate::meetings::AudioChunkDraft {
                    id: "staged-tail-chunk".into(),
                    meeting_id: created.id.clone(),
                    channel_id: "microphone".into(),
                    sequence: 0,
                    start_ms: 0,
                    end_ms: 1_000,
                    sample_count: 48_000,
                    byte_len: 192_000,
                    sha256: "a".repeat(64),
                    relative_path: format!("{}/audio/microphone/00000000.f32le", created.id),
                },
                NOW,
            )
            .unwrap();
        store
            .apply_transcript_batch(&TranscriptBatch {
                meeting_id: created.id.clone(),
                batch_id: "terminal-before-staged-promotion".into(),
                base_revision: 0,
                source: "live-local".into(),
                observed_at: NOW.into(),
                marks_final: true,
                changes: Vec::new(),
            })
            .unwrap();
        let transcription = Arc::new(FakeTranscription::default());
        let runtime = MeetingRuntime::new(
            Arc::clone(&store),
            Arc::new(PromotingRecoveryCapture {
                store: Arc::clone(&store),
            }),
            transcription.clone(),
            Arc::new(FakePlatform::default()),
            Arc::new(FakeClock),
            Arc::new(FakeEvents::default()),
        )
        .unwrap();

        assert_eq!(
            store.get_meeting(&created.id).unwrap().status,
            MeetingStatus::Interrupted
        );
        assert!(store.has_committed_audio(&created.id).unwrap());
        let jobs = store.list_jobs(&created.id).unwrap();
        assert_eq!(
            jobs.iter()
                .filter(|job| {
                    job.definition.kind == FollowUpJobKind::Custom("transcription".into())
                })
                .count(),
            1
        );
        assert!(!jobs
            .iter()
            .any(|job| job.definition.kind == FollowUpJobKind::Summary));
        assert!(transcription.starts.lock().unwrap().is_empty());
        assert_eq!(
            runtime.meeting(&created.id).unwrap().lifecycle,
            "interrupted"
        );
    }

    #[test]
    fn completed_repair_job_redelivery_performs_zero_provider_work() {
        let fixture = make_fixture();
        let started = fixture
            .runtime
            .start(start_request(&fixture.runtime, "repair-redelivery"))
            .unwrap();
        let meeting_id = started.active_meeting_id.unwrap();
        fixture.runtime.stop(&meeting_id).unwrap();
        let starts_before = fixture.transcription.starts.lock().unwrap().len();
        let finalizes_before = fixture.transcription.finalizes.lock().unwrap().len();
        let jobs_before = fixture.store.list_jobs(&meeting_id).unwrap();
        let job = FollowUpJob {
            definition: FollowUpJobDraft {
                id: "job-transcription-run-redelivery".into(),
                meeting_id: meeting_id.clone(),
                kind: FollowUpJobKind::Custom("transcription".into()),
                idempotency_key: format!("{meeting_id}:transcription:run-redelivery"),
                payload: json!({
                    "captureGeneration": "run-redelivery",
                    "transcriptionRoute": "https://must-not-contact.example/listen",
                    "transcriptionModel": "must-not-load"
                }),
                max_attempts: 3,
                not_before: NOW.into(),
            },
            state: JobState::Running,
            attempts: 2,
            created_at: NOW.into(),
            updated_at: NOW.into(),
            lease_owner: Some("redelivery-worker".into()),
            lease_token: Some("redelivery-lease".into()),
            lease_expires_at: Some(LEASE_END.into()),
            last_error: None,
            result: None,
        };

        let result = crate::meetings::jobs::execute_transcription_repair_with(
            &fixture.runtime,
            fixture.transcription.as_ref(),
            &job,
        )
        .unwrap();
        assert_eq!(result["transcriptFinal"], true);
        assert_eq!(
            fixture.transcription.starts.lock().unwrap().len(),
            starts_before
        );
        assert_eq!(
            fixture.transcription.finalizes.lock().unwrap().len(),
            finalizes_before
        );
        assert_eq!(fixture.store.list_jobs(&meeting_id).unwrap(), jobs_before);
    }

    #[test]
    fn repair_retry_refuses_to_replace_a_transcript_after_source_audio_is_gone() {
        let store = Arc::new(MeetingStore::open_in_memory().unwrap());
        let transcription = Arc::new(AlwaysFailTranscription::default());
        let runtime = MeetingRuntime::new(
            Arc::clone(&store),
            Arc::new(FakeCapture::default()),
            transcription.clone(),
            Arc::new(FakePlatform::default()),
            Arc::new(FakeClock),
            Arc::new(FakeEvents::default()),
        )
        .unwrap();
        let started = runtime
            .start(start_request(&runtime, "repair-without-source"))
            .unwrap();
        let meeting_id = started.active_meeting_id.unwrap();
        let run_id = transcription.starts.lock().unwrap()[0].run_id.clone();
        runtime
            .handle_capture_failure(&meeting_id, &run_id, "capture failed")
            .unwrap();
        let repair = store
            .list_jobs(&meeting_id)
            .unwrap()
            .into_iter()
            .find(|job| job.definition.kind == FollowUpJobKind::Custom("transcription".into()))
            .unwrap();
        let starts_before = transcription.starts.lock().unwrap().len();

        let error = crate::meetings::jobs::execute_transcription_repair_with(
            &runtime,
            transcription.as_ref(),
            &repair,
        )
        .unwrap_err();
        assert!(error.contains("no committed source audio"));
        assert_eq!(transcription.starts.lock().unwrap().len(), starts_before);
    }

    #[test]
    fn failed_terminal_repair_redelivery_performs_zero_provider_or_audio_work() {
        let store = Arc::new(MeetingStore::open_in_memory().unwrap());
        let transcription = Arc::new(FakeTranscription::default());
        let runtime = MeetingRuntime::new(
            Arc::clone(&store),
            Arc::new(FakeCapture::default()),
            transcription.clone(),
            Arc::new(FakePlatform::default()),
            Arc::new(FakeClock),
            Arc::new(FakeEvents::default()),
        )
        .unwrap();
        let started = runtime
            .start(start_request(&runtime, "failed-repair-redelivery"))
            .unwrap();
        let meeting_id = started.active_meeting_id.unwrap();
        let run_id = transcription.starts.lock().unwrap()[0].run_id.clone();
        runtime
            .handle_capture_failure(&meeting_id, &run_id, "capture failed")
            .unwrap();
        let starts_before = transcription.starts.lock().unwrap().len();
        let finalizes_before = transcription.finalizes.lock().unwrap().len();
        let repair = FollowUpJob {
            definition: FollowUpJobDraft {
                id: "failed-terminal-redelivery".into(),
                meeting_id: meeting_id.clone(),
                kind: FollowUpJobKind::Custom("transcription".into()),
                idempotency_key: format!("{meeting_id}:transcription:{run_id}"),
                payload: json!({
                    "captureGeneration": run_id,
                    "transcriptionRoute": "https://must-not-contact.example/listen",
                    "transcriptionModel": "must-not-load"
                }),
                max_attempts: 3,
                not_before: NOW.into(),
            },
            state: JobState::Running,
            attempts: 2,
            created_at: NOW.into(),
            updated_at: NOW.into(),
            lease_owner: Some("redelivery-worker".into()),
            lease_token: Some("redelivery-lease".into()),
            lease_expires_at: Some(LEASE_END.into()),
            last_error: None,
            result: None,
        };

        let result = crate::meetings::jobs::execute_transcription_repair_with(
            &runtime,
            transcription.as_ref(),
            &repair,
        )
        .unwrap();
        assert_eq!(result["transcriptFinal"], true);
        assert_eq!(transcription.starts.lock().unwrap().len(), starts_before);
        assert_eq!(
            transcription.finalizes.lock().unwrap().len(),
            finalizes_before
        );
        assert_eq!(
            store.get_meeting(&meeting_id).unwrap().status,
            MeetingStatus::Failed
        );
    }

    #[test]
    fn failed_capture_worker_and_stop_race_enqueue_exactly_one_repair() {
        let store = Arc::new(MeetingStore::open_in_memory().unwrap());
        let capture = Arc::new(FakeCapture::default());
        let transcription = Arc::new(AlwaysFailTranscription::default());
        let runtime = MeetingRuntime::new(
            Arc::clone(&store),
            capture,
            transcription.clone(),
            Arc::new(FakePlatform::default()),
            Arc::new(FakeClock),
            Arc::new(FakeEvents::default()),
        )
        .unwrap();
        let started = runtime
            .start(start_request(&runtime, "capture-stop-race"))
            .unwrap();
        let meeting_id = started.active_meeting_id.unwrap();
        let run_id = transcription.starts.lock().unwrap()[0].run_id.clone();
        let barrier = Arc::new(Barrier::new(3));
        let stop_runtime = runtime.clone();
        let stop_meeting = meeting_id.clone();
        let stop_barrier = Arc::clone(&barrier);
        let stop = thread::spawn(move || {
            stop_barrier.wait();
            stop_runtime.stop(&stop_meeting)
        });
        let failure_runtime = runtime.clone();
        let failure_meeting = meeting_id.clone();
        let failure_run = run_id.clone();
        let failure_barrier = Arc::clone(&barrier);
        let failure = thread::spawn(move || {
            failure_barrier.wait();
            failure_runtime.handle_capture_failure(
                &failure_meeting,
                &failure_run,
                "native worker failed",
            )
        });
        barrier.wait();
        stop.join().unwrap().unwrap();
        failure.join().unwrap().unwrap();

        assert_eq!(
            store.get_meeting(&meeting_id).unwrap().status,
            MeetingStatus::Interrupted
        );
        assert_eq!(transcription.finalizes.lock().unwrap().len(), 1);
        let jobs = store.list_jobs(&meeting_id).unwrap();
        let repairs = jobs
            .iter()
            .filter(|job| job.definition.kind == FollowUpJobKind::Custom("transcription".into()))
            .collect::<Vec<_>>();
        assert_eq!(repairs.len(), 1);
        assert_eq!(repairs[0].state, JobState::Pending);
        assert_eq!(repairs[0].definition.payload["captureGeneration"], run_id);
        assert_eq!(
            repairs[0].definition.idempotency_key,
            format!("{meeting_id}:transcription:{run_id}")
        );
    }

    #[test]
    fn stop_winning_failed_worker_race_enqueues_repair_before_delayed_callback() {
        let store = Arc::new(MeetingStore::open_in_memory().unwrap());
        let capture = Arc::new(EndedWorkerCapture::default());
        let transcription = Arc::new(SessionOwningFailTranscription::default());
        let runtime = MeetingRuntime::new(
            Arc::clone(&store),
            capture.clone(),
            transcription.clone(),
            Arc::new(FakePlatform::default()),
            Arc::new(FakeClock),
            Arc::new(FakeEvents::default()),
        )
        .unwrap();
        let started = runtime
            .start(start_request(&runtime, "ended-worker-stop-race"))
            .unwrap();
        let meeting_id = started.active_meeting_id.unwrap();
        let run_id = capture.starts.lock().unwrap()[0].run_id.clone();

        let stop_error = runtime.stop(&meeting_id).unwrap_err();
        assert!(stop_error.to_string().contains("already ended"));
        // The native failure notifier was queued before Stop but arrives only
        // after Stop released the operation lock.
        runtime
            .handle_capture_failure(
                &meeting_id,
                &run_id,
                "capture worker already ended after a durable chunk failure",
            )
            .unwrap();

        let snapshot = runtime.snapshot().unwrap();
        assert!(snapshot.active_meeting_id.is_none());
        assert_eq!(
            store.get_meeting(&meeting_id).unwrap().status,
            MeetingStatus::Interrupted
        );
        assert_eq!(capture.stops.lock().unwrap().len(), 1);
        let repairs = store
            .list_jobs(&meeting_id)
            .unwrap()
            .into_iter()
            .filter(|job| job.definition.kind == FollowUpJobKind::Custom("transcription".into()))
            .collect::<Vec<_>>();
        assert_eq!(repairs.len(), 1);
        assert_eq!(repairs[0].state, JobState::Pending);
        assert_eq!(repairs[0].definition.payload["captureGeneration"], run_id);
        transcription
            .start(&TranscriptionStart {
                meeting_id: meeting_id.clone(),
                run_id: format!("repair-{run_id}"),
                route: repairs[0].definition.payload["transcriptionRoute"]
                    .as_str()
                    .unwrap()
                    .into(),
                model: repairs[0].definition.payload["transcriptionModel"]
                    .as_str()
                    .unwrap()
                    .into(),
                repair_generation: Some(run_id.clone()),
            })
            .expect("Stop must remove the live transcription session before repair");
        assert_eq!(transcription.finalizes.lock().unwrap().len(), 1);
        assert_eq!(transcription.starts.lock().unwrap().len(), 2);
    }

    #[test]
    fn renderer_dto_uses_exact_final_and_projection_fields() {
        let fixture = make_fixture();
        let started = fixture
            .runtime
            .start(start_request(&fixture.runtime, "serde-shape"))
            .unwrap();
        let snapshot = fixture
            .runtime
            .stop(started.active_meeting_id.as_deref().unwrap())
            .unwrap();
        let value = serde_json::to_value(snapshot).unwrap();
        let meeting = &value["meetings"][0];
        for field in [
            "lifecycle",
            "transcription",
            "segments",
            "summaryState",
            "kgState",
            "jobs",
        ] {
            assert!(
                meeting.get(field).is_some(),
                "missing renderer field {field}"
            );
        }
        assert_eq!(meeting["segments"], json!([]));
        let page = fixture
            .runtime
            .transcript_page(started.active_meeting_id.as_deref().unwrap(), None, None)
            .unwrap();
        let page = serde_json::to_value(page).unwrap();
        assert_eq!(page["segments"][0]["final"], true);
        assert!(page["segments"][0].get("final_").is_none());

        let clear_retention: MeetingConfigPatch =
            serde_json::from_value(json!({ "retentionDays": null })).unwrap();
        let omitted_retention: MeetingConfigPatch = serde_json::from_value(json!({})).unwrap();
        assert_eq!(clear_retention.retention_days, Some(None));
        assert_eq!(omitted_retention.retention_days, None);
    }

    #[test]
    fn external_operations_propagate_real_port_failures() {
        let fixture = make_fixture();
        fixture.platform.state.lock().unwrap().fail_model_install =
            Some("checksum mismatch".into());
        let error = fixture.runtime.install_model("whisper-small").unwrap_err();
        assert!(error.to_string().contains("checksum mismatch"));
        assert!(fixture
            .platform
            .state
            .lock()
            .unwrap()
            .projection
            .models
            .is_empty());

        let started = fixture
            .runtime
            .start(start_request(&fixture.runtime, "export-error"))
            .unwrap();
        let meeting_id = started.active_meeting_id.unwrap();
        fixture.runtime.stop(&meeting_id).unwrap();
        fixture.platform.state.lock().unwrap().fail_export = Some("destination unavailable".into());
        let error = fixture
            .runtime
            .export(&meeting_id, MeetingExportFormat::Markdown)
            .unwrap_err();
        assert!(error.to_string().contains("destination unavailable"));
        assert!(fixture.platform.state.lock().unwrap().exports.is_empty());
    }

    #[test]
    fn mtg_153_running_activity_only_releases_deletion_wait_and_cannot_recreate_content() {
        let fixture = make_fixture();
        let started = fixture
            .runtime
            .start(start_request(&fixture.runtime, "deletion-authority"))
            .unwrap();
        let meeting_id = started.active_meeting_id.unwrap();
        fixture.runtime.stop(&meeting_id).unwrap();
        let running = fixture
            .runtime
            .claim_next_job("activity-worker", LEASE_END)
            .unwrap()
            .unwrap();

        let error = fixture
            .runtime
            .delete(&meeting_id, MeetingDeleteMode::All)
            .unwrap_err();
        assert!(matches!(
            error,
            MeetingRuntimeError::Store(MeetingStoreError::DeletionBlocked {
                running_jobs: 1,
                ..
            })
        ));
        assert!(fixture
            .runtime
            .update_meeting(
                &meeting_id,
                MeetingUpdatePatch {
                    title: Some("late Activity title".into()),
                    summary: Some("late Activity summary".into()),
                    tags: None,
                },
            )
            .unwrap_err()
            .to_string()
            .contains("being permanently deleted"));
        assert!(!fixture
            .platform
            .state
            .lock()
            .unwrap()
            .contents
            .contains_key(&meeting_id));

        fixture
            .runtime
            .finish_job(
                &running.definition.id,
                running.lease_token.as_deref().unwrap(),
                JobFinish::Succeeded {
                    result: json!({
                        "title": "must be discarded",
                        "summary": "must be discarded"
                    }),
                },
            )
            .unwrap();
        let job = fixture
            .store
            .list_jobs(&meeting_id)
            .unwrap()
            .into_iter()
            .find(|job| job.definition.id == running.definition.id)
            .unwrap();
        assert_eq!(job.state, JobState::Cancelled);
        assert!(job.result.is_none());
        assert_eq!(
            fixture.store.deletion(&meeting_id).unwrap().unwrap().stage,
            MeetingDeletionStage::FilesPending
        );
        let state = fixture.platform.state.lock().unwrap();
        assert_eq!(
            state.deleted,
            [(meeting_id.clone(), MeetingDeleteMode::All)]
        );
        assert!(state.contents.get(&meeting_id).unwrap().deleted);
    }

    #[test]
    fn capture_start_failure_is_durable_and_never_reported_as_success() {
        let fixture = make_fixture();
        *fixture.capture.fail_start.lock().unwrap() = Some("device busy".into());
        let error = fixture
            .runtime
            .start(start_request(&fixture.runtime, "capture-error"))
            .unwrap_err();
        assert!(error.to_string().contains("device busy"));
        let meetings = fixture.store.list_meetings(10).unwrap();
        assert_eq!(meetings.len(), 1);
        assert_eq!(meetings[0].status, MeetingStatus::Failed);
        assert_eq!(
            meetings[0].failure.as_ref().unwrap().code,
            "capture-start-failed"
        );
        assert!(fixture
            .runtime
            .snapshot()
            .unwrap()
            .active_meeting_id
            .is_none());
    }

    #[test]
    fn capture_worker_starts_only_after_durable_runtime_ownership_exists() {
        let store = Arc::new(MeetingStore::open_in_memory().unwrap());
        let capture = Arc::new(AuthorityCheckingCapture {
            store: Arc::clone(&store),
            observed_status: Mutex::new(None),
        });
        let runtime = MeetingRuntime::new(
            store,
            capture.clone(),
            Arc::new(FakeTranscription::default()),
            Arc::new(FakePlatform::default()),
            Arc::new(FakeClock),
            Arc::new(FakeEvents::default()),
        )
        .unwrap();

        runtime
            .start(start_request(&runtime, "durable-before-worker"))
            .unwrap();
        assert_eq!(
            *capture.observed_status.lock().unwrap(),
            Some(MeetingStatus::Recording)
        );
    }

    #[test]
    fn mtg_046_mid_session_capture_failure_is_immediately_durable_and_visible() {
        let fixture = make_fixture();
        let started = fixture
            .runtime
            .start(start_request(&fixture.runtime, "mid-session-failure"))
            .unwrap();
        let meeting_id = started.active_meeting_id.unwrap();
        let run_id = fixture.capture.starts.lock().unwrap()[0].run_id.clone();

        fixture.runtime.capture_failed(
            &meeting_id,
            &run_id,
            "disk reserve was exhausted while committing microphone audio",
        );

        let snapshot = fixture.runtime.snapshot().unwrap();
        assert!(snapshot.active_meeting_id.is_none());
        let meeting = snapshot
            .meetings
            .iter()
            .find(|meeting| meeting.id == meeting_id)
            .unwrap();
        assert_eq!(meeting.lifecycle, "failed");
        assert!(meeting.transcript_final);
        assert!(meeting.error.as_deref().unwrap().contains("disk reserve"));
        assert_eq!(
            fixture
                .store
                .get_meeting(&meeting_id)
                .unwrap()
                .failure
                .as_ref()
                .map(|failure| failure.code.as_str()),
            Some("capture-runtime-failed")
        );
        assert_eq!(fixture.capture.stops.lock().unwrap().len(), 1);
        assert!(fixture
            .events
            .published
            .lock()
            .unwrap()
            .iter()
            .any(|event| event.kind == "capture-runtime-failed"));

        // A late callback from a superseded worker cannot damage the already
        // reconciled record.
        fixture
            .runtime
            .capture_failed(&meeting_id, "stale-run", "late device error");
        assert_eq!(
            fixture.store.get_meeting(&meeting_id).unwrap().status,
            MeetingStatus::Failed
        );
    }

    #[test]
    fn capture_failure_is_visible_before_slow_transcription_drain() {
        let store = Arc::new(MeetingStore::open_in_memory().unwrap());
        let events = Arc::new(FakeEvents::default());
        let transcription = Arc::new(FailureOrderingTranscription {
            store: Arc::clone(&store),
            events: Arc::clone(&events),
            observed_interrupted_before_finalize: Mutex::new(false),
        });
        let runtime = MeetingRuntime::new(
            Arc::clone(&store),
            Arc::new(FakeCapture::default()),
            transcription.clone(),
            Arc::new(FakePlatform::default()),
            Arc::new(FakeClock),
            events,
        )
        .unwrap();
        let started = runtime
            .start(start_request(&runtime, "visible-before-drain"))
            .unwrap();
        let meeting_id = started.active_meeting_id.unwrap();
        let run_id = runtime.active().unwrap().as_ref().unwrap().run_id.clone();

        runtime.capture_failed(
            &meeting_id,
            &run_id,
            "disk reserve was exhausted while persisting audio",
        );

        assert!(*transcription
            .observed_interrupted_before_finalize
            .lock()
            .unwrap());
        assert_eq!(
            store.get_meeting(&meeting_id).unwrap().status,
            MeetingStatus::Failed
        );
    }

    #[test]
    fn native_capture_failure_sink_does_not_keep_runtime_alive() {
        let runtime = MeetingRuntime::new(
            Arc::new(MeetingStore::open_in_memory().unwrap()),
            Arc::new(FakeCapture::default()),
            Arc::new(FakeTranscription::default()),
            Arc::new(FakePlatform::default()),
            Arc::new(FakeClock),
            Arc::new(FakeEvents::default()),
        )
        .unwrap();
        let weak_inner = Arc::downgrade(&runtime.inner);
        let sink = runtime.capture_failure_sink();

        drop(runtime);

        assert!(weak_inner.upgrade().is_none());
        sink.capture_failed("ended-meeting", "ended-run", "late worker completion");
    }
}
