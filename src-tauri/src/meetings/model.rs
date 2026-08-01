use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt;

pub const MAX_ID_BYTES: usize = 160;
pub const MAX_TITLE_CHARS: usize = 512;
pub const MAX_TRANSCRIPT_TEXT_BYTES: usize = 1_048_576;
pub const MAX_TRANSCRIPT_CHANGES: usize = 5_000;
pub const MAX_JOB_ATTEMPTS: u32 = 100;
pub const MAX_METADATA_BYTES: usize = 262_144;
pub const MAX_JOB_PAYLOAD_BYTES: usize = 1_048_576;
pub const MAX_JOB_RESULT_BYTES: usize = 1_048_576;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MeetingStatus {
    Detected,
    Recording,
    Stopping,
    Finalizing,
    Completed,
    Interrupted,
    Failed,
    Discarded,
}

impl MeetingStatus {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Discarded)
    }

    pub fn can_transition_to(self, next: Self) -> bool {
        if self == next {
            return true;
        }
        match self {
            Self::Detected => matches!(next, Self::Recording | Self::Failed | Self::Discarded),
            Self::Recording => {
                matches!(next, Self::Stopping | Self::Interrupted | Self::Failed)
            }
            Self::Stopping => {
                matches!(next, Self::Finalizing | Self::Interrupted | Self::Failed)
            }
            Self::Finalizing => {
                matches!(next, Self::Completed | Self::Interrupted | Self::Failed)
            }
            Self::Interrupted => {
                matches!(next, Self::Finalizing | Self::Failed | Self::Discarded)
            }
            Self::Completed | Self::Failed | Self::Discarded => false,
        }
    }

    pub fn accepts_transcript_changes(self) -> bool {
        !matches!(self, Self::Failed | Self::Discarded)
    }
}

impl fmt::Display for MeetingStatus {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Detected => "detected",
            Self::Recording => "recording",
            Self::Stopping => "stopping",
            Self::Finalizing => "finalizing",
            Self::Completed => "completed",
            Self::Interrupted => "interrupted",
            Self::Failed => "failed",
            Self::Discarded => "discarded",
        })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingOrigin {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
    #[serde(default)]
    pub evidence: Value,
}

impl Default for MeetingOrigin {
    fn default() -> Self {
        Self {
            kind: "manual".into(),
            external_id: None,
            confidence: None,
            evidence: Value::Object(Default::default()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AudioChannelKind {
    Microphone,
    System,
    Mixed,
    Imported,
}

impl fmt::Display for AudioChannelKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Microphone => "microphone",
            Self::System => "system",
            Self::Mixed => "mixed",
            Self::Imported => "imported",
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioChannelDraft {
    pub id: String,
    pub kind: AudioChannelKind,
    pub sample_rate_hz: u32,
    pub channels: u16,
    pub sample_format: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioChannel {
    #[serde(flatten)]
    pub definition: AudioChannelDraft,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingDraft {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub origin: MeetingOrigin,
    #[serde(default)]
    pub channels: Vec<AudioChannelDraft>,
    #[serde(default)]
    pub metadata: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingFailure {
    pub code: String,
    pub message: String,
    #[serde(default)]
    pub retryable: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingRecord {
    pub id: String,
    pub title: String,
    pub origin: MeetingOrigin,
    pub status: MeetingStatus,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stopped_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finalized_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interrupted_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interruption_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<MeetingFailure>,
    pub revision: u64,
    pub transcript_revision: u64,
    pub recovery_count: u32,
    #[serde(default)]
    pub metadata: Value,
    #[serde(default)]
    pub channels: Vec<AudioChannel>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AudioChunkStatus {
    Staged,
    Committed,
    Corrupt,
}

impl fmt::Display for AudioChunkStatus {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Staged => "staged",
            Self::Committed => "committed",
            Self::Corrupt => "corrupt",
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioChunkDraft {
    pub id: String,
    pub meeting_id: String,
    pub channel_id: String,
    pub sequence: u64,
    pub start_ms: i64,
    pub end_ms: i64,
    pub sample_count: u64,
    pub byte_len: u64,
    pub sha256: String,
    pub relative_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioChunk {
    #[serde(flatten)]
    pub definition: AudioChunkDraft,
    pub status: AudioChunkStatus,
    pub staged_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub committed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub integrity_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegmentInput {
    pub id: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speaker: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
    #[serde(default)]
    pub is_final: bool,
    #[serde(default)]
    pub metadata: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegmentRecord {
    #[serde(flatten)]
    pub segment: TranscriptSegmentInput,
    pub created_revision: u64,
    pub updated_revision: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TranscriptGapReason {
    CaptureUnavailable,
    DeviceChanged,
    BufferOverflow,
    TranscriptionFailed,
    UnsupportedAudio,
    Unknown,
}

impl fmt::Display for TranscriptGapReason {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::CaptureUnavailable => "capture-unavailable",
            Self::DeviceChanged => "device-changed",
            Self::BufferOverflow => "buffer-overflow",
            Self::TranscriptionFailed => "transcription-failed",
            Self::UnsupportedAudio => "unsupported-audio",
            Self::Unknown => "unknown",
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptGapInput {
    pub id: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub reason: TranscriptGapReason,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptGapRecord {
    #[serde(flatten)]
    pub gap: TranscriptGapInput,
    pub created_revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_revision: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum TranscriptChange {
    UpsertSegment { segment: TranscriptSegmentInput },
    DeleteSegment { segment_id: String },
    OpenGap { gap: TranscriptGapInput },
    ResolveGap { gap_id: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptBatch {
    pub meeting_id: String,
    pub batch_id: String,
    pub base_revision: u64,
    pub source: String,
    pub observed_at: String,
    #[serde(default)]
    pub marks_final: bool,
    pub changes: Vec<TranscriptChange>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptRevision {
    pub meeting_id: String,
    pub revision: u64,
    pub base_revision: u64,
    pub batch_id: String,
    pub source: String,
    pub observed_at: String,
    pub marks_final: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptApplyResult {
    pub revision: u64,
    pub duplicate: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSnapshot {
    pub meeting_id: String,
    pub revision: u64,
    pub segments: Vec<TranscriptSegmentRecord>,
    pub gaps: Vec<TranscriptGapRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FollowUpJobKind {
    Summary,
    KnowledgeGraph,
    Custom(String),
}

impl FollowUpJobKind {
    pub fn as_storage_key(&self) -> String {
        match self {
            Self::Summary => "summary".into(),
            Self::KnowledgeGraph => "knowledge-graph".into(),
            Self::Custom(name) => format!("custom:{name}"),
        }
    }

    pub fn from_storage_key(value: &str) -> Self {
        match value {
            "summary" => Self::Summary,
            "knowledge-graph" => Self::KnowledgeGraph,
            other => Self::Custom(other.strip_prefix("custom:").unwrap_or(other).into()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum JobState {
    Pending,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

impl fmt::Display for JobState {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FollowUpJobDraft {
    pub id: String,
    pub meeting_id: String,
    pub kind: FollowUpJobKind,
    pub idempotency_key: String,
    #[serde(default)]
    pub payload: Value,
    pub max_attempts: u32,
    pub not_before: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FollowUpJob {
    #[serde(flatten)]
    pub definition: FollowUpJobDraft,
    pub state: JobState,
    pub attempts: u32,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lease_owner: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lease_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lease_expires_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "outcome",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum JobFinish {
    Succeeded {
        result: Value,
    },
    Failed {
        error: String,
        retryable: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        retry_at: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryReport {
    pub interrupted_meeting_ids: Vec<String>,
    pub requeued_job_ids: Vec<String>,
    pub failed_job_ids: Vec<String>,
    pub staged_audio_chunks: Vec<AudioChunk>,
}

pub(crate) fn validate_id(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err(format!("{label} cannot be empty"));
    }
    if value.len() > MAX_ID_BYTES {
        return Err(format!("{label} exceeds {MAX_ID_BYTES} bytes"));
    }
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err(format!(
            "{label} may contain only ASCII letters, numbers, '-', '_', '.', and ':'"
        ));
    }
    Ok(())
}

pub(crate) fn validate_meeting_draft(draft: &MeetingDraft) -> Result<(), String> {
    validate_id(&draft.id, "meeting id")?;
    let title = draft.title.trim();
    if title.is_empty() {
        return Err("meeting title cannot be empty".into());
    }
    if title.chars().count() > MAX_TITLE_CHARS {
        return Err(format!(
            "meeting title exceeds {MAX_TITLE_CHARS} characters"
        ));
    }
    if draft.origin.kind.trim().is_empty() {
        return Err("meeting origin kind cannot be empty".into());
    }
    if let Some(confidence) = draft.origin.confidence {
        if !confidence.is_finite() || !(0.0..=1.0).contains(&confidence) {
            return Err("meeting origin confidence must be between 0 and 1".into());
        }
    }
    validate_json_size(
        &draft.origin.evidence,
        MAX_METADATA_BYTES,
        "meeting origin evidence",
    )?;
    validate_json_size(&draft.metadata, MAX_METADATA_BYTES, "meeting metadata")?;
    let mut ids = std::collections::HashSet::new();
    for channel in &draft.channels {
        validate_audio_channel(channel)?;
        if !ids.insert(&channel.id) {
            return Err(format!("duplicate audio channel '{}'", channel.id));
        }
    }
    Ok(())
}

pub(crate) fn validate_audio_channel(channel: &AudioChannelDraft) -> Result<(), String> {
    validate_id(&channel.id, "audio channel id")?;
    if !(8_000..=384_000).contains(&channel.sample_rate_hz) {
        return Err("audio sample rate must be between 8000 and 384000 Hz".into());
    }
    if channel.channels == 0 || channel.channels > 32 {
        return Err("audio channel count must be between 1 and 32".into());
    }
    if channel.sample_format.trim().is_empty() || channel.sample_format.len() > 32 {
        return Err("audio sample format must contain 1 to 32 bytes".into());
    }
    Ok(())
}

pub(crate) fn validate_audio_chunk(chunk: &AudioChunkDraft) -> Result<(), String> {
    validate_id(&chunk.id, "audio chunk id")?;
    validate_id(&chunk.meeting_id, "meeting id")?;
    validate_id(&chunk.channel_id, "audio channel id")?;
    if chunk.end_ms <= chunk.start_ms || chunk.start_ms < 0 {
        return Err("audio chunk must have a non-negative, increasing time range".into());
    }
    if chunk.sample_count == 0 || chunk.byte_len == 0 {
        return Err("audio chunk sample and byte counts must be positive".into());
    }
    if chunk.sha256.len() != 64 || !chunk.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("audio chunk sha256 must be 64 hexadecimal characters".into());
    }
    if chunk.relative_path.is_empty()
        || chunk.relative_path.starts_with('/')
        || chunk.relative_path.split('/').any(|part| part == "..")
    {
        return Err("audio chunk path must be a contained relative path".into());
    }
    Ok(())
}

pub(crate) fn validate_transcript_batch(batch: &TranscriptBatch) -> Result<(), String> {
    validate_id(&batch.meeting_id, "meeting id")?;
    validate_id(&batch.batch_id, "transcript batch id")?;
    if batch.source.trim().is_empty() || batch.source.len() > 160 {
        return Err("transcript source must contain 1 to 160 bytes".into());
    }
    if batch.changes.is_empty() && !batch.marks_final {
        return Err("transcript batch must contain a change or mark the transcript final".into());
    }
    if batch.changes.len() > MAX_TRANSCRIPT_CHANGES {
        return Err(format!(
            "transcript batch exceeds {MAX_TRANSCRIPT_CHANGES} changes"
        ));
    }
    let mut touched = std::collections::HashSet::new();
    for change in &batch.changes {
        let key = match change {
            TranscriptChange::UpsertSegment { segment } => {
                validate_segment(segment)?;
                format!("segment:{}", segment.id)
            }
            TranscriptChange::DeleteSegment { segment_id } => {
                validate_id(segment_id, "transcript segment id")?;
                format!("segment:{segment_id}")
            }
            TranscriptChange::OpenGap { gap } => {
                validate_gap(gap)?;
                format!("gap:{}", gap.id)
            }
            TranscriptChange::ResolveGap { gap_id } => {
                validate_id(gap_id, "transcript gap id")?;
                format!("gap:{gap_id}")
            }
        };
        if !touched.insert(key.clone()) {
            return Err(format!("transcript batch changes '{key}' more than once"));
        }
    }
    Ok(())
}

fn validate_segment(segment: &TranscriptSegmentInput) -> Result<(), String> {
    validate_id(&segment.id, "transcript segment id")?;
    if segment.start_ms < 0 || segment.end_ms <= segment.start_ms {
        return Err("transcript segment must have a non-negative, increasing time range".into());
    }
    if segment.text.trim().is_empty() {
        return Err("transcript segment text cannot be empty".into());
    }
    if segment.text.len() > MAX_TRANSCRIPT_TEXT_BYTES {
        return Err(format!(
            "transcript segment text exceeds {MAX_TRANSCRIPT_TEXT_BYTES} bytes"
        ));
    }
    if let Some(channel_id) = &segment.channel_id {
        validate_id(channel_id, "audio channel id")?;
    }
    if segment
        .speaker
        .as_ref()
        .is_some_and(|value| value.len() > 256)
    {
        return Err("transcript speaker exceeds 256 bytes".into());
    }
    if let Some(confidence) = segment.confidence {
        if !confidence.is_finite() || !(0.0..=1.0).contains(&confidence) {
            return Err("transcript confidence must be between 0 and 1".into());
        }
    }
    validate_json_size(
        &segment.metadata,
        MAX_METADATA_BYTES,
        "transcript segment metadata",
    )?;
    Ok(())
}

fn validate_gap(gap: &TranscriptGapInput) -> Result<(), String> {
    validate_id(&gap.id, "transcript gap id")?;
    if gap.start_ms < 0 || gap.end_ms <= gap.start_ms {
        return Err("transcript gap must have a non-negative, increasing time range".into());
    }
    if let Some(channel_id) = &gap.channel_id {
        validate_id(channel_id, "audio channel id")?;
    }
    if gap.detail.as_ref().is_some_and(|value| value.len() > 4_096) {
        return Err("transcript gap detail exceeds 4096 bytes".into());
    }
    Ok(())
}

pub(crate) fn validate_job_draft(job: &FollowUpJobDraft) -> Result<(), String> {
    validate_id(&job.id, "job id")?;
    validate_id(&job.meeting_id, "meeting id")?;
    validate_id(&job.idempotency_key, "job idempotency key")?;
    if job.max_attempts == 0 || job.max_attempts > MAX_JOB_ATTEMPTS {
        return Err(format!(
            "job max attempts must be between 1 and {MAX_JOB_ATTEMPTS}"
        ));
    }
    if let FollowUpJobKind::Custom(name) = &job.kind {
        validate_id(name, "custom job kind")?;
    }
    validate_json_size(&job.payload, MAX_JOB_PAYLOAD_BYTES, "job payload")?;
    Ok(())
}

pub(crate) fn validate_job_result(value: &Value) -> Result<(), String> {
    validate_json_size(value, MAX_JOB_RESULT_BYTES, "job result")
}

fn validate_json_size(value: &Value, maximum: usize, label: &str) -> Result<(), String> {
    let bytes = serde_json::to_vec(value)
        .map_err(|error| format!("{label} could not be serialized: {error}"))?;
    if bytes.len() > maximum {
        return Err(format!("{label} exceeds {maximum} serialized bytes"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gherkin_terminal_states_never_reopen_through_the_generic_transition_api() {
        // Explicit continuation is an atomic store operation with a transcript
        // barrier; the generic lifecycle transition API remains closed.
        for terminal in [
            MeetingStatus::Completed,
            MeetingStatus::Failed,
            MeetingStatus::Discarded,
        ] {
            for candidate in [
                MeetingStatus::Detected,
                MeetingStatus::Recording,
                MeetingStatus::Stopping,
                MeetingStatus::Finalizing,
                MeetingStatus::Completed,
                MeetingStatus::Interrupted,
                MeetingStatus::Failed,
                MeetingStatus::Discarded,
            ] {
                assert_eq!(
                    terminal.can_transition_to(candidate),
                    terminal == candidate,
                    "{terminal} -> {candidate}"
                );
            }
        }
    }

    #[test]
    fn gherkin_happy_path_and_interruption_recovery_are_explicit() {
        let happy_path = [
            MeetingStatus::Detected,
            MeetingStatus::Recording,
            MeetingStatus::Stopping,
            MeetingStatus::Finalizing,
            MeetingStatus::Completed,
        ];
        for pair in happy_path.windows(2) {
            assert!(pair[0].can_transition_to(pair[1]));
        }
        assert!(MeetingStatus::Recording.can_transition_to(MeetingStatus::Interrupted));
        assert!(MeetingStatus::Stopping.can_transition_to(MeetingStatus::Interrupted));
        assert!(MeetingStatus::Finalizing.can_transition_to(MeetingStatus::Interrupted));
        assert!(MeetingStatus::Interrupted.can_transition_to(MeetingStatus::Finalizing));
        assert!(!MeetingStatus::Interrupted.can_transition_to(MeetingStatus::Recording));
    }

    #[test]
    fn gherkin_a_batch_cannot_mutate_one_entity_twice() {
        let batch = TranscriptBatch {
            meeting_id: "meeting-1".into(),
            batch_id: "batch-1".into(),
            base_revision: 0,
            source: "local-whisper".into(),
            observed_at: "2026-07-30T10:00:00Z".into(),
            marks_final: false,
            changes: vec![
                TranscriptChange::UpsertSegment {
                    segment: TranscriptSegmentInput {
                        id: "segment-1".into(),
                        start_ms: 0,
                        end_ms: 100,
                        text: "First".into(),
                        channel_id: None,
                        speaker: None,
                        confidence: None,
                        is_final: false,
                        metadata: Value::Null,
                    },
                },
                TranscriptChange::DeleteSegment {
                    segment_id: "segment-1".into(),
                },
            ],
        };
        assert!(validate_transcript_batch(&batch)
            .unwrap_err()
            .contains("more than once"));
    }

    #[test]
    fn gherkin_audio_paths_cannot_escape_the_meeting_root() {
        let chunk = AudioChunkDraft {
            id: "chunk-1".into(),
            meeting_id: "meeting-1".into(),
            channel_id: "mic".into(),
            sequence: 0,
            start_ms: 0,
            end_ms: 100,
            sample_count: 4_800,
            byte_len: 9_600,
            sha256: "a".repeat(64),
            relative_path: "../keys.env".into(),
        };
        assert!(validate_audio_chunk(&chunk).is_err());
    }
}
