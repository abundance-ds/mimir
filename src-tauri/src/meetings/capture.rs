//! Durable adapter from the realtime audio crate into meeting-owned chunks.
//!
//! Each source remains a separate 16 kHz mono f32le timeline. Device-rate
//! frames are resampled independently, explicit gaps are persisted as evidence,
//! and every one-second chunk is staged in SQLite before an atomic file replace
//! and committed only after the durable bytes exist.

use super::{
    runtime::{CaptureStart, CaptureStop, CaptureStopResult, MeetingCapturePort},
    AudioChunkDraft, AudioChunkStatus, MeetingStore, RecoveryReport,
};
use chrono::{SecondsFormat, Utc};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex, MutexGuard,
    },
    thread,
    time::Duration,
};
use tokio::sync::watch;

const CANONICAL_SAMPLE_RATE_HZ: u32 = 16_000;
const FRAME_MILLISECONDS: u64 = 20;
const CHUNK_SAMPLES: usize = CANONICAL_SAMPLE_RATE_HZ as usize;
const MINIMUM_FREE_BYTES: u64 = 512 * 1024 * 1024;
const START_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug)]
struct CaptureSession {
    stop: watch::Sender<bool>,
    microphone_muted: Arc<AtomicBool>,
    worker: thread::JoinHandle<Result<CaptureStopResult, String>>,
}

pub struct NativeMeetingCapture {
    store: Arc<MeetingStore>,
    data_dir: PathBuf,
    sessions: Mutex<HashMap<String, CaptureSession>>,
}

impl NativeMeetingCapture {
    pub fn new(store: Arc<MeetingStore>, data_dir: impl Into<PathBuf>) -> Result<Self, String> {
        let data_dir = data_dir.into();
        fs::create_dir_all(data_dir.join("audio"))
            .map_err(|error| format!("could not create meeting audio directory: {error}"))?;
        Ok(Self {
            store,
            data_dir,
            sessions: Mutex::new(HashMap::new()),
        })
    }

    fn sessions(&self) -> Result<MutexGuard<'_, HashMap<String, CaptureSession>>, String> {
        self.sessions
            .lock()
            .map_err(|_| "meeting capture session mutex was poisoned".into())
    }

    fn recover_chunk(&self, chunk: &super::AudioChunk) -> Result<(), String> {
        let path = contained_path(&self.data_dir, &chunk.definition.relative_path)?;
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) => {
                self.store
                    .mark_audio_chunk_corrupt(
                        &chunk.definition.id,
                        &format!("staged audio file is unavailable: {error}"),
                        &now(),
                    )
                    .map_err(|store_error| store_error.to_string())?;
                return Ok(());
            }
        };
        let checksum = sha256_hex(&bytes);
        if bytes.len() as u64 != chunk.definition.byte_len || checksum != chunk.definition.sha256 {
            self.store
                .mark_audio_chunk_corrupt(
                    &chunk.definition.id,
                    "staged audio file size or checksum does not match its durable record",
                    &now(),
                )
                .map_err(|error| error.to_string())?;
            return Ok(());
        }
        self.store
            .commit_audio_chunk(&chunk.definition.id, &now())
            .map_err(|error| error.to_string())?;
        Ok(())
    }
}

impl MeetingCapturePort for NativeMeetingCapture {
    fn recover(&self, report: &RecoveryReport) -> Result<(), String> {
        for chunk in &report.staged_audio_chunks {
            if chunk.status == AudioChunkStatus::Staged {
                self.recover_chunk(chunk)?;
            }
        }
        Ok(())
    }

    fn start(&self, request: &CaptureStart) -> Result<(), String> {
        let mut sessions = self.sessions()?;
        if sessions.contains_key(&request.meeting_id) {
            return Err(format!(
                "meeting '{}' already owns an audio capture worker",
                request.meeting_id
            ));
        }
        ensure_free_space(&self.data_dir)?;
        let (stop, stop_rx) = watch::channel(false);
        let microphone_muted = Arc::new(AtomicBool::new(false));
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let store = Arc::clone(&self.store);
        let data_dir = self.data_dir.clone();
        let request = request.clone();
        let meeting_id = request.meeting_id.clone();
        let worker_muted = Arc::clone(&microphone_muted);
        let worker = thread::Builder::new()
            .name(format!("mimir-audio-{}", request.meeting_id))
            .spawn(move || {
                run_capture_worker(store, data_dir, request, stop_rx, worker_muted, ready_tx)
            })
            .map_err(|error| format!("could not spawn meeting audio worker: {error}"))?;

        match ready_rx.recv_timeout(START_TIMEOUT) {
            Ok(Ok(())) => {
                sessions.insert(
                    meeting_id,
                    CaptureSession {
                        stop,
                        microphone_muted,
                        worker,
                    },
                );
                Ok(())
            }
            Ok(Err(message)) => {
                let _ = stop.send(true);
                let _ = worker.join();
                Err(message)
            }
            Err(error) => {
                let _ = stop.send(true);
                let _ = worker.join();
                Err(format!(
                    "meeting audio devices did not initialize within {} seconds: {error}",
                    START_TIMEOUT.as_secs()
                ))
            }
        }
    }

    fn stop(&self, request: &CaptureStop) -> Result<CaptureStopResult, String> {
        let session = self
            .sessions()?
            .remove(&request.meeting_id)
            .ok_or_else(|| format!("meeting '{}' has no audio worker", request.meeting_id))?;
        let _ = session.stop.send(true);
        session
            .worker
            .join()
            .map_err(|_| "meeting audio worker panicked".to_string())?
    }

    fn set_microphone_muted(
        &self,
        meeting_id: &str,
        _run_id: &str,
        muted: bool,
    ) -> Result<(), String> {
        let sessions = self.sessions()?;
        let session = sessions
            .get(meeting_id)
            .ok_or_else(|| format!("meeting '{meeting_id}' has no audio worker"))?;
        session.microphone_muted.store(muted, Ordering::Release);
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn run_capture_worker(
    store: Arc<MeetingStore>,
    data_dir: PathBuf,
    request: CaptureStart,
    mut stop: watch::Receiver<bool>,
    microphone_muted: Arc<AtomicBool>,
    ready: mpsc::SyncSender<Result<(), String>>,
) -> Result<CaptureStopResult, String> {
    use futures_util::StreamExt;
    use mimir_meeting_audio::{CaptureHealth, FrameDuration, MicrophoneInput, SystemAudioInput};

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .map_err(|error| format!("could not initialize meeting audio runtime: {error}"))?;
    runtime.block_on(async move {
        let microphone = match MicrophoneInput::open(None)
            .and_then(|input| input.start(FrameDuration::DEFAULT, CaptureHealth::default()))
        {
            Ok(stream) => stream,
            Err(error) => {
                let message = format!("microphone capture is unavailable: {error}");
                let _ = ready.send(Err(message.clone()));
                return Err(message);
            }
        };
        let system = match SystemAudioInput::open()
            .and_then(|input| input.start(FrameDuration::DEFAULT, CaptureHealth::default()))
        {
            Ok(stream) => stream,
            Err(error) => {
                let message = format!(
                    "system audio capture is unavailable; grant Screen & System Audio Recording permission and retry: {error}"
                );
                let _ = ready.send(Err(message.clone()));
                return Err(message);
            }
        };
        ready
            .send(Ok(()))
            .map_err(|_| "meeting capture caller stopped during initialization".to_string())?;

        tokio::pin!(microphone);
        tokio::pin!(system);
        let mut mic_writer = ChannelWriter::new(
            Arc::clone(&store),
            data_dir.clone(),
            request.meeting_id.clone(),
            "microphone",
        );
        let mut system_writer = ChannelWriter::new(
            store,
            data_dir,
            request.meeting_id.clone(),
            "system",
        );
        let mut microphone_open = true;
        let mut system_open = true;
        while microphone_open || system_open {
            tokio::select! {
                biased;
                changed = stop.changed() => {
                    if changed.is_err() || *stop.borrow() {
                        break;
                    }
                }
                frame = microphone.next(), if microphone_open => {
                    match frame {
                        Some(frame) => mic_writer.push_frame(
                            frame,
                            microphone_muted.load(Ordering::Acquire),
                        )?,
                        None => microphone_open = false,
                    }
                }
                frame = system.next(), if system_open => {
                    match frame {
                        Some(frame) => system_writer.push_frame(frame, false)?,
                        None => system_open = false,
                    }
                }
            }
        }
        mic_writer.finish()?;
        system_writer.finish()?;
        if !*stop.borrow() && (!microphone_open || !system_open) {
            return Err(
                "an audio device stopped unexpectedly; durable audio was finalized for recovery"
                    .into(),
            );
        }
        let duration_ms = mic_writer
            .duration_ms()
            .max(system_writer.duration_ms());
        Ok(CaptureStopResult { duration_ms })
    })
}

#[cfg(not(target_os = "macos"))]
fn run_capture_worker(
    _store: Arc<MeetingStore>,
    _data_dir: PathBuf,
    _request: CaptureStart,
    _stop: watch::Receiver<bool>,
    _microphone_muted: Arc<AtomicBool>,
    ready: mpsc::SyncSender<Result<(), String>>,
) -> Result<CaptureStopResult, String> {
    let message =
        "native meeting capture is supported only by the macOS arm64 Scribe release".to_string();
    let _ = ready.send(Err(message.clone()));
    Err(message)
}

#[cfg(target_os = "macos")]
struct ChannelWriter {
    store: Arc<MeetingStore>,
    data_dir: PathBuf,
    meeting_id: String,
    channel_id: &'static str,
    chunk_sequence: u64,
    canonical_samples: u64,
    buffer: Vec<f32>,
    gaps: Vec<PersistedGap>,
}

#[cfg(target_os = "macos")]
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedGap {
    sequence: u64,
    start_ms: u64,
    end_ms: u64,
    reason: String,
}

#[cfg(target_os = "macos")]
impl ChannelWriter {
    fn new(
        store: Arc<MeetingStore>,
        data_dir: PathBuf,
        meeting_id: String,
        channel_id: &'static str,
    ) -> Self {
        Self {
            store,
            data_dir,
            meeting_id,
            channel_id,
            chunk_sequence: 0,
            canonical_samples: 0,
            buffer: Vec::with_capacity(CHUNK_SAMPLES),
            gaps: Vec::new(),
        }
    }

    fn push_frame(
        &mut self,
        frame: mimir_meeting_audio::RawAudioFrame,
        muted: bool,
    ) -> Result<(), String> {
        let frame_start_ms = frame.sequence.saturating_mul(FRAME_MILLISECONDS);
        let mut input = Vec::with_capacity(frame.sample_count as usize);
        for span in frame.spans {
            match span {
                mimir_meeting_audio::RawAudioSpan::Samples { samples, .. } => {
                    if muted {
                        input.resize(input.len().saturating_add(samples.len()), 0.0);
                    } else {
                        input.extend(samples);
                    }
                }
                mimir_meeting_audio::RawAudioSpan::Gap(gap) => {
                    let sample_count = usize::try_from(gap.sample_count.unwrap_or(0))
                        .map_err(|_| "audio gap sample count exceeds this platform".to_string())?;
                    input.resize(input.len().saturating_add(sample_count), 0.0);
                    self.gaps.push(PersistedGap {
                        sequence: frame.sequence,
                        start_ms: frame_start_ms,
                        end_ms: frame_start_ms.saturating_add(FRAME_MILLISECONDS),
                        reason: format!("{:?}", gap.reason),
                    });
                }
            }
        }
        let target_samples =
            (CANONICAL_SAMPLE_RATE_HZ as u64 * FRAME_MILLISECONDS / 1_000) as usize;
        self.buffer.extend(resample_exact(&input, target_samples));
        self.canonical_samples = self.canonical_samples.saturating_add(target_samples as u64);
        while self.buffer.len() >= CHUNK_SAMPLES {
            let remainder = self.buffer.split_off(CHUNK_SAMPLES);
            let chunk = std::mem::replace(&mut self.buffer, remainder);
            self.persist_chunk(chunk)?;
        }
        Ok(())
    }

    fn finish(&mut self) -> Result<(), String> {
        if !self.buffer.is_empty() {
            let chunk = std::mem::take(&mut self.buffer);
            self.persist_chunk(chunk)?;
        }
        if !self.gaps.is_empty() {
            let relative = format!("audio/{}/{}/gaps.json", self.meeting_id, self.channel_id);
            let path = contained_path(&self.data_dir, &relative)?;
            crate::persistence::write_json_atomic(path, &self.gaps)
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    fn persist_chunk(&mut self, samples: Vec<f32>) -> Result<(), String> {
        ensure_free_space(&self.data_dir)?;
        let bytes = samples
            .iter()
            .flat_map(|sample| sample.to_le_bytes())
            .collect::<Vec<_>>();
        let sequence = self.chunk_sequence;
        let start_sample = sequence.saturating_mul(CHUNK_SAMPLES as u64);
        let end_sample = start_sample.saturating_add(samples.len() as u64);
        let start_ms = start_sample.saturating_mul(1_000) / CANONICAL_SAMPLE_RATE_HZ as u64;
        let end_ms = end_sample.saturating_mul(1_000) / CANONICAL_SAMPLE_RATE_HZ as u64;
        let relative = format!(
            "audio/{}/{}/{sequence:08}.f32le",
            self.meeting_id, self.channel_id
        );
        let draft = AudioChunkDraft {
            id: format!("{}-{}-{sequence:08}", self.meeting_id, self.channel_id),
            meeting_id: self.meeting_id.clone(),
            channel_id: self.channel_id.into(),
            sequence,
            start_ms: start_ms as i64,
            end_ms: end_ms.max(start_ms.saturating_add(1)) as i64,
            sample_count: samples.len() as u64,
            byte_len: bytes.len() as u64,
            sha256: sha256_hex(&bytes),
            relative_path: relative.clone(),
        };
        self.store
            .stage_audio_chunk(&draft, &now())
            .map_err(|error| error.to_string())?;
        let path = contained_path(&self.data_dir, &relative)?;
        crate::persistence::write_bytes_atomic(&path, &bytes).map_err(|error| error.to_string())?;
        self.store
            .commit_audio_chunk(&draft.id, &now())
            .map_err(|error| error.to_string())?;
        self.chunk_sequence = self.chunk_sequence.saturating_add(1);
        Ok(())
    }

    fn duration_ms(&self) -> u64 {
        self.canonical_samples.saturating_mul(1_000) / CANONICAL_SAMPLE_RATE_HZ as u64
    }
}

fn resample_exact(input: &[f32], output_len: usize) -> Vec<f32> {
    if output_len == 0 {
        return Vec::new();
    }
    if input.is_empty() {
        return vec![0.0; output_len];
    }
    if input.len() == output_len {
        return input.to_vec();
    }
    if output_len == 1 || input.len() == 1 {
        return vec![input[0]; output_len];
    }
    let scale = (input.len() - 1) as f64 / (output_len - 1) as f64;
    (0..output_len)
        .map(|index| {
            let position = index as f64 * scale;
            let left = position.floor() as usize;
            let right = (left + 1).min(input.len() - 1);
            let fraction = (position - left as f64) as f32;
            input[left] + (input[right] - input[left]) * fraction
        })
        .collect()
}

fn contained_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative = Path::new(relative);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("meeting audio path is not a contained relative path".into());
    }
    Ok(root.join(relative))
}

fn ensure_free_space(path: &Path) -> Result<(), String> {
    let available = fs2::available_space(path)
        .map_err(|error| format!("could not inspect free space for meeting audio: {error}"))?;
    if available < MINIMUM_FREE_BYTES {
        return Err(format!(
            "meeting recording needs at least {} MiB free; only {} MiB are available",
            MINIMUM_FREE_BYTES / 1024 / 1024,
            available / 1024 / 1024
        ));
    }
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resampling_keeps_exact_timeline_size_and_endpoints() {
        let output = resample_exact(&[0.0, 0.5, 1.0], 5);
        assert_eq!(output.len(), 5);
        assert_eq!(output[0], 0.0);
        assert_eq!(output[4], 1.0);
        assert!((output[2] - 0.5).abs() < f32::EPSILON);
    }

    #[test]
    fn empty_audio_becomes_explicit_timeline_silence_only_for_a_known_gap() {
        assert_eq!(resample_exact(&[], 4), vec![0.0; 4]);
    }

    #[test]
    fn contained_audio_paths_reject_escape_components() {
        let root = Path::new("/tmp/mimir-meetings");
        assert!(contained_path(root, "audio/meeting/mic/1.f32le").is_ok());
        assert!(contained_path(root, "../secret").is_err());
        assert!(contained_path(root, "/tmp/secret").is_err());
        assert_eq!(
            contained_path(root, "audio/./secret").unwrap(),
            root.join("audio/secret")
        );
    }
}
