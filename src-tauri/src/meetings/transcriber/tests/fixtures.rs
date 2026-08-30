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

    fn state_changed(&self, _meeting_id: &str) {}
}

fn test_status_reporter() -> WorkerStatusReporter {
    WorkerStatusReporter {
        meeting_id: "meeting-1".into(),
        state: Arc::new(Mutex::new(TranscriptionSessionState::Initializing)),
        changes: Arc::new(NoopTranscriptionChangeSink),
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

struct SlowStartingLocal {
    release: Mutex<Receiver<()>>,
}

impl LocalTranscriber for SlowStartingLocal {
    fn verify(&self, model_id: &str) -> Result<VerifiedLocalRuntime, String> {
        self.release
            .lock()
            .map_err(|_| "slow local release mutex was poisoned".to_string())?
            .recv()
            .map_err(|_| "slow local release was dropped".to_string())?;
        Ok(VerifiedLocalRuntime {
            runtime_id: "slow-test-runtime".into(),
            runtime_version: "1".into(),
            model_sha256: format!("verified-{model_id}"),
        })
    }

    fn run(&self, context: LocalTranscriptionContext<'_>) -> Result<(), String> {
        context
            .finalize
            .recv()
            .map_err(|_| "slow local finalization channel closed".to_string())?;
        Ok(())
    }
}

struct FailingAfterReadyLocal;

impl LocalTranscriber for FailingAfterReadyLocal {
    fn verify(&self, model_id: &str) -> Result<VerifiedLocalRuntime, String> {
        Ok(VerifiedLocalRuntime {
            runtime_id: "ready-then-fail-runtime".into(),
            runtime_version: "1".into(),
            model_sha256: format!("verified-{model_id}"),
        })
    }

    fn run(&self, _context: LocalTranscriptionContext<'_>) -> Result<(), String> {
        Err("inference worker stopped".into())
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

