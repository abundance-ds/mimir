use super::model::{
    validate_audio_chunk, validate_id, validate_job_draft, validate_job_result,
    validate_meeting_draft, validate_transcript_batch, AudioChannel, AudioChannelDraft,
    AudioChannelKind, AudioChunk, AudioChunkDraft, AudioChunkStatus, FollowUpJob, FollowUpJobDraft,
    FollowUpJobKind, JobFinish, JobState, MeetingDraft, MeetingFailure, MeetingRecord,
    MeetingStatus, RecoveryReport, TranscriptApplyResult, TranscriptBatch, TranscriptChange,
    TranscriptGapInput, TranscriptGapReason, TranscriptGapRecord, TranscriptRevision,
    TranscriptSegmentInput, TranscriptSegmentRecord, TranscriptSnapshot,
};
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row, Transaction, TransactionBehavior};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    sync::{Mutex, MutexGuard},
    time::Duration,
};
use thiserror::Error;
use uuid::Uuid;

pub const CURRENT_SCHEMA_VERSION: u32 = 1;
const APPLICATION_ID: i64 = 0x4d4d4554; // "MMET"

#[derive(Debug, Error)]
pub enum MeetingStoreError {
    #[error("meeting store database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("meeting store serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("invalid meeting data: {0}")]
    Validation(String),
    #[error("{entity} '{id}' was not found")]
    NotFound { entity: &'static str, id: String },
    #[error("revision conflict for meeting '{meeting_id}': expected {expected}, actual {actual}")]
    RevisionConflict {
        meeting_id: String,
        expected: u64,
        actual: u64,
    },
    #[error("meeting '{meeting_id}' cannot transition from {from} to {to}")]
    InvalidTransition {
        meeting_id: String,
        from: MeetingStatus,
        to: MeetingStatus,
    },
    #[error("idempotency key '{key}' was already used with different input")]
    IdempotencyConflict { key: String },
    #[error("job '{job_id}' is no longer owned by this worker lease")]
    LeaseLost { job_id: String },
    #[error("meeting database schema version {found} is newer than supported version {supported}")]
    UnsupportedSchemaVersion { found: u32, supported: u32 },
    #[error("meeting database belongs to another application (application_id={0})")]
    ForeignDatabase(i64),
    #[error("meeting store mutex was poisoned")]
    Poisoned,
}

pub struct MeetingStore {
    connection: Mutex<Connection>,
}

impl MeetingStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, MeetingStoreError> {
        let connection = Connection::open(path)?;
        Self::from_connection(connection)
    }

    pub fn open_in_memory() -> Result<Self, MeetingStoreError> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(mut connection: Connection) -> Result<Self, MeetingStoreError> {
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.pragma_update(None, "synchronous", "FULL")?;
        let _ = connection.pragma_update(None, "journal_mode", "WAL");
        migrate(&mut connection)?;
        let violations: i64 =
            connection.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                row.get(0)
            })?;
        if violations != 0 {
            return Err(MeetingStoreError::Validation(format!(
                "database contains {violations} foreign-key violations"
            )));
        }
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub fn schema_version(&self) -> Result<u32, MeetingStoreError> {
        let connection = self.lock()?;
        schema_version(&connection)
    }

    pub fn create_meeting(
        &self,
        draft: &MeetingDraft,
        observed_at: &str,
    ) -> Result<MeetingRecord, MeetingStoreError> {
        validate_meeting_draft(draft).map_err(MeetingStoreError::Validation)?;
        let observed_at = timestamp(observed_at)?;
        let origin = json(draft.origin.clone())?;
        let metadata = json(draft.metadata.clone())?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "INSERT INTO meetings (
               id,title,origin_json,status,created_at,updated_at,metadata_json
             ) VALUES (?1,?2,?3,'detected',?4,?4,?5)",
            params![draft.id, draft.title.trim(), origin, observed_at, metadata],
        )?;
        for channel in &draft.channels {
            insert_channel(&transaction, &draft.id, channel, &observed_at)?;
        }
        let meeting = load_meeting_tx(&transaction, &draft.id)?;
        transaction.commit()?;
        Ok(meeting)
    }

    pub fn get_meeting(&self, meeting_id: &str) -> Result<MeetingRecord, MeetingStoreError> {
        validate_id(meeting_id, "meeting id").map_err(MeetingStoreError::Validation)?;
        let connection = self.lock()?;
        load_meeting(&connection, meeting_id)
    }

    pub fn list_meetings(&self, limit: u32) -> Result<Vec<MeetingRecord>, MeetingStoreError> {
        let connection = self.lock()?;
        let mut statement = connection
            .prepare("SELECT id FROM meetings ORDER BY created_at DESC, id DESC LIMIT ?1")?;
        let ids = statement
            .query_map([limit.clamp(1, 1_000)], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        ids.into_iter()
            .map(|meeting_id| load_meeting(&connection, &meeting_id))
            .collect()
    }

    pub fn transition_meeting(
        &self,
        meeting_id: &str,
        expected_revision: u64,
        next: MeetingStatus,
        observed_at: &str,
        failure: Option<&MeetingFailure>,
    ) -> Result<MeetingRecord, MeetingStoreError> {
        validate_id(meeting_id, "meeting id").map_err(MeetingStoreError::Validation)?;
        let observed_at = timestamp(observed_at)?;
        if next == MeetingStatus::Failed && failure.is_none() {
            return Err(MeetingStoreError::Validation(
                "failed meetings require failure detail".into(),
            ));
        }
        if next != MeetingStatus::Failed && failure.is_some() {
            return Err(MeetingStoreError::Validation(
                "failure detail is valid only for the failed status".into(),
            ));
        }
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = load_meeting_tx(&transaction, meeting_id)?;
        if current.revision != expected_revision {
            return Err(MeetingStoreError::RevisionConflict {
                meeting_id: meeting_id.into(),
                expected: expected_revision,
                actual: current.revision,
            });
        }
        if current.status == next {
            transaction.commit()?;
            return Ok(current);
        }
        if !current.status.can_transition_to(next) {
            return Err(MeetingStoreError::InvalidTransition {
                meeting_id: meeting_id.into(),
                from: current.status,
                to: next,
            });
        }

        let failure_code = failure.map(|value| value.code.as_str());
        let failure_message = failure.map(|value| value.message.as_str());
        let failure_retryable = failure.map(|value| value.retryable);
        transaction.execute(
            "UPDATE meetings SET
               status=?2,
               updated_at=?3,
               revision=revision+1,
               started_at=CASE WHEN ?2='recording' THEN COALESCE(started_at,?3) ELSE started_at END,
               stopped_at=CASE WHEN ?2 IN ('stopping','finalizing') THEN COALESCE(stopped_at,?3) ELSE stopped_at END,
               finalized_at=CASE WHEN ?2='completed' THEN ?3 ELSE finalized_at END,
               interrupted_at=CASE WHEN ?2='interrupted' THEN ?3 ELSE interrupted_at END,
               failure_code=?4,
               failure_message=?5,
               failure_retryable=?6
             WHERE id=?1",
            params![
                meeting_id,
                next.to_string(),
                observed_at,
                failure_code,
                failure_message,
                failure_retryable
            ],
        )?;
        let meeting = load_meeting_tx(&transaction, meeting_id)?;
        transaction.commit()?;
        Ok(meeting)
    }

    pub fn stage_audio_chunk(
        &self,
        chunk: &AudioChunkDraft,
        observed_at: &str,
    ) -> Result<AudioChunk, MeetingStoreError> {
        validate_audio_chunk(chunk).map_err(MeetingStoreError::Validation)?;
        let observed_at = timestamp(observed_at)?;
        let fingerprint = fingerprint(chunk)?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let meeting = load_meeting_tx(&transaction, &chunk.meeting_id)?;
        if !matches!(
            meeting.status,
            MeetingStatus::Recording
                | MeetingStatus::Stopping
                | MeetingStatus::Finalizing
                | MeetingStatus::Interrupted
        ) {
            return Err(MeetingStoreError::Validation(format!(
                "meeting '{}' is {} and cannot accept audio chunks",
                chunk.meeting_id, meeting.status
            )));
        }
        require_channel_tx(&transaction, &chunk.meeting_id, &chunk.channel_id)?;

        if let Some((existing, existing_fingerprint)) =
            load_audio_chunk_optional_tx(&transaction, &chunk.id)?
        {
            if existing_fingerprint == fingerprint {
                transaction.commit()?;
                return Ok(existing);
            }
            return Err(MeetingStoreError::IdempotencyConflict {
                key: chunk.id.clone(),
            });
        }
        let sequence_owner: Option<String> = transaction
            .query_row(
                "SELECT id FROM audio_chunks
                 WHERE meeting_id=?1 AND channel_id=?2 AND sequence=?3",
                params![chunk.meeting_id, chunk.channel_id, to_i64(chunk.sequence)?],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(owner) = sequence_owner {
            return Err(MeetingStoreError::IdempotencyConflict {
                key: format!(
                    "{}:{}:{} (owned by {owner})",
                    chunk.meeting_id, chunk.channel_id, chunk.sequence
                ),
            });
        }
        transaction.execute(
            "INSERT INTO audio_chunks (
               id,meeting_id,channel_id,sequence,start_ms,end_ms,sample_count,
               byte_len,sha256,relative_path,status,staged_at,fingerprint,integrity_error
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,LOWER(?9),?10,'staged',?11,?12,NULL)",
            params![
                chunk.id,
                chunk.meeting_id,
                chunk.channel_id,
                to_i64(chunk.sequence)?,
                chunk.start_ms,
                chunk.end_ms,
                to_i64(chunk.sample_count)?,
                to_i64(chunk.byte_len)?,
                chunk.sha256,
                chunk.relative_path,
                observed_at,
                fingerprint
            ],
        )?;
        let (stored, _) = load_audio_chunk_optional_tx(&transaction, &chunk.id)?
            .expect("inserted audio chunk must exist");
        transaction.commit()?;
        Ok(stored)
    }

    pub fn mark_audio_chunk_corrupt(
        &self,
        chunk_id: &str,
        detail: &str,
        observed_at: &str,
    ) -> Result<AudioChunk, MeetingStoreError> {
        validate_id(chunk_id, "audio chunk id").map_err(MeetingStoreError::Validation)?;
        if detail.trim().is_empty() || detail.len() > 4_096 {
            return Err(MeetingStoreError::Validation(
                "audio integrity error must contain 1 to 4096 bytes".into(),
            ));
        }
        let observed_at = timestamp(observed_at)?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let Some((existing, _)) = load_audio_chunk_optional_tx(&transaction, chunk_id)? else {
            return Err(not_found("audio chunk", chunk_id));
        };
        if existing.status == AudioChunkStatus::Committed {
            return Err(MeetingStoreError::Validation(format!(
                "committed audio chunk '{chunk_id}' cannot be marked corrupt"
            )));
        }
        if existing.status == AudioChunkStatus::Corrupt {
            transaction.commit()?;
            return Ok(existing);
        }
        transaction.execute(
            "UPDATE audio_chunks
             SET status='corrupt',integrity_error=?2,committed_at=?3 WHERE id=?1",
            params![chunk_id, detail.trim(), observed_at],
        )?;
        let (stored, _) = load_audio_chunk_optional_tx(&transaction, chunk_id)?
            .expect("updated audio chunk must exist");
        transaction.commit()?;
        Ok(stored)
    }

    pub fn commit_audio_chunk(
        &self,
        chunk_id: &str,
        observed_at: &str,
    ) -> Result<AudioChunk, MeetingStoreError> {
        validate_id(chunk_id, "audio chunk id").map_err(MeetingStoreError::Validation)?;
        let observed_at = timestamp(observed_at)?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let Some((existing, _)) = load_audio_chunk_optional_tx(&transaction, chunk_id)? else {
            return Err(not_found("audio chunk", chunk_id));
        };
        if existing.status == AudioChunkStatus::Committed {
            transaction.commit()?;
            return Ok(existing);
        }
        if existing.status != AudioChunkStatus::Staged {
            return Err(MeetingStoreError::Validation(format!(
                "audio chunk '{chunk_id}' is {} and cannot be committed",
                existing.status
            )));
        }
        transaction.execute(
            "UPDATE audio_chunks
             SET status='committed', committed_at=?2 WHERE id=?1",
            params![chunk_id, observed_at],
        )?;
        let (stored, _) = load_audio_chunk_optional_tx(&transaction, chunk_id)?
            .expect("updated audio chunk must exist");
        transaction.commit()?;
        Ok(stored)
    }

    pub fn apply_transcript_batch(
        &self,
        batch: &TranscriptBatch,
    ) -> Result<TranscriptApplyResult, MeetingStoreError> {
        validate_transcript_batch(batch).map_err(MeetingStoreError::Validation)?;
        let observed_at = timestamp(&batch.observed_at)?;
        let batch_hash = transcript_batch_fingerprint(batch, &observed_at)?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let meeting = load_meeting_tx(&transaction, &batch.meeting_id)?;
        if !meeting.status.accepts_transcript_changes() {
            return Err(MeetingStoreError::Validation(format!(
                "meeting '{}' is {} and cannot accept transcript changes",
                batch.meeting_id, meeting.status
            )));
        }

        if let Some((stored_hash, revision)) = transaction
            .query_row(
                "SELECT batch_hash,revision FROM transcript_batches
                 WHERE meeting_id=?1 AND batch_id=?2",
                params![batch.meeting_id, batch.batch_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()?
        {
            if stored_hash == batch_hash {
                transaction.commit()?;
                return Ok(TranscriptApplyResult {
                    revision: from_i64(revision, "transcript revision")?,
                    duplicate: true,
                });
            }
            return Err(MeetingStoreError::IdempotencyConflict {
                key: batch.batch_id.clone(),
            });
        }
        if meeting.transcript_revision != batch.base_revision {
            return Err(MeetingStoreError::RevisionConflict {
                meeting_id: batch.meeting_id.clone(),
                expected: batch.base_revision,
                actual: meeting.transcript_revision,
            });
        }
        let revision = meeting
            .transcript_revision
            .checked_add(1)
            .ok_or_else(|| MeetingStoreError::Validation("transcript revision overflow".into()))?;
        transaction.execute(
            "INSERT INTO transcript_revisions (
               meeting_id,revision,base_revision,batch_id,source,observed_at,marks_final
             ) VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![
                batch.meeting_id,
                to_i64(revision)?,
                to_i64(batch.base_revision)?,
                batch.batch_id,
                batch.source.trim(),
                observed_at,
                batch.marks_final
            ],
        )?;
        for change in &batch.changes {
            apply_transcript_change(&transaction, &batch.meeting_id, revision, change)?;
        }
        transaction.execute(
            "INSERT INTO transcript_batches (
               meeting_id,batch_id,batch_hash,revision
             ) VALUES (?1,?2,?3,?4)",
            params![
                batch.meeting_id,
                batch.batch_id,
                batch_hash,
                to_i64(revision)?
            ],
        )?;
        transaction.execute(
            "UPDATE meetings SET transcript_revision=?2,revision=revision+1,updated_at=?3
             WHERE id=?1",
            params![batch.meeting_id, to_i64(revision)?, observed_at],
        )?;
        transaction.commit()?;
        Ok(TranscriptApplyResult {
            revision,
            duplicate: false,
        })
    }

    pub fn transcript_snapshot(
        &self,
        meeting_id: &str,
        revision: Option<u64>,
    ) -> Result<TranscriptSnapshot, MeetingStoreError> {
        validate_id(meeting_id, "meeting id").map_err(MeetingStoreError::Validation)?;
        let connection = self.lock()?;
        let meeting = load_meeting(&connection, meeting_id)?;
        let target = revision.unwrap_or(meeting.transcript_revision);
        if target > meeting.transcript_revision {
            return Err(MeetingStoreError::RevisionConflict {
                meeting_id: meeting_id.into(),
                expected: target,
                actual: meeting.transcript_revision,
            });
        }
        Ok(TranscriptSnapshot {
            meeting_id: meeting_id.into(),
            revision: target,
            segments: load_segments_at(&connection, meeting_id, target)?,
            gaps: load_gaps_at(&connection, meeting_id, target)?,
        })
    }

    pub fn transcript_revisions(
        &self,
        meeting_id: &str,
    ) -> Result<Vec<TranscriptRevision>, MeetingStoreError> {
        validate_id(meeting_id, "meeting id").map_err(MeetingStoreError::Validation)?;
        let connection = self.lock()?;
        require_meeting(&connection, meeting_id)?;
        let mut statement = connection.prepare(
            "SELECT meeting_id,revision,base_revision,batch_id,source,observed_at,marks_final
             FROM transcript_revisions WHERE meeting_id=?1 ORDER BY revision",
        )?;
        let rows = statement
            .query_map([meeting_id], |row| {
                Ok(TranscriptRevision {
                    meeting_id: row.get(0)?,
                    revision: row.get::<_, i64>(1)? as u64,
                    base_revision: row.get::<_, i64>(2)? as u64,
                    batch_id: row.get(3)?,
                    source: row.get(4)?,
                    observed_at: row.get(5)?,
                    marks_final: row.get(6)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn enqueue_job(
        &self,
        job: &FollowUpJobDraft,
        observed_at: &str,
    ) -> Result<(FollowUpJob, bool), MeetingStoreError> {
        validate_job_draft(job).map_err(MeetingStoreError::Validation)?;
        let observed_at = timestamp(observed_at)?;
        let not_before = timestamp(&job.not_before)?;
        let request_hash = job_fingerprint(job, &not_before)?;
        let payload = json(job.payload.clone())?;
        let kind = job.kind.as_storage_key();
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        require_meeting_tx(&transaction, &job.meeting_id)?;
        if let Some((existing, existing_hash)) =
            load_job_by_idempotency_tx(&transaction, &job.meeting_id, &job.idempotency_key)?
        {
            if existing_hash == request_hash {
                transaction.commit()?;
                return Ok((existing, true));
            }
            return Err(MeetingStoreError::IdempotencyConflict {
                key: job.idempotency_key.clone(),
            });
        }
        transaction.execute(
            "INSERT INTO follow_up_jobs (
               id,meeting_id,kind,idempotency_key,request_hash,payload_json,state,
               attempts,max_attempts,not_before,created_at,updated_at
             ) VALUES (?1,?2,?3,?4,?5,?6,'pending',0,?7,?8,?9,?9)",
            params![
                job.id,
                job.meeting_id,
                kind,
                job.idempotency_key,
                request_hash,
                payload,
                job.max_attempts,
                not_before,
                observed_at
            ],
        )?;
        let stored = load_job_tx(&transaction, &job.id)?;
        transaction.commit()?;
        Ok((stored, false))
    }

    pub fn claim_next_job(
        &self,
        worker_id: &str,
        observed_at: &str,
        lease_expires_at: &str,
    ) -> Result<Option<FollowUpJob>, MeetingStoreError> {
        validate_id(worker_id, "worker id").map_err(MeetingStoreError::Validation)?;
        let observed_at = timestamp(observed_at)?;
        let lease_expires_at = timestamp(lease_expires_at)?;
        if lease_expires_at <= observed_at {
            return Err(MeetingStoreError::Validation(
                "job lease must expire after it is claimed".into(),
            ));
        }
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        release_expired_jobs(&transaction, &observed_at)?;
        let job_id: Option<String> = transaction
            .query_row(
                "SELECT id FROM follow_up_jobs
                 WHERE state='pending' AND not_before<=?1 AND attempts<max_attempts
                 ORDER BY not_before,created_at,id LIMIT 1",
                [&observed_at],
                |row| row.get(0),
            )
            .optional()?;
        let Some(job_id) = job_id else {
            transaction.commit()?;
            return Ok(None);
        };
        let lease_token = Uuid::new_v4().to_string();
        let updated = transaction.execute(
            "UPDATE follow_up_jobs SET
               state='running',attempts=attempts+1,lease_owner=?2,lease_token=?3,
               lease_expires_at=?4,updated_at=?5
             WHERE id=?1 AND state='pending'",
            params![
                job_id,
                worker_id,
                lease_token,
                lease_expires_at,
                observed_at
            ],
        )?;
        if updated != 1 {
            return Err(MeetingStoreError::LeaseLost { job_id });
        }
        let job = load_job_tx(&transaction, &job_id)?;
        transaction.commit()?;
        Ok(Some(job))
    }

    pub fn finish_job(
        &self,
        job_id: &str,
        lease_token: &str,
        outcome: &JobFinish,
        observed_at: &str,
    ) -> Result<FollowUpJob, MeetingStoreError> {
        validate_id(job_id, "job id").map_err(MeetingStoreError::Validation)?;
        validate_id(lease_token, "job lease token").map_err(MeetingStoreError::Validation)?;
        let observed_at = timestamp(observed_at)?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = load_job_tx(&transaction, job_id)?;
        if current.state != JobState::Running || current.lease_token.as_deref() != Some(lease_token)
        {
            return Err(MeetingStoreError::LeaseLost {
                job_id: job_id.into(),
            });
        }
        match outcome {
            JobFinish::Succeeded { result } => {
                validate_job_result(result).map_err(MeetingStoreError::Validation)?;
                transaction.execute(
                    "UPDATE follow_up_jobs SET
                       state='succeeded',result_json=?2,last_error=NULL,
                       lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=?3
                     WHERE id=?1",
                    params![job_id, json(result)?, observed_at],
                )?;
            }
            JobFinish::Failed {
                error,
                retryable,
                retry_at,
            } => {
                if error.trim().is_empty() || error.len() > 16_384 {
                    return Err(MeetingStoreError::Validation(
                        "job error must contain 1 to 16384 bytes".into(),
                    ));
                }
                let retry = *retryable && current.attempts < current.definition.max_attempts;
                let retry_at = if retry {
                    timestamp(retry_at.as_deref().unwrap_or(&observed_at))?
                } else {
                    observed_at.clone()
                };
                transaction.execute(
                    "UPDATE follow_up_jobs SET
                       state=?2,not_before=?3,last_error=?4,result_json=NULL,
                       lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=?5
                     WHERE id=?1",
                    params![
                        job_id,
                        if retry { "pending" } else { "failed" },
                        retry_at,
                        error,
                        observed_at
                    ],
                )?;
            }
        }
        let job = load_job_tx(&transaction, job_id)?;
        transaction.commit()?;
        Ok(job)
    }

    pub fn cancel_job(
        &self,
        job_id: &str,
        observed_at: &str,
    ) -> Result<FollowUpJob, MeetingStoreError> {
        validate_id(job_id, "job id").map_err(MeetingStoreError::Validation)?;
        let observed_at = timestamp(observed_at)?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = load_job_tx(&transaction, job_id)?;
        if matches!(
            current.state,
            JobState::Succeeded | JobState::Failed | JobState::Cancelled
        ) {
            transaction.commit()?;
            return Ok(current);
        }
        transaction.execute(
            "UPDATE follow_up_jobs SET
               state='cancelled',lease_owner=NULL,lease_token=NULL,
               lease_expires_at=NULL,updated_at=?2
             WHERE id=?1",
            params![job_id, observed_at],
        )?;
        let job = load_job_tx(&transaction, job_id)?;
        transaction.commit()?;
        Ok(job)
    }

    pub fn list_jobs(&self, meeting_id: &str) -> Result<Vec<FollowUpJob>, MeetingStoreError> {
        validate_id(meeting_id, "meeting id").map_err(MeetingStoreError::Validation)?;
        let connection = self.lock()?;
        require_meeting(&connection, meeting_id)?;
        let mut statement = connection
            .prepare("SELECT id FROM follow_up_jobs WHERE meeting_id=?1 ORDER BY created_at,id")?;
        let ids = statement
            .query_map([meeting_id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        ids.into_iter()
            .map(|job_id| load_job(&connection, &job_id))
            .collect()
    }

    /// Reconcile process-owned state after an unclean or ordinary application
    /// restart. The transaction is intentionally idempotent:
    ///
    /// - active capture/finalization becomes `interrupted`;
    /// - every running job loses its process lease and is requeued unless its
    ///   attempt budget is exhausted;
    /// - staged chunks are reported but never guessed to be committed or
    ///   corrupt without a capture adapter checking their bytes.
    pub fn recover_after_restart(
        &self,
        observed_at: &str,
    ) -> Result<RecoveryReport, MeetingStoreError> {
        let observed_at = timestamp(observed_at)?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;

        let interrupted_meeting_ids = query_strings(
            &transaction,
            "SELECT id FROM meetings
             WHERE status IN ('recording','stopping','finalizing') ORDER BY id",
        )?;
        transaction.execute(
            "UPDATE meetings SET
               status='interrupted',interrupted_at=?1,
               interruption_reason='application-restarted',
               recovery_count=recovery_count+1,revision=revision+1,updated_at=?1
             WHERE status IN ('recording','stopping','finalizing')",
            [&observed_at],
        )?;

        let requeued_job_ids = query_strings(
            &transaction,
            "SELECT id FROM follow_up_jobs
             WHERE state='running' AND attempts<max_attempts ORDER BY id",
        )?;
        let failed_job_ids = query_strings(
            &transaction,
            "SELECT id FROM follow_up_jobs
             WHERE state='running' AND attempts>=max_attempts ORDER BY id",
        )?;
        transaction.execute(
            "UPDATE follow_up_jobs SET
               state=CASE WHEN attempts>=max_attempts THEN 'failed' ELSE 'pending' END,
               not_before=CASE WHEN attempts>=max_attempts THEN not_before ELSE ?1 END,
               last_error='worker lease lost during application restart',
               lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=?1
             WHERE state='running'",
            [&observed_at],
        )?;

        let staged_audio_chunks = load_staged_audio_chunks_tx(&transaction)?;
        transaction.commit()?;
        Ok(RecoveryReport {
            interrupted_meeting_ids,
            requeued_job_ids,
            failed_job_ids,
            staged_audio_chunks,
        })
    }

    fn lock(&self) -> Result<MutexGuard<'_, Connection>, MeetingStoreError> {
        self.connection
            .lock()
            .map_err(|_| MeetingStoreError::Poisoned)
    }
}

fn migrate(connection: &mut Connection) -> Result<(), MeetingStoreError> {
    let application_id: i64 =
        connection.pragma_query_value(None, "application_id", |row| row.get(0))?;
    if application_id != 0 && application_id != APPLICATION_ID {
        return Err(MeetingStoreError::ForeignDatabase(application_id));
    }
    let version = schema_version(connection)?;
    if version > CURRENT_SCHEMA_VERSION {
        return Err(MeetingStoreError::UnsupportedSchemaVersion {
            found: version,
            supported: CURRENT_SCHEMA_VERSION,
        });
    }
    if version == 0 {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        migration_v1(&transaction)?;
        transaction.pragma_update(None, "application_id", APPLICATION_ID)?;
        transaction.pragma_update(None, "user_version", 1)?;
        transaction.commit()?;
    }
    Ok(())
}

fn schema_version(connection: &Connection) -> Result<u32, MeetingStoreError> {
    Ok(connection.pragma_query_value(None, "user_version", |row| row.get(0))?)
}

fn migration_v1(transaction: &Transaction<'_>) -> Result<(), MeetingStoreError> {
    transaction.execute_batch(
        "CREATE TABLE meetings (
           id TEXT PRIMARY KEY,
           title TEXT NOT NULL,
           origin_json TEXT NOT NULL,
           status TEXT NOT NULL CHECK(status IN (
             'detected','recording','stopping','finalizing','completed',
             'interrupted','failed','discarded'
           )),
           created_at TEXT NOT NULL,
           updated_at TEXT NOT NULL,
           started_at TEXT,
           stopped_at TEXT,
           finalized_at TEXT,
           interrupted_at TEXT,
           interruption_reason TEXT,
           failure_code TEXT,
           failure_message TEXT,
           failure_retryable INTEGER,
           revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
           transcript_revision INTEGER NOT NULL DEFAULT 0 CHECK(transcript_revision>=0),
           recovery_count INTEGER NOT NULL DEFAULT 0 CHECK(recovery_count>=0),
           metadata_json TEXT NOT NULL DEFAULT '{}'
         );

         CREATE TABLE audio_channels (
           meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
           id TEXT NOT NULL,
           kind TEXT NOT NULL CHECK(kind IN ('microphone','system','mixed','imported')),
           sample_rate_hz INTEGER NOT NULL CHECK(sample_rate_hz>0),
           channels INTEGER NOT NULL CHECK(channels>0),
           sample_format TEXT NOT NULL,
           device_id TEXT,
           created_at TEXT NOT NULL,
           PRIMARY KEY(meeting_id,id)
         );

         CREATE TABLE audio_chunks (
           id TEXT PRIMARY KEY,
           meeting_id TEXT NOT NULL,
           channel_id TEXT NOT NULL,
           sequence INTEGER NOT NULL CHECK(sequence>=0),
           start_ms INTEGER NOT NULL CHECK(start_ms>=0),
           end_ms INTEGER NOT NULL CHECK(end_ms>start_ms),
           sample_count INTEGER NOT NULL CHECK(sample_count>0),
           byte_len INTEGER NOT NULL CHECK(byte_len>0),
           sha256 TEXT NOT NULL,
           relative_path TEXT NOT NULL,
           status TEXT NOT NULL CHECK(status IN ('staged','committed','corrupt')),
           staged_at TEXT NOT NULL,
           committed_at TEXT,
           fingerprint TEXT NOT NULL,
           integrity_error TEXT,
           FOREIGN KEY(meeting_id,channel_id)
             REFERENCES audio_channels(meeting_id,id) ON DELETE CASCADE,
           UNIQUE(meeting_id,channel_id,sequence)
         );

         CREATE TABLE transcript_revisions (
           meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
           revision INTEGER NOT NULL CHECK(revision>0),
           base_revision INTEGER NOT NULL CHECK(base_revision>=0),
           batch_id TEXT NOT NULL,
           source TEXT NOT NULL,
           observed_at TEXT NOT NULL,
           marks_final INTEGER NOT NULL DEFAULT 0,
           PRIMARY KEY(meeting_id,revision),
           UNIQUE(meeting_id,batch_id),
           CHECK(revision=base_revision+1)
         );

         CREATE TABLE transcript_batches (
           meeting_id TEXT NOT NULL,
           batch_id TEXT NOT NULL,
           batch_hash TEXT NOT NULL,
           revision INTEGER NOT NULL,
           PRIMARY KEY(meeting_id,batch_id),
           FOREIGN KEY(meeting_id,revision)
             REFERENCES transcript_revisions(meeting_id,revision) ON DELETE CASCADE
         );

         CREATE TABLE transcript_segments (
           meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
           segment_id TEXT NOT NULL,
           start_ms INTEGER NOT NULL CHECK(start_ms>=0),
           end_ms INTEGER NOT NULL CHECK(end_ms>start_ms),
           text TEXT NOT NULL,
           channel_id TEXT,
           speaker TEXT,
           confidence REAL,
           is_final INTEGER NOT NULL DEFAULT 0,
           metadata_json TEXT NOT NULL DEFAULT '{}',
           created_revision INTEGER NOT NULL,
           updated_revision INTEGER NOT NULL,
           PRIMARY KEY(meeting_id,segment_id),
           FOREIGN KEY(meeting_id,created_revision)
             REFERENCES transcript_revisions(meeting_id,revision),
           FOREIGN KEY(meeting_id,updated_revision)
             REFERENCES transcript_revisions(meeting_id,revision),
           FOREIGN KEY(meeting_id,channel_id)
             REFERENCES audio_channels(meeting_id,id),
           CHECK(confidence IS NULL OR (confidence>=0.0 AND confidence<=1.0))
         );

         CREATE TABLE transcript_segment_versions (
           meeting_id TEXT NOT NULL,
           segment_id TEXT NOT NULL,
           revision INTEGER NOT NULL,
           operation TEXT NOT NULL CHECK(operation IN ('upsert','delete')),
           start_ms INTEGER,
           end_ms INTEGER,
           text TEXT,
           channel_id TEXT,
           speaker TEXT,
           confidence REAL,
           is_final INTEGER,
           metadata_json TEXT,
           created_revision INTEGER NOT NULL,
           PRIMARY KEY(meeting_id,segment_id,revision),
           FOREIGN KEY(meeting_id,revision)
             REFERENCES transcript_revisions(meeting_id,revision) ON DELETE CASCADE
         );

         CREATE TABLE transcript_gaps (
           meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
           gap_id TEXT NOT NULL,
           start_ms INTEGER NOT NULL CHECK(start_ms>=0),
           end_ms INTEGER NOT NULL CHECK(end_ms>start_ms),
           reason TEXT NOT NULL,
           channel_id TEXT,
           detail TEXT,
           created_revision INTEGER NOT NULL,
           resolved_revision INTEGER,
           PRIMARY KEY(meeting_id,gap_id),
           FOREIGN KEY(meeting_id,created_revision)
             REFERENCES transcript_revisions(meeting_id,revision),
           FOREIGN KEY(meeting_id,resolved_revision)
             REFERENCES transcript_revisions(meeting_id,revision),
           FOREIGN KEY(meeting_id,channel_id)
             REFERENCES audio_channels(meeting_id,id)
         );

         CREATE TABLE follow_up_jobs (
           id TEXT PRIMARY KEY,
           meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
           kind TEXT NOT NULL,
           idempotency_key TEXT NOT NULL,
           request_hash TEXT NOT NULL,
           payload_json TEXT NOT NULL,
           state TEXT NOT NULL CHECK(state IN (
             'pending','running','succeeded','failed','cancelled'
           )),
           attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
           max_attempts INTEGER NOT NULL CHECK(max_attempts>0),
           not_before TEXT NOT NULL,
           created_at TEXT NOT NULL,
           updated_at TEXT NOT NULL,
           lease_owner TEXT,
           lease_token TEXT,
           lease_expires_at TEXT,
           last_error TEXT,
           result_json TEXT,
           UNIQUE(meeting_id,idempotency_key),
           CHECK(
             (state='running' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL
               AND lease_expires_at IS NOT NULL)
             OR
             (state<>'running' AND lease_owner IS NULL AND lease_token IS NULL
               AND lease_expires_at IS NULL)
           )
         );

         CREATE INDEX idx_meetings_created ON meetings(created_at DESC,id DESC);
         CREATE INDEX idx_chunks_meeting_channel
           ON audio_chunks(meeting_id,channel_id,sequence);
         CREATE INDEX idx_segment_versions_revision
           ON transcript_segment_versions(meeting_id,revision,segment_id);
         CREATE INDEX idx_gaps_revision
           ON transcript_gaps(meeting_id,created_revision,resolved_revision);
         CREATE INDEX idx_jobs_claim
           ON follow_up_jobs(state,not_before,created_at,id);
         CREATE INDEX idx_jobs_meeting ON follow_up_jobs(meeting_id,created_at,id);",
    )?;
    Ok(())
}

fn insert_channel(
    transaction: &Transaction<'_>,
    meeting_id: &str,
    channel: &AudioChannelDraft,
    observed_at: &str,
) -> Result<(), MeetingStoreError> {
    transaction.execute(
        "INSERT INTO audio_channels (
           meeting_id,id,kind,sample_rate_hz,channels,sample_format,device_id,created_at
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        params![
            meeting_id,
            channel.id,
            channel.kind.to_string(),
            channel.sample_rate_hz,
            channel.channels,
            channel.sample_format,
            channel.device_id,
            observed_at
        ],
    )?;
    Ok(())
}

fn apply_transcript_change(
    transaction: &Transaction<'_>,
    meeting_id: &str,
    revision: u64,
    change: &TranscriptChange,
) -> Result<(), MeetingStoreError> {
    match change {
        TranscriptChange::UpsertSegment { segment } => {
            if let Some(channel_id) = &segment.channel_id {
                require_channel_tx(transaction, meeting_id, channel_id)?;
            }
            let created_revision: Option<i64> = transaction
                .query_row(
                    "SELECT created_revision FROM transcript_segment_versions
                     WHERE meeting_id=?1 AND segment_id=?2
                     ORDER BY revision DESC LIMIT 1",
                    params![meeting_id, segment.id],
                    |row| row.get(0),
                )
                .optional()?;
            let created_revision = created_revision
                .map(|value| from_i64(value, "created transcript revision"))
                .transpose()?
                .unwrap_or(revision);
            let metadata = json(segment.metadata.clone())?;
            transaction.execute(
                "INSERT INTO transcript_segment_versions (
                   meeting_id,segment_id,revision,operation,start_ms,end_ms,text,
                   channel_id,speaker,confidence,is_final,metadata_json,created_revision
                 ) VALUES (?1,?2,?3,'upsert',?4,?5,?6,?7,?8,?9,?10,?11,?12)",
                params![
                    meeting_id,
                    segment.id,
                    to_i64(revision)?,
                    segment.start_ms,
                    segment.end_ms,
                    segment.text,
                    segment.channel_id,
                    segment.speaker,
                    segment.confidence,
                    segment.is_final,
                    metadata,
                    to_i64(created_revision)?
                ],
            )?;
            transaction.execute(
                "INSERT INTO transcript_segments (
                   meeting_id,segment_id,start_ms,end_ms,text,channel_id,speaker,
                   confidence,is_final,metadata_json,created_revision,updated_revision
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
                 ON CONFLICT(meeting_id,segment_id) DO UPDATE SET
                   start_ms=excluded.start_ms,end_ms=excluded.end_ms,text=excluded.text,
                   channel_id=excluded.channel_id,speaker=excluded.speaker,
                   confidence=excluded.confidence,is_final=excluded.is_final,
                   metadata_json=excluded.metadata_json,updated_revision=excluded.updated_revision",
                params![
                    meeting_id,
                    segment.id,
                    segment.start_ms,
                    segment.end_ms,
                    segment.text,
                    segment.channel_id,
                    segment.speaker,
                    segment.confidence,
                    segment.is_final,
                    json(segment.metadata.clone())?,
                    to_i64(created_revision)?,
                    to_i64(revision)?
                ],
            )?;
        }
        TranscriptChange::DeleteSegment { segment_id } => {
            let created_revision: i64 = transaction
                .query_row(
                    "SELECT created_revision FROM transcript_segments
                     WHERE meeting_id=?1 AND segment_id=?2",
                    params![meeting_id, segment_id],
                    |row| row.get(0),
                )
                .optional()?
                .ok_or_else(|| not_found("transcript segment", segment_id))?;
            transaction.execute(
                "INSERT INTO transcript_segment_versions (
                   meeting_id,segment_id,revision,operation,created_revision
                 ) VALUES (?1,?2,?3,'delete',?4)",
                params![meeting_id, segment_id, to_i64(revision)?, created_revision],
            )?;
            transaction.execute(
                "DELETE FROM transcript_segments WHERE meeting_id=?1 AND segment_id=?2",
                params![meeting_id, segment_id],
            )?;
        }
        TranscriptChange::OpenGap { gap } => {
            if let Some(channel_id) = &gap.channel_id {
                require_channel_tx(transaction, meeting_id, channel_id)?;
            }
            let exists: bool = transaction.query_row(
                "SELECT EXISTS(
                   SELECT 1 FROM transcript_gaps WHERE meeting_id=?1 AND gap_id=?2
                 )",
                params![meeting_id, gap.id],
                |row| row.get(0),
            )?;
            if exists {
                return Err(MeetingStoreError::IdempotencyConflict {
                    key: gap.id.clone(),
                });
            }
            transaction.execute(
                "INSERT INTO transcript_gaps (
                   meeting_id,gap_id,start_ms,end_ms,reason,channel_id,detail,created_revision
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                params![
                    meeting_id,
                    gap.id,
                    gap.start_ms,
                    gap.end_ms,
                    gap.reason.to_string(),
                    gap.channel_id,
                    gap.detail,
                    to_i64(revision)?
                ],
            )?;
        }
        TranscriptChange::ResolveGap { gap_id } => {
            let open: bool = transaction
                .query_row(
                    "SELECT resolved_revision IS NULL FROM transcript_gaps
                     WHERE meeting_id=?1 AND gap_id=?2",
                    params![meeting_id, gap_id],
                    |row| row.get(0),
                )
                .optional()?
                .ok_or_else(|| not_found("transcript gap", gap_id))?;
            if !open {
                return Err(MeetingStoreError::Validation(format!(
                    "transcript gap '{gap_id}' is already resolved"
                )));
            }
            transaction.execute(
                "UPDATE transcript_gaps SET resolved_revision=?3
                 WHERE meeting_id=?1 AND gap_id=?2",
                params![meeting_id, gap_id, to_i64(revision)?],
            )?;
        }
    }
    Ok(())
}

fn load_meeting(
    connection: &Connection,
    meeting_id: &str,
) -> Result<MeetingRecord, MeetingStoreError> {
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

fn load_meeting_tx(
    transaction: &Transaction<'_>,
    meeting_id: &str,
) -> Result<MeetingRecord, MeetingStoreError> {
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

fn meeting_from_row(row: &Row<'_>) -> rusqlite::Result<MeetingRecord> {
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

trait Queryable {
    fn prepare_query<'a>(&'a self, sql: &str) -> rusqlite::Result<rusqlite::Statement<'a>>;
}

impl Queryable for Connection {
    fn prepare_query<'a>(&'a self, sql: &str) -> rusqlite::Result<rusqlite::Statement<'a>> {
        self.prepare(sql)
    }
}

impl Queryable for Transaction<'_> {
    fn prepare_query<'a>(&'a self, sql: &str) -> rusqlite::Result<rusqlite::Statement<'a>> {
        self.prepare(sql)
    }
}

fn load_channels<Q: Queryable>(
    queryable: &Q,
    meeting_id: &str,
) -> Result<Vec<AudioChannel>, MeetingStoreError> {
    let mut statement = queryable.prepare_query(
        "SELECT id,kind,sample_rate_hz,channels,sample_format,device_id,created_at
         FROM audio_channels WHERE meeting_id=?1 ORDER BY id",
    )?;
    let channels = statement
        .query_map([meeting_id], |row| {
            let kind: String = row.get(1)?;
            Ok(AudioChannel {
                definition: AudioChannelDraft {
                    id: row.get(0)?,
                    kind: channel_kind(&kind).map_err(text_from_sql_error)?,
                    sample_rate_hz: row.get(2)?,
                    channels: row.get(3)?,
                    sample_format: row.get(4)?,
                    device_id: row.get(5)?,
                },
                created_at: row.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(channels)
}

fn load_segments_at(
    connection: &Connection,
    meeting_id: &str,
    revision: u64,
) -> Result<Vec<TranscriptSegmentRecord>, MeetingStoreError> {
    let mut statement = connection.prepare(
        "SELECT v.segment_id,v.start_ms,v.end_ms,v.text,v.channel_id,v.speaker,
                v.confidence,v.is_final,v.metadata_json,v.created_revision,v.revision
         FROM transcript_segment_versions v
         JOIN (
           SELECT segment_id,MAX(revision) AS revision
           FROM transcript_segment_versions
           WHERE meeting_id=?1 AND revision<=?2
           GROUP BY segment_id
         ) latest ON latest.segment_id=v.segment_id AND latest.revision=v.revision
         WHERE v.meeting_id=?1 AND v.operation='upsert'
         ORDER BY v.start_ms,v.end_ms,v.segment_id",
    )?;
    let segments = statement
        .query_map(params![meeting_id, to_i64(revision)?], |row| {
            let metadata: String = row.get(8)?;
            Ok(TranscriptSegmentRecord {
                segment: TranscriptSegmentInput {
                    id: row.get(0)?,
                    start_ms: row.get(1)?,
                    end_ms: row.get(2)?,
                    text: row.get(3)?,
                    channel_id: row.get(4)?,
                    speaker: row.get(5)?,
                    confidence: row.get(6)?,
                    is_final: row.get(7)?,
                    metadata: serde_json::from_str(&metadata).map_err(json_from_sql_error)?,
                },
                created_revision: row.get::<_, i64>(9)? as u64,
                updated_revision: row.get::<_, i64>(10)? as u64,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(segments)
}

fn load_gaps_at(
    connection: &Connection,
    meeting_id: &str,
    revision: u64,
) -> Result<Vec<TranscriptGapRecord>, MeetingStoreError> {
    let mut statement = connection.prepare(
        "SELECT gap_id,start_ms,end_ms,reason,channel_id,detail,
                created_revision,resolved_revision
         FROM transcript_gaps
         WHERE meeting_id=?1 AND created_revision<=?2
           AND (resolved_revision IS NULL OR resolved_revision>?2)
         ORDER BY start_ms,end_ms,gap_id",
    )?;
    let gaps = statement
        .query_map(params![meeting_id, to_i64(revision)?], |row| {
            let reason: String = row.get(3)?;
            Ok(TranscriptGapRecord {
                gap: TranscriptGapInput {
                    id: row.get(0)?,
                    start_ms: row.get(1)?,
                    end_ms: row.get(2)?,
                    reason: gap_reason(&reason).map_err(text_from_sql_error)?,
                    channel_id: row.get(4)?,
                    detail: row.get(5)?,
                },
                created_revision: row.get::<_, i64>(6)? as u64,
                // This snapshot contains only gaps unresolved at `revision`.
                // Do not leak a resolution that happened in a future revision.
                resolved_revision: None,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(gaps)
}

fn load_audio_chunk_optional_tx(
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

fn audio_chunk_from_row(row: &Row<'_>) -> rusqlite::Result<(AudioChunk, String)> {
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

fn load_staged_audio_chunks_tx(
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

fn load_job(connection: &Connection, job_id: &str) -> Result<FollowUpJob, MeetingStoreError> {
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

fn load_job_tx(
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

fn load_job_by_idempotency_tx(
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

fn job_from_row(row: &Row<'_>) -> rusqlite::Result<FollowUpJob> {
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

fn require_meeting(connection: &Connection, meeting_id: &str) -> Result<(), MeetingStoreError> {
    let exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM meetings WHERE id=?1)",
        [meeting_id],
        |row| row.get(0),
    )?;
    exists
        .then_some(())
        .ok_or_else(|| not_found("meeting", meeting_id))
}

fn require_meeting_tx(
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

fn require_channel_tx(
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

fn timestamp(value: &str) -> Result<String, MeetingStoreError> {
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

fn transcript_batch_fingerprint(
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

fn job_fingerprint(
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

fn fingerprint<T: Serialize>(value: &T) -> Result<String, MeetingStoreError> {
    let bytes = serde_json::to_vec(value)?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn release_expired_jobs(
    transaction: &Transaction<'_>,
    observed_at: &str,
) -> Result<(), MeetingStoreError> {
    transaction.execute(
        "UPDATE follow_up_jobs SET
           state=CASE WHEN attempts>=max_attempts THEN 'failed' ELSE 'pending' END,
           not_before=CASE WHEN attempts>=max_attempts THEN not_before ELSE ?1 END,
           last_error='worker lease expired before completion',
           lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=?1
         WHERE state='running' AND lease_expires_at<=?1",
        [observed_at],
    )?;
    Ok(())
}

fn json<T: Serialize>(value: T) -> Result<String, MeetingStoreError> {
    Ok(serde_json::to_string(&value)?)
}

fn query_strings(
    transaction: &Transaction<'_>,
    sql: &str,
) -> Result<Vec<String>, MeetingStoreError> {
    let mut statement = transaction.prepare(sql)?;
    let values = statement
        .query_map([], |row| row.get(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(values)
}

fn to_i64(value: u64) -> Result<i64, MeetingStoreError> {
    i64::try_from(value).map_err(|_| {
        MeetingStoreError::Validation(format!("value {value} exceeds SQLite integer range"))
    })
}

fn from_i64(value: i64, label: &str) -> Result<u64, MeetingStoreError> {
    u64::try_from(value)
        .map_err(|_| MeetingStoreError::Validation(format!("{label} cannot be negative")))
}

fn not_found(entity: &'static str, id: &str) -> MeetingStoreError {
    MeetingStoreError::NotFound {
        entity,
        id: id.into(),
    }
}

fn meeting_status(value: &str) -> Result<MeetingStatus, String> {
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

fn channel_kind(value: &str) -> Result<AudioChannelKind, String> {
    Ok(match value {
        "microphone" => AudioChannelKind::Microphone,
        "system" => AudioChannelKind::System,
        "mixed" => AudioChannelKind::Mixed,
        "imported" => AudioChannelKind::Imported,
        other => return Err(format!("unknown audio channel kind '{other}'")),
    })
}

fn audio_chunk_status(value: &str) -> Result<AudioChunkStatus, String> {
    Ok(match value {
        "staged" => AudioChunkStatus::Staged,
        "committed" => AudioChunkStatus::Committed,
        "corrupt" => AudioChunkStatus::Corrupt,
        other => return Err(format!("unknown audio chunk status '{other}'")),
    })
}

fn gap_reason(value: &str) -> Result<TranscriptGapReason, String> {
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

fn job_state(value: &str) -> Result<JobState, String> {
    Ok(match value {
        "pending" => JobState::Pending,
        "running" => JobState::Running,
        "succeeded" => JobState::Succeeded,
        "failed" => JobState::Failed,
        "cancelled" => JobState::Cancelled,
        other => return Err(format!("unknown job state '{other}'")),
    })
}

fn json_from_sql_error(error: serde_json::Error) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
}

fn text_from_sql_error(error: String) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        0,
        rusqlite::types::Type::Text,
        Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, error)),
    )
}

#[cfg(test)]
mod tests {
    use super::super::model::MeetingOrigin;
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    const T0: &str = "2026-07-30T10:00:00Z";
    const T1: &str = "2026-07-30T10:01:00Z";
    const T2: &str = "2026-07-30T10:02:00Z";
    const T3: &str = "2026-07-30T10:03:00Z";

    fn store() -> MeetingStore {
        MeetingStore::open_in_memory().unwrap()
    }

    fn meeting() -> MeetingDraft {
        MeetingDraft {
            id: "meeting-1".into(),
            title: "Project review".into(),
            origin: MeetingOrigin {
                kind: "calendar".into(),
                external_id: Some("event-1".into()),
                confidence: Some(0.98),
                evidence: json!({"process": "zoom"}),
            },
            channels: vec![
                AudioChannelDraft {
                    id: "mic".into(),
                    kind: AudioChannelKind::Microphone,
                    sample_rate_hz: 48_000,
                    channels: 1,
                    sample_format: "f32le".into(),
                    device_id: Some("device-1".into()),
                },
                AudioChannelDraft {
                    id: "system".into(),
                    kind: AudioChannelKind::System,
                    sample_rate_hz: 48_000,
                    channels: 2,
                    sample_format: "f32le".into(),
                    device_id: None,
                },
            ],
            metadata: json!({"workspacePath": "/workspace"}),
        }
    }

    fn start_recording(store: &MeetingStore) -> MeetingRecord {
        let created = store.create_meeting(&meeting(), T0).unwrap();
        store
            .transition_meeting(
                &created.id,
                created.revision,
                MeetingStatus::Recording,
                T1,
                None,
            )
            .unwrap()
    }

    fn segment(id: &str, text: &str) -> TranscriptSegmentInput {
        TranscriptSegmentInput {
            id: id.into(),
            start_ms: 0,
            end_ms: 1_000,
            text: text.into(),
            channel_id: Some("system".into()),
            speaker: Some("Alex".into()),
            confidence: Some(0.9),
            is_final: false,
            metadata: json!({}),
        }
    }

    fn batch(
        batch_id: &str,
        base_revision: u64,
        changes: Vec<TranscriptChange>,
    ) -> TranscriptBatch {
        TranscriptBatch {
            meeting_id: "meeting-1".into(),
            batch_id: batch_id.into(),
            base_revision,
            source: "local-whisper".into(),
            observed_at: T2.into(),
            marks_final: false,
            changes,
        }
    }

    fn job(id: &str, key: &str, max_attempts: u32) -> FollowUpJobDraft {
        FollowUpJobDraft {
            id: id.into(),
            meeting_id: "meeting-1".into(),
            kind: FollowUpJobKind::Summary,
            idempotency_key: key.into(),
            payload: json!({"prompt": "Summarize"}),
            max_attempts,
            not_before: T1.into(),
        }
    }

    #[test]
    fn gherkin_new_database_migrates_atomically_and_reopens() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("meetings.sqlite");
        {
            let store = MeetingStore::open(&path).unwrap();
            assert_eq!(store.schema_version().unwrap(), CURRENT_SCHEMA_VERSION);
            store.create_meeting(&meeting(), T0).unwrap();
        }
        let reopened = MeetingStore::open(&path).unwrap();
        assert_eq!(reopened.get_meeting("meeting-1").unwrap().channels.len(), 2);
    }

    #[test]
    fn gherkin_a_newer_schema_is_refused_without_mutation() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("future.sqlite");
        let connection = Connection::open(&path).unwrap();
        connection
            .pragma_update(None, "application_id", APPLICATION_ID)
            .unwrap();
        connection.pragma_update(None, "user_version", 999).unwrap();
        drop(connection);
        assert!(matches!(
            MeetingStore::open(&path),
            Err(MeetingStoreError::UnsupportedSchemaVersion { found: 999, .. })
        ));
        let connection = Connection::open(path).unwrap();
        let version: u32 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, 999);
    }

    #[test]
    fn gherkin_state_changes_use_optimistic_revision_and_idempotent_replay() {
        let store = store();
        let detected = store.create_meeting(&meeting(), T0).unwrap();
        let recording = store
            .transition_meeting(&detected.id, 0, MeetingStatus::Recording, T1, None)
            .unwrap();
        assert_eq!(recording.revision, 1);
        assert_eq!(
            store
                .transition_meeting(&detected.id, 1, MeetingStatus::Recording, T2, None)
                .unwrap()
                .revision,
            1
        );
        assert!(matches!(
            store.transition_meeting(&detected.id, 0, MeetingStatus::Stopping, T2, None),
            Err(MeetingStoreError::RevisionConflict { actual: 1, .. })
        ));
        assert!(matches!(
            store.transition_meeting(&detected.id, 1, MeetingStatus::Completed, T2, None),
            Err(MeetingStoreError::InvalidTransition { .. })
        ));
    }

    #[test]
    fn gherkin_audio_chunk_staging_is_exactly_once_and_commit_is_idempotent() {
        let store = store();
        start_recording(&store);
        let chunk = AudioChunkDraft {
            id: "chunk-1".into(),
            meeting_id: "meeting-1".into(),
            channel_id: "mic".into(),
            sequence: 0,
            start_ms: 0,
            end_ms: 1_000,
            sample_count: 48_000,
            byte_len: 192_000,
            sha256: "a".repeat(64),
            relative_path: "meeting-1/mic/000000.flac".into(),
        };
        assert_eq!(
            store.stage_audio_chunk(&chunk, T1).unwrap().status,
            AudioChunkStatus::Staged
        );
        assert_eq!(
            store.stage_audio_chunk(&chunk, T2).unwrap().status,
            AudioChunkStatus::Staged
        );
        let mut conflicting = chunk.clone();
        conflicting.sha256 = "b".repeat(64);
        assert!(matches!(
            store.stage_audio_chunk(&conflicting, T2),
            Err(MeetingStoreError::IdempotencyConflict { .. })
        ));
        let committed = store.commit_audio_chunk(&chunk.id, T2).unwrap();
        assert_eq!(committed.status, AudioChunkStatus::Committed);
        assert_eq!(
            store
                .commit_audio_chunk(&chunk.id, T3)
                .unwrap()
                .committed_at,
            committed.committed_at
        );
    }

    #[test]
    fn gherkin_transcript_batches_are_atomic_revisioned_and_exactly_once() {
        let store = store();
        start_recording(&store);
        let first = batch(
            "batch-1",
            0,
            vec![
                TranscriptChange::UpsertSegment {
                    segment: segment("segment-1", "Draft"),
                },
                TranscriptChange::OpenGap {
                    gap: TranscriptGapInput {
                        id: "gap-1".into(),
                        start_ms: 1_000,
                        end_ms: 2_000,
                        reason: TranscriptGapReason::BufferOverflow,
                        channel_id: Some("system".into()),
                        detail: Some("provider lag".into()),
                    },
                },
            ],
        );
        assert_eq!(
            store.apply_transcript_batch(&first).unwrap(),
            TranscriptApplyResult {
                revision: 1,
                duplicate: false
            }
        );
        assert_eq!(
            store.apply_transcript_batch(&first).unwrap(),
            TranscriptApplyResult {
                revision: 1,
                duplicate: true
            }
        );
        let second = batch(
            "batch-2",
            1,
            vec![
                TranscriptChange::UpsertSegment {
                    segment: segment("segment-1", "Final"),
                },
                TranscriptChange::ResolveGap {
                    gap_id: "gap-1".into(),
                },
            ],
        );
        store.apply_transcript_batch(&second).unwrap();

        let revision_one = store.transcript_snapshot("meeting-1", Some(1)).unwrap();
        assert_eq!(revision_one.segments[0].segment.text, "Draft");
        assert_eq!(revision_one.gaps.len(), 1);
        assert_eq!(revision_one.gaps[0].resolved_revision, None);
        let revision_two = store.transcript_snapshot("meeting-1", None).unwrap();
        assert_eq!(revision_two.segments[0].segment.text, "Final");
        assert!(revision_two.gaps.is_empty());
        assert_eq!(store.transcript_revisions("meeting-1").unwrap().len(), 2);
    }

    #[test]
    fn gherkin_failed_transcript_change_rolls_back_the_whole_batch() {
        let store = store();
        start_recording(&store);
        let invalid = batch(
            "batch-1",
            0,
            vec![
                TranscriptChange::UpsertSegment {
                    segment: segment("segment-1", "Should roll back"),
                },
                TranscriptChange::DeleteSegment {
                    segment_id: "missing".into(),
                },
            ],
        );
        assert!(matches!(
            store.apply_transcript_batch(&invalid),
            Err(MeetingStoreError::NotFound { .. })
        ));
        let snapshot = store.transcript_snapshot("meeting-1", None).unwrap();
        assert_eq!(snapshot.revision, 0);
        assert!(snapshot.segments.is_empty());
        assert!(store.transcript_revisions("meeting-1").unwrap().is_empty());
    }

    #[test]
    fn gherkin_stale_transcript_writer_cannot_overwrite_a_newer_revision() {
        let store = store();
        start_recording(&store);
        store
            .apply_transcript_batch(&batch(
                "batch-1",
                0,
                vec![TranscriptChange::UpsertSegment {
                    segment: segment("segment-1", "Current"),
                }],
            ))
            .unwrap();
        assert!(matches!(
            store.apply_transcript_batch(&batch(
                "batch-stale",
                0,
                vec![TranscriptChange::UpsertSegment {
                    segment: segment("segment-1", "Stale"),
                }],
            )),
            Err(MeetingStoreError::RevisionConflict { actual: 1, .. })
        ));
        assert_eq!(
            store
                .transcript_snapshot("meeting-1", None)
                .unwrap()
                .segments[0]
                .segment
                .text,
            "Current"
        );
    }

    #[test]
    fn gherkin_job_idempotency_rejects_same_key_with_different_intent() {
        let store = store();
        start_recording(&store);
        let draft = job("job-1", "summary:on-stop", 3);
        assert!(!store.enqueue_job(&draft, T1).unwrap().1);
        let mut replay = draft.clone();
        replay.id = "job-retry-request".into();
        let (original, duplicate) = store.enqueue_job(&replay, T2).unwrap();
        assert!(duplicate);
        assert_eq!(original.definition.id, "job-1");
        let mut conflicting = draft.clone();
        conflicting.id = "job-conflicting-request".into();
        conflicting.payload = json!({"prompt": "Do something else"});
        assert!(matches!(
            store.enqueue_job(&conflicting, T2),
            Err(MeetingStoreError::IdempotencyConflict { .. })
        ));
        assert_eq!(store.list_jobs("meeting-1").unwrap().len(), 1);
    }

    #[test]
    fn gherkin_job_lease_blocks_stale_worker_completion_and_retries_with_budget() {
        let store = store();
        start_recording(&store);
        store
            .enqueue_job(&job("job-1", "summary:on-stop", 2), T1)
            .unwrap();
        let first = store.claim_next_job("worker-1", T1, T2).unwrap().unwrap();
        assert_eq!(first.attempts, 1);
        let token = first.lease_token.clone().unwrap();
        let retry = store
            .finish_job(
                "job-1",
                &token,
                &JobFinish::Failed {
                    error: "temporary provider failure".into(),
                    retryable: true,
                    retry_at: Some(T2.into()),
                },
                T1,
            )
            .unwrap();
        assert_eq!(retry.state, JobState::Pending);

        let second = store.claim_next_job("worker-2", T2, T3).unwrap().unwrap();
        assert_eq!(second.attempts, 2);
        assert!(matches!(
            store.finish_job(
                "job-1",
                &token,
                &JobFinish::Succeeded { result: json!({}) },
                T2
            ),
            Err(MeetingStoreError::LeaseLost { .. })
        ));
        let exhausted = store
            .finish_job(
                "job-1",
                second.lease_token.as_deref().unwrap(),
                &JobFinish::Failed {
                    error: "still failing".into(),
                    retryable: true,
                    retry_at: Some(T3.into()),
                },
                T2,
            )
            .unwrap();
        assert_eq!(exhausted.state, JobState::Failed);
    }

    #[test]
    fn gherkin_an_expired_live_lease_is_reclaimed_without_an_app_restart() {
        let store = store();
        start_recording(&store);
        store
            .enqueue_job(&job("job-1", "summary:on-stop", 2), T1)
            .unwrap();
        let abandoned = store.claim_next_job("worker-1", T1, T2).unwrap().unwrap();
        let reclaimed = store.claim_next_job("worker-2", T2, T3).unwrap().unwrap();
        assert_eq!(reclaimed.definition.id, "job-1");
        assert_eq!(reclaimed.attempts, 2);
        assert_ne!(reclaimed.lease_token, abandoned.lease_token);
        assert!(matches!(
            store.finish_job(
                "job-1",
                abandoned.lease_token.as_deref().unwrap(),
                &JobFinish::Succeeded { result: json!({}) },
                T2
            ),
            Err(MeetingStoreError::LeaseLost { .. })
        ));
    }

    #[test]
    fn gherkin_recovery_reports_staged_audio_until_integrity_is_decided() {
        let store = store();
        start_recording(&store);
        let chunk = AudioChunkDraft {
            id: "chunk-1".into(),
            meeting_id: "meeting-1".into(),
            channel_id: "system".into(),
            sequence: 0,
            start_ms: 0,
            end_ms: 1_000,
            sample_count: 48_000,
            byte_len: 192_000,
            sha256: "a".repeat(64),
            relative_path: "meeting-1/system/000000.flac".into(),
        };
        store.stage_audio_chunk(&chunk, T1).unwrap();
        assert_eq!(
            store
                .recover_after_restart(T2)
                .unwrap()
                .staged_audio_chunks
                .len(),
            1
        );
        let corrupt = store
            .mark_audio_chunk_corrupt("chunk-1", "sha256 mismatch", T2)
            .unwrap();
        assert_eq!(corrupt.status, AudioChunkStatus::Corrupt);
        assert_eq!(corrupt.integrity_error.as_deref(), Some("sha256 mismatch"));
        assert!(store
            .recover_after_restart(T3)
            .unwrap()
            .staged_audio_chunks
            .is_empty());
    }

    #[test]
    fn gherkin_restart_recovery_is_durable_conservative_and_idempotent() {
        let store = store();
        start_recording(&store);
        let chunk = AudioChunkDraft {
            id: "chunk-1".into(),
            meeting_id: "meeting-1".into(),
            channel_id: "system".into(),
            sequence: 0,
            start_ms: 0,
            end_ms: 1_000,
            sample_count: 48_000,
            byte_len: 192_000,
            sha256: "a".repeat(64),
            relative_path: "meeting-1/system/000000.flac".into(),
        };
        store.stage_audio_chunk(&chunk, T1).unwrap();
        store
            .enqueue_job(&job("job-1", "summary:on-stop", 3), T1)
            .unwrap();
        store.claim_next_job("worker-1", T1, T2).unwrap().unwrap();

        let first = store.recover_after_restart(T2).unwrap();
        assert_eq!(first.interrupted_meeting_ids, ["meeting-1"]);
        assert_eq!(first.requeued_job_ids, ["job-1"]);
        assert_eq!(first.staged_audio_chunks.len(), 1);
        let recovered = store.get_meeting("meeting-1").unwrap();
        assert_eq!(recovered.status, MeetingStatus::Interrupted);
        assert_eq!(recovered.recovery_count, 1);
        assert_eq!(
            store.list_jobs("meeting-1").unwrap()[0].state,
            JobState::Pending
        );

        let second = store.recover_after_restart(T3).unwrap();
        assert!(second.interrupted_meeting_ids.is_empty());
        assert!(second.requeued_job_ids.is_empty());
        assert_eq!(second.staged_audio_chunks.len(), 1);
        assert_eq!(store.get_meeting("meeting-1").unwrap().recovery_count, 1);
    }
}
