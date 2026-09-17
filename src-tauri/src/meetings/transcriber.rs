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
    diagnostics::ScribeDiagnostics,
    runtime::{
        MeetingTranscriptionPort, TranscriptionFinalize, TranscriptionRepairIntent,
        TranscriptionStart, TranscriptionWorkerStatus,
    },
    stt::{
        AudioEncoding, ClientMessage, NormalizedSegment, NormalizedTranscriptBatch, SegmentState,
        ServerMessage, SttPreflightRequest, TranscriptAccumulator, TranscriptionOperation, WireId,
        STT_WIRE_CONTRACT,
    },
    AudioChunk, AudioChunkStatus, MeetingStore, TranscriptBatch, TranscriptChange,
    TranscriptRepairBegin, TranscriptSegmentInput,
};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
use chrono::{SecondsFormat, Utc};
use futures_util::{future::BoxFuture, SinkExt, StreamExt};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    fs::{self, File, OpenOptions},
    io::{self, Read},
    net::SocketAddr,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{self, Receiver, Sender, SyncSender},
        Arc, Mutex, MutexGuard,
    },
    thread,
    time::{Duration, Instant},
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

mod api;
mod audio_source;
mod custom;
mod openai;
mod openai_state;
mod store_sink;
mod transport;
mod wire;

pub use api::*;
pub use audio_source::{PersistedAudioChunk, PersistedAudioSource};
use custom::*;
use openai::*;
use openai_state::*;
use store_sink::*;
use transport::*;
use wire::*;

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
const OPENAI_SAMPLE_RATE_HZ: u32 = 24_000;
const OPENAI_VAD_THRESHOLD: f64 = 0.5;
const OPENAI_VAD_PREFIX_PADDING_MS: u64 = 300;
const OPENAI_VAD_SILENCE_DURATION_MS: u64 = 800;
const OPENAI_VAD_SETTLE_TIMEOUT: Duration = Duration::from_millis(1_500);
const OPENAI_FINALIZE_TIMEOUT: Duration = Duration::from_secs(20);

struct TranscriptionSession {
    meeting_id: String,
    end_sequence: Arc<AtomicU64>,
    finalize: Sender<FinalizeCommand>,
    worker: thread::JoinHandle<Result<WorkerCompletion, String>>,
    readiness: thread::JoinHandle<()>,
    state: Arc<Mutex<TranscriptionSessionState>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TranscriptionSessionState {
    Initializing,
    Connecting,
    Listening,
    Live,
    Reconnecting,
    Failed,
}

#[derive(Clone)]
struct WorkerStatusReporter {
    meeting_id: String,
    state: Arc<Mutex<TranscriptionSessionState>>,
    changes: Arc<dyn TranscriptionChangeSink>,
}

impl WorkerStatusReporter {
    fn set(&self, next: TranscriptionSessionState) {
        let changed = self
            .state
            .lock()
            .map(|mut state| {
                if *state == next {
                    return false;
                }
                *state = next;
                true
            })
            .unwrap_or(false);
        if changed {
            self.changes.state_changed(&self.meeting_id);
        }
    }
}

struct ReportingBatchSink<'a> {
    inner: &'a mut dyn NormalizedBatchSink,
    status: WorkerStatusReporter,
}

impl NormalizedBatchSink for ReportingBatchSink<'_> {
    fn ingest(&mut self, batch: NormalizedTranscriptBatch) -> Result<(), String> {
        self.status.set(TranscriptionSessionState::Live);
        self.inner.ingest(batch)
    }

    fn final_segment_count(&self) -> u64 {
        self.inner.final_segment_count()
    }
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
        if sessions.contains_key(&request.run_id) {
            return Err(format!(
                "meeting '{}' already owns a transcription worker",
                request.meeting_id
            ));
        }
        if let Some(capture_generation) = request.repair_generation.as_deref() {
            let user_replaces_terminal_transcript = request.repair_intent
                == Some(TranscriptionRepairIntent::UserRequestedRetranscription)
                && self
                    .store
                    .get_meeting(&request.meeting_id)
                    .map_err(|error| error.to_string())?
                    .status
                    != super::MeetingStatus::Interrupted;
            let begin = if user_replaces_terminal_transcript {
                self.store.begin_transcript_retranscription(
                    &request.meeting_id,
                    capture_generation,
                    &request.run_id,
                    &now(),
                )
            } else {
                self.store.begin_transcript_repair(
                    &request.meeting_id,
                    capture_generation,
                    &request.run_id,
                    &now(),
                )
            };
            match begin.map_err(|error| error.to_string())? {
                TranscriptRepairBegin::Collecting => {}
                TranscriptRepairBegin::AlreadyCommitted { revision } => {
                    return Err(format!(
                        "transcript repair generation was already committed at revision {revision}"
                    ));
                }
            }
        }
        let provider = self.provider_resolver.resolve(request)?;
        let diagnostics = ScribeDiagnostics::new(&self.data_dir, &request.meeting_id);
        let (provider_kind, provider_model) = match &provider {
            ResolvedTranscriptionProvider::Local { model_id } => ("local", model_id.as_str()),
            ResolvedTranscriptionProvider::Custom { endpoint, model }
                if is_openai_realtime_route(endpoint, model) =>
            {
                ("openai", model.as_str())
            }
            ResolvedTranscriptionProvider::Custom { model, .. } => ("custom", model.as_str()),
        };
        diagnostics.record(
            "transcription.worker.start",
            json!({
                "provider": provider_kind,
                "model": provider_model,
                "firstSequence": request.first_sequence,
                "repair": request.repair_generation.is_some(),
            }),
        );

        let (finalize_tx, finalize_rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let worker_request = request.clone();
        let end_sequence = Arc::new(AtomicU64::new(u64::MAX));
        let worker_end_sequence = Arc::clone(&end_sequence);
        let store = Arc::clone(&self.store);
        let data_dir = self.data_dir.clone();
        let credentials = Arc::clone(&self.credential_resolver);
        let local = Arc::clone(&self.local);
        let changes = Arc::clone(&self.changes);
        let state = Arc::new(Mutex::new(TranscriptionSessionState::Initializing));
        let worker_status = WorkerStatusReporter {
            meeting_id: request.meeting_id.clone(),
            state: Arc::clone(&state),
            changes: Arc::clone(&self.changes),
        };
        let failure_status = worker_status.clone();
        let worker_diagnostics = diagnostics.clone();
        let ready_status = if matches!(provider, ResolvedTranscriptionProvider::Custom { .. }) {
            TranscriptionSessionState::Listening
        } else {
            TranscriptionSessionState::Live
        };
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
                    worker_status,
                    worker_end_sequence,
                );
                if let Err(message) = &result {
                    // This succeeds only while the caller is still waiting for
                    // startup. Once Ready was consumed, the receiver is gone
                    // and a later runtime failure cannot masquerade as a
                    // second startup outcome.
                    let _ = startup_error.try_send(Err(message.clone()));
                    failure_status.set(TranscriptionSessionState::Failed);
                }
                worker_diagnostics.record(
                    "transcription.worker.finished",
                    match &result {
                        Ok(completion) => json!({
                            "ok": true,
                            "source": completion.source,
                            "unresolvedPartials": completion.unresolved_partial_count,
                        }),
                        Err(error) => json!({ "ok": false, "error": error }),
                    },
                );
                result
            })
            .map_err(|error| format!("could not spawn transcription worker: {error}"))?;
        let readiness_state = Arc::clone(&state);
        let readiness_changes = Arc::clone(&self.changes);
        let readiness_meeting_id = request.meeting_id.clone();
        let readiness = thread::Builder::new()
            .name(format!("mimir-stt-ready-{}", request.meeting_id))
            .spawn(move || {
                let next = match ready_rx.recv() {
                    Ok(Ok(())) => ready_status,
                    Ok(Err(_)) | Err(_) => TranscriptionSessionState::Failed,
                };
                if let Ok(mut state) = readiness_state.lock() {
                    // A worker can fail immediately after reporting Ready.
                    // Never let the slower observer overwrite that terminal
                    // failure with a stale Live projection.
                    if !matches!(
                        *state,
                        TranscriptionSessionState::Live | TranscriptionSessionState::Failed
                    ) {
                        *state = next;
                    }
                }
                readiness_changes.state_changed(&readiness_meeting_id);
            })
            .map_err(|error| {
                let _ = finalize_tx.send(FinalizeCommand { observed_at: now() });
                format!("could not monitor transcription worker startup: {error}")
            })?;

        sessions.insert(
            request.run_id.clone(),
            TranscriptionSession {
                meeting_id: request.meeting_id.clone(),
                end_sequence,
                finalize: finalize_tx,
                worker,
                readiness,
                state,
            },
        );
        Ok(())
    }

    fn seal(&self, meeting_id: &str, run_id: &str, end_sequence: u64) -> Result<(), String> {
        if let Some(session) = self.sessions()?.get(run_id) {
            if session.meeting_id != meeting_id {
                return Err("transcription run belongs to another meeting".into());
            }
            session.end_sequence.store(end_sequence, Ordering::Release);
        }
        Ok(())
    }

    fn finalize(&self, request: &TranscriptionFinalize) -> Result<TranscriptBatch, String> {
        let session = self.sessions()?.remove(&request.run_id).ok_or_else(|| {
            "Transcription is not active. Stored audio remains available for delayed repair."
                .to_string()
        })?;
        let finalize_sent = session
            .finalize
            .send(FinalizeCommand {
                observed_at: request.observed_at.clone(),
            })
            .is_ok();
        let completion = session
            .worker
            .join()
            .map_err(|_| "transcription worker panicked".to_string())?;
        session
            .readiness
            .join()
            .map_err(|_| "transcription startup observer panicked".to_string())?;
        let completion = completion.map_err(|error| {
            if finalize_sent {
                error
            } else {
                format!("Transcription stopped; recorded audio is safe for repair. {error}")
            }
        })?;
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

    fn status(&self, meeting_id: &str) -> TranscriptionWorkerStatus {
        let Ok(sessions) = self.sessions() else {
            return TranscriptionWorkerStatus::Delayed;
        };
        let current_run = self.store.get_meeting(meeting_id).ok().and_then(|meeting| {
            meeting
                .metadata
                .get("runId")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        });
        let Some(session) = current_run
            .as_ref()
            .and_then(|run| sessions.get(run))
            .or_else(|| {
                sessions
                    .values()
                    .find(|session| session.meeting_id == meeting_id)
            })
        else {
            return TranscriptionWorkerStatus::Delayed;
        };
        let status = match session.state.lock() {
            Ok(state) => match &*state {
                TranscriptionSessionState::Initializing => TranscriptionWorkerStatus::Initializing,
                TranscriptionSessionState::Connecting => TranscriptionWorkerStatus::Connecting,
                TranscriptionSessionState::Listening => TranscriptionWorkerStatus::Listening,
                TranscriptionSessionState::Live => TranscriptionWorkerStatus::Live,
                TranscriptionSessionState::Reconnecting => TranscriptionWorkerStatus::Reconnecting,
                TranscriptionSessionState::Failed => TranscriptionWorkerStatus::Failed,
            },
            Err(_) => TranscriptionWorkerStatus::Delayed,
        };
        status
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
    status: WorkerStatusReporter,
    end_sequence: Arc<AtomicU64>,
) -> Result<WorkerCompletion, String> {
    let mut audio =
        PersistedAudioSource::authoritative(Arc::clone(&store), &data_dir, &request.meeting_id)?;
    audio.end_sequence = end_sequence;
    let source = match &provider {
        ResolvedTranscriptionProvider::Local { .. } => "local",
        ResolvedTranscriptionProvider::Custom { .. } => "custom",
    };
    let diagnostics = ScribeDiagnostics::new(&data_dir, &request.meeting_id);
    let mut sink = StoreBatchSink::new(
        Arc::clone(&store),
        diagnostics.clone(),
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
            let (bridge_cancel_tx, bridge_cancel_rx) = mpsc::channel();
            let bridge = thread::Builder::new()
                .name(format!("mimir-stt-finalize-{}", request.meeting_id))
                .spawn(move || loop {
                    match finalize.recv_timeout(Duration::from_millis(25)) {
                        Ok(command) => {
                            let _ = local_tx.send(LocalFinalizeCommand {
                                observed_at: command.observed_at,
                            });
                            break;
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => {
                            if bridge_cancel_rx.try_recv().is_ok() {
                                break;
                            }
                        }
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                })
                .map_err(|error| format!("could not start local finalization bridge: {error}"))?;
            let run_result = local.run(LocalTranscriptionContext {
                meeting_id: &request.meeting_id,
                run_id: &request.run_id,
                model_id: &model_id,
                first_sequence: request.first_sequence,
                audio: &audio,
                finalize: &local_rx,
                sink: &mut sink,
            });
            let _ = bridge_cancel_tx.send(());
            let _ = bridge.join();
            run_result?;
        }
        ResolvedTranscriptionProvider::Custom { endpoint, model } => {
            status.set(TranscriptionSessionState::Connecting);
            let credential = resolve_custom_credential(credentials.as_ref(), &endpoint)?;
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|error| format!("could not initialize transcription runtime: {error}"))?;
            let context = CustomRunContext {
                request: &request,
                endpoint: &endpoint,
                model: &model,
                credential: credential.as_deref(),
                audio: &audio,
                finalize: &finalize,
                ready: &ready,
                status: &status,
                diagnostics: &diagnostics,
            };
            let mut reporting_sink = ReportingBatchSink {
                inner: &mut sink,
                status: status.clone(),
            };
            if is_openai_realtime_route(&endpoint, &model) {
                runtime.block_on(run_openai_realtime(context, &mut reporting_sink))?;
            } else {
                runtime.block_on(run_custom(context, &mut reporting_sink))?;
            }
        }
    }
    Ok(WorkerCompletion {
        source: source.into(),
        unresolved_partial_count: sink.accumulator.unresolved_partial_count(),
    })
}

fn resolve_custom_credential(
    resolver: &dyn MeetingCredentialResolver,
    endpoint: &CustomSttEndpoint,
) -> Result<Option<String>, String> {
    resolver
        .bearer_token(endpoint)
        .map_err(|_| "could not resolve custom transcription credential".to_string())
}

#[cfg(test)]
mod tests;
