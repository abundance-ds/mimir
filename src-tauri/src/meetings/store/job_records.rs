use super::*;

pub(super) fn load_audio_chunk_optional_tx(
    transaction: &Transaction<'_>,
    chunk_id: &str,
) -> Result<Option<(AudioChunk, String)>, MeetingStoreError> {
    Ok(transaction
        .query_row(
            "SELECT id,meeting_id,channel_id,sequence,start_ms,end_ms,sample_count,
                    byte_len,sha256,relative_path,status,staged_at,committed_at,
                    fingerprint,integrity_error
             FROM audio_chunks WHERE id=?1",
            [chunk_id],
            audio_chunk_from_row,
        )
        .optional()?)
}

pub(super) fn audio_chunk_from_row(row: &Row<'_>) -> rusqlite::Result<(AudioChunk, String)> {
    let status: String = row.get(10)?;
    Ok((
        AudioChunk {
            definition: AudioChunkDraft {
                id: row.get(0)?,
                meeting_id: row.get(1)?,
                channel_id: row.get(2)?,
                sequence: row.get::<_, i64>(3)? as u64,
                start_ms: row.get(4)?,
                end_ms: row.get(5)?,
                sample_count: row.get::<_, i64>(6)? as u64,
                byte_len: row.get::<_, i64>(7)? as u64,
                sha256: row.get(8)?,
                relative_path: row.get(9)?,
            },
            status: audio_chunk_status(&status).map_err(text_from_sql_error)?,
            staged_at: row.get(11)?,
            committed_at: row.get(12)?,
            integrity_error: row.get(14)?,
        },
        row.get(13)?,
    ))
}

pub(super) fn load_staged_audio_chunks_tx(
    transaction: &Transaction<'_>,
) -> Result<Vec<AudioChunk>, MeetingStoreError> {
    let mut statement = transaction.prepare(
        "SELECT id,meeting_id,channel_id,sequence,start_ms,end_ms,sample_count,
                byte_len,sha256,relative_path,status,staged_at,committed_at,
                fingerprint,integrity_error
         FROM audio_chunks WHERE status='staged'
         ORDER BY meeting_id,channel_id,sequence",
    )?;
    let chunks = statement
        .query_map([], audio_chunk_from_row)?
        .map(|result| result.map(|(chunk, _)| chunk))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(chunks)
}

pub(super) fn load_job(
    connection: &Connection,
    job_id: &str,
) -> Result<FollowUpJob, MeetingStoreError> {
    connection
        .query_row(
            "SELECT id,meeting_id,kind,idempotency_key,payload_json,state,attempts,
                    max_attempts,not_before,created_at,updated_at,lease_owner,
                    lease_token,lease_expires_at,last_error,result_json
             FROM follow_up_jobs WHERE id=?1",
            [job_id],
            job_from_row,
        )
        .optional()?
        .ok_or_else(|| not_found("follow-up job", job_id))
}

pub(super) fn load_job_tx(
    transaction: &Transaction<'_>,
    job_id: &str,
) -> Result<FollowUpJob, MeetingStoreError> {
    transaction
        .query_row(
            "SELECT id,meeting_id,kind,idempotency_key,payload_json,state,attempts,
                    max_attempts,not_before,created_at,updated_at,lease_owner,
                    lease_token,lease_expires_at,last_error,result_json
             FROM follow_up_jobs WHERE id=?1",
            [job_id],
            job_from_row,
        )
        .optional()?
        .ok_or_else(|| not_found("follow-up job", job_id))
}

pub(super) fn load_job_by_idempotency_tx(
    transaction: &Transaction<'_>,
    meeting_id: &str,
    idempotency_key: &str,
) -> Result<Option<(FollowUpJob, String)>, MeetingStoreError> {
    let row: Option<(String, String)> = transaction
        .query_row(
            "SELECT id,request_hash FROM follow_up_jobs
             WHERE meeting_id=?1 AND idempotency_key=?2",
            params![meeting_id, idempotency_key],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    row.map(|(job_id, request_hash)| Ok((load_job_tx(transaction, &job_id)?, request_hash)))
        .transpose()
}

pub(super) fn job_from_row(row: &Row<'_>) -> rusqlite::Result<FollowUpJob> {
    let kind: String = row.get(2)?;
    let payload: String = row.get(4)?;
    let state: String = row.get(5)?;
    let result: Option<String> = row.get(15)?;
    Ok(FollowUpJob {
        definition: FollowUpJobDraft {
            id: row.get(0)?,
            meeting_id: row.get(1)?,
            kind: FollowUpJobKind::from_storage_key(&kind),
            idempotency_key: row.get(3)?,
            payload: serde_json::from_str(&payload).map_err(json_from_sql_error)?,
            max_attempts: row.get(7)?,
            not_before: row.get(8)?,
        },
        state: job_state(&state).map_err(text_from_sql_error)?,
        attempts: row.get(6)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
        lease_owner: row.get(11)?,
        lease_token: row.get(12)?,
        lease_expires_at: row.get(13)?,
        last_error: row.get(14)?,
        result: result
            .map(|value| serde_json::from_str(&value).map_err(json_from_sql_error))
            .transpose()?,
    })
}
