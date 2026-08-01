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
    AudioChannelDraft, AudioChannelKind, AudioChunkDraft, AudioChunkStatus, MeetingStore,
    MeetingStoreError, RecoveryReport, TranscriptBatch, TranscriptChange, TranscriptGapInput,
    TranscriptGapReason,
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
const FRAME_MILLISECONDS_DURATION: Duration = Duration::from_millis(FRAME_MILLISECONDS);
const CHUNK_SAMPLES: usize = CANONICAL_SAMPLE_RATE_HZ as usize;
const MINIMUM_FREE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_RESTART_ATTEMPTS: u8 = 6;
const RESTART_INITIAL_BACKOFF: Duration = Duration::from_millis(250);
const RESTART_MAX_BACKOFF: Duration = Duration::from_secs(4);
const RESTART_STABLE_MICROPHONE_FRAMES: u32 = 250;
// CoreAudio delivers microphone and process-tap callbacks independently. A
// stop can therefore observe a few callbacks from one source after the last
// callback from the other even though neither source failed. Keep the durable
// tracks aligned, but do not misrepresent this bounded scheduling skew as
// missing meeting audio. Larger divergence remains an explicit capture gap.
const MAX_CALLBACK_STOP_SKEW_FRAMES: u64 = 13;
const SYSTEM_GAP_CHECKPOINT_FRAMES: u64 = 1_500;

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

fn is_bounded_callback_stop_skew(microphone_frames: u64, system_frames: u64) -> bool {
    microphone_frames.max(system_frames) <= MAX_CALLBACK_STOP_SKEW_FRAMES
}

const fn canonical_frame_samples() -> u64 {
    CANONICAL_SAMPLE_RATE_HZ as u64 * FRAME_MILLISECONDS / 1_000
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CaptureWorkerPhase {
    Opening,
    StopRequested,
    Capturing,
    Finished,
}

#[derive(Debug)]
struct CaptureStartupState {
    phase: Mutex<CaptureWorkerPhase>,
}

impl CaptureStartupState {
    fn opening() -> Self {
        Self {
            phase: Mutex::new(CaptureWorkerPhase::Opening),
        }
    }

    /// Atomically hands successfully opened streams to the capture loop.
    /// A Stop that won the race keeps ownership and prevents callbacks from
    /// becoming live after the renderer already finalized the meeting.
    fn begin_capture(&self) -> Result<bool, String> {
        let mut phase = self
            .phase
            .lock()
            .map_err(|_| "meeting capture startup state was poisoned".to_string())?;
        match *phase {
            CaptureWorkerPhase::Opening => {
                *phase = CaptureWorkerPhase::Capturing;
                Ok(true)
            }
            CaptureWorkerPhase::StopRequested => Ok(false),
            CaptureWorkerPhase::Capturing => {
                Err("meeting capture worker attempted to start twice".into())
            }
            CaptureWorkerPhase::Finished => Ok(false),
        }
    }

    fn request_stop(&self) -> Result<StopDisposition, String> {
        let mut phase = self
            .phase
            .lock()
            .map_err(|_| "meeting capture startup state was poisoned".to_string())?;
        match *phase {
            CaptureWorkerPhase::Opening => {
                *phase = CaptureWorkerPhase::StopRequested;
                Ok(StopDisposition::ReapOpeningWorker)
            }
            CaptureWorkerPhase::StopRequested => Ok(StopDisposition::ReapOpeningWorker),
            CaptureWorkerPhase::Capturing | CaptureWorkerPhase::Finished => {
                Ok(StopDisposition::JoinOwnedWorker)
            }
        }
    }

    fn finish(&self) {
        if let Ok(mut phase) = self.phase.lock() {
            *phase = CaptureWorkerPhase::Finished;
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StopDisposition {
    ReapOpeningWorker,
    JoinOwnedWorker,
}

struct CaptureWorkerContext {
    store: Arc<MeetingStore>,
    data_dir: PathBuf,
    request: CaptureStart,
    stop: watch::Receiver<bool>,
    microphone_muted: Arc<AtomicBool>,
    startup: Arc<CaptureStartupState>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CaptureSourcePlan {
    microphone_channel_id: String,
    system_channel_id: Option<String>,
}

impl CaptureSourcePlan {
    fn from_channels(channels: &[AudioChannelDraft]) -> Result<Self, String> {
        let microphone = channels
            .iter()
            .filter(|channel| channel.kind == AudioChannelKind::Microphone)
            .collect::<Vec<_>>();
        if microphone.len() != 1 {
            return Err(
                "meeting capture requires exactly one authorized microphone channel".into(),
            );
        }
        let system = channels
            .iter()
            .filter(|channel| channel.kind == AudioChannelKind::System)
            .collect::<Vec<_>>();
        if system.len() > 1 {
            return Err("meeting capture permits at most one authorized system channel".into());
        }
        let microphone_channel_id = microphone[0].id.trim();
        if microphone_channel_id.is_empty() {
            return Err("authorized microphone channel id cannot be empty".into());
        }
        let system_channel_id = system
            .first()
            .map(|channel| channel.id.trim())
            .map(|channel_id| {
                if channel_id.is_empty() {
                    Err("authorized system channel id cannot be empty".to_string())
                } else {
                    Ok(channel_id.to_string())
                }
            })
            .transpose()?;
        Ok(Self {
            microphone_channel_id: microphone_channel_id.to_string(),
            system_channel_id,
        })
    }
}

#[cfg(test)]
impl CaptureWorkerContext {
    fn begin_capture(&self) -> Result<bool, String> {
        self.startup.begin_capture()
    }
}

trait CaptureWorkerRunner: Send + Sync {
    fn run(&self, context: CaptureWorkerContext) -> Result<CaptureStopResult, String>;
}

struct NativeCaptureWorkerRunner;

impl CaptureWorkerRunner for NativeCaptureWorkerRunner {
    fn run(&self, context: CaptureWorkerContext) -> Result<CaptureStopResult, String> {
        run_capture_worker(context)
    }
}

#[derive(Debug)]
struct CaptureSession {
    stop: watch::Sender<bool>,
    microphone_muted: Arc<AtomicBool>,
    startup: Arc<CaptureStartupState>,
    worker: thread::JoinHandle<Result<CaptureStopResult, String>>,
}

pub struct NativeMeetingCapture {
    store: Arc<MeetingStore>,
    data_dir: PathBuf,
    sessions: Mutex<HashMap<String, CaptureSession>>,
    failure_sink: Arc<Mutex<Option<Arc<dyn MeetingCaptureFailureSink>>>>,
    startup_cleanup_pending: Arc<AtomicBool>,
    worker_runner: Arc<dyn CaptureWorkerRunner>,
}

impl NativeMeetingCapture {
    pub fn new(store: Arc<MeetingStore>, data_dir: impl Into<PathBuf>) -> Result<Self, String> {
        Self::with_worker(store, data_dir, Arc::new(NativeCaptureWorkerRunner))
    }

    fn with_worker(
        store: Arc<MeetingStore>,
        data_dir: impl Into<PathBuf>,
        worker_runner: Arc<dyn CaptureWorkerRunner>,
    ) -> Result<Self, String> {
        let data_dir = data_dir.into();
        ensure_private_directory(&data_dir)
            .map_err(|error| format!("could not secure meeting audio directory: {error}"))?;
        Ok(Self {
            store,
            data_dir,
            sessions: Mutex::new(HashMap::new()),
            failure_sink: Arc::new(Mutex::new(None)),
            startup_cleanup_pending: Arc::new(AtomicBool::new(false)),
            worker_runner,
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
        if self.startup_cleanup_pending.load(Ordering::Acquire) {
            return Err(
                "a timed-out meeting audio startup is still being reclaimed; retry after it exits"
                    .into(),
            );
        }
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
        let startup = Arc::new(CaptureStartupState::opening());
        let context = CaptureWorkerContext {
            store: Arc::clone(&self.store),
            data_dir: self.data_dir.clone(),
            request: request.clone(),
            stop: stop_rx,
            microphone_muted: Arc::clone(&microphone_muted),
            startup: Arc::clone(&startup),
        };
        let meeting_id = request.meeting_id.clone();
        let worker_meeting_id = meeting_id.clone();
        let worker_run_id = request.run_id.clone();
        let failure_sink = Arc::clone(&self.failure_sink);
        let worker_startup = Arc::clone(&startup);
        let runner = Arc::clone(&self.worker_runner);
        let (registered_tx, registered_rx) = mpsc::sync_channel(1);
        let worker = thread::Builder::new()
            .name(format!("mimir-audio-{}", request.meeting_id))
            .spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    runner.run(context)
                }))
                .unwrap_or_else(|_| Err("meeting audio worker panicked".into()));
                worker_startup.finish();
                let registered = registered_rx.recv().unwrap_or(false);
                if registered {
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
        sessions.insert(
            meeting_id,
            CaptureSession {
                stop,
                microphone_muted,
                startup,
                worker,
            },
        );
        // A device can reject synchronously on the worker thread. Do not let
        // that terminal callback race the session-map insertion above.
        let _ = registered_tx.send(true);
        Ok(())
    }

    fn stop(&self, request: &CaptureStop) -> Result<CaptureStopResult, String> {
        let session = self
            .sessions()?
            .remove(&request.meeting_id)
            .ok_or_else(|| format!("meeting '{}' has no audio worker", request.meeting_id))?;
        let _ = session.stop.send(true);
        match session.startup.request_stop()? {
            StopDisposition::ReapOpeningWorker => {
                reap_startup_worker(
                    "stopped meeting audio startup",
                    session.worker,
                    Arc::clone(&self.startup_cleanup_pending),
                );
                Ok(CaptureStopResult { duration_ms: 0 })
            }
            StopDisposition::JoinOwnedWorker => session
                .worker
                .join()
                .map_err(|_| "meeting audio worker panicked".to_string())?,
        }
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

fn reap_startup_worker<T: Send + 'static>(
    label: &'static str,
    worker: thread::JoinHandle<T>,
    pending: Arc<AtomicBool>,
) {
    pending.store(true, Ordering::Release);
    let reaper_pending = Arc::clone(&pending);
    if let Err(error) = thread::Builder::new()
        .name("mimir-audio-startup-reaper".into())
        .spawn(move || {
            if worker.join().is_err() {
                log::error!("{label} panicked while being reclaimed");
            }
            reaper_pending.store(false, Ordering::Release);
        })
    {
        // The worker handle is detached when spawning the reaper fails. Keep
        // the gate closed for this process because its completion can no
        // longer be observed safely; an application restart resets ownership.
        log::error!("Could not reclaim {label} in the background: {error}");
    }
}

#[cfg(target_os = "macos")]
fn run_capture_worker(context: CaptureWorkerContext) -> Result<CaptureStopResult, String> {
    use futures_util::StreamExt;

    let CaptureWorkerContext {
        store,
        data_dir,
        request,
        mut stop,
        microphone_muted,
        startup,
    } = context;

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .map_err(|error| format!("could not initialize meeting audio runtime: {error}"))?;
    runtime.block_on(async move {
        let source_plan = CaptureSourcePlan::from_channels(&request.channels)?;
        let initial_microphone = open_microphone_stream(request.microphone_device_id.as_deref())?;
        if !startup.begin_capture()? {
            drop(initial_microphone);
            return Ok(CaptureStopResult { duration_ms: 0 });
        }

        let mut mic_writer = ChannelWriter::new(
            Arc::clone(&store),
            data_dir.clone(),
            request.meeting_id.clone(),
            source_plan.microphone_channel_id,
        );
        let mut system_writer = source_plan.system_channel_id.map(|channel_id| {
            ChannelWriter::new(store, data_dir, request.meeting_id.clone(), channel_id)
        });
        let mut microphone = Some(initial_microphone);
        let mut system: Option<SystemAudioStream> = None;
        let mut system_open = None;
        let mut system_retry = SystemRetryPolicy::default();
        let mut system_retry_at = Instant::now();
        let mut system_outage = system_writer.as_ref().map(|_| {
            SystemChannelOutage::new(
                "system audio was unavailable while its process tap was opening",
            )
        });
        let mut system_maintenance = tokio::time::interval(FRAME_MILLISECONDS_DURATION);
        system_maintenance.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut restart_policy = CaptureRestartPolicy::default();

        let capture_result: Result<(), String> = 'capture: loop {
            let event = tokio::select! {
                biased;
                changed = stop.changed() => {
                    if changed.is_err() || *stop.borrow() {
                        CaptureLoopEvent::Stop
                    } else {
                        continue;
                    }
                }
                _ = system_maintenance.tick(), if system_writer.is_some() => {
                    CaptureLoopEvent::MaintainSystem
                }
                frame = async { microphone.as_mut().expect("guarded microphone").next().await }, if microphone.is_some() => {
                    match frame {
                        Some(frame) => CaptureLoopEvent::Microphone(frame),
                        None => CaptureLoopEvent::MicrophoneInterrupted(
                            "the microphone stream ended unexpectedly",
                        ),
                    }
                }
                frame = async { system.as_mut().expect("guarded system stream").next().await }, if system.is_some() => {
                    match frame {
                        Some(frame) => CaptureLoopEvent::System(frame),
                        None => CaptureLoopEvent::SystemInterrupted(
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
                    if system.is_none() {
                        let system_writer = system_writer
                            .as_mut()
                            .expect("system outage exists only for an authorized writer");
                        let outage = system_outage
                            .as_mut()
                            .expect("authorized system channel owns outage evidence");
                        if let Err(error) = outage.cover_to(system_writer, mic_writer.canonical_samples)
                        {
                            break Err(error);
                        }
                    }
                }
                CaptureLoopEvent::System(frame) => {
                    let Some(system_writer) = system_writer.as_mut() else {
                        break Err("system audio produced data without an authorized channel".into());
                    };
                    if let Err(error) = system_writer.push_frame(frame, false) {
                        break Err(error);
                    }
                }
                CaptureLoopEvent::MaintainSystem => {
                    if let Err(error) = maintain_system_capture(
                        &mut system,
                        &mut system_open,
                        &mut system_retry,
                        &mut system_retry_at,
                        system_outage
                            .as_mut()
                            .expect("maintenance requires an authorized system channel"),
                        system_writer
                            .as_mut()
                            .expect("maintenance requires an authorized system writer"),
                        mic_writer.canonical_samples,
                    ) {
                        break Err(error);
                    }
                }
                CaptureLoopEvent::SystemInterrupted(reason) => {
                    drop(system.take());
                    system_open = None;
                    system_retry.reset();
                    system_retry_at = Instant::now();
                    let outage = system_outage
                        .as_mut()
                        .expect("system interruption requires an authorized channel");
                    if let Err(error) = outage.replace_reason(
                        system_writer
                            .as_mut()
                            .expect("system interruption requires an authorized writer"),
                        reason,
                    ) {
                        break Err(error);
                    }
                    log::warn!("Scribe system audio degraded without stopping microphone capture: {reason}");
                }
                CaptureLoopEvent::MicrophoneInterrupted(reason) => {
                    drop(microphone.take());
                    drop(system.take());
                    system_open = None;
                    if let (Some(outage), Some(writer)) =
                        (system_outage.as_mut(), system_writer.as_mut())
                    {
                        if let Err(error) = outage.finish(writer) {
                            break Err(error);
                        }
                    }
                    let interrupted_at = Instant::now();
                    let mut last_failure = reason.to_string();

                    loop {
                        let Some(attempt) = restart_policy.record_failure() else {
                            if let Err(error) = apply_microphone_restart_gap(
                                &mut mic_writer,
                                system_writer.as_mut(),
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
                            if let Err(error) = apply_microphone_restart_gap(
                                &mut mic_writer,
                                system_writer.as_mut(),
                                interrupted_at.elapsed(),
                                "capture stopped while audio devices were reconnecting",
                            ) {
                                break 'capture Err(error);
                            }
                            break 'capture Ok(());
                        }

                        match open_microphone_stream(request.microphone_device_id.as_deref()) {
                            Ok(reopened) => {
                                if let Err(error) = apply_microphone_restart_gap(
                                    &mut mic_writer,
                                    system_writer.as_mut(),
                                    interrupted_at.elapsed(),
                                    reason,
                                ) {
                                    break 'capture Err(error);
                                }
                                microphone = Some(reopened);
                                if let Some(outage) = system_outage.as_mut() {
                                    *outage = SystemChannelOutage::new(
                                        "system audio was unavailable while the microphone recovered",
                                    );
                                    system_retry.reset();
                                    system_retry_at = Instant::now();
                                }
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

        drop(microphone);
        drop(system);
        drop(system_open);
        let outage_result = match (system_outage.as_mut(), system_writer.as_mut()) {
            (Some(outage), Some(writer)) => {
                outage.cover_to(writer, mic_writer.canonical_samples)?;
                outage.finish(writer)
            }
            _ => Ok(()),
        };
        let alignment_result = if let Some(system_writer) = system_writer.as_mut() {
            align_channel_writers(
                &mut mic_writer,
                system_writer,
                "capture stopped while one channel was ahead",
            )
        } else {
            Ok(())
        };
        let mic_finish = mic_writer.finish();
        let system_finish = system_writer
            .as_mut()
            .map_or(Ok(()), ChannelWriter::finish);
        let duration_ms = system_writer.as_ref().map_or_else(
            || mic_writer.duration_ms(),
            |writer| mic_writer.duration_ms().max(writer.duration_ms()),
        );
        combine_capture_results(
            capture_result,
            combine_unit_results(outage_result, alignment_result),
            mic_finish,
            system_finish,
            duration_ms,
        )
    })
}

#[cfg(target_os = "macos")]
type MicrophoneStream = std::pin::Pin<Box<mimir_meeting_audio::MicrophoneStream>>;

#[cfg(target_os = "macos")]
type SystemAudioStream = std::pin::Pin<Box<mimir_meeting_audio::SystemAudioStream>>;

#[cfg(target_os = "macos")]
enum CaptureLoopEvent {
    Stop,
    Microphone(mimir_meeting_audio::RawAudioFrame),
    System(mimir_meeting_audio::RawAudioFrame),
    MaintainSystem,
    MicrophoneInterrupted(&'static str),
    SystemInterrupted(&'static str),
}

#[cfg(target_os = "macos")]
fn open_microphone_stream(microphone_device_id: Option<&str>) -> Result<MicrophoneStream, String> {
    use mimir_meeting_audio::{CaptureHealth, FrameDuration, MicrophoneInput};

    let microphone_input = MicrophoneInput::open_device(microphone_device_id).map_err(|error| {
        format!(
            "microphone capture could not open a usable input; reconnect the selected device or verify Microphone permission: {error}"
        )
    })?;
    if let Some(missing) = microphone_input.fallback_from_device_id() {
        log::warn!(
            "Selected Scribe microphone '{missing}' is unavailable; using '{}' ({}) for this capture",
            microphone_input.device_name(),
            microphone_input.device_id()
        );
    }
    let microphone = microphone_input
        .start(FrameDuration::DEFAULT, CaptureHealth::default())
        .map_err(|error| {
            format!(
                "microphone capture opened but its stream could not start; reconnect or select an input device and verify Microphone permission: {error}"
            )
        })?;
    Ok(Box::pin(microphone))
}

#[cfg(target_os = "macos")]
fn open_system_audio_stream() -> Result<SystemAudioStream, String> {
    use mimir_meeting_audio::{CaptureHealth, FrameDuration, SystemAudioInput};

    let system = SystemAudioInput::open()
        .and_then(|input| input.start(FrameDuration::DEFAULT, CaptureHealth::default()))
        .map_err(|error| {
            format!(
                "system audio capture is unavailable; verify Screen & System Audio Recording permission and the default output device: {error}"
            )
        })?;
    Ok(Box::pin(system))
}

#[cfg(target_os = "macos")]
struct SystemOpenAttempt {
    result: mpsc::Receiver<Result<SystemAudioStream, String>>,
}

#[cfg(target_os = "macos")]
impl SystemOpenAttempt {
    fn spawn() -> Result<Self, String> {
        let (send, result) = mpsc::sync_channel(1);
        thread::Builder::new()
            .name("mimir-system-audio-open".into())
            .spawn(move || {
                let _ = send.send(open_system_audio_stream());
            })
            .map_err(|error| format!("could not start system-audio initialization: {error}"))?;
        Ok(Self { result })
    }

    fn poll(&self) -> Option<Result<SystemAudioStream, String>> {
        match self.result.try_recv() {
            Ok(result) => Some(result),
            Err(mpsc::TryRecvError::Empty) => None,
            Err(mpsc::TryRecvError::Disconnected) => Some(Err(
                "system-audio initialization ended without a result".into(),
            )),
        }
    }
}

#[cfg(target_os = "macos")]
#[derive(Debug, Default)]
struct SystemRetryPolicy {
    failures: u8,
}

#[cfg(target_os = "macos")]
impl SystemRetryPolicy {
    fn reset(&mut self) {
        self.failures = 0;
    }

    fn next_delay(&mut self) -> Duration {
        self.failures = self.failures.saturating_add(1).min(16);
        let shift = u32::from(self.failures.saturating_sub(1)).min(7);
        Duration::from_millis(250_u64.saturating_mul(1_u64 << shift)).min(Duration::from_secs(30))
    }
}

#[cfg(target_os = "macos")]
#[allow(clippy::too_many_arguments)]
fn maintain_system_capture(
    system: &mut Option<SystemAudioStream>,
    opening: &mut Option<SystemOpenAttempt>,
    retry: &mut SystemRetryPolicy,
    retry_at: &mut Instant,
    outage: &mut SystemChannelOutage,
    writer: &mut ChannelWriter,
    microphone_samples: u64,
) -> Result<(), String> {
    if system.is_some() {
        return Ok(());
    }
    outage.cover_to(writer, microphone_samples)?;

    if let Some(attempt) = opening.as_ref() {
        let Some(result) = attempt.poll() else {
            return Ok(());
        };
        *opening = None;
        match result {
            Ok(stream) => {
                outage.finish(writer)?;
                *system = Some(stream);
                retry.reset();
                return Ok(());
            }
            Err(error) => {
                outage.replace_reason(writer, &error)?;
                *retry_at = Instant::now() + retry.next_delay();
                log::warn!(
                    "Scribe system audio remains unavailable; microphone capture continues: {error}"
                );
                return Ok(());
            }
        }
    }

    if Instant::now() >= *retry_at {
        match SystemOpenAttempt::spawn() {
            Ok(attempt) => *opening = Some(attempt),
            Err(error) => {
                outage.replace_reason(writer, &error)?;
                *retry_at = Instant::now() + retry.next_delay();
            }
        }
    }
    Ok(())
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
fn apply_microphone_restart_gap(
    microphone: &mut ChannelWriter,
    mut system: Option<&mut ChannelWriter>,
    interruption: Duration,
    reason: &str,
) -> Result<(), String> {
    let system_samples = system
        .as_ref()
        .map(|writer| writer.canonical_samples)
        .unwrap_or(microphone.canonical_samples);
    let plan =
        CaptureRestartPolicy::gap_plan(microphone.canonical_samples, system_samples, interruption);
    microphone.push_timeline_gap_frames(
        plan.microphone_catch_up_frames,
        "microphone channel aligned before capture restart",
    )?;
    if let Some(system) = system.as_mut() {
        system.push_timeline_gap_frames(
            plan.system_catch_up_frames,
            "system channel aligned before capture restart",
        )?;
    }
    microphone.push_timeline_gap_frames(plan.interruption_frames, reason)?;
    if let Some(system) = system {
        system.push_timeline_gap_frames(plan.interruption_frames, reason)?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn align_channel_writers(
    microphone: &mut ChannelWriter,
    system: &mut ChannelWriter,
    reason: &str,
) -> Result<(), String> {
    let aligned_samples = microphone.canonical_samples.max(system.canonical_samples);
    let microphone_frames =
        frames_for_samples(aligned_samples.saturating_sub(microphone.canonical_samples));
    let system_frames =
        frames_for_samples(aligned_samples.saturating_sub(system.canonical_samples));
    if is_bounded_callback_stop_skew(microphone_frames, system_frames) {
        microphone.push_timeline_padding_frames(microphone_frames)?;
        system.push_timeline_padding_frames(system_frames)?;
    } else {
        microphone.push_timeline_gap_frames(microphone_frames, reason)?;
        system.push_timeline_gap_frames(system_frames, reason)?;
    }
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

#[cfg(target_os = "macos")]
fn combine_unit_results(
    first: Result<(), String>,
    second: Result<(), String>,
) -> Result<(), String> {
    match (first, second) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(error), Ok(())) | (Ok(()), Err(error)) => Err(error),
        (Err(first), Err(second)) => Err(format!("{first}; {second}")),
    }
}

#[cfg(not(target_os = "macos"))]
fn run_capture_worker(context: CaptureWorkerContext) -> Result<CaptureStopResult, String> {
    let CaptureWorkerContext {
        store,
        data_dir,
        request,
        stop,
        microphone_muted,
        startup,
    } = context;
    let _ = (store, data_dir, request, stop, microphone_muted, startup);
    let message =
        "native meeting capture is supported only by the macOS arm64 Scribe release".to_string();
    Err(message)
}

#[cfg(target_os = "macos")]
struct ChannelWriter {
    store: Arc<MeetingStore>,
    data_dir: PathBuf,
    meeting_id: String,
    channel_id: String,
    chunk_sequence: u64,
    canonical_samples: u64,
    buffer: Vec<f32>,
    gaps: Vec<PersistedGap>,
}

#[cfg(target_os = "macos")]
#[derive(Debug)]
struct SystemChannelOutage {
    reason: String,
    checkpoint_start_sample: Option<u64>,
}

#[cfg(target_os = "macos")]
impl SystemChannelOutage {
    fn new(reason: impl Into<String>) -> Self {
        Self {
            reason: bounded_gap_reason(&reason.into()),
            checkpoint_start_sample: None,
        }
    }

    /// Advance the unavailable system channel to the microphone-owned clock.
    /// Silence is persisted through the ordinary chunk authority; explicit
    /// gap evidence is checkpointed every thirty seconds instead of emitting
    /// one SQLite transcript mutation for every 20 ms microphone callback.
    fn cover_to(&mut self, writer: &mut ChannelWriter, target_samples: u64) -> Result<(), String> {
        if target_samples <= writer.canonical_samples {
            return Ok(());
        }
        let missing_samples = target_samples.saturating_sub(writer.canonical_samples);
        let frames = frames_for_samples(missing_samples);
        self.checkpoint_start_sample
            .get_or_insert(writer.canonical_samples);
        writer.push_timeline_padding_frames(frames)?;
        let checkpoint_samples = SYSTEM_GAP_CHECKPOINT_FRAMES
            .checked_mul(canonical_frame_samples())
            .ok_or_else(|| "system-audio gap checkpoint overflowed".to_string())?;
        if writer.canonical_samples.saturating_sub(
            self.checkpoint_start_sample
                .unwrap_or(writer.canonical_samples),
        ) >= checkpoint_samples
        {
            self.checkpoint(writer)?;
        }
        Ok(())
    }

    fn checkpoint(&mut self, writer: &mut ChannelWriter) -> Result<(), String> {
        let Some(start_sample) = self.checkpoint_start_sample.take() else {
            return Ok(());
        };
        writer.record_gap_samples(start_sample, writer.canonical_samples, &self.reason)?;
        writer.flush_gap_manifest()
    }

    fn finish(&mut self, writer: &mut ChannelWriter) -> Result<(), String> {
        self.checkpoint(writer)
    }

    fn replace_reason(&mut self, writer: &mut ChannelWriter, reason: &str) -> Result<(), String> {
        self.finish(writer)?;
        self.reason = bounded_gap_reason(reason);
        Ok(())
    }
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
        channel_id: impl Into<String>,
    ) -> Self {
        Self {
            store,
            data_dir,
            meeting_id,
            channel_id: channel_id.into(),
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
        self.record_gap_samples(start_sample, end_sample, reason)?;

        self.push_timeline_padding_frames(frames)?;
        self.flush_gap_manifest()
    }

    fn record_gap_samples(
        &mut self,
        start_sample: u64,
        end_sample: u64,
        reason: &str,
    ) -> Result<(), String> {
        if end_sample <= start_sample {
            return Ok(());
        }
        self.record_gap(PersistedGap {
            sequence: start_sample / canonical_frame_samples(),
            start_ms: start_sample.saturating_mul(1_000) / CANONICAL_SAMPLE_RATE_HZ as u64,
            end_ms: end_sample.saturating_mul(1_000) / CANONICAL_SAMPLE_RATE_HZ as u64,
            reason: bounded_gap_reason(reason),
        })
    }

    fn push_timeline_padding_frames(&mut self, frames: u64) -> Result<(), String> {
        if frames == 0 {
            return Ok(());
        }
        let gap_samples = frames
            .checked_mul(canonical_frame_samples())
            .ok_or_else(|| "capture alignment padding exceeds the meeting timeline".to_string())?;
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
        Ok(())
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
                channel_id: Some(self.channel_id.clone()),
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
            channel_id: self.channel_id.clone(),
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

    struct BlockingOpenWorker {
        entered: mpsc::SyncSender<()>,
        release: Mutex<mpsc::Receiver<()>>,
    }

    impl CaptureWorkerRunner for BlockingOpenWorker {
        fn run(&self, context: CaptureWorkerContext) -> Result<CaptureStopResult, String> {
            self.entered
                .send(())
                .map_err(|_| "blocking-open observer stopped".to_string())?;
            self.release
                .lock()
                .map_err(|_| "blocking-open release was poisoned".to_string())?
                .recv()
                .map_err(|_| "blocking-open release stopped".to_string())?;
            if !context.begin_capture()? {
                return Ok(CaptureStopResult { duration_ms: 0 });
            }
            Err("test worker unexpectedly entered capture".into())
        }
    }

    struct FailingOpenWorker;

    impl CaptureWorkerRunner for FailingOpenWorker {
        fn run(&self, _context: CaptureWorkerContext) -> Result<CaptureStopResult, String> {
            Err("synthetic device-open failure".into())
        }
    }

    struct RecordingFailureSink {
        failures: mpsc::SyncSender<(String, String, String)>,
    }

    impl MeetingCaptureFailureSink for RecordingFailureSink {
        fn capture_failed(&self, meeting_id: &str, run_id: &str, message: &str) {
            let _ = self.failures.send((
                meeting_id.to_string(),
                run_id.to_string(),
                message.to_string(),
            ));
        }
    }

    fn capture_request(meeting_id: &str) -> CaptureStart {
        CaptureStart {
            meeting_id: meeting_id.into(),
            run_id: format!("run-{meeting_id}"),
            workspace_path: None,
            microphone_device_id: None,
            channels: vec![channel(
                "microphone",
                super::super::AudioChannelKind::Microphone,
            )],
        }
    }

    fn channel(id: &str, kind: super::super::AudioChannelKind) -> super::super::AudioChannelDraft {
        super::super::AudioChannelDraft {
            id: id.into(),
            kind,
            sample_rate_hz: CANONICAL_SAMPLE_RATE_HZ,
            channels: 1,
            sample_format: "f32le".into(),
            device_id: None,
        }
    }

    #[test]
    fn mic_only_channel_authority_never_requests_a_system_stream_or_writer() {
        let plan = CaptureSourcePlan::from_channels(&[channel(
            "chosen-microphone",
            super::super::AudioChannelKind::Microphone,
        )])
        .unwrap();

        assert_eq!(plan.microphone_channel_id, "chosen-microphone");
        assert_eq!(plan.system_channel_id, None);
        assert!(plan.system_channel_id.is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn requested_system_open_failure_retains_mic_and_persists_aligned_gap_silence() {
        use crate::meetings::{AudioChannelKind, MeetingDraft, MeetingOrigin, MeetingStatus};
        use serde_json::json;

        let directory = tempfile::tempdir().unwrap();
        let store = Arc::new(MeetingStore::open_in_memory().unwrap());
        store
            .create_meeting(
                &MeetingDraft {
                    id: "degraded-system".into(),
                    title: "Degraded system".into(),
                    origin: MeetingOrigin::default(),
                    channels: vec![
                        channel("microphone", AudioChannelKind::Microphone),
                        channel("system", AudioChannelKind::System),
                    ],
                    metadata: json!({}),
                },
                "2026-08-01T10:00:00Z",
            )
            .unwrap();
        store
            .transition_meeting(
                "degraded-system",
                0,
                MeetingStatus::Recording,
                "2026-08-01T10:00:01Z",
                None,
            )
            .unwrap();
        let mut microphone = ChannelWriter::new(
            Arc::clone(&store),
            directory.path().to_path_buf(),
            "degraded-system".into(),
            "microphone",
        );
        let mut system = ChannelWriter::new(
            Arc::clone(&store),
            directory.path().to_path_buf(),
            "degraded-system".into(),
            "system",
        );
        let mut outage = SystemChannelOutage::new(
            "system audio process tap could not open; microphone capture continued",
        );

        for _ in 0..55 {
            microphone
                .push_canonical_samples(&vec![0.25; canonical_frame_samples() as usize])
                .unwrap();
            outage
                .cover_to(&mut system, microphone.canonical_samples)
                .unwrap();
        }
        outage.finish(&mut system).unwrap();
        microphone.finish().unwrap();
        system.finish().unwrap();

        assert_eq!(microphone.canonical_samples, system.canonical_samples);
        assert!(microphone.canonical_samples > CANONICAL_SAMPLE_RATE_HZ as u64);
        assert!(!store
            .committed_audio_chunks("degraded-system", "microphone", 0, 100)
            .unwrap()
            .is_empty());
        assert!(!store
            .committed_audio_chunks("degraded-system", "system", 0, 100)
            .unwrap()
            .is_empty());
        assert!(!store
            .transcript_snapshot("degraded-system", None)
            .unwrap()
            .gaps
            .is_empty());
    }

    #[test]
    fn pending_device_open_is_owned_before_start_returns_and_stop_is_prompt() {
        let directory = tempfile::tempdir().unwrap();
        let store = Arc::new(MeetingStore::open_in_memory().unwrap());
        let (entered_tx, entered_rx) = mpsc::sync_channel(1);
        let (release_tx, release_rx) = mpsc::sync_channel(1);
        let capture = NativeMeetingCapture::with_worker(
            store,
            directory.path(),
            Arc::new(BlockingOpenWorker {
                entered: entered_tx,
                release: Mutex::new(release_rx),
            }),
        )
        .unwrap();
        let request = capture_request("pending-open");

        let started_at = Instant::now();
        capture.start(&request).unwrap();
        assert!(started_at.elapsed() < Duration::from_millis(100));
        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();

        let stopped_at = Instant::now();
        let stopped = capture
            .stop(&CaptureStop {
                meeting_id: request.meeting_id.clone(),
                run_id: request.run_id.clone(),
            })
            .unwrap();
        assert!(stopped_at.elapsed() < Duration::from_millis(100));
        assert_eq!(stopped.duration_ms, 0);
        assert!(capture.startup_cleanup_pending.load(Ordering::Acquire));

        release_tx.send(()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(1);
        while capture.startup_cleanup_pending.load(Ordering::Acquire) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(1));
        }
        assert!(!capture.startup_cleanup_pending.load(Ordering::Acquire));
    }

    #[test]
    fn asynchronous_open_failure_reaches_sink_and_retains_stoppable_ownership() {
        let directory = tempfile::tempdir().unwrap();
        let store = Arc::new(MeetingStore::open_in_memory().unwrap());
        let capture =
            NativeMeetingCapture::with_worker(store, directory.path(), Arc::new(FailingOpenWorker))
                .unwrap();
        let (failures_tx, failures_rx) = mpsc::sync_channel(1);
        capture
            .install_failure_sink(Arc::new(RecordingFailureSink {
                failures: failures_tx,
            }))
            .unwrap();
        let request = capture_request("failed-open");

        capture.start(&request).unwrap();
        assert_eq!(
            failures_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            (
                request.meeting_id.clone(),
                request.run_id.clone(),
                "synthetic device-open failure".into(),
            )
        );
        let error = capture
            .stop(&CaptureStop {
                meeting_id: request.meeting_id,
                run_id: request.run_id,
            })
            .unwrap_err();
        assert_eq!(error, "synthetic device-open failure");
        assert!(!error.contains("no audio worker"));
    }

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
    fn stop_alignment_tolerance_does_not_hide_a_stalled_source() {
        assert!(is_bounded_callback_stop_skew(
            MAX_CALLBACK_STOP_SKEW_FRAMES,
            0
        ));
        assert!(!is_bounded_callback_stop_skew(
            MAX_CALLBACK_STOP_SKEW_FRAMES + 1,
            0
        ));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn normal_stop_alignment_does_not_report_callback_skew_as_missing_audio() {
        use crate::meetings::{
            AudioChannelDraft, AudioChannelKind, MeetingDraft, MeetingOrigin, MeetingStatus,
        };
        use serde_json::json;
        use tempfile::tempdir;

        let directory = tempdir().unwrap();
        let store = Arc::new(MeetingStore::open_in_memory().unwrap());
        store
            .create_meeting(
                &MeetingDraft {
                    id: "stop-alignment".into(),
                    title: "Stop alignment".into(),
                    origin: MeetingOrigin::default(),
                    channels: vec![
                        AudioChannelDraft {
                            id: "microphone".into(),
                            kind: AudioChannelKind::Microphone,
                            sample_rate_hz: CANONICAL_SAMPLE_RATE_HZ,
                            channels: 1,
                            sample_format: "f32le".into(),
                            device_id: None,
                        },
                        AudioChannelDraft {
                            id: "system".into(),
                            kind: AudioChannelKind::System,
                            sample_rate_hz: CANONICAL_SAMPLE_RATE_HZ,
                            channels: 1,
                            sample_format: "f32le".into(),
                            device_id: None,
                        },
                    ],
                    metadata: json!({}),
                },
                "2026-07-31T10:00:00Z",
            )
            .unwrap();
        store
            .transition_meeting(
                "stop-alignment",
                0,
                MeetingStatus::Recording,
                "2026-07-31T10:00:01Z",
                None,
            )
            .unwrap();

        let mut microphone = ChannelWriter::new(
            Arc::clone(&store),
            directory.path().to_path_buf(),
            "stop-alignment".into(),
            "microphone",
        );
        let mut system = ChannelWriter::new(
            Arc::clone(&store),
            directory.path().to_path_buf(),
            "stop-alignment".into(),
            "system",
        );
        microphone
            .push_canonical_samples(&vec![1.0; canonical_frame_samples() as usize * 3])
            .unwrap();

        align_channel_writers(
            &mut microphone,
            &mut system,
            "capture stopped while one channel was ahead",
        )
        .unwrap();
        microphone.finish().unwrap();
        system.finish().unwrap();

        assert_eq!(microphone.canonical_samples, system.canonical_samples);
        assert!(store
            .transcript_snapshot("stop-alignment", None)
            .unwrap()
            .gaps
            .is_empty());
        assert!(!directory
            .path()
            .join("stop-alignment/audio/system/gaps.json")
            .exists());
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
