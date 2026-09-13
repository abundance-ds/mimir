use super::*;

pub const MEETING_EVENT: &str = "mimir://meeting-event";
pub(super) const DEFAULT_MEETING_LIMIT: u32 = 200;
pub(super) const MAX_LIBRARY_GAPS: u32 = 100;
pub(super) const MAX_SUMMARY_PREVIEW_CHARS: usize = 2_000;
pub(super) const DEFAULT_JOB_ATTEMPTS: u32 = 3;

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
    /// Existing completed meeting whose durable timeline should be continued
    /// with a fresh native capture run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continue_meeting_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub consent_token: Option<String>,
    /// Set only by the native IPC command after consuming a window-bound,
    /// short-lived consent grant. Serde deliberately cannot populate it.
    #[serde(skip)]
    pub(crate) authorized_consent: Option<MeetingStartConsentContext>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareMeetingRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
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
    pub continue_meeting_id: Option<String>,
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
    pub notes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub graph_node_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub graph_draft: Option<MeetingGraphDraft>,
    /// Generated titles must not replace a title that the user entered.
    #[serde(skip)]
    pub(crate) generated_title: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingGraphDraft {
    #[serde(default)]
    pub project_resolved: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default)]
    pub people_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope_id: Option<String>,
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
    pub ignored_apps: Option<Vec<MeetingIgnoredApp>>,
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
    #[serde(default)]
    pub ignored_apps: Vec<MeetingIgnoredApp>,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MeetingIgnoredApp {
    pub app_id: String,
    pub app_name: String,
}

impl Default for MeetingConfig {
    fn default() -> Self {
        Self {
            ignored_apps: Vec::new(),
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
    pub notes: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_app: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kg_decision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub graph_node_id: Option<String>,
    #[serde(default)]
    pub graph_draft: MeetingGraphDraft,
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
