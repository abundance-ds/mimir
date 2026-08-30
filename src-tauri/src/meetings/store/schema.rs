use super::*;

pub(super) fn repair_sqlite_files(database_path: &Path) -> Result<(), MeetingStoreError> {
    repair_private_file_if_exists(database_path)?;
    for suffix in ["-wal", "-shm", "-journal"] {
        let mut name = database_path.as_os_str().to_os_string();
        name.push(suffix);
        let sidecar = PathBuf::from(name);
        repair_private_file_if_exists(sidecar)?;
    }
    Ok(())
}

pub(super) fn migrate(connection: &mut Connection) -> Result<(), MeetingStoreError> {
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

pub(super) fn schema_version(connection: &Connection) -> Result<u32, MeetingStoreError> {
    Ok(connection.pragma_query_value(None, "user_version", |row| row.get(0))?)
}

pub(super) fn migration_v1(transaction: &Transaction<'_>) -> Result<(), MeetingStoreError> {
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

pub(super) fn migration_v2(transaction: &Transaction<'_>) -> Result<(), MeetingStoreError> {
    transaction.execute_batch(
        "CREATE INDEX IF NOT EXISTS transcript_segments_timeline
         ON transcript_segments(meeting_id,start_ms,end_ms,segment_id);",
    )?;
    Ok(())
}

pub(super) fn migration_v3(transaction: &Transaction<'_>) -> Result<(), MeetingStoreError> {
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

pub(super) fn migration_v4(transaction: &Transaction<'_>) -> Result<(), MeetingStoreError> {
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

pub(super) fn migration_v5(transaction: &Transaction<'_>) -> Result<(), MeetingStoreError> {
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
