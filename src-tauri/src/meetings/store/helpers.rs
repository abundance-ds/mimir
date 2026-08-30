use super::*;

pub(super) fn require_meeting(
    connection: &Connection,
    meeting_id: &str,
) -> Result<(), MeetingStoreError> {
    let exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM meetings WHERE id=?1)",
        [meeting_id],
        |row| row.get(0),
    )?;
    exists
        .then_some(())
        .ok_or_else(|| not_found("meeting", meeting_id))
}

pub(super) fn require_meeting_tx(
    transaction: &Transaction<'_>,
    meeting_id: &str,
) -> Result<(), MeetingStoreError> {
    let exists: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM meetings WHERE id=?1)",
        [meeting_id],
        |row| row.get(0),
    )?;
    exists
        .then_some(())
        .ok_or_else(|| not_found("meeting", meeting_id))
}

pub(super) fn require_channel_tx(
    transaction: &Transaction<'_>,
    meeting_id: &str,
    channel_id: &str,
) -> Result<(), MeetingStoreError> {
    let exists: bool = transaction.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM audio_channels WHERE meeting_id=?1 AND id=?2
         )",
        params![meeting_id, channel_id],
        |row| row.get(0),
    )?;
    exists
        .then_some(())
        .ok_or_else(|| not_found("audio channel", channel_id))
}

pub(super) fn timestamp(value: &str) -> Result<String, MeetingStoreError> {
    DateTime::parse_from_rfc3339(value)
        .map(|value| {
            value
                .with_timezone(&Utc)
                .to_rfc3339_opts(SecondsFormat::Millis, true)
        })
        .map_err(|error| {
            MeetingStoreError::Validation(format!("invalid RFC 3339 timestamp '{value}': {error}"))
        })
}

pub(super) fn transcript_batch_fingerprint(
    batch: &TranscriptBatch,
    canonical_observed_at: &str,
) -> Result<String, MeetingStoreError> {
    let mut canonical = batch.clone();
    canonical.observed_at = canonical_observed_at.into();
    fingerprint(&canonical)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JobIntentFingerprint<'a> {
    meeting_id: &'a str,
    kind: &'a FollowUpJobKind,
    idempotency_key: &'a str,
    payload: &'a serde_json::Value,
    max_attempts: u32,
    not_before: &'a str,
}

pub(super) fn job_fingerprint(
    job: &FollowUpJobDraft,
    canonical_not_before: &str,
) -> Result<String, MeetingStoreError> {
    fingerprint(&JobIntentFingerprint {
        meeting_id: &job.meeting_id,
        kind: &job.kind,
        idempotency_key: &job.idempotency_key,
        payload: &job.payload,
        max_attempts: job.max_attempts,
        not_before: canonical_not_before,
    })
}

pub(super) fn fingerprint<T: Serialize>(value: &T) -> Result<String, MeetingStoreError> {
    let bytes = serde_json::to_vec(value)?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

pub(super) fn release_expired_jobs(
    transaction: &Transaction<'_>,
    observed_at: &str,
) -> Result<(), MeetingStoreError> {
    transaction.execute(
        "UPDATE follow_up_jobs SET
           state='cancelled',result_json=NULL,
           last_error='expired result discarded by permanent meeting deletion',
           lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=?1
         WHERE state='running' AND lease_expires_at<=?1
           AND EXISTS (
             SELECT 1 FROM meeting_deletions d
             WHERE d.meeting_id=follow_up_jobs.meeting_id AND d.mode='all'
           )",
        [observed_at],
    )?;
    transaction.execute(
        "UPDATE follow_up_jobs SET
           state=CASE WHEN attempts>=max_attempts THEN 'failed' ELSE 'pending' END,
           not_before=CASE WHEN attempts>=max_attempts THEN not_before ELSE ?1 END,
           last_error='worker lease expired before completion',
           lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=?1
         WHERE state='running' AND lease_expires_at<=?1
           AND NOT EXISTS (
             SELECT 1 FROM meeting_deletions d
             WHERE d.meeting_id=follow_up_jobs.meeting_id AND d.mode='all'
           )",
        [observed_at],
    )?;
    Ok(())
}

pub(super) fn json<T: Serialize>(value: T) -> Result<String, MeetingStoreError> {
    Ok(serde_json::to_string(&value)?)
}

pub(super) fn query_strings(
    transaction: &Transaction<'_>,
    sql: &str,
) -> Result<Vec<String>, MeetingStoreError> {
    let mut statement = transaction.prepare(sql)?;
    let values = statement
        .query_map([], |row| row.get(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(values)
}

pub(super) fn to_i64(value: u64) -> Result<i64, MeetingStoreError> {
    i64::try_from(value).map_err(|_| {
        MeetingStoreError::Validation(format!("value {value} exceeds SQLite integer range"))
    })
}

pub(super) fn from_i64(value: i64, label: &str) -> Result<u64, MeetingStoreError> {
    u64::try_from(value)
        .map_err(|_| MeetingStoreError::Validation(format!("{label} cannot be negative")))
}

pub(super) fn not_found(entity: &'static str, id: &str) -> MeetingStoreError {
    MeetingStoreError::NotFound {
        entity,
        id: id.into(),
    }
}

pub(super) fn meeting_status(value: &str) -> Result<MeetingStatus, String> {
    Ok(match value {
        "detected" => MeetingStatus::Detected,
        "recording" => MeetingStatus::Recording,
        "stopping" => MeetingStatus::Stopping,
        "finalizing" => MeetingStatus::Finalizing,
        "completed" => MeetingStatus::Completed,
        "interrupted" => MeetingStatus::Interrupted,
        "failed" => MeetingStatus::Failed,
        "discarded" => MeetingStatus::Discarded,
        other => return Err(format!("unknown meeting status '{other}'")),
    })
}

pub(super) fn channel_kind(value: &str) -> Result<AudioChannelKind, String> {
    Ok(match value {
        "microphone" => AudioChannelKind::Microphone,
        "system" => AudioChannelKind::System,
        "mixed" => AudioChannelKind::Mixed,
        "imported" => AudioChannelKind::Imported,
        other => return Err(format!("unknown audio channel kind '{other}'")),
    })
}

pub(super) fn audio_chunk_status(value: &str) -> Result<AudioChunkStatus, String> {
    Ok(match value {
        "staged" => AudioChunkStatus::Staged,
        "committed" => AudioChunkStatus::Committed,
        "corrupt" => AudioChunkStatus::Corrupt,
        other => return Err(format!("unknown audio chunk status '{other}'")),
    })
}

pub(super) fn gap_reason(value: &str) -> Result<TranscriptGapReason, String> {
    Ok(match value {
        "capture-unavailable" => TranscriptGapReason::CaptureUnavailable,
        "device-changed" => TranscriptGapReason::DeviceChanged,
        "buffer-overflow" => TranscriptGapReason::BufferOverflow,
        "transcription-failed" => TranscriptGapReason::TranscriptionFailed,
        "unsupported-audio" => TranscriptGapReason::UnsupportedAudio,
        "unknown" => TranscriptGapReason::Unknown,
        other => return Err(format!("unknown transcript gap reason '{other}'")),
    })
}

pub(super) fn job_state(value: &str) -> Result<JobState, String> {
    Ok(match value {
        "pending" => JobState::Pending,
        "running" => JobState::Running,
        "succeeded" => JobState::Succeeded,
        "failed" => JobState::Failed,
        "cancelled" => JobState::Cancelled,
        other => return Err(format!("unknown job state '{other}'")),
    })
}

pub(super) fn json_from_sql_error(error: serde_json::Error) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
}

pub(super) fn text_from_sql_error(error: String) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        0,
        rusqlite::types::Type::Text,
        Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, error)),
    )
}
