use super::*;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingSnapshot {
    pub revision: u64,
    pub meetings: Vec<MeetingView>,
    /// A start response contains the active meeting only. The renderer merges
    /// it into the current library and reconciles the full library after the
    /// recording surface is usable.
    #[serde(default, skip_serializing_if = "is_false")]
    pub start_projection: bool,
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

fn is_false(value: &bool) -> bool {
    !*value
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
    /// Start of the current native capture run. Unlike `started_at`, this
    /// advances when a completed meeting is continued after a break.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recording_started_at: Option<String>,
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
    pub notes: String,
    #[serde(default)]
    pub summary_truncated: bool,
    pub summary_state: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub summary_needs_update: bool,
    pub kg_state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub graph_node_id: Option<String>,
    #[serde(default)]
    pub graph_draft: MeetingGraphDraft,
    #[serde(default)]
    pub jobs: Vec<MeetingJobView>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MeetingFilingSource {
    pub id: String,
    pub title: String,
    pub summary: String,
    pub started_at: Option<String>,
    pub duration_ms: u64,
    pub graph_node_id: Option<String>,
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
