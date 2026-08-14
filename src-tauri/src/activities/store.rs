use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::{mpsc, Arc, Mutex, MutexGuard},
    thread,
    time::{Duration, Instant},
};

use super::{ActivityRecord, OutputChunk};

const DATABASE_FILE: &str = "activities.sqlite3";
const STORE_BATCH_WINDOW: Duration = Duration::from_millis(20);
const STORE_QUEUE_CAPACITY: usize = 256;
pub const TERMINAL_CHECKPOINT_FORMAT_VERSION: u32 = 1;
const MAX_CHECKPOINT_BYTES: usize = 16 * 1024 * 1024;
const MAX_SEARCH_TEXT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum TerminalEvent {
    Output { sequence: u64, bytes: Vec<u8> },
    Resize { sequence: u64, cols: u16, rows: u16 },
}

impl TerminalEvent {
    pub fn sequence(&self) -> u64 {
        match self {
            Self::Output { sequence, .. } | Self::Resize { sequence, .. } => *sequence,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCheckpoint {
    pub revision: u64,
    pub through_sequence: u64,
    pub cols: u16,
    pub rows: u16,
    pub format_version: u32,
    pub engine_version: String,
    pub unicode_version: String,
    pub data: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalRestoreState {
    pub checkpoint: Option<TerminalCheckpoint>,
    pub revision: u64,
    pub base_sequence: u64,
    pub first_sequence: Option<u64>,
    pub last_sequence: u64,
    pub truncated: bool,
    pub cols: u16,
    pub rows: u16,
    pub events: Vec<TerminalEvent>,
}

#[derive(Debug, Clone)]
pub struct SaveTerminalCheckpoint {
    pub activity_id: String,
    pub run_id: String,
    pub base_revision: u64,
    pub through_sequence: u64,
    pub cols: u16,
    pub rows: u16,
    pub format_version: u32,
    pub engine_version: String,
    pub unicode_version: String,
    pub data: String,
    pub search_text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedTerminalCheckpoint {
    pub revision: u64,
    pub through_sequence: u64,
}

#[derive(Debug, Clone)]
pub struct LoadedActivity {
    pub record: ActivityRecord,
    pub byte_cap: usize,
    pub chunks: Vec<OutputChunk>,
    pub next_sequence: u64,
    pub truncated: bool,
    pub checkpoint_through_sequence: u64,
    pub checkpoint_search_text: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone)]
pub struct LegacyActivity {
    pub source_name: String,
    pub record: ActivityRecord,
    pub byte_cap: usize,
    pub chunks: Vec<OutputChunk>,
    pub next_sequence: u64,
    pub truncated: bool,
}

pub struct ActivityStore {
    tx: Option<mpsc::SyncSender<StoreCommand>>,
    errors: Arc<Mutex<Vec<String>>>,
    worker: Arc<Mutex<Option<thread::JoinHandle<()>>>>,
}

impl Clone for ActivityStore {
    fn clone(&self) -> Self {
        Self {
            tx: self.tx.clone(),
            errors: self.errors.clone(),
            worker: self.worker.clone(),
        }
    }
}

impl Drop for ActivityStore {
    fn drop(&mut self) {
        if Arc::strong_count(&self.worker) != 1 {
            return;
        }
        // Close the final sender before joining. The worker drains all queued
        // commands, drops SQLite, and removes transient WAL sidecars before
        // the owning supervisor finishes its own drop.
        self.tx.take();
        if let Some(worker) = lock(&self.worker).take() {
            let _ = worker.join();
        }
    }
}

enum StoreCommand {
    BeginRun {
        record: ActivityRecord,
        byte_cap: usize,
        cols: u16,
        rows: u16,
    },
    SaveRecord {
        record: ActivityRecord,
        byte_cap: usize,
    },
    AppendEvent {
        activity_id: String,
        run_id: String,
        event: TerminalEvent,
    },
    ImportLegacy {
        activity: LegacyActivity,
        ack: mpsc::Sender<Result<bool, String>>,
    },
    LoadAll {
        ack: mpsc::Sender<Result<Vec<LoadedActivity>, String>>,
    },
    LoadLegacySources {
        ack: mpsc::Sender<Result<Vec<String>, String>>,
    },
    Restore {
        activity_id: String,
        run_id: String,
        ack: mpsc::Sender<Result<TerminalRestoreState, String>>,
    },
    SaveCheckpoint {
        checkpoint: Box<SaveTerminalCheckpoint>,
        ack: mpsc::Sender<Result<SavedTerminalCheckpoint, String>>,
    },
    Delete {
        activity_id: String,
        ack: mpsc::Sender<Result<(), String>>,
    },
    Flush(mpsc::Sender<Result<(), String>>),
}

impl ActivityStore {
    pub fn start(directory: &Path) -> Result<Self, String> {
        let path = directory.join(DATABASE_FILE);
        let connection = open_database(&path)?;
        let (tx, rx) = mpsc::sync_channel(STORE_QUEUE_CAPACITY);
        let errors = Arc::new(Mutex::new(Vec::new()));
        let worker_errors = errors.clone();
        let worker = thread::Builder::new()
            .name("activity-store".into())
            .spawn(move || store_loop(connection, rx, worker_errors))
            .map_err(|error| format!("Could not start Activity store: {error}"))?;
        Ok(Self {
            tx: Some(tx),
            errors,
            worker: Arc::new(Mutex::new(Some(worker))),
        })
    }

    pub fn database_path(directory: &Path) -> PathBuf {
        directory.join(DATABASE_FILE)
    }

    pub fn begin_run(&self, record: ActivityRecord, byte_cap: usize, cols: u16, rows: u16) {
        self.send(StoreCommand::BeginRun {
            record,
            byte_cap,
            cols,
            rows,
        });
    }

    pub fn save_record(&self, record: ActivityRecord, byte_cap: usize) {
        self.send(StoreCommand::SaveRecord { record, byte_cap });
    }

    pub fn append_event(&self, activity_id: String, run_id: String, event: TerminalEvent) {
        self.send(StoreCommand::AppendEvent {
            activity_id,
            run_id,
            event,
        });
    }

    pub fn import_legacy(&self, activity: LegacyActivity) -> Result<bool, String> {
        let (ack_tx, ack_rx) = mpsc::channel();
        self.send_result(StoreCommand::ImportLegacy {
            activity,
            ack: ack_tx,
        })?;
        receive(ack_rx, "importing legacy Activity")?
    }

    pub fn load_all(&self) -> Result<Vec<LoadedActivity>, String> {
        let (ack_tx, ack_rx) = mpsc::channel();
        self.send_result(StoreCommand::LoadAll { ack: ack_tx })?;
        receive(ack_rx, "loading Activities")?
    }

    pub fn legacy_sources(&self) -> Result<Vec<String>, String> {
        let (ack_tx, ack_rx) = mpsc::channel();
        self.send_result(StoreCommand::LoadLegacySources { ack: ack_tx })?;
        receive(ack_rx, "loading Activity migration markers")?
    }

    pub fn restore(&self, activity_id: &str, run_id: &str) -> Result<TerminalRestoreState, String> {
        let (ack_tx, ack_rx) = mpsc::channel();
        self.send_result(StoreCommand::Restore {
            activity_id: activity_id.to_string(),
            run_id: run_id.to_string(),
            ack: ack_tx,
        })?;
        receive(ack_rx, "restoring terminal state")?
    }

    pub fn save_checkpoint(
        &self,
        checkpoint: SaveTerminalCheckpoint,
    ) -> Result<SavedTerminalCheckpoint, String> {
        let (ack_tx, ack_rx) = mpsc::channel();
        self.send_result(StoreCommand::SaveCheckpoint {
            checkpoint: Box::new(checkpoint),
            ack: ack_tx,
        })?;
        receive(ack_rx, "saving terminal checkpoint")?
    }

    pub fn delete(&self, activity_id: &str) -> Result<(), String> {
        let (ack_tx, ack_rx) = mpsc::channel();
        self.send_result(StoreCommand::Delete {
            activity_id: activity_id.to_string(),
            ack: ack_tx,
        })?;
        receive(ack_rx, "deleting Activity")?
    }

    pub fn flush(&self) -> Result<(), String> {
        let (ack_tx, ack_rx) = mpsc::channel();
        self.send_result(StoreCommand::Flush(ack_tx))?;
        receive(ack_rx, "flushing Activity store")??;
        let errors = lock(&self.errors);
        errors.last().map_or(Ok(()), |error| Err(error.clone()))
    }

    pub fn take_errors(&self) -> Vec<String> {
        std::mem::take(&mut *lock(&self.errors))
    }

    fn send(&self, command: StoreCommand) {
        if self
            .tx
            .as_ref()
            .is_none_or(|sender| sender.send(command).is_err())
        {
            lock(&self.errors).push("Activity store worker channel closed".into());
        }
    }

    fn send_result(&self, command: StoreCommand) -> Result<(), String> {
        self.tx
            .as_ref()
            .ok_or_else(|| "Activity store worker channel closed".to_string())?
            .send(command)
            .map_err(|_| "Activity store worker channel closed".to_string())
    }
}

fn receive<T>(receiver: mpsc::Receiver<T>, operation: &str) -> Result<T, String> {
    receiver
        .recv()
        .map_err(|_| format!("Activity store stopped while {operation}"))
}

fn open_database(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open(path)
        .map_err(|error| format!("Could not open {}: {error}", path.display()))?;
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .and_then(|_| connection.pragma_update(None, "synchronous", "NORMAL"))
        .and_then(|_| connection.pragma_update(None, "foreign_keys", "ON"))
        .and_then(|_| connection.pragma_update(None, "wal_autocheckpoint", 1000))
        .map_err(|error| format!("Could not configure {}: {error}", path.display()))?;
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS activity_records (
                activity_id TEXT PRIMARY KEY,
                record_json BLOB NOT NULL,
                byte_cap INTEGER NOT NULL,
                run_id TEXT NOT NULL,
                next_sequence INTEGER NOT NULL,
                truncated_through INTEGER NOT NULL DEFAULT 0,
                tail_bytes INTEGER NOT NULL DEFAULT 0,
                cols INTEGER NOT NULL,
                rows INTEGER NOT NULL,
                checkpoint_revision INTEGER NOT NULL DEFAULT 0,
                checkpoint_through INTEGER NOT NULL DEFAULT 0,
                checkpoint_cols INTEGER,
                checkpoint_rows INTEGER,
                checkpoint_format INTEGER,
                checkpoint_engine TEXT,
                checkpoint_unicode TEXT,
                checkpoint_data TEXT,
                checkpoint_search_text TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS terminal_events (
                activity_id TEXT NOT NULL,
                run_id TEXT NOT NULL,
                sequence INTEGER NOT NULL,
                kind INTEGER NOT NULL,
                data BLOB,
                cols INTEGER,
                rows INTEGER,
                PRIMARY KEY (activity_id, run_id, sequence),
                FOREIGN KEY (activity_id) REFERENCES activity_records(activity_id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS terminal_events_run
                ON terminal_events(activity_id, run_id, sequence);
            CREATE TABLE IF NOT EXISTS legacy_activity_imports (
                source_name TEXT PRIMARY KEY,
                activity_id TEXT NOT NULL,
                FOREIGN KEY (activity_id) REFERENCES activity_records(activity_id) ON DELETE CASCADE
            );",
        )
        .map_err(|error| format!("Could not initialize {}: {error}", path.display()))?;
    ensure_column(
        &connection,
        "activity_records",
        "tail_bytes",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    connection
        .execute_batch(
            "UPDATE activity_records
                SET tail_bytes = COALESCE((
                    SELECT SUM(length(data)) FROM terminal_events
                     WHERE terminal_events.activity_id = activity_records.activity_id
                       AND terminal_events.run_id = activity_records.run_id
                       AND terminal_events.kind = 0
                ), 0)
              WHERE tail_bytes = 0;",
        )
        .map_err(|error| format!("Could not reconcile Activity store counters: {error}"))?;
    Ok(connection)
}

fn ensure_column(
    connection: &Connection,
    table: &str,
    column: &str,
    declaration: &str,
) -> Result<(), String> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| format!("Could not inspect Activity store schema: {error}"))?;
    let present = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| format!("Could not read Activity store schema: {error}"))?
        .filter_map(Result::ok)
        .any(|name| name == column);
    if !present {
        connection
            .execute_batch(&format!(
                "ALTER TABLE {table} ADD COLUMN {column} {declaration}"
            ))
            .map_err(|error| format!("Could not upgrade Activity store schema: {error}"))?;
    }
    Ok(())
}

fn store_loop(
    mut connection: Connection,
    receiver: mpsc::Receiver<StoreCommand>,
    errors: Arc<Mutex<Vec<String>>>,
) {
    while let Ok(first) = receiver.recv() {
        let mut commands = vec![first];
        let deadline = Instant::now() + STORE_BATCH_WINDOW;
        while commands.len() < STORE_QUEUE_CAPACITY {
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                break;
            };
            match receiver.recv_timeout(remaining) {
                Ok(command) => commands.push(command),
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }

        let result = apply_batch(&mut connection, commands);
        if let Err(error) = result {
            lock(&errors).push(error);
        }
    }
}

fn apply_batch(connection: &mut Connection, commands: Vec<StoreCommand>) -> Result<(), String> {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Could not begin Activity store transaction: {error}"))?;
    let mut deferred = Vec::new();

    for command in commands {
        match command {
            StoreCommand::BeginRun {
                record,
                byte_cap,
                cols,
                rows,
            } => begin_run(&transaction, &record, byte_cap, cols, rows)?,
            StoreCommand::SaveRecord { record, byte_cap } => {
                save_record(&transaction, &record, byte_cap)?
            }
            StoreCommand::AppendEvent {
                activity_id,
                run_id,
                event,
            } => append_event(&transaction, &activity_id, &run_id, &event)?,
            StoreCommand::ImportLegacy { activity, ack } => {
                let result = isolated_mutation(&transaction, |transaction| {
                    import_legacy(transaction, activity)
                })?;
                deferred.push(DeferredAck::Bool(ack, result));
            }
            StoreCommand::LoadAll { ack } => {
                deferred.push(DeferredAck::Activities(ack, load_all(&transaction)))
            }
            StoreCommand::LoadLegacySources { ack } => {
                deferred.push(DeferredAck::Strings(ack, load_legacy_sources(&transaction)))
            }
            StoreCommand::Restore {
                activity_id,
                run_id,
                ack,
            } => deferred.push(DeferredAck::Restore(
                ack,
                restore(&transaction, &activity_id, &run_id),
            )),
            StoreCommand::SaveCheckpoint { checkpoint, ack } => {
                let result = isolated_mutation(&transaction, |transaction| {
                    save_checkpoint(transaction, &checkpoint)
                })?;
                deferred.push(DeferredAck::Checkpoint(ack, result));
            }
            StoreCommand::Delete { activity_id, ack } => {
                let result = isolated_mutation(&transaction, |transaction| {
                    transaction
                        .execute(
                            "DELETE FROM activity_records WHERE activity_id = ?1",
                            params![activity_id],
                        )
                        .map(|_| ())
                        .map_err(|error| format!("Could not delete Activity: {error}"))
                })?;
                deferred.push(DeferredAck::Unit(ack, result));
            }
            StoreCommand::Flush(ack) => deferred.push(DeferredAck::Unit(ack, Ok(()))),
        }
    }

    let commit = transaction
        .commit()
        .map_err(|error| format!("Could not commit Activity store transaction: {error}"));
    match commit {
        Ok(()) => {
            for ack in deferred {
                ack.send();
            }
            Ok(())
        }
        Err(error) => {
            for ack in deferred {
                ack.send_error(error.clone());
            }
            Err(error)
        }
    }
}

/// Isolate an acknowledged mutation from the other commands in its batch.
/// Expected validation or statement errors roll back only this command. A
/// savepoint-management error aborts the outer transaction through `Err`.
fn isolated_mutation<T>(
    transaction: &Transaction<'_>,
    operation: impl FnOnce(&Transaction<'_>) -> Result<T, String>,
) -> Result<Result<T, String>, String> {
    transaction
        .execute_batch("SAVEPOINT activity_store_command")
        .map_err(|error| format!("Could not start Activity store command: {error}"))?;
    match operation(transaction) {
        Ok(value) => {
            transaction
                .execute_batch("RELEASE activity_store_command")
                .map_err(|error| format!("Could not commit Activity store command: {error}"))?;
            Ok(Ok(value))
        }
        Err(operation_error) => {
            transaction
                .execute_batch("ROLLBACK TO activity_store_command; RELEASE activity_store_command")
                .map_err(|rollback_error| {
                    format!(
                        "{operation_error}; could not roll back Activity store command: \
                         {rollback_error}"
                    )
                })?;
            Ok(Err(operation_error))
        }
    }
}

enum DeferredAck {
    Unit(mpsc::Sender<Result<(), String>>, Result<(), String>),
    Bool(mpsc::Sender<Result<bool, String>>, Result<bool, String>),
    Activities(
        mpsc::Sender<Result<Vec<LoadedActivity>, String>>,
        Result<Vec<LoadedActivity>, String>,
    ),
    Strings(
        mpsc::Sender<Result<Vec<String>, String>>,
        Result<Vec<String>, String>,
    ),
    Restore(
        mpsc::Sender<Result<TerminalRestoreState, String>>,
        Result<TerminalRestoreState, String>,
    ),
    Checkpoint(
        mpsc::Sender<Result<SavedTerminalCheckpoint, String>>,
        Result<SavedTerminalCheckpoint, String>,
    ),
}

impl DeferredAck {
    fn send(self) {
        match self {
            Self::Unit(sender, result) => {
                let _ = sender.send(result);
            }
            Self::Bool(sender, result) => {
                let _ = sender.send(result);
            }
            Self::Activities(sender, result) => {
                let _ = sender.send(result);
            }
            Self::Strings(sender, result) => {
                let _ = sender.send(result);
            }
            Self::Restore(sender, result) => {
                let _ = sender.send(result);
            }
            Self::Checkpoint(sender, result) => {
                let _ = sender.send(result);
            }
        }
    }

    fn send_error(self, error: String) {
        match self {
            Self::Unit(sender, _) => {
                let _ = sender.send(Err(error));
            }
            Self::Bool(sender, _) => {
                let _ = sender.send(Err(error));
            }
            Self::Activities(sender, _) => {
                let _ = sender.send(Err(error));
            }
            Self::Strings(sender, _) => {
                let _ = sender.send(Err(error));
            }
            Self::Restore(sender, _) => {
                let _ = sender.send(Err(error));
            }
            Self::Checkpoint(sender, _) => {
                let _ = sender.send(Err(error));
            }
        }
    }
}

fn begin_run(
    transaction: &Transaction<'_>,
    record: &ActivityRecord,
    byte_cap: usize,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let run_id = record_run_id(record)?;
    let record_json = serde_json::to_vec(record)
        .map_err(|error| format!("Could not serialize Activity record: {error}"))?;
    transaction
        .execute(
            "INSERT INTO activity_records (
                activity_id, record_json, byte_cap, run_id, next_sequence,
                truncated_through, tail_bytes, cols, rows
            ) VALUES (?1, ?2, ?3, ?4, 1, 0, 0, ?5, ?6)
            ON CONFLICT(activity_id) DO UPDATE SET
                record_json = excluded.record_json,
                byte_cap = excluded.byte_cap,
                run_id = excluded.run_id,
                next_sequence = 1,
                truncated_through = 0,
                tail_bytes = 0,
                cols = excluded.cols,
                rows = excluded.rows,
                checkpoint_revision = 0,
                checkpoint_through = 0,
                checkpoint_cols = NULL,
                checkpoint_rows = NULL,
                checkpoint_format = NULL,
                checkpoint_engine = NULL,
                checkpoint_unicode = NULL,
                checkpoint_data = NULL,
                checkpoint_search_text = ''",
            params![
                record.id,
                record_json,
                to_i64(byte_cap as u64),
                run_id,
                i64::from(cols.max(1)),
                i64::from(rows.max(1)),
            ],
        )
        .map_err(|error| format!("Could not begin terminal run: {error}"))?;
    transaction
        .execute(
            "DELETE FROM terminal_events WHERE activity_id = ?1",
            params![record.id],
        )
        .map_err(|error| format!("Could not reset terminal events: {error}"))?;
    Ok(())
}

fn save_record(
    transaction: &Transaction<'_>,
    record: &ActivityRecord,
    byte_cap: usize,
) -> Result<(), String> {
    let record_json = serde_json::to_vec(record)
        .map_err(|error| format!("Could not serialize Activity record: {error}"))?;
    let run_id = record
        .session
        .as_ref()
        .map(|session| session.run_id.as_str())
        .unwrap_or("");
    transaction
        .execute(
            "INSERT INTO activity_records (
                activity_id, record_json, byte_cap, run_id, next_sequence,
                truncated_through, tail_bytes, cols, rows
            ) VALUES (?1, ?2, ?3, ?4, 1, 0, 0, 80, 24)
            ON CONFLICT(activity_id) DO UPDATE SET
                record_json = excluded.record_json,
                byte_cap = excluded.byte_cap",
            params![record.id, record_json, to_i64(byte_cap as u64), run_id],
        )
        .map_err(|error| format!("Could not save Activity record: {error}"))?;
    Ok(())
}

fn append_event(
    transaction: &Transaction<'_>,
    activity_id: &str,
    run_id: &str,
    event: &TerminalEvent,
) -> Result<(), String> {
    let sequence = event.sequence();
    let changed = match event {
        TerminalEvent::Output { bytes, .. } => transaction.execute(
            "INSERT OR IGNORE INTO terminal_events (
                activity_id, run_id, sequence, kind, data
            ) SELECT ?1, ?2, ?3, 0, ?4
              WHERE EXISTS (
                SELECT 1 FROM activity_records
                 WHERE activity_id = ?1 AND run_id = ?2
              )",
            params![activity_id, run_id, to_i64(sequence), bytes],
        ),
        TerminalEvent::Resize { cols, rows, .. } => transaction.execute(
            "INSERT OR IGNORE INTO terminal_events (
                activity_id, run_id, sequence, kind, cols, rows
            ) SELECT ?1, ?2, ?3, 1, ?4, ?5
              WHERE EXISTS (
                SELECT 1 FROM activity_records
                 WHERE activity_id = ?1 AND run_id = ?2
              )",
            params![
                activity_id,
                run_id,
                to_i64(sequence),
                i64::from(*cols),
                i64::from(*rows),
            ],
        ),
    }
    .map_err(|error| format!("Could not append terminal event: {error}"))?;
    if changed == 0 {
        return Ok(());
    }
    match event {
        TerminalEvent::Output { bytes, .. } => transaction.execute(
            "UPDATE activity_records
                    SET next_sequence = MAX(next_sequence, ?3 + 1),
                        tail_bytes = tail_bytes + ?4
                  WHERE activity_id = ?1 AND run_id = ?2",
            params![
                activity_id,
                run_id,
                to_i64(sequence),
                to_i64(bytes.len() as u64),
            ],
        ),
        TerminalEvent::Resize { cols, rows, .. } => transaction.execute(
            "UPDATE activity_records
                    SET next_sequence = MAX(next_sequence, ?3 + 1), cols = ?4, rows = ?5
                  WHERE activity_id = ?1 AND run_id = ?2",
            params![
                activity_id,
                run_id,
                to_i64(sequence),
                i64::from(*cols),
                i64::from(*rows),
            ],
        ),
    }
    .map_err(|error| format!("Could not advance terminal event watermark: {error}"))?;
    prune_tail(transaction, activity_id, run_id)
}

fn prune_tail(
    transaction: &Transaction<'_>,
    activity_id: &str,
    run_id: &str,
) -> Result<(), String> {
    let (byte_cap, total_bytes): (i64, i64) = transaction
        .query_row(
            "SELECT byte_cap, tail_bytes
               FROM activity_records
              WHERE activity_id = ?1 AND run_id = ?2",
            params![activity_id, run_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| format!("Could not measure terminal journal: {error}"))?
        .unwrap_or((0, 0));
    if total_bytes <= byte_cap.max(0) {
        return Ok(());
    }

    let overflow = total_bytes.saturating_sub(byte_cap.max(0));
    let cutoff: Option<i64> = transaction
        .query_row(
            "SELECT sequence FROM (
                SELECT sequence,
                       SUM(CASE WHEN kind = 0 THEN length(data) ELSE 0 END)
                           OVER (ORDER BY sequence) AS consumed
                  FROM terminal_events
                 WHERE activity_id = ?1 AND run_id = ?2
            ) WHERE consumed <= ?3
              ORDER BY sequence DESC LIMIT 1",
            params![activity_id, run_id, overflow],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Could not find terminal journal cutoff: {error}"))?;
    let Some(cutoff) = cutoff else {
        return Ok(());
    };
    let deleted_bytes: i64 = transaction
        .query_row(
            "SELECT COALESCE(SUM(length(data)), 0)
               FROM terminal_events
              WHERE activity_id = ?1 AND run_id = ?2
                AND sequence <= ?3 AND kind = 0",
            params![activity_id, run_id, cutoff],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not measure pruned terminal bytes: {error}"))?;
    transaction
        .execute(
            "DELETE FROM terminal_events
              WHERE activity_id = ?1 AND run_id = ?2 AND sequence <= ?3",
            params![activity_id, run_id, cutoff],
        )
        .and_then(|_| {
            transaction.execute(
                "UPDATE activity_records
                    SET truncated_through = MAX(truncated_through, ?3),
                        tail_bytes = MAX(0, tail_bytes - ?4)
                  WHERE activity_id = ?1 AND run_id = ?2",
                params![activity_id, run_id, cutoff, deleted_bytes],
            )
        })
        .map_err(|error| format!("Could not prune terminal journal: {error}"))?;
    Ok(())
}

fn import_legacy(transaction: &Transaction<'_>, activity: LegacyActivity) -> Result<bool, String> {
    let exists = transaction
        .query_row(
            "SELECT 1 FROM activity_records WHERE activity_id = ?1",
            params![activity.record.id],
            |_| Ok(()),
        )
        .optional()
        .map_err(|error| format!("Could not inspect Activity migration state: {error}"))?
        .is_some();
    if exists {
        transaction
            .execute(
                "INSERT OR REPLACE INTO legacy_activity_imports (source_name, activity_id)
                 VALUES (?1, ?2)",
                params![activity.source_name, activity.record.id],
            )
            .map_err(|error| format!("Could not mark legacy Activity import: {error}"))?;
        return Ok(false);
    }
    let run_id = activity
        .record
        .session
        .as_ref()
        .map(|session| session.run_id.clone())
        .unwrap_or_else(|| "legacy".into());
    let record_json = serde_json::to_vec(&activity.record)
        .map_err(|error| format!("Could not serialize legacy Activity: {error}"))?;
    let first_sequence = activity
        .chunks
        .first()
        .map(|chunk| chunk.sequence)
        .unwrap_or(1);
    let truncated_through = activity
        .truncated
        .then(|| first_sequence.saturating_sub(1))
        .unwrap_or(0);
    transaction
        .execute(
            "INSERT INTO activity_records (
                activity_id, record_json, byte_cap, run_id, next_sequence,
                truncated_through, tail_bytes, cols, rows
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 80, 24)",
            params![
                activity.record.id,
                record_json,
                to_i64(activity.byte_cap as u64),
                run_id,
                to_i64(activity.next_sequence.max(1)),
                to_i64(truncated_through),
                to_i64(
                    activity
                        .chunks
                        .iter()
                        .map(|chunk| chunk.bytes.len() as u64)
                        .sum(),
                ),
            ],
        )
        .map_err(|error| format!("Could not import legacy Activity: {error}"))?;
    for chunk in activity.chunks {
        transaction
            .execute(
                "INSERT INTO terminal_events (
                    activity_id, run_id, sequence, kind, data
                ) VALUES (?1, ?2, ?3, 0, ?4)",
                params![
                    activity.record.id,
                    run_id,
                    to_i64(chunk.sequence),
                    chunk.bytes,
                ],
            )
            .map_err(|error| format!("Could not import legacy terminal bytes: {error}"))?;
    }
    transaction
        .execute(
            "INSERT INTO legacy_activity_imports (source_name, activity_id) VALUES (?1, ?2)",
            params![activity.source_name, activity.record.id],
        )
        .map_err(|error| format!("Could not mark legacy Activity import: {error}"))?;
    Ok(true)
}

fn load_legacy_sources(transaction: &Transaction<'_>) -> Result<Vec<String>, String> {
    let mut statement = transaction
        .prepare("SELECT source_name FROM legacy_activity_imports ORDER BY source_name")
        .map_err(|error| format!("Could not prepare Activity migration markers: {error}"))?;
    let rows = statement
        .query_map([], |row| row.get(0))
        .map_err(|error| format!("Could not query Activity migration markers: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not read Activity migration markers: {error}"))
}

fn load_all(transaction: &Transaction<'_>) -> Result<Vec<LoadedActivity>, String> {
    let mut statement = transaction
        .prepare(
            "SELECT activity_id, record_json, byte_cap, run_id, next_sequence,
                    truncated_through, checkpoint_through,
                    checkpoint_search_text, cols, rows
               FROM activity_records",
        )
        .map_err(|error| format!("Could not prepare Activity load: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Vec<u8>>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, i64>(8)?,
                row.get::<_, i64>(9)?,
            ))
        })
        .map_err(|error| format!("Could not query Activities: {error}"))?;
    let mut activities = Vec::new();
    for row in rows {
        let (
            activity_id,
            record_json,
            byte_cap,
            run_id,
            next_sequence,
            truncated_through,
            checkpoint_through,
            checkpoint_search_text,
            cols,
            rows,
        ) = row.map_err(|error| format!("Could not read Activity row: {error}"))?;
        let record = serde_json::from_slice(&record_json)
            .map_err(|error| format!("Could not decode Activity {activity_id}: {error}"))?;
        let events = load_events(
            transaction,
            &activity_id,
            &run_id,
            checkpoint_through as u64,
        )?;
        let chunks = events
            .into_iter()
            .filter_map(|event| match event {
                TerminalEvent::Output { sequence, bytes } => Some(OutputChunk { sequence, bytes }),
                TerminalEvent::Resize { .. } => None,
            })
            .collect();
        activities.push(LoadedActivity {
            record,
            byte_cap: to_usize(byte_cap),
            chunks,
            next_sequence: to_u64(next_sequence).max(1),
            truncated: truncated_through > checkpoint_through,
            checkpoint_through_sequence: to_u64(checkpoint_through),
            checkpoint_search_text,
            cols: to_u16(cols),
            rows: to_u16(rows),
        });
    }
    Ok(activities)
}

fn restore(
    transaction: &Transaction<'_>,
    activity_id: &str,
    run_id: &str,
) -> Result<TerminalRestoreState, String> {
    type RestoreRow = (
        String,
        u64,
        u64,
        u16,
        u16,
        Option<u16>,
        Option<u16>,
        Option<u32>,
        Option<String>,
        Option<String>,
        Option<String>,
        u64,
    );
    let row: RestoreRow = transaction
        .query_row(
            "SELECT run_id, checkpoint_revision, checkpoint_through, cols, rows,
                    checkpoint_cols, checkpoint_rows, checkpoint_format,
                    checkpoint_engine, checkpoint_unicode, checkpoint_data,
                    truncated_through
               FROM activity_records WHERE activity_id = ?1",
            params![activity_id],
            |row| {
                Ok((
                    row.get(0)?,
                    to_u64(row.get(1)?),
                    to_u64(row.get(2)?),
                    to_u16(row.get(3)?),
                    to_u16(row.get(4)?),
                    row.get::<_, Option<i64>>(5)?.map(to_u16),
                    row.get::<_, Option<i64>>(6)?.map(to_u16),
                    row.get::<_, Option<i64>>(7)?.map(|value| value as u32),
                    row.get(8)?,
                    row.get(9)?,
                    row.get(10)?,
                    to_u64(row.get(11)?),
                ))
            },
        )
        .optional()
        .map_err(|error| format!("Could not load terminal checkpoint: {error}"))?
        .ok_or_else(|| format!("Activity {activity_id} has no terminal journal"))?;
    if row.0 != run_id {
        return Err(format!("Activity {activity_id} terminal run changed"));
    }
    let checkpoint_usable = row.10.is_some() && row.11 <= row.2;
    let base_sequence = if checkpoint_usable { row.2 } else { row.11 };
    let checkpoint = if checkpoint_usable {
        Some(TerminalCheckpoint {
            revision: row.1,
            through_sequence: row.2,
            cols: row.5.unwrap_or(row.3),
            rows: row.6.unwrap_or(row.4),
            format_version: row.7.unwrap_or(0),
            engine_version: row.8.unwrap_or_default(),
            unicode_version: row.9.unwrap_or_default(),
            data: row.10.unwrap_or_default(),
        })
    } else {
        None
    };
    let events = load_events(transaction, activity_id, run_id, base_sequence)?;
    let first_sequence = events.first().map(TerminalEvent::sequence);
    let last_sequence = events
        .last()
        .map(TerminalEvent::sequence)
        .unwrap_or(base_sequence);
    Ok(TerminalRestoreState {
        checkpoint,
        revision: row.1,
        base_sequence,
        first_sequence,
        last_sequence,
        truncated: row.11 > row.2 || first_sequence.is_some_and(|first| first > base_sequence + 1),
        cols: row.3,
        rows: row.4,
        events,
    })
}

fn load_events(
    transaction: &Transaction<'_>,
    activity_id: &str,
    run_id: &str,
    after_sequence: u64,
) -> Result<Vec<TerminalEvent>, String> {
    let mut statement = transaction
        .prepare(
            "SELECT sequence, kind, data, cols, rows
               FROM terminal_events
              WHERE activity_id = ?1 AND run_id = ?2 AND sequence > ?3
              ORDER BY sequence",
        )
        .map_err(|error| format!("Could not prepare terminal replay: {error}"))?;
    let rows = statement
        .query_map(
            params![activity_id, run_id, to_i64(after_sequence)],
            |row| {
                let sequence = to_u64(row.get(0)?);
                let kind: i64 = row.get(1)?;
                if kind == 0 {
                    Ok(TerminalEvent::Output {
                        sequence,
                        bytes: row.get::<_, Option<Vec<u8>>>(2)?.unwrap_or_default(),
                    })
                } else {
                    Ok(TerminalEvent::Resize {
                        sequence,
                        cols: to_u16(row.get(3)?),
                        rows: to_u16(row.get(4)?),
                    })
                }
            },
        )
        .map_err(|error| format!("Could not query terminal replay: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not read terminal replay: {error}"))
}

fn save_checkpoint(
    transaction: &Transaction<'_>,
    checkpoint: &SaveTerminalCheckpoint,
) -> Result<SavedTerminalCheckpoint, String> {
    if checkpoint.format_version != TERMINAL_CHECKPOINT_FORMAT_VERSION {
        return Err(format!(
            "Unsupported terminal checkpoint format {}",
            checkpoint.format_version
        ));
    }
    if checkpoint.data.len() > MAX_CHECKPOINT_BYTES {
        return Err("Terminal checkpoint is too large".into());
    }
    if checkpoint.search_text.len() > MAX_SEARCH_TEXT_BYTES {
        return Err("Terminal search text is too large".into());
    }
    let state: Option<(String, u64, u64, u64)> = transaction
        .query_row(
            "SELECT run_id, checkpoint_revision, checkpoint_through,
                    next_sequence - 1
               FROM activity_records WHERE activity_id = ?1",
            params![checkpoint.activity_id],
            |row| {
                Ok((
                    row.get(0)?,
                    to_u64(row.get(1)?),
                    to_u64(row.get(2)?),
                    to_u64(row.get(3)?),
                ))
            },
        )
        .optional()
        .map_err(|error| format!("Could not validate terminal checkpoint: {error}"))?;
    let Some((run_id, revision, previous_through, durable_through)) = state else {
        return Err(format!("Activity {} was not found", checkpoint.activity_id));
    };
    if run_id != checkpoint.run_id {
        return Err(format!(
            "Activity {} terminal run changed",
            checkpoint.activity_id
        ));
    }
    if revision != checkpoint.base_revision {
        return Err(format!(
            "Terminal checkpoint revision changed from {} to {}",
            checkpoint.base_revision, revision
        ));
    }
    if checkpoint.through_sequence < previous_through
        || checkpoint.through_sequence > durable_through
    {
        return Err(format!(
            "Terminal checkpoint sequence {} is outside {}..={}",
            checkpoint.through_sequence, previous_through, durable_through
        ));
    }
    let revision = revision.saturating_add(1);
    let compacted_bytes: i64 = transaction
        .query_row(
            "SELECT COALESCE(SUM(length(data)), 0)
               FROM terminal_events
              WHERE activity_id = ?1 AND run_id = ?2
                AND sequence <= ?3 AND kind = 0",
            params![
                checkpoint.activity_id,
                checkpoint.run_id,
                to_i64(checkpoint.through_sequence),
            ],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not measure checkpointed terminal bytes: {error}"))?;
    transaction
        .execute(
            "UPDATE activity_records SET
                checkpoint_revision = ?3,
                checkpoint_through = ?4,
                checkpoint_cols = ?5,
                checkpoint_rows = ?6,
                checkpoint_format = ?7,
                checkpoint_engine = ?8,
                checkpoint_unicode = ?9,
                checkpoint_data = ?10,
                checkpoint_search_text = ?11
              WHERE activity_id = ?1 AND run_id = ?2",
            params![
                checkpoint.activity_id,
                checkpoint.run_id,
                to_i64(revision),
                to_i64(checkpoint.through_sequence),
                i64::from(checkpoint.cols.max(1)),
                i64::from(checkpoint.rows.max(1)),
                i64::from(checkpoint.format_version),
                checkpoint.engine_version,
                checkpoint.unicode_version,
                checkpoint.data,
                checkpoint.search_text,
            ],
        )
        .and_then(|_| {
            transaction.execute(
                "DELETE FROM terminal_events
                  WHERE activity_id = ?1 AND run_id = ?2 AND sequence <= ?3",
                params![
                    checkpoint.activity_id,
                    checkpoint.run_id,
                    to_i64(checkpoint.through_sequence),
                ],
            )
        })
        .and_then(|_| {
            transaction.execute(
                "UPDATE activity_records
                    SET tail_bytes = MAX(0, tail_bytes - ?3)
                  WHERE activity_id = ?1 AND run_id = ?2",
                params![checkpoint.activity_id, checkpoint.run_id, compacted_bytes,],
            )
        })
        .map_err(|error| format!("Could not save terminal checkpoint: {error}"))?;
    Ok(SavedTerminalCheckpoint {
        revision,
        through_sequence: checkpoint.through_sequence,
    })
}

fn record_run_id(record: &ActivityRecord) -> Result<&str, String> {
    record
        .session
        .as_ref()
        .map(|session| session.run_id.as_str())
        .filter(|run_id| !run_id.is_empty())
        .ok_or_else(|| format!("Activity {} has no terminal run id", record.id))
}

fn to_i64(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

fn to_u64(value: i64) -> u64 {
    u64::try_from(value).unwrap_or(0)
}

fn to_usize(value: i64) -> usize {
    usize::try_from(value).unwrap_or(0)
}

fn to_u16(value: i64) -> u16 {
    u16::try_from(value).unwrap_or(u16::MAX).max(1)
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::activities::{
        ActivityHost, ActivityKind, ActivityOrigin, ActivityRetention, ActivityStatus,
    };
    use tempfile::tempdir;

    fn record(id: &str, run_id: &str) -> ActivityRecord {
        ActivityRecord {
            id: id.into(),
            kind: ActivityKind::Agent,
            title: id.into(),
            auto_title_eligible: false,
            workspace_path: None,
            status: ActivityStatus::Idle,
            created_at: "2026-08-14T00:00:00Z".into(),
            updated_at: "2026-08-14T00:00:00Z".into(),
            last_viewed_at: None,
            archived_at: None,
            close_requested_at: None,
            retention: ActivityRetention::Durable,
            source: ActivityOrigin::default(),
            host: ActivityHost::pty(None),
            launch: None,
            session: Some(super::super::ActivitySessionRecord {
                run_id: run_id.into(),
                started_at: "2026-08-14T00:00:00Z".into(),
                ended_at: None,
                agent_id: None,
                cli_session_id: None,
                exit: None,
                last_output_sequence: 0,
                scrollback_bytes: 0,
            }),
            error: None,
        }
    }

    #[test]
    fn stores_binary_events_and_compacts_only_through_a_valid_checkpoint() {
        let directory = tempdir().unwrap();
        let store = ActivityStore::start(directory.path()).unwrap();
        store.begin_run(record("one", "run-1"), 1024, 80, 24);
        store.append_event(
            "one".into(),
            "run-1".into(),
            TerminalEvent::Output {
                sequence: 1,
                bytes: vec![0, 255, 27],
            },
        );
        store.append_event(
            "one".into(),
            "run-1".into(),
            TerminalEvent::Resize {
                sequence: 2,
                cols: 120,
                rows: 40,
            },
        );

        let before = store.restore("one", "run-1").unwrap();
        assert_eq!(before.last_sequence, 2);
        assert_eq!(before.events.len(), 2);
        let saved = store
            .save_checkpoint(SaveTerminalCheckpoint {
                activity_id: "one".into(),
                run_id: "run-1".into(),
                base_revision: 0,
                through_sequence: 2,
                cols: 120,
                rows: 40,
                format_version: TERMINAL_CHECKPOINT_FORMAT_VERSION,
                engine_version: "6.0.0".into(),
                unicode_version: "11".into(),
                data: "checkpoint".into(),
                search_text: "visible screen".into(),
            })
            .unwrap();
        assert_eq!(saved.revision, 1);

        let after = store.restore("one", "run-1").unwrap();
        assert_eq!(after.events, Vec::new());
        assert_eq!(after.checkpoint.unwrap().data, "checkpoint");
    }

    #[test]
    fn rejects_stale_checkpoint_revisions_and_sequences_past_the_watermark() {
        let directory = tempdir().unwrap();
        let store = ActivityStore::start(directory.path()).unwrap();
        store.begin_run(record("one", "run-1"), 1024, 80, 24);
        store.append_event(
            "one".into(),
            "run-1".into(),
            TerminalEvent::Output {
                sequence: 1,
                bytes: b"hello".to_vec(),
            },
        );
        let checkpoint = SaveTerminalCheckpoint {
            activity_id: "one".into(),
            run_id: "run-1".into(),
            base_revision: 0,
            through_sequence: 1,
            cols: 80,
            rows: 24,
            format_version: TERMINAL_CHECKPOINT_FORMAT_VERSION,
            engine_version: "6.0.0".into(),
            unicode_version: "11".into(),
            data: "hello".into(),
            search_text: "hello".into(),
        };
        store.save_checkpoint(checkpoint.clone()).unwrap();
        assert!(store.save_checkpoint(checkpoint).is_err());

        store.append_event(
            "one".into(),
            "run-1".into(),
            TerminalEvent::Output {
                sequence: 2,
                bytes: b"world".to_vec(),
            },
        );
        let future = SaveTerminalCheckpoint {
            activity_id: "one".into(),
            run_id: "run-1".into(),
            base_revision: 1,
            through_sequence: 3,
            cols: 80,
            rows: 24,
            format_version: TERMINAL_CHECKPOINT_FORMAT_VERSION,
            engine_version: "6.0.0".into(),
            unicode_version: "11".into(),
            data: "future".into(),
            search_text: "future".into(),
        };
        assert!(store.save_checkpoint(future).is_err());
    }

    #[test]
    fn sustained_small_redraws_keep_the_binary_tail_bounded() {
        let directory = tempdir().unwrap();
        let store = ActivityStore::start(directory.path()).unwrap();
        let byte_cap = 1024;
        let segment_bytes = 187;
        store.begin_run(record("redraw", "run-1"), byte_cap, 80, 24);
        for sequence in 1..=5_000 {
            store.append_event(
                "redraw".into(),
                "run-1".into(),
                TerminalEvent::Output {
                    sequence,
                    bytes: vec![b'x'; segment_bytes],
                },
            );
        }
        store.flush().unwrap();

        let connection = Connection::open(ActivityStore::database_path(directory.path())).unwrap();
        let (tail_bytes, rows): (i64, i64) = connection
            .query_row(
                "SELECT r.tail_bytes, COUNT(e.sequence)
                   FROM activity_records r
                   LEFT JOIN terminal_events e ON e.activity_id = r.activity_id
                  WHERE r.activity_id = 'redraw'
                  GROUP BY r.activity_id",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert!(tail_bytes <= (byte_cap + segment_bytes) as i64);
        assert!(rows <= 7);
    }

    #[test]
    fn failed_checkpoint_rolls_back_its_record_update() {
        let directory = tempdir().unwrap();
        let store = ActivityStore::start(directory.path()).unwrap();
        store.begin_run(record("checkpoint", "run-1"), 1024, 80, 24);
        store.append_event(
            "checkpoint".into(),
            "run-1".into(),
            TerminalEvent::Output {
                sequence: 1,
                bytes: b"before checkpoint".to_vec(),
            },
        );
        store.flush().unwrap();

        let connection = Connection::open(ActivityStore::database_path(directory.path())).unwrap();
        connection
            .execute_batch(
                "CREATE TRIGGER reject_checkpoint_compaction
                 BEFORE DELETE ON terminal_events
                 WHEN OLD.activity_id = 'checkpoint'
                 BEGIN
                    SELECT RAISE(ABORT, 'forced checkpoint failure');
                 END;",
            )
            .unwrap();
        drop(connection);

        let result = store.save_checkpoint(SaveTerminalCheckpoint {
            activity_id: "checkpoint".into(),
            run_id: "run-1".into(),
            base_revision: 0,
            through_sequence: 1,
            cols: 80,
            rows: 24,
            format_version: TERMINAL_CHECKPOINT_FORMAT_VERSION,
            engine_version: "6.0.0".into(),
            unicode_version: "11".into(),
            data: "must roll back".into(),
            search_text: "must roll back".into(),
        });
        assert!(result.is_err());
        store.flush().unwrap();

        let restored = store.restore("checkpoint", "run-1").unwrap();
        assert_eq!(restored.revision, 0);
        assert!(restored.checkpoint.is_none());
        assert_eq!(restored.events.len(), 1);
    }

    #[test]
    fn failed_legacy_import_rolls_back_the_record_and_marker() {
        let directory = tempdir().unwrap();
        let store = ActivityStore::start(directory.path()).unwrap();
        store.flush().unwrap();
        let connection = Connection::open(ActivityStore::database_path(directory.path())).unwrap();
        connection
            .execute_batch(
                "CREATE TRIGGER reject_legacy_event
                 BEFORE INSERT ON terminal_events
                 WHEN NEW.activity_id = 'legacy'
                 BEGIN
                    SELECT RAISE(ABORT, 'forced legacy import failure');
                 END;",
            )
            .unwrap();
        drop(connection);

        let result = store.import_legacy(LegacyActivity {
            source_name: "legacy.activity.json".into(),
            record: record("legacy", "run-1"),
            byte_cap: 1024,
            chunks: vec![OutputChunk {
                sequence: 1,
                bytes: b"legacy output".to_vec(),
            }],
            next_sequence: 2,
            truncated: false,
        });
        assert!(result.is_err());
        store.flush().unwrap();
        assert!(store.load_all().unwrap().is_empty());
        assert!(store.legacy_sources().unwrap().is_empty());
    }

    #[test]
    fn final_drop_joins_the_worker_and_closes_wal_sidecars() {
        let directory = tempdir().unwrap();
        let database_path = ActivityStore::database_path(directory.path());
        {
            let store = ActivityStore::start(directory.path()).unwrap();
            store.begin_run(record("drop", "run-1"), 1024, 80, 24);
            store.flush().unwrap();
            let clone = store.clone();
            drop(store);
            assert!(database_path.exists());
            drop(clone);
        }

        assert!(database_path.exists());
        assert!(!database_path.with_extension("sqlite3-wal").exists());
        assert!(!database_path.with_extension("sqlite3-shm").exists());
    }
}
