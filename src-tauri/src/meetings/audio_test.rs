//! Ephemeral microphone/system-audio diagnostics for Scribe.
//!
//! A test owns native streams but never a meeting, file, transcript, or sample
//! buffer. Each source is reduced immediately to a bounded sample count and
//! peak. Combined projections are emitted at most ten times per second and the
//! owning window can always release the streams without relying on renderer
//! cleanup code running successfully.

use serde::Serialize;
#[cfg(target_os = "macos")]
use std::thread;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};
use tauri::Emitter;
use uuid::Uuid;

pub const MEETING_AUDIO_TEST_EVENT: &str = "mimir://meeting-audio-test";
const LEVEL_INTERVAL: Duration = Duration::from_millis(100);
const AUDIO_SIGNAL_THRESHOLD: f32 = 0.002;
const MAX_ERROR_CHARS: usize = 512;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingAudioTestStarted {
    pub test_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_microphone_device_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingAudioSourceLevel {
    /// `open-failed`, `no-data`, `silent`, `signal`, `ended`, or `stopped`.
    pub state: String,
    pub level: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingAudioTestEvent {
    pub test_id: String,
    pub sequence: u64,
    /// `running` for rate-limited level projections; `stopped` is the terminal
    /// lifecycle notification and is not a metering tick.
    pub state: String,
    pub microphone: MeetingAudioSourceLevel,
    pub system_audio: MeetingAudioSourceLevel,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub microphone_device_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub microphone_device_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback_from_microphone_device_id: Option<String>,
}

pub trait MeetingAudioTestEventSink: Send + Sync {
    fn publish(&self, event: &MeetingAudioTestEvent) -> Result<(), String>;
}

struct TauriMeetingAudioTestEventSink {
    app: tauri::AppHandle,
}

impl MeetingAudioTestEventSink for TauriMeetingAudioTestEventSink {
    fn publish(&self, event: &MeetingAudioTestEvent) -> Result<(), String> {
        self.app
            .emit(MEETING_AUDIO_TEST_EVENT, event)
            .map_err(|error| format!("Could not publish Scribe audio-test level: {error}"))
    }
}

#[derive(Debug, Default)]
struct AudioSignalObservation {
    sample_count: u64,
    peak: f32,
    failure: Option<SourceFailure>,
}

#[derive(Debug)]
struct SourceFailure {
    state: &'static str,
    error: String,
}

impl AudioSignalObservation {
    fn open_failed(error: impl Into<String>) -> Self {
        Self {
            failure: Some(SourceFailure {
                state: "open-failed",
                error: bounded_error(error.into()),
            }),
            ..Self::default()
        }
    }

    fn stream_ended(&mut self, error: impl Into<String>) {
        self.failure = Some(SourceFailure {
            state: "ended",
            error: bounded_error(error.into()),
        });
        self.sample_count = 0;
        self.peak = 0.0;
    }

    fn observe_samples(&mut self, samples: &[f32]) {
        // Only scalar evidence survives this call. The borrowed frame is
        // dropped by the worker immediately after observation.
        self.sample_count = self.sample_count.saturating_add(samples.len() as u64);
        for sample in samples.iter().copied().filter(|sample| sample.is_finite()) {
            self.peak = self.peak.max(sample.abs());
        }
    }

    fn take_level(&mut self) -> MeetingAudioSourceLevel {
        let projection = if let Some(failure) = &self.failure {
            MeetingAudioSourceLevel {
                state: failure.state.into(),
                level: 0,
                error: Some(failure.error.clone()),
            }
        } else {
            MeetingAudioSourceLevel {
                state: if self.sample_count == 0 {
                    "no-data"
                } else if self.peak >= AUDIO_SIGNAL_THRESHOLD {
                    "signal"
                } else {
                    "silent"
                }
                .into(),
                level: normalized_level(self.sample_count, self.peak),
                error: None,
            }
        };
        self.sample_count = 0;
        self.peak = 0.0;
        projection
    }

    fn stopped_level(&self) -> MeetingAudioSourceLevel {
        MeetingAudioSourceLevel {
            state: "stopped".into(),
            level: 0,
            error: None,
        }
    }
}

fn normalized_level(sample_count: u64, peak: f32) -> u8 {
    if sample_count == 0 || peak <= 0.000_001 {
        return 0;
    }
    let decibels = 20.0 * peak.min(1.0).log10();
    (((decibels + 60.0) / 60.0) * 100.0)
        .clamp(0.0, 100.0)
        .round() as u8
}

fn bounded_error(value: String) -> String {
    value.chars().take(MAX_ERROR_CHARS).collect()
}

#[derive(Clone)]
struct AudioTestSpec {
    test_id: String,
    requested_microphone_device_id: Option<String>,
}

trait AudioTestWorker: Send {
    fn stop(self: Box<Self>);
}

trait AudioTestWorkerFactory: Send + Sync {
    fn start(&self, spec: AudioTestSpec) -> Result<Box<dyn AudioTestWorker>, String>;
}

struct AudioTestSession {
    owner_window: String,
    worker: Box<dyn AudioTestWorker>,
}

struct MeetingAudioTestManagerInner {
    factory: Arc<dyn AudioTestWorkerFactory>,
    sessions: Mutex<HashMap<String, AudioTestSession>>,
}

#[derive(Clone)]
pub struct MeetingAudioTestManager {
    inner: Arc<MeetingAudioTestManagerInner>,
}

impl MeetingAudioTestManager {
    pub fn production(app: &tauri::AppHandle) -> Self {
        let sink = Arc::new(TauriMeetingAudioTestEventSink { app: app.clone() });
        Self::with_factory(Arc::new(NativeAudioTestWorkerFactory { sink }))
    }

    fn with_factory(factory: Arc<dyn AudioTestWorkerFactory>) -> Self {
        Self {
            inner: Arc::new(MeetingAudioTestManagerInner {
                factory,
                sessions: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub fn start(
        &self,
        owner_window: &str,
        requested_microphone_device_id: Option<String>,
    ) -> Result<MeetingAudioTestStarted, String> {
        let mut sessions = self.sessions()?;
        if let Some((test_id, session)) = sessions.iter().next() {
            return Err(format!(
                "Audio check '{test_id}' is already running for window '{}'",
                session.owner_window
            ));
        }
        let test_id = format!("audio-test-{}", Uuid::new_v4());
        let spec = AudioTestSpec {
            test_id: test_id.clone(),
            requested_microphone_device_id: requested_microphone_device_id.clone(),
        };
        let worker = self.inner.factory.start(spec)?;
        sessions.insert(
            test_id.clone(),
            AudioTestSession {
                owner_window: owner_window.into(),
                worker,
            },
        );
        Ok(MeetingAudioTestStarted {
            test_id,
            requested_microphone_device_id,
        })
    }

    pub fn stop(&self, owner_window: &str, test_id: &str) -> Result<(), String> {
        let session = {
            let mut sessions = self.sessions()?;
            let session = sessions
                .remove(test_id)
                .ok_or_else(|| format!("Audio check '{test_id}' is not running"))?;
            if session.owner_window != owner_window {
                sessions.insert(test_id.into(), session);
                return Err("Only the window that started an audio check can stop it".into());
            }
            session
        };
        session.worker.stop();
        Ok(())
    }

    pub fn stop_window(&self, owner_window: &str) -> Result<(), String> {
        let sessions = {
            let mut active = self.sessions()?;
            let ids = active
                .iter()
                .filter(|(_, session)| session.owner_window == owner_window)
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            ids.into_iter()
                .filter_map(|id| active.remove(&id))
                .collect::<Vec<_>>()
        };
        for session in sessions {
            session.worker.stop();
        }
        Ok(())
    }

    pub fn stop_all(&self) -> Result<(), String> {
        let sessions = {
            let mut active = self.sessions()?;
            active
                .drain()
                .map(|(_, session)| session)
                .collect::<Vec<_>>()
        };
        for session in sessions {
            session.worker.stop();
        }
        Ok(())
    }

    fn sessions(&self) -> Result<MutexGuard<'_, HashMap<String, AudioTestSession>>, String> {
        self.inner
            .sessions
            .lock()
            .map_err(|_| "Scribe audio-test state was poisoned".into())
    }
}

impl Drop for MeetingAudioTestManagerInner {
    fn drop(&mut self) {
        let Ok(active) = self.sessions.get_mut() else {
            return;
        };
        for (_, session) in active.drain() {
            session.worker.stop();
        }
    }
}

struct NativeAudioTestWorkerFactory {
    sink: Arc<dyn MeetingAudioTestEventSink>,
}

impl AudioTestWorkerFactory for NativeAudioTestWorkerFactory {
    fn start(&self, spec: AudioTestSpec) -> Result<Box<dyn AudioTestWorker>, String> {
        #[cfg(target_os = "macos")]
        {
            let (stop, stop_rx) = tokio::sync::watch::channel(false);
            let sink = Arc::clone(&self.sink);
            let worker = thread::Builder::new()
                .name(format!("mimir-{}", spec.test_id))
                .spawn(move || run_native_audio_test(spec, stop_rx, sink))
                .map_err(|error| format!("Could not start Scribe audio check: {error}"))?;
            Ok(Box::new(ThreadAudioTestWorker {
                stop,
                worker: Some(worker),
            }))
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = &self.sink;
            let _ = spec;
            Err("Live audio checking is available only in Mimir for macOS".into())
        }
    }
}

#[cfg(target_os = "macos")]
struct ThreadAudioTestWorker {
    stop: tokio::sync::watch::Sender<bool>,
    worker: Option<thread::JoinHandle<()>>,
}

#[cfg(target_os = "macos")]
impl AudioTestWorker for ThreadAudioTestWorker {
    fn stop(mut self: Box<Self>) {
        let _ = self.stop.send(true);
        if let Some(worker) = self.worker.take() {
            reap_audio_test_worker(worker);
        }
    }
}

#[cfg(target_os = "macos")]
fn reap_audio_test_worker(worker: thread::JoinHandle<()>) {
    // Core Audio/TCC can block inside device open and cannot observe the watch
    // signal until that native call returns. Recording startup must never join
    // such a diagnostic worker synchronously; retain cleanup on a tiny reaper
    // thread instead.
    if let Err(error) = thread::Builder::new()
        .name("mimir-audio-test-reaper".into())
        .spawn(move || {
            if worker.join().is_err() {
                log::error!("Scribe audio-test worker panicked during teardown");
            }
        })
    {
        log::error!("Could not reclaim Scribe audio-test worker: {error}");
    }
}

#[cfg(target_os = "macos")]
fn run_native_audio_test(
    spec: AudioTestSpec,
    mut stop: tokio::sync::watch::Receiver<bool>,
    sink: Arc<dyn MeetingAudioTestEventSink>,
) {
    use futures_util::StreamExt;
    use mimir_meeting_audio::{CaptureHealth, FrameDuration, MicrophoneInput, SystemAudioInput};

    let mut microphone_observation = AudioSignalObservation::default();
    let microphone_input =
        MicrophoneInput::open_device(spec.requested_microphone_device_id.as_deref());
    let (mut microphone, microphone_device_id, microphone_device_name, fallback_from) =
        match microphone_input {
            Ok(input) => {
                let id = input.device_id();
                let name = input.device_name();
                let fallback = input.fallback_from_device_id().map(str::to_owned);
                match input.start(FrameDuration::DEFAULT, CaptureHealth::default()) {
                    Ok(stream) => (Some(Box::pin(stream)), Some(id), Some(name), fallback),
                    Err(error) => {
                        microphone_observation = AudioSignalObservation::open_failed(format!(
                            "Microphone opened but its stream could not start: {error}"
                        ));
                        (None, Some(id), Some(name), fallback)
                    }
                }
            }
            Err(error) => {
                microphone_observation = AudioSignalObservation::open_failed(format!(
                    "Microphone could not open: {error}"
                ));
                (None, None, None, None)
            }
        };

    let mut system_observation = AudioSignalObservation::default();
    let mut system = match SystemAudioInput::open()
        .and_then(|input| input.start(FrameDuration::DEFAULT, CaptureHealth::default()))
    {
        Ok(stream) => Some(Box::pin(stream)),
        Err(error) => {
            system_observation = AudioSignalObservation::open_failed(format!(
                "System audio could not open: {error}"
            ));
            None
        }
    };

    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            log::error!("Could not initialize Scribe audio-test runtime: {error}");
            return;
        }
    };
    runtime.block_on(async move {
        let mut interval = tokio::time::interval(LEVEL_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut sequence = 0_u64;
        loop {
            tokio::select! {
                changed = stop.changed() => {
                    if changed.is_err() || *stop.borrow() {
                        break;
                    }
                }
                frame = async { microphone.as_mut().expect("guarded microphone").next().await }, if microphone.is_some() => {
                    match frame {
                        Some(frame) => observe_frame(&mut microphone_observation, frame),
                        None => {
                            microphone = None;
                            microphone_observation.stream_ended("Microphone stream ended during the audio check");
                        }
                    }
                }
                frame = async { system.as_mut().expect("guarded system audio").next().await }, if system.is_some() => {
                    match frame {
                        Some(frame) => observe_frame(&mut system_observation, frame),
                        None => {
                            system = None;
                            system_observation.stream_ended("System-audio stream ended during the audio check");
                        }
                    }
                }
                _ = interval.tick() => {
                    sequence = sequence.saturating_add(1);
                    publish_event(&sink, MeetingAudioTestEvent {
                        test_id: spec.test_id.clone(),
                        sequence,
                        state: "running".into(),
                        microphone: microphone_observation.take_level(),
                        system_audio: system_observation.take_level(),
                        microphone_device_id: microphone_device_id.clone(),
                        microphone_device_name: microphone_device_name.clone(),
                        fallback_from_microphone_device_id: fallback_from.clone(),
                    });
                }
            }
        }
        // Drop both streams before reporting terminal ownership release.
        drop(microphone);
        drop(system);
        sequence = sequence.saturating_add(1);
        publish_event(&sink, MeetingAudioTestEvent {
            test_id: spec.test_id,
            sequence,
            state: "stopped".into(),
            microphone: microphone_observation.stopped_level(),
            system_audio: system_observation.stopped_level(),
            microphone_device_id,
            microphone_device_name,
            fallback_from_microphone_device_id: fallback_from,
        });
    });
}

#[cfg(target_os = "macos")]
fn observe_frame(
    observation: &mut AudioSignalObservation,
    frame: mimir_meeting_audio::RawAudioFrame,
) {
    use mimir_meeting_audio::RawAudioSpan;

    for span in frame.spans {
        if let RawAudioSpan::Samples { samples, .. } = span {
            observation.observe_samples(&samples);
        }
    }
}

#[cfg(target_os = "macos")]
fn publish_event(sink: &Arc<dyn MeetingAudioTestEventSink>, event: MeetingAudioTestEvent) {
    if let Err(error) = sink.publish(&event) {
        log::debug!("{error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    #[cfg(target_os = "macos")]
    use std::time::Instant;

    struct FakeWorker {
        stops: Arc<AtomicUsize>,
    }

    impl AudioTestWorker for FakeWorker {
        fn stop(self: Box<Self>) {
            self.stops.fetch_add(1, Ordering::SeqCst);
        }
    }

    struct FakeFactory {
        stops: Arc<AtomicUsize>,
    }

    impl AudioTestWorkerFactory for FakeFactory {
        fn start(&self, _spec: AudioTestSpec) -> Result<Box<dyn AudioTestWorker>, String> {
            Ok(Box::new(FakeWorker {
                stops: Arc::clone(&self.stops),
            }))
        }
    }

    #[test]
    fn level_projection_is_rate_limited_and_never_retains_samples() {
        assert!(LEVEL_INTERVAL >= Duration::from_millis(100));

        let mut observation = AudioSignalObservation::default();
        observation.observe_samples(&[0.0, -0.25, f32::NAN, 0.1]);
        let signal = observation.take_level();
        assert_eq!(signal.state, "signal");
        assert!(signal.level > 0);
        assert_eq!(observation.sample_count, 0);
        assert_eq!(observation.peak, 0.0);
        assert!(std::mem::size_of::<AudioSignalObservation>() <= 64);

        observation.observe_samples(&[0.0, 0.001]);
        assert_eq!(observation.take_level().state, "silent");
        assert_eq!(
            AudioSignalObservation::default().take_level().state,
            "no-data"
        );
        assert_eq!(
            AudioSignalObservation::open_failed("permission denied")
                .take_level()
                .state,
            "open-failed"
        );
    }

    #[test]
    fn explicit_stop_and_window_teardown_release_each_test_once() {
        let stops = Arc::new(AtomicUsize::new(0));
        let manager = MeetingAudioTestManager::with_factory(Arc::new(FakeFactory {
            stops: Arc::clone(&stops),
        }));

        let first = manager
            .start("main", Some("CoreAudio:mic-a".into()))
            .unwrap();
        assert!(manager
            .start("second", None)
            .unwrap_err()
            .contains("already running"));
        assert!(manager
            .stop("second", &first.test_id)
            .unwrap_err()
            .contains("Only"));
        manager.stop("main", &first.test_id).unwrap();
        assert_eq!(stops.load(Ordering::SeqCst), 1);

        manager.start("main", None).unwrap();
        manager.stop_window("main").unwrap();
        manager.stop_window("main").unwrap();
        assert_eq!(stops.load(Ordering::SeqCst), 2);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn blocked_native_audio_test_cleanup_never_delays_recording_startup() {
        let (release, blocked) = std::sync::mpsc::sync_channel(1);
        let finished = Arc::new(AtomicUsize::new(0));
        let worker_finished = Arc::clone(&finished);
        let worker = thread::spawn(move || {
            let _ = blocked.recv();
            worker_finished.store(1, Ordering::Release);
        });

        let started = Instant::now();
        reap_audio_test_worker(worker);
        assert!(started.elapsed() < Duration::from_millis(100));
        assert_eq!(finished.load(Ordering::Acquire), 0);

        release.send(()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(1);
        while finished.load(Ordering::Acquire) == 0 && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(1));
        }
        assert_eq!(finished.load(Ordering::Acquire), 1);
    }
}
