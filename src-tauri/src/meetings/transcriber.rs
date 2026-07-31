//! Production transcription adapter over meeting-owned durable audio chunks.
//!
//! Capture is the authority: this module only reads atomic, one-second,
//! 16 kHz mono f32le files written below
//! `<meeting-id>/audio/{microphone,system}/`. The custom provider boundary is
//! the versioned `mimir.stt.v1` WebSocket contract. Local transcription is an
//! injected, owned runner and is unavailable unless that runner verifies both
//! its runtime and selected model; there is no simulated transcript and no
//! provider fallback.

use super::{
    config::CustomSttEndpoint,
    runtime::{MeetingTranscriptionPort, TranscriptionFinalize, TranscriptionStart},
    stt::{
        AudioEncoding, ClientMessage, NormalizedTranscriptBatch, SegmentState, ServerMessage,
        SttPreflightRequest, TranscriptAccumulator, TranscriptionOperation, WireId,
        STT_WIRE_CONTRACT,
    },
    AudioChunk, AudioChunkStatus, MeetingStore, TranscriptBatch, TranscriptChange,
    TranscriptRepairBegin, TranscriptSegmentInput,
};
use chrono::{SecondsFormat, Utc};
use futures_util::{future::BoxFuture, SinkExt, StreamExt};
use serde_json::json;
use sha2::{Digest, Sha256};
#[cfg(test)]
use std::time::Instant;
use std::{
    collections::{BTreeMap, HashMap},
    fs::{self, File, OpenOptions},
    io::{self, Read},
    net::SocketAddr,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, Sender, SyncSender},
        Arc, Mutex, MutexGuard,
    },
    thread,
    time::Duration,
};
use tokio::net::{lookup_host, TcpStream};
use tokio::time::{sleep, timeout};
use tokio_tungstenite::{
    client_async_tls_with_config,
    tungstenite::{
        client::IntoClientRequest,
        http::{header::AUTHORIZATION, HeaderValue},
        protocol::WebSocketConfig,
        Message,
    },
    Connector as WebSocketConnector,
};
use url::Url;

const SAMPLE_RATE_HZ: u32 = 16_000;
const CHANNELS: u8 = 2;
const BYTES_PER_SAMPLE: usize = size_of::<f32>();
const MAX_MONO_CHUNK_BYTES: usize = SAMPLE_RATE_HZ as usize * BYTES_PER_SAMPLE;
const MAX_INTERLEAVED_CHUNK_BYTES: usize = MAX_MONO_CHUNK_BYTES * CHANNELS as usize;
const MAX_PROVIDER_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const MAX_PROVIDER_FRAME_BYTES: usize = 4 * 1024 * 1024;
const MAX_DNS_ADDRESSES: usize = 16;
const DEFAULT_AUDIO_READ_CHUNKS: usize = 32;
const MAX_AUDIO_READ_CHUNKS: usize = 512;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const PROVIDER_RESPONSE_TIMEOUT: Duration = Duration::from_secs(8);
const AUDIO_POLL_INTERVAL: Duration = Duration::from_millis(100);
const MAX_CONNECT_ATTEMPTS: u8 = 5;
const MAX_INITIAL_CONNECT_ATTEMPTS: u8 = 2;
const BASE_RECONNECT_DELAY: Duration = Duration::from_millis(250);
const MAX_RECONNECT_DELAY: Duration = Duration::from_secs(4);
const START_READY_TIMEOUT: Duration = Duration::from_secs(30);

/// A selected provider. The runtime route is resolved once per recording and
/// reconnects are constrained to the resulting variant.
#[derive(Clone)]
pub enum ResolvedTranscriptionProvider {
    Local {
        model_id: String,
    },
    Custom {
        endpoint: CustomSttEndpoint,
        model: String,
    },
}

impl std::fmt::Debug for ResolvedTranscriptionProvider {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Local { model_id } => formatter
                .debug_struct("Local")
                .field("model_id", model_id)
                .finish(),
            Self::Custom { endpoint, model } => formatter
                .debug_struct("Custom")
                .field("endpoint", endpoint)
                .field("model", model)
                .finish(),
        }
    }
}

pub trait TranscriptionProviderResolver: Send + Sync {
    fn resolve(
        &self,
        request: &TranscriptionStart,
    ) -> Result<ResolvedTranscriptionProvider, String>;
}

/// Resolves the current runtime's compact `route` contract. `https://` is
/// accepted as a UI-friendly spelling and converted to `wss://` before the
/// strict endpoint validator runs.
pub struct RuntimeRouteResolver;

impl TranscriptionProviderResolver for RuntimeRouteResolver {
    fn resolve(
        &self,
        request: &TranscriptionStart,
    ) -> Result<ResolvedTranscriptionProvider, String> {
        if request.route == "local" {
            if request.model.trim().is_empty() {
                return Err("the selected local transcription model is empty".into());
            }
            return Ok(ResolvedTranscriptionProvider::Local {
                model_id: request.model.clone(),
            });
        }

        let mut parsed = Url::parse(&request.route)
            .map_err(|_| "the custom transcription URL is invalid".to_string())?;
        if parsed.scheme() == "https" {
            parsed
                .set_scheme("wss")
                .map_err(|_| "the custom transcription URL cannot be converted to wss")?;
        }
        let approved_host = parsed
            .host_str()
            .ok_or_else(|| "the custom transcription URL has no host".to_string())?
            .to_string();
        let endpoint = CustomSttEndpoint::new(parsed.as_str(), &approved_host)
            .map_err(|error| error.to_string())?;
        if request.model.trim().is_empty() {
            return Err("the custom transcription model is empty".into());
        }
        Ok(ResolvedTranscriptionProvider::Custom {
            endpoint,
            model: request.model.clone(),
        })
    }
}

/// Resolves a credential inside the native process. Implementations must never
/// put the returned value into diagnostics, IPC, or persisted configuration.
pub trait MeetingCredentialResolver: Send + Sync {
    fn bearer_token(&self, endpoint: &CustomSttEndpoint) -> Result<Option<String>, String>;
}

/// Notification seam for durable live transcript revisions. Capture and STT
/// remain renderer-independent; the Tauri adapter coalesces this signal into
/// an authoritative snapshot refresh.
pub trait TranscriptionChangeSink: Send + Sync {
    fn changed(&self, meeting_id: &str);
}

pub struct NoopTranscriptionChangeSink;

impl TranscriptionChangeSink for NoopTranscriptionChangeSink {
    fn changed(&self, _meeting_id: &str) {}
}

pub struct NoMeetingCredential;

impl MeetingCredentialResolver for NoMeetingCredential {
    fn bearer_token(&self, _endpoint: &CustomSttEndpoint) -> Result<Option<String>, String> {
        Ok(None)
    }
}

/// Evidence returned only after a local runner verifies an owned executable,
/// its version, and the exact model artifact.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedLocalRuntime {
    pub runtime_id: String,
    pub runtime_version: String,
    pub model_sha256: String,
}

/// Context for a real local runner. The runner reads the same durable chunks
/// as the custom transport and emits only normalized provider batches.
pub struct LocalTranscriptionContext<'a> {
    pub meeting_id: &'a str,
    pub run_id: &'a str,
    pub model_id: &'a str,
    pub audio: &'a PersistedAudioSource,
    pub finalize: &'a Receiver<LocalFinalizeCommand>,
    pub sink: &'a mut dyn NormalizedBatchSink,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalFinalizeCommand {
    pub observed_at: String,
}

pub trait LocalTranscriber: Send + Sync {
    fn verify(&self, model_id: &str) -> Result<VerifiedLocalRuntime, String>;

    /// Runs until `context.finalize` receives a command. A successful silent
    /// run may emit no segments; any emitted partial must still be resolved.
    fn run(&self, context: LocalTranscriptionContext<'_>) -> Result<(), String>;
}

/// Honest default when no verified whisper runtime is installed.
pub struct UnavailableLocalTranscriber;

impl LocalTranscriber for UnavailableLocalTranscriber {
    fn verify(&self, model_id: &str) -> Result<VerifiedLocalRuntime, String> {
        Err(format!(
            "local transcription model '{model_id}' is unavailable or its runtime has not been verified"
        ))
    }

    fn run(&self, _context: LocalTranscriptionContext<'_>) -> Result<(), String> {
        Err("local transcription cannot run without a verified owned runtime".into())
    }
}

pub trait NormalizedBatchSink {
    fn ingest(&mut self, batch: NormalizedTranscriptBatch) -> Result<(), String>;
    fn final_segment_count(&self) -> u64;
}

struct TranscriptionSession {
    finalize: Sender<FinalizeCommand>,
    worker: thread::JoinHandle<Result<WorkerCompletion, String>>,
}

#[derive(Debug, Clone)]
struct FinalizeCommand {
    observed_at: String,
}

struct WorkerCompletion {
    source: String,
    unresolved_partial_count: usize,
}

pub struct NativeMeetingTranscriber {
    store: Arc<MeetingStore>,
    data_dir: PathBuf,
    provider_resolver: Arc<dyn TranscriptionProviderResolver>,
    credential_resolver: Arc<dyn MeetingCredentialResolver>,
    local: Arc<dyn LocalTranscriber>,
    changes: Arc<dyn TranscriptionChangeSink>,
    sessions: Mutex<HashMap<String, TranscriptionSession>>,
    startup_cleanup_pending: Arc<AtomicBool>,
}

impl NativeMeetingTranscriber {
    pub fn new(
        store: Arc<MeetingStore>,
        data_dir: impl Into<PathBuf>,
        provider_resolver: Arc<dyn TranscriptionProviderResolver>,
        credential_resolver: Arc<dyn MeetingCredentialResolver>,
        local: Arc<dyn LocalTranscriber>,
        changes: Arc<dyn TranscriptionChangeSink>,
    ) -> Result<Self, String> {
        let data_dir = data_dir.into();
        fs::create_dir_all(&data_dir)
            .map_err(|error| format!("could not create meeting audio directory: {error}"))?;
        Ok(Self {
            store,
            data_dir,
            provider_resolver,
            credential_resolver,
            local,
            changes,
            sessions: Mutex::new(HashMap::new()),
            startup_cleanup_pending: Arc::new(AtomicBool::new(false)),
        })
    }

    pub fn with_unavailable_local(
        store: Arc<MeetingStore>,
        data_dir: impl Into<PathBuf>,
        credential_resolver: Arc<dyn MeetingCredentialResolver>,
    ) -> Result<Self, String> {
        Self::new(
            store,
            data_dir,
            Arc::new(RuntimeRouteResolver),
            credential_resolver,
            Arc::new(UnavailableLocalTranscriber),
            Arc::new(NoopTranscriptionChangeSink),
        )
    }

    fn sessions(&self) -> Result<MutexGuard<'_, HashMap<String, TranscriptionSession>>, String> {
        self.sessions
            .lock()
            .map_err(|_| "meeting transcription session mutex was poisoned".into())
    }
}

impl MeetingTranscriptionPort for NativeMeetingTranscriber {
    fn start(&self, request: &TranscriptionStart) -> Result<(), String> {
        let mut sessions = self.sessions()?;
        if self.startup_cleanup_pending.load(Ordering::Acquire) {
            return Err(
                "a timed-out transcription startup is still being reclaimed; retry after it exits"
                    .into(),
            );
        }
        if sessions.contains_key(&request.meeting_id) {
            return Err(format!(
                "meeting '{}' already owns a transcription worker",
                request.meeting_id
            ));
        }
        if let Some(capture_generation) = request.repair_generation.as_deref() {
            match self
                .store
                .begin_transcript_repair(
                    &request.meeting_id,
                    capture_generation,
                    &request.run_id,
                    &now(),
                )
                .map_err(|error| error.to_string())?
            {
                TranscriptRepairBegin::Collecting => {}
                TranscriptRepairBegin::AlreadyCommitted { revision } => {
                    return Err(format!(
                        "transcript repair generation was already committed at revision {revision}"
                    ));
                }
            }
        }
        let provider = self.provider_resolver.resolve(request)?;

        let (finalize_tx, finalize_rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let worker_request = request.clone();
        let store = Arc::clone(&self.store);
        let data_dir = self.data_dir.clone();
        let credentials = Arc::clone(&self.credential_resolver);
        let local = Arc::clone(&self.local);
        let changes = Arc::clone(&self.changes);
        let thread_name = format!("mimir-stt-{}", request.meeting_id);
        let worker = thread::Builder::new()
            .name(thread_name)
            .spawn(move || {
                let startup_error = ready_tx.clone();
                let result = run_worker(
                    store,
                    data_dir,
                    worker_request,
                    provider,
                    credentials,
                    local,
                    changes,
                    finalize_rx,
                    ready_tx,
                );
                if let Err(message) = &result {
                    // This succeeds only while the caller is still waiting for
                    // startup. Once Ready was consumed, the receiver is gone
                    // and a later runtime failure cannot masquerade as a
                    // second startup outcome.
                    let _ = startup_error.try_send(Err(message.clone()));
                }
                result
            })
            .map_err(|error| format!("could not spawn transcription worker: {error}"))?;

        match ready_rx.recv_timeout(START_READY_TIMEOUT) {
            Ok(Ok(())) => {
                sessions.insert(
                    request.meeting_id.clone(),
                    TranscriptionSession {
                        finalize: finalize_tx,
                        worker,
                    },
                );
                Ok(())
            }
            Ok(Err(message)) => {
                let _ = finalize_tx.send(FinalizeCommand { observed_at: now() });
                drop(ready_rx);
                reap_transcription_startup(
                    "meeting transcription startup",
                    worker,
                    Arc::clone(&self.startup_cleanup_pending),
                );
                Err(message)
            }
            Err(error) => {
                let _ = finalize_tx.send(FinalizeCommand { observed_at: now() });
                drop(ready_rx);
                reap_transcription_startup(
                    "timed-out meeting transcription startup",
                    worker,
                    Arc::clone(&self.startup_cleanup_pending),
                );
                Err(format!(
                    "transcription provider did not become ready within {} seconds: {error}",
                    START_READY_TIMEOUT.as_secs()
                ))
            }
        }
    }

    fn finalize(&self, request: &TranscriptionFinalize) -> Result<TranscriptBatch, String> {
        let session = self
            .sessions()?
            .remove(&request.meeting_id)
            .ok_or_else(|| {
                format!(
                    "meeting '{}' has no live transcription worker; delayed repair is required",
                    request.meeting_id
                )
            })?;
        session
            .finalize
            .send(FinalizeCommand {
                observed_at: request.observed_at.clone(),
            })
            .map_err(|_| "transcription worker stopped before finalization".to_string())?;
        let completion = session
            .worker
            .join()
            .map_err(|_| "transcription worker panicked".to_string())??;
        if completion.unresolved_partial_count != 0 {
            return Err(format!(
                "transcription provider completed with {} unresolved partial segment(s); delayed repair is required",
                completion.unresolved_partial_count
            ));
        }

        // Live provider batches advance this value. Reading it after the worker
        // joins makes the terminal marker linearizable with those durable
        // revisions.
        let base_revision = self
            .store
            .get_meeting(&request.meeting_id)
            .map_err(|error| error.to_string())?
            .transcript_revision;
        Ok(TranscriptBatch {
            meeting_id: request.meeting_id.clone(),
            batch_id: format!(
                "{}:terminal:{}",
                sanitize_wire_component(&request.run_id),
                base_revision
            ),
            base_revision,
            source: completion.source,
            observed_at: request.observed_at.clone(),
            marks_final: true,
            changes: Vec::new(),
        })
    }
}

#[allow(clippy::too_many_arguments)]
fn run_worker(
    store: Arc<MeetingStore>,
    data_dir: PathBuf,
    request: TranscriptionStart,
    provider: ResolvedTranscriptionProvider,
    credentials: Arc<dyn MeetingCredentialResolver>,
    local: Arc<dyn LocalTranscriber>,
    changes: Arc<dyn TranscriptionChangeSink>,
    finalize: Receiver<FinalizeCommand>,
    ready: SyncSender<Result<(), String>>,
) -> Result<WorkerCompletion, String> {
    let audio =
        PersistedAudioSource::authoritative(Arc::clone(&store), data_dir, &request.meeting_id)?;
    let source = match &provider {
        ResolvedTranscriptionProvider::Local { .. } => "local",
        ResolvedTranscriptionProvider::Custom { .. } => "custom",
    };
    let mut sink = StoreBatchSink::new(
        Arc::clone(&store),
        &request.meeting_id,
        &request.run_id,
        source,
        request.repair_generation.as_deref(),
        changes,
    )?;

    match provider {
        ResolvedTranscriptionProvider::Local { model_id } => {
            // Verification can hash a large artifact and probe the native
            // runtime. Keep it inside the bounded startup worker so a blocked
            // filesystem/runtime cannot pin the serialized meeting runtime.
            local.verify(&model_id)?;
            ready
                .send(Ok(()))
                .map_err(|_| "transcription caller stopped during local startup".to_string())?;
            let (local_tx, local_rx) = mpsc::channel();
            let bridge = thread::Builder::new()
                .name(format!("mimir-stt-finalize-{}", request.meeting_id))
                .spawn(move || {
                    if let Ok(command) = finalize.recv() {
                        let _ = local_tx.send(LocalFinalizeCommand {
                            observed_at: command.observed_at,
                        });
                    }
                })
                .map_err(|error| format!("could not start local finalization bridge: {error}"))?;
            let run_result = local.run(LocalTranscriptionContext {
                meeting_id: &request.meeting_id,
                run_id: &request.run_id,
                model_id: &model_id,
                audio: &audio,
                finalize: &local_rx,
                sink: &mut sink,
            });
            let _ = bridge.join();
            run_result?;
        }
        ResolvedTranscriptionProvider::Custom { endpoint, model } => {
            let credential = resolve_custom_credential(credentials.as_ref(), &endpoint)?;
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|error| format!("could not initialize transcription runtime: {error}"))?;
            runtime.block_on(run_custom(
                CustomRunContext {
                    request: &request,
                    endpoint: &endpoint,
                    model: &model,
                    credential: credential.as_deref(),
                    audio: &audio,
                    finalize: &finalize,
                    ready: &ready,
                },
                &mut sink,
            ))?;
        }
    }
    Ok(WorkerCompletion {
        source: source.into(),
        unresolved_partial_count: sink.accumulator.unresolved_partial_count(),
    })
}

fn reap_transcription_startup<T: Send + 'static>(
    label: &'static str,
    worker: thread::JoinHandle<T>,
    pending: Arc<AtomicBool>,
) {
    pending.store(true, Ordering::Release);
    let reaper_pending = Arc::clone(&pending);
    if let Err(error) = thread::Builder::new()
        .name("mimir-stt-startup-reaper".into())
        .spawn(move || {
            if worker.join().is_err() {
                log::error!("{label} panicked while being reclaimed");
            }
            reaper_pending.store(false, Ordering::Release);
        })
    {
        log::error!("Could not reclaim {label} in the background: {error}");
    }
}

fn resolve_custom_credential(
    resolver: &dyn MeetingCredentialResolver,
    endpoint: &CustomSttEndpoint,
) -> Result<Option<String>, String> {
    resolver
        .bearer_token(endpoint)
        .map_err(|_| "could not resolve custom transcription credential".to_string())
}

#[derive(Clone, PartialEq, Eq)]
pub struct PersistedAudioChunk {
    pub sequence: u64,
    pub start_ms: u64,
    pub end_ms: u64,
    pub bytes: Vec<u8>,
}

impl std::fmt::Debug for PersistedAudioChunk {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PersistedAudioChunk")
            .field("sequence", &self.sequence)
            .field("start_ms", &self.start_ms)
            .field("end_ms", &self.end_ms)
            .field("audio", &format_args!("[{} bytes]", self.bytes.len()))
            .finish()
    }
}

enum AudioAuthority {
    CommittedStore(Arc<MeetingStore>),
    #[cfg(test)]
    FixtureDirectory,
}

enum AuthorizedAudioChunk {
    Committed(Box<AudioChunk>),
    #[cfg(test)]
    Fixture {
        path: PathBuf,
    },
}

/// Safe reader for capture-owned channel files.
///
/// Production construction requires a [`MeetingStore`]. SQLite's committed
/// rows are the only authority for which files may cross the STT boundary;
/// directory contents are never discovered or trusted.
pub struct PersistedAudioSource {
    root: PathBuf,
    meeting_id: String,
    authority: AudioAuthority,
}

impl PersistedAudioSource {
    pub(crate) fn authoritative(
        store: Arc<MeetingStore>,
        data_dir: impl Into<PathBuf>,
        meeting_id: &str,
    ) -> Result<Self, String> {
        validate_path_component(meeting_id, "meeting id")?;
        Ok(Self {
            root: data_dir.into(),
            meeting_id: meeting_id.into(),
            authority: AudioAuthority::CommittedStore(store),
        })
    }

    /// Raw fixture construction exists only for isolated local-whisper unit
    /// tests. It is absent from production builds and cannot be reached by a
    /// runtime provider.
    #[cfg(test)]
    pub fn new(data_dir: impl Into<PathBuf>, meeting_id: &str) -> Result<Self, String> {
        validate_path_component(meeting_id, "meeting id")?;
        Ok(Self {
            root: data_dir.into(),
            meeting_id: meeting_id.into(),
            authority: AudioAuthority::FixtureDirectory,
        })
    }

    pub fn paired_chunks_from(
        &self,
        first_sequence: u64,
    ) -> Result<Vec<PersistedAudioChunk>, String> {
        self.paired_chunks_from_bounded(first_sequence, DEFAULT_AUDIO_READ_CHUNKS)
    }

    pub fn paired_chunks_from_bounded(
        &self,
        first_sequence: u64,
        maximum_chunks: usize,
    ) -> Result<Vec<PersistedAudioChunk>, String> {
        self.chunks_from(first_sequence, false, maximum_chunks)
    }

    /// Returns every durable final chunk. A channel that ended one partial
    /// chunk earlier is padded with silence only in the provider projection;
    /// its source file is never changed.
    pub fn final_chunks_from(
        &self,
        first_sequence: u64,
    ) -> Result<Vec<PersistedAudioChunk>, String> {
        self.final_chunks_from_bounded(first_sequence, DEFAULT_AUDIO_READ_CHUNKS)
    }

    pub fn final_chunks_from_bounded(
        &self,
        first_sequence: u64,
        maximum_chunks: usize,
    ) -> Result<Vec<PersistedAudioChunk>, String> {
        self.chunks_from(first_sequence, true, maximum_chunks)
    }

    fn chunks_from(
        &self,
        first_sequence: u64,
        include_unpaired_final_chunks: bool,
        maximum_chunks: usize,
    ) -> Result<Vec<PersistedAudioChunk>, String> {
        if maximum_chunks == 0 || maximum_chunks > MAX_AUDIO_READ_CHUNKS {
            return Err(format!(
                "audio reads must request between 1 and {MAX_AUDIO_READ_CHUNKS} chunks"
            ));
        }
        let microphone =
            self.authorized_channel_chunks("microphone", first_sequence, maximum_chunks)?;
        let system = self.authorized_channel_chunks("system", first_sequence, maximum_chunks)?;
        let mut result = Vec::new();
        let mut sequence = first_sequence;
        while result.len() < maximum_chunks {
            let microphone_chunk = microphone.get(&sequence);
            let system_chunk = system.get(&sequence);
            match (microphone_chunk, system_chunk) {
                (None, None) => break,
                (Some(_), Some(_)) => {}
                _ if include_unpaired_final_chunks => {}
                _ => break,
            }
            // A missing final channel is projected as silence only after the
            // other channel has been authorized and read. No synthetic file
            // or database row is created.
            let microphone_bytes = microphone_chunk
                .map(|chunk| self.read_authorized_chunk(chunk))
                .transpose()?
                .unwrap_or_default();
            let system_bytes = system_chunk
                .map(|chunk| self.read_authorized_chunk(chunk))
                .transpose()?
                .unwrap_or_default();
            let bytes = interleave_f32le(&microphone_bytes, &system_bytes)?;
            let sample_count = bytes.len() / BYTES_PER_SAMPLE / CHANNELS as usize;
            let start_ms = sequence.saturating_mul(1_000);
            let duration_ms = (sample_count as u64).saturating_mul(1_000) / SAMPLE_RATE_HZ as u64;
            result.push(PersistedAudioChunk {
                sequence,
                start_ms,
                end_ms: start_ms.saturating_add(duration_ms.max(1)),
                bytes,
            });
            sequence = sequence
                .checked_add(1)
                .ok_or_else(|| "audio chunk sequence overflow".to_string())?;
        }
        Ok(result)
    }

    fn authorized_channel_chunks(
        &self,
        channel: &str,
        first_sequence: u64,
        maximum_chunks: usize,
    ) -> Result<BTreeMap<u64, AuthorizedAudioChunk>, String> {
        validate_path_component(channel, "audio channel")?;
        match &self.authority {
            AudioAuthority::CommittedStore(store) => {
                let chunks = store
                    .committed_audio_chunks(
                        &self.meeting_id,
                        channel,
                        first_sequence,
                        maximum_chunks as u32,
                    )
                    .map_err(|error| error.to_string())?
                    .into_iter()
                    .map(|chunk| {
                        let sequence = chunk.definition.sequence;
                        (sequence, AuthorizedAudioChunk::Committed(Box::new(chunk)))
                    })
                    .collect::<BTreeMap<_, _>>();
                Ok(chunks)
            }
            #[cfg(test)]
            AudioAuthority::FixtureDirectory => {
                self.fixture_channel_chunks(channel, first_sequence, maximum_chunks)
            }
        }
    }

    fn read_authorized_chunk(&self, chunk: &AuthorizedAudioChunk) -> Result<Vec<u8>, String> {
        match chunk {
            AuthorizedAudioChunk::Committed(chunk) => {
                read_committed_mono_chunk(&self.root, &self.meeting_id, chunk)
            }
            #[cfg(test)]
            AuthorizedAudioChunk::Fixture { path, .. } => read_fixture_mono_chunk(path),
        }
    }

    #[cfg(test)]
    fn fixture_channel_chunks(
        &self,
        channel: &str,
        first_sequence: u64,
        _maximum_chunks: usize,
    ) -> Result<BTreeMap<u64, AuthorizedAudioChunk>, String> {
        let directory = self.root.join(&self.meeting_id).join("audio").join(channel);
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
            Err(error) => {
                return Err(format!(
                    "could not inspect durable {channel} audio chunks: {error}"
                ))
            }
        };
        let mut chunks = BTreeMap::new();
        for entry in entries {
            let entry = entry.map_err(|error| format!("could not inspect audio chunk: {error}"))?;
            let file_type = entry
                .file_type()
                .map_err(|error| format!("could not inspect audio chunk type: {error}"))?;
            if !file_type.is_file() {
                continue;
            }
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                return Err("audio chunk filename is not valid UTF-8".into());
            };
            let Some(stem) = name.strip_suffix(".f32le") else {
                continue;
            };
            if stem.len() != 8 || !stem.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err(
                    "audio chunk filename does not use the canonical sequence format".into(),
                );
            }
            let sequence = stem
                .parse::<u64>()
                .map_err(|_| "audio chunk sequence is invalid".to_string())?;
            if sequence < first_sequence {
                continue;
            }
            if chunks
                .insert(
                    sequence,
                    AuthorizedAudioChunk::Fixture { path: entry.path() },
                )
                .is_some()
            {
                return Err(format!(
                    "durable {channel} audio contains duplicate sequence {sequence}"
                ));
            }
        }
        Ok(chunks)
    }
}

fn read_committed_mono_chunk(
    root: &Path,
    meeting_id: &str,
    chunk: &AudioChunk,
) -> Result<Vec<u8>, String> {
    let definition = &chunk.definition;
    if chunk.status != AudioChunkStatus::Committed
        || chunk.committed_at.is_none()
        || chunk.integrity_error.is_some()
    {
        return Err("audio chunk is not a healthy committed database record".into());
    }
    if definition.meeting_id != meeting_id {
        return Err("audio chunk database authority belongs to another meeting".into());
    }
    validate_path_component(&definition.channel_id, "audio channel")?;
    let canonical_relative_path = format!(
        "{meeting_id}/audio/{}/{:08}.f32le",
        definition.channel_id, definition.sequence
    );
    if definition.relative_path != canonical_relative_path {
        return Err("audio chunk database path is not canonical".into());
    }
    let expected_byte_len = definition
        .sample_count
        .checked_mul(BYTES_PER_SAMPLE as u64)
        .ok_or_else(|| "audio chunk byte length overflow".to_string())?;
    if definition.byte_len != expected_byte_len
        || definition.byte_len == 0
        || definition.byte_len > MAX_MONO_CHUNK_BYTES as u64
    {
        return Err("audio chunk database length is invalid".into());
    }
    let expected_start_ms = definition
        .sequence
        .checked_mul(1_000)
        .ok_or_else(|| "audio chunk timestamp overflow".to_string())?;
    let expected_duration_ms = definition
        .sample_count
        .checked_mul(1_000)
        .ok_or_else(|| "audio chunk duration overflow".to_string())?
        / SAMPLE_RATE_HZ as u64;
    let expected_end_ms = expected_start_ms
        .checked_add(expected_duration_ms.max(1))
        .ok_or_else(|| "audio chunk timestamp overflow".to_string())?;
    if u64::try_from(definition.start_ms).ok() != Some(expected_start_ms)
        || u64::try_from(definition.end_ms).ok() != Some(expected_end_ms)
    {
        return Err("audio chunk database timestamps are invalid".into());
    }
    if definition.sha256.len() != 64
        || !definition
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("audio chunk database digest is invalid".into());
    }

    let mut file = open_committed_chunk_no_follow(
        root,
        meeting_id,
        &definition.channel_id,
        definition.sequence,
    )?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("could not inspect committed audio chunk: {error}"))?;
    if !metadata.is_file() || metadata.len() != definition.byte_len {
        return Err("committed audio chunk is not a regular file of the recorded length".into());
    }
    let read_limit = definition
        .byte_len
        .checked_add(1)
        .ok_or_else(|| "audio chunk read limit overflow".to_string())?;
    let mut bytes = Vec::with_capacity(definition.byte_len as usize);
    file.by_ref()
        .take(read_limit)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("could not read committed audio chunk: {error}"))?;
    if bytes.len() as u64 != definition.byte_len {
        return Err("committed audio chunk changed while it was being read".into());
    }
    let digest = format!("{:x}", Sha256::digest(&bytes));
    if !digest.eq_ignore_ascii_case(&definition.sha256) {
        return Err("committed audio chunk failed its database SHA-256 check".into());
    }
    Ok(bytes)
}

#[cfg(test)]
fn read_fixture_mono_chunk(path: &Path) -> Result<Vec<u8>, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("could not inspect durable audio chunk: {error}"))?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err("durable audio chunk is not a regular file".into());
    }
    let length = usize::try_from(metadata.len())
        .map_err(|_| "durable audio chunk is too large for this platform".to_string())?;
    if length == 0 || length > MAX_MONO_CHUNK_BYTES || length % BYTES_PER_SAMPLE != 0 {
        return Err("durable audio chunk has an invalid f32le length".into());
    }
    let bytes = fs::read(path).map_err(|error| format!("could not read durable audio: {error}"))?;
    if bytes.len() != length {
        return Err("durable audio chunk changed while it was being read".into());
    }
    Ok(bytes)
}

#[cfg(unix)]
fn open_committed_chunk_no_follow(
    root: &Path,
    meeting_id: &str,
    channel_id: &str,
    sequence: u64,
) -> Result<File, String> {
    use std::{
        ffi::CString,
        os::{
            fd::{AsRawFd, FromRawFd},
            raw::{c_char, c_int},
            unix::fs::OpenOptionsExt,
        },
    };

    #[cfg(target_os = "macos")]
    const O_DIRECTORY: c_int = 0x0010_0000;
    #[cfg(target_os = "macos")]
    const O_NOFOLLOW: c_int = 0x0000_0100;
    #[cfg(target_os = "macos")]
    const O_CLOEXEC: c_int = 0x0100_0000;
    #[cfg(not(target_os = "macos"))]
    const O_DIRECTORY: c_int = 0x0001_0000;
    #[cfg(not(target_os = "macos"))]
    const O_NOFOLLOW: c_int = 0x0002_0000;
    #[cfg(not(target_os = "macos"))]
    const O_CLOEXEC: c_int = 0x0008_0000;
    const O_RDONLY: c_int = 0;

    unsafe extern "C" {
        fn openat(directory_fd: c_int, path: *const c_char, flags: c_int, ...) -> c_int;
    }

    fn child(parent: &File, name: &str, flags: c_int, kind: &str) -> Result<File, String> {
        let name = CString::new(name)
            .map_err(|_| format!("committed audio {kind} contains a NUL byte"))?;
        // SAFETY: `parent` remains open for this call, `name` is a valid
        // NUL-terminated C string, and no creation flag requiring a mode is
        // passed. Ownership of a successful descriptor moves into `File`.
        let descriptor = unsafe { openat(parent.as_raw_fd(), name.as_ptr(), flags) };
        if descriptor < 0 {
            return Err(format!(
                "could not open committed audio {kind} without following links: {}",
                io::Error::last_os_error()
            ));
        }
        // SAFETY: `openat` returned a fresh owned descriptor above.
        Ok(unsafe { File::from_raw_fd(descriptor) })
    }

    let mut options = OpenOptions::new();
    options
        .read(true)
        .custom_flags(O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    let root = options.open(root).map_err(|error| {
        format!("could not open committed audio root without following links: {error}")
    })?;
    let directory_flags = O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC;
    let meeting = child(&root, meeting_id, directory_flags, "meeting directory")?;
    let audio = child(&meeting, "audio", directory_flags, "audio directory")?;
    let channel = child(&audio, channel_id, directory_flags, "channel directory")?;
    child(
        &channel,
        &format!("{sequence:08}.f32le"),
        O_RDONLY | O_NOFOLLOW | O_CLOEXEC,
        "chunk",
    )
}

#[cfg(not(unix))]
fn open_committed_chunk_no_follow(
    _root: &Path,
    _meeting_id: &str,
    _channel_id: &str,
    _sequence: u64,
) -> Result<File, String> {
    Err("secure committed audio reads are unavailable on this platform".into())
}

fn interleave_f32le(microphone: &[u8], system: &[u8]) -> Result<Vec<u8>, String> {
    if !microphone.len().is_multiple_of(BYTES_PER_SAMPLE)
        || !system.len().is_multiple_of(BYTES_PER_SAMPLE)
    {
        return Err("audio channel is not aligned to f32le samples".into());
    }
    let samples = (microphone.len().max(system.len())) / BYTES_PER_SAMPLE;
    let output_len = samples
        .checked_mul(CHANNELS as usize)
        .and_then(|count| count.checked_mul(BYTES_PER_SAMPLE))
        .ok_or_else(|| "interleaved audio frame size overflow".to_string())?;
    if output_len > MAX_INTERLEAVED_CHUNK_BYTES {
        return Err("interleaved audio frame exceeds the protocol limit".into());
    }
    let silence = 0_f32.to_le_bytes();
    let mut output = Vec::with_capacity(output_len);
    for index in 0..samples {
        for channel in [microphone, system] {
            let offset = index * BYTES_PER_SAMPLE;
            if let Some(sample) = channel.get(offset..offset + BYTES_PER_SAMPLE) {
                output.extend_from_slice(sample);
            } else {
                output.extend_from_slice(&silence);
            }
        }
    }
    Ok(output)
}

struct StoreBatchSink {
    store: Arc<MeetingStore>,
    meeting_id: String,
    provider_run_id: String,
    source: String,
    repair_generation: Option<String>,
    accumulator: TranscriptAccumulator,
    final_segment_count: u64,
    changes: Arc<dyn TranscriptionChangeSink>,
}

impl StoreBatchSink {
    fn new(
        store: Arc<MeetingStore>,
        meeting_id: &str,
        provider_run_id: &str,
        source: &str,
        repair_generation: Option<&str>,
        changes: Arc<dyn TranscriptionChangeSink>,
    ) -> Result<Self, String> {
        WireId::new(meeting_id.to_string()).map_err(|error| error.to_string())?;
        WireId::new(provider_run_id.to_string()).map_err(|error| error.to_string())?;
        Ok(Self {
            store,
            meeting_id: meeting_id.into(),
            provider_run_id: provider_run_id.into(),
            source: source.into(),
            repair_generation: repair_generation.map(str::to_string),
            accumulator: TranscriptAccumulator::default(),
            final_segment_count: 0,
            changes,
        })
    }
}

impl NormalizedBatchSink for StoreBatchSink {
    fn ingest(&mut self, batch: NormalizedTranscriptBatch) -> Result<(), String> {
        for segment in &batch.segments {
            if segment.state != SegmentState::Final {
                continue;
            }
            let channel_id = segment.channel_id.as_ref().ok_or_else(|| {
                "provider final segment omitted the required audio channel identifier".to_string()
            })?;
            if !matches!(channel_id.as_str(), "microphone" | "system") {
                return Err(
                    "provider final segment used an unknown audio channel identifier".into(),
                );
            }
        }
        let provider_sequence = batch.provider_sequence;
        // Apply to a candidate state. Provider normalization and durable store
        // persistence commit together; a failed SQLite write must remain
        // replayable on reconnect.
        let mut candidate = self.accumulator.clone();
        let report = candidate.apply(batch).map_err(|error| error.to_string())?;
        if report.duplicate_batch {
            return Ok(());
        }
        let mut changes = Vec::new();
        let mut accepted_finals = 0_u64;
        for segment_id in report.accepted_segment_ids {
            let accepted = candidate
                .segments()
                .get(&segment_id)
                .ok_or_else(|| "accepted provider segment disappeared".to_string())?;
            let segment = &accepted.value;
            let channel_id = segment.channel_id.as_ref().ok_or_else(|| {
                "provider final segment omitted the required audio channel identifier".to_string()
            })?;
            if !matches!(channel_id.as_str(), "microphone" | "system") {
                return Err(
                    "provider final segment used an unknown audio channel identifier".into(),
                );
            }
            let start_ms = i64::try_from(segment.start_ms)
                .map_err(|_| "provider segment start exceeds durable range".to_string())?;
            let end_ms = i64::try_from(segment.end_ms)
                .map_err(|_| "provider segment end exceeds durable range".to_string())?;
            changes.push(TranscriptChange::UpsertSegment {
                segment: TranscriptSegmentInput {
                    id: stable_durable_id(
                        "segment",
                        &[&self.provider_run_id, segment.segment_id.as_str()],
                    ),
                    start_ms,
                    end_ms,
                    text: segment.text.clone(),
                    channel_id: Some(channel_id.to_string()),
                    speaker: segment.speaker.clone(),
                    confidence: segment.confidence.map(f64::from),
                    is_final: segment.state == SegmentState::Final,
                    metadata: json!({
                        "owner": "stt",
                        "providerRunId": self.provider_run_id,
                        "providerSequence": accepted.provider_sequence,
                        "providerRevision": segment.revision,
                        "language": segment.language,
                    }),
                },
            });
            if segment.state == SegmentState::Final {
                accepted_finals = accepted_finals.saturating_add(1);
            }
        }
        if changes.is_empty() {
            self.accumulator = candidate;
            return Ok(());
        }
        let meeting = self
            .store
            .get_meeting(&self.meeting_id)
            .map_err(|error| error.to_string())?;
        let durable = TranscriptBatch {
            meeting_id: self.meeting_id.clone(),
            batch_id: format!(
                "{}:{}",
                sanitize_wire_component(&self.provider_run_id),
                provider_sequence
            ),
            base_revision: meeting.transcript_revision,
            source: self.source.clone(),
            observed_at: now(),
            marks_final: false,
            changes,
        };
        if let Some(capture_generation) = self.repair_generation.as_deref() {
            self.store
                .stage_transcript_repair_batch(capture_generation, &self.provider_run_id, &durable)
                .map_err(|error| error.to_string())?;
        } else {
            self.store
                .apply_transcript_batch(&durable)
                .map_err(|error| error.to_string())?;
            self.changes.changed(&self.meeting_id);
        }
        self.accumulator = candidate;
        self.final_segment_count = self.final_segment_count.saturating_add(accepted_finals);
        Ok(())
    }

    fn final_segment_count(&self) -> u64 {
        self.final_segment_count
    }
}

struct CustomRunContext<'a> {
    request: &'a TranscriptionStart,
    endpoint: &'a CustomSttEndpoint,
    model: &'a str,
    credential: Option<&'a str>,
    audio: &'a PersistedAudioSource,
    finalize: &'a Receiver<FinalizeCommand>,
    ready: &'a SyncSender<Result<(), String>>,
}

async fn run_custom(
    context: CustomRunContext<'_>,
    sink: &mut dyn NormalizedBatchSink,
) -> Result<(), String> {
    run_custom_with_connector(context, sink, &ProductionCustomConnector).await
}

trait CustomConnectionFactory: Send + Sync {
    fn connect<'a>(
        &'a self,
        endpoint: &'a CustomSttEndpoint,
        credential: Option<&'a str>,
    ) -> BoxFuture<'a, Result<(PinnedWebSocket, SocketAddr), String>>;
}

struct ProductionCustomConnector;

impl CustomConnectionFactory for ProductionCustomConnector {
    fn connect<'a>(
        &'a self,
        endpoint: &'a CustomSttEndpoint,
        credential: Option<&'a str>,
    ) -> BoxFuture<'a, Result<(PinnedWebSocket, SocketAddr), String>> {
        Box::pin(connect_pinned(endpoint, credential))
    }
}

async fn run_custom_with_connector(
    context: CustomRunContext<'_>,
    sink: &mut dyn NormalizedBatchSink,
    connector: &dyn CustomConnectionFactory,
) -> Result<(), String> {
    let CustomRunContext {
        request,
        endpoint,
        model,
        credential,
        audio,
        finalize,
        ready,
    } = context;
    let preflight = SttPreflightRequest {
        operation: TranscriptionOperation::Live,
        encoding: AudioEncoding::PcmF32Le,
        sample_rate_hz: SAMPLE_RATE_HZ,
        channels: CHANNELS,
        channel_ids: vec![
            WireId::new("microphone").expect("static wire id"),
            WireId::new("system").expect("static wire id"),
        ],
        audio_frame_bytes: MAX_INTERLEAVED_CHUNK_BYTES as u32,
        partial_results: true,
        speaker_labels: false,
        language: None,
    };
    let session_id =
        WireId::new(request.run_id.clone()).map_err(|error| format!("invalid run id: {error}"))?;
    let model_id = WireId::new(model.to_string())
        .map_err(|error| format!("invalid custom model identifier: {error}"))?;
    let mut next_sequence = 0_u64;
    let mut ready_reported = false;
    let mut attempt = 0_u8;
    let mut finalizing = false;

    loop {
        if !finalizing {
            match finalize.try_recv() {
                Ok(_) => finalizing = true,
                Err(mpsc::TryRecvError::Disconnected) => {
                    return Err("transcription finalization channel closed".into())
                }
                Err(mpsc::TryRecvError::Empty) => {}
            }
        }
        let connection = connector.connect(endpoint, credential).await;
        let (mut websocket, _pinned_address) = match connection {
            Ok(connection) => connection,
            Err(message) => {
                attempt = attempt.saturating_add(1);
                let maximum = if ready_reported {
                    MAX_CONNECT_ATTEMPTS
                } else {
                    MAX_INITIAL_CONNECT_ATTEMPTS
                };
                if attempt >= maximum {
                    if !ready_reported {
                        let _ = ready.send(Err(message.clone()));
                    }
                    return Err(format!(
                        "selected custom transcription provider is unavailable after {attempt} attempts: {message}"
                    ));
                }
                sleep(reconnect_delay(attempt)).await;
                continue;
            }
        };

        let handshake = async {
            send_client_message(
                &mut websocket,
                &ClientMessage::start(session_id.clone(), model_id.clone(), preflight.clone()),
            )
            .await?;
            let capabilities = match receive_server_message(&mut websocket).await? {
                ServerMessage::Ready {
                    contract,
                    capabilities,
                } => {
                    if contract != STT_WIRE_CONTRACT {
                        return Err("custom provider selected an incompatible STT contract".into());
                    }
                    capabilities
                }
                _ => return Err("custom provider did not begin with a ready frame".into()),
            };
            capabilities
                .preflight(&preflight)
                .map_err(|error| error.to_string())
        }
        .await;
        if let Err(message) = handshake {
            attempt = attempt.saturating_add(1);
            let maximum = if ready_reported {
                MAX_CONNECT_ATTEMPTS
            } else {
                MAX_INITIAL_CONNECT_ATTEMPTS
            };
            if attempt >= maximum {
                if !ready_reported {
                    let _ = ready.send(Err(message.clone()));
                }
                return Err(format!(
                    "selected custom transcription provider rejected the protocol after {attempt} attempts: {message}"
                ));
            }
            sleep(reconnect_delay(attempt)).await;
            continue;
        }
        if !ready_reported {
            ready
                .send(Ok(()))
                .map_err(|_| "transcription caller stopped during provider startup".to_string())?;
            ready_reported = true;
        }
        match drive_custom_connection(
            &mut websocket,
            audio,
            finalize,
            sink,
            &mut next_sequence,
            model,
            &mut finalizing,
        )
        .await
        {
            Ok(()) => return Ok(()),
            Err(failure) if failure.retryable => {
                attempt = attempt.saturating_add(1);
                if attempt >= MAX_CONNECT_ATTEMPTS {
                    return Err(format!(
                        "selected custom transcription provider exhausted its reconnect budget ({})",
                        failure.code
                    ));
                }
                let requested = failure.retry_after.unwrap_or_default();
                sleep(
                    requested
                        .max(reconnect_delay(attempt))
                        .min(MAX_RECONNECT_DELAY),
                )
                .await;
            }
            Err(failure) => {
                return Err(format!(
                    "selected custom transcription provider failed ({})",
                    failure.code
                ))
            }
        }
    }
}

#[derive(Debug)]
struct ProviderFailure {
    code: String,
    retryable: bool,
    retry_after: Option<Duration>,
}

async fn drive_custom_connection<S>(
    websocket: &mut tokio_tungstenite::WebSocketStream<S>,
    audio: &PersistedAudioSource,
    finalize: &Receiver<FinalizeCommand>,
    sink: &mut dyn NormalizedBatchSink,
    next_sequence: &mut u64,
    _model: &str,
    finalizing: &mut bool,
) -> Result<(), ProviderFailure>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    loop {
        if !*finalizing {
            match finalize.try_recv() {
                Ok(_) => *finalizing = true,
                Err(mpsc::TryRecvError::Disconnected) => {
                    return Err(ProviderFailure {
                        code: "finalize-channel-closed".into(),
                        retryable: false,
                        retry_after: None,
                    })
                }
                Err(mpsc::TryRecvError::Empty) => {}
            }
        }

        let chunks = audio
            .chunks_from(*next_sequence, *finalizing, 1)
            .map_err(non_retryable)?;
        if let Some(chunk) = chunks.first() {
            send_client_message(
                websocket,
                &ClientMessage::Audio {
                    sequence: chunk.sequence,
                    start_ms: chunk.start_ms,
                    end_ms: chunk.end_ms,
                    byte_len: chunk.bytes.len() as u32,
                },
            )
            .await
            .map_err(retryable_transport)?;
            websocket
                .send(Message::binary(chunk.bytes.clone()))
                .await
                .map_err(|_| retryable("audio-send-failed"))?;
            await_acknowledgement(websocket, chunk.sequence, sink).await?;
            *next_sequence = chunk.sequence.saturating_add(1);
            continue;
        }

        if *finalizing {
            send_client_message(
                websocket,
                &ClientMessage::Stop {
                    final_audio_sequence: next_sequence.saturating_sub(1),
                },
            )
            .await
            .map_err(retryable_transport)?;
            return await_completion(websocket, sink).await;
        }
        sleep(AUDIO_POLL_INTERVAL).await;
    }
}

async fn await_acknowledgement<S>(
    websocket: &mut tokio_tungstenite::WebSocketStream<S>,
    expected_sequence: u64,
    sink: &mut dyn NormalizedBatchSink,
) -> Result<(), ProviderFailure>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    loop {
        match receive_server_message(websocket)
            .await
            .map_err(retryable_transport)?
        {
            ServerMessage::Acknowledged { audio_sequence }
                if audio_sequence == expected_sequence =>
            {
                return Ok(())
            }
            ServerMessage::Acknowledged { .. } => {
                return Err(non_retryable(
                    "provider acknowledged an unexpected audio sequence",
                ))
            }
            ServerMessage::Transcript { batch } => sink.ingest(batch).map_err(non_retryable)?,
            ServerMessage::Error {
                code,
                retryable,
                retry_after_ms,
            } => {
                return Err(ProviderFailure {
                    code: opaque_provider_error_code(code.as_str()),
                    retryable,
                    retry_after: retry_after_ms.map(Duration::from_millis),
                })
            }
            ServerMessage::Complete { .. } | ServerMessage::Ready { .. } => {
                return Err(non_retryable(
                    "provider emitted an out-of-order control message",
                ))
            }
        }
    }
}

async fn await_completion<S>(
    websocket: &mut tokio_tungstenite::WebSocketStream<S>,
    sink: &mut dyn NormalizedBatchSink,
) -> Result<(), ProviderFailure>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    loop {
        match receive_server_message(websocket)
            .await
            .map_err(retryable_transport)?
        {
            ServerMessage::Transcript { batch } => sink.ingest(batch).map_err(non_retryable)?,
            ServerMessage::Complete { .. } => {
                let _ = websocket.close(None).await;
                return Ok(());
            }
            ServerMessage::Error {
                code,
                retryable,
                retry_after_ms,
            } => {
                return Err(ProviderFailure {
                    code: opaque_provider_error_code(code.as_str()),
                    retryable,
                    retry_after: retry_after_ms.map(Duration::from_millis),
                })
            }
            ServerMessage::Acknowledged { .. } => {}
            ServerMessage::Ready { .. } => {
                return Err(non_retryable(
                    "provider emitted a second ready message during finalization",
                ))
            }
        }
    }
}

type PinnedWebSocket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>;

async fn connect_pinned(
    endpoint: &CustomSttEndpoint,
    credential: Option<&str>,
) -> Result<(PinnedWebSocket, SocketAddr), String> {
    let parsed =
        Url::parse(endpoint.as_str()).map_err(|_| "approved custom endpoint is invalid")?;
    let host = parsed
        .host_str()
        .ok_or_else(|| "approved custom endpoint has no host".to_string())?;
    let port = parsed
        .port_or_known_default()
        .ok_or_else(|| "approved custom endpoint has no port".to_string())?;
    let addresses = timeout(CONNECT_TIMEOUT, lookup_host((host, port)))
        .await
        .map_err(|_| "custom provider DNS lookup timed out".to_string())?
        .map_err(|_| "custom provider DNS lookup failed".to_string())?
        .collect::<Vec<_>>();
    if addresses.is_empty() || addresses.len() > MAX_DNS_ADDRESSES {
        return Err("custom provider DNS returned an invalid address count".into());
    }
    endpoint
        .validate_resolved_addresses(addresses.iter().map(SocketAddr::ip))
        .map_err(|error| error.to_string())?;
    connect_prevalidated_addresses(endpoint, credential, addresses, None).await
}

/// Opens addresses already pinned to the approved endpoint. Production calls
/// this only after public-address validation above. The test connector injects
/// loopback plus a generated CA to exercise the real TLS/WebSocket path
/// deterministically without weakening production routing.
async fn connect_prevalidated_addresses(
    endpoint: &CustomSttEndpoint,
    credential: Option<&str>,
    addresses: Vec<SocketAddr>,
    connector: Option<WebSocketConnector>,
) -> Result<(PinnedWebSocket, SocketAddr), String> {
    let mut last_error = None;
    for address in addresses {
        let tcp = match timeout(CONNECT_TIMEOUT, TcpStream::connect(address)).await {
            Ok(Ok(tcp)) => tcp,
            Ok(Err(_)) => {
                last_error = Some("TCP connection failed");
                continue;
            }
            Err(_) => {
                last_error = Some("TCP connection timed out");
                continue;
            }
        };
        tcp.set_nodelay(true)
            .map_err(|_| "could not configure provider connection".to_string())?;
        let mut request = endpoint
            .as_str()
            .into_client_request()
            .map_err(|_| "could not build custom provider handshake".to_string())?;
        request.headers_mut().insert(
            "sec-websocket-protocol",
            HeaderValue::from_static(STT_WIRE_CONTRACT),
        );
        if let Some(token) = credential {
            let value = HeaderValue::from_str(&format!("Bearer {token}"))
                .map_err(|_| "native credential contains invalid header bytes".to_string())?;
            request.headers_mut().insert(AUTHORIZATION, value);
        }
        let configuration = WebSocketConfig::default()
            .write_buffer_size(64 * 1024)
            .max_write_buffer_size(512 * 1024)
            .max_message_size(Some(MAX_PROVIDER_RESPONSE_BYTES))
            .max_frame_size(Some(MAX_PROVIDER_FRAME_BYTES));
        match timeout(
            CONNECT_TIMEOUT,
            client_async_tls_with_config(request, tcp, Some(configuration), connector.clone()),
        )
        .await
        {
            Ok(Ok((websocket, response))) => {
                let selected = response
                    .headers()
                    .get("sec-websocket-protocol")
                    .and_then(|value| value.to_str().ok());
                if selected != Some(STT_WIRE_CONTRACT) {
                    return Err(
                        "custom provider did not select the mimir.stt.v1 subprotocol".into(),
                    );
                }
                return Ok((websocket, address));
            }
            Ok(Err(_)) => last_error = Some("TLS/WebSocket handshake failed"),
            Err(_) => last_error = Some("TLS/WebSocket handshake timed out"),
        }
    }
    Err(format!(
        "could not connect to any approved DNS address: {}",
        last_error.unwrap_or("connection unavailable")
    ))
}

async fn send_client_message<S>(
    websocket: &mut tokio_tungstenite::WebSocketStream<S>,
    message: &ClientMessage,
) -> Result<(), String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let encoded =
        serde_json::to_string(message).map_err(|_| "could not encode STT request".to_string())?;
    websocket
        .send(Message::text(encoded))
        .await
        .map_err(|_| "could not send STT request".to_string())
}

async fn receive_server_message<S>(
    websocket: &mut tokio_tungstenite::WebSocketStream<S>,
) -> Result<ServerMessage, String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    loop {
        let message = timeout(PROVIDER_RESPONSE_TIMEOUT, websocket.next())
            .await
            .map_err(|_| "custom provider response timed out".to_string())?
            .ok_or_else(|| "custom provider closed the connection".to_string())?
            .map_err(|_| "custom provider WebSocket failed".to_string())?;
        match message {
            Message::Text(text) => {
                if text.len() > MAX_PROVIDER_RESPONSE_BYTES {
                    return Err("custom provider response exceeded its size bound".into());
                }
                let message: ServerMessage = serde_json::from_str(text.as_str())
                    .map_err(|_| "custom provider emitted invalid protocol JSON".to_string())?;
                message
                    .validate()
                    .map_err(|error| format!("custom provider protocol error: {error}"))?;
                return Ok(message);
            }
            Message::Ping(bytes) => websocket
                .send(Message::Pong(bytes))
                .await
                .map_err(|_| "could not answer custom provider heartbeat".to_string())?,
            Message::Pong(_) => {}
            Message::Binary(_) => {
                return Err("custom provider sent an unexpected binary response".into())
            }
            Message::Close(_) => return Err("custom provider closed the connection".into()),
            Message::Frame(_) => {
                return Err("custom provider exposed an unexpected raw frame".into())
            }
        }
    }
}

fn reconnect_delay(attempt: u8) -> Duration {
    let multiplier = 2_u32.saturating_pow(u32::from(attempt.saturating_sub(1)));
    BASE_RECONNECT_DELAY
        .saturating_mul(multiplier)
        .min(MAX_RECONNECT_DELAY)
}

fn retryable_transport(message: String) -> ProviderFailure {
    ProviderFailure {
        code: sanitize_error_code(&message),
        retryable: true,
        retry_after: None,
    }
}

fn retryable(code: &str) -> ProviderFailure {
    ProviderFailure {
        code: code.into(),
        retryable: true,
        retry_after: None,
    }
}

fn non_retryable(message: impl ToString) -> ProviderFailure {
    ProviderFailure {
        code: sanitize_error_code(&message.to_string()),
        retryable: false,
        retry_after: None,
    }
}

fn sanitize_error_code(message: &str) -> String {
    opaque_diagnostic_code("transport-error", message)
}

fn opaque_provider_error_code(code: &str) -> String {
    opaque_diagnostic_code("provider-error", code)
}

fn opaque_diagnostic_code(prefix: &str, sensitive: &str) -> String {
    let digest = format!("{:x}", Sha256::digest(sensitive.as_bytes()));
    format!("{prefix}-{}", &digest[..16])
}

fn sanitize_wire_component(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '-'
            }
        })
        .collect()
}

fn stable_durable_id(prefix: &str, values: &[&str]) -> String {
    let mut hasher = Sha256::new();
    for value in values {
        hasher.update((value.len() as u64).to_be_bytes());
        hasher.update(value.as_bytes());
    }
    format!("{prefix}:{:x}", hasher.finalize())
}

fn validate_path_component(value: &str, label: &str) -> Result<(), String> {
    let path = Path::new(value);
    if value.is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        || value.contains(['/', '\\'])
    {
        return Err(format!("{label} is not a safe path component"));
    }
    Ok(())
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meetings::stt::{
        LanguageCapability, NormalizedSegment, SegmentState, SttCapabilities, STT_WIRE_VERSION,
    };
    use crate::meetings::{
        AudioChannelDraft, AudioChannelKind, AudioChunkDraft, MeetingDraft, MeetingOrigin,
        MeetingStatus,
    };
    use rcgen::{BasicConstraints, CertificateParams, CertifiedIssuer, IsCa, KeyPair};
    use rustls::{
        pki_types::{CertificateDer, PrivatePkcs8KeyDer},
        ClientConfig, RootCertStore, ServerConfig,
    };
    use std::net::Ipv4Addr;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tempfile::TempDir;
    use tokio::net::TcpListener;
    use tokio_rustls::TlsAcceptor;
    use tokio_tungstenite::{
        accept_hdr_async,
        tungstenite::{
            handshake::server::{Request, Response},
            protocol::Role,
        },
    };

    fn chunk_definition(
        meeting_id: &str,
        channel: &str,
        sequence: u64,
        samples: &[f32],
    ) -> (AudioChunkDraft, Vec<u8>) {
        let bytes = samples
            .iter()
            .flat_map(|sample| sample.to_le_bytes())
            .collect::<Vec<_>>();
        let start_ms = sequence * 1_000;
        let duration_ms = (samples.len() as u64 * 1_000) / SAMPLE_RATE_HZ as u64;
        (
            AudioChunkDraft {
                id: format!("{meeting_id}-{channel}-{sequence:08}"),
                meeting_id: meeting_id.into(),
                channel_id: channel.into(),
                sequence,
                start_ms: start_ms as i64,
                end_ms: start_ms.saturating_add(duration_ms.max(1)) as i64,
                sample_count: samples.len() as u64,
                byte_len: bytes.len() as u64,
                sha256: format!("{:x}", Sha256::digest(&bytes)),
                relative_path: format!("{meeting_id}/audio/{channel}/{sequence:08}.f32le"),
            },
            bytes,
        )
    }

    fn write_chunk_file(root: &Path, definition: &AudioChunkDraft, bytes: &[u8]) -> PathBuf {
        let path = root.join(&definition.relative_path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, bytes).unwrap();
        path
    }

    fn stage_chunk(
        store: &MeetingStore,
        root: &Path,
        meeting_id: &str,
        channel: &str,
        sequence: u64,
        samples: &[f32],
    ) -> AudioChunkDraft {
        let (definition, bytes) = chunk_definition(meeting_id, channel, sequence, samples);
        write_chunk_file(root, &definition, &bytes);
        store
            .stage_audio_chunk(&definition, "2026-07-30T10:00:02Z")
            .unwrap();
        definition
    }

    fn commit_chunk(
        store: &MeetingStore,
        root: &Path,
        meeting_id: &str,
        channel: &str,
        sequence: u64,
        samples: &[f32],
    ) -> AudioChunkDraft {
        let definition = stage_chunk(store, root, meeting_id, channel, sequence, samples);
        store
            .commit_audio_chunk(&definition.id, "2026-07-30T10:00:03Z")
            .unwrap();
        definition
    }

    #[derive(Default)]
    struct CountingChanges(AtomicUsize);

    impl TranscriptionChangeSink for CountingChanges {
        fn changed(&self, _meeting_id: &str) {
            self.0.fetch_add(1, Ordering::Relaxed);
        }
    }

    struct SilentLocal;

    impl LocalTranscriber for SilentLocal {
        fn verify(&self, model_id: &str) -> Result<VerifiedLocalRuntime, String> {
            Ok(VerifiedLocalRuntime {
                runtime_id: "silent-test-runtime".into(),
                runtime_version: "1".into(),
                model_sha256: format!("verified-{model_id}"),
            })
        }

        fn run(&self, context: LocalTranscriptionContext<'_>) -> Result<(), String> {
            context
                .finalize
                .recv()
                .map_err(|_| "silent test finalization channel closed".to_string())?;
            Ok(())
        }
    }

    struct OneFinalRepairLocal;

    impl LocalTranscriber for OneFinalRepairLocal {
        fn verify(&self, model_id: &str) -> Result<VerifiedLocalRuntime, String> {
            Ok(VerifiedLocalRuntime {
                runtime_id: "repair-test-runtime".into(),
                runtime_version: "1".into(),
                model_sha256: format!("verified-{model_id}"),
            })
        }

        fn run(&self, context: LocalTranscriptionContext<'_>) -> Result<(), String> {
            context
                .sink
                .ingest(NormalizedTranscriptBatch {
                    provider_sequence: 1,
                    batch_id: WireId::new("repair-provider-batch").unwrap(),
                    segments: vec![NormalizedSegment {
                        segment_id: WireId::new("utterance-repaired").unwrap(),
                        revision: 1,
                        state: SegmentState::Final,
                        start_ms: 0,
                        end_ms: 1_000,
                        text: "Repaired only after the complete pass.".into(),
                        channel_id: Some(WireId::new("microphone").unwrap()),
                        speaker: Some("You".into()),
                        language: Some("en".into()),
                        confidence: Some(0.97),
                    }],
                })
                .map_err(|error| error.to_string())?;
            context
                .finalize
                .recv()
                .map_err(|_| "repair test finalization channel closed".to_string())?;
            Ok(())
        }
    }

    fn recording_store() -> Arc<MeetingStore> {
        let store = Arc::new(MeetingStore::open_in_memory().unwrap());
        let created = store
            .create_meeting(
                &MeetingDraft {
                    id: "meeting-1".into(),
                    title: "Live transcript".into(),
                    origin: MeetingOrigin {
                        kind: "manual".into(),
                        external_id: None,
                        confidence: None,
                        evidence: json!({}),
                    },
                    channels: vec![
                        AudioChannelDraft {
                            id: "microphone".into(),
                            kind: AudioChannelKind::Microphone,
                            sample_rate_hz: 16_000,
                            channels: 1,
                            sample_format: "f32le".into(),
                            device_id: None,
                        },
                        AudioChannelDraft {
                            id: "system".into(),
                            kind: AudioChannelKind::System,
                            sample_rate_hz: 16_000,
                            channels: 1,
                            sample_format: "f32le".into(),
                            device_id: None,
                        },
                    ],
                    metadata: json!({}),
                },
                "2026-07-30T10:00:00Z",
            )
            .unwrap();
        store
            .transition_meeting(
                "meeting-1",
                created.revision,
                MeetingStatus::Recording,
                "2026-07-30T10:00:01Z",
                None,
            )
            .unwrap();
        store
    }

    #[test]
    fn silent_local_meeting_emits_an_empty_terminal_batch() {
        let temporary = TempDir::new().unwrap();
        let store = recording_store();
        let transcriber = NativeMeetingTranscriber::new(
            Arc::clone(&store),
            temporary.path(),
            Arc::new(RuntimeRouteResolver),
            Arc::new(NoMeetingCredential),
            Arc::new(SilentLocal),
            Arc::new(NoopTranscriptionChangeSink),
        )
        .unwrap();
        let start = TranscriptionStart {
            meeting_id: "meeting-1".into(),
            run_id: "silent-run".into(),
            route: "local".into(),
            model: "whisper-small".into(),
            repair_generation: None,
        };
        transcriber.start(&start).unwrap();

        let batch = transcriber
            .finalize(&TranscriptionFinalize {
                meeting_id: "meeting-1".into(),
                run_id: "silent-run".into(),
                base_revision: 0,
                observed_at: "2026-07-30T10:05:00Z".into(),
            })
            .unwrap();

        assert!(batch.marks_final);
        assert!(batch.changes.is_empty());
        assert_eq!(batch.base_revision, 0);
        store.apply_transcript_batch(&batch).unwrap();
        let overview = store.transcript_overview("meeting-1", 1).unwrap();
        assert!(overview.is_final);
        assert_eq!(overview.segment_count, 0);
    }

    #[test]
    fn repair_worker_stages_privately_then_reconciles_from_audio_zero() {
        let temporary = TempDir::new().unwrap();
        let store = recording_store();
        store
            .apply_transcript_batch(&TranscriptBatch {
                meeting_id: "meeting-1".into(),
                batch_id: "pre-crash-partial".into(),
                base_revision: 0,
                source: "custom".into(),
                observed_at: "2026-07-30T10:00:02Z".into(),
                marks_final: false,
                changes: vec![TranscriptChange::UpsertSegment {
                    segment: TranscriptSegmentInput {
                        id: "stale-live-partial".into(),
                        start_ms: 0,
                        end_ms: 500,
                        text: "stale partial".into(),
                        channel_id: Some("microphone".into()),
                        speaker: None,
                        confidence: Some(0.4),
                        is_final: false,
                        metadata: json!({
                            "owner": "stt",
                            "providerRunId": "crashed-live-run"
                        }),
                    },
                }],
            })
            .unwrap();
        let meeting = store.get_meeting("meeting-1").unwrap();
        store
            .transition_meeting(
                "meeting-1",
                meeting.revision,
                MeetingStatus::Interrupted,
                "2026-07-30T10:00:03Z",
                None,
            )
            .unwrap();
        let changes = Arc::new(CountingChanges::default());
        let transcriber = NativeMeetingTranscriber::new(
            Arc::clone(&store),
            temporary.path(),
            Arc::new(RuntimeRouteResolver),
            Arc::new(NoMeetingCredential),
            Arc::new(OneFinalRepairLocal),
            changes.clone(),
        )
        .unwrap();
        let start = TranscriptionStart {
            meeting_id: "meeting-1".into(),
            run_id: "repair-run-generation-1".into(),
            route: "local".into(),
            model: "whisper-small".into(),
            repair_generation: Some("run-generation-1".into()),
        };
        transcriber.start(&start).unwrap();
        let terminal = transcriber
            .finalize(&TranscriptionFinalize {
                meeting_id: "meeting-1".into(),
                run_id: start.run_id.clone(),
                base_revision: 1,
                observed_at: "2026-07-30T10:05:00Z".into(),
            })
            .unwrap();

        // Provider output has completed, but only private repair staging has
        // changed. The pre-crash transcript remains authoritative until the
        // terminal reconciliation transaction.
        let before_commit = store.transcript_snapshot("meeting-1", None).unwrap();
        assert_eq!(before_commit.segments.len(), 1);
        assert_eq!(before_commit.segments[0].segment.id, "stale-live-partial");
        assert_eq!(changes.0.load(Ordering::Relaxed), 0);
        store
            .commit_transcript_repair("run-generation-1", "repair-run-generation-1", &terminal)
            .unwrap();
        let after_commit = store.transcript_snapshot("meeting-1", None).unwrap();
        assert_eq!(after_commit.segments.len(), 1);
        assert_eq!(
            after_commit.segments[0].segment.text,
            "Repaired only after the complete pass."
        );
        assert!(after_commit.segments[0].segment.is_final);
        assert_eq!(
            after_commit.segments[0].segment.metadata["providerRunId"],
            "repair-run-generation-1"
        );
    }

    #[test]
    fn partial_segments_are_live_durable_and_replaced_by_their_final_revision() {
        let store = recording_store();
        let changes = Arc::new(CountingChanges::default());
        let mut sink = StoreBatchSink::new(
            Arc::clone(&store),
            "meeting-1",
            "run-1",
            "custom",
            None,
            changes.clone(),
        )
        .unwrap();
        let segment = |revision, state, text: &str| NormalizedTranscriptBatch {
            provider_sequence: revision + 1,
            batch_id: WireId::new(format!("batch-{revision}")).unwrap(),
            segments: vec![NormalizedSegment {
                segment_id: WireId::new("utterance-1").unwrap(),
                revision,
                state,
                start_ms: 0,
                end_ms: 1_000,
                text: text.into(),
                channel_id: Some(WireId::new("microphone").unwrap()),
                speaker: Some("You".into()),
                language: Some("en".into()),
                confidence: Some(0.9),
            }],
        };

        sink.ingest(segment(0, SegmentState::Partial, "planning"))
            .unwrap();
        let partial = store.transcript_snapshot("meeting-1", None).unwrap();
        assert_eq!(partial.segments.len(), 1);
        assert!(!partial.segments[0].segment.is_final);
        assert_eq!(partial.segments[0].segment.text, "planning");

        sink.ingest(segment(1, SegmentState::Final, "planning complete"))
            .unwrap();
        let final_snapshot = store.transcript_snapshot("meeting-1", None).unwrap();
        assert_eq!(final_snapshot.segments.len(), 1);
        assert!(final_snapshot.segments[0].segment.is_final);
        assert_eq!(final_snapshot.segments[0].segment.text, "planning complete");
        assert_eq!(sink.final_segment_count(), 1);
        assert_eq!(changes.0.load(Ordering::Relaxed), 2);
    }

    #[test]
    fn durable_channels_are_interleaved_only_at_the_provider_boundary() {
        let temporary = TempDir::new().unwrap();
        let store = recording_store();
        commit_chunk(
            &store,
            temporary.path(),
            "meeting-1",
            "microphone",
            0,
            &[1.0, 2.0],
        );
        commit_chunk(
            &store,
            temporary.path(),
            "meeting-1",
            "system",
            0,
            &[3.0, 4.0],
        );
        let source =
            PersistedAudioSource::authoritative(store, temporary.path(), "meeting-1").unwrap();
        let chunks = source.paired_chunks_from(0).unwrap();
        let values = chunks[0]
            .bytes
            .chunks_exact(4)
            .map(|sample| f32::from_le_bytes(sample.try_into().unwrap()))
            .collect::<Vec<_>>();
        assert_eq!(values, vec![1.0, 3.0, 2.0, 4.0]);
        assert_eq!(chunks[0].sequence, 0);
    }

    #[cfg(unix)]
    #[test]
    fn durable_audio_reader_rejects_symlinked_parent_components() {
        use std::os::unix::fs::symlink;

        let temporary = TempDir::new().unwrap();
        let store = recording_store();
        let outside = temporary.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        let (definition, bytes) = chunk_definition("meeting-1", "microphone", 0, &[0.75]);
        fs::write(outside.join("00000000.f32le"), bytes).unwrap();
        store
            .stage_audio_chunk(&definition, "2026-07-30T10:00:02Z")
            .unwrap();
        store
            .commit_audio_chunk(&definition.id, "2026-07-30T10:00:03Z")
            .unwrap();
        let meeting_audio = temporary.path().join("meeting-1").join("audio");
        fs::create_dir_all(&meeting_audio).unwrap();
        symlink(&outside, meeting_audio.join("microphone")).unwrap();
        fs::create_dir_all(meeting_audio.join("system")).unwrap();
        let source =
            PersistedAudioSource::authoritative(store, temporary.path(), "meeting-1").unwrap();

        let error = source.final_chunks_from(0).unwrap_err();

        assert!(error.contains("without following links"));
    }

    #[test]
    fn a_shorter_channel_is_padded_without_mutating_its_durable_file() {
        let temporary = TempDir::new().unwrap();
        let store = recording_store();
        commit_chunk(
            &store,
            temporary.path(),
            "meeting-1",
            "microphone",
            0,
            &[1.0, 2.0],
        );
        commit_chunk(&store, temporary.path(), "meeting-1", "system", 0, &[3.0]);
        let source =
            PersistedAudioSource::authoritative(store, temporary.path(), "meeting-1").unwrap();
        let values = source.paired_chunks_from(0).unwrap()[0]
            .bytes
            .chunks_exact(4)
            .map(|sample| f32::from_le_bytes(sample.try_into().unwrap()))
            .collect::<Vec<_>>();
        assert_eq!(values, vec![1.0, 3.0, 2.0, 0.0]);
        assert_eq!(
            fs::metadata(
                temporary
                    .path()
                    .join("meeting-1/audio/system/00000000.f32le")
            )
            .unwrap()
            .len(),
            4
        );
    }

    #[test]
    fn an_unpaired_chunk_is_not_disclosed_to_the_provider() {
        let temporary = TempDir::new().unwrap();
        let store = recording_store();
        commit_chunk(
            &store,
            temporary.path(),
            "meeting-1",
            "microphone",
            0,
            &[1.0],
        );
        let source =
            PersistedAudioSource::authoritative(store, temporary.path(), "meeting-1").unwrap();
        assert!(source.paired_chunks_from(0).unwrap().is_empty());
        let final_chunk = source.final_chunks_from(0).unwrap().pop().unwrap();
        let values = final_chunk
            .bytes
            .chunks_exact(4)
            .map(|sample| f32::from_le_bytes(sample.try_into().unwrap()))
            .collect::<Vec<_>>();
        assert_eq!(values, vec![1.0, 0.0]);
    }

    #[test]
    fn live_reader_never_advances_past_an_unpaired_sequence() {
        let temporary = TempDir::new().unwrap();
        let store = recording_store();
        commit_chunk(
            &store,
            temporary.path(),
            "meeting-1",
            "microphone",
            0,
            &[1.0],
        );
        commit_chunk(
            &store,
            temporary.path(),
            "meeting-1",
            "microphone",
            1,
            &[2.0],
        );
        commit_chunk(&store, temporary.path(), "meeting-1", "system", 1, &[3.0]);
        let source =
            PersistedAudioSource::authoritative(store, temporary.path(), "meeting-1").unwrap();

        assert!(source.paired_chunks_from(0).unwrap().is_empty());
        let final_chunks = source.final_chunks_from(0).unwrap();
        assert_eq!(
            final_chunks
                .iter()
                .map(|chunk| chunk.sequence)
                .collect::<Vec<_>>(),
            vec![0, 1]
        );
    }

    #[test]
    fn durable_audio_reads_are_contiguous_and_memory_bounded() {
        let temporary = TempDir::new().unwrap();
        let store = recording_store();
        for sequence in 0..40 {
            commit_chunk(
                &store,
                temporary.path(),
                "meeting-1",
                "microphone",
                sequence,
                &[1.0],
            );
            commit_chunk(
                &store,
                temporary.path(),
                "meeting-1",
                "system",
                sequence,
                &[2.0],
            );
        }
        let source =
            PersistedAudioSource::authoritative(store, temporary.path(), "meeting-1").unwrap();
        let chunks = source.paired_chunks_from_bounded(0, 7).unwrap();
        assert_eq!(chunks.len(), 7);
        assert_eq!(chunks.last().unwrap().sequence, 6);
        assert!(source.paired_chunks_from_bounded(0, 0).is_err());
        assert!(source
            .paired_chunks_from_bounded(0, MAX_AUDIO_READ_CHUNKS + 1)
            .is_err());
    }

    #[test]
    fn unregistered_staged_and_corrupt_files_are_silence_not_stt_input() {
        let temporary = TempDir::new().unwrap();
        let store = recording_store();

        let (unregistered, unregistered_bytes) =
            chunk_definition("meeting-1", "microphone", 0, &[91.0]);
        write_chunk_file(temporary.path(), &unregistered, &unregistered_bytes);
        commit_chunk(&store, temporary.path(), "meeting-1", "system", 0, &[1.0]);

        stage_chunk(
            &store,
            temporary.path(),
            "meeting-1",
            "microphone",
            1,
            &[92.0],
        );
        commit_chunk(&store, temporary.path(), "meeting-1", "system", 1, &[2.0]);

        let corrupt = stage_chunk(
            &store,
            temporary.path(),
            "meeting-1",
            "microphone",
            2,
            &[93.0],
        );
        store
            .mark_audio_chunk_corrupt(
                &corrupt.id,
                "test integrity rejection",
                "2026-07-30T10:00:03Z",
            )
            .unwrap();
        commit_chunk(&store, temporary.path(), "meeting-1", "system", 2, &[3.0]);

        let source =
            PersistedAudioSource::authoritative(store, temporary.path(), "meeting-1").unwrap();
        assert!(source.paired_chunks_from(0).unwrap().is_empty());
        let projected = source
            .final_chunks_from(0)
            .unwrap()
            .into_iter()
            .flat_map(|chunk| {
                chunk
                    .bytes
                    .chunks_exact(BYTES_PER_SAMPLE)
                    .map(|sample| f32::from_le_bytes(sample.try_into().unwrap()))
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();

        assert_eq!(projected, vec![0.0, 1.0, 0.0, 2.0, 0.0, 3.0]);
        assert!(!projected.contains(&91.0));
        assert!(!projected.contains(&92.0));
        assert!(!projected.contains(&93.0));
    }

    #[test]
    fn tampered_committed_file_fails_sha256_before_stt_disclosure() {
        let temporary = TempDir::new().unwrap();
        let store = recording_store();
        let microphone = commit_chunk(
            &store,
            temporary.path(),
            "meeting-1",
            "microphone",
            0,
            &[1.0],
        );
        commit_chunk(&store, temporary.path(), "meeting-1", "system", 0, &[2.0]);
        fs::write(
            temporary.path().join(&microphone.relative_path),
            9_f32.to_le_bytes(),
        )
        .unwrap();
        let source =
            PersistedAudioSource::authoritative(store, temporary.path(), "meeting-1").unwrap();

        let error = source.final_chunks_from(0).unwrap_err();

        assert!(error.contains("SHA-256"));
    }

    #[test]
    fn noncanonical_committed_database_path_is_rejected_before_file_read() {
        let temporary = TempDir::new().unwrap();
        let store = recording_store();
        let (mut definition, bytes) = chunk_definition("meeting-1", "microphone", 0, &[7.0]);
        definition.relative_path = "meeting-1/audio/microphone/alternate.f32le".into();
        write_chunk_file(temporary.path(), &definition, &bytes);
        store
            .stage_audio_chunk(&definition, "2026-07-30T10:00:02Z")
            .unwrap();
        store
            .commit_audio_chunk(&definition.id, "2026-07-30T10:00:03Z")
            .unwrap();
        let source =
            PersistedAudioSource::authoritative(store, temporary.path(), "meeting-1").unwrap();

        let error = source.final_chunks_from(0).unwrap_err();

        assert!(error.contains("not canonical"));
    }

    #[test]
    fn route_resolution_has_exactly_local_or_secure_custom_modes() {
        let resolver = RuntimeRouteResolver;
        let local = resolver
            .resolve(&TranscriptionStart {
                meeting_id: "meeting-1".into(),
                run_id: "run-1".into(),
                route: "local".into(),
                model: "whisper-small".into(),
                repair_generation: None,
            })
            .unwrap();
        assert!(matches!(local, ResolvedTranscriptionProvider::Local { .. }));

        let custom = resolver
            .resolve(&TranscriptionStart {
                meeting_id: "meeting-1".into(),
                run_id: "run-1".into(),
                route: "https://speech.example.com/mimir".into(),
                model: "meeting-model".into(),
                repair_generation: None,
            })
            .unwrap();
        let ResolvedTranscriptionProvider::Custom { endpoint, .. } = custom else {
            panic!("expected custom route");
        };
        assert_eq!(endpoint.as_str(), "wss://speech.example.com/mimir");

        assert!(resolver
            .resolve(&TranscriptionStart {
                meeting_id: "meeting-1".into(),
                run_id: "run-1".into(),
                route: "http://speech.example.com/mimir".into(),
                model: "meeting-model".into(),
                repair_generation: None,
            })
            .is_err());
        assert!(resolver
            .resolve(&TranscriptionStart {
                meeting_id: "meeting-1".into(),
                run_id: "run-1".into(),
                route: "http://127.0.0.1:9000/mimir".into(),
                model: "meeting-model".into(),
                repair_generation: None,
            })
            .is_err());
    }

    #[test]
    fn local_default_is_explicitly_unavailable() {
        let unavailable = UnavailableLocalTranscriber;
        let error = unavailable.verify("whisper-small").unwrap_err();
        assert!(error.contains("unavailable"));
        assert!(!error.contains("success"));
    }

    #[test]
    fn diagnostics_omit_credentials_provider_details_transcript_and_audio() {
        const SECRET: &str = "SUPER_SECRET_BEARER_TOKEN_ABC123";
        struct LeakingCredentialResolver;
        impl MeetingCredentialResolver for LeakingCredentialResolver {
            fn bearer_token(
                &self,
                _endpoint: &CustomSttEndpoint,
            ) -> Result<Option<String>, String> {
                Err(format!("credential lookup failed with {SECRET}"))
            }
        }

        let endpoint =
            CustomSttEndpoint::new("wss://speech.example.com/mimir", "speech.example.com").unwrap();
        let credential_error =
            resolve_custom_credential(&LeakingCredentialResolver, &endpoint).unwrap_err();
        assert_eq!(
            credential_error,
            "could not resolve custom transcription credential"
        );
        assert!(!credential_error.contains(SECRET));

        let output = sanitize_error_code(&format!("TLS peer said {SECRET}"));
        assert!(output.len() <= 96);
        assert!(!output.contains(SECRET));
        assert!(output
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-'));
        let provider = opaque_provider_error_code(SECRET);
        assert!(!provider.contains(SECRET));

        let chunk = PersistedAudioChunk {
            sequence: 1,
            start_ms: 0,
            end_ms: 1_000,
            bytes: SECRET.as_bytes().to_vec(),
        };
        let chunk_debug = format!("{chunk:?}");
        assert!(!chunk_debug.contains(SECRET));
        assert!(chunk_debug.contains(&format!("{} bytes", SECRET.len())));

        let transcript = provider_batch(1, "diagnostic", 1, SegmentState::Partial, SECRET);
        let transcript_debug = format!("{transcript:?}");
        assert!(!transcript_debug.contains(SECRET));
    }

    #[test]
    fn reconnect_backoff_is_bounded() {
        assert_eq!(reconnect_delay(1), Duration::from_millis(250));
        assert_eq!(reconnect_delay(2), Duration::from_millis(500));
        assert_eq!(reconnect_delay(20), MAX_RECONNECT_DELAY);
    }

    #[test]
    fn timed_out_transcriber_returns_without_joining_and_late_ready_is_rejected() {
        let (release_tx, release_rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::sync_channel::<Result<(), String>>(1);
        let worker = thread::spawn(move || {
            release_rx.recv().unwrap();
            assert!(ready_tx.send(Ok(())).is_err());
        });
        let pending = Arc::new(AtomicBool::new(false));

        assert!(ready_rx.recv_timeout(Duration::from_millis(5)).is_err());
        drop(ready_rx);
        let returned_at = Instant::now();
        reap_transcription_startup("test transcription startup", worker, Arc::clone(&pending));

        assert!(returned_at.elapsed() < Duration::from_millis(100));
        assert!(pending.load(Ordering::Acquire));
        release_tx.send(()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(1);
        while pending.load(Ordering::Acquire) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(1));
        }
        assert!(!pending.load(Ordering::Acquire));
    }

    #[derive(Default)]
    struct MockSink {
        batches: Vec<NormalizedTranscriptBatch>,
    }

    impl NormalizedBatchSink for MockSink {
        fn ingest(&mut self, batch: NormalizedTranscriptBatch) -> Result<(), String> {
            batch.validate().map_err(|error| error.to_string())?;
            self.batches.push(batch);
            Ok(())
        }

        fn final_segment_count(&self) -> u64 {
            self.batches
                .iter()
                .flat_map(|batch| &batch.segments)
                .filter(|segment| segment.state == SegmentState::Final)
                .count() as u64
        }
    }

    struct InjectedTlsConnector {
        address: SocketAddr,
        connector: WebSocketConnector,
    }

    impl CustomConnectionFactory for InjectedTlsConnector {
        fn connect<'a>(
            &'a self,
            endpoint: &'a CustomSttEndpoint,
            credential: Option<&'a str>,
        ) -> BoxFuture<'a, Result<(PinnedWebSocket, SocketAddr), String>> {
            let address = self.address;
            let connector = self.connector.clone();
            Box::pin(async move {
                connect_prevalidated_addresses(endpoint, credential, vec![address], Some(connector))
                    .await
            })
        }
    }

    fn generated_tls_configs(host: &str) -> (ServerConfig, ClientConfig) {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let mut ca_params = CertificateParams::new(Vec::<String>::new()).unwrap();
        ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        let ca = CertifiedIssuer::self_signed(ca_params, KeyPair::generate().unwrap()).unwrap();
        let server_key = KeyPair::generate().unwrap();
        let server_params = CertificateParams::new(vec![host.to_string()]).unwrap();
        let server_certificate = server_params.signed_by(&server_key, &ca).unwrap();
        let private_key = PrivatePkcs8KeyDer::from(server_key.serialize_der()).into();
        let server = ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(
                vec![server_certificate.der().clone(), ca.der().clone()],
                private_key,
            )
            .unwrap();
        let mut roots = RootCertStore::empty();
        roots.add(CertificateDer::from(ca.der().to_vec())).unwrap();
        let client = ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth();
        (server, client)
    }

    fn custom_capabilities() -> SttCapabilities {
        SttCapabilities {
            contract_version: STT_WIRE_VERSION,
            operations: [TranscriptionOperation::Live].into_iter().collect(),
            encodings: [AudioEncoding::PcmF32Le].into_iter().collect(),
            sample_rates_hz: [SAMPLE_RATE_HZ].into_iter().collect(),
            max_channels: CHANNELS,
            max_audio_frame_bytes: MAX_INTERLEAVED_CHUNK_BYTES as u32,
            supports_partial_results: true,
            supports_speaker_labels: false,
            languages: LanguageCapability::Any,
        }
    }

    async fn accept_tls_websocket(
        listener: &TcpListener,
        acceptor: &TlsAcceptor,
        expected_authorization: &str,
        accepted_credentials: Arc<AtomicUsize>,
    ) -> tokio_tungstenite::WebSocketStream<tokio_rustls::server::TlsStream<TcpStream>> {
        let (tcp, _) = listener.accept().await.unwrap();
        let tls = acceptor.accept(tcp).await.unwrap();
        let expected_authorization = expected_authorization.to_string();
        accept_hdr_async(tls, move |request: &Request, mut response: Response| {
            let credential_matches = request
                .headers()
                .get(AUTHORIZATION)
                .and_then(|value| value.to_str().ok())
                == Some(expected_authorization.as_str());
            let protocol_matches = request
                .headers()
                .get("sec-websocket-protocol")
                .and_then(|value| value.to_str().ok())
                == Some(STT_WIRE_CONTRACT);
            if credential_matches && protocol_matches {
                accepted_credentials.fetch_add(1, Ordering::Relaxed);
            }
            response.headers_mut().insert(
                "sec-websocket-protocol",
                HeaderValue::from_static(STT_WIRE_CONTRACT),
            );
            Ok(response)
        })
        .await
        .unwrap()
    }

    async fn expect_start<S>(websocket: &mut tokio_tungstenite::WebSocketStream<S>)
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    {
        let Message::Text(text) = websocket.next().await.unwrap().unwrap() else {
            panic!("expected start metadata");
        };
        let ClientMessage::Start {
            contract, request, ..
        } = serde_json::from_str::<ClientMessage>(text.as_str()).unwrap()
        else {
            panic!("expected start frame");
        };
        assert_eq!(contract, STT_WIRE_CONTRACT);
        assert_eq!(request.encoding, AudioEncoding::PcmF32Le);
        assert_eq!(request.channels, CHANNELS);
        send_server_message(
            websocket,
            &ServerMessage::Ready {
                contract: STT_WIRE_CONTRACT.into(),
                capabilities: custom_capabilities(),
            },
        )
        .await;
    }

    async fn expect_audio<S>(
        websocket: &mut tokio_tungstenite::WebSocketStream<S>,
        expected_sequence: u64,
    ) -> Vec<u8>
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    {
        let Message::Text(metadata) = websocket.next().await.unwrap().unwrap() else {
            panic!("expected audio metadata");
        };
        let ClientMessage::Audio {
            sequence, byte_len, ..
        } = serde_json::from_str::<ClientMessage>(metadata.as_str()).unwrap()
        else {
            panic!("expected audio metadata frame");
        };
        assert_eq!(sequence, expected_sequence);
        let Message::Binary(audio) = websocket.next().await.unwrap().unwrap() else {
            panic!("expected binary audio");
        };
        assert_eq!(audio.len(), byte_len as usize);
        audio.to_vec()
    }

    fn provider_batch(
        provider_sequence: u64,
        batch_id: &str,
        revision: u64,
        state: SegmentState,
        text: &str,
    ) -> NormalizedTranscriptBatch {
        NormalizedTranscriptBatch {
            provider_sequence,
            batch_id: WireId::new(batch_id).unwrap(),
            segments: vec![NormalizedSegment {
                segment_id: WireId::new("tls-utterance").unwrap(),
                revision,
                state,
                start_ms: 0,
                end_ms: 1_000,
                text: text.into(),
                channel_id: Some(WireId::new("microphone").unwrap()),
                speaker: Some("You".into()),
                language: Some("en".into()),
                confidence: Some(0.98),
            }],
        }
    }

    #[tokio::test]
    async fn generated_ca_tls_provider_reconnects_replays_and_finalizes_end_to_end() {
        const HOST: &str = "scribe-test.example";
        const BEARER: &str = "ultra-secret-bearer-value";
        const PARTIAL: &str = "private transcript sentinel";
        const FINAL: &str = "private transcript sentinel finalized";

        let temporary = TempDir::new().unwrap();
        let store = recording_store();
        commit_chunk(
            &store,
            temporary.path(),
            "meeting-1",
            "microphone",
            0,
            &[0.1, 0.2],
        );
        commit_chunk(
            &store,
            temporary.path(),
            "meeting-1",
            "system",
            0,
            &[0.3, 0.4],
        );
        commit_chunk(
            &store,
            temporary.path(),
            "meeting-1",
            "microphone",
            1,
            &[0.5, 0.6],
        );
        commit_chunk(
            &store,
            temporary.path(),
            "meeting-1",
            "system",
            1,
            &[0.7, 0.8],
        );
        let audio =
            PersistedAudioSource::authoritative(Arc::clone(&store), temporary.path(), "meeting-1")
                .unwrap();
        let mut sink = StoreBatchSink::new(
            Arc::clone(&store),
            "meeting-1",
            "tls-run",
            "custom",
            None,
            Arc::new(CountingChanges::default()),
        )
        .unwrap();

        let (server_config, client_config) = generated_tls_configs(HOST);
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let acceptor = TlsAcceptor::from(Arc::new(server_config));
        let accepted_credentials = Arc::new(AtomicUsize::new(0));
        let credential_counter = Arc::clone(&accepted_credentials);
        let server = tokio::spawn(async move {
            let expected_authorization = format!("Bearer {BEARER}");
            let mut first = accept_tls_websocket(
                &listener,
                &acceptor,
                &expected_authorization,
                Arc::clone(&credential_counter),
            )
            .await;
            expect_start(&mut first).await;
            let first_audio = expect_audio(&mut first, 0).await;
            send_server_message(
                &mut first,
                &ServerMessage::Transcript {
                    batch: provider_batch(1, "tls-partial", 1, SegmentState::Partial, PARTIAL),
                },
            )
            .await;
            send_server_message(
                &mut first,
                &ServerMessage::Error {
                    code: WireId::new("transient-private-provider-detail").unwrap(),
                    retryable: true,
                    retry_after_ms: Some(1),
                },
            )
            .await;
            drop(first);

            let mut second = accept_tls_websocket(
                &listener,
                &acceptor,
                &expected_authorization,
                Arc::clone(&credential_counter),
            )
            .await;
            expect_start(&mut second).await;
            let replayed_audio = expect_audio(&mut second, 0).await;
            send_server_message(
                &mut second,
                &ServerMessage::Transcript {
                    batch: provider_batch(2, "tls-final", 2, SegmentState::Final, FINAL),
                },
            )
            .await;
            send_server_message(
                &mut second,
                &ServerMessage::Acknowledged { audio_sequence: 0 },
            )
            .await;
            let second_audio = expect_audio(&mut second, 1).await;
            send_server_message(
                &mut second,
                &ServerMessage::Acknowledged { audio_sequence: 1 },
            )
            .await;
            let Message::Text(stop) = second.next().await.unwrap().unwrap() else {
                panic!("expected stop frame");
            };
            assert!(matches!(
                serde_json::from_str::<ClientMessage>(stop.as_str()).unwrap(),
                ClientMessage::Stop {
                    final_audio_sequence: 1
                }
            ));
            send_server_message(
                &mut second,
                &ServerMessage::Complete {
                    final_provider_sequence: 2,
                },
            )
            .await;
            (first_audio, replayed_audio, second_audio)
        });

        let endpoint =
            CustomSttEndpoint::new(&format!("wss://{HOST}:{}/listen", address.port()), HOST)
                .unwrap();
        let connector = InjectedTlsConnector {
            address,
            connector: WebSocketConnector::Rustls(Arc::new(client_config)),
        };
        let request = TranscriptionStart {
            meeting_id: "meeting-1".into(),
            run_id: "tls-run".into(),
            route: endpoint.as_str().into(),
            model: "tls-model".into(),
            repair_generation: None,
        };
        let (finalize_tx, finalize_rx) = mpsc::channel();
        finalize_tx
            .send(FinalizeCommand {
                observed_at: "2026-07-31T12:00:00.000Z".into(),
            })
            .unwrap();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        run_custom_with_connector(
            CustomRunContext {
                request: &request,
                endpoint: &endpoint,
                model: &request.model,
                credential: Some(BEARER),
                audio: &audio,
                finalize: &finalize_rx,
                ready: &ready_tx,
            },
            &mut sink,
            &connector,
        )
        .await
        .unwrap();
        assert_eq!(ready_rx.recv().unwrap(), Ok(()));
        let (first_audio, replayed_audio, second_audio) = server.await.unwrap();
        assert_eq!(first_audio, replayed_audio);
        assert_ne!(first_audio, second_audio);
        assert_eq!(accepted_credentials.load(Ordering::Relaxed), 2);
        let transcript = store.transcript_snapshot("meeting-1", None).unwrap();
        assert_eq!(transcript.segments.len(), 1);
        assert!(transcript.segments[0].segment.is_final);
        assert_eq!(transcript.segments[0].segment.text, FINAL);
        assert_eq!(sink.final_segment_count(), 1);
        assert_eq!(sink.accumulator.unresolved_partial_count(), 0);
    }

    #[tokio::test]
    async fn scripted_wire_peer_receives_durable_audio_and_completes_with_a_final_batch() {
        let temporary = TempDir::new().unwrap();
        let store = recording_store();
        commit_chunk(
            &store,
            temporary.path(),
            "meeting-1",
            "microphone",
            0,
            &[0.25, 0.5],
        );
        commit_chunk(
            &store,
            temporary.path(),
            "meeting-1",
            "system",
            0,
            &[0.75, 1.0],
        );
        let audio =
            PersistedAudioSource::authoritative(store, temporary.path(), "meeting-1").unwrap();
        let (finalize_tx, finalize_rx) = mpsc::channel();
        finalize_tx
            .send(FinalizeCommand {
                observed_at: "2026-07-31T12:00:00.000Z".into(),
            })
            .unwrap();
        let (client_io, server_io) = tokio::io::duplex(512 * 1024);
        let mut client =
            tokio_tungstenite::WebSocketStream::from_raw_socket(client_io, Role::Client, None)
                .await;
        let mut server =
            tokio_tungstenite::WebSocketStream::from_raw_socket(server_io, Role::Server, None)
                .await;

        let peer = async move {
            let metadata = server.next().await.unwrap().unwrap();
            let Message::Text(metadata) = metadata else {
                panic!("expected audio metadata");
            };
            let metadata: ClientMessage = serde_json::from_str(metadata.as_str()).unwrap();
            assert!(matches!(
                metadata,
                ClientMessage::Audio {
                    sequence: 0,
                    byte_len: 16,
                    ..
                }
            ));
            let audio = server.next().await.unwrap().unwrap();
            assert!(matches!(audio, Message::Binary(bytes) if bytes.len() == 16));
            send_server_message(
                &mut server,
                &ServerMessage::Acknowledged { audio_sequence: 0 },
            )
            .await;

            let stop = server.next().await.unwrap().unwrap();
            let Message::Text(stop) = stop else {
                panic!("expected stop message");
            };
            assert!(matches!(
                serde_json::from_str::<ClientMessage>(stop.as_str()).unwrap(),
                ClientMessage::Stop {
                    final_audio_sequence: 0
                }
            ));
            send_server_message(
                &mut server,
                &ServerMessage::Transcript {
                    batch: NormalizedTranscriptBatch {
                        provider_sequence: 1,
                        batch_id: WireId::new("provider-batch-1").unwrap(),
                        segments: vec![NormalizedSegment {
                            segment_id: WireId::new("utterance-1").unwrap(),
                            revision: 1,
                            state: SegmentState::Final,
                            start_ms: 0,
                            end_ms: 1_000,
                            text: "Durable audio reached the provider.".into(),
                            channel_id: Some(WireId::new("microphone").unwrap()),
                            speaker: Some("You".into()),
                            language: Some("en".into()),
                            confidence: Some(0.99),
                        }],
                    },
                },
            )
            .await;
            send_server_message(
                &mut server,
                &ServerMessage::Complete {
                    final_provider_sequence: 1,
                },
            )
            .await;
        };

        let mut sink = MockSink::default();
        let mut next_sequence = 0;
        let mut finalizing = false;
        let client_run = drive_custom_connection(
            &mut client,
            &audio,
            &finalize_rx,
            &mut sink,
            &mut next_sequence,
            "model-1",
            &mut finalizing,
        );
        let (result, ()) = tokio::join!(client_run, peer);
        result.unwrap();
        assert_eq!(next_sequence, 1);
        assert_eq!(sink.final_segment_count(), 1);
    }

    async fn send_server_message<S>(
        websocket: &mut tokio_tungstenite::WebSocketStream<S>,
        message: &ServerMessage,
    ) where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    {
        websocket
            .send(Message::text(serde_json::to_string(message).unwrap()))
            .await
            .unwrap();
    }
}
