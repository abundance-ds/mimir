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
    create_private_file, ensure_private_directory, repair_private_file_if_exists, PersistenceError,
};
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row, Transaction, TransactionBehavior};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
    time::Duration,
};
use thiserror::Error;
use uuid::Uuid;

mod audio;
mod deletion;
mod helpers;
mod job_records;
mod jobs;
mod meetings;
mod records;
mod schema;
mod transcript_queries;
mod transcript_read;
mod transcript_records;
mod transcript_write;

use helpers::*;
use job_records::*;
use records::*;
use transcript_queries::*;
use transcript_records::*;

use schema::{migrate, repair_sqlite_files, schema_version};
#[cfg(test)]
use schema::{migration_v1, migration_v2, migration_v3, migration_v4, migration_v5};

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

    fn lock(&self) -> Result<MutexGuard<'_, Connection>, MeetingStoreError> {
        self.connection
            .lock()
            .map_err(|_| MeetingStoreError::Poisoned)
    }
}

#[cfg(test)]
mod tests;
