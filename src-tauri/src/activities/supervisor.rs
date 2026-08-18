use chrono::{DateTime, Local, Utc};
use portable_pty::{
    native_pty_system, ChildKiller, CommandBuilder, ExitStatus, MasterPty, PtySize,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{self, BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, Ordering},
        mpsc, Arc, Condvar, Mutex, MutexGuard,
    },
    thread,
    time::{Duration, Instant},
};
use thiserror::Error;
use uuid::Uuid;

use crate::persistence::{
    load_json_optional_quarantining, quarantine_corrupt_file, PersistenceError, QuarantinedLoad,
};

use super::{
    model::{
        ActivityHost, ActivityKind, ActivityRecord, ActivityRetention, ActivitySessionRecord,
        ActivityStatus, ActivityTitleSource, SessionExitReason, SessionExitRecord,
    },
    scrollback::{OutputChunk, RawScrollback, ScrollbackReplay},
    status::{AgentStatusChange, AgentStatusTracker, AgentStatusTrackerConfig},
    store::{
        ActivityStore, LegacyActivity, SaveTerminalCheckpoint, SavedTerminalCheckpoint,
        TerminalCheckpoint, TerminalEvent,
    },
};

pub const DEFAULT_TERMINAL_SCROLLBACK_BYTES: usize = 1024 * 1024;
pub const DEFAULT_DURABLE_SCROLLBACK_BYTES: usize = 2 * 1024 * 1024;

const PERSISTED_VERSION: u32 = 1;
const NO_STOP_INTENT: u8 = 0;
const USER_STOP_INTENT: u8 = 1;
const QUIT_INTERRUPT_INTENT: u8 = 2;
const OUTPUT_RECORD_PERSIST_INTERVAL_MS: u64 = 2_000;
/// Coalescing window for PTY output events: bytes read within one frame are
/// published as a single `ActivityEvent::Output`.
const OUTPUT_FLUSH_FRAME: Duration = Duration::from_millis(16);
/// Gather window for the first bytes after a quiet period. A full-screen TUI
/// repaint (erase + redraw, one stdout write) reaches the reader as several
/// PTY reads microseconds apart; publishing the first read alone lets the
/// renderer paint the erased intermediate state, which shows as flicker in
/// the repainted region. Holding the first flush this long keeps the whole
/// repaint in one Output event. Echo latency grows by at most this much.
const OUTPUT_FLUSH_GATHER: Duration = Duration::from_millis(2);
/// Pending-output cap that forces an immediate flush mid-frame and blocks the
/// PTY reader until drained, preserving real backpressure toward the child.
const OUTPUT_FLUSH_BUFFER_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone)]
pub struct ActivitySupervisorConfig {
    pub persistence_dir: PathBuf,
    pub codex_sessions_dir: Option<PathBuf>,
    pub terminal_scrollback_bytes: usize,
    pub durable_scrollback_bytes: usize,
    pub read_chunk_bytes: usize,
    pub agent_status: AgentStatusTrackerConfig,
}

impl ActivitySupervisorConfig {
    pub fn new(persistence_dir: impl Into<PathBuf>) -> Self {
        Self {
            persistence_dir: persistence_dir.into(),
            ..Self::default()
        }
    }
}

impl Default for ActivitySupervisorConfig {
    fn default() -> Self {
        let persistence_dir = dirs::home_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join(".mimir")
            .join("activities");
        Self {
            persistence_dir,
            codex_sessions_dir: dirs::home_dir().map(|home| home.join(".codex").join("sessions")),
            terminal_scrollback_bytes: DEFAULT_TERMINAL_SCROLLBACK_BYTES,
            durable_scrollback_bytes: DEFAULT_DURABLE_SCROLLBACK_BYTES,
            read_chunk_bytes: 16 * 1024,
            agent_status: AgentStatusTrackerConfig::default(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct SpawnActivityRequest {
    pub record: ActivityRecord,
    pub cols: u16,
    pub rows: u16,
    /// Exact provider-owned session id. Codex supplies this asynchronously
    /// through its notify callback; other supported CLIs accept it at launch.
    pub cli_session_id: Option<String>,
    /// Per-launch override for specialist terminal surfaces.
    pub scrollback_byte_cap: Option<usize>,
}

impl SpawnActivityRequest {
    pub fn new(record: ActivityRecord, cols: u16, rows: u16) -> Self {
        Self {
            record,
            cols,
            rows,
            cli_session_id: None,
            scrollback_byte_cap: None,
        }
    }

    pub fn with_cli_session_id(mut self, cli_session_id: Option<String>) -> Self {
        self.cli_session_id = cli_session_id;
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivitySnapshot {
    pub record: ActivityRecord,
    pub scrollback: ScrollbackReplay,
    pub live: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_id: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityHistorySearchHit {
    pub activity_id: String,
    pub snippet: String,
}

pub type ActivitySubscriptionId = u64;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityAttachment {
    pub subscription_id: ActivitySubscriptionId,
    pub snapshot: ActivitySnapshot,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityTerminalAttachment {
    pub record: ActivityRecord,
    pub live: bool,
    pub run_id: String,
    pub owner_id: String,
    pub lease_generation: u64,
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
pub struct ActivityTerminalCheckpointRequest {
    pub activity_id: String,
    pub run_id: String,
    pub owner_id: String,
    pub lease_generation: u64,
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
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ActivityEvent {
    Upsert {
        record: ActivityRecord,
    },
    Output {
        activity_id: String,
        sequence: u64,
        bytes: Vec<u8>,
    },
    Resize {
        activity_id: String,
        sequence: u64,
        cols: u16,
        rows: u16,
    },
    Status {
        activity_id: String,
        status: ActivityStatus,
        needs_input_is_blocking: bool,
    },
    Exit {
        activity_id: String,
        exit: SessionExitRecord,
        record: ActivityRecord,
    },
}

/// Renderer, Tauri, tests, and future remote clients can all consume the same
/// event stream without making this module depend on a particular runtime.
pub trait ActivityEventSink: Send + Sync + 'static {
    fn publish(&self, event: &ActivityEvent);
}

impl ActivityEventSink for mpsc::Sender<ActivityEvent> {
    fn publish(&self, event: &ActivityEvent) {
        let _ = self.send(event.clone());
    }
}

#[derive(Debug, Error)]
pub enum SupervisorError {
    #[error("activity id cannot be empty")]
    EmptyActivityId,
    #[error("activity {0} already exists")]
    AlreadyExists(String),
    #[error("activity {0} was not found")]
    NotFound(String),
    #[error("activity {0} does not use a PTY host")]
    NotPty(String),
    #[error("activity {0} has no launch specification")]
    MissingLaunch(String),
    #[error("activity {0} is not running")]
    NotRunning(String),
    #[error("activity title cannot be empty")]
    EmptyTitle,
    #[error("activity {0} is ephemeral and cannot be archived")]
    NotDurable(String),
    #[error("activity {activity_id} must be ended before it can be {operation}")]
    NotEnded {
        activity_id: String,
        operation: &'static str,
    },
    #[error("could not open PTY for {activity_id}: {message}")]
    OpenPty {
        activity_id: String,
        message: String,
    },
    #[error("could not spawn {command} for {activity_id}: {message}")]
    Spawn {
        activity_id: String,
        command: String,
        message: String,
    },
    #[error("activity {activity_id} command channel closed")]
    CommandChannelClosed { activity_id: String },
    #[error("activity {activity_id} command failed: {message}")]
    Command {
        activity_id: String,
        message: String,
    },
    #[error("persistence failed: {0}")]
    Persistence(#[from] PersistenceError),
    #[error("persistence worker failed: {0}")]
    PersistenceWorker(String),
}

#[derive(Clone)]
pub struct ActivitySupervisor {
    inner: Arc<SupervisorInner>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ActivityShutdownReport {
    pub interrupted: usize,
    pub remaining: usize,
}

struct SupervisorInner {
    config: ActivitySupervisorConfig,
    activities: Mutex<HashMap<String, Arc<ManagedActivity>>>,
    spawning_ids: Mutex<HashSet<String>>,
    dispatch: Mutex<DispatchState>,
    store: ActivityStore,
    quarantined_files: Mutex<Vec<PathBuf>>,
}

/// Prevents concurrent launches from racing past the duplicate-id check.
/// Failure paths release automatically before returning to the caller.
struct SpawnReservation {
    inner: Arc<SupervisorInner>,
    activity_id: String,
    active: bool,
}

impl SpawnReservation {
    fn release(&mut self) {
        if self.active {
            lock(&self.inner.spawning_ids).remove(&self.activity_id);
            self.active = false;
        }
    }
}

impl Drop for SpawnReservation {
    fn drop(&mut self) {
        self.release();
    }
}

struct ManagedActivity {
    record: Mutex<ActivityRecord>,
    scrollback: Mutex<RawScrollback>,
    command_tx: Mutex<Option<mpsc::Sender<SessionCommand>>>,
    killer: Mutex<Option<Box<dyn ChildKiller + Send + Sync>>>,
    stop_intent: AtomicU8,
    process_id: AtomicU32,
    last_output_persist_ms: AtomicU64,
    /// A resumed session keeps the previous conversation stamp through CLI
    /// startup. The first submitted user turn releases this hold.
    preserve_updated_at_until_turn: AtomicBool,
    next_event_sequence: AtomicU64,
    terminal_order: Mutex<()>,
    terminal_size: Mutex<(u16, u16)>,
    checkpoint_lease: Mutex<Option<CheckpointLease>>,
    next_lease_generation: AtomicU64,
    terminal_search: Mutex<TerminalSearchState>,
    tracker: Mutex<Option<AgentStatusTracker>>,
    runtime_started: Instant,
    /// Live only while a session runs; completion takes and joins it so all
    /// buffered output is published before the exit event.
    output_flush: Mutex<Option<OutputFlushHandle>>,
}

#[derive(Debug, Clone)]
struct CheckpointLease {
    owner_id: String,
    run_id: String,
    generation: u64,
    minimum_sequence: u64,
}

#[derive(Debug, Clone, Default)]
struct TerminalSearchState {
    checkpoint_through_sequence: u64,
    checkpoint_text: String,
}

/// Accumulates PTY reads between frame flushes. The reader thread appends and
/// blocks above `OUTPUT_FLUSH_BUFFER_BYTES` so the PTY keeps exerting real
/// backpressure on the child; the flush worker drains it at most once per
/// `OUTPUT_FLUSH_FRAME` into a single coalesced Output event.
struct OutputCoalescer {
    state: Mutex<CoalescerState>,
    wakeup: Condvar,
}

#[derive(Default)]
struct CoalescerState {
    pending: Vec<u8>,
    closed: bool,
}

impl OutputCoalescer {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(CoalescerState::default()),
            wakeup: Condvar::new(),
        })
    }

    /// Reader side: append bytes and wake the flush worker. Blocks while the
    /// buffer is over the cap; the worker flushes immediately and notifies.
    fn push(&self, bytes: &[u8]) {
        let mut state = lock(&self.state);
        state.pending.extend_from_slice(bytes);
        self.wakeup.notify_all();
        let _state = self
            .wakeup
            .wait_while(state, |state| {
                state.pending.len() >= OUTPUT_FLUSH_BUFFER_BYTES && !state.closed
            })
            .unwrap_or_else(|poisoned| poisoned.into_inner());
    }

    fn close(&self) {
        lock(&self.state).closed = true;
        self.wakeup.notify_all();
    }
}

struct OutputFlushHandle {
    coalescer: Arc<OutputCoalescer>,
    worker: thread::JoinHandle<()>,
}

impl OutputFlushHandle {
    /// Close the coalescer and wait for the worker's final flush. Returns only
    /// after every buffered byte has been appended to scrollback and published,
    /// so exit events can never overtake output.
    fn finish(self) {
        self.coalescer.close();
        let _ = self.worker.join();
    }
}

struct DispatchState {
    next_subscription_id: ActivitySubscriptionId,
    sinks: HashMap<ActivitySubscriptionId, Arc<dyn ActivityEventSink>>,
}

enum SessionCommand {
    Write(Vec<u8>, mpsc::Sender<Result<(), String>>),
    Resize(PtySize, mpsc::Sender<Result<(), String>>),
    Close,
}

enum CompletionPart {
    Child(Result<ExitStatus, String>),
    Reader(Result<(), String>),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedActivity {
    version: u32,
    record: ActivityRecord,
    scrollback: PersistedScrollback,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedScrollback {
    chunks: Vec<OutputChunk>,
    next_sequence: u64,
    truncated: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CliSessionBinding {
    activity_id: String,
    run_id: String,
    cli_session_id: String,
}

#[derive(Debug, Deserialize)]
struct CodexSessionMetaEnvelope {
    #[serde(rename = "type")]
    event_type: String,
    payload: CodexSessionMeta,
}

#[derive(Debug, Deserialize)]
struct CodexSessionMeta {
    id: String,
    timestamp: String,
    cwd: String,
}

impl ActivitySupervisor {
    pub fn new(config: ActivitySupervisorConfig) -> Result<Self, SupervisorError> {
        fs::create_dir_all(&config.persistence_dir).map_err(|source| PersistenceError::Io {
            operation: "create activity persistence directory",
            path: config.persistence_dir.clone(),
            source,
        })?;

        let store = ActivityStore::start(&config.persistence_dir)
            .map_err(SupervisorError::PersistenceWorker)?;
        let supervisor = Self {
            inner: Arc::new(SupervisorInner {
                config,
                activities: Mutex::new(HashMap::new()),
                spawning_ids: Mutex::new(HashSet::new()),
                dispatch: Mutex::new(DispatchState {
                    next_subscription_id: 1,
                    sinks: HashMap::new(),
                }),
                store,
                quarantined_files: Mutex::new(Vec::new()),
            }),
        };
        supervisor.hydrate()?;
        Ok(supervisor)
    }

    /// Spawn a PTY with the exact command and argv stored on the activity.
    /// No shell string is constructed or reparsed.
    pub fn spawn(
        &self,
        request: SpawnActivityRequest,
    ) -> Result<ActivitySnapshot, SupervisorError> {
        self.spawn_session(request, false)
    }

    /// Start a new session for an existing, ended PTY activity. The durable
    /// identity — id, creation time, sidebar position — survives; the new
    /// session replaces the previous run's scrollback and exit record.
    pub fn respawn(
        &self,
        request: SpawnActivityRequest,
    ) -> Result<ActivitySnapshot, SupervisorError> {
        self.spawn_session(request, true)
    }

    fn spawn_session(
        &self,
        request: SpawnActivityRequest,
        replace_ended: bool,
    ) -> Result<ActivitySnapshot, SupervisorError> {
        let mut cli_session_id = request.cli_session_id.clone();
        let mut record = request.record;
        record.normalize_legacy_title_source();
        if record.id.trim().is_empty() {
            return Err(SupervisorError::EmptyActivityId);
        }
        if !matches!(record.host, ActivityHost::Pty { .. }) {
            return Err(SupervisorError::NotPty(record.id));
        }
        let launch = record
            .launch
            .clone()
            .ok_or_else(|| SupervisorError::MissingLaunch(record.id.clone()))?;

        let mut reservation = {
            let activities = lock(&self.inner.activities);
            let mut spawning_ids = lock(&self.inner.spawning_ids);
            if replace_ended {
                let existing = activities
                    .get(&record.id)
                    .ok_or_else(|| SupervisorError::NotFound(record.id.clone()))?;
                let existing_record = lock(&existing.record);
                if lock(&existing.command_tx).is_some() || existing_record.status.is_live() {
                    return Err(SupervisorError::NotEnded {
                        activity_id: record.id.clone(),
                        operation: "resumed",
                    });
                }
                record.created_at = existing_record.created_at.clone();
                record.title = existing_record.title.clone();
                record.title_source = existing_record.title_source;
                record.updated_at = existing_record.updated_at.clone();
                record.archived_at = None;
                record.close_requested_at = None;
                if cli_session_id.is_none() {
                    cli_session_id = existing_record
                        .session
                        .as_ref()
                        .and_then(|session| session.cli_session_id.clone());
                }
            } else if activities.contains_key(&record.id) {
                return Err(SupervisorError::AlreadyExists(record.id));
            }
            if !spawning_ids.insert(record.id.clone()) {
                return Err(SupervisorError::AlreadyExists(record.id));
            }
            SpawnReservation {
                inner: self.inner.clone(),
                activity_id: record.id.clone(),
                active: true,
            }
        };

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(pty_size(request.cols, request.rows))
            .map_err(|error| SupervisorError::OpenPty {
                activity_id: record.id.clone(),
                message: error.to_string(),
            })?;

        // Acquire all parent-side resources before a child exists. A setup
        // error can therefore never leave an untracked process behind.
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| SupervisorError::OpenPty {
                activity_id: record.id.clone(),
                message: format!("could not clone PTY reader: {error}"),
            })?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| SupervisorError::OpenPty {
                activity_id: record.id.clone(),
                message: format!("could not take PTY writer: {error}"),
            })?;

        let run_id = Uuid::new_v4().to_string();
        let mut command = CommandBuilder::new(&launch.command);
        command.args(&launch.args);
        if let Some(cwd) = &launch.cwd {
            command.cwd(cwd);
        }
        command.env("TERM", "xterm-256color");
        for (key, value) in &launch.env {
            command.env(key, value);
        }
        command.env("MIMIR_ACTIVITY_ID", &record.id);
        command.env("MIMIR_ACTIVITY_RUN_ID", &run_id);
        command.env(
            "MIMIR_SESSION_BINDINGS_DIR",
            session_bindings_dir(&self.inner.config.persistence_dir),
        );

        let mut child =
            pair.slave
                .spawn_command(command)
                .map_err(|error| SupervisorError::Spawn {
                    activity_id: record.id.clone(),
                    command: launch.command.clone(),
                    message: error.to_string(),
                })?;
        drop(pair.slave);

        let killer = child.clone_killer();
        let process_id = child.process_id();
        let now = timestamp();
        record.status = initial_live_status(record.kind);
        if !replace_ended {
            record.updated_at = now.clone();
        }
        record.error = None;
        record.session = Some(ActivitySessionRecord {
            run_id,
            started_at: now,
            ended_at: None,
            agent_id: if matches!(record.kind, ActivityKind::Agent | ActivityKind::Routine) {
                record.source.launcher_id.clone()
            } else {
                None
            },
            cli_session_id,
            exit: None,
            last_output_sequence: 0,
            scrollback_bytes: 0,
        });

        let byte_cap = request.scrollback_byte_cap.unwrap_or_else(|| {
            if matches!(record.kind, ActivityKind::Agent | ActivityKind::Routine)
                && record.retention == ActivityRetention::Durable
            {
                self.inner.config.durable_scrollback_bytes
            } else {
                self.inner.config.terminal_scrollback_bytes
            }
        });
        let (command_tx, command_rx) = mpsc::channel();
        let tracker = (record.kind == ActivityKind::Agent)
            .then(|| AgentStatusTracker::new(0, self.inner.config.agent_status));
        let activity = Arc::new(ManagedActivity {
            record: Mutex::new(record),
            scrollback: Mutex::new(RawScrollback::new(byte_cap)),
            command_tx: Mutex::new(Some(command_tx)),
            killer: Mutex::new(Some(killer)),
            stop_intent: AtomicU8::new(NO_STOP_INTENT),
            process_id: AtomicU32::new(process_id.unwrap_or(0)),
            last_output_persist_ms: AtomicU64::new(0),
            preserve_updated_at_until_turn: AtomicBool::new(replace_ended),
            next_event_sequence: AtomicU64::new(1),
            terminal_order: Mutex::new(()),
            terminal_size: Mutex::new((request.cols.max(1), request.rows.max(1))),
            checkpoint_lease: Mutex::new(None),
            next_lease_generation: AtomicU64::new(1),
            terminal_search: Mutex::new(TerminalSearchState::default()),
            tracker: Mutex::new(tracker),
            runtime_started: Instant::now(),
            output_flush: Mutex::new(None),
        });

        {
            let mut activities = lock(&self.inner.activities);
            activities.insert(lock(&activity.record).id.clone(), activity.clone());
        }
        self.inner.store.begin_run(
            lock(&activity.record).clone(),
            byte_cap,
            request.cols.max(1),
            request.rows.max(1),
        );
        reservation.release();

        let inner_for_commands = self.inner.clone();
        let activity_for_commands = activity.clone();
        thread::spawn(move || {
            command_loop(
                pair.master,
                writer,
                command_rx,
                inner_for_commands,
                activity_for_commands,
            )
        });

        let coalescer = OutputCoalescer::new();
        let flush_worker = {
            let inner = self.inner.clone();
            let activity = activity.clone();
            let coalescer = coalescer.clone();
            thread::spawn(move || output_flush_loop(inner, activity, coalescer))
        };
        *lock(&activity.output_flush) = Some(OutputFlushHandle {
            coalescer: coalescer.clone(),
            worker: flush_worker,
        });

        let (completion_tx, completion_rx) = mpsc::channel();
        let read_chunk_bytes = self.inner.config.read_chunk_bytes;
        let reader_completion = completion_tx.clone();
        thread::spawn(move || {
            let result = reader_loop(reader, read_chunk_bytes, coalescer);
            let _ = reader_completion.send(CompletionPart::Reader(result));
        });

        thread::spawn(move || {
            let result = child.wait().map_err(|error| error.to_string());
            let _ = completion_tx.send(CompletionPart::Child(result));
        });

        let inner_for_completion = self.inner.clone();
        let activity_for_completion = activity.clone();
        thread::spawn(move || {
            completion_loop(completion_rx, inner_for_completion, activity_for_completion)
        });

        if lock(&activity.tracker).is_some() {
            let inner_for_polling = self.inner.clone();
            let activity_for_polling = activity.clone();
            thread::spawn(move || agent_status_poll_loop(inner_for_polling, activity_for_polling));
        }

        let snapshot = self.snapshot_for(&activity, None);
        self.inner.publish(ActivityEvent::Upsert {
            record: snapshot.record.clone(),
        });
        self.inner.persist_if_durable(&activity);
        Ok(snapshot)
    }

    pub fn list(&self) -> Vec<ActivityRecord> {
        let activities: Vec<_> = lock(&self.inner.activities).values().cloned().collect();
        let mut records: Vec<_> = activities
            .iter()
            .map(|activity| lock(&activity.record).clone())
            .collect();
        records.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        records
    }

    pub fn search_history(&self, query: &str, limit: usize) -> Vec<ActivityHistorySearchHit> {
        let needle = query.trim().to_ascii_lowercase();
        if limit == 0 {
            return Vec::new();
        }

        let activities: Vec<_> = lock(&self.inner.activities).values().cloned().collect();
        let mut hits = activities
            .into_iter()
            .filter_map(|activity| {
                let record = lock(&activity.record).clone();
                record.archived_at.as_ref()?;
                let search = lock(&activity.terminal_search).clone();
                let bytes = lock(&activity.scrollback)
                    .persisted_chunks()
                    .into_iter()
                    .filter(|chunk| chunk.sequence > search.checkpoint_through_sequence)
                    .flat_map(|chunk| chunk.bytes)
                    .collect::<Vec<_>>();
                let tail = terminal_search_text(&bytes);
                let text = if search.checkpoint_text.is_empty() {
                    tail
                } else if tail.is_empty() {
                    search.checkpoint_text
                } else {
                    format!("{}\n{}", search.checkpoint_text, tail)
                };
                let snippet = if needle.is_empty() {
                    recent_snippet(&text)
                } else {
                    let index = text.to_ascii_lowercase().find(&needle)?;
                    search_snippet(&text, index, needle.len())
                };
                Some((
                    record.archived_at.clone().unwrap_or(record.updated_at),
                    ActivityHistorySearchHit {
                        activity_id: record.id,
                        snippet,
                    },
                ))
            })
            .collect::<Vec<_>>();
        hits.sort_by(|left, right| right.0.cmp(&left.0));
        hits.into_iter()
            .take(limit.min(100))
            .map(|(_, hit)| hit)
            .collect()
    }

    pub fn snapshot(
        &self,
        activity_id: &str,
        after_sequence: Option<u64>,
    ) -> Result<ActivitySnapshot, SupervisorError> {
        let activity = self.activity(activity_id)?;
        Ok(self.snapshot_for(&activity, after_sequence))
    }

    pub fn replay(
        &self,
        activity_id: &str,
        after_sequence: Option<u64>,
    ) -> Result<ScrollbackReplay, SupervisorError> {
        let activity = self.activity(activity_id)?;
        let replay = lock(&activity.scrollback).replay_after(after_sequence);
        Ok(replay)
    }

    /// Atomically installs a subscriber and captures replay state. Output
    /// emitted after this call's snapshot is guaranteed to reach the sink.
    pub fn attach(
        &self,
        activity_id: &str,
        after_sequence: Option<u64>,
        sink: Arc<dyn ActivityEventSink>,
    ) -> Result<ActivityAttachment, SupervisorError> {
        let activity = self.activity(activity_id)?;
        let mut dispatch = lock(&self.inner.dispatch);
        let subscription_id = dispatch.next_subscription_id;
        dispatch.next_subscription_id = dispatch.next_subscription_id.saturating_add(1);
        dispatch.sinks.insert(subscription_id, sink);
        let snapshot = self.snapshot_for(&activity, after_sequence);
        Ok(ActivityAttachment {
            subscription_id,
            snapshot,
        })
    }

    pub fn subscribe(&self, sink: Arc<dyn ActivityEventSink>) -> ActivitySubscriptionId {
        let mut dispatch = lock(&self.inner.dispatch);
        let subscription_id = dispatch.next_subscription_id;
        dispatch.next_subscription_id = dispatch.next_subscription_id.saturating_add(1);
        dispatch.sinks.insert(subscription_id, sink);
        subscription_id
    }

    pub fn unsubscribe(&self, subscription_id: ActivitySubscriptionId) -> bool {
        lock(&self.inner.dispatch)
            .sinks
            .remove(&subscription_id)
            .is_some()
    }

    /// Acquire the single renderer checkpoint lease for one terminal run and
    /// return a durable checkpoint plus its ordered event tail. A later attach
    /// replaces this lease, so a stale WebView cannot compact newer output.
    pub fn terminal_attach(
        &self,
        activity_id: &str,
        owner_id: String,
    ) -> Result<ActivityTerminalAttachment, SupervisorError> {
        let activity = self.activity(activity_id)?;
        let record = lock(&activity.record).clone();
        let run_id = record
            .session
            .as_ref()
            .map(|session| session.run_id.clone())
            .ok_or_else(|| SupervisorError::NotRunning(activity_id.to_string()))?;
        let generation = activity
            .next_lease_generation
            .fetch_add(1, Ordering::AcqRel);
        let mut lease = lock(&activity.checkpoint_lease);
        *lease = Some(CheckpointLease {
            owner_id: owner_id.clone(),
            run_id: run_id.clone(),
            generation,
            minimum_sequence: 0,
        });
        let restore = self
            .inner
            .store
            .restore(activity_id, &run_id)
            .map_err(SupervisorError::PersistenceWorker)?;
        if let Some(current) = lease.as_mut() {
            current.minimum_sequence = restore.base_sequence;
        }
        let live = lock(&activity.command_tx).is_some() && record.status.is_live();
        Ok(ActivityTerminalAttachment {
            record,
            live,
            run_id,
            owner_id,
            lease_generation: generation,
            checkpoint: restore.checkpoint,
            revision: restore.revision,
            base_sequence: restore.base_sequence,
            first_sequence: restore.first_sequence,
            last_sequence: restore.last_sequence,
            truncated: restore.truncated,
            cols: restore.cols,
            rows: restore.rows,
            events: restore.events,
        })
    }

    pub fn save_terminal_checkpoint(
        &self,
        request: ActivityTerminalCheckpointRequest,
    ) -> Result<SavedTerminalCheckpoint, SupervisorError> {
        let activity = self.activity(&request.activity_id)?;
        let lease = lock(&activity.checkpoint_lease);
        let valid = lease.as_ref().is_some_and(|lease| {
            lease.owner_id == request.owner_id
                && lease.run_id == request.run_id
                && lease.generation == request.lease_generation
                && request.through_sequence >= lease.minimum_sequence
        });
        if !valid {
            return Err(SupervisorError::PersistenceWorker(
                "Terminal checkpoint lease is stale".into(),
            ));
        }
        // Keep the lease lock through the store commit. A concurrent attach
        // cannot replace the owner between validation and compaction.
        let saved = self
            .inner
            .store
            .save_checkpoint(SaveTerminalCheckpoint {
                activity_id: request.activity_id,
                run_id: request.run_id,
                base_revision: request.base_revision,
                through_sequence: request.through_sequence,
                cols: request.cols,
                rows: request.rows,
                format_version: request.format_version,
                engine_version: request.engine_version,
                unicode_version: request.unicode_version,
                data: request.data,
                search_text: request.search_text.clone(),
            })
            .map_err(SupervisorError::PersistenceWorker)?;
        *lock(&activity.terminal_search) = TerminalSearchState {
            checkpoint_through_sequence: saved.through_sequence,
            checkpoint_text: request.search_text,
        };
        drop(lease);
        Ok(saved)
    }

    pub fn release_terminal_lease(
        &self,
        activity_id: &str,
        owner_id: &str,
        lease_generation: u64,
    ) -> Result<bool, SupervisorError> {
        let activity = self.activity(activity_id)?;
        let mut lease = lock(&activity.checkpoint_lease);
        let matches = lease.as_ref().is_some_and(|lease| {
            lease.owner_id == owner_id && lease.generation == lease_generation
        });
        if matches {
            lease.take();
        }
        Ok(matches)
    }

    pub fn write(
        &self,
        activity_id: &str,
        bytes: impl Into<Vec<u8>>,
    ) -> Result<(), SupervisorError> {
        let activity = self.activity(activity_id)?;
        let bytes = bytes.into();
        let submits_turn = bytes.contains(&b'\r');
        let command_tx = lock(&activity.command_tx)
            .clone()
            .ok_or_else(|| SupervisorError::NotRunning(activity_id.to_string()))?;
        let (ack_tx, ack_rx) = mpsc::channel();
        command_tx
            .send(SessionCommand::Write(bytes, ack_tx))
            .map_err(|_| SupervisorError::CommandChannelClosed {
                activity_id: activity_id.to_string(),
            })?;
        receive_command_ack(activity_id, ack_rx)?;
        if submits_turn {
            self.inner.record_activity_interaction(&activity);
        }
        Ok(())
    }

    pub fn resize(&self, activity_id: &str, cols: u16, rows: u16) -> Result<(), SupervisorError> {
        if cols == 0 || rows == 0 {
            return Ok(());
        }
        let activity = self.activity(activity_id)?;
        let command_tx = lock(&activity.command_tx)
            .clone()
            .ok_or_else(|| SupervisorError::NotRunning(activity_id.to_string()))?;
        let (ack_tx, ack_rx) = mpsc::channel();
        command_tx
            .send(SessionCommand::Resize(pty_size(cols, rows), ack_tx))
            .map_err(|_| SupervisorError::CommandChannelClosed {
                activity_id: activity_id.to_string(),
            })?;
        receive_command_ack(activity_id, ack_rx)
    }

    /// User stop is distinct from application quit. The eventual child outcome
    /// is authoritative, but its reason remains `stopped` even when the OS
    /// reports the kill as a non-zero or signalled exit.
    pub fn stop(&self, activity_id: &str) -> Result<(), SupervisorError> {
        let activity = self.activity(activity_id)?;
        self.kill_with_intent(activity_id, &activity, USER_STOP_INTENT)
    }

    /// Rename an activity without disturbing its process, PTY, or scrollback.
    pub fn rename(
        &self,
        activity_id: &str,
        title: impl Into<String>,
    ) -> Result<ActivityRecord, SupervisorError> {
        let title = title.into().trim().to_string();
        if title.is_empty() {
            return Err(SupervisorError::EmptyTitle);
        }
        let activity = self.activity(activity_id)?;
        let (record, sinks) = {
            let dispatch = lock(&self.inner.dispatch);
            let mut record = lock(&activity.record);
            let scrollback = lock(&activity.scrollback);
            if record.title == title && record.title_source == ActivityTitleSource::Manual {
                return Ok(record.clone());
            }
            record.title = title;
            record.title_source = ActivityTitleSource::Manual;
            record.updated_at = timestamp();
            let snapshot = record.clone();
            if record.retention.should_persist() {
                self.inner
                    .store
                    .save_record(record.clone(), scrollback.byte_cap());
            }
            let sinks = dispatch.sinks.values().cloned().collect::<Vec<_>>();
            (snapshot, sinks)
        };
        publish_to_sinks(
            &sinks,
            &ActivityEvent::Upsert {
                record: record.clone(),
            },
        );
        Ok(record)
    }

    /// Accept a local prompt-derived title only while the launcher placeholder
    /// is still present. Manual titles always remain authoritative.
    pub fn provisional_title(
        &self,
        activity_id: &str,
        title: impl Into<String>,
    ) -> Result<ActivityRecord, SupervisorError> {
        self.apply_provisional_title(activity_id, title)
    }

    fn apply_provisional_title(
        &self,
        activity_id: &str,
        title: impl Into<String>,
    ) -> Result<ActivityRecord, SupervisorError> {
        let title = normalize_provisional_title(&title.into());
        if title.is_empty() {
            return Err(SupervisorError::EmptyTitle);
        }
        let activity = self.activity(activity_id)?;
        let (record, sinks) = {
            let dispatch = lock(&self.inner.dispatch);
            let mut record = lock(&activity.record);
            record.normalize_legacy_title_source();
            if record.kind != ActivityKind::Agent
                || record.title_source != ActivityTitleSource::Launcher
            {
                return Ok(record.clone());
            }
            let scrollback = lock(&activity.scrollback);
            record.title = title;
            record.title_source = ActivityTitleSource::Provisional;
            record.updated_at = timestamp();
            let snapshot = record.clone();
            if record.retention.should_persist() {
                self.inner
                    .store
                    .save_record(record.clone(), scrollback.byte_cap());
            }
            let sinks = dispatch.sinks.values().cloned().collect::<Vec<_>>();
            (snapshot, sinks)
        };
        publish_to_sinks(
            &sinks,
            &ActivityEvent::Upsert {
                record: record.clone(),
            },
        );
        Ok(record)
    }

    /// Archive and restore ended activities. Explicitly archiving an ephemeral
    /// terminal promotes it to durable retention so the user's History intent
    /// survives restart; other ephemeral records remain non-archivable.
    pub fn set_archived(
        &self,
        activity_id: &str,
        archived: bool,
    ) -> Result<ActivityRecord, SupervisorError> {
        let activity = self.activity(activity_id)?;
        let (record, sinks) = {
            let dispatch = lock(&self.inner.dispatch);
            let mut record = lock(&activity.record);
            let scrollback = lock(&activity.scrollback);
            let promotes_terminal = archived
                && record.kind == ActivityKind::Terminal
                && record.retention == ActivityRetention::Ephemeral;
            if record.retention != ActivityRetention::Durable && !promotes_terminal {
                return Err(SupervisorError::NotDurable(activity_id.to_string()));
            }
            if !record.is_clearable() {
                return Err(SupervisorError::NotEnded {
                    activity_id: activity_id.to_string(),
                    operation: "archived",
                });
            }
            if record.is_archived() == archived {
                return Ok(record.clone());
            }
            let now = timestamp();
            if promotes_terminal {
                record.retention = ActivityRetention::Durable;
            }
            record.archived_at = archived.then(|| now.clone());
            record.close_requested_at = None;
            record.updated_at = now;
            let snapshot = record.clone();
            if record.retention.should_persist() {
                self.inner
                    .store
                    .save_record(record.clone(), scrollback.byte_cap());
            }
            let sinks = dispatch.sinks.values().cloned().collect::<Vec<_>>();
            (snapshot, sinks)
        };
        self.inner
            .store
            .flush()
            .map_err(SupervisorError::PersistenceWorker)?;
        publish_to_sinks(
            &sinks,
            &ActivityEvent::Upsert {
                record: record.clone(),
            },
        );
        Ok(record)
    }

    /// Persist the user's close intent before terminating an archivable PTY.
    /// Closing an ephemeral terminal first promotes it to durable retention.
    /// Completion atomically turns that intent into an archive timestamp, and
    /// hydration does the same if the app exits before completion is observed.
    pub fn request_close(&self, activity_id: &str) -> Result<ActivityRecord, SupervisorError> {
        let activity = self.activity(activity_id)?;
        let live = lock(&activity.command_tx).is_some();
        let retains_history = {
            let record = lock(&activity.record);
            record.retention == ActivityRetention::Durable || record.kind == ActivityKind::Terminal
        };
        if !retains_history {
            if live {
                self.kill_with_intent(activity_id, &activity, USER_STOP_INTENT)?;
            }
            return Ok(lock(&activity.record).clone());
        }

        let (record, sinks) = {
            let dispatch = lock(&self.inner.dispatch);
            let mut record = lock(&activity.record);
            let scrollback = lock(&activity.scrollback);
            if record.is_archived() {
                return Ok(record.clone());
            }
            let now = timestamp();
            if record.retention == ActivityRetention::Ephemeral {
                record.retention = ActivityRetention::Durable;
            }
            if live {
                record.close_requested_at = Some(now.clone());
            } else {
                record.archived_at = Some(now.clone());
                record.close_requested_at = None;
            }
            record.updated_at = now;
            let snapshot = record.clone();
            if record.retention.should_persist() {
                self.inner
                    .store
                    .save_record(record.clone(), scrollback.byte_cap());
            }
            let sinks = dispatch.sinks.values().cloned().collect::<Vec<_>>();
            (snapshot, sinks)
        };

        // A successful close acknowledgement means the intent survives a
        // process restart. Do not terminate or hide the row before this fence.
        self.inner
            .store
            .flush()
            .map_err(SupervisorError::PersistenceWorker)?;
        publish_to_sinks(
            &sinks,
            &ActivityEvent::Upsert {
                record: record.clone(),
            },
        );
        if live {
            if let Err(error) = self.kill_with_intent(activity_id, &activity, USER_STOP_INTENT) {
                self.rollback_close_intent(&activity)?;
                return Err(error);
            }
        }
        Ok(record)
    }

    fn rollback_close_intent(
        &self,
        activity: &Arc<ManagedActivity>,
    ) -> Result<(), SupervisorError> {
        let rollback = {
            let dispatch = lock(&self.inner.dispatch);
            let mut record = lock(&activity.record);
            if record.close_requested_at.is_none() {
                None
            } else {
                let scrollback = lock(&activity.scrollback);
                record.close_requested_at = None;
                record.updated_at = timestamp();
                let snapshot = record.clone();
                if record.retention.should_persist() {
                    self.inner
                        .store
                        .save_record(record.clone(), scrollback.byte_cap());
                }
                Some((
                    snapshot,
                    dispatch.sinks.values().cloned().collect::<Vec<_>>(),
                ))
            }
        };
        let Some((record, sinks)) = rollback else {
            return Ok(());
        };
        self.inner
            .store
            .flush()
            .map_err(SupervisorError::PersistenceWorker)?;
        publish_to_sinks(&sinks, &ActivityEvent::Upsert { record });
        Ok(())
    }

    /// Permanently clear an ended activity and its persisted scrollback.
    ///
    /// Completion persists its final snapshot while holding the activity
    /// record lock, so once this method observes an ended record its ordered
    /// delete is guaranteed to follow every session write.
    pub fn clear(&self, activity_id: &str) -> Result<ActivityRecord, SupervisorError> {
        let mut activities = lock(&self.inner.activities);
        if lock(&self.inner.spawning_ids).contains(activity_id) {
            return Err(SupervisorError::NotEnded {
                activity_id: activity_id.to_string(),
                operation: "cleared",
            });
        }
        let activity = activities
            .get(activity_id)
            .cloned()
            .ok_or_else(|| SupervisorError::NotFound(activity_id.to_string()))?;
        let record = lock(&activity.record);
        if lock(&activity.command_tx).is_some() || !record.is_clearable() {
            return Err(SupervisorError::NotEnded {
                activity_id: activity_id.to_string(),
                operation: "cleared",
            });
        }
        let removed = record.clone();
        drop(record);

        let legacy_path =
            activity_persistence_path(&self.inner.config.persistence_dir, activity_id);
        if legacy_path.exists() {
            fs::remove_file(&legacy_path).map_err(|source| PersistenceError::Io {
                operation: "delete legacy Activity persistence file",
                path: legacy_path,
                source,
            })?;
        }
        self.inner
            .store
            .delete(activity_id)
            .map_err(SupervisorError::PersistenceWorker)?;
        activities.remove(activity_id);
        Ok(removed)
    }

    /// Mark and terminate every live process as interrupted. This is the app
    /// quit/restart path; it never masquerades as an intentional user stop.
    pub fn interrupt_all(&self) -> usize {
        let activities: Vec<_> = lock(&self.inner.activities)
            .iter()
            .map(|(id, activity)| (id.clone(), activity.clone()))
            .collect();
        let mut interrupted = 0;
        for (id, activity) in activities {
            if lock(&activity.command_tx).is_some()
                && self
                    .kill_with_intent(&id, &activity, QUIT_INTERRUPT_INTENT)
                    .is_ok()
            {
                interrupted += 1;
            }
        }
        interrupted
    }

    pub fn flush_persistence(&self) -> Result<(), SupervisorError> {
        self.inner
            .store
            .flush()
            .map_err(SupervisorError::PersistenceWorker)
    }

    /// Interrupt live PTYs, give their readers a short bounded window to
    /// persist final scrollback/exit metadata, then flush the ordered writer.
    pub fn shutdown(&self, timeout: Duration) -> Result<ActivityShutdownReport, SupervisorError> {
        let interrupted = self.interrupt_all();
        let deadline = Instant::now() + timeout;
        let remaining = loop {
            let live = lock(&self.inner.activities)
                .values()
                .filter(|activity| lock(&activity.command_tx).is_some())
                .count();
            if live == 0 || Instant::now() >= deadline {
                break live;
            }
            thread::sleep(Duration::from_millis(5));
        };
        self.flush_persistence()?;
        Ok(ActivityShutdownReport {
            interrupted,
            remaining,
        })
    }

    pub fn take_persistence_errors(&self) -> Vec<String> {
        self.inner.store.take_errors()
    }

    pub fn quarantined_files(&self) -> Vec<PathBuf> {
        lock(&self.inner.quarantined_files).clone()
    }

    fn activity(&self, activity_id: &str) -> Result<Arc<ManagedActivity>, SupervisorError> {
        lock(&self.inner.activities)
            .get(activity_id)
            .cloned()
            .ok_or_else(|| SupervisorError::NotFound(activity_id.to_string()))
    }

    fn snapshot_for(
        &self,
        activity: &Arc<ManagedActivity>,
        after_sequence: Option<u64>,
    ) -> ActivitySnapshot {
        let record = lock(&activity.record).clone();
        let scrollback = lock(&activity.scrollback).replay_after(after_sequence);
        let live = lock(&activity.command_tx).is_some() && record.status.is_live();
        let process_id = match activity.process_id.load(Ordering::Acquire) {
            0 => None,
            process_id => Some(process_id),
        };
        ActivitySnapshot {
            record,
            scrollback,
            live,
            process_id,
        }
    }

    fn kill_with_intent(
        &self,
        activity_id: &str,
        activity: &Arc<ManagedActivity>,
        intent: u8,
    ) -> Result<(), SupervisorError> {
        if lock(&activity.command_tx).is_none() {
            return if lock(&activity.record).status.is_ended() {
                Ok(())
            } else {
                Err(SupervisorError::NotRunning(activity_id.to_string()))
            };
        }
        activity.stop_intent.store(intent, Ordering::Release);
        let killer = lock(&activity.killer).take();
        if let Some(mut killer) = killer {
            killer.kill().map_err(|error| SupervisorError::Command {
                activity_id: activity_id.to_string(),
                message: format!("could not terminate process: {error}"),
            })?;
        }
        Ok(())
    }

    fn hydrate(&self) -> Result<(), SupervisorError> {
        // Import v1 JSON once. The source files stay in place for one-version
        // rollback, but SQLite is authoritative as soon as the source marker
        // commits. Do not parse a retained large JSON file on later starts.
        let imported_sources: HashSet<_> = self
            .inner
            .store
            .legacy_sources()
            .map_err(SupervisorError::PersistenceWorker)?
            .into_iter()
            .collect();
        let entries = fs::read_dir(&self.inner.config.persistence_dir).map_err(|source| {
            PersistenceError::Io {
                operation: "read activity persistence directory",
                path: self.inner.config.persistence_dir.clone(),
                source,
            }
        })?;
        for entry in entries {
            let entry = entry.map_err(|source| PersistenceError::Io {
                operation: "read activity persistence directory entry",
                path: self.inner.config.persistence_dir.clone(),
                source,
            })?;
            let path = entry.path();
            if !is_activity_persistence_file(&path) {
                continue;
            }
            let Some(source_name) = path
                .file_name()
                .and_then(|name| name.to_str())
                .map(str::to_owned)
            else {
                continue;
            };
            if imported_sources.contains(&source_name) {
                continue;
            }

            let persisted = match load_json_optional_quarantining::<PersistedActivity>(&path)? {
                QuarantinedLoad::Missing => continue,
                QuarantinedLoad::Loaded(persisted) => persisted,
                QuarantinedLoad::Quarantined { path, .. } => {
                    lock(&self.inner.quarantined_files).push(path);
                    continue;
                }
            };
            if persisted.version != PERSISTED_VERSION {
                if let Some(quarantined) = quarantine_corrupt_file(&path)? {
                    lock(&self.inner.quarantined_files).push(quarantined);
                }
                continue;
            }
            if persisted.record.retention != ActivityRetention::Durable {
                continue;
            }
            let byte_cap = if matches!(
                persisted.record.kind,
                ActivityKind::Agent | ActivityKind::Routine
            ) {
                self.inner.config.durable_scrollback_bytes
            } else {
                self.inner.config.terminal_scrollback_bytes
            };
            self.inner
                .store
                .import_legacy(LegacyActivity {
                    source_name,
                    record: persisted.record,
                    byte_cap,
                    chunks: persisted.scrollback.chunks,
                    next_sequence: persisted.scrollback.next_sequence,
                    truncated: persisted.scrollback.truncated,
                })
                .map_err(SupervisorError::PersistenceWorker)?;
        }

        let stored = self
            .inner
            .store
            .load_all()
            .map_err(SupervisorError::PersistenceWorker)?;
        let mut corrected_records = false;
        for loaded in stored {
            let mut record = loaded.record;
            if record.retention != ActivityRetention::Durable {
                self.inner
                    .store
                    .delete(&record.id)
                    .map_err(SupervisorError::PersistenceWorker)?;
                continue;
            }
            let mut corrected = false;
            if record.normalize_legacy_title_source() {
                corrected = true;
            }
            if capture_cli_session_id(&self.inner.config.persistence_dir, &mut record) {
                corrected = true;
            }
            if recover_legacy_codex_session_id(&self.inner.config, &mut record) {
                corrected = true;
            }
            if record.status.is_live() {
                corrected = true;
                let now = timestamp();
                let exit = SessionExitRecord {
                    reason: SessionExitReason::Interrupted,
                    code: None,
                    signal: None,
                    message: Some("Mimir exited before this activity completed".into()),
                };
                record.status = ActivityStatus::Interrupted;
                record.error = None;
                if let Some(session) = record.session.as_mut() {
                    session.ended_at = Some(now);
                    session.exit = Some(exit);
                }
            }
            if let Some(close_requested_at) = record.close_requested_at.take() {
                corrected = true;
                record.archived_at = Some(close_requested_at);
            }

            let scrollback = RawScrollback::from_persisted(
                loaded.byte_cap,
                loaded.chunks,
                loaded.next_sequence,
                loaded.truncated,
            );
            if let Some(session) = record.session.as_mut() {
                session.last_output_sequence = loaded.next_sequence.saturating_sub(1);
                session.scrollback_bytes = scrollback.retained_bytes() as u64;
            }
            let activity = Arc::new(ManagedActivity {
                record: Mutex::new(record),
                scrollback: Mutex::new(scrollback),
                command_tx: Mutex::new(None),
                killer: Mutex::new(None),
                stop_intent: AtomicU8::new(NO_STOP_INTENT),
                process_id: AtomicU32::new(0),
                last_output_persist_ms: AtomicU64::new(0),
                preserve_updated_at_until_turn: AtomicBool::new(false),
                next_event_sequence: AtomicU64::new(loaded.next_sequence.max(1)),
                terminal_order: Mutex::new(()),
                terminal_size: Mutex::new((loaded.cols, loaded.rows)),
                checkpoint_lease: Mutex::new(None),
                next_lease_generation: AtomicU64::new(1),
                terminal_search: Mutex::new(TerminalSearchState {
                    checkpoint_through_sequence: loaded.checkpoint_through_sequence,
                    checkpoint_text: loaded.checkpoint_search_text,
                }),
                tracker: Mutex::new(None),
                runtime_started: Instant::now(),
                output_flush: Mutex::new(None),
            });
            let activity_id = lock(&activity.record).id.clone();
            lock(&self.inner.activities).insert(activity_id, activity.clone());
            if corrected {
                self.inner.persist_if_durable(&activity);
                corrected_records = true;
            }
        }
        if corrected_records {
            self.inner
                .store
                .flush()
                .map_err(SupervisorError::PersistenceWorker)?;
        }
        Ok(())
    }
}

impl SupervisorInner {
    fn publish(&self, event: ActivityEvent) {
        let sinks: Vec<_> = lock(&self.dispatch).sinks.values().cloned().collect();
        publish_to_sinks(&sinks, &event);
    }

    /// Record one coalesced batch of PTY output. Bytes within a batch keep
    /// their read order, and the whole batch takes a single scrollback
    /// sequence, so attach snapshots and live events never split a batch.
    fn record_output(&self, activity: &Arc<ManagedActivity>, bytes: Vec<u8>) {
        let _terminal_order = lock(&activity.terminal_order);
        let output_elapsed_ms = elapsed_ms(activity.runtime_started);
        let status_change = {
            let mut tracker = lock(&activity.tracker);
            tracker
                .as_mut()
                .and_then(|tracker| tracker.feed(&bytes, output_elapsed_ms))
        };
        let status_updated = status_change.is_some();

        let mut events = Vec::with_capacity(2);
        let sinks;
        {
            // This gate makes attach+snapshot race-free. No callback or I/O is
            // performed while it is held.
            let dispatch = lock(&self.dispatch);
            let mut record = lock(&activity.record);
            let mut scrollback = lock(&activity.scrollback);
            let sequence = activity.next_event_sequence.fetch_add(1, Ordering::AcqRel);
            scrollback.append_with_sequence(sequence, &bytes);
            let retained_bytes = scrollback.retained_bytes() as u64;
            if let Some(session) = record.session.as_mut() {
                session.last_output_sequence = sequence;
                session.scrollback_bytes = retained_bytes;
            }
            let persist_output = record.retention.should_persist()
                && (status_updated
                    || claim_periodic_persistence(
                        &activity.last_output_persist_ms,
                        output_elapsed_ms,
                    ));
            if persist_output && !holds_activity_time(activity) {
                record.updated_at = timestamp();
            }
            apply_status_change(&mut record, status_change.as_ref());
            let activity_id = record.id.clone();
            let run_id = record
                .session
                .as_ref()
                .map(|session| session.run_id.clone())
                .unwrap_or_default();
            self.store.append_event(
                activity_id.clone(),
                run_id,
                TerminalEvent::Output {
                    sequence,
                    bytes: bytes.clone(),
                },
            );
            events.push(ActivityEvent::Output {
                activity_id,
                sequence,
                bytes,
            });
            if let Some(change) = status_change {
                events.push(ActivityEvent::Status {
                    activity_id: record.id.clone(),
                    status: change.status,
                    needs_input_is_blocking: change.needs_input_is_blocking,
                });
            }
            if persist_output && record.retention.should_persist() {
                self.store
                    .save_record(record.clone(), scrollback.byte_cap());
            }
            sinks = dispatch.sinks.values().cloned().collect::<Vec<_>>();
        }
        for event in events {
            publish_to_sinks(&sinks, &event);
        }
    }

    fn record_resize(&self, activity: &Arc<ManagedActivity>, cols: u16, rows: u16) {
        let cols = cols.max(1);
        let rows = rows.max(1);
        let event;
        let sinks;
        {
            let dispatch = lock(&self.dispatch);
            let record = lock(&activity.record);
            if lock(&activity.command_tx).is_none() {
                return;
            }
            let mut size = lock(&activity.terminal_size);
            if *size == (cols, rows) {
                return;
            }
            *size = (cols, rows);
            let sequence = activity.next_event_sequence.fetch_add(1, Ordering::AcqRel);
            lock(&activity.scrollback).observe_sequence(sequence);
            let run_id = record
                .session
                .as_ref()
                .map(|session| session.run_id.clone())
                .unwrap_or_default();
            self.store.append_event(
                record.id.clone(),
                run_id,
                TerminalEvent::Resize {
                    sequence,
                    cols,
                    rows,
                },
            );
            event = ActivityEvent::Resize {
                activity_id: record.id.clone(),
                sequence,
                cols,
                rows,
            };
            sinks = dispatch.sinks.values().cloned().collect::<Vec<_>>();
        }
        publish_to_sinks(&sinks, &event);
    }

    fn record_agent_status(&self, activity: &Arc<ManagedActivity>, change: AgentStatusChange) {
        let event;
        let sinks;
        {
            let dispatch = lock(&self.dispatch);
            let mut record = lock(&activity.record);
            if record.status.is_ended() {
                return;
            }
            let scrollback = lock(&activity.scrollback);
            record.status = change.status;
            if !holds_activity_time(activity) {
                record.updated_at = timestamp();
            }
            event = ActivityEvent::Status {
                activity_id: record.id.clone(),
                status: change.status,
                needs_input_is_blocking: change.needs_input_is_blocking,
            };
            if record.retention.should_persist() {
                self.store
                    .save_record(record.clone(), scrollback.byte_cap());
            }
            sinks = dispatch.sinks.values().cloned().collect::<Vec<_>>();
        }
        publish_to_sinks(&sinks, &event);
    }

    fn record_activity_interaction(&self, activity: &Arc<ManagedActivity>) {
        if !activity
            .preserve_updated_at_until_turn
            .swap(false, Ordering::AcqRel)
        {
            return;
        }

        let record_snapshot;
        let sinks;
        {
            let dispatch = lock(&self.dispatch);
            let mut record = lock(&activity.record);
            let scrollback = lock(&activity.scrollback);
            record.updated_at = timestamp();
            record_snapshot = record.clone();
            if record.retention.should_persist() {
                self.store
                    .save_record(record.clone(), scrollback.byte_cap());
            }
            sinks = dispatch.sinks.values().cloned().collect::<Vec<_>>();
        }
        publish_to_sinks(
            &sinks,
            &ActivityEvent::Upsert {
                record: record_snapshot,
            },
        );
    }

    fn complete(
        &self,
        activity: &Arc<ManagedActivity>,
        child_result: Result<ExitStatus, String>,
        reader_result: Result<(), String>,
    ) {
        // The reader has finished, so no new bytes can arrive. Joining the
        // flush worker publishes every buffered Output event (and feeds the
        // status tracker) before the exit below is classified and announced.
        let output_flush = lock(&activity.output_flush).take();
        if let Some(output_flush) = output_flush {
            output_flush.finish();
        }
        let exit = classify_exit(
            activity.stop_intent.load(Ordering::Acquire),
            child_result,
            reader_result,
        );
        let status_change = {
            let mut tracker = lock(&activity.tracker);
            tracker
                .as_mut()
                .and_then(|tracker| tracker.finish(&exit, elapsed_ms(activity.runtime_started)))
        };
        let _ = lock(&activity.command_tx).take().map(|command_tx| {
            let _ = command_tx.send(SessionCommand::Close);
        });
        lock(&activity.killer).take();
        activity.process_id.store(0, Ordering::Release);

        let record_snapshot;
        let sinks;
        {
            let dispatch = lock(&self.dispatch);
            let mut record = lock(&activity.record);
            let scrollback = lock(&activity.scrollback);
            let now = timestamp();
            record.status = exit.activity_status();
            if exit.reason != SessionExitReason::Interrupted {
                record.updated_at = now.clone();
            }
            record.error = if exit.reason == SessionExitReason::Failed {
                exit.message.clone()
            } else {
                None
            };
            if let Some(close_requested_at) = record.close_requested_at.take() {
                record.archived_at = Some(close_requested_at);
            }
            capture_cli_session_id_after_exit(&self.config.persistence_dir, &mut record);
            recover_legacy_codex_session_id(&self.config, &mut record);
            if let Some(session) = record.session.as_mut() {
                session.ended_at = Some(now);
                session.exit = Some(exit.clone());
                session.last_output_sequence = activity
                    .next_event_sequence
                    .load(Ordering::Acquire)
                    .saturating_sub(1);
                session.scrollback_bytes = scrollback.retained_bytes() as u64;
            }
            if let Some(change) = status_change {
                debug_assert_eq!(change.status, record.status);
            }
            record_snapshot = record.clone();
            if record.retention.should_persist() {
                self.store
                    .save_record(record.clone(), scrollback.byte_cap());
            }
            sinks = dispatch.sinks.values().cloned().collect::<Vec<_>>();
        }
        publish_to_sinks(
            &sinks,
            &ActivityEvent::Exit {
                activity_id: record_snapshot.id.clone(),
                exit,
                record: record_snapshot,
            },
        );
    }

    fn persist_if_durable(&self, activity: &Arc<ManagedActivity>) {
        let record = lock(&activity.record);
        if !record.retention.should_persist() {
            return;
        }
        let scrollback = lock(&activity.scrollback);
        self.store
            .save_record(record.clone(), scrollback.byte_cap());
    }
}

fn command_loop(
    master: Box<dyn MasterPty + Send>,
    mut writer: Box<dyn Write + Send>,
    receiver: mpsc::Receiver<SessionCommand>,
    inner: Arc<SupervisorInner>,
    activity: Arc<ManagedActivity>,
) {
    while let Ok(command) = receiver.recv() {
        match command {
            SessionCommand::Write(bytes, ack) => {
                let result = writer
                    .write_all(&bytes)
                    .and_then(|_| writer.flush())
                    .map_err(|error| error.to_string());
                let _ = ack.send(result);
            }
            SessionCommand::Resize(size, ack) => {
                let _terminal_order = lock(&activity.terminal_order);
                let cols = size.cols;
                let rows = size.rows;
                let result = master.resize(size).map_err(|error| error.to_string());
                if result.is_ok() {
                    inner.record_resize(&activity, cols, rows);
                }
                let _ = ack.send(result);
            }
            SessionCommand::Close => break,
        }
    }
}

fn reader_loop(
    mut reader: Box<dyn Read + Send>,
    read_chunk_bytes: usize,
    coalescer: Arc<OutputCoalescer>,
) -> Result<(), String> {
    let mut buffer = vec![0_u8; read_chunk_bytes.max(1)];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => return Ok(()),
            Ok(read) => coalescer.push(&buffer[..read]),
            Err(error) if is_pty_eof(&error) => return Ok(()),
            Err(error) => return Err(error.to_string()),
        }
    }
}

/// Drains coalesced PTY output at most once per `OUTPUT_FLUSH_FRAME`. The
/// first bytes after a quiet period wait `OUTPUT_FLUSH_GATHER` so a burst
/// (a TUI repaint) publishes whole; sustained floods collapse into one
/// Output event per frame. A full buffer or a close flushes at once.
fn output_flush_loop(
    inner: Arc<SupervisorInner>,
    activity: Arc<ManagedActivity>,
    coalescer: Arc<OutputCoalescer>,
) {
    let mut next_flush_at = Instant::now();
    loop {
        let (bytes, closed) = drain_output(&coalescer, next_flush_at, OUTPUT_FLUSH_GATHER);
        // Wake a reader blocked on the buffer cap now that it is drained.
        coalescer.wakeup.notify_all();
        if bytes.is_empty() {
            debug_assert!(closed);
            return;
        }
        inner.record_output(&activity, bytes);
        next_flush_at = Instant::now() + OUTPUT_FLUSH_FRAME;
        if closed {
            return;
        }
    }
}

/// Blocks until pending output is ready to publish, then drains it. Mid-flood
/// wakes hold to `next_flush_at`; after a quiet period (deadline already
/// passed) the drain waits `gather` from now instead of returning the first
/// read alone. A close or a buffer over `OUTPUT_FLUSH_BUFFER_BYTES` drains
/// immediately. Returns the drained bytes and whether the coalescer closed.
fn drain_output(
    coalescer: &OutputCoalescer,
    next_flush_at: Instant,
    gather: Duration,
) -> (Vec<u8>, bool) {
    let state = lock(&coalescer.state);
    let mut state = coalescer
        .wakeup
        .wait_while(state, |state| state.pending.is_empty() && !state.closed)
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let now = Instant::now();
    let deadline = if next_flush_at > now {
        next_flush_at
    } else {
        now + gather
    };
    while !state.closed && state.pending.len() < OUTPUT_FLUSH_BUFFER_BYTES {
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            break;
        };
        let (next_state, timeout) = coalescer
            .wakeup
            .wait_timeout(state, remaining)
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state = next_state;
        if timeout.timed_out() {
            break;
        }
    }
    (std::mem::take(&mut state.pending), state.closed)
}

fn agent_status_poll_loop(inner: Arc<SupervisorInner>, activity: Arc<ManagedActivity>) {
    let interval_ms = inner
        .config
        .agent_status
        .idle_threshold_ms
        .saturating_div(4)
        .clamp(50, 500);
    let interval = Duration::from_millis(interval_ms);

    loop {
        thread::sleep(interval);
        if lock(&activity.command_tx).is_none() {
            return;
        }
        let change = {
            let mut tracker = lock(&activity.tracker);
            tracker
                .as_mut()
                .and_then(|tracker| tracker.poll(elapsed_ms(activity.runtime_started)))
        };
        if let Some(change) = change {
            inner.record_agent_status(&activity, change);
        }
    }
}

fn completion_loop(
    receiver: mpsc::Receiver<CompletionPart>,
    inner: Arc<SupervisorInner>,
    activity: Arc<ManagedActivity>,
) {
    let mut child_result = None;
    let mut reader_result = None;
    while child_result.is_none() || reader_result.is_none() {
        match receiver.recv() {
            Ok(CompletionPart::Child(result)) => child_result = Some(result),
            Ok(CompletionPart::Reader(result)) => reader_result = Some(result),
            Err(_) => break,
        }
    }
    inner.complete(
        &activity,
        child_result.unwrap_or_else(|| Err("child reaper stopped unexpectedly".into())),
        reader_result.unwrap_or_else(|| Err("PTY reader stopped unexpectedly".into())),
    );
}

fn apply_status_change(record: &mut ActivityRecord, change: Option<&AgentStatusChange>) {
    if let Some(change) = change {
        record.status = change.status;
    }
}

/// A live interactive surface is not necessarily doing work. Agent status has
/// its own tracker, while a plain terminal remains idle until its shell exits.
/// Task-style process Activities remain working for the life of the process.
fn initial_live_status(kind: ActivityKind) -> ActivityStatus {
    match kind {
        ActivityKind::Terminal | ActivityKind::Agent | ActivityKind::Files => ActivityStatus::Idle,
        ActivityKind::App | ActivityKind::Routine => ActivityStatus::Working,
    }
}

fn holds_activity_time(activity: &ManagedActivity) -> bool {
    activity
        .preserve_updated_at_until_turn
        .load(Ordering::Acquire)
        || activity.stop_intent.load(Ordering::Acquire) == QUIT_INTERRUPT_INTENT
}

fn normalize_provisional_title(value: &str) -> String {
    let compact = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let compact = compact.trim_matches(|character| {
        matches!(
            character,
            '"' | '\'' | '`' | '*' | '#' | '“' | '”' | '‘' | '’'
        )
    });
    let words = compact
        .split_whitespace()
        .take(8)
        .collect::<Vec<_>>()
        .join(" ");
    let mut bounded = words.chars().take(60).collect::<String>();
    if words.chars().count() > 60 {
        if let Some(boundary) = bounded.rfind(' ') {
            bounded.truncate(boundary);
        }
    }
    bounded
        .trim_end_matches(['.', ',', ';', ':'])
        .trim()
        .to_string()
}

fn classify_exit(
    stop_intent: u8,
    child_result: Result<ExitStatus, String>,
    reader_result: Result<(), String>,
) -> SessionExitRecord {
    match stop_intent {
        USER_STOP_INTENT => SessionExitRecord {
            reason: SessionExitReason::Stopped,
            code: child_result.ok().map(exit_code),
            signal: None,
            message: None,
        },
        QUIT_INTERRUPT_INTENT => SessionExitRecord {
            reason: SessionExitReason::Interrupted,
            code: child_result.ok().map(exit_code),
            signal: None,
            message: Some("Mimir quit while this activity was running".into()),
        },
        _ => match child_result {
            Ok(status) if status.success() => SessionExitRecord {
                reason: SessionExitReason::Completed,
                code: Some(exit_code(status)),
                signal: None,
                message: reader_result.err(),
            },
            Ok(status) => SessionExitRecord {
                reason: SessionExitReason::Failed,
                code: Some(exit_code(status.clone())),
                signal: None,
                message: Some(status.to_string()),
            },
            Err(message) => SessionExitRecord {
                reason: SessionExitReason::Failed,
                code: None,
                signal: None,
                message: Some(message),
            },
        },
    }
}

fn exit_code(status: ExitStatus) -> i32 {
    i32::try_from(status.exit_code()).unwrap_or(i32::MAX)
}

fn receive_command_ack(
    activity_id: &str,
    receiver: mpsc::Receiver<Result<(), String>>,
) -> Result<(), SupervisorError> {
    receiver
        .recv()
        .map_err(|_| SupervisorError::CommandChannelClosed {
            activity_id: activity_id.to_string(),
        })?
        .map_err(|message| SupervisorError::Command {
            activity_id: activity_id.to_string(),
            message,
        })
}

fn activity_persistence_path(directory: &Path, activity_id: &str) -> PathBuf {
    let digest = Sha256::digest(activity_id.as_bytes());
    directory.join(format!("{digest:x}.activity.json"))
}

fn session_bindings_dir(persistence_dir: &Path) -> PathBuf {
    persistence_dir.join(".session-bindings")
}

fn capture_cli_session_id(persistence_dir: &Path, record: &mut ActivityRecord) -> bool {
    let Some(session) = record.session.as_ref() else {
        return false;
    };
    let path = session_bindings_dir(persistence_dir).join(format!("{}.json", session.run_id));
    let binding = fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<CliSessionBinding>(&bytes).ok());
    let _ = fs::remove_file(&path);
    let Some(binding) = binding else {
        return false;
    };
    if binding.activity_id != record.id
        || binding.run_id != session.run_id
        || Uuid::parse_str(&binding.cli_session_id).is_err()
    {
        return false;
    }
    let Some(session) = record.session.as_mut() else {
        return false;
    };
    if session.cli_session_id.as_deref() == Some(&binding.cli_session_id) {
        return false;
    }
    session.cli_session_id = Some(binding.cli_session_id);
    true
}

fn capture_cli_session_id_after_exit(persistence_dir: &Path, record: &mut ActivityRecord) {
    let awaits_codex_binding = record.session.as_ref().is_some_and(|session| {
        (session.agent_id.as_deref() == Some("codex")
            || record.source.launcher_id.as_deref() == Some("codex"))
            && session.cli_session_id.is_none()
    });
    if !awaits_codex_binding || capture_cli_session_id(persistence_dir, record) {
        return;
    }
    // Codex starts notify at turn completion. Normally its atomic binding is
    // already present when the PTY exits; allow a short scheduling grace
    // period so a fast Ctrl-D cannot leave a safely resumable thread unbound.
    for _ in 0..20 {
        thread::sleep(Duration::from_millis(5));
        if capture_cli_session_id(persistence_dir, record) {
            break;
        }
    }
}

fn recover_legacy_codex_session_id(
    config: &ActivitySupervisorConfig,
    record: &mut ActivityRecord,
) -> bool {
    let needs_recovery = record.session.as_ref().is_some_and(|session| {
        (session.agent_id.as_deref() == Some("codex")
            || record.source.launcher_id.as_deref() == Some("codex"))
            && session.cli_session_id.is_none()
    });
    if !needs_recovery {
        return false;
    }
    let launch_sessions_dir = record
        .launch
        .as_ref()
        .and_then(|launch| launch.env.get("CODEX_HOME"))
        .map(|codex_home| PathBuf::from(codex_home).join("sessions"));
    let Some(root) = launch_sessions_dir
        .as_deref()
        .or(config.codex_sessions_dir.as_deref())
    else {
        return false;
    };
    let Ok(created_at) = DateTime::parse_from_rfc3339(&record.created_at) else {
        return false;
    };
    let workspace = record.workspace_path.as_deref().or_else(|| {
        record
            .launch
            .as_ref()
            .and_then(|launch| launch.cwd.as_deref())
    });
    let Some(workspace) = workspace else {
        return false;
    };

    let local_date = created_at.with_timezone(&Local).date_naive();
    let mut candidates = HashSet::new();
    for day_offset in -1..=1 {
        let date = local_date + chrono::Duration::days(day_offset);
        let directory = root
            .join(date.format("%Y").to_string())
            .join(date.format("%m").to_string())
            .join(date.format("%d").to_string());
        let Ok(entries) = fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                continue;
            }
            let Ok(file) = fs::File::open(path) else {
                continue;
            };
            let mut first_line = String::new();
            if BufReader::new(file).read_line(&mut first_line).is_err() {
                continue;
            }
            let Ok(meta) = serde_json::from_str::<CodexSessionMetaEnvelope>(&first_line) else {
                continue;
            };
            if meta.event_type != "session_meta" || meta.payload.cwd != workspace {
                continue;
            }
            let Ok(session_at) = DateTime::parse_from_rfc3339(&meta.payload.timestamp) else {
                continue;
            };
            let delta_ms = session_at
                .signed_duration_since(created_at)
                .num_milliseconds();
            if (-1_000..=15_000).contains(&delta_ms) && Uuid::parse_str(&meta.payload.id).is_ok() {
                candidates.insert(meta.payload.id);
            }
        }
    }
    if candidates.len() != 1 {
        return false;
    }
    let cli_session_id = candidates.into_iter().next().expect("one candidate");
    let Some(session) = record.session.as_mut() else {
        return false;
    };
    session.cli_session_id = Some(cli_session_id);
    true
}

fn is_activity_persistence_file(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(".activity.json"))
}

fn publish_to_sinks(sinks: &[Arc<dyn ActivityEventSink>], event: &ActivityEvent) {
    for sink in sinks {
        // One faulty integration must not stop PTY capture or process reaping.
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| sink.publish(event)));
    }
}

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn timestamp() -> String {
    Utc::now().to_rfc3339()
}

fn elapsed_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

fn claim_periodic_persistence(last_persist_ms: &AtomicU64, elapsed_ms: u64) -> bool {
    let stamp = elapsed_ms.saturating_add(1);
    loop {
        let previous = last_persist_ms.load(Ordering::Acquire);
        if previous != 0 && stamp.saturating_sub(previous) < OUTPUT_RECORD_PERSIST_INTERVAL_MS {
            return false;
        }
        if last_persist_ms
            .compare_exchange(previous, stamp, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            return true;
        }
    }
}

fn is_pty_eof(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::UnexpectedEof || (cfg!(unix) && error.raw_os_error() == Some(5))
}

fn terminal_search_text(bytes: &[u8]) -> String {
    #[derive(Clone, Copy)]
    enum State {
        Text,
        Escape,
        Csi,
        Osc,
        OscEscape,
    }

    let mut state = State::Text;
    let mut plain = Vec::with_capacity(bytes.len());
    for &byte in bytes {
        state = match state {
            State::Text => match byte {
                0x1b => State::Escape,
                b'\n' | b'\r' | b'\t' => {
                    plain.push(b' ');
                    State::Text
                }
                0x20..=0x7e | 0x80..=0xff => {
                    plain.push(byte);
                    State::Text
                }
                _ => State::Text,
            },
            State::Escape => match byte {
                b'[' => State::Csi,
                b']' => State::Osc,
                _ => State::Text,
            },
            State::Csi => {
                if (0x40..=0x7e).contains(&byte) {
                    State::Text
                } else {
                    State::Csi
                }
            }
            State::Osc => match byte {
                0x07 => State::Text,
                0x1b => State::OscEscape,
                _ => State::Osc,
            },
            State::OscEscape => {
                if byte == b'\\' {
                    State::Text
                } else {
                    State::Osc
                }
            }
        };
    }

    String::from_utf8_lossy(&plain)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn search_snippet(text: &str, index: usize, needle_len: usize) -> String {
    let mut start = index.saturating_sub(56);
    while start > 0 && !text.is_char_boundary(start) {
        start -= 1;
    }
    let mut end = index
        .saturating_add(needle_len)
        .saturating_add(96)
        .min(text.len());
    while end < text.len() && !text.is_char_boundary(end) {
        end += 1;
    }
    let prefix = if start > 0 { "…" } else { "" };
    let suffix = if end < text.len() { "…" } else { "" };
    format!("{prefix}{}{suffix}", text[start..end].trim())
}

fn recent_snippet(text: &str) -> String {
    const CONTEXT_BYTES: usize = 180;
    let mut start = text.len().saturating_sub(CONTEXT_BYTES);
    while start > 0 && !text.is_char_boundary(start) {
        start -= 1;
    }
    let prefix = if start > 0 { "…" } else { "" };
    format!("{prefix}{}", text[start..].trim())
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::activities::model::{ActivityLaunchSpec, ActivityOrigin};
    use rusqlite::{params, Connection};
    use std::collections::BTreeMap;
    use tempfile::TempDir;

    fn durable_record(id: &str, command: &str, args: Vec<String>) -> ActivityRecord {
        let now = "2026-07-25T00:00:00Z".to_string();
        ActivityRecord {
            id: id.into(),
            kind: ActivityKind::Agent,
            title: id.into(),
            title_source: ActivityTitleSource::Manual,
            legacy_auto_title_eligible: None,
            workspace_path: None,
            status: ActivityStatus::Ready,
            created_at: now.clone(),
            updated_at: now,
            last_viewed_at: None,
            archived_at: None,
            close_requested_at: None,
            retention: ActivityRetention::Durable,
            source: ActivityOrigin {
                launcher_id: Some("test-agent".into()),
                ..ActivityOrigin::default()
            },
            host: ActivityHost::pty(None),
            launch: Some(ActivityLaunchSpec {
                command: command.into(),
                args,
                cwd: None,
                env: BTreeMap::new(),
            }),
            session: None,
            error: None,
        }
    }

    fn create_supervisor(temp: &TempDir) -> ActivitySupervisor {
        let mut config = ActivitySupervisorConfig::new(temp.path());
        config.terminal_scrollback_bytes = 32 * 1024;
        config.durable_scrollback_bytes = 32 * 1024;
        config.agent_status.fallback_activity_delay_ms = 0;
        config.agent_status.idle_threshold_ms = 100;
        ActivitySupervisor::new(config).unwrap()
    }

    fn rewrite_stored_record(
        temp: &TempDir,
        activity_id: &str,
        mutate: impl FnOnce(&mut ActivityRecord),
    ) {
        let connection = Connection::open(ActivityStore::database_path(temp.path())).unwrap();
        let bytes: Vec<u8> = connection
            .query_row(
                "SELECT record_json FROM activity_records WHERE activity_id = ?1",
                params![activity_id],
                |row| row.get(0),
            )
            .unwrap();
        let mut record: ActivityRecord = serde_json::from_slice(&bytes).unwrap();
        mutate(&mut record);
        connection
            .execute(
                "UPDATE activity_records SET record_json = ?2 WHERE activity_id = ?1",
                params![activity_id, serde_json::to_vec(&record).unwrap()],
            )
            .unwrap();
    }

    fn wait_for_end(supervisor: &ActivitySupervisor, id: &str) -> ActivitySnapshot {
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            let snapshot = supervisor.snapshot(id, None).unwrap();
            if snapshot.record.status.is_ended() {
                return snapshot;
            }
            assert!(Instant::now() < deadline, "activity {id} did not exit");
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn replay_bytes(snapshot: &ActivitySnapshot) -> Vec<u8> {
        snapshot
            .scrollback
            .chunks
            .iter()
            .flat_map(|chunk| chunk.bytes.iter().copied())
            .collect()
    }

    #[test]
    fn initial_live_status_separates_interactive_surfaces_from_process_work() {
        assert_eq!(
            initial_live_status(ActivityKind::Terminal),
            ActivityStatus::Idle
        );
        assert_eq!(
            initial_live_status(ActivityKind::Agent),
            ActivityStatus::Idle
        );
        assert_eq!(
            initial_live_status(ActivityKind::Files),
            ActivityStatus::Idle
        );
        assert_eq!(
            initial_live_status(ActivityKind::App),
            ActivityStatus::Working
        );
        assert_eq!(
            initial_live_status(ActivityKind::Routine),
            ActivityStatus::Working
        );
    }

    #[test]
    fn noisy_output_persistence_is_bounded_without_losing_the_first_snapshot() {
        let last = AtomicU64::new(0);

        assert!(claim_periodic_persistence(&last, 0));
        assert!(!claim_periodic_persistence(
            &last,
            OUTPUT_RECORD_PERSIST_INTERVAL_MS - 1
        ));
        assert!(claim_periodic_persistence(
            &last,
            OUTPUT_RECORD_PERSIST_INTERVAL_MS
        ));
        assert!(!claim_periodic_persistence(
            &last,
            OUTPUT_RECORD_PERSIST_INTERVAL_MS * 2 - 1
        ));
        assert!(claim_periodic_persistence(
            &last,
            OUTPUT_RECORD_PERSIST_INTERVAL_MS * 2
        ));
    }

    #[test]
    fn archived_history_search_returns_plain_bounded_context() {
        let temp = tempfile::tempdir().unwrap();
        let supervisor = create_supervisor(&temp);
        supervisor
            .spawn(SpawnActivityRequest::new(
                durable_record(
                    "history-search",
                    "/bin/sh",
                    vec![
                        "-c".into(),
                        "printf '\\033[31mreviewed sidebar ordering\\033[0m\\n'".into(),
                    ],
                ),
                80,
                24,
            ))
            .unwrap();
        wait_for_end(&supervisor, "history-search");
        supervisor.set_archived("history-search", true).unwrap();

        let hits = supervisor.search_history("sidebar ordering", 10);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].activity_id, "history-search");
        assert!(hits[0].snippet.contains("reviewed sidebar ordering"));
        assert!(!hits[0].snippet.contains("\u{1b}["));
        let recent = supervisor.search_history("", 10);
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].activity_id, "history-search");
        assert!(recent[0].snippet.contains("reviewed sidebar ordering"));
        assert!(!recent[0].snippet.contains("\u{1b}["));
        assert!(supervisor.search_history("not present", 10).is_empty());
    }

    #[test]
    fn coalescer_applies_backpressure_and_preserves_bytes_across_drain() {
        let coalescer = OutputCoalescer::new();
        let pusher_coalescer = coalescer.clone();
        let pusher = thread::spawn(move || {
            pusher_coalescer.push(&vec![b'a'; OUTPUT_FLUSH_BUFFER_BYTES]);
            // Reached only after the capped buffer is drained below.
            pusher_coalescer.push(b"tail");
            pusher_coalescer.close();
        });

        let deadline = Instant::now() + Duration::from_secs(5);
        while lock(&coalescer.state).pending.len() < OUTPUT_FLUSH_BUFFER_BYTES {
            assert!(
                Instant::now() < deadline,
                "capped push never became visible"
            );
            thread::sleep(Duration::from_millis(1));
        }

        let drained = std::mem::take(&mut lock(&coalescer.state).pending);
        coalescer.wakeup.notify_all();
        pusher.join().unwrap();

        assert_eq!(drained, vec![b'a'; OUTPUT_FLUSH_BUFFER_BYTES]);
        let state = lock(&coalescer.state);
        assert_eq!(state.pending, b"tail");
        assert!(state.closed);
    }

    #[test]
    fn quiet_period_burst_gathers_into_one_drain() {
        let coalescer = OutputCoalescer::new();
        coalescer.push(b"\x1b[1A\x1b[2K");
        let pusher_coalescer = coalescer.clone();
        let pusher = thread::spawn(move || {
            thread::sleep(Duration::from_millis(10));
            pusher_coalescer.push(b"redrawn frame");
        });
        // The frame deadline passed long ago (quiet period). The gather
        // window must hold the drain until the rest of the repaint burst
        // arrives, so erase and redraw publish as one event.
        let (bytes, closed) = drain_output(
            &coalescer,
            Instant::now() - Duration::from_secs(1),
            Duration::from_millis(200),
        );
        pusher.join().unwrap();
        assert_eq!(bytes, b"\x1b[1A\x1b[2Kredrawn frame".to_vec());
        assert!(!closed);
    }

    #[test]
    fn close_ends_the_gather_window_immediately() {
        let coalescer = OutputCoalescer::new();
        coalescer.push(b"tail");
        coalescer.close();
        let started = Instant::now();
        let (bytes, closed) = drain_output(
            &coalescer,
            Instant::now() - Duration::from_secs(1),
            Duration::from_secs(30),
        );
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(bytes, b"tail".to_vec());
        assert!(closed);
    }

    #[cfg(unix)]
    #[test]
    fn rapid_output_coalesces_into_fewer_events_and_flushes_before_exit() {
        let temp = TempDir::new().unwrap();
        let supervisor = create_supervisor(&temp);
        let (event_tx, event_rx) = mpsc::channel();
        supervisor.subscribe(Arc::new(event_tx));

        let lines = 400_usize;
        let record = durable_record(
            "burst",
            "/bin/sh",
            vec![
                "-c".into(),
                format!(
                    "i=0; while [ $i -lt {lines} ]; do printf 'chunk-%04d\\n' \"$i\"; i=$((i+1)); done"
                ),
            ],
        );
        supervisor
            .spawn(SpawnActivityRequest::new(record, 80, 24))
            .unwrap();
        let snapshot = wait_for_end(&supervisor, "burst");
        assert_eq!(snapshot.record.status, ActivityStatus::Done);

        let mut output_events = 0_usize;
        let mut streamed = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(8);
        let exit_record = loop {
            assert!(Instant::now() < deadline, "exit event never arrived");
            match event_rx.recv_timeout(Duration::from_millis(200)) {
                Ok(ActivityEvent::Output {
                    activity_id, bytes, ..
                }) if activity_id == "burst" => {
                    output_events += 1;
                    streamed.extend_from_slice(&bytes);
                }
                Ok(ActivityEvent::Exit {
                    activity_id,
                    record,
                    ..
                }) if activity_id == "burst" => break record,
                Ok(_) | Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => panic!("event channel closed"),
            }
        };
        assert_eq!(exit_record.status, ActivityStatus::Done);

        // Every byte precedes the exit event: the streamed Output events alone
        // rebuild the complete scrollback, and nothing trails the exit.
        assert_eq!(streamed, replay_bytes(&snapshot));
        assert!(String::from_utf8_lossy(&streamed).contains("chunk-0399"));
        while let Ok(event) = event_rx.recv_timeout(Duration::from_millis(200)) {
            assert!(
                !matches!(
                    event,
                    ActivityEvent::Output { activity_id, .. } if activity_id == "burst"
                ),
                "output event arrived after exit"
            );
        }

        assert!(output_events >= 1);
        assert!(
            output_events < lines / 4,
            "expected frame coalescing to batch {lines} rapid writes, saw {output_events} output events"
        );
    }

    #[cfg(unix)]
    #[test]
    fn exact_argv_is_preserved_and_early_output_is_replayed() {
        let temp = TempDir::new().unwrap();
        let supervisor = create_supervisor(&temp);
        let record = durable_record(
            "argv",
            "/bin/sh",
            vec![
                "-c".into(),
                "printf '%s' \"$1\"".into(),
                "mimir".into(),
                "two words;still-one-arg".into(),
            ],
        );
        supervisor
            .spawn(SpawnActivityRequest::new(record, 80, 24))
            .unwrap();

        let snapshot = wait_for_end(&supervisor, "argv");
        assert_eq!(snapshot.record.status, ActivityStatus::Done);
        assert_eq!(replay_bytes(&snapshot), b"two words;still-one-arg");
        assert_eq!(
            snapshot.record.session.unwrap().exit.unwrap().reason,
            SessionExitReason::Completed
        );
    }

    #[cfg(unix)]
    #[test]
    fn runs_noisy_sessions_independently_without_output_crossover() {
        let temp = TempDir::new().unwrap();
        let supervisor = create_supervisor(&temp);
        for (id, token) in [("left", "LEFT"), ("right", "RIGHT")] {
            let record = durable_record(
                id,
                "/bin/sh",
                vec![
                    "-c".into(),
                    format!("i=0; while [ $i -lt 300 ]; do printf '{token}-%03d\\n' \"$i\"; i=$((i+1)); done"),
                ],
            );
            supervisor
                .spawn(SpawnActivityRequest::new(record, 80, 24))
                .unwrap();
        }

        let left = replay_bytes(&wait_for_end(&supervisor, "left"));
        let right = replay_bytes(&wait_for_end(&supervisor, "right"));
        assert!(String::from_utf8_lossy(&left).contains("LEFT-299"));
        assert!(!String::from_utf8_lossy(&left).contains("RIGHT"));
        assert!(String::from_utf8_lossy(&right).contains("RIGHT-299"));
        assert!(!String::from_utf8_lossy(&right).contains("LEFT"));
    }

    #[cfg(unix)]
    #[test]
    fn shutdown_interrupts_live_ptys_and_flushes_the_final_snapshot() {
        let temp = TempDir::new().unwrap();
        let supervisor = create_supervisor(&temp);
        let record = durable_record(
            "quit",
            "/bin/sh",
            vec!["-c".into(), "printf before-quit; sleep 30".into()],
        );
        supervisor
            .spawn(SpawnActivityRequest::new(record, 80, 24))
            .unwrap();

        let deadline = Instant::now() + Duration::from_secs(3);
        let before_shutdown = loop {
            let snapshot = supervisor.snapshot("quit", None).unwrap();
            if replay_bytes(&snapshot).contains(&b'b') {
                break snapshot.record.updated_at;
            }
            assert!(Instant::now() < deadline, "activity output never arrived");
            thread::sleep(Duration::from_millis(10));
        };

        let report = supervisor.shutdown(Duration::from_secs(3)).unwrap();
        assert_eq!(
            report,
            ActivityShutdownReport {
                interrupted: 1,
                remaining: 0,
            }
        );
        let snapshot = supervisor.snapshot("quit", None).unwrap();
        assert_eq!(snapshot.record.status, ActivityStatus::Interrupted);
        assert_eq!(snapshot.record.updated_at, before_shutdown);
        assert_eq!(
            snapshot.record.session.unwrap().exit.unwrap().reason,
            SessionExitReason::Interrupted
        );

        drop(supervisor);
        let restarted = create_supervisor(&temp);
        let restored = restarted.snapshot("quit", None).unwrap();
        assert_eq!(restored.record.status, ActivityStatus::Interrupted);
        assert_eq!(restored.record.updated_at, before_shutdown);
    }

    #[cfg(unix)]
    #[test]
    fn attach_replays_existing_bytes_then_receives_new_events() {
        let temp = TempDir::new().unwrap();
        let supervisor = create_supervisor(&temp);
        let record = durable_record(
            "attach",
            "/bin/sh",
            vec![
                "-c".into(),
                "printf before; read line; printf -- '-%s-after' \"$line\"".into(),
            ],
        );
        supervisor
            .spawn(SpawnActivityRequest::new(record, 80, 24))
            .unwrap();

        let deadline = Instant::now() + Duration::from_secs(3);
        while !String::from_utf8_lossy(
            &supervisor
                .replay("attach", None)
                .unwrap()
                .chunks
                .iter()
                .flat_map(|chunk| chunk.bytes.iter().copied())
                .collect::<Vec<_>>(),
        )
        .contains("before")
        {
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(5));
        }

        let (event_tx, event_rx) = mpsc::channel();
        let attachment = supervisor
            .attach("attach", None, Arc::new(event_tx))
            .unwrap();
        assert!(String::from_utf8_lossy(&replay_bytes(&attachment.snapshot)).contains("before"));
        supervisor.write("attach", b"go\n".to_vec()).unwrap();

        let mut saw_after = false;
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if let Ok(ActivityEvent::Output { bytes, .. }) =
                event_rx.recv_timeout(Duration::from_millis(100))
            {
                if String::from_utf8_lossy(&bytes).contains("after") {
                    saw_after = true;
                    break;
                }
            }
        }
        assert!(saw_after);
        assert!(supervisor.unsubscribe(attachment.subscription_id));
        wait_for_end(&supervisor, "attach");
    }

    #[cfg(unix)]
    #[test]
    fn terminal_checkpoint_lease_rejects_stale_renderers_and_restores_the_winner() {
        let temp = TempDir::new().unwrap();
        let supervisor = create_supervisor(&temp);
        supervisor
            .spawn(SpawnActivityRequest::new(
                durable_record(
                    "checkpoint-lease",
                    "/bin/sh",
                    vec!["-c".into(), "printf state".into()],
                ),
                80,
                24,
            ))
            .unwrap();
        wait_for_end(&supervisor, "checkpoint-lease");
        supervisor.flush_persistence().unwrap();

        let stale = supervisor
            .terminal_attach("checkpoint-lease", "old-webview".into())
            .unwrap();
        let current = supervisor
            .terminal_attach("checkpoint-lease", "new-webview".into())
            .unwrap();
        let request = |attachment: &ActivityTerminalAttachment, owner_id: &str| {
            ActivityTerminalCheckpointRequest {
                activity_id: "checkpoint-lease".into(),
                run_id: attachment.run_id.clone(),
                owner_id: owner_id.into(),
                lease_generation: attachment.lease_generation,
                base_revision: attachment.revision,
                through_sequence: attachment.last_sequence,
                cols: 80,
                rows: 24,
                format_version: 1,
                engine_version: "6.0.0".into(),
                unicode_version: "11".into(),
                data: "serialized state".into(),
                search_text: "state".into(),
            }
        };
        assert!(supervisor
            .save_terminal_checkpoint(request(&stale, "old-webview"))
            .is_err());
        let saved = supervisor
            .save_terminal_checkpoint(request(&current, "new-webview"))
            .unwrap();
        assert_eq!(saved.revision, 1);

        let restored = supervisor
            .terminal_attach("checkpoint-lease", "third-webview".into())
            .unwrap();
        assert_eq!(restored.checkpoint.unwrap().data, "serialized state");
        assert!(restored.events.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn reconciles_failure_and_explicit_stop_reasons() {
        let temp = TempDir::new().unwrap();
        let supervisor = create_supervisor(&temp);
        let failed = durable_record("failed", "/bin/sh", vec!["-c".into(), "exit 7".into()]);
        supervisor
            .spawn(SpawnActivityRequest::new(failed, 80, 24))
            .unwrap();
        let failed = wait_for_end(&supervisor, "failed");
        let exit = failed.record.session.unwrap().exit.unwrap();
        assert_eq!(exit.reason, SessionExitReason::Failed);
        assert_eq!(exit.code, Some(7));

        let running = durable_record(
            "stopped",
            "/bin/sh",
            vec!["-c".into(), "while :; do sleep 1; done".into()],
        );
        supervisor
            .spawn(SpawnActivityRequest::new(running, 80, 24))
            .unwrap();
        supervisor.stop("stopped").unwrap();
        let stopped = wait_for_end(&supervisor, "stopped");
        assert_eq!(stopped.record.status, ActivityStatus::Stopped);
        assert_eq!(
            stopped.record.session.unwrap().exit.unwrap().reason,
            SessionExitReason::Stopped
        );
    }

    #[cfg(unix)]
    #[test]
    fn plain_terminal_starts_idle_and_remains_live_until_stopped() {
        let temp = TempDir::new().unwrap();
        let supervisor = create_supervisor(&temp);
        let mut terminal = durable_record(
            "terminal-idle",
            "/bin/sh",
            vec!["-c".into(), "while :; do sleep 1; done".into()],
        );
        terminal.kind = ActivityKind::Terminal;
        terminal.retention = ActivityRetention::Ephemeral;

        let spawned = supervisor
            .spawn(SpawnActivityRequest::new(terminal, 80, 24))
            .unwrap();

        assert_eq!(spawned.record.status, ActivityStatus::Idle);
        assert!(spawned.live);
        assert!(spawned
            .record
            .session
            .as_ref()
            .is_some_and(|session| session.exit.is_none()));

        supervisor.stop("terminal-idle").unwrap();
        let stopped = wait_for_end(&supervisor, "terminal-idle");
        assert_eq!(stopped.record.status, ActivityStatus::Stopped);
        assert!(!stopped.live);
    }

    #[cfg(unix)]
    #[test]
    fn agent_status_settles_during_silence_and_quit_is_interrupted() {
        let temp = TempDir::new().unwrap();
        let supervisor = create_supervisor(&temp);
        let running = durable_record(
            "quit",
            "/bin/sh",
            vec![
                "-c".into(),
                "printf '\\a'; while :; do sleep 1; done".into(),
            ],
        );
        supervisor
            .spawn(SpawnActivityRequest::new(running, 80, 24))
            .unwrap();

        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let snapshot = supervisor.snapshot("quit", None).unwrap();
            if snapshot.record.status == ActivityStatus::Idle
                && replay_bytes(&snapshot).contains(&0x07)
            {
                break;
            }
            assert!(Instant::now() < deadline, "agent did not settle to idle");
            thread::sleep(Duration::from_millis(10));
        }

        assert_eq!(supervisor.interrupt_all(), 1);
        let interrupted = wait_for_end(&supervisor, "quit");
        assert_eq!(interrupted.record.status, ActivityStatus::Interrupted);
        assert_eq!(
            interrupted.record.session.unwrap().exit.unwrap().reason,
            SessionExitReason::Interrupted
        );
    }

    #[cfg(unix)]
    #[test]
    fn respawn_reuses_the_ended_activity_identity_with_a_fresh_session() {
        let temp = TempDir::new().unwrap();
        let supervisor = create_supervisor(&temp);
        let first = durable_record(
            "resume",
            "/bin/sh",
            vec!["-c".into(), "printf first".into()],
        );
        let exact_session_id = "11111111-1111-4111-8111-111111111111".to_string();
        supervisor
            .spawn(
                SpawnActivityRequest::new(first, 80, 24)
                    .with_cli_session_id(Some(exact_session_id.clone())),
            )
            .unwrap();
        let ended = wait_for_end(&supervisor, "resume");
        assert!(String::from_utf8_lossy(&replay_bytes(&ended)).contains("first"));
        let first_session = ended.record.session.unwrap();
        assert_eq!(
            first_session.cli_session_id.as_deref(),
            Some(exact_session_id.as_str())
        );
        let first_run_id = first_session.run_id;
        supervisor.rename("resume", "Pinned resume title").unwrap();

        let mut again = durable_record(
            "resume",
            "/bin/sh",
            vec!["-c".into(), "printf second-run".into()],
        );
        again.created_at = "2027-01-01T00:00:00Z".into();
        again.title = "Codex".into();
        again.title_source = ActivityTitleSource::Launcher;
        let resumed = supervisor
            .respawn(SpawnActivityRequest::new(again, 80, 24))
            .unwrap();
        assert_eq!(resumed.record.created_at, "2026-07-25T00:00:00Z");
        assert_eq!(resumed.record.title, "Pinned resume title");
        assert_eq!(resumed.record.title_source, ActivityTitleSource::Manual);
        assert!(resumed.record.archived_at.is_none());
        let resumed_session = resumed.record.session.unwrap();
        assert_ne!(resumed_session.run_id, first_run_id);
        assert_eq!(
            resumed_session.cli_session_id.as_deref(),
            Some(exact_session_id.as_str())
        );

        let finished = wait_for_end(&supervisor, "resume");
        let replay = String::from_utf8_lossy(&replay_bytes(&finished)).to_string();
        assert!(replay.contains("second-run"));
        assert!(!replay.contains("first"));
        assert_ne!(finished.record.session.unwrap().run_id, first_run_id);
        assert_eq!(supervisor.list().len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn respawn_preserves_activity_time_until_submitted_input() {
        let temp = TempDir::new().unwrap();
        let supervisor = create_supervisor(&temp);
        let first = durable_record("resume-time", "/bin/sh", vec!["-c".into(), "true".into()]);
        supervisor
            .spawn(SpawnActivityRequest::new(first, 80, 24))
            .unwrap();
        let previous_time = wait_for_end(&supervisor, "resume-time").record.updated_at;

        let resumed = durable_record(
            "resume-time",
            "/bin/sh",
            vec![
                "-c".into(),
                "printf restored; IFS= read -r line; while :; do sleep 1; done".into(),
            ],
        );
        let snapshot = supervisor
            .respawn(SpawnActivityRequest::new(resumed, 80, 24))
            .unwrap();
        assert_eq!(snapshot.record.updated_at, previous_time);

        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let snapshot = supervisor.snapshot("resume-time", None).unwrap();
            if replay_bytes(&snapshot).starts_with(b"restored") {
                assert_eq!(snapshot.record.updated_at, previous_time);
                break;
            }
            assert!(
                Instant::now() < deadline,
                "restoration output never arrived"
            );
            thread::sleep(Duration::from_millis(10));
        }

        thread::sleep(Duration::from_millis(2));
        supervisor.write("resume-time", b"next turn\r").unwrap();
        let after_input = supervisor.snapshot("resume-time", None).unwrap();
        assert_ne!(after_input.record.updated_at, previous_time);
        assert!(after_input.live);

        supervisor.stop("resume-time").unwrap();
        wait_for_end(&supervisor, "resume-time");
    }

    #[cfg(unix)]
    #[test]
    fn respawn_rejects_missing_and_live_activities() {
        let temp = TempDir::new().unwrap();
        let supervisor = create_supervisor(&temp);
        let missing = durable_record("ghost", "/bin/sh", vec!["-c".into(), "true".into()]);
        assert!(matches!(
            supervisor.respawn(SpawnActivityRequest::new(missing, 80, 24)),
            Err(SupervisorError::NotFound(id)) if id == "ghost"
        ));

        let running = durable_record(
            "live",
            "/bin/sh",
            vec!["-c".into(), "while :; do sleep 1; done".into()],
        );
        supervisor
            .spawn(SpawnActivityRequest::new(running.clone(), 80, 24))
            .unwrap();
        assert!(matches!(
            supervisor.respawn(SpawnActivityRequest::new(running.clone(), 80, 24)),
            Err(SupervisorError::NotEnded {
                operation: "resumed",
                ..
            })
        ));

        supervisor.stop("live").unwrap();
        wait_for_end(&supervisor, "live");
        supervisor
            .respawn(SpawnActivityRequest::new(
                durable_record("live", "/bin/sh", vec!["-c".into(), "printf back".into()]),
                80,
                24,
            ))
            .unwrap();
        let finished = wait_for_end(&supervisor, "live");
        assert!(String::from_utf8_lossy(&replay_bytes(&finished)).contains("back"));
    }

    #[cfg(unix)]
    #[test]
    fn durable_output_hydrates_and_stale_live_state_becomes_interrupted() {
        let temp = TempDir::new().unwrap();
        let supervisor = create_supervisor(&temp);
        let record = durable_record(
            "persisted",
            "/bin/sh",
            vec!["-c".into(), "printf saved".into()],
        );
        supervisor
            .spawn(SpawnActivityRequest::new(record, 80, 24))
            .unwrap();
        let finished = wait_for_end(&supervisor, "persisted");
        supervisor.flush_persistence().unwrap();
        drop(supervisor);

        let hydrated = create_supervisor(&temp);
        let snapshot = hydrated.snapshot("persisted", None).unwrap();
        assert_eq!(snapshot.record.status, ActivityStatus::Done);
        assert_eq!(replay_bytes(&snapshot), replay_bytes(&finished));

        drop(hydrated);
        rewrite_stored_record(&temp, "persisted", |record| {
            record.status = ActivityStatus::Working;
            record.updated_at = "2026-07-25T09:30:00Z".into();
            record.session.as_mut().unwrap().exit = None;
            record.session.as_mut().unwrap().ended_at = None;
        });

        let restarted = create_supervisor(&temp);
        let snapshot = restarted.snapshot("persisted", None).unwrap();
        assert_eq!(snapshot.record.status, ActivityStatus::Interrupted);
        assert_eq!(snapshot.record.updated_at, "2026-07-25T09:30:00Z");
        assert_eq!(
            snapshot.record.session.unwrap().exit.unwrap().reason,
            SessionExitReason::Interrupted
        );
    }

    #[cfg(unix)]
    #[test]
    fn terminal_close_promotes_retention_and_survives_restart_as_archived() {
        let temp = TempDir::new().unwrap();
        let supervisor = create_supervisor(&temp);
        let mut record = durable_record(
            "close-intent",
            "/bin/sh",
            vec!["-c".into(), "while :; do sleep 1; done".into()],
        );
        record.kind = ActivityKind::Terminal;
        record.retention = ActivityRetention::Ephemeral;
        supervisor
            .spawn(SpawnActivityRequest::new(record, 80, 24))
            .unwrap();
        let (event_tx, event_rx) = mpsc::channel();
        supervisor.subscribe(Arc::new(event_tx));

        let requested = supervisor.request_close("close-intent").unwrap();
        assert_eq!(requested.retention, ActivityRetention::Durable);
        assert!(requested.close_requested_at.is_some());
        assert!(requested.archived_at.is_none());
        assert!(matches!(
            event_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            ActivityEvent::Upsert { record }
                if record.close_requested_at.is_some() && record.archived_at.is_none()
        ));

        let ended = wait_for_end(&supervisor, "close-intent");
        assert!(ended.record.close_requested_at.is_none());
        assert!(ended.record.archived_at.is_some());
        supervisor.flush_persistence().unwrap();

        drop(supervisor);
        rewrite_stored_record(&temp, "close-intent", |record| {
            record.status = ActivityStatus::Working;
            record.archived_at = None;
            record.close_requested_at = Some("2026-07-25T12:00:00Z".into());
            if let Some(session) = record.session.as_mut() {
                session.ended_at = None;
                session.exit = None;
            }
        });

        let restarted = create_supervisor(&temp);
        let recovered = restarted.snapshot("close-intent", None).unwrap();
        assert_eq!(
            recovered.record.archived_at.as_deref(),
            Some("2026-07-25T12:00:00Z")
        );
        assert!(recovered.record.close_requested_at.is_none());
        assert_eq!(recovered.record.status, ActivityStatus::Interrupted);
    }

    #[test]
    fn legacy_codex_recovery_requires_one_timestamp_and_workspace_match() {
        let temp = TempDir::new().unwrap();
        let sessions = temp.path().join("codex-sessions");
        let created_at = "2026-07-25T12:00:00Z";
        let created = DateTime::parse_from_rfc3339(created_at).unwrap();
        let date = created.with_timezone(&Local).date_naive();
        let directory = sessions
            .join(date.format("%Y").to_string())
            .join(date.format("%m").to_string())
            .join(date.format("%d").to_string());
        fs::create_dir_all(&directory).unwrap();
        let first_id = "11111111-1111-4111-8111-111111111111";
        fs::write(
            directory.join("rollout-one.jsonl"),
            format!(
                "{}\n",
                serde_json::json!({
                    "type": "session_meta",
                    "payload": {
                        "id": first_id,
                        "timestamp": "2026-07-25T12:00:01Z",
                        "cwd": "/work",
                    }
                })
            ),
        )
        .unwrap();

        let mut config = ActivitySupervisorConfig::new(temp.path().join("activities"));
        config.codex_sessions_dir = Some(sessions);
        let mut record = durable_record("legacy", "/bin/sh", vec![]);
        record.created_at = created_at.into();
        record.workspace_path = Some("/work".into());
        record.source.launcher_id = Some("codex".into());
        record.session = Some(ActivitySessionRecord {
            run_id: "run-one".into(),
            started_at: created_at.into(),
            ended_at: Some(created_at.into()),
            agent_id: None,
            cli_session_id: None,
            exit: None,
            last_output_sequence: 0,
            scrollback_bytes: 0,
        });

        assert!(recover_legacy_codex_session_id(&config, &mut record));
        assert_eq!(
            record.session.unwrap().cli_session_id.as_deref(),
            Some(first_id)
        );

        fs::write(
            directory.join("rollout-two.jsonl"),
            format!(
                "{}\n",
                serde_json::json!({
                    "type": "session_meta",
                    "payload": {
                        "id": "22222222-2222-4222-8222-222222222222",
                        "timestamp": "2026-07-25T12:00:02Z",
                        "cwd": "/work",
                    }
                })
            ),
        )
        .unwrap();
        let mut ambiguous = durable_record("ambiguous", "/bin/sh", vec![]);
        ambiguous.created_at = created_at.into();
        ambiguous.workspace_path = Some("/work".into());
        ambiguous.source.launcher_id = Some("codex".into());
        ambiguous.session = Some(ActivitySessionRecord {
            run_id: "run-two".into(),
            started_at: created_at.into(),
            ended_at: Some(created_at.into()),
            agent_id: None,
            cli_session_id: None,
            exit: None,
            last_output_sequence: 0,
            scrollback_bytes: 0,
        });
        assert!(!recover_legacy_codex_session_id(&config, &mut ambiguous));
        assert!(ambiguous.session.unwrap().cli_session_id.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn title_priority_is_launcher_then_provisional_then_manual() {
        let temp = TempDir::new().unwrap();
        let supervisor = create_supervisor(&temp);

        let mut automatic = durable_record(
            "automatic-title",
            "/bin/sh",
            vec!["-c".into(), "true".into()],
        );
        automatic.title_source = ActivityTitleSource::Launcher;
        supervisor
            .spawn(SpawnActivityRequest::new(automatic, 80, 24))
            .unwrap();
        wait_for_end(&supervisor, "automatic-title");

        let (event_tx, event_rx) = mpsc::channel();
        supervisor.subscribe(Arc::new(event_tx));
        let provisional = supervisor
            .provisional_title("automatic-title", "Restore Activity titles")
            .unwrap();
        assert_eq!(provisional.title, "Restore Activity titles");
        assert_eq!(provisional.title_source, ActivityTitleSource::Provisional);
        assert!(matches!(
            event_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            ActivityEvent::Upsert { record }
                if record.title == "Restore Activity titles"
                    && record.title_source == ActivityTitleSource::Provisional
        ));

        let ignored = supervisor
            .provisional_title("automatic-title", "Replace the generated title")
            .unwrap();
        assert_eq!(ignored.title, provisional.title);
        assert!(event_rx.recv_timeout(Duration::from_millis(20)).is_err());

        let mut explicit = durable_record(
            "explicit-title",
            "/bin/sh",
            vec!["-c".into(), "true".into()],
        );
        explicit.title_source = ActivityTitleSource::Launcher;
        supervisor
            .spawn(SpawnActivityRequest::new(explicit, 80, 24))
            .unwrap();
        wait_for_end(&supervisor, "explicit-title");
        supervisor.rename("explicit-title", "User title").unwrap();
        let protected = supervisor
            .provisional_title("explicit-title", "Provisional title")
            .unwrap();
        assert_eq!(protected.title, "User title");
        assert_eq!(protected.title_source, ActivityTitleSource::Manual);

        let renamed_again = supervisor
            .rename("explicit-title", "Later user title")
            .unwrap();
        assert_eq!(renamed_again.title, "Later user title");
        assert_eq!(renamed_again.title_source, ActivityTitleSource::Manual);
        let late_provisional = supervisor
            .provisional_title("explicit-title", "Late fallback")
            .unwrap();
        assert_eq!(late_provisional.title, "Later user title");
    }

    #[cfg(unix)]
    #[test]
    fn rename_archive_and_clear_are_ordered_durable_lifecycle_operations() {
        let temp = TempDir::new().unwrap();
        let supervisor = create_supervisor(&temp);
        let record = durable_record(
            "lifecycle",
            "/bin/sh",
            vec!["-c".into(), "printf durable-history".into()],
        );
        supervisor
            .spawn(SpawnActivityRequest::new(record, 80, 24))
            .unwrap();
        wait_for_end(&supervisor, "lifecycle");
        supervisor.flush_persistence().unwrap();

        let (event_tx, event_rx) = mpsc::channel();
        supervisor.subscribe(Arc::new(event_tx));

        let renamed = supervisor.rename("lifecycle", "  Review run  ").unwrap();
        assert_eq!(renamed.title, "Review run");
        assert!(matches!(
            event_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            ActivityEvent::Upsert { record } if record.title == "Review run"
        ));

        let archived = supervisor.set_archived("lifecycle", true).unwrap();
        assert!(archived.archived_at.is_some());
        assert!(matches!(
            event_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            ActivityEvent::Upsert { record } if record.archived_at.is_some()
        ));

        supervisor.flush_persistence().unwrap();
        drop(supervisor);

        let hydrated = create_supervisor(&temp);
        let restored = hydrated.snapshot("lifecycle", None).unwrap();
        assert_eq!(restored.record.title, "Review run");
        assert!(restored.record.archived_at.is_some());
        assert_eq!(replay_bytes(&restored), b"durable-history");

        let removed = hydrated.clear("lifecycle").unwrap();
        assert_eq!(removed.id, "lifecycle");
        assert!(hydrated.list().is_empty());
        assert!(!activity_persistence_path(temp.path(), "lifecycle").exists());
        drop(hydrated);

        assert!(create_supervisor(&temp).list().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn lifecycle_rejects_running_and_non_terminal_ephemeral_archives() {
        let temp = TempDir::new().unwrap();
        let supervisor = create_supervisor(&temp);
        let running = durable_record(
            "running-lifecycle",
            "/bin/sh",
            vec!["-c".into(), "while :; do sleep 1; done".into()],
        );
        supervisor
            .spawn(SpawnActivityRequest::new(running, 80, 24))
            .unwrap();

        assert!(matches!(
            supervisor.rename("running-lifecycle", "  "),
            Err(SupervisorError::EmptyTitle)
        ));
        assert!(matches!(
            supervisor.set_archived("running-lifecycle", true),
            Err(SupervisorError::NotEnded {
                operation: "archived",
                ..
            })
        ));
        assert!(matches!(
            supervisor.clear("running-lifecycle"),
            Err(SupervisorError::NotEnded {
                operation: "cleared",
                ..
            })
        ));
        supervisor.stop("running-lifecycle").unwrap();
        wait_for_end(&supervisor, "running-lifecycle");

        let mut ephemeral =
            durable_record("ephemeral", "/bin/sh", vec!["-c".into(), "true".into()]);
        ephemeral.retention = ActivityRetention::Ephemeral;
        supervisor
            .spawn(SpawnActivityRequest::new(ephemeral, 80, 24))
            .unwrap();
        wait_for_end(&supervisor, "ephemeral");
        assert!(matches!(
            supervisor.set_archived("ephemeral", true),
            Err(SupervisorError::NotDurable(id)) if id == "ephemeral"
        ));
        assert_eq!(supervisor.clear("ephemeral").unwrap().id, "ephemeral");

        let mut terminal = durable_record(
            "terminal-history",
            "/bin/sh",
            vec!["-c".into(), "true".into()],
        );
        terminal.kind = ActivityKind::Terminal;
        terminal.retention = ActivityRetention::Ephemeral;
        supervisor
            .spawn(SpawnActivityRequest::new(terminal, 80, 24))
            .unwrap();
        wait_for_end(&supervisor, "terminal-history");
        let archived = supervisor.set_archived("terminal-history", true).unwrap();
        assert_eq!(archived.retention, ActivityRetention::Durable);
        assert!(archived.archived_at.is_some());
        supervisor.flush_persistence().unwrap();
        assert!(ActivityStore::database_path(temp.path()).exists());
    }

    #[test]
    fn malformed_persistence_is_quarantined_without_blocking_startup() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("bad.activity.json");
        fs::write(&path, b"{definitely not json").unwrap();

        let supervisor = create_supervisor(&temp);
        assert!(supervisor.list().is_empty());
        let quarantined = supervisor.quarantined_files();
        assert_eq!(quarantined.len(), 1);
        assert!(quarantined[0].exists());
        assert!(!path.exists());
    }

    #[test]
    fn imported_legacy_source_is_not_parsed_again() {
        let temp = TempDir::new().unwrap();
        let path = activity_persistence_path(temp.path(), "legacy-marker");
        let mut record = durable_record("legacy-marker", "/bin/sh", vec![]);
        record.status = ActivityStatus::Done;
        let persisted = PersistedActivity {
            version: PERSISTED_VERSION,
            record,
            scrollback: PersistedScrollback {
                chunks: vec![OutputChunk {
                    sequence: 1,
                    bytes: b"legacy terminal state".to_vec(),
                }],
                next_sequence: 2,
                truncated: false,
            },
        };
        fs::write(&path, serde_json::to_vec(&persisted).unwrap()).unwrap();

        let supervisor = create_supervisor(&temp);
        assert_eq!(supervisor.list().len(), 1);
        assert_eq!(
            replay_bytes(&supervisor.snapshot("legacy-marker", None).unwrap()),
            b"legacy terminal state"
        );
        drop(supervisor);

        // The source stays for rollback. Its contents are no longer on the
        // startup path after the import marker commits.
        fs::write(&path, b"{not valid JSON anymore").unwrap();
        let restored = create_supervisor(&temp);
        assert_eq!(restored.list().len(), 1);
        assert!(restored.quarantined_files().is_empty());
        assert_eq!(fs::read(&path).unwrap(), b"{not valid JSON anymore");
        assert_eq!(restored.clear("legacy-marker").unwrap().id, "legacy-marker");
        assert!(!path.exists());
        drop(restored);
        assert!(create_supervisor(&temp).list().is_empty());
    }

    #[test]
    fn failed_legacy_file_delete_keeps_the_sqlite_activity() {
        let temp = TempDir::new().unwrap();
        let path = activity_persistence_path(temp.path(), "legacy-delete-failure");
        let mut record = durable_record("legacy-delete-failure", "/bin/sh", vec![]);
        record.status = ActivityStatus::Done;
        let persisted = PersistedActivity {
            version: PERSISTED_VERSION,
            record,
            scrollback: PersistedScrollback {
                chunks: Vec::new(),
                next_sequence: 1,
                truncated: false,
            },
        };
        fs::write(&path, serde_json::to_vec(&persisted).unwrap()).unwrap();
        let supervisor = create_supervisor(&temp);
        assert_eq!(supervisor.list().len(), 1);

        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(supervisor.clear("legacy-delete-failure").is_err());
        assert_eq!(supervisor.list().len(), 1);

        fs::remove_dir(&path).unwrap();
        drop(supervisor);
        let restored = create_supervisor(&temp);
        assert_eq!(restored.list().len(), 1);
        assert_eq!(restored.list()[0].id, "legacy-delete-failure");
    }
}
