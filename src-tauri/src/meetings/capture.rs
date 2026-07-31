//! Durable adapter from the realtime audio crate into meeting-owned chunks.
//!
//! Each source remains a separate 16 kHz mono f32le timeline. Device-rate
//! frames are resampled independently, explicit gaps are persisted as evidence,
//! and every one-second chunk is staged in SQLite before an atomic file replace
//! and committed only after the durable bytes exist.

use super::{
    runtime::{
        CaptureStart, CaptureStop, CaptureStopResult, MeetingCaptureFailureSink, MeetingCapturePort,
    },
    AudioChunkDraft, AudioChunkStatus, MeetingStore, MeetingStoreError, RecoveryReport,
    TranscriptBatch, TranscriptChange, TranscriptGapInput, TranscriptGapReason,
};
use crate::persistence::{
    ensure_private_directory, prepare_private_file_path, write_private_bytes_atomic,
    write_private_json_atomic,
};
use chrono::{SecondsFormat, Utc};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex, MutexGuard,
    },
    thread,
    time::{Duration, Instant},
};
use tokio::sync::watch;

const CANONICAL_SAMPLE_RATE_HZ: u32 = 16_000;
const FRAME_MILLISECONDS: u64 = 20;
const CHUNK_SAMPLES: usize = CANONICAL_SAMPLE_RATE_HZ as usize;
const MINIMUM_FREE_BYTES: u64 = 512 * 1024 * 1024;
const START_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_RESTART_ATTEMPTS: u8 = 6;
const RESTART_INITIAL_BACKOFF: Duration = Duration::from_millis(250);
const RESTART_MAX_BACKOFF: Duration = Duration::from_secs(4);
const RESTART_STABLE_MICROPHONE_FRAMES: u32 = 250;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RestartAttempt {
    number: u8,
    delay: Duration,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TimelineGapPlan {
    microphone_catch_up_frames: u64,
    system_catch_up_frames: u64,
    interruption_frames: u64,
}

/// Restart budget and timeline-continuity policy for one capture session.
///
/// Opening both devices successfully does not immediately reset the budget:
/// a driver that repeatedly opens and EOFs must still terminate. Five seconds
/// of microphone frames marks the replacement pair stable.
#[derive(Debug)]
struct CaptureRestartPolicy {
    failures: u8,
    stable_microphone_frames: u32,
    max_attempts: u8,
    initial_backoff: Duration,
    max_backoff: Duration,
    stable_frames_required: u32,
}

impl Default for CaptureRestartPolicy {
    fn default() -> Self {
        Self {
            failures: 0,
            stable_microphone_frames: 0,
            max_attempts: MAX_RESTART_ATTEMPTS,
            initial_backoff: RESTART_INITIAL_BACKOFF,
            max_backoff: RESTART_MAX_BACKOFF,
            stable_frames_required: RESTART_STABLE_MICROPHONE_FRAMES,
        }
    }
}

impl CaptureRestartPolicy {
    fn record_failure(&mut self) -> Option<RestartAttempt> {
        if self.failures >= self.max_attempts {
            return None;
        }
        self.failures = self.failures.saturating_add(1);
        self.stable_microphone_frames = 0;
        let shift = u32::from(self.failures.saturating_sub(1)).min(31);
        let multiplier = 1_u32.checked_shl(shift).unwrap_or(u32::MAX);
        let delay = self
            .initial_backoff
            .checked_mul(multiplier)
            .unwrap_or(self.max_backoff)
            .min(self.max_backoff);
        Some(RestartAttempt {
            number: self.failures,
            delay,
        })
    }

    fn record_microphone_frame(&mut self) {
        if self.failures == 0 {
            return;
        }
        self.stable_microphone_frames = self.stable_microphone_frames.saturating_add(1);
        if self.stable_microphone_frames >= self.stable_frames_required {
            self.failures = 0;
            self.stable_microphone_frames = 0;
        }
    }

    fn gap_plan(
        microphone_samples: u64,
        system_samples: u64,
        interruption: Duration,
    ) -> TimelineGapPlan {
        let aligned_samples = microphone_samples.max(system_samples);
        TimelineGapPlan {
            microphone_catch_up_frames: frames_for_samples(
                aligned_samples.saturating_sub(microphone_samples),
            ),
            system_catch_up_frames: frames_for_samples(
                aligned_samples.saturating_sub(system_samples),
            ),
            interruption_frames: frames_for_interruption(interruption),
        }
    }
}

fn frames_for_samples(samples: u64) -> u64 {
    samples.saturating_add(canonical_frame_samples().saturating_sub(1)) / canonical_frame_samples()
}

fn frames_for_interruption(interruption: Duration) -> u64 {
    let millis = interruption.as_millis().min(u128::from(u64::MAX)) as u64;
    millis
        .max(1)
        .saturating_add(FRAME_MILLISECONDS.saturating_sub(1))
        / FRAME_MILLISECONDS
}

const fn canonical_frame_samples() -> u64 {
    CANONICAL_SAMPLE_RATE_HZ as u64 * FRAME_MILLISECONDS / 1_000
}

struct StartupReadiness {
    sender: Option<mpsc::SyncSender<Result<(), String>>>,
}

impl StartupReadiness {
    fn new(sender: mpsc::SyncSender<Result<(), String>>) -> Self {
        Self {
            sender: Some(sender),
        }
    }

    /// Returns `true` only for the first report.
    fn report(&mut self, result: Result<(), String>) -> Result<bool, String> {
        let Some(sender) = self.sender.take() else {
            return Ok(false);
        };
        sender
            .send(result)
            .map_err(|_| "meeting capture caller stopped during initialization".to_string())?;
        Ok(true)
    }
}

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
    failure_sink: Arc<Mutex<Option<Arc<dyn MeetingCaptureFailureSink>>>>,
}

impl NativeMeetingCapture {
    pub fn new(store: Arc<MeetingStore>, data_dir: impl Into<PathBuf>) -> Result<Self, String> {
        let data_dir = data_dir.into();
        ensure_private_directory(&data_dir)
            .map_err(|error| format!("could not secure meeting audio directory: {error}"))?;
        Ok(Self {
            store,
            data_dir,
            sessions: Mutex::new(HashMap::new()),
            failure_sink: Arc::new(Mutex::new(None)),
        })
    }

    pub fn install_failure_sink(
        &self,
        sink: Arc<dyn MeetingCaptureFailureSink>,
    ) -> Result<(), String> {
        let mut current = self
            .failure_sink
            .lock()
            .map_err(|_| "meeting capture failure-sink mutex was poisoned".to_string())?;
        if current.is_some() {
            return Err("meeting capture failure sink is already installed".into());
        }
        *current = Some(sink);
        Ok(())
    }

    fn sessions(&self) -> Result<MutexGuard<'_, HashMap<String, CaptureSession>>, String> {
        self.sessions
            .lock()
            .map_err(|_| "meeting capture session mutex was poisoned".into())
    }

    fn recover_chunk(&self, chunk: &super::AudioChunk) -> Result<(), String> {
        let path = private_audio_path(&self.data_dir, &chunk.definition.relative_path)?;
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
        let finished = sessions
            .iter()
            .filter(|(_, session)| session.worker.is_finished())
            .map(|(meeting_id, _)| meeting_id.clone())
            .collect::<Vec<_>>();
        for meeting_id in finished {
            if let Some(session) = sessions.remove(&meeting_id) {
                let _ = session.worker.join();
            }
        }
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
        let worker_meeting_id = meeting_id.clone();
        let worker_run_id = request.run_id.clone();
        let worker_muted = Arc::clone(&microphone_muted);
        let failure_sink = Arc::clone(&self.failure_sink);
        let (startup_decision_tx, startup_decision_rx) = mpsc::sync_channel(1);
        let worker = thread::Builder::new()
            .name(format!("mimir-audio-{}", request.meeting_id))
            .spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    run_capture_worker(store, data_dir, request, stop_rx, worker_muted, ready_tx)
                }))
                .unwrap_or_else(|_| Err("meeting audio worker panicked".into()));
                let armed = startup_decision_rx.recv().unwrap_or(false);
                if armed {
                    if let Err(message) = &result {
                        let sink = failure_sink
                            .lock()
                            .ok()
                            .and_then(|sink| sink.as_ref().cloned());
                        if let Some(sink) = sink {
                            let meeting_id = worker_meeting_id.clone();
                            let run_id = worker_run_id.clone();
                            let message = message.clone();
                            let _ = thread::Builder::new()
                                .name("mimir-audio-failure".into())
                                .spawn(move || {
                                    sink.capture_failed(&meeting_id, &run_id, &message);
                                });
                        } else {
                            log::error!(
                                "Scribe capture '{worker_meeting_id}' failed without an installed failure sink: {message}"
                            );
                        }
                    }
                }
                result
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
                let _ = startup_decision_tx.send(true);
                Ok(())
            }
            Ok(Err(message)) => {
                let _ = startup_decision_tx.send(false);
                let _ = stop.send(true);
                let _ = worker.join();
                Err(message)
            }
            Err(error) => {
                let _ = startup_decision_tx.send(false);
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

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .map_err(|error| format!("could not initialize meeting audio runtime: {error}"))?;
    runtime.block_on(async move {
        let mut readiness = StartupReadiness::new(ready);
        let initial_streams = match open_native_streams() {
            Ok(streams) => streams,
            Err(error) => {
                let _ = readiness.report(Err(error.clone()));
                return Err(error);
            }
        };
        readiness.report(Ok(()))?;

        let mut mic_writer = ChannelWriter::new(
            Arc::clone(&store),
            data_dir.clone(),
            request.meeting_id.clone(),
            "microphone",
        );
        let mut system_writer =
            ChannelWriter::new(store, data_dir, request.meeting_id.clone(), "system");
        let mut streams = Some(initial_streams);
        let mut restart_policy = CaptureRestartPolicy::default();

        let capture_result: Result<(), String> = 'capture: loop {
            let pair = streams
                .as_mut()
                .expect("native streams are restored before capture resumes");
            let event = tokio::select! {
                biased;
                changed = stop.changed() => {
                    if changed.is_err() || *stop.borrow() {
                        CaptureLoopEvent::Stop
                    } else {
                        continue;
                    }
                }
                frame = pair.microphone.next() => {
                    match frame {
                        Some(frame) => CaptureLoopEvent::Microphone(frame),
                        None => CaptureLoopEvent::Interrupted(
                            "the microphone stream ended unexpectedly",
                        ),
                    }
                }
                frame = pair.system.next() => {
                    match frame {
                        Some(frame) => CaptureLoopEvent::System(frame),
                        None => CaptureLoopEvent::Interrupted(
                            "the system-audio process tap ended unexpectedly",
                        ),
                    }
                }
            };

            match event {
                CaptureLoopEvent::Stop => break Ok(()),
                CaptureLoopEvent::Microphone(frame) => {
                    if let Err(error) =
                        mic_writer.push_frame(frame, microphone_muted.load(Ordering::Acquire))
                    {
                        break Err(error);
                    }
                    restart_policy.record_microphone_frame();
                }
                CaptureLoopEvent::System(frame) => {
                    if let Err(error) = system_writer.push_frame(frame, false) {
                        break Err(error);
                    }
                }
                CaptureLoopEvent::Interrupted(reason) => {
                    // Always discard both streams. Keeping the surviving
                    // source would let the independent device clocks diverge
                    // and would hide part of the outage in only one track.
                    drop(streams.take());
                    let interrupted_at = Instant::now();
                    let mut last_failure = reason.to_string();

                    loop {
                        let Some(attempt) = restart_policy.record_failure() else {
                            if let Err(error) = apply_restart_gap(
                                &mut mic_writer,
                                &mut system_writer,
                                interrupted_at.elapsed(),
                                reason,
                            ) {
                                break 'capture Err(error);
                            }
                            break 'capture Err(restart_exhausted_message(
                                restart_policy.max_attempts,
                                &last_failure,
                            ));
                        };

                        if wait_for_stop(&mut stop, attempt.delay).await {
                            if let Err(error) = apply_restart_gap(
                                &mut mic_writer,
                                &mut system_writer,
                                interrupted_at.elapsed(),
                                "capture stopped while audio devices were reconnecting",
                            ) {
                                break 'capture Err(error);
                            }
                            break 'capture Ok(());
                        }

                        match open_native_streams() {
                            Ok(reopened) => {
                                if let Err(error) = apply_restart_gap(
                                    &mut mic_writer,
                                    &mut system_writer,
                                    interrupted_at.elapsed(),
                                    reason,
                                ) {
                                    break 'capture Err(error);
                                }
                                streams = Some(reopened);
                                break;
                            }
                            Err(error) => {
                                last_failure =
                                    format!("restart attempt {} failed: {error}", attempt.number);
                            }
                        }
                    }
                }
            }
        };

        drop(streams);
        let alignment_result = align_channel_writers(
            &mut mic_writer,
            &mut system_writer,
            "capture stopped while one channel was ahead",
        );
        let mic_finish = mic_writer.finish();
        let system_finish = system_writer.finish();
        let duration_ms = mic_writer.duration_ms().max(system_writer.duration_ms());
        combine_capture_results(
            capture_result,
            alignment_result,
            mic_finish,
            system_finish,
            duration_ms,
        )
    })
}

#[cfg(target_os = "macos")]
struct NativeCaptureStreams {
    microphone: std::pin::Pin<Box<mimir_meeting_audio::MicrophoneStream>>,
    system: std::pin::Pin<Box<mimir_meeting_audio::SystemAudioStream>>,
}

#[cfg(target_os = "macos")]
enum CaptureLoopEvent {
    Stop,
    Microphone(mimir_meeting_audio::RawAudioFrame),
    System(mimir_meeting_audio::RawAudioFrame),
    Interrupted(&'static str),
}

#[cfg(target_os = "macos")]
fn open_native_streams() -> Result<NativeCaptureStreams, String> {
    use mimir_meeting_audio::{CaptureHealth, FrameDuration, MicrophoneInput, SystemAudioInput};

    let microphone = MicrophoneInput::open(None)
        .and_then(|input| input.start(FrameDuration::DEFAULT, CaptureHealth::default()))
        .map_err(|error| {
            format!(
                "microphone capture is unavailable; reconnect or select an input device and verify Microphone permission: {error}"
            )
        })?;
    let system = SystemAudioInput::open()
        .and_then(|input| input.start(FrameDuration::DEFAULT, CaptureHealth::default()))
        .map_err(|error| {
            format!(
                "system audio capture is unavailable; verify Screen & System Audio Recording permission and the default output device: {error}"
            )
        })?;
    Ok(NativeCaptureStreams {
        microphone: Box::pin(microphone),
        system: Box::pin(system),
    })
}

#[cfg(target_os = "macos")]
async fn wait_for_stop(stop: &mut watch::Receiver<bool>, delay: Duration) -> bool {
    if *stop.borrow() {
        return true;
    }
    tokio::select! {
        biased;
        changed = stop.changed() => changed.is_err() || *stop.borrow(),
        _ = tokio::time::sleep(delay) => false,
    }
}

#[cfg(target_os = "macos")]
fn restart_exhausted_message(attempts: u8, last_failure: &str) -> String {
    format!(
        "audio capture could not recover after {attempts} attempts; reconnect or select the microphone and output devices, verify Microphone and Screen & System Audio Recording permissions, then stop and start the recording. Last failure: {last_failure}"
    )
}

#[cfg(target_os = "macos")]
fn apply_restart_gap(
    microphone: &mut ChannelWriter,
    system: &mut ChannelWriter,
    interruption: Duration,
    reason: &str,
) -> Result<(), String> {
    let plan = CaptureRestartPolicy::gap_plan(
        microphone.canonical_samples,
        system.canonical_samples,
        interruption,
    );
    microphone.push_timeline_gap_frames(
        plan.microphone_catch_up_frames,
        "microphone channel aligned before capture restart",
    )?;
    system.push_timeline_gap_frames(
        plan.system_catch_up_frames,
        "system channel aligned before capture restart",
    )?;
    microphone.push_timeline_gap_frames(plan.interruption_frames, reason)?;
    system.push_timeline_gap_frames(plan.interruption_frames, reason)?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn align_channel_writers(
    microphone: &mut ChannelWriter,
    system: &mut ChannelWriter,
    reason: &str,
) -> Result<(), String> {
    let aligned_samples = microphone.canonical_samples.max(system.canonical_samples);
    microphone.push_timeline_gap_frames(
        frames_for_samples(aligned_samples.saturating_sub(microphone.canonical_samples)),
        reason,
    )?;
    system.push_timeline_gap_frames(
        frames_for_samples(aligned_samples.saturating_sub(system.canonical_samples)),
        reason,
    )?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn combine_capture_results(
    capture: Result<(), String>,
    alignment: Result<(), String>,
    microphone_finish: Result<(), String>,
    system_finish: Result<(), String>,
    duration_ms: u64,
) -> Result<CaptureStopResult, String> {
    let mut failures = Vec::new();
    for result in [capture, alignment, microphone_finish, system_finish] {
        if let Err(error) = result {
            failures.push(error);
        }
    }
    if failures.is_empty() {
        Ok(CaptureStopResult { duration_ms })
    } else {
        Err(failures.join("; "))
    }
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
        frame
            .validate()
            .map_err(|error| format!("audio backend emitted an invalid frame: {error}"))?;
        let frame_start_ms = self.duration_ms();
        let timeline_sequence = self.canonical_samples / canonical_frame_samples();
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
                    self.record_gap(PersistedGap {
                        sequence: timeline_sequence,
                        start_ms: frame_start_ms,
                        end_ms: frame_start_ms.saturating_add(FRAME_MILLISECONDS),
                        reason: bounded_gap_reason(&format!("{:?}", gap.reason)),
                    })?;
                }
            }
        }
        let target_samples =
            (CANONICAL_SAMPLE_RATE_HZ as u64 * FRAME_MILLISECONDS / 1_000) as usize;
        let canonical = resample_exact(&input, target_samples);
        self.push_canonical_samples(&canonical)
    }

    fn push_timeline_gap_frames(&mut self, frames: u64, reason: &str) -> Result<(), String> {
        if frames == 0 {
            return Ok(());
        }
        let start_sample = self.canonical_samples;
        let gap_samples = frames
            .checked_mul(canonical_frame_samples())
            .ok_or_else(|| "capture restart gap exceeds the meeting timeline".to_string())?;
        let end_sample = start_sample
            .checked_add(gap_samples)
            .ok_or_else(|| "capture restart gap overflows the meeting timeline".to_string())?;
        self.record_gap(PersistedGap {
            sequence: start_sample / canonical_frame_samples(),
            start_ms: start_sample.saturating_mul(1_000) / CANONICAL_SAMPLE_RATE_HZ as u64,
            end_ms: end_sample.saturating_mul(1_000) / CANONICAL_SAMPLE_RATE_HZ as u64,
            reason: bounded_gap_reason(reason),
        })?;

        let mut remaining = gap_samples;
        while remaining > 0 {
            let space = CHUNK_SAMPLES.saturating_sub(self.buffer.len()).max(1);
            let take = remaining.min(space as u64) as usize;
            self.buffer
                .resize(self.buffer.len().saturating_add(take), 0.0);
            self.canonical_samples = self
                .canonical_samples
                .checked_add(take as u64)
                .ok_or_else(|| "canonical meeting audio timeline overflowed".to_string())?;
            remaining = remaining.saturating_sub(take as u64);
            self.persist_full_chunks()?;
        }
        self.flush_gap_manifest()
    }

    fn record_gap(&mut self, gap: PersistedGap) -> Result<(), String> {
        self.persist_transcript_gap(&gap)?;
        self.gaps.push(gap);
        Ok(())
    }

    fn persist_transcript_gap(&self, gap: &PersistedGap) -> Result<(), String> {
        let start_ms = i64::try_from(gap.start_ms)
            .map_err(|_| "capture gap start exceeds the transcript timeline".to_string())?;
        let end_ms = i64::try_from(gap.end_ms)
            .map_err(|_| "capture gap end exceeds the transcript timeline".to_string())?;
        let stable = format!(
            "capture-gap-{}-{}-{}",
            self.channel_id, gap.sequence, gap.start_ms
        );
        let change = TranscriptChange::OpenGap {
            gap: TranscriptGapInput {
                id: stable.clone(),
                start_ms,
                end_ms,
                reason: transcript_gap_reason(&gap.reason),
                channel_id: Some(self.channel_id.into()),
                detail: Some(gap.reason.clone()),
            },
        };
        for _ in 0..8 {
            let base_revision = self
                .store
                .get_meeting(&self.meeting_id)
                .map_err(|error| error.to_string())?
                .transcript_revision;
            let batch = TranscriptBatch {
                meeting_id: self.meeting_id.clone(),
                batch_id: stable.clone(),
                base_revision,
                source: "native-capture".into(),
                observed_at: now(),
                marks_final: false,
                changes: vec![change.clone()],
            };
            match self.store.apply_transcript_batch(&batch) {
                Ok(_) => return Ok(()),
                Err(MeetingStoreError::RevisionConflict { .. }) => continue,
                Err(error) => return Err(error.to_string()),
            }
        }
        Err("capture gap could not join the transcript revision after bounded retries".into())
    }

    fn push_canonical_samples(&mut self, samples: &[f32]) -> Result<(), String> {
        self.buffer.extend_from_slice(samples);
        self.canonical_samples = self
            .canonical_samples
            .checked_add(samples.len() as u64)
            .ok_or_else(|| "canonical meeting audio timeline overflowed".to_string())?;
        self.persist_full_chunks()
    }

    fn persist_full_chunks(&mut self) -> Result<(), String> {
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
        self.flush_gap_manifest()
    }

    fn flush_gap_manifest(&self) -> Result<(), String> {
        if self.gaps.is_empty() {
            return Ok(());
        }
        let relative = format!("{}/audio/{}/gaps.json", self.meeting_id, self.channel_id);
        let path = private_audio_path(&self.data_dir, &relative)?;
        write_private_json_atomic(path, &self.gaps).map_err(|error| error.to_string())
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
            "{}/audio/{}/{sequence:08}.f32le",
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
        let path = private_audio_path(&self.data_dir, &relative)?;
        write_private_bytes_atomic(&path, &bytes).map_err(|error| error.to_string())?;
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

fn private_audio_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    prepare_private_file_path(root, relative)
        .map_err(|error| format!("meeting audio path is not a safe contained path: {error}"))
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

fn bounded_gap_reason(value: &str) -> String {
    value.chars().take(512).collect()
}

fn transcript_gap_reason(value: &str) -> TranscriptGapReason {
    let value = value.to_ascii_lowercase();
    if value.contains("overflow") || value.contains("dropped") || value.contains("lag") {
        TranscriptGapReason::BufferOverflow
    } else if value.contains("device")
        || value.contains("route")
        || value.contains("restart")
        || value.contains("stream ended")
    {
        TranscriptGapReason::DeviceChanged
    } else if value.contains("permission") || value.contains("unavailable") {
        TranscriptGapReason::CaptureUnavailable
    } else {
        TranscriptGapReason::Unknown
    }
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restart_backoff_is_exponential_capped_and_bounded() {
        let mut policy = CaptureRestartPolicy {
            max_attempts: 5,
            initial_backoff: Duration::from_millis(100),
            max_backoff: Duration::from_millis(350),
            stable_frames_required: 3,
            ..CaptureRestartPolicy::default()
        };

        let attempts = (0..5)
            .map(|_| policy.record_failure().unwrap())
            .collect::<Vec<_>>();

        assert_eq!(
            attempts,
            vec![
                RestartAttempt {
                    number: 1,
                    delay: Duration::from_millis(100)
                },
                RestartAttempt {
                    number: 2,
                    delay: Duration::from_millis(200)
                },
                RestartAttempt {
                    number: 3,
                    delay: Duration::from_millis(350)
                },
                RestartAttempt {
                    number: 4,
                    delay: Duration::from_millis(350)
                },
                RestartAttempt {
                    number: 5,
                    delay: Duration::from_millis(350)
                },
            ]
        );
        assert_eq!(policy.record_failure(), None);
    }

    #[test]
    fn reopening_does_not_reset_budget_until_stream_is_stable() {
        let mut policy = CaptureRestartPolicy {
            max_attempts: 3,
            stable_frames_required: 3,
            ..CaptureRestartPolicy::default()
        };

        assert_eq!(policy.record_failure().unwrap().number, 1);
        policy.record_microphone_frame();
        policy.record_microphone_frame();
        assert_eq!(policy.record_failure().unwrap().number, 2);
        policy.record_microphone_frame();
        policy.record_microphone_frame();
        policy.record_microphone_frame();
        assert_eq!(policy.record_failure().unwrap().number, 1);
    }

    #[test]
    fn restart_gap_plan_aligns_channels_and_rounds_outage_up() {
        let frame = canonical_frame_samples();
        let plan = CaptureRestartPolicy::gap_plan(
            frame.saturating_mul(7),
            frame.saturating_mul(5),
            Duration::from_millis(21),
        );

        assert_eq!(
            plan,
            TimelineGapPlan {
                microphone_catch_up_frames: 0,
                system_catch_up_frames: 2,
                interruption_frames: 2,
            }
        );
        let microphone_resume = 7 + plan.microphone_catch_up_frames + plan.interruption_frames;
        let system_resume = 5 + plan.system_catch_up_frames + plan.interruption_frames;
        assert_eq!(microphone_resume, system_resume);
    }

    #[test]
    fn even_an_immediate_restart_persists_one_explicit_gap_frame() {
        assert_eq!(frames_for_interruption(Duration::ZERO), 1);
        assert_eq!(frames_for_interruption(Duration::from_millis(20)), 1);
        assert_eq!(frames_for_interruption(Duration::from_millis(21)), 2);
    }

    #[test]
    fn startup_readiness_reports_only_the_initial_outcome() {
        let (sender, receiver) = mpsc::sync_channel(2);
        let mut readiness = StartupReadiness::new(sender);

        assert!(readiness.report(Ok(())).unwrap());
        assert!(!readiness
            .report(Err("a later restart failed".into()))
            .unwrap());
        assert_eq!(receiver.recv().unwrap(), Ok(()));
        assert!(receiver.try_recv().is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn restarted_stream_sequence_keeps_one_continuous_durable_timeline() {
        use crate::meetings::{
            AudioChannelDraft, AudioChannelKind, MeetingDraft, MeetingOrigin, MeetingStatus,
        };
        use mimir_meeting_audio::{AudioFormat, AudioSource, RawAudioFrame, RawAudioSpan};
        use serde_json::json;
        use tempfile::tempdir;

        let directory = tempdir().unwrap();
        let store = Arc::new(MeetingStore::open_in_memory().unwrap());
        store
            .create_meeting(
                &MeetingDraft {
                    id: "restart-meeting".into(),
                    title: "Restart test".into(),
                    origin: MeetingOrigin::default(),
                    channels: vec![AudioChannelDraft {
                        id: "microphone".into(),
                        kind: AudioChannelKind::Microphone,
                        sample_rate_hz: CANONICAL_SAMPLE_RATE_HZ,
                        channels: 1,
                        sample_format: "f32le".into(),
                        device_id: None,
                    }],
                    metadata: json!({}),
                },
                "2026-07-31T10:00:00Z",
            )
            .unwrap();
        store
            .transition_meeting(
                "restart-meeting",
                0,
                MeetingStatus::Recording,
                "2026-07-31T10:00:01Z",
                None,
            )
            .unwrap();
        let mut writer = ChannelWriter::new(
            Arc::clone(&store),
            directory.path().to_path_buf(),
            "restart-meeting".into(),
            "microphone",
        );
        let samples_per_frame = canonical_frame_samples();
        let frame = |sequence, start_sample, value| RawAudioFrame {
            source: AudioSource::Microphone,
            sequence,
            format: AudioFormat::mono(CANONICAL_SAMPLE_RATE_HZ).unwrap(),
            start_sample,
            sample_count: samples_per_frame,
            spans: vec![RawAudioSpan::Samples {
                start_sample,
                samples: vec![value; samples_per_frame as usize],
            }],
        };

        writer.push_frame(frame(99, 31_680, 1.0), false).unwrap();
        writer
            .push_timeline_gap_frames(2, "default input device changed")
            .unwrap();
        // A replacement backend starts its own sequence/sample clock at zero.
        writer.push_frame(frame(0, 0, 2.0), false).unwrap();
        writer.finish().unwrap();

        assert_eq!(writer.duration_ms(), 80);
        let bytes = fs::read(
            directory
                .path()
                .join("restart-meeting/audio/microphone/00000000.f32le"),
        )
        .unwrap();
        let samples = bytes
            .chunks_exact(4)
            .map(|bytes| f32::from_le_bytes(bytes.try_into().unwrap()))
            .collect::<Vec<_>>();
        assert_eq!(samples.len(), samples_per_frame as usize * 4);
        assert!(samples[..samples_per_frame as usize]
            .iter()
            .all(|sample| *sample == 1.0));
        assert!(
            samples[samples_per_frame as usize..samples_per_frame as usize * 3]
                .iter()
                .all(|sample| *sample == 0.0)
        );
        assert!(samples[samples_per_frame as usize * 3..]
            .iter()
            .all(|sample| *sample == 2.0));

        let gaps: serde_json::Value = serde_json::from_slice(
            &fs::read(
                directory
                    .path()
                    .join("restart-meeting/audio/microphone/gaps.json"),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(gaps[0]["startMs"], 20);
        assert_eq!(gaps[0]["endMs"], 60);
        assert_eq!(gaps[0]["reason"], "default input device changed");
        let transcript = store.transcript_snapshot("restart-meeting", None).unwrap();
        assert_eq!(transcript.gaps.len(), 1);
        assert_eq!(
            transcript.gaps[0].gap.reason,
            TranscriptGapReason::DeviceChanged
        );
        assert_eq!(
            transcript.gaps[0].gap.channel_id.as_deref(),
            Some("microphone")
        );
    }

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
    fn private_audio_paths_reject_escape_components() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("mimir-meetings");
        fs::create_dir(&root).unwrap();
        assert!(private_audio_path(&root, "meeting/audio/mic/1.f32le").is_ok());
        assert!(private_audio_path(&root, "../secret").is_err());
        assert!(private_audio_path(&root, "/tmp/secret").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn private_audio_path_refuses_a_symlinked_parent_component() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("meetings");
        let outside = directory.path().join("outside");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&outside).unwrap();
        symlink(&outside, root.join("meeting-1")).unwrap();

        assert!(private_audio_path(&root, "meeting-1/audio/microphone/00000000.f32le").is_err());
        assert!(!outside.join("audio").exists());
    }
}
