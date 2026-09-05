use super::*;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureStart {
    pub meeting_id: String,
    pub run_id: String,
    pub workspace_path: Option<String>,
    pub microphone_device_id: Option<String>,
    pub channels: Vec<AudioChannelDraft>,
    /// First append-only chunk sequence owned by this capture run.
    pub first_sequence: u64,
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
    /// First append-only audio sequence owned by this live run. Repair passes
    /// always use zero because they rebuild retained source audio.
    pub first_sequence: u64,
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
    pub(super) fn as_str(self) -> &'static str {
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

    /// Signal the owned worker without waiting for teardown or transcription.
    /// The later `stop` call still joins the worker and returns its report.
    fn signal_stop(&self, _request: &CaptureStop) -> Result<(), String> {
        Ok(())
    }

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
