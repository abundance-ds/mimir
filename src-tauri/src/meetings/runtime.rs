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

mod followups;
mod library;

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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingSummaryRunRequest {
    pub template: String,
    pub prompt: String,
    #[serde(default)]
    pub preset: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingConfigPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detection_enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_record: Option<bool>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_nullable_patch"
    )]
    pub microphone_device_id: Option<Option<String>>,
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
    pub summary_prompt: Option<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub microphone_device_id: Option<String>,
    pub transcription_mode: String,
    pub custom_url: String,
    pub custom_model: String,
    pub api_key_configured: bool,
    pub local_model: String,
    pub summary_enabled: bool,
    pub summary_template: String,
    pub summary_prompt: String,
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
            microphone_device_id: None,
            transcription_mode: "local".into(),
            custom_url: String::new(),
            custom_model: String::new(),
            api_key_configured: false,
            local_model: "whisper-small".into(),
            summary_enabled: true,
            summary_template: "standard".into(),
            summary_prompt: default_summary_prompt(),
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
    pub summary_prompt: String,
    pub summary_preset: String,
    pub kg_prompt: String,
    pub kg_preset: String,
}

impl From<&MeetingConfig> for MeetingHookConfig {
    fn from(config: &MeetingConfig) -> Self {
        Self {
            summary_enabled: config.summary_enabled,
            summary_template: config.summary_template.clone(),
            summary_prompt: config.summary_prompt.clone(),
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
    Files,
}

impl MeetingExportFormat {
    pub fn parse(value: &str) -> Result<Self, MeetingRuntimeError> {
        match value {
            "markdown" => Ok(Self::Markdown),
            "json" => Ok(Self::Json),
            "audio" => Ok(Self::Audio),
            "files" => Ok(Self::Files),
            _ => Err(MeetingRuntimeError::Validation(
                "meeting export format must be markdown, json, audio, or files".into(),
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
    pub microphone_device_id: Option<String>,
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
    /// Distinguishes automatic crash repair from an explicit user request to
    /// reprocess retained audio with the provider selected today. Automatic
    /// repair deliberately leaves this unset and remains bound to the
    /// meeting's original consented route.
    pub repair_intent: Option<TranscriptionRepairIntent>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TranscriptionRepairIntent {
    UserRequestedRetranscription,
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
    Connecting,
    Listening,
    Live,
    Reconnecting,
    Failed,
    Delayed,
}

impl TranscriptionWorkerStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Initializing => "initializing",
            Self::Connecting => "connecting",
            Self::Listening => "listening",
            Self::Live => "live",
            Self::Reconnecting => "reconnecting",
            Self::Failed => "failed",
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingTranscriptSearchHit {
    pub meeting_id: String,
    pub segment_id: String,
    pub start_ms: u64,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingLibrarySearchMatch {
    pub title: bool,
    pub summary: bool,
    pub tags: bool,
    pub transcript: Vec<MeetingTranscriptSearchHit>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
            "microphoneDeviceId": projection.config.microphone_device_id.clone(),
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
            microphone_device_id: projection.config.microphone_device_id.clone(),
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
            repair_intent: None,
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
                &hook_config.summary_prompt,
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

    pub(crate) fn committed_transcript_repair_revision(
        &self,
        meeting_id: &str,
        capture_generation: &str,
        provider_run_id: &str,
    ) -> Result<Option<u64>, MeetingRuntimeError> {
        self.inner
            .store
            .committed_transcript_repair_revision(meeting_id, capture_generation, provider_run_id)
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
                    &config.summary_prompt,
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
                    &config.summary_prompt,
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

    /// Atomically publish one explicit retranscription generation while
    /// leaving the meeting's already-terminal lifecycle untouched.
    ///
    /// Provider output has been private staging up to this point. Therefore
    /// every error before this terminal commit preserves the prior readable
    /// transcript and its revision.
    pub fn complete_user_retranscription(
        &self,
        meeting_id: &str,
        capture_generation: &str,
        provider_run_id: &str,
        batch: TranscriptBatch,
    ) -> Result<MeetingSnapshot, MeetingRuntimeError> {
        let _operation = self.operation()?;
        let meeting = self.inner.store.get_meeting(meeting_id)?;
        if !matches!(
            meeting.status,
            MeetingStatus::Completed | MeetingStatus::Failed
        ) {
            return Err(MeetingRuntimeError::Validation(
                "retranscription requires a completed or failed meeting".into(),
            ));
        }
        if batch.meeting_id != meeting_id
            || batch.base_revision != meeting.transcript_revision
            || !batch.marks_final
            || !batch.changes.is_empty()
        {
            return Err(MeetingRuntimeError::Validation(
                "retranscription returned an invalid terminal batch".into(),
            ));
        }
        self.inner
            .store
            .commit_transcript_repair(capture_generation, provider_run_id, &batch)?;
        let overview = self.inner.store.transcript_overview(meeting_id, 1)?;
        if !overview.is_final || overview.non_final_segment_count != 0 {
            return Err(MeetingRuntimeError::Validation(
                "retranscription did not produce an all-final transcript".into(),
            ));
        }
        self.publish_unlocked("meeting-retranscribed", Some(meeting_id.into()), None)
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
    require_summary_prompt(&config.summary_prompt)?;
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
    if let Some(Some(device_id)) = &patch.microphone_device_id {
        validate_microphone_device_id(device_id).map_err(MeetingRuntimeError::Validation)?;
    }
    if let Some(template) = &patch.summary_template {
        require_summary_template(template)?;
    }
    if let Some(prompt) = &patch.summary_prompt {
        require_summary_prompt(prompt)?;
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

pub(crate) fn validate_microphone_device_id(value: &str) -> Result<(), String> {
    if value.trim() != value || value.is_empty() {
        return Err("microphone device identity cannot be empty or padded".into());
    }
    if value.len() > 1_024 {
        return Err("microphone device identity is too long".into());
    }
    if value.chars().any(char::is_control) {
        return Err("microphone device identity contains control characters".into());
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

fn require_summary_preset(value: &str) -> Result<(), MeetingRuntimeError> {
    if value.len() > 200 || value.chars().any(char::is_control) || value.trim() != value {
        return Err(MeetingRuntimeError::Validation(
            "summary CLI agent preset is invalid".into(),
        ));
    }
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

pub(crate) fn default_summary_prompt() -> String {
    summary_template_instructions("standard")
        .expect("standard summary instructions must exist")
        .into()
}

pub(crate) fn require_summary_prompt(value: &str) -> Result<(), MeetingRuntimeError> {
    if value.trim().is_empty() {
        return Err(MeetingRuntimeError::Validation(
            "summary instructions cannot be empty".into(),
        ));
    }
    if value.chars().count() > 16_000 {
        return Err(MeetingRuntimeError::Validation(
            "summary instructions exceed 16000 characters".into(),
        ));
    }
    if value
        .chars()
        .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    {
        return Err(MeetingRuntimeError::Validation(
            "summary instructions contain unsupported control characters".into(),
        ));
    }
    Ok(())
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
mod tests;
