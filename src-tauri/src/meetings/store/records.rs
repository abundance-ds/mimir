use super::*;

pub(super) fn load_meeting(
    connection: &Connection,
    meeting_id: &str,
) -> Result<MeetingRecord, MeetingStoreError> {
    reject_permanent_deletion(connection, meeting_id)?;
    let mut meeting = connection
        .query_row(
            "SELECT id,title,origin_json,status,created_at,updated_at,started_at,
                    stopped_at,finalized_at,interrupted_at,interruption_reason,
                    failure_code,failure_message,failure_retryable,revision,
                    transcript_revision,recovery_count,metadata_json
             FROM meetings WHERE id=?1",
            [meeting_id],
            meeting_from_row,
        )
        .optional()?
        .ok_or_else(|| not_found("meeting", meeting_id))?;
    meeting.channels = load_channels(connection, meeting_id)?;
    Ok(meeting)
}

pub(super) fn load_meeting_tx(
    transaction: &Transaction<'_>,
    meeting_id: &str,
) -> Result<MeetingRecord, MeetingStoreError> {
    reject_permanent_deletion(transaction, meeting_id)?;
    let mut meeting = transaction
        .query_row(
            "SELECT id,title,origin_json,status,created_at,updated_at,started_at,
                    stopped_at,finalized_at,interrupted_at,interruption_reason,
                    failure_code,failure_message,failure_retryable,revision,
                    transcript_revision,recovery_count,metadata_json
             FROM meetings WHERE id=?1",
            [meeting_id],
            meeting_from_row,
        )
        .optional()?
        .ok_or_else(|| not_found("meeting", meeting_id))?;
    meeting.channels = load_channels(transaction, meeting_id)?;
    Ok(meeting)
}

pub(super) fn load_deletion_optional(
    connection: &Connection,
    meeting_id: &str,
) -> Result<Option<MeetingDeletion>, MeetingStoreError> {
    connection
        .query_row(
            "SELECT meeting_id,mode,stage,requested_at,updated_at,last_error
             FROM meeting_deletions WHERE meeting_id=?1",
            [meeting_id],
            deletion_from_row,
        )
        .optional()
        .map_err(MeetingStoreError::from)
}

pub(super) fn load_deletion_optional_tx(
    transaction: &Transaction<'_>,
    meeting_id: &str,
) -> Result<Option<MeetingDeletion>, MeetingStoreError> {
    transaction
        .query_row(
            "SELECT meeting_id,mode,stage,requested_at,updated_at,last_error
             FROM meeting_deletions WHERE meeting_id=?1",
            [meeting_id],
            deletion_from_row,
        )
        .optional()
        .map_err(MeetingStoreError::from)
}

pub(super) fn deletion_from_row(row: &Row<'_>) -> rusqlite::Result<MeetingDeletion> {
    let mode = row.get::<_, String>(1)?;
    let stage = row.get::<_, String>(2)?;
    Ok(MeetingDeletion {
        meeting_id: row.get(0)?,
        mode: deletion_mode(&mode).map_err(text_from_sql_error)?,
        stage: deletion_stage(&stage).map_err(text_from_sql_error)?,
        requested_at: row.get(3)?,
        updated_at: row.get(4)?,
        running_jobs: 0,
        last_error: row.get(5)?,
    })
}

pub(super) fn deletion_mode(value: &str) -> Result<MeetingDeletionMode, String> {
    match value {
        "audio" => Ok(MeetingDeletionMode::Audio),
        "all" => Ok(MeetingDeletionMode::All),
        other => Err(format!("unknown meeting deletion mode '{other}'")),
    }
}

pub(super) fn deletion_stage(value: &str) -> Result<MeetingDeletionStage, String> {
    match value {
        "waiting-for-jobs" => Ok(MeetingDeletionStage::WaitingForJobs),
        "files-pending" => Ok(MeetingDeletionStage::FilesPending),
        "database-pending" => Ok(MeetingDeletionStage::DatabasePending),
        "marker-cleanup-pending" => Ok(MeetingDeletionStage::MarkerCleanupPending),
        other => Err(format!("unknown meeting deletion stage '{other}'")),
    }
}

pub(super) fn running_job_count_tx(
    transaction: &Transaction<'_>,
    meeting_id: &str,
) -> Result<u32, MeetingStoreError> {
    let count: i64 = transaction.query_row(
        "SELECT COUNT(*) FROM follow_up_jobs
         WHERE meeting_id=?1 AND state='running'",
        [meeting_id],
        |row| row.get(0),
    )?;
    u32::try_from(count)
        .map_err(|_| MeetingStoreError::Validation("running job count overflow".into()))
}

pub(super) fn deletion_capture_pending_tx(
    transaction: &Transaction<'_>,
    meeting_id: &str,
) -> Result<bool, MeetingStoreError> {
    Ok(transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM meetings WHERE id=?1 AND status IN ('recording','stopping','finalizing'))",
        [meeting_id], |row| row.get(0),
    )?)
}

pub(super) fn refresh_deletion_tx(
    transaction: &Transaction<'_>,
    mut deletion: MeetingDeletion,
    observed_at: &str,
) -> Result<MeetingDeletion, MeetingStoreError> {
    if deletion.mode == MeetingDeletionMode::All
        && deletion.stage == MeetingDeletionStage::WaitingForJobs
    {
        deletion.running_jobs = running_job_count_tx(transaction, &deletion.meeting_id)?;
        if deletion.running_jobs == 0
            && !deletion_capture_pending_tx(transaction, &deletion.meeting_id)?
        {
            transaction.execute(
                "UPDATE meeting_deletions SET
                   stage='files-pending',updated_at=?2,last_error=NULL
                 WHERE meeting_id=?1 AND stage='waiting-for-jobs'",
                params![deletion.meeting_id, observed_at],
            )?;
            deletion.stage = MeetingDeletionStage::FilesPending;
            deletion.updated_at = observed_at.into();
        }
    } else if deletion.mode == MeetingDeletionMode::All {
        deletion.running_jobs = running_job_count_tx(transaction, &deletion.meeting_id)?;
    }
    Ok(deletion)
}

pub(super) fn deletion_blocks_job_tx(
    transaction: &Transaction<'_>,
    meeting_id: &str,
    kind: &FollowUpJobKind,
) -> Result<bool, MeetingStoreError> {
    let mode: Option<String> = transaction
        .query_row(
            "SELECT mode FROM meeting_deletions WHERE meeting_id=?1",
            [meeting_id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(match mode.as_deref() {
        Some("all") => true,
        Some("audio") => matches!(kind, FollowUpJobKind::Custom(name) if name == "transcription"),
        _ => false,
    })
}

pub(super) fn deletion_in_progress_tx(
    transaction: &Transaction<'_>,
    meeting_id: &str,
) -> Result<MeetingStoreError, MeetingStoreError> {
    let deletion = load_deletion_optional_tx(transaction, meeting_id)?
        .ok_or_else(|| not_found("meeting deletion", meeting_id))?;
    Ok(MeetingStoreError::DeletionInProgress {
        meeting_id: meeting_id.into(),
        stage: deletion.stage.storage_key(),
    })
}

pub(super) fn reject_permanent_deletion(
    connection: &Connection,
    meeting_id: &str,
) -> Result<(), MeetingStoreError> {
    let deletion = load_deletion_optional(connection, meeting_id)?;
    if let Some(deletion) = deletion.filter(|value| value.mode == MeetingDeletionMode::All) {
        return Err(MeetingStoreError::DeletionInProgress {
            meeting_id: meeting_id.into(),
            stage: deletion.stage.storage_key(),
        });
    }
    Ok(())
}

pub(super) fn meeting_from_row(row: &Row<'_>) -> rusqlite::Result<MeetingRecord> {
    let origin: String = row.get(2)?;
    let status: String = row.get(3)?;
    let failure_code: Option<String> = row.get(11)?;
    let metadata: String = row.get(17)?;
    Ok(MeetingRecord {
        id: row.get(0)?,
        title: row.get(1)?,
        origin: serde_json::from_str(&origin).map_err(json_from_sql_error)?,
        status: meeting_status(&status).map_err(text_from_sql_error)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
        started_at: row.get(6)?,
        stopped_at: row.get(7)?,
        finalized_at: row.get(8)?,
        interrupted_at: row.get(9)?,
        interruption_reason: row.get(10)?,
        failure: failure_code.map(|code| MeetingFailure {
            code,
            message: row
                .get::<_, Option<String>>(12)
                .ok()
                .flatten()
                .unwrap_or_default(),
            retryable: row
                .get::<_, Option<bool>>(13)
                .ok()
                .flatten()
                .unwrap_or(false),
        }),
        revision: row.get::<_, i64>(14)? as u64,
        transcript_revision: row.get::<_, i64>(15)? as u64,
        recovery_count: row.get::<_, i64>(16)? as u32,
        metadata: serde_json::from_str(&metadata).map_err(json_from_sql_error)?,
        channels: Vec::new(),
    })
}
