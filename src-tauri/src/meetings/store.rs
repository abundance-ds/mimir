use super::model::{
    validate_audio_chunk, validate_id, validate_job_draft, validate_job_result,
    validate_meeting_draft, validate_transcript_batch, AudioChannel, AudioChannelDraft,
    AudioChannelKind, AudioChunk, AudioChunkDraft, AudioChunkStatus, FollowUpJob, FollowUpJobDraft,
    FollowUpJobKind, JobFinish, JobState, MeetingDraft, MeetingFailure, MeetingRecord,
    MeetingStatus, RecoveryReport, TranscriptApplyResult, TranscriptBatch, TranscriptChange,
    TranscriptGapInput, TranscriptGapReason, TranscriptGapRecord, TranscriptRevision,
    TranscriptSegmentInput, TranscriptSegmentRecord, TranscriptSnapshot, MAX_TITLE_CHARS,
};
use crate::persistence::{
    create_private_file, ensure_private_directory, repair_private_file_if_exists,
    repair_private_tree, PersistenceError,
};
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row, Transaction, TransactionBehavior};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
    time::Duration,
};
use thiserror::Error;
use uuid::Uuid;

pub const CURRENT_SCHEMA_VERSION: u32 = 6;
pub const MAX_TRANSCRIPT_PAGE_SEGMENTS: u32 = 250;
pub const MAX_COMMITTED_AUDIO_CHUNK_PAGE: u32 = 512;
const APPLICATION_ID: i64 = 0x4d4d4554; // "MMET"
const MAX_CONTENT_SEARCH_QUERY_BYTES: usize = 512;
const MAX_INDEXED_SUMMARY_BYTES: usize = 4 * 1024 * 1024;
const MAX_INDEXED_TAGS: usize = 64;
const MAX_INDEXED_TAG_BYTES: usize = 160;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranscriptPageCursor {
    pub start_ms: i64,
    pub end_ms: i64,
    pub segment_id: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TranscriptPage {
    pub meeting_id: String,
    pub revision: u64,
    pub total_segments: u64,
    pub has_more: bool,
    pub next_before: Option<TranscriptPageCursor>,
    pub segments: Vec<TranscriptSegmentRecord>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TranscriptOverview {
    pub revision: u64,
    pub is_final: bool,
    pub segment_count: u64,
    pub non_final_segment_count: u64,
    pub unresolved_gap_count: u64,
    pub gaps: Vec<TranscriptGapRecord>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TranscriptRepairBegin {
    Collecting,
    AlreadyCommitted { revision: u64 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranscriptSearchHit {
    pub meeting_id: String,
    pub segment_id: String,
    pub start_ms: i64,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MeetingContentSearchHit {
    pub meeting_id: String,
    pub title_match: bool,
    pub summary_match: bool,
    pub tags_match: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MeetingListCursor {
    pub created_at: String,
    pub meeting_id: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MeetingListPage {
    pub meetings: Vec<MeetingRecord>,
    pub has_more: bool,
    pub next_before: Option<MeetingListCursor>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MeetingDeletionMode {
    Audio,
    All,
}

impl MeetingDeletionMode {
    fn storage_key(self) -> &'static str {
        match self {
            Self::Audio => "audio",
            Self::All => "all",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MeetingDeletionStage {
    WaitingForJobs,
    FilesPending,
    DatabasePending,
    MarkerCleanupPending,
}

impl MeetingDeletionStage {
    fn storage_key(self) -> &'static str {
        match self {
            Self::WaitingForJobs => "waiting-for-jobs",
            Self::FilesPending => "files-pending",
            Self::DatabasePending => "database-pending",
            Self::MarkerCleanupPending => "marker-cleanup-pending",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MeetingDeletion {
    pub meeting_id: String,
    pub mode: MeetingDeletionMode,
    pub stage: MeetingDeletionStage,
    pub requested_at: String,
    pub updated_at: String,
    pub running_jobs: u32,
    pub last_error: Option<String>,
}

#[derive(Debug, Error)]
pub enum MeetingStoreError {
    #[error("meeting store private-storage error: {0}")]
    PrivateStorage(#[from] PersistenceError),
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
    #[error(
        "meeting '{meeting_id}' deletion is waiting for {running_jobs} running job(s) to finish"
    )]
    DeletionBlocked {
        meeting_id: String,
        running_jobs: u32,
    },
    #[error("meeting '{meeting_id}' is being permanently deleted ({stage})")]
    DeletionInProgress {
        meeting_id: String,
        stage: &'static str,
    },
    #[error("meeting database schema version {found} is newer than supported version {supported}")]
    UnsupportedSchemaVersion { found: u32, supported: u32 },
    #[error("meeting database belongs to another application (application_id={0})")]
    ForeignDatabase(i64),
    #[error("meeting store mutex was poisoned")]
    Poisoned,
}

pub struct MeetingStore {
    connection: Mutex<Connection>,
    database_path: Option<PathBuf>,
}

impl MeetingStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, MeetingStoreError> {
        let path = path.as_ref();
        let parent = path.parent().unwrap_or_else(|| Path::new("."));
        ensure_private_directory(parent)?;
        repair_private_tree(parent)?;
        repair_sqlite_files(path)?;
        create_private_file(path)?;
        let store = Self::from_connection(Connection::open(path)?, Some(path.to_path_buf()))?;
        store.repair_database_permissions()?;
        Ok(store)
    }

    pub fn open_in_memory() -> Result<Self, MeetingStoreError> {
        Self::from_connection(Connection::open_in_memory()?, None)
    }

    fn from_connection(
        mut connection: Connection,
        database_path: Option<PathBuf>,
    ) -> Result<Self, MeetingStoreError> {
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
            database_path,
        })
    }

    fn repair_database_permissions(&self) -> Result<(), MeetingStoreError> {
        if let Some(path) = &self.database_path {
            repair_sqlite_files(path)?;
        }
        Ok(())
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
        Ok(self.list_meetings_page(None, limit)?.meetings)
    }

    /// Return every interrupted meeting that still needs a startup
    /// transcription decision. This query is intentionally independent of
    /// the bounded renderer library projection.
    pub fn interrupted_meeting_ids(&self) -> Result<Vec<String>, MeetingStoreError> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT id FROM meetings
             WHERE status='interrupted'
               AND NOT EXISTS (
                 SELECT 1 FROM meeting_deletions d
                 WHERE d.meeting_id=meetings.id AND d.mode='all'
               )
             ORDER BY id",
        )?;
        let ids = statement
            .query_map([], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(ids)
    }

    pub fn list_meetings_page(
        &self,
        before: Option<&MeetingListCursor>,
        limit: u32,
    ) -> Result<MeetingListPage, MeetingStoreError> {
        if let Some(cursor) = before {
            timestamp(&cursor.created_at)?;
            validate_id(&cursor.meeting_id, "meeting list cursor id")
                .map_err(MeetingStoreError::Validation)?;
        }
        let limit = limit.clamp(1, 1_000);
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT m.id FROM meetings m
             WHERE NOT EXISTS (
                     SELECT 1 FROM meeting_deletions d
                     WHERE d.meeting_id=m.id AND d.mode='all'
                   )
               AND (
                    ?1 IS NULL
                 OR m.created_at < ?1
                 OR (m.created_at=?1 AND m.id < ?2)
               )
             ORDER BY m.created_at DESC,m.id DESC
             LIMIT ?3",
        )?;
        let ids = statement
            .query_map(
                params![
                    before.map(|cursor| cursor.created_at.as_str()),
                    before.map(|cursor| cursor.meeting_id.as_str()),
                    i64::from(limit) + 1
                ],
                |row| row.get::<_, String>(0),
            )?
            .collect::<Result<Vec<_>, _>>()?;
        let has_more = ids.len() > limit as usize;
        let meetings = ids
            .into_iter()
            .take(limit as usize)
            .map(|meeting_id| load_meeting(&connection, &meeting_id))
            .collect::<Result<Vec<_>, _>>()?;
        let next_before =
            has_more
                .then(|| meetings.last())
                .flatten()
                .map(|meeting| MeetingListCursor {
                    created_at: meeting.created_at.clone(),
                    meeting_id: meeting.id.clone(),
                });
        Ok(MeetingListPage {
            meetings,
            has_more,
            next_before,
        })
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
        if !matches!(next, MeetingStatus::Failed | MeetingStatus::Interrupted) && failure.is_some()
        {
            return Err(MeetingStoreError::Validation(
                "failure detail is valid only for failed or interrupted recovery intent".into(),
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
               stopped_at=CASE
                 WHEN ?2 IN ('stopping','finalizing','interrupted','failed')
                 THEN COALESCE(stopped_at,?3)
                 ELSE stopped_at
               END,
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

    /// Commit terminal lifecycle and its optional default follow-up outbox
    /// entry under one SQLite write lock.
    ///
    /// This closes the crash boundary where a meeting could previously become
    /// `completed` before its required title/summary job was durable.
    pub fn complete_meeting_with_job(
        &self,
        meeting_id: &str,
        expected_revision: u64,
        observed_at: &str,
        job: Option<&FollowUpJobDraft>,
    ) -> Result<(MeetingRecord, Option<FollowUpJob>), MeetingStoreError> {
        validate_id(meeting_id, "meeting id").map_err(MeetingStoreError::Validation)?;
        let observed_at = timestamp(observed_at)?;
        let prepared_job = job
            .map(|job| {
                validate_job_draft(job).map_err(MeetingStoreError::Validation)?;
                if job.meeting_id != meeting_id {
                    return Err(MeetingStoreError::Validation(
                        "completion follow-up must belong to the completed meeting".into(),
                    ));
                }
                let not_before = timestamp(&job.not_before)?;
                let request_hash = job_fingerprint(job, &not_before)?;
                let payload = json(job.payload.clone())?;
                Ok((
                    job,
                    not_before,
                    request_hash,
                    payload,
                    job.kind.as_storage_key(),
                ))
            })
            .transpose()?;
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
        if current.status != MeetingStatus::Completed
            && !current.status.can_transition_to(MeetingStatus::Completed)
        {
            return Err(MeetingStoreError::InvalidTransition {
                meeting_id: meeting_id.into(),
                from: current.status,
                to: MeetingStatus::Completed,
            });
        }

        if current.status != MeetingStatus::Completed {
            transaction.execute(
                "UPDATE meetings SET
                   status='completed',
                   updated_at=?2,
                   revision=revision+1,
                   stopped_at=COALESCE(stopped_at,?2),
                   finalized_at=?2,
                   failure_code=NULL,
                   failure_message=NULL,
                   failure_retryable=NULL
                 WHERE id=?1",
                params![meeting_id, observed_at],
            )?;
        }

        let stored_job = if let Some((job, not_before, request_hash, payload, kind)) = prepared_job
        {
            if deletion_blocks_job_tx(&transaction, meeting_id, &job.kind)? {
                return Err(deletion_in_progress_tx(&transaction, meeting_id)?);
            }
            if let Some((existing, existing_hash)) =
                load_job_by_idempotency_tx(&transaction, meeting_id, &job.idempotency_key)?
            {
                if existing_hash != request_hash {
                    return Err(MeetingStoreError::IdempotencyConflict {
                        key: job.idempotency_key.clone(),
                    });
                }
                Some(existing)
            } else {
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
                Some(load_job_tx(&transaction, &job.id)?)
            }
        } else {
            None
        };
        let completed = load_meeting_tx(&transaction, meeting_id)?;
        transaction.commit()?;
        Ok((completed, stored_job))
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

    /// Read one bounded, sequence-keyset page of committed channel audio.
    ///
    /// This is the only audio-file projection suitable for transcription.
    /// Filesystem discovery is deliberately not an authority: staged,
    /// corrupt, and unregistered paths never appear here.
    pub fn committed_audio_chunks(
        &self,
        meeting_id: &str,
        channel_id: &str,
        first_sequence: u64,
        limit: u32,
    ) -> Result<Vec<AudioChunk>, MeetingStoreError> {
        validate_id(meeting_id, "meeting id").map_err(MeetingStoreError::Validation)?;
        validate_id(channel_id, "audio channel id").map_err(MeetingStoreError::Validation)?;
        if limit == 0 || limit > MAX_COMMITTED_AUDIO_CHUNK_PAGE {
            return Err(MeetingStoreError::Validation(format!(
                "committed audio reads must request between 1 and {MAX_COMMITTED_AUDIO_CHUNK_PAGE} chunks"
            )));
        }

        let connection = self.lock()?;
        let meeting_exists = connection
            .query_row("SELECT 1 FROM meetings WHERE id=?1", [meeting_id], |_| {
                Ok(())
            })
            .optional()?
            .is_some();
        if !meeting_exists {
            return Err(not_found("meeting", meeting_id));
        }
        let channel_exists = connection
            .query_row(
                "SELECT 1 FROM audio_channels WHERE meeting_id=?1 AND id=?2",
                params![meeting_id, channel_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if !channel_exists {
            return Err(not_found("audio channel", channel_id));
        }

        let mut statement = connection.prepare(
            "SELECT id,meeting_id,channel_id,sequence,start_ms,end_ms,sample_count,
                    byte_len,sha256,relative_path,status,staged_at,committed_at,
                    fingerprint,integrity_error
             FROM audio_chunks
             WHERE meeting_id=?1 AND channel_id=?2
               AND status='committed' AND sequence>=?3
             ORDER BY sequence
             LIMIT ?4",
        )?;
        let chunks = statement
            .query_map(
                params![
                    meeting_id,
                    channel_id,
                    to_i64(first_sequence)?,
                    i64::from(limit)
                ],
                audio_chunk_from_row,
            )?
            .map(|result| result.map(|(chunk, _)| chunk))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(chunks)
    }

    pub fn has_committed_audio(&self, meeting_id: &str) -> Result<bool, MeetingStoreError> {
        validate_id(meeting_id, "meeting id").map_err(MeetingStoreError::Validation)?;
        let connection = self.lock()?;
        require_meeting(&connection, meeting_id)?;
        connection
            .query_row(
                "SELECT EXISTS(
                   SELECT 1 FROM audio_chunks
                   WHERE meeting_id=?1 AND status='committed'
                 )",
                [meeting_id],
                |row| row.get(0),
            )
            .map_err(Into::into)
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

    /// Start (or restart) one repair generation without exposing its partial
    /// output as the authoritative transcript.
    ///
    /// A provider retry always begins reading committed audio from sequence
    /// zero. Clearing only this generation's staging rows in the same
    /// transaction means a process crash can never mix an old partial pass
    /// with a later complete pass. A committed generation is immutable and is
    /// returned without reopening provider work.
    pub fn begin_transcript_repair(
        &self,
        meeting_id: &str,
        capture_generation: &str,
        provider_run_id: &str,
        observed_at: &str,
    ) -> Result<TranscriptRepairBegin, MeetingStoreError> {
        validate_id(meeting_id, "meeting id").map_err(MeetingStoreError::Validation)?;
        validate_id(capture_generation, "capture generation")
            .map_err(MeetingStoreError::Validation)?;
        validate_id(provider_run_id, "provider run id").map_err(MeetingStoreError::Validation)?;
        let observed_at = timestamp(observed_at)?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let meeting = load_meeting_tx(&transaction, meeting_id)?;
        if !matches!(
            meeting.status,
            MeetingStatus::Interrupted | MeetingStatus::Finalizing
        ) {
            return Err(MeetingStoreError::Validation(format!(
                "meeting '{meeting_id}' is {} and cannot begin transcript repair",
                meeting.status
            )));
        }
        let existing = transaction
            .query_row(
                "SELECT provider_run_id,state,terminal_revision
                 FROM transcript_repair_runs
                 WHERE meeting_id=?1 AND capture_generation=?2",
                params![meeting_id, capture_generation],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<i64>>(2)?,
                    ))
                },
            )
            .optional()?;
        if let Some((stored_run_id, state, terminal_revision)) = existing {
            if stored_run_id != provider_run_id {
                return Err(MeetingStoreError::IdempotencyConflict {
                    key: format!("{meeting_id}:{capture_generation}"),
                });
            }
            if state == "committed" {
                let revision = terminal_revision.ok_or_else(|| {
                    MeetingStoreError::Validation(format!(
                        "committed transcript repair '{meeting_id}:{capture_generation}' has no terminal revision"
                    ))
                })?;
                transaction.commit()?;
                return Ok(TranscriptRepairBegin::AlreadyCommitted {
                    revision: from_i64(revision, "repair terminal revision")?,
                });
            }
            transaction.execute(
                "DELETE FROM transcript_repair_segments
                 WHERE meeting_id=?1 AND capture_generation=?2",
                params![meeting_id, capture_generation],
            )?;
            transaction.execute(
                "UPDATE transcript_repair_runs
                 SET state='collecting',updated_at=?3,terminal_revision=NULL
                 WHERE meeting_id=?1 AND capture_generation=?2",
                params![meeting_id, capture_generation, observed_at],
            )?;
        } else {
            transaction.execute(
                "INSERT INTO transcript_repair_runs (
                   meeting_id,capture_generation,provider_run_id,state,
                   started_at,updated_at,terminal_revision
                 ) VALUES (?1,?2,?3,'collecting',?4,?4,NULL)",
                params![meeting_id, capture_generation, provider_run_id, observed_at],
            )?;
        }
        transaction.commit()?;
        Ok(TranscriptRepairBegin::Collecting)
    }

    /// Persist a bounded provider batch into private repair staging.
    ///
    /// These rows are not indexed by transcript search, rendered, or returned
    /// to agents. The authoritative transcript changes only when the complete
    /// all-final generation is reconciled below.
    pub fn stage_transcript_repair_batch(
        &self,
        capture_generation: &str,
        provider_run_id: &str,
        batch: &TranscriptBatch,
    ) -> Result<(), MeetingStoreError> {
        validate_transcript_batch(batch).map_err(MeetingStoreError::Validation)?;
        validate_id(capture_generation, "capture generation")
            .map_err(MeetingStoreError::Validation)?;
        validate_id(provider_run_id, "provider run id").map_err(MeetingStoreError::Validation)?;
        if batch.marks_final {
            return Err(MeetingStoreError::Validation(
                "repair staging cannot accept a terminal batch".into(),
            ));
        }
        let observed_at = timestamp(&batch.observed_at)?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        require_collecting_repair_tx(
            &transaction,
            &batch.meeting_id,
            capture_generation,
            provider_run_id,
        )?;
        for change in &batch.changes {
            match change {
                TranscriptChange::UpsertSegment { segment } => {
                    if let Some(channel_id) = &segment.channel_id {
                        require_channel_tx(&transaction, &batch.meeting_id, channel_id)?;
                    }
                    let mut metadata = segment.metadata.clone();
                    let object = metadata.as_object_mut().ok_or_else(|| {
                        MeetingStoreError::Validation(
                            "repair transcript segment metadata must be an object".into(),
                        )
                    })?;
                    object.insert(
                        "providerRunId".into(),
                        serde_json::Value::String(provider_run_id.into()),
                    );
                    object.insert("owner".into(), serde_json::Value::String("stt".into()));
                    transaction.execute(
                        "INSERT INTO transcript_repair_segments (
                           meeting_id,capture_generation,segment_id,start_ms,end_ms,text,
                           channel_id,speaker,confidence,is_final,metadata_json,updated_at
                         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
                         ON CONFLICT(meeting_id,capture_generation,segment_id) DO UPDATE SET
                           start_ms=excluded.start_ms,end_ms=excluded.end_ms,
                           text=excluded.text,channel_id=excluded.channel_id,
                           speaker=excluded.speaker,confidence=excluded.confidence,
                           is_final=excluded.is_final,
                           metadata_json=excluded.metadata_json,
                           updated_at=excluded.updated_at",
                        params![
                            batch.meeting_id,
                            capture_generation,
                            segment.id,
                            segment.start_ms,
                            segment.end_ms,
                            segment.text,
                            segment.channel_id,
                            segment.speaker,
                            segment.confidence,
                            segment.is_final,
                            json(metadata)?,
                            observed_at
                        ],
                    )?;
                }
                TranscriptChange::DeleteSegment { segment_id } => {
                    transaction.execute(
                        "DELETE FROM transcript_repair_segments
                         WHERE meeting_id=?1 AND capture_generation=?2 AND segment_id=?3",
                        params![batch.meeting_id, capture_generation, segment_id],
                    )?;
                }
                TranscriptChange::OpenGap { .. } | TranscriptChange::ResolveGap { .. } => {
                    return Err(MeetingStoreError::Validation(
                        "provider repair batches cannot mutate capture-owned transcript gaps"
                            .into(),
                    ));
                }
            }
        }
        transaction.execute(
            "UPDATE transcript_repair_runs SET updated_at=?3
             WHERE meeting_id=?1 AND capture_generation=?2",
            params![batch.meeting_id, capture_generation, observed_at],
        )?;
        transaction.commit()?;
        Ok(())
    }

    /// Atomically replace the STT projection with one complete repair pass.
    ///
    /// The reconciliation is expressed as set-based SQLite operations. It
    /// creates exactly one bounded internal transcript revision regardless of
    /// whether the meeting has ten, five thousand, or one hundred thousand
    /// segments; Rust never loads that corpus into memory. Capture gap rows and
    /// every earlier segment-version row remain intact for provenance.
    pub fn commit_transcript_repair(
        &self,
        capture_generation: &str,
        provider_run_id: &str,
        terminal: &TranscriptBatch,
    ) -> Result<TranscriptApplyResult, MeetingStoreError> {
        validate_transcript_batch(terminal).map_err(MeetingStoreError::Validation)?;
        validate_id(capture_generation, "capture generation")
            .map_err(MeetingStoreError::Validation)?;
        validate_id(provider_run_id, "provider run id").map_err(MeetingStoreError::Validation)?;
        if !terminal.marks_final || !terminal.changes.is_empty() {
            return Err(MeetingStoreError::Validation(
                "repair completion requires an empty terminal marker".into(),
            ));
        }
        let observed_at = timestamp(&terminal.observed_at)?;
        let batch_hash = transcript_batch_fingerprint(terminal, &observed_at)?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let meeting = load_meeting_tx(&transaction, &terminal.meeting_id)?;
        let repair = require_repair_tx(
            &transaction,
            &terminal.meeting_id,
            capture_generation,
            provider_run_id,
        )?;
        if repair.0 == "committed" {
            let revision = repair.1.ok_or_else(|| {
                MeetingStoreError::Validation(
                    "committed transcript repair has no terminal revision".into(),
                )
            })?;
            let (stored_batch_id, stored_hash) = transaction.query_row(
                "SELECT r.batch_id,b.batch_hash
                 FROM transcript_revisions r
                 JOIN transcript_batches b
                   ON b.meeting_id=r.meeting_id AND b.revision=r.revision
                 WHERE r.meeting_id=?1 AND r.revision=?2",
                params![terminal.meeting_id, revision],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )?;
            if stored_batch_id != terminal.batch_id || stored_hash != batch_hash {
                return Err(MeetingStoreError::IdempotencyConflict {
                    key: format!("{}/{}", terminal.meeting_id, terminal.batch_id),
                });
            }
            transaction.commit()?;
            return Ok(TranscriptApplyResult {
                revision: from_i64(revision, "repair terminal revision")?,
                duplicate: true,
            });
        }
        if meeting.transcript_revision != terminal.base_revision {
            return Err(MeetingStoreError::RevisionConflict {
                meeting_id: terminal.meeting_id.clone(),
                expected: terminal.base_revision,
                actual: meeting.transcript_revision,
            });
        }
        let non_final: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM transcript_repair_segments
             WHERE meeting_id=?1 AND capture_generation=?2 AND is_final=0",
            params![terminal.meeting_id, capture_generation],
            |row| row.get(0),
        )?;
        if non_final != 0 {
            return Err(MeetingStoreError::Validation(format!(
                "transcript repair contains {non_final} unresolved partial segment(s)"
            )));
        }
        let revision = meeting
            .transcript_revision
            .checked_add(1)
            .ok_or_else(|| MeetingStoreError::Validation("transcript revision overflow".into()))?;
        transaction.execute(
            "INSERT INTO transcript_revisions (
               meeting_id,revision,base_revision,batch_id,source,observed_at,marks_final
             ) VALUES (?1,?2,?3,?4,?5,?6,1)",
            params![
                terminal.meeting_id,
                to_i64(revision)?,
                to_i64(terminal.base_revision)?,
                terminal.batch_id,
                terminal.source.trim(),
                observed_at
            ],
        )?;

        // History for rows absent from the completed pass records their
        // deletion. Rows present in both projections receive one upsert
        // version below, preserving their original created revision.
        transaction.execute(
            "INSERT INTO transcript_segment_versions (
               meeting_id,segment_id,revision,operation,created_revision
             )
             SELECT current.meeting_id,current.segment_id,?3,'delete',
                    current.created_revision
             FROM transcript_segments current
             WHERE current.meeting_id=?1
               AND NOT EXISTS (
                 SELECT 1 FROM transcript_repair_segments staged
                 WHERE staged.meeting_id=current.meeting_id
                   AND staged.capture_generation=?2
                   AND staged.segment_id=current.segment_id
               )",
            params![terminal.meeting_id, capture_generation, to_i64(revision)?],
        )?;
        transaction.execute(
            "INSERT INTO transcript_segment_versions (
               meeting_id,segment_id,revision,operation,start_ms,end_ms,text,
               channel_id,speaker,confidence,is_final,metadata_json,created_revision
             )
             SELECT staged.meeting_id,staged.segment_id,?3,'upsert',
                    staged.start_ms,staged.end_ms,staged.text,staged.channel_id,
                    staged.speaker,staged.confidence,staged.is_final,
                    staged.metadata_json,
                    COALESCE(current.created_revision,?3)
             FROM transcript_repair_segments staged
             LEFT JOIN transcript_segments current
               ON current.meeting_id=staged.meeting_id
              AND current.segment_id=staged.segment_id
             WHERE staged.meeting_id=?1 AND staged.capture_generation=?2",
            params![terminal.meeting_id, capture_generation, to_i64(revision)?],
        )?;
        transaction.execute(
            "DELETE FROM transcript_segments WHERE meeting_id=?1",
            [terminal.meeting_id.as_str()],
        )?;
        transaction.execute(
            "INSERT INTO transcript_segments (
               meeting_id,segment_id,start_ms,end_ms,text,channel_id,speaker,
               confidence,is_final,metadata_json,created_revision,updated_revision
             )
             SELECT staged.meeting_id,staged.segment_id,staged.start_ms,
                    staged.end_ms,staged.text,staged.channel_id,staged.speaker,
                    staged.confidence,staged.is_final,staged.metadata_json,
                    COALESCE(versions.created_revision,?3),?3
             FROM transcript_repair_segments staged
             LEFT JOIN (
               SELECT meeting_id,segment_id,MIN(created_revision) AS created_revision
               FROM transcript_segment_versions
               WHERE meeting_id=?1
               GROUP BY meeting_id,segment_id
             ) versions
               ON versions.meeting_id=staged.meeting_id
              AND versions.segment_id=staged.segment_id
             WHERE staged.meeting_id=?1 AND staged.capture_generation=?2",
            params![terminal.meeting_id, capture_generation, to_i64(revision)?],
        )?;
        transaction.execute(
            "INSERT INTO transcript_batches (
               meeting_id,batch_id,batch_hash,revision
             ) VALUES (?1,?2,?3,?4)",
            params![
                terminal.meeting_id,
                terminal.batch_id,
                batch_hash,
                to_i64(revision)?
            ],
        )?;
        transaction.execute(
            "UPDATE meetings SET transcript_revision=?2,revision=revision+1,updated_at=?3
             WHERE id=?1",
            params![terminal.meeting_id, to_i64(revision)?, observed_at],
        )?;
        transaction.execute(
            "UPDATE transcript_repair_runs
             SET state='committed',updated_at=?3,terminal_revision=?4
             WHERE meeting_id=?1 AND capture_generation=?2",
            params![
                terminal.meeting_id,
                capture_generation,
                observed_at,
                to_i64(revision)?
            ],
        )?;
        transaction.execute(
            "DELETE FROM transcript_repair_segments
             WHERE meeting_id=?1 AND capture_generation=?2",
            params![terminal.meeting_id, capture_generation],
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

    /// Read a bounded, keyset-paginated window from the current transcript.
    ///
    /// Pages are returned in presentation order, while the query walks the
    /// durable index newest-first. A cursor is stable when new live segments
    /// arrive and therefore cannot duplicate or skip older rows due to offset
    /// shifts.
    pub fn transcript_page(
        &self,
        meeting_id: &str,
        before: Option<&TranscriptPageCursor>,
        limit: u32,
    ) -> Result<TranscriptPage, MeetingStoreError> {
        validate_id(meeting_id, "meeting id").map_err(MeetingStoreError::Validation)?;
        if let Some(cursor) = before {
            validate_id(&cursor.segment_id, "transcript cursor segment id")
                .map_err(MeetingStoreError::Validation)?;
            if cursor.start_ms < 0 || cursor.end_ms <= cursor.start_ms {
                return Err(MeetingStoreError::Validation(
                    "transcript cursor has an invalid time range".into(),
                ));
            }
        }
        let limit = limit.clamp(1, MAX_TRANSCRIPT_PAGE_SEGMENTS);
        let connection = self.lock()?;
        let meeting = load_meeting(&connection, meeting_id)?;
        let total_segments = connection.query_row(
            "SELECT COUNT(*) FROM transcript_segments WHERE meeting_id=?1",
            [meeting_id],
            |row| row.get::<_, i64>(0),
        )? as u64;
        let before_start = before.map(|cursor| cursor.start_ms);
        let before_end = before.map(|cursor| cursor.end_ms);
        let before_id = before.map(|cursor| cursor.segment_id.as_str());
        let mut statement = connection.prepare(
            "SELECT segment_id,start_ms,end_ms,text,channel_id,speaker,confidence,
                    is_final,metadata_json,created_revision,updated_revision
             FROM transcript_segments
             WHERE meeting_id=?1
               AND (
                 ?2 IS NULL
                 OR start_ms < ?2
                 OR (start_ms=?2 AND end_ms < ?3)
                 OR (start_ms=?2 AND end_ms=?3 AND segment_id < ?4)
               )
             ORDER BY start_ms DESC,end_ms DESC,segment_id DESC
             LIMIT ?5",
        )?;
        let mut segments = statement
            .query_map(
                params![
                    meeting_id,
                    before_start,
                    before_end,
                    before_id,
                    i64::from(limit) + 1
                ],
                current_segment_from_row,
            )?
            .collect::<Result<Vec<_>, _>>()?;
        let has_more = segments.len() > limit as usize;
        segments.truncate(limit as usize);
        let next_before =
            has_more
                .then(|| segments.last())
                .flatten()
                .map(|segment| TranscriptPageCursor {
                    start_ms: segment.segment.start_ms,
                    end_ms: segment.segment.end_ms,
                    segment_id: segment.segment.id.clone(),
                });
        segments.reverse();
        Ok(TranscriptPage {
            meeting_id: meeting_id.into(),
            revision: meeting.transcript_revision,
            total_segments,
            has_more,
            next_before,
            segments,
        })
    }

    /// Backward-compatible chronological slice for bounded agent reads.
    ///
    /// Renderer navigation uses keyset pagination above. This offset form is
    /// deliberately capped by callers and exists for the established
    /// `meetings_get` tool contract.
    pub fn transcript_slice(
        &self,
        meeting_id: &str,
        offset: u64,
        limit: u32,
    ) -> Result<TranscriptPage, MeetingStoreError> {
        validate_id(meeting_id, "meeting id").map_err(MeetingStoreError::Validation)?;
        let offset = i64::try_from(offset).map_err(|_| {
            MeetingStoreError::Validation("transcript offset exceeds the durable range".into())
        })?;
        let limit = limit.clamp(1, MAX_TRANSCRIPT_PAGE_SEGMENTS);
        let connection = self.lock()?;
        let meeting = load_meeting(&connection, meeting_id)?;
        let total_segments = connection.query_row(
            "SELECT COUNT(*) FROM transcript_segments WHERE meeting_id=?1",
            [meeting_id],
            |row| row.get::<_, i64>(0),
        )? as u64;
        let mut statement = connection.prepare(
            "SELECT segment_id,start_ms,end_ms,text,channel_id,speaker,confidence,
                    is_final,metadata_json,created_revision,updated_revision
             FROM transcript_segments
             WHERE meeting_id=?1
             ORDER BY start_ms,end_ms,segment_id
             LIMIT ?2 OFFSET ?3",
        )?;
        let segments = statement
            .query_map(
                params![meeting_id, i64::from(limit), offset],
                current_segment_from_row,
            )?
            .collect::<Result<Vec<_>, _>>()?;
        let returned = segments.len() as u64;
        Ok(TranscriptPage {
            meeting_id: meeting_id.into(),
            revision: meeting.transcript_revision,
            total_segments,
            has_more: (offset as u64).saturating_add(returned) < total_segments,
            next_before: None,
            segments,
        })
    }

    /// Return only the bounded transcript metadata required by a library row.
    pub fn transcript_overview(
        &self,
        meeting_id: &str,
        gap_limit: u32,
    ) -> Result<TranscriptOverview, MeetingStoreError> {
        validate_id(meeting_id, "meeting id").map_err(MeetingStoreError::Validation)?;
        let connection = self.lock()?;
        let meeting = load_meeting(&connection, meeting_id)?;
        let is_final = connection
            .query_row(
                "SELECT marks_final FROM transcript_revisions
                 WHERE meeting_id=?1 AND revision=?2",
                params![meeting_id, to_i64(meeting.transcript_revision)?],
                |row| row.get::<_, bool>(0),
            )
            .optional()?
            .unwrap_or(false);
        let (segment_count, non_final_segment_count) = connection.query_row(
            "SELECT COUNT(*),COALESCE(SUM(CASE WHEN is_final=0 THEN 1 ELSE 0 END),0)
             FROM transcript_segments WHERE meeting_id=?1",
            [meeting_id],
            |row| Ok((row.get::<_, i64>(0)? as u64, row.get::<_, i64>(1)? as u64)),
        )?;
        let unresolved_gap_count = connection.query_row(
            "SELECT COUNT(*) FROM transcript_gaps
             WHERE meeting_id=?1 AND resolved_revision IS NULL",
            [meeting_id],
            |row| row.get::<_, i64>(0),
        )? as u64;
        let mut statement = connection.prepare(
            "SELECT gap_id,start_ms,end_ms,reason,channel_id,detail,
                    created_revision,resolved_revision
             FROM transcript_gaps
             WHERE meeting_id=?1 AND resolved_revision IS NULL
             ORDER BY start_ms DESC,end_ms DESC,gap_id DESC
             LIMIT ?2",
        )?;
        let mut gaps = statement
            .query_map(params![meeting_id, gap_limit.clamp(1, 100)], gap_from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        gaps.reverse();
        Ok(TranscriptOverview {
            revision: meeting.transcript_revision,
            is_final,
            segment_count,
            non_final_segment_count,
            unresolved_gap_count,
            gaps,
        })
    }

    pub fn search_transcript(
        &self,
        query: &str,
        limit: u32,
    ) -> Result<Vec<TranscriptSearchHit>, MeetingStoreError> {
        let query = query.trim();
        if query.is_empty() {
            return Err(MeetingStoreError::Validation(
                "transcript search query cannot be empty".into(),
            ));
        }
        let phrase = format!("\"{}\"", query.replace('"', "\"\""));
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "WITH ranked AS (
               SELECT s.meeting_id,s.segment_id,s.start_ms,s.text,
                      ROW_NUMBER() OVER (
                        PARTITION BY s.meeting_id
                        ORDER BY s.start_ms,s.end_ms,s.segment_id
                      ) AS meeting_rank
               FROM transcript_segments_fts f
               JOIN transcript_segments s
                 ON s.meeting_id=f.meeting_id AND s.segment_id=f.segment_id
               JOIN meetings m ON m.id=s.meeting_id
               WHERE transcript_segments_fts MATCH ?1
                 AND m.status IN ('completed','interrupted','failed')
                 AND NOT EXISTS (
                   SELECT 1 FROM meeting_deletions d
                   WHERE d.meeting_id=s.meeting_id AND d.mode='all'
                 )
             )
             SELECT meeting_id,segment_id,start_ms,text
             FROM ranked
             WHERE meeting_rank<=3
             ORDER BY (
               SELECT created_at FROM meetings WHERE id=ranked.meeting_id
             ) DESC,meeting_id DESC,start_ms,segment_id
             LIMIT ?2",
        )?;
        let hits = statement
            .query_map(params![phrase, limit.clamp(1, 300)], |row| {
                Ok(TranscriptSearchHit {
                    meeting_id: row.get(0)?,
                    segment_id: row.get(1)?,
                    start_ms: row.get(2)?,
                    text: row.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(hits)
    }

    /// Atomically synchronize the private reviewed-content search authority.
    ///
    /// The JSON review document remains the human-editable projection. This
    /// transaction owns the queryable copy, including its trigram index, so a
    /// search never walks an unbounded content directory.
    pub fn sync_content_search(
        &self,
        meeting_id: &str,
        title: &str,
        summary: Option<&str>,
        tags: &[String],
        deleted: bool,
        content_fingerprint: &str,
    ) -> Result<(), MeetingStoreError> {
        validate_id(meeting_id, "meeting id").map_err(MeetingStoreError::Validation)?;
        let title = title.trim();
        if title.is_empty() {
            return Err(MeetingStoreError::Validation(
                "meeting search title cannot be empty".into(),
            ));
        }
        if title.chars().count() > MAX_TITLE_CHARS {
            return Err(MeetingStoreError::Validation(
                "meeting search title exceeds the durable limit".into(),
            ));
        }
        if summary.is_some_and(|value| value.len() > MAX_INDEXED_SUMMARY_BYTES) {
            return Err(MeetingStoreError::Validation(
                "meeting search summary exceeds the durable limit".into(),
            ));
        }
        if tags.len() > MAX_INDEXED_TAGS
            || tags.iter().any(|tag| {
                tag.trim().is_empty()
                    || tag.len() > MAX_INDEXED_TAG_BYTES
                    || tag.chars().any(char::is_control)
            })
        {
            return Err(MeetingStoreError::Validation(
                "meeting search tags exceed the durable limits".into(),
            ));
        }
        if content_fingerprint.is_empty()
            || content_fingerprint.len() > 512
            || content_fingerprint.chars().any(char::is_control)
        {
            return Err(MeetingStoreError::Validation(
                "meeting content fingerprint is invalid".into(),
            ));
        }
        let tags_json = json(tags)?;
        let tags_text = tags.join("\n");
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        require_meeting(&transaction, meeting_id)?;
        transaction.execute(
            "INSERT INTO meeting_content_search (
               meeting_id,title,summary,tags_json,tags_text,deleted,content_fingerprint
             ) VALUES (?1,?2,?3,?4,?5,?6,?7)
             ON CONFLICT(meeting_id) DO UPDATE SET
               title=excluded.title,
               summary=excluded.summary,
               tags_json=excluded.tags_json,
               tags_text=excluded.tags_text,
               deleted=excluded.deleted,
               content_fingerprint=excluded.content_fingerprint",
            params![
                meeting_id,
                title,
                summary.unwrap_or_default(),
                tags_json,
                tags_text,
                deleted,
                content_fingerprint
            ],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn content_search_fingerprint(
        &self,
        meeting_id: &str,
    ) -> Result<Option<String>, MeetingStoreError> {
        validate_id(meeting_id, "meeting id").map_err(MeetingStoreError::Validation)?;
        let connection = self.lock()?;
        require_meeting(&connection, meeting_id)?;
        connection
            .query_row(
                "SELECT content_fingerprint FROM meeting_content_search
                 WHERE meeting_id=?1",
                [meeting_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(Into::into)
    }

    /// Search every durable reviewed title, full summary, and tag.
    ///
    /// Queries use the FTS5 trigram index for true substring matching. The
    /// three-character minimum is deliberate: shorter terms cannot use the
    /// index and would require reading arbitrarily many multi-megabyte
    /// summaries while holding the meeting operation boundary.
    pub fn search_content(
        &self,
        query: &str,
        limit: u32,
    ) -> Result<Vec<MeetingContentSearchHit>, MeetingStoreError> {
        let query = query.trim();
        if query.is_empty() {
            return Err(MeetingStoreError::Validation(
                "meeting content search query cannot be empty".into(),
            ));
        }
        if query.len() > MAX_CONTENT_SEARCH_QUERY_BYTES {
            return Err(MeetingStoreError::Validation(
                "meeting content search query exceeds the durable limit".into(),
            ));
        }
        if query.chars().count() < 3 {
            return Err(MeetingStoreError::Validation(
                "meeting content search query must contain at least 3 characters".into(),
            ));
        }
        let limit = limit.clamp(1, 100);
        let normalized = query.to_lowercase();
        let connection = self.lock()?;
        let phrase = format!("\"{}\"", query.replace('"', "\"\""));
        let mut statement = connection.prepare(
            "WITH field_matches AS (
               SELECT meeting_id,1 AS title_match,0 AS summary_match,0 AS tags_match
               FROM meeting_content_search_fts WHERE title MATCH ?1
               UNION ALL
               SELECT meeting_id,0,1,0
               FROM meeting_content_search_fts WHERE summary MATCH ?1
               UNION ALL
               SELECT meeting_id,0,0,1
               FROM meeting_content_search_fts WHERE tags MATCH ?1
             ),
             grouped AS (
               SELECT meeting_id,
                      MAX(title_match) AS title_match,
                      MAX(summary_match) AS summary_match,
                      MAX(tags_match) AS tags_match
               FROM field_matches GROUP BY meeting_id
             )
             SELECT g.meeting_id,g.title_match,g.summary_match,g.tags_match,
                    c.title,c.tags_json
             FROM grouped g
             JOIN meeting_content_search c ON c.meeting_id=g.meeting_id
             JOIN meetings m ON m.id=g.meeting_id
             WHERE c.deleted=0
               AND m.status IN ('completed','interrupted','failed')
               AND NOT EXISTS (
                 SELECT 1 FROM meeting_deletions d
                 WHERE d.meeting_id=g.meeting_id AND d.mode='all'
               )
             ORDER BY m.created_at DESC,m.id DESC",
        )?;
        let rows = statement.query_map([phrase], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, bool>(1)?,
                row.get::<_, bool>(2)?,
                row.get::<_, bool>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
            ))
        })?;
        let mut hits = Vec::with_capacity(limit as usize);
        for row in rows {
            let (
                meeting_id,
                indexed_title_match,
                summary_match,
                indexed_tags_match,
                title,
                tags_json,
            ) = row?;
            let tags: Vec<String> = serde_json::from_str(&tags_json)?;
            // Recheck bounded title/tag values with Rust's Unicode lowercase
            // semantics and reject a theoretical cross-tag trigram match.
            let title_match = indexed_title_match && title.to_lowercase().contains(&normalized);
            let tags_match = indexed_tags_match
                && tags
                    .iter()
                    .any(|tag| tag.to_lowercase().contains(&normalized));
            if title_match || summary_match || tags_match {
                hits.push(MeetingContentSearchHit {
                    meeting_id,
                    title_match,
                    summary_match,
                    tags_match,
                });
                if hits.len() == limit as usize {
                    break;
                }
            }
        }
        Ok(hits)
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

    pub fn has_retention_hold(&self, meeting_id: &str) -> Result<bool, MeetingStoreError> {
        validate_id(meeting_id, "meeting id").map_err(MeetingStoreError::Validation)?;
        let connection = self.lock()?;
        require_meeting(&connection, meeting_id)?;
        let held = connection.query_row(
            "SELECT
               EXISTS(
                 SELECT 1 FROM follow_up_jobs
                 WHERE meeting_id=?1 AND state IN ('pending','running')
               )
               OR EXISTS(
                 SELECT 1 FROM audio_chunks
                 WHERE meeting_id=?1 AND status='staged'
               )
               OR EXISTS(
                 SELECT 1 FROM transcript_repair_runs
                 WHERE meeting_id=?1 AND state='collecting'
               )",
            [meeting_id],
            |row| row.get::<_, bool>(0),
        )?;
        Ok(held)
    }

    /// Begin an irreversible, crash-replayable deletion.
    ///
    /// The tombstone and pending-job cancellation share one `IMMEDIATE`
    /// transaction. A permanent deletion is therefore hidden from readers
    /// before another worker can claim work for it. Running jobs retain their
    /// lease: their Activity may still own a process and output file, so the
    /// deletion waits until that worker reaches a terminal lease boundary.
    pub fn begin_deletion(
        &self,
        meeting_id: &str,
        mode: MeetingDeletionMode,
        observed_at: &str,
    ) -> Result<MeetingDeletion, MeetingStoreError> {
        validate_id(meeting_id, "meeting id").map_err(MeetingStoreError::Validation)?;
        let observed_at = timestamp(observed_at)?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(existing) = load_deletion_optional_tx(&transaction, meeting_id)? {
            if existing.mode != mode {
                return Err(MeetingStoreError::Validation(format!(
                    "meeting '{meeting_id}' already has a {} deletion in progress",
                    existing.mode.storage_key()
                )));
            }
            let deletion = refresh_deletion_tx(&transaction, existing, &observed_at)?;
            transaction.commit()?;
            return Ok(deletion);
        }
        let status: Option<String> = transaction
            .query_row(
                "SELECT status FROM meetings WHERE id=?1",
                [meeting_id],
                |row| row.get(0),
            )
            .optional()?;
        let status = status.ok_or_else(|| not_found("meeting", meeting_id))?;
        if matches!(status.as_str(), "recording" | "stopping" | "finalizing") {
            return Err(MeetingStoreError::Validation(
                "an active meeting cannot be deleted".into(),
            ));
        }

        if mode == MeetingDeletionMode::Audio {
            let staged_chunks: bool = transaction.query_row(
                "SELECT EXISTS(
                   SELECT 1 FROM audio_chunks
                   WHERE meeting_id=?1 AND status='staged'
                 )",
                [meeting_id],
                |row| row.get(0),
            )?;
            let transcription_jobs: bool = transaction.query_row(
                "SELECT EXISTS(
                   SELECT 1 FROM follow_up_jobs
                   WHERE meeting_id=?1
                     AND kind='custom:transcription'
                     AND state IN ('pending','running')
                 )",
                [meeting_id],
                |row| row.get(0),
            )?;
            let collecting_repair: bool = transaction.query_row(
                "SELECT EXISTS(
                   SELECT 1 FROM transcript_repair_runs
                   WHERE meeting_id=?1 AND state='collecting'
                 )",
                [meeting_id],
                |row| row.get(0),
            )?;
            if staged_chunks || transcription_jobs || collecting_repair {
                return Err(MeetingStoreError::Validation(
                    "source audio is held by transcription recovery; finish or resolve recovery before deleting it"
                        .into(),
                ));
            }
        }

        let running_jobs = if mode == MeetingDeletionMode::All {
            running_job_count_tx(&transaction, meeting_id)?
        } else {
            0
        };
        transaction.execute(
            "INSERT INTO meeting_deletions (
               meeting_id,mode,stage,requested_at,updated_at,last_error
             ) VALUES (?1,?2,?3,?4,?4,NULL)",
            params![
                meeting_id,
                mode.storage_key(),
                if running_jobs == 0 {
                    MeetingDeletionStage::FilesPending.storage_key()
                } else {
                    MeetingDeletionStage::WaitingForJobs.storage_key()
                },
                observed_at
            ],
        )?;
        if mode == MeetingDeletionMode::All {
            transaction.execute(
                "UPDATE follow_up_jobs SET
                   state='cancelled',lease_owner=NULL,lease_token=NULL,
                   lease_expires_at=NULL,last_error='cancelled by permanent meeting deletion',
                   updated_at=?2
                 WHERE meeting_id=?1 AND state='pending'",
                params![meeting_id, observed_at],
            )?;
        }
        let mut existing = load_deletion_optional_tx(&transaction, meeting_id)?
            .expect("inserted meeting deletion must exist");
        existing.running_jobs = running_jobs;
        let deletion = refresh_deletion_tx(&transaction, existing, &observed_at)?;
        transaction.commit()?;
        Ok(deletion)
    }

    pub fn deletion(&self, meeting_id: &str) -> Result<Option<MeetingDeletion>, MeetingStoreError> {
        validate_id(meeting_id, "meeting id").map_err(MeetingStoreError::Validation)?;
        let connection = self.lock()?;
        load_deletion_optional(&connection, meeting_id)
    }

    pub fn pending_deletions(&self) -> Result<Vec<MeetingDeletion>, MeetingStoreError> {
        let connection = self.lock()?;
        let mut statement = connection
            .prepare("SELECT meeting_id FROM meeting_deletions ORDER BY requested_at,meeting_id")?;
        let ids = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        ids.into_iter()
            .map(|meeting_id| {
                load_deletion_optional(&connection, &meeting_id)?
                    .ok_or_else(|| not_found("meeting deletion", &meeting_id))
            })
            .collect()
    }

    /// Recheck process-owned job leases without weakening their ownership.
    pub fn refresh_deletion(
        &self,
        meeting_id: &str,
        observed_at: &str,
    ) -> Result<MeetingDeletion, MeetingStoreError> {
        validate_id(meeting_id, "meeting id").map_err(MeetingStoreError::Validation)?;
        let observed_at = timestamp(observed_at)?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = load_deletion_optional_tx(&transaction, meeting_id)?
            .ok_or_else(|| not_found("meeting deletion", meeting_id))?;
        let deletion = refresh_deletion_tx(&transaction, existing, &observed_at)?;
        transaction.commit()?;
        Ok(deletion)
    }

    pub fn record_deletion_error(
        &self,
        meeting_id: &str,
        detail: &str,
        observed_at: &str,
    ) -> Result<MeetingDeletion, MeetingStoreError> {
        validate_id(meeting_id, "meeting id").map_err(MeetingStoreError::Validation)?;
        if detail.trim().is_empty() || detail.len() > 16_384 {
            return Err(MeetingStoreError::Validation(
                "deletion error must contain 1 to 16384 bytes".into(),
            ));
        }
        let observed_at = timestamp(observed_at)?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let updated = transaction.execute(
            "UPDATE meeting_deletions
             SET last_error=?2,updated_at=?3 WHERE meeting_id=?1",
            params![meeting_id, detail.trim(), observed_at],
        )?;
        if updated != 1 {
            return Err(not_found("meeting deletion", meeting_id));
        }
        let deletion = load_deletion_optional_tx(&transaction, meeting_id)?
            .expect("updated meeting deletion must exist");
        transaction.commit()?;
        Ok(deletion)
    }

    /// Advance after the private file owner has durably removed its owned
    /// artifacts. This boundary is persisted before SQLite authority changes.
    pub fn mark_deletion_files_removed(
        &self,
        meeting_id: &str,
        observed_at: &str,
    ) -> Result<MeetingDeletion, MeetingStoreError> {
        self.advance_deletion(
            meeting_id,
            MeetingDeletionStage::FilesPending,
            MeetingDeletionStage::DatabasePending,
            observed_at,
        )
    }

    /// Remove the SQLite-owned meeting/audio authority only after file removal
    /// is durable. The independent deletion journal intentionally survives the
    /// cascade so marker cleanup can be retried after a crash.
    pub fn remove_deletion_database_authority(
        &self,
        meeting_id: &str,
        observed_at: &str,
    ) -> Result<MeetingDeletion, MeetingStoreError> {
        validate_id(meeting_id, "meeting id").map_err(MeetingStoreError::Validation)?;
        let observed_at = timestamp(observed_at)?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let deletion = load_deletion_optional_tx(&transaction, meeting_id)?
            .ok_or_else(|| not_found("meeting deletion", meeting_id))?;
        if deletion.stage != MeetingDeletionStage::DatabasePending {
            return Err(MeetingStoreError::Validation(format!(
                "meeting deletion database boundary requires database-pending, found {}",
                deletion.stage.storage_key()
            )));
        }
        match deletion.mode {
            MeetingDeletionMode::Audio => {
                transaction
                    .execute("DELETE FROM audio_chunks WHERE meeting_id=?1", [meeting_id])?;
            }
            MeetingDeletionMode::All => {
                let running_jobs = running_job_count_tx(&transaction, meeting_id)?;
                if running_jobs != 0 {
                    return Err(MeetingStoreError::DeletionBlocked {
                        meeting_id: meeting_id.into(),
                        running_jobs,
                    });
                }
                transaction.execute("DELETE FROM meetings WHERE id=?1", [meeting_id])?;
            }
        }
        transaction.execute(
            "UPDATE meeting_deletions SET
               stage='marker-cleanup-pending',updated_at=?2,last_error=NULL
             WHERE meeting_id=?1",
            params![meeting_id, observed_at],
        )?;
        let deletion = load_deletion_optional_tx(&transaction, meeting_id)?
            .expect("advanced meeting deletion must exist");
        transaction.commit()?;
        Ok(deletion)
    }

    pub fn complete_deletion(&self, meeting_id: &str) -> Result<(), MeetingStoreError> {
        validate_id(meeting_id, "meeting id").map_err(MeetingStoreError::Validation)?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let deletion = load_deletion_optional_tx(&transaction, meeting_id)?
            .ok_or_else(|| not_found("meeting deletion", meeting_id))?;
        if deletion.stage != MeetingDeletionStage::MarkerCleanupPending {
            return Err(MeetingStoreError::Validation(format!(
                "meeting deletion cannot complete from {}",
                deletion.stage.storage_key()
            )));
        }
        transaction.execute(
            "DELETE FROM meeting_deletions WHERE meeting_id=?1",
            [meeting_id],
        )?;
        transaction.commit()?;
        Ok(())
    }

    fn advance_deletion(
        &self,
        meeting_id: &str,
        expected: MeetingDeletionStage,
        next: MeetingDeletionStage,
        observed_at: &str,
    ) -> Result<MeetingDeletion, MeetingStoreError> {
        validate_id(meeting_id, "meeting id").map_err(MeetingStoreError::Validation)?;
        let observed_at = timestamp(observed_at)?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let deletion = load_deletion_optional_tx(&transaction, meeting_id)?
            .ok_or_else(|| not_found("meeting deletion", meeting_id))?;
        if deletion.stage != expected {
            return Err(MeetingStoreError::Validation(format!(
                "meeting deletion expected {}, found {}",
                expected.storage_key(),
                deletion.stage.storage_key()
            )));
        }
        transaction.execute(
            "UPDATE meeting_deletions SET
               stage=?2,updated_at=?3,last_error=NULL WHERE meeting_id=?1",
            params![meeting_id, next.storage_key(), observed_at],
        )?;
        let deletion = load_deletion_optional_tx(&transaction, meeting_id)?
            .expect("advanced meeting deletion must exist");
        transaction.commit()?;
        Ok(deletion)
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
        if deletion_blocks_job_tx(&transaction, &job.meeting_id, &job.kind)? {
            return Err(deletion_in_progress_tx(&transaction, &job.meeting_id)?);
        }
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
                "SELECT j.id FROM follow_up_jobs j
                 WHERE j.state='pending'
                   AND j.not_before<=?1
                   AND j.attempts<j.max_attempts
                   AND NOT EXISTS (
                     SELECT 1 FROM meeting_deletions d
                     WHERE d.meeting_id=j.meeting_id
                       AND (
                         d.mode='all'
                         OR (d.mode='audio' AND j.kind='custom:transcription')
                       )
                   )
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
        let permanent_deletion: bool = transaction.query_row(
            "SELECT EXISTS(
               SELECT 1 FROM meeting_deletions
               WHERE meeting_id=?1 AND mode='all'
             )",
            [&current.definition.meeting_id],
            |row| row.get(0),
        )?;
        if permanent_deletion {
            transaction.execute(
                "UPDATE follow_up_jobs SET
                   state='cancelled',result_json=NULL,
                   last_error='result discarded by permanent meeting deletion',
                   lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=?2
                 WHERE id=?1",
                params![job_id, observed_at],
            )?;
            let deletion = load_deletion_optional_tx(&transaction, &current.definition.meeting_id)?
                .expect("permanent deletion query guaranteed a journal row");
            refresh_deletion_tx(&transaction, deletion, &observed_at)?;
            let job = load_job_tx(&transaction, job_id)?;
            transaction.commit()?;
            return Ok(job);
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
        let recovery_stops = {
            let mut statement = transaction.prepare(
                "SELECT m.id,m.started_at,m.stopped_at,MAX(a.end_ms)
                 FROM meetings m
                 LEFT JOIN audio_chunks a
                   ON a.meeting_id=m.id AND a.status='committed'
                 WHERE m.status IN ('recording','stopping','finalizing')
                 GROUP BY m.id,m.started_at,m.stopped_at
                 ORDER BY m.id",
            )?;
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<i64>>(3)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        for (meeting_id, started_at, stopped_at, last_committed_end_ms) in recovery_stops {
            if stopped_at.is_some() {
                continue;
            }
            let recovered_stop = if let Some(started_at) = started_at {
                let started = DateTime::parse_from_rfc3339(&started_at).map_err(|error| {
                    MeetingStoreError::Validation(format!(
                        "meeting '{meeting_id}' has an invalid start timestamp: {error}"
                    ))
                })?;
                started
                    .checked_add_signed(chrono::Duration::milliseconds(
                        last_committed_end_ms.unwrap_or(0),
                    ))
                    .ok_or_else(|| {
                        MeetingStoreError::Validation(format!(
                            "meeting '{meeting_id}' committed audio duration overflows its timestamp"
                        ))
                    })?
                    .with_timezone(&Utc)
                    .to_rfc3339_opts(SecondsFormat::Millis, true)
            } else {
                // A live meeting should always have a start timestamp. Keep a
                // corrupt legacy row recoverable without inventing an earlier
                // wall-clock time than the only durable observation.
                observed_at.clone()
            };
            transaction.execute(
                "UPDATE meetings SET stopped_at=?2 WHERE id=?1 AND stopped_at IS NULL",
                params![meeting_id, recovered_stop],
            )?;
        }
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
            "SELECT j.id FROM follow_up_jobs j
             WHERE j.state='running' AND j.attempts<j.max_attempts
               AND NOT EXISTS (
                 SELECT 1 FROM meeting_deletions d
                 WHERE d.meeting_id=j.meeting_id AND d.mode='all'
               )
             ORDER BY j.id",
        )?;
        let failed_job_ids = query_strings(
            &transaction,
            "SELECT j.id FROM follow_up_jobs j
             WHERE j.state='running' AND j.attempts>=j.max_attempts
               AND NOT EXISTS (
                 SELECT 1 FROM meeting_deletions d
                 WHERE d.meeting_id=j.meeting_id AND d.mode='all'
               )
             ORDER BY j.id",
        )?;
        transaction.execute(
            "UPDATE follow_up_jobs SET
               state=CASE WHEN attempts>=max_attempts THEN 'failed' ELSE 'pending' END,
               not_before=CASE WHEN attempts>=max_attempts THEN not_before ELSE ?1 END,
               last_error='worker lease lost during application restart',
               lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=?1
             WHERE state='running'
               AND NOT EXISTS (
                 SELECT 1 FROM meeting_deletions d
                 WHERE d.meeting_id=follow_up_jobs.meeting_id AND d.mode='all'
               )",
            [&observed_at],
        )?;
        transaction.execute(
            "UPDATE follow_up_jobs SET
               state='cancelled',last_error='cancelled by permanent meeting deletion after restart',
               result_json=NULL,lease_owner=NULL,lease_token=NULL,
               lease_expires_at=NULL,updated_at=?1
             WHERE state='running'
               AND EXISTS (
                 SELECT 1 FROM meeting_deletions d
                 WHERE d.meeting_id=follow_up_jobs.meeting_id AND d.mode='all'
               )",
            [&observed_at],
        )?;
        transaction.execute(
            "UPDATE meeting_deletions SET
               stage='files-pending',updated_at=?1
             WHERE mode='all' AND stage='waiting-for-jobs'
               AND NOT EXISTS (
                 SELECT 1 FROM follow_up_jobs j
                 WHERE j.meeting_id=meeting_deletions.meeting_id AND j.state='running'
               )",
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

    /// Reconcile the staged audio authority returned by
    /// [`recover_after_restart`] after the native capture adapter has verified
    /// its private files.
    ///
    /// `true` means every originally staged chunk is now committed. Corrupt or
    /// still-staged chunks fail closed so lifecycle recovery cannot bless a
    /// terminal transcript that omitted durable tail audio.
    pub fn finish_audio_recovery(
        &self,
        report: &RecoveryReport,
    ) -> Result<bool, MeetingStoreError> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut all_committed = true;
        for chunk in &report.staged_audio_chunks {
            let current = load_audio_chunk_optional_tx(&transaction, &chunk.definition.id)?
                .map(|(chunk, _)| chunk)
                .ok_or_else(|| not_found("audio chunk", &chunk.definition.id))?;
            all_committed &= current.status == AudioChunkStatus::Committed;
        }

        for meeting_id in &report.interrupted_meeting_ids {
            validate_id(meeting_id, "meeting id").map_err(MeetingStoreError::Validation)?;
            let (started_at, stopped_at, last_committed_end_ms) = transaction.query_row(
                "SELECT m.started_at,m.stopped_at,MAX(a.end_ms)
                 FROM meetings m
                 LEFT JOIN audio_chunks a
                   ON a.meeting_id=m.id AND a.status='committed'
                 WHERE m.id=?1
                 GROUP BY m.id,m.started_at,m.stopped_at",
                [meeting_id],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<i64>>(2)?,
                    ))
                },
            )?;
            let Some(started_at) = started_at else {
                continue;
            };
            let candidate = DateTime::parse_from_rfc3339(&started_at)
                .map_err(|error| {
                    MeetingStoreError::Validation(format!(
                        "meeting '{meeting_id}' has an invalid start timestamp: {error}"
                    ))
                })?
                .checked_add_signed(chrono::Duration::milliseconds(
                    last_committed_end_ms.unwrap_or(0),
                ))
                .ok_or_else(|| {
                    MeetingStoreError::Validation(format!(
                        "meeting '{meeting_id}' committed audio duration overflows its timestamp"
                    ))
                })?
                .with_timezone(&Utc);
            let should_advance = stopped_at
                .as_deref()
                .map(DateTime::parse_from_rfc3339)
                .transpose()
                .map_err(|error| {
                    MeetingStoreError::Validation(format!(
                        "meeting '{meeting_id}' has an invalid stop timestamp: {error}"
                    ))
                })?
                .is_none_or(|stopped| candidate > stopped);
            if should_advance {
                transaction.execute(
                    "UPDATE meetings SET stopped_at=?2 WHERE id=?1",
                    params![
                        meeting_id,
                        candidate.to_rfc3339_opts(SecondsFormat::Millis, true)
                    ],
                )?;
            }
        }
        transaction.commit()?;
        Ok(all_committed)
    }

    fn lock(&self) -> Result<MutexGuard<'_, Connection>, MeetingStoreError> {
        self.connection
            .lock()
            .map_err(|_| MeetingStoreError::Poisoned)
    }
}

fn repair_sqlite_files(database_path: &Path) -> Result<(), MeetingStoreError> {
    repair_private_file_if_exists(database_path)?;
    for suffix in ["-wal", "-shm", "-journal"] {
        let mut name = database_path.as_os_str().to_os_string();
        name.push(suffix);
        let sidecar = PathBuf::from(name);
        repair_private_file_if_exists(sidecar)?;
    }
    Ok(())
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
    if version < 2 {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        migration_v2(&transaction)?;
        transaction.pragma_update(None, "user_version", 2)?;
        transaction.commit()?;
    }
    if version < 3 {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        migration_v3(&transaction)?;
        transaction.pragma_update(None, "user_version", 3)?;
        transaction.commit()?;
    }
    if version < 4 {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        migration_v4(&transaction)?;
        transaction.pragma_update(None, "user_version", 4)?;
        transaction.commit()?;
    }
    if version < 5 {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        migration_v5(&transaction)?;
        transaction.pragma_update(None, "user_version", 5)?;
        transaction.commit()?;
    }
    if version < 6 {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        migration_v6(&transaction)?;
        transaction.pragma_update(None, "user_version", 6)?;
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

fn migration_v2(transaction: &Transaction<'_>) -> Result<(), MeetingStoreError> {
    transaction.execute_batch(
        "CREATE INDEX IF NOT EXISTS transcript_segments_timeline
         ON transcript_segments(meeting_id,start_ms,end_ms,segment_id);",
    )?;
    Ok(())
}

fn migration_v3(transaction: &Transaction<'_>) -> Result<(), MeetingStoreError> {
    transaction.execute_batch(
        "CREATE VIRTUAL TABLE transcript_segments_fts USING fts5(
           meeting_id UNINDEXED,
           segment_id UNINDEXED,
           text,
           tokenize='unicode61'
         );
         INSERT INTO transcript_segments_fts(meeting_id,segment_id,text)
           SELECT meeting_id,segment_id,text FROM transcript_segments;
         CREATE TRIGGER transcript_segments_fts_insert
         AFTER INSERT ON transcript_segments BEGIN
           INSERT INTO transcript_segments_fts(meeting_id,segment_id,text)
           VALUES (new.meeting_id,new.segment_id,new.text);
         END;
         CREATE TRIGGER transcript_segments_fts_update
         AFTER UPDATE ON transcript_segments BEGIN
           DELETE FROM transcript_segments_fts
           WHERE meeting_id=old.meeting_id AND segment_id=old.segment_id;
           INSERT INTO transcript_segments_fts(meeting_id,segment_id,text)
           VALUES (new.meeting_id,new.segment_id,new.text);
         END;
         CREATE TRIGGER transcript_segments_fts_delete
         AFTER DELETE ON transcript_segments BEGIN
           DELETE FROM transcript_segments_fts
           WHERE meeting_id=old.meeting_id AND segment_id=old.segment_id;
         END;",
    )?;
    Ok(())
}

fn migration_v4(transaction: &Transaction<'_>) -> Result<(), MeetingStoreError> {
    transaction.execute_batch(
        "CREATE TABLE meeting_deletions (
           meeting_id TEXT PRIMARY KEY,
           mode TEXT NOT NULL CHECK(mode IN ('audio','all')),
           stage TEXT NOT NULL CHECK(stage IN (
             'waiting-for-jobs','files-pending','database-pending',
             'marker-cleanup-pending'
           )),
           requested_at TEXT NOT NULL,
           updated_at TEXT NOT NULL,
           last_error TEXT
         );
         CREATE INDEX idx_meeting_deletions_stage
           ON meeting_deletions(stage,requested_at,meeting_id);",
    )?;
    Ok(())
}

fn migration_v5(transaction: &Transaction<'_>) -> Result<(), MeetingStoreError> {
    transaction.execute_batch(
        "CREATE TABLE meeting_content_search (
           meeting_id TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
           title TEXT NOT NULL,
           summary TEXT NOT NULL DEFAULT '',
           tags_json TEXT NOT NULL DEFAULT '[]',
           tags_text TEXT NOT NULL DEFAULT '',
           deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)),
           content_fingerprint TEXT NOT NULL DEFAULT 'missing'
         );
         INSERT INTO meeting_content_search(meeting_id,title)
           SELECT id,title FROM meetings;
         CREATE TRIGGER meeting_content_search_meeting_insert
         AFTER INSERT ON meetings BEGIN
           INSERT INTO meeting_content_search(meeting_id,title)
           VALUES (new.id,new.title);
         END;

         CREATE VIRTUAL TABLE meeting_content_search_fts USING fts5(
           meeting_id UNINDEXED,
           title,
           summary,
           tags,
           tokenize='trigram'
         );
         INSERT INTO meeting_content_search_fts(meeting_id,title,summary,tags)
           SELECT meeting_id,title,summary,tags_text FROM meeting_content_search;
         CREATE TRIGGER meeting_content_search_fts_insert
         AFTER INSERT ON meeting_content_search BEGIN
           INSERT INTO meeting_content_search_fts(meeting_id,title,summary,tags)
           VALUES (new.meeting_id,new.title,new.summary,new.tags_text);
         END;
         CREATE TRIGGER meeting_content_search_fts_update
         AFTER UPDATE ON meeting_content_search BEGIN
           DELETE FROM meeting_content_search_fts
           WHERE meeting_id=old.meeting_id;
           INSERT INTO meeting_content_search_fts(meeting_id,title,summary,tags)
           VALUES (new.meeting_id,new.title,new.summary,new.tags_text);
         END;
         CREATE TRIGGER meeting_content_search_fts_delete
         AFTER DELETE ON meeting_content_search BEGIN
           DELETE FROM meeting_content_search_fts
           WHERE meeting_id=old.meeting_id;
         END;",
    )?;
    Ok(())
}

fn migration_v6(transaction: &Transaction<'_>) -> Result<(), MeetingStoreError> {
    transaction.execute_batch(
        "CREATE TABLE transcript_repair_runs (
           meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
           capture_generation TEXT NOT NULL,
           provider_run_id TEXT NOT NULL,
           state TEXT NOT NULL CHECK(state IN ('collecting','committed')),
           started_at TEXT NOT NULL,
           updated_at TEXT NOT NULL,
           terminal_revision INTEGER,
           PRIMARY KEY(meeting_id,capture_generation),
           FOREIGN KEY(meeting_id,terminal_revision)
             REFERENCES transcript_revisions(meeting_id,revision),
           CHECK(
             (state='collecting' AND terminal_revision IS NULL)
             OR (state='committed' AND terminal_revision IS NOT NULL)
           )
         );
         CREATE TABLE transcript_repair_segments (
           meeting_id TEXT NOT NULL,
           capture_generation TEXT NOT NULL,
           segment_id TEXT NOT NULL,
           start_ms INTEGER NOT NULL CHECK(start_ms>=0),
           end_ms INTEGER NOT NULL CHECK(end_ms>start_ms),
           text TEXT NOT NULL,
           channel_id TEXT,
           speaker TEXT,
           confidence REAL,
           is_final INTEGER NOT NULL,
           metadata_json TEXT NOT NULL,
           updated_at TEXT NOT NULL,
           PRIMARY KEY(meeting_id,capture_generation,segment_id),
           FOREIGN KEY(meeting_id,capture_generation)
             REFERENCES transcript_repair_runs(meeting_id,capture_generation)
             ON DELETE CASCADE,
           FOREIGN KEY(meeting_id,channel_id)
             REFERENCES audio_channels(meeting_id,id),
           CHECK(confidence IS NULL OR (confidence>=0.0 AND confidence<=1.0))
         );
         CREATE INDEX idx_transcript_repair_state
           ON transcript_repair_runs(state,updated_at,meeting_id,capture_generation);

         -- Pre-v6 repair rows hash an intent keyed by mutable transcript
         -- revision. Rewriting only their key/payload would invalidate that
         -- request hash. Cancel the legacy owners atomically; startup scans
         -- every interrupted meeting and creates one freshly hashed job bound
         -- to its immutable capture generation.
         UPDATE follow_up_jobs
         SET state='cancelled',
             last_error='superseded by capture-generation repair ownership migration',
             lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL
         WHERE kind='custom:transcription'
           AND state IN ('pending','running');",
    )?;
    Ok(())
}

fn require_collecting_repair_tx(
    transaction: &Transaction<'_>,
    meeting_id: &str,
    capture_generation: &str,
    provider_run_id: &str,
) -> Result<(), MeetingStoreError> {
    let (state, _) =
        require_repair_tx(transaction, meeting_id, capture_generation, provider_run_id)?;
    if state != "collecting" {
        return Err(MeetingStoreError::Validation(format!(
            "transcript repair '{meeting_id}:{capture_generation}' is already committed"
        )));
    }
    Ok(())
}

fn require_repair_tx(
    transaction: &Transaction<'_>,
    meeting_id: &str,
    capture_generation: &str,
    provider_run_id: &str,
) -> Result<(String, Option<i64>), MeetingStoreError> {
    let repair = transaction
        .query_row(
            "SELECT provider_run_id,state,terminal_revision
             FROM transcript_repair_runs
             WHERE meeting_id=?1 AND capture_generation=?2",
            params![meeting_id, capture_generation],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| not_found("transcript repair", capture_generation))?;
    if repair.0 != provider_run_id {
        return Err(MeetingStoreError::IdempotencyConflict {
            key: format!("{meeting_id}:{capture_generation}"),
        });
    }
    Ok((repair.1, repair.2))
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

fn load_meeting_tx(
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

fn load_deletion_optional(
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

fn load_deletion_optional_tx(
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

fn deletion_from_row(row: &Row<'_>) -> rusqlite::Result<MeetingDeletion> {
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

fn deletion_mode(value: &str) -> Result<MeetingDeletionMode, String> {
    match value {
        "audio" => Ok(MeetingDeletionMode::Audio),
        "all" => Ok(MeetingDeletionMode::All),
        other => Err(format!("unknown meeting deletion mode '{other}'")),
    }
}

fn deletion_stage(value: &str) -> Result<MeetingDeletionStage, String> {
    match value {
        "waiting-for-jobs" => Ok(MeetingDeletionStage::WaitingForJobs),
        "files-pending" => Ok(MeetingDeletionStage::FilesPending),
        "database-pending" => Ok(MeetingDeletionStage::DatabasePending),
        "marker-cleanup-pending" => Ok(MeetingDeletionStage::MarkerCleanupPending),
        other => Err(format!("unknown meeting deletion stage '{other}'")),
    }
}

fn running_job_count_tx(
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

fn refresh_deletion_tx(
    transaction: &Transaction<'_>,
    mut deletion: MeetingDeletion,
    observed_at: &str,
) -> Result<MeetingDeletion, MeetingStoreError> {
    if deletion.mode == MeetingDeletionMode::All
        && deletion.stage == MeetingDeletionStage::WaitingForJobs
    {
        deletion.running_jobs = running_job_count_tx(transaction, &deletion.meeting_id)?;
        if deletion.running_jobs == 0 {
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

fn deletion_blocks_job_tx(
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

fn deletion_in_progress_tx(
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

fn reject_permanent_deletion(
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

fn current_segment_from_row(row: &Row<'_>) -> rusqlite::Result<TranscriptSegmentRecord> {
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
}

fn gap_from_row(row: &Row<'_>) -> rusqlite::Result<TranscriptGapRecord> {
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
        resolved_revision: row.get::<_, Option<i64>>(7)?.map(|value| value as u64),
    })
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
    const T4: &str = "2026-07-30T10:04:00Z";

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

    fn repair_terminal(base_revision: u64) -> TranscriptBatch {
        TranscriptBatch {
            meeting_id: "meeting-1".into(),
            batch_id: "repair-terminal".into(),
            base_revision,
            source: "repair-local-whisper".into(),
            observed_at: T3.into(),
            marks_final: true,
            changes: Vec::new(),
        }
    }

    fn interrupt(store: &MeetingStore) {
        let meeting = store.get_meeting("meeting-1").unwrap();
        store
            .transition_meeting(
                "meeting-1",
                meeting.revision,
                MeetingStatus::Interrupted,
                T2,
                None,
            )
            .unwrap();
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
    fn completing_a_meeting_and_enqueuing_its_summary_is_one_transaction() {
        let store = store();
        let recording = start_recording(&store);
        let stopping = store
            .transition_meeting(
                "meeting-1",
                recording.revision,
                MeetingStatus::Stopping,
                T2,
                None,
            )
            .unwrap();
        let finalizing = store
            .transition_meeting(
                "meeting-1",
                stopping.revision,
                MeetingStatus::Finalizing,
                T2,
                None,
            )
            .unwrap();
        let mut invalid_summary = job("summary-invalid", "summary:1", 3);
        invalid_summary.meeting_id = "another-meeting".into();
        assert!(
            store
                .complete_meeting_with_job(
                    "meeting-1",
                    finalizing.revision,
                    T3,
                    Some(&invalid_summary),
                )
                .is_err()
        );
        assert_eq!(
            store.get_meeting("meeting-1").unwrap().status,
            MeetingStatus::Finalizing
        );
        assert!(store.list_jobs("meeting-1").unwrap().is_empty());

        let summary = job("summary-valid", "summary:1", 3);
        let (completed, enqueued) = store
            .complete_meeting_with_job("meeting-1", finalizing.revision, T3, Some(&summary))
            .unwrap();
        assert_eq!(completed.status, MeetingStatus::Completed);
        assert_eq!(enqueued.unwrap().definition.id, summary.id);
        assert_eq!(store.list_jobs("meeting-1").unwrap().len(), 1);
    }

    #[test]
    fn schema_v5_backfills_existing_meeting_titles_into_private_search() {
        let mut connection = Connection::open_in_memory().unwrap();
        {
            let transaction = connection.transaction().unwrap();
            migration_v1(&transaction).unwrap();
            migration_v2(&transaction).unwrap();
            migration_v3(&transaction).unwrap();
            migration_v4(&transaction).unwrap();
            transaction
                .execute(
                    "INSERT INTO meetings (
                       id,title,origin_json,status,created_at,updated_at,metadata_json
                     ) VALUES (
                       'meeting-legacy','Legacy substring sentinel',
                       '{\"kind\":\"manual\",\"evidence\":{}}','completed',?1,?1,'{}'
                     )",
                    [T0],
                )
                .unwrap();
            transaction
                .pragma_update(None, "application_id", APPLICATION_ID)
                .unwrap();
            transaction.pragma_update(None, "user_version", 4).unwrap();
            transaction.commit().unwrap();
        }

        let store = MeetingStore::from_connection(connection, None).unwrap();
        assert_eq!(store.schema_version().unwrap(), CURRENT_SCHEMA_VERSION);
        let hits = store.search_content("acy substring", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].meeting_id, "meeting-legacy");
        assert!(hits[0].title_match);
    }

    #[test]
    fn schema_v6_cancels_mutable_revision_repairs_before_fresh_generation_ownership() {
        let mut connection = Connection::open_in_memory().unwrap();
        {
            let transaction = connection.transaction().unwrap();
            migration_v1(&transaction).unwrap();
            migration_v2(&transaction).unwrap();
            migration_v3(&transaction).unwrap();
            migration_v4(&transaction).unwrap();
            migration_v5(&transaction).unwrap();
            transaction
                .execute(
                    "INSERT INTO meetings (
                       id,title,origin_json,status,created_at,updated_at,metadata_json
                     ) VALUES (
                       'meeting-legacy-repair','Legacy repair',
                       '{\"kind\":\"manual\",\"evidence\":{}}','interrupted',?1,?1,
                       '{\"runId\":\"run-stable-generation\"}'
                     )",
                    [T0],
                )
                .unwrap();
            for (id, revision) in [("legacy-repair-zero", 0), ("legacy-repair-one", 1)] {
                transaction
                    .execute(
                        "INSERT INTO follow_up_jobs (
                           id,meeting_id,kind,idempotency_key,request_hash,payload_json,
                           state,attempts,max_attempts,not_before,created_at,updated_at
                         ) VALUES (
                           ?1,'meeting-legacy-repair','custom:transcription',?2,?3,?4,
                           'pending',0,3,?5,?5,?5
                         )",
                        params![
                            id,
                            format!("meeting-legacy-repair:transcription:{revision}"),
                            format!("legacy-intent-hash-{revision}"),
                            serde_json::to_string(&json!({
                                "meetingId": "meeting-legacy-repair",
                                "transcriptRevision": revision
                            }))
                            .unwrap(),
                            T0
                        ],
                    )
                    .unwrap();
            }
            transaction
                .pragma_update(None, "application_id", APPLICATION_ID)
                .unwrap();
            transaction.pragma_update(None, "user_version", 5).unwrap();
            transaction.commit().unwrap();
        }

        let store = MeetingStore::from_connection(connection, None).unwrap();
        assert_eq!(store.schema_version().unwrap(), CURRENT_SCHEMA_VERSION);
        let legacy = store.list_jobs("meeting-legacy-repair").unwrap();
        assert_eq!(legacy.len(), 2);
        assert!(legacy.iter().all(|job| job.state == JobState::Cancelled));
        assert!(legacy.iter().all(|job| {
            job.last_error.as_deref()
                == Some("superseded by capture-generation repair ownership migration")
        }));

        let fresh = FollowUpJobDraft {
            id: "job-transcription-run-stable-generation".into(),
            meeting_id: "meeting-legacy-repair".into(),
            kind: FollowUpJobKind::Custom("transcription".into()),
            idempotency_key: "meeting-legacy-repair:transcription:run-stable-generation".into(),
            payload: json!({
                "meetingId": "meeting-legacy-repair",
                "captureGeneration": "run-stable-generation",
                "transcriptionRoute": "local",
                "transcriptionModel": "whisper-small"
            }),
            max_attempts: 3,
            not_before: T1.into(),
        };
        let (enqueued, duplicate) = store.enqueue_job(&fresh, T1).unwrap();
        assert!(!duplicate);
        assert_eq!(enqueued.state, JobState::Pending);
    }

    #[test]
    fn reviewed_content_search_preserves_substrings_and_scrubs_fts_on_deletion() {
        let store = store();
        let created = store.create_meeting(&meeting(), T0).unwrap();
        store
            .transition_meeting(
                &created.id,
                created.revision,
                MeetingStatus::Failed,
                T1,
                Some(&MeetingFailure {
                    code: "fixture".into(),
                    message: "terminal fixture".into(),
                    retryable: false,
                }),
            )
            .unwrap();
        store
            .sync_content_search(
                "meeting-1",
                "Überarbeitete ReleasePlanung",
                Some("The decision lives beyond every library preview."),
                &["RoadmapSentinel".into()],
                false,
                "test-content-v1",
            )
            .unwrap();

        let title = store.search_content("leasePlan", 10).unwrap();
        assert_eq!(title.len(), 1);
        assert!(title[0].title_match);
        assert!(matches!(
            store.search_content("üb", 10),
            Err(MeetingStoreError::Validation(message))
                if message.contains("at least 3 characters")
        ));
        let short_unicode = store.search_content("übe", 10).unwrap();
        assert_eq!(short_unicode.len(), 1);
        assert!(short_unicode[0].title_match);
        let summary = store.search_content("beyond every", 10).unwrap();
        assert_eq!(summary.len(), 1);
        assert!(summary[0].summary_match);
        let tag = store.search_content("mapSent", 10).unwrap();
        assert_eq!(tag.len(), 1);
        assert!(tag[0].tags_match);

        store
            .begin_deletion("meeting-1", MeetingDeletionMode::All, T2)
            .unwrap();
        assert!(store
            .search_content("ReleasePlanung", 10)
            .unwrap()
            .is_empty());
        store.mark_deletion_files_removed("meeting-1", T3).unwrap();
        store
            .remove_deletion_database_authority("meeting-1", T4)
            .unwrap();
        let connection = store.lock().unwrap();
        let indexed_rows: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM meeting_content_search_fts
                 WHERE meeting_id='meeting-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(indexed_rows, 0, "permanent deletion retained indexed text");
    }

    #[cfg(unix)]
    #[test]
    fn meeting_database_and_wal_sidecars_are_repaired_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempdir().unwrap();
        let root = directory.path().join("meetings");
        std::fs::create_dir(&root).unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o777)).unwrap();
        let path = root.join("meetings.sqlite");
        let store = MeetingStore::open(&path).unwrap();
        store.create_meeting(&meeting(), T0).unwrap();

        assert_eq!(
            std::fs::metadata(&root).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let wal = PathBuf::from(format!("{}-wal", path.display()));
        let shm = PathBuf::from(format!("{}-shm", path.display()));
        assert!(wal.exists(), "WAL mode must keep a live write-ahead log");
        assert!(shm.exists(), "WAL mode must keep a live shared-memory file");

        // Simulate state left by an older permissive build, then verify an
        // ordinary startup repairs all SQLite-owned artifacts.
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o666)).unwrap();
        std::fs::set_permissions(&wal, std::fs::Permissions::from_mode(0o666)).unwrap();
        std::fs::set_permissions(&shm, std::fs::Permissions::from_mode(0o666)).unwrap();
        drop(store);
        let reopened = MeetingStore::open(&path).unwrap();
        reopened.repair_database_permissions().unwrap();
        for artifact in [&path, &wal, &shm] {
            if artifact.exists() {
                assert_eq!(
                    std::fs::metadata(artifact).unwrap().permissions().mode() & 0o777,
                    0o600,
                    "{} was not owner-only",
                    artifact.display()
                );
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn meeting_database_open_refuses_database_and_sidecar_symlinks() {
        use std::os::unix::fs::symlink;

        let directory = tempdir().unwrap();
        let root = directory.path().join("meetings");
        std::fs::create_dir(&root).unwrap();
        let outside = directory.path().join("outside.sqlite");
        std::fs::write(&outside, b"outside").unwrap();
        let database = root.join("meetings.sqlite");
        symlink(&outside, &database).unwrap();
        assert!(matches!(
            MeetingStore::open(&database),
            Err(MeetingStoreError::PrivateStorage(_))
        ));
        assert_eq!(std::fs::read(&outside).unwrap(), b"outside");

        std::fs::remove_file(&database).unwrap();
        let store = MeetingStore::open(&database).unwrap();
        drop(store);
        let outside_sidecar = directory.path().join("outside-sidecar");
        std::fs::write(&outside_sidecar, b"outside sidecar").unwrap();
        let wal = PathBuf::from(format!("{}-wal", database.display()));
        symlink(&outside_sidecar, &wal).unwrap();
        assert!(matches!(
            MeetingStore::open(&database),
            Err(MeetingStoreError::PrivateStorage(_))
        ));
        assert_eq!(std::fs::read(&outside_sidecar).unwrap(), b"outside sidecar");
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
    fn interrupted_and_failed_recordings_keep_a_terminal_stop_timestamp() {
        for (meeting_id, terminal) in [
            ("meeting-interrupted", MeetingStatus::Interrupted),
            ("meeting-failed", MeetingStatus::Failed),
        ] {
            let store = store();
            let mut draft = meeting();
            draft.id = meeting_id.into();
            let created = store.create_meeting(&draft, T0).unwrap();
            let recording = store
                .transition_meeting(
                    meeting_id,
                    created.revision,
                    MeetingStatus::Recording,
                    T1,
                    None,
                )
                .unwrap();
            let failure = (terminal == MeetingStatus::Failed).then_some(MeetingFailure {
                code: "capture-failed".into(),
                message: "capture worker ended".into(),
                retryable: true,
            });
            let ended = store
                .transition_meeting(
                    meeting_id,
                    recording.revision,
                    terminal,
                    T2,
                    failure.as_ref(),
                )
                .unwrap();
            assert_eq!(
                ended.stopped_at.as_deref(),
                Some("2026-07-30T10:02:00.000Z")
            );
        }
    }

    #[test]
    fn repair_replaces_partial_and_final_stt_rows_but_preserves_gaps_and_history() {
        let store = store();
        start_recording(&store);
        let mut old_final = segment("old-final", "Old final");
        old_final.is_final = true;
        let prior = batch(
            "prior-live",
            0,
            vec![
                TranscriptChange::UpsertSegment { segment: old_final },
                TranscriptChange::UpsertSegment {
                    segment: segment("stale-partial", "unfinished"),
                },
                TranscriptChange::OpenGap {
                    gap: TranscriptGapInput {
                        id: "capture-gap".into(),
                        start_ms: 1_000,
                        end_ms: 2_000,
                        reason: TranscriptGapReason::CaptureUnavailable,
                        channel_id: Some("system".into()),
                        detail: Some("capture sleep provenance".into()),
                    },
                },
            ],
        );
        store.apply_transcript_batch(&prior).unwrap();
        interrupt(&store);

        assert_eq!(
            store
                .begin_transcript_repair(
                    "meeting-1",
                    "run-generation-1",
                    "repair-run-generation-1",
                    T2,
                )
                .unwrap(),
            TranscriptRepairBegin::Collecting
        );
        let mut repaired = segment("new-final", "Repaired from audio sequence zero");
        repaired.is_final = true;
        store
            .stage_transcript_repair_batch(
                "run-generation-1",
                "repair-run-generation-1",
                &batch(
                    "repair-segments",
                    1,
                    vec![TranscriptChange::UpsertSegment { segment: repaired }],
                ),
            )
            .unwrap();
        let applied = store
            .commit_transcript_repair(
                "run-generation-1",
                "repair-run-generation-1",
                &repair_terminal(1),
            )
            .unwrap();
        assert_eq!(applied.revision, 2);
        assert!(!applied.duplicate);

        let current = store.transcript_snapshot("meeting-1", None).unwrap();
        assert_eq!(current.segments.len(), 1);
        assert_eq!(current.segments[0].segment.id, "new-final");
        assert!(current.segments[0].segment.is_final);
        assert_eq!(
            current.segments[0].segment.metadata["providerRunId"],
            "repair-run-generation-1"
        );
        assert_eq!(current.gaps.len(), 1);
        assert_eq!(current.gaps[0].gap.id, "capture-gap");

        let before_repair = store.transcript_snapshot("meeting-1", Some(1)).unwrap();
        assert_eq!(before_repair.segments.len(), 2);
        assert!(before_repair
            .segments
            .iter()
            .any(|segment| segment.segment.id == "stale-partial"));
        assert_eq!(before_repair.gaps[0].gap.id, "capture-gap");

        let duplicate = store
            .commit_transcript_repair(
                "run-generation-1",
                "repair-run-generation-1",
                &repair_terminal(1),
            )
            .unwrap();
        assert!(duplicate.duplicate);
        assert_eq!(duplicate.revision, 2);
    }

    #[test]
    fn repair_restart_twice_clears_stale_staging_and_requires_all_final_output() {
        let store = store();
        start_recording(&store);
        interrupt(&store);
        let mut partial = segment("provider-segment", "partial repair");
        partial.metadata = json!({"attempt": 1});
        store
            .begin_transcript_repair(
                "meeting-1",
                "run-generation-1",
                "repair-run-generation-1",
                T1,
            )
            .unwrap();
        store
            .stage_transcript_repair_batch(
                "run-generation-1",
                "repair-run-generation-1",
                &batch(
                    "repair-partial",
                    0,
                    vec![TranscriptChange::UpsertSegment { segment: partial }],
                ),
            )
            .unwrap();
        assert!(store
            .commit_transcript_repair(
                "run-generation-1",
                "repair-run-generation-1",
                &repair_terminal(0),
            )
            .unwrap_err()
            .to_string()
            .contains("unresolved partial"));

        // Two process restarts replay audio from zero under the same stable
        // provider run. Each begin clears only private staging; no partial
        // repair row ever reaches the authoritative transcript.
        for observed_at in [T2, T3] {
            assert_eq!(
                store
                    .begin_transcript_repair(
                        "meeting-1",
                        "run-generation-1",
                        "repair-run-generation-1",
                        observed_at,
                    )
                    .unwrap(),
                TranscriptRepairBegin::Collecting
            );
            assert_eq!(
                store
                    .transcript_overview("meeting-1", 1)
                    .unwrap()
                    .segment_count,
                0
            );
        }
        let mut final_segment = segment("provider-segment", "complete repair");
        final_segment.is_final = true;
        store
            .stage_transcript_repair_batch(
                "run-generation-1",
                "repair-run-generation-1",
                &batch(
                    "repair-final",
                    0,
                    vec![TranscriptChange::UpsertSegment {
                        segment: final_segment,
                    }],
                ),
            )
            .unwrap();
        store
            .commit_transcript_repair(
                "run-generation-1",
                "repair-run-generation-1",
                &repair_terminal(0),
            )
            .unwrap();
        let overview = store.transcript_overview("meeting-1", 1).unwrap();
        assert!(overview.is_final);
        assert_eq!(overview.segment_count, 1);
        assert_eq!(overview.non_final_segment_count, 0);
    }

    #[test]
    fn silent_repair_commits_an_empty_all_final_generation() {
        let store = store();
        start_recording(&store);
        interrupt(&store);
        store
            .begin_transcript_repair("meeting-1", "run-silent", "repair-run-silent", T2)
            .unwrap();
        store
            .commit_transcript_repair("run-silent", "repair-run-silent", &repair_terminal(0))
            .unwrap();
        let overview = store.transcript_overview("meeting-1", 1).unwrap();
        assert!(overview.is_final);
        assert_eq!(overview.segment_count, 0);
        assert_eq!(overview.non_final_segment_count, 0);
    }

    #[test]
    fn repair_reconciliation_is_one_revision_beyond_one_hundred_thousand_segments() {
        let store = store();
        start_recording(&store);
        interrupt(&store);
        store
            .begin_transcript_repair("meeting-1", "run-scale", "repair-run-scale", T2)
            .unwrap();
        {
            let connection = store.lock().unwrap();
            connection
                .execute_batch(
                    "WITH RECURSIVE counter(value) AS (
                       SELECT 0
                       UNION ALL
                       SELECT value+1 FROM counter WHERE value<100000
                     )
                     INSERT INTO transcript_repair_segments (
                       meeting_id,capture_generation,segment_id,start_ms,end_ms,
                       text,channel_id,speaker,confidence,is_final,metadata_json,
                       updated_at
                     )
                     SELECT 'meeting-1','run-scale',printf('segment-%06d',value),
                            value*10,value*10+9,printf('text %d',value),
                            'system',NULL,NULL,1,
                            '{\"owner\":\"stt\",\"providerRunId\":\"repair-run-scale\"}',
                            '2026-07-30T10:02:00Z'
                     FROM counter;",
                )
                .unwrap();
        }
        let applied = store
            .commit_transcript_repair("run-scale", "repair-run-scale", &repair_terminal(0))
            .unwrap();
        assert_eq!(applied.revision, 1);
        let overview = store.transcript_overview("meeting-1", 1).unwrap();
        assert_eq!(overview.segment_count, 100_001);
        assert_eq!(overview.non_final_segment_count, 0);
        assert!(overview.is_final);
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
    fn committed_audio_projection_is_status_filtered_keyset_ordered_and_bounded() {
        let store = store();
        start_recording(&store);
        for sequence in 0..4 {
            let chunk = AudioChunkDraft {
                id: format!("chunk-{sequence}"),
                meeting_id: "meeting-1".into(),
                channel_id: "mic".into(),
                sequence,
                start_ms: (sequence * 1_000) as i64,
                end_ms: (sequence * 1_000 + 1) as i64,
                sample_count: 1,
                byte_len: 4,
                sha256: format!("{sequence:x}").repeat(64),
                relative_path: format!("meeting-1/audio/mic/{sequence:08}.f32le"),
            };
            store.stage_audio_chunk(&chunk, T1).unwrap();
        }
        store.commit_audio_chunk("chunk-1", T2).unwrap();
        store
            .mark_audio_chunk_corrupt("chunk-2", "fixture corruption", T2)
            .unwrap();
        store.commit_audio_chunk("chunk-3", T2).unwrap();

        assert_eq!(
            store
                .committed_audio_chunks("meeting-1", "mic", 0, 10)
                .unwrap()
                .into_iter()
                .map(|chunk| chunk.definition.sequence)
                .collect::<Vec<_>>(),
            vec![1, 3]
        );
        assert_eq!(
            store
                .committed_audio_chunks("meeting-1", "mic", 2, 1)
                .unwrap()[0]
                .definition
                .sequence,
            3
        );
        assert!(store
            .committed_audio_chunks("meeting-1", "mic", 0, 0)
            .is_err());
        assert!(store
            .committed_audio_chunks("meeting-1", "mic", 0, MAX_COMMITTED_AUDIO_CHUNK_PAGE + 1,)
            .is_err());
    }

    #[test]
    fn permanent_deletion_tombstone_cancels_pending_work_and_waits_for_running_activity() {
        let store = store();
        let recording = start_recording(&store);
        store
            .transition_meeting(
                &recording.id,
                recording.revision,
                MeetingStatus::Failed,
                T2,
                Some(&MeetingFailure {
                    code: "terminal".into(),
                    message: "ready for deletion".into(),
                    retryable: false,
                }),
            )
            .unwrap();
        store
            .enqueue_job(&job("privacy-running", "privacy-running", 2), T2)
            .unwrap();
        let running = store
            .claim_next_job("privacy-worker", T2, T3)
            .unwrap()
            .unwrap();
        store
            .enqueue_job(&job("privacy-pending", "privacy-pending", 2), T2)
            .unwrap();

        let deletion = store
            .begin_deletion("meeting-1", MeetingDeletionMode::All, T2)
            .unwrap();
        assert_eq!(deletion.stage, MeetingDeletionStage::WaitingForJobs);
        assert_eq!(deletion.running_jobs, 1);
        assert!(matches!(
            store.get_meeting("meeting-1"),
            Err(MeetingStoreError::DeletionInProgress { .. })
        ));
        assert!(store.list_meetings(10).unwrap().is_empty());
        assert!(store
            .claim_next_job("another-worker", T2, T3)
            .unwrap()
            .is_none());
        assert_eq!(
            store
                .list_jobs("meeting-1")
                .unwrap()
                .iter()
                .find(|job| job.definition.id == "privacy-pending")
                .unwrap()
                .state,
            JobState::Cancelled
        );
        assert!(matches!(
            store.enqueue_job(&job("late-job", "late-job", 2), T2),
            Err(MeetingStoreError::DeletionInProgress { .. })
        ));

        let finished = store
            .finish_job(
                &running.definition.id,
                running.lease_token.as_deref().unwrap(),
                &JobFinish::Succeeded {
                    result: json!({"title": "must not survive"}),
                },
                T3,
            )
            .unwrap();
        assert_eq!(finished.state, JobState::Cancelled);
        assert!(finished.result.is_none());
        assert_eq!(
            store.deletion("meeting-1").unwrap().unwrap().stage,
            MeetingDeletionStage::FilesPending
        );
        store.mark_deletion_files_removed("meeting-1", T3).unwrap();
        store
            .remove_deletion_database_authority("meeting-1", T3)
            .unwrap();
        assert_eq!(
            store.deletion("meeting-1").unwrap().unwrap().stage,
            MeetingDeletionStage::MarkerCleanupPending
        );
        store.complete_deletion("meeting-1").unwrap();
        assert!(matches!(
            store.get_meeting("meeting-1"),
            Err(MeetingStoreError::NotFound { .. })
        ));
    }

    #[test]
    fn audio_deletion_rejects_transcription_recovery_holds_and_replays_independently() {
        let store = store();
        let recording = start_recording(&store);
        let chunk = AudioChunkDraft {
            id: "privacy-chunk".into(),
            meeting_id: recording.id.clone(),
            channel_id: "mic".into(),
            sequence: 0,
            start_ms: 0,
            end_ms: 1_000,
            sample_count: 48_000,
            byte_len: 192_000,
            sha256: "a".repeat(64),
            relative_path: "meeting-1/audio/mic/00000000.f32le".into(),
        };
        store.stage_audio_chunk(&chunk, T1).unwrap();
        let failed = store
            .transition_meeting(
                "meeting-1",
                recording.revision,
                MeetingStatus::Failed,
                T2,
                Some(&MeetingFailure {
                    code: "recovery".into(),
                    message: "terminal with staged audio".into(),
                    retryable: false,
                }),
            )
            .unwrap();
        assert_eq!(failed.status, MeetingStatus::Failed);
        assert!(store
            .begin_deletion("meeting-1", MeetingDeletionMode::Audio, T2)
            .unwrap_err()
            .to_string()
            .contains("transcription recovery"));

        store.commit_audio_chunk(&chunk.id, T2).unwrap();
        let mut transcription = job("repair-job", "repair", 2);
        transcription.kind = FollowUpJobKind::Custom("transcription".into());
        store.enqueue_job(&transcription, T2).unwrap();
        assert!(store
            .begin_deletion("meeting-1", MeetingDeletionMode::Audio, T2)
            .unwrap_err()
            .to_string()
            .contains("transcription recovery"));
        store.cancel_job("repair-job", T2).unwrap();
        store
            .enqueue_job(&job("summary-job", "summary", 2), T2)
            .unwrap();
        let deletion = store
            .begin_deletion("meeting-1", MeetingDeletionMode::Audio, T2)
            .unwrap();
        assert_eq!(deletion.stage, MeetingDeletionStage::FilesPending);
        assert_eq!(
            store
                .claim_next_job("summary-worker", T2, T3)
                .unwrap()
                .unwrap()
                .definition
                .id,
            "summary-job"
        );
        store.mark_deletion_files_removed("meeting-1", T3).unwrap();
        store
            .remove_deletion_database_authority("meeting-1", T3)
            .unwrap();
        store.complete_deletion("meeting-1").unwrap();
        assert_eq!(
            store.get_meeting("meeting-1").unwrap().status,
            MeetingStatus::Failed
        );
        assert!(store
            .recover_after_restart(T3)
            .unwrap()
            .staged_audio_chunks
            .is_empty());
    }

    #[test]
    fn audio_deletion_rejects_collecting_repair_after_job_attempts_are_exhausted() {
        let store = store();
        let recording = start_recording(&store);
        let interrupted = store
            .transition_meeting(
                "meeting-1",
                recording.revision,
                MeetingStatus::Interrupted,
                T2,
                None,
            )
            .unwrap();
        assert_eq!(interrupted.status, MeetingStatus::Interrupted);
        assert_eq!(
            store
                .begin_transcript_repair("meeting-1", "capture-generation", "provider-run", T2)
                .unwrap(),
            TranscriptRepairBegin::Collecting
        );
        assert!(store.has_retention_hold("meeting-1").unwrap());

        assert!(store
            .begin_deletion("meeting-1", MeetingDeletionMode::Audio, T3)
            .unwrap_err()
            .to_string()
            .contains("transcription recovery"));
    }

    #[test]
    fn deletion_journal_survives_every_database_boundary_and_meeting_cascade() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("meetings.sqlite");
        {
            let store = MeetingStore::open(&path).unwrap();
            let recording = start_recording(&store);
            store
                .transition_meeting(
                    "meeting-1",
                    recording.revision,
                    MeetingStatus::Failed,
                    T2,
                    Some(&MeetingFailure {
                        code: "terminal".into(),
                        message: "ready".into(),
                        retryable: false,
                    }),
                )
                .unwrap();
            store
                .begin_deletion("meeting-1", MeetingDeletionMode::All, T2)
                .unwrap();
        }
        {
            let store = MeetingStore::open(&path).unwrap();
            assert_eq!(
                store.pending_deletions().unwrap()[0].stage,
                MeetingDeletionStage::FilesPending
            );
            store.mark_deletion_files_removed("meeting-1", T3).unwrap();
        }
        {
            let store = MeetingStore::open(&path).unwrap();
            assert_eq!(
                store.pending_deletions().unwrap()[0].stage,
                MeetingDeletionStage::DatabasePending
            );
            store
                .remove_deletion_database_authority("meeting-1", T3)
                .unwrap();
        }
        {
            let store = MeetingStore::open(&path).unwrap();
            assert!(matches!(
                store.get_meeting("meeting-1"),
                Err(MeetingStoreError::DeletionInProgress { .. })
            ));
            assert_eq!(
                store.pending_deletions().unwrap()[0].stage,
                MeetingDeletionStage::MarkerCleanupPending
            );
            store.complete_deletion("meeting-1").unwrap();
            assert!(matches!(
                store.get_meeting("meeting-1"),
                Err(MeetingStoreError::NotFound { .. })
            ));
        }
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
    fn transcript_pages_remain_bounded_and_stable_at_one_hundred_thousand_segments() {
        let store = store();
        start_recording(&store);
        {
            let mut connection = store.lock().unwrap();
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .unwrap();
            transaction
                .execute(
                    "INSERT INTO transcript_revisions (
                       meeting_id,revision,base_revision,batch_id,source,observed_at,marks_final
                     ) VALUES ('meeting-1',1,0,'scale-fixture','test',?1,0)",
                    [T2],
                )
                .unwrap();
            transaction
                .execute(
                    "UPDATE meetings SET transcript_revision=1 WHERE id='meeting-1'",
                    [],
                )
                .unwrap();
            {
                let mut insert = transaction
                    .prepare(
                        "INSERT INTO transcript_segments (
                           meeting_id,segment_id,start_ms,end_ms,text,channel_id,speaker,
                           confidence,is_final,metadata_json,created_revision,updated_revision
                         ) VALUES ('meeting-1',?1,?2,?3,'word','system',NULL,0.9,1,'{}',1,1)",
                    )
                    .unwrap();
                for index in 0_i64..100_000 {
                    let start_ms = index * 1_000;
                    insert
                        .execute(params![
                            format!("segment-{index:06}"),
                            start_ms,
                            start_ms + 900
                        ])
                        .unwrap();
                }
            }
            transaction.commit().unwrap();
        }

        let latest = store.transcript_page("meeting-1", None, 10_000).unwrap();
        assert_eq!(latest.total_segments, 100_000);
        assert_eq!(latest.segments.len(), MAX_TRANSCRIPT_PAGE_SEGMENTS as usize);
        assert!(latest.has_more);
        assert_eq!(
            latest.segments.first().unwrap().segment.start_ms,
            99_750_000
        );
        assert_eq!(latest.segments.last().unwrap().segment.start_ms, 99_999_000);
        assert!(
            serde_json::to_vec(&latest.segments).unwrap().len() < 128 * 1024,
            "a single IPC transcript page exceeded its 128 KiB payload budget"
        );

        let older = store
            .transcript_page("meeting-1", latest.next_before.as_ref(), 250)
            .unwrap();
        assert_eq!(older.segments.len(), 250);
        assert_eq!(older.segments.first().unwrap().segment.start_ms, 99_500_000);
        assert_eq!(older.segments.last().unwrap().segment.start_ms, 99_749_000);
        assert_ne!(
            latest.segments.first().unwrap().segment.id,
            older.segments.last().unwrap().segment.id
        );
        for status in [
            MeetingStatus::Stopping,
            MeetingStatus::Finalizing,
            MeetingStatus::Completed,
        ] {
            let meeting = store.get_meeting("meeting-1").unwrap();
            store
                .transition_meeting("meeting-1", meeting.revision, status, T3, None)
                .unwrap();
        }
        let hits = store.search_transcript("word", 300).unwrap();
        assert_eq!(hits.len(), 3);
        assert!(hits.iter().all(|hit| hit.meeting_id == "meeting-1"));
    }

    #[test]
    fn meeting_keyset_pages_reach_records_beyond_the_old_one_thousand_cap() {
        let store = store();
        {
            let mut connection = store.lock().unwrap();
            let transaction = connection.transaction().unwrap();
            {
                let mut insert = transaction
                    .prepare(
                        "INSERT INTO meetings (
                           id,title,origin_json,status,created_at,updated_at,metadata_json
                         ) VALUES (
                           ?1,'Scale','{\"kind\":\"manual\",\"evidence\":{}}',
                           'completed',?2,?2,'{}'
                         )",
                    )
                    .unwrap();
                for index in 0..1_205 {
                    insert
                        .execute(params![
                            format!("meeting-{index:04}"),
                            format!("2026-07-{:02}T10:00:00Z", 1 + index % 30)
                        ])
                        .unwrap();
                }
            }
            transaction.commit().unwrap();
        }

        let mut before = None;
        let mut ids = Vec::new();
        loop {
            let page = store.list_meetings_page(before.as_ref(), 250).unwrap();
            ids.extend(page.meetings.iter().map(|meeting| meeting.id.clone()));
            if !page.has_more {
                break;
            }
            before = page.next_before;
        }
        assert_eq!(ids.len(), 1_205);
        assert_eq!(
            ids.iter().collect::<std::collections::HashSet<_>>().len(),
            1_205
        );
        assert!(ids.contains(&"meeting-0000".to_string()));
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
        let committed_chunk = AudioChunkDraft {
            id: "chunk-committed".into(),
            meeting_id: "meeting-1".into(),
            channel_id: "mic".into(),
            sequence: 0,
            start_ms: 0,
            end_ms: 42_000,
            sample_count: 2_016_000,
            byte_len: 8_064_000,
            sha256: "b".repeat(64),
            relative_path: "meeting-1/mic/000000.f32le".into(),
        };
        store.stage_audio_chunk(&committed_chunk, T1).unwrap();
        store.commit_audio_chunk(&committed_chunk.id, T1).unwrap();
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
            recovered.stopped_at.as_deref(),
            Some("2026-07-30T10:01:42.000Z")
        );
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
