//! Managed, in-process local Whisper transcription for Scribe.
//!
//! The capture subsystem remains the audio authority. This runner tails only
//! atomically committed, one-second channel files through
//! [`PersistedAudioSource`], so slow inference cannot block or allocate on the
//! real-time capture thread. A model is accepted only when its complete
//! manifest identity, size, checksum, target platform, and whisper.cpp runtime
//! can be verified again at the point of use.

use super::{
    config::{ModelManifest, RuntimePlatform, Sha256Digest},
    stt::{NormalizedSegment, NormalizedTranscriptBatch, SegmentState, WireId},
    transcriber::{
        LocalTranscriber, LocalTranscriptionContext, NormalizedBatchSink, PersistedAudioChunk,
        VerifiedLocalRuntime,
    },
};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

const SAMPLE_RATE_HZ: usize = 16_000;
const CHANNEL_COUNT: usize = 2;
const BYTES_PER_FRAME: usize = size_of::<f32>() * CHANNEL_COUNT;
const DEFAULT_WINDOW_CHUNKS: usize = 8;
const MAX_TAIL_CHUNKS: usize = 32;
const DEFAULT_POLL_INTERVAL: Duration = Duration::from_millis(100);
const MAX_HISTORY_BYTES: usize = 2_048;
const SILENCE_RMS_THRESHOLD: f32 = 0.000_25;

/// Production local runner. The catalog must be the same immutable manifest
/// catalog exposed by [`super::platform::NativeMeetingPlatform`].
pub struct ManagedWhisperTranscriber {
    models: ManagedModelRegistry,
    inference: Arc<dyn WhisperInferenceBackend>,
    prepared: Mutex<Option<PreparedWhisperSession>>,
    window_chunks: usize,
    poll_interval: Duration,
}

/// Narrow bridge to the platform-owned managed-model state machine.
///
/// Implementations must return only a completely installed artifact that was
/// re-hashed against the selected manifest immediately before this call.
pub trait ManagedWhisperArtifactResolver: Send + Sync {
    fn artifact_for_use(&self, model_id: &str) -> Result<PathBuf, String>;
}

impl ManagedWhisperArtifactResolver for super::platform::NativeMeetingPlatform {
    fn artifact_for_use(&self, model_id: &str) -> Result<PathBuf, String> {
        self.managed_model_artifact(model_id)
    }
}

impl ManagedWhisperTranscriber {
    /// Creates the production implementation.
    ///
    /// On the supported macOS arm64 target this is whisper.cpp linked in
    /// process with Metal enabled. Every other build keeps the same API but
    /// reports a hard, actionable unavailable error from `verify`; it never
    /// falls back to a CPU runner.
    pub fn production(
        artifacts: Arc<dyn ManagedWhisperArtifactResolver>,
        manifests: impl IntoIterator<Item = ModelManifest>,
    ) -> Result<Self, String> {
        Self::new(
            ManagedModelRegistry::new(artifacts, manifests, RuntimePlatform::current())?,
            production_backend(),
            DEFAULT_WINDOW_CHUNKS,
            DEFAULT_POLL_INTERVAL,
        )
    }

    fn new(
        models: ManagedModelRegistry,
        inference: Arc<dyn WhisperInferenceBackend>,
        window_chunks: usize,
        poll_interval: Duration,
    ) -> Result<Self, String> {
        if window_chunks == 0 {
            return Err("local Whisper inference window cannot be empty".into());
        }
        if poll_interval.is_zero() {
            return Err("local Whisper audio poll interval cannot be zero".into());
        }
        Ok(Self {
            models,
            inference,
            prepared: Mutex::new(None),
            window_chunks,
            poll_interval,
        })
    }

    fn verified_artifact(&self, model_id: &str) -> Result<VerifiedModelArtifact, String> {
        self.models.verify(model_id)
    }

    fn prepare(&self, artifact: &VerifiedModelArtifact) -> Result<PreparedWhisperSession, String> {
        self.inference.prepare(artifact)
    }

    fn prepared(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, Option<PreparedWhisperSession>>, String> {
        self.prepared
            .lock()
            .map_err(|_| "managed Whisper session mutex was poisoned".into())
    }
}

impl LocalTranscriber for ManagedWhisperTranscriber {
    fn verify(&self, model_id: &str) -> Result<VerifiedLocalRuntime, String> {
        let artifact = self.verified_artifact(model_id)?;
        let mut prepared = self.prepared()?;
        if prepared
            .as_ref()
            .is_none_or(|cached| !cached.matches(&artifact))
        {
            *prepared = Some(self.prepare(&artifact)?);
        }
        let runtime = &prepared
            .as_ref()
            .ok_or_else(|| "managed Whisper preparation produced no session".to_string())?
            .runtime;
        Ok(VerifiedLocalRuntime {
            runtime_id: runtime.id.clone(),
            runtime_version: runtime.version.clone(),
            model_sha256: artifact.sha256.to_string(),
        })
    }

    fn run(&self, context: LocalTranscriptionContext<'_>) -> Result<(), String> {
        // Verify again inside the worker. `start` may have spent time launching
        // the thread, and a model can be removed between preflight and use.
        let artifact = self.verified_artifact(context.model_id)?;
        let cached = self.prepared()?.take();
        let mut inference = match cached {
            Some(cached) if cached.matches(&artifact) => cached.session,
            _ => self.prepare(&artifact)?.session,
        };
        let mut stream =
            StreamingState::new(context.run_id, self.window_chunks, self.poll_interval);

        let mut finalizing = false;
        loop {
            if !finalizing {
                match context.finalize.try_recv() {
                    Ok(command) => {
                        // The value is deliberately consumed: receipt, rather
                        // than disconnection, is the terminal authority.
                        let _observed_at = command.observed_at;
                        finalizing = true;
                    }
                    Err(std::sync::mpsc::TryRecvError::Empty) => {}
                    Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                        return Err(
                            "local transcription finalization channel closed without a command"
                                .into(),
                        )
                    }
                }
            }
            let chunks = if finalizing {
                context
                    .audio
                    .final_chunks_from_bounded(stream.next_sequence, MAX_TAIL_CHUNKS)?
            } else {
                context
                    .audio
                    .paired_chunks_from_bounded(stream.next_sequence, MAX_TAIL_CHUNKS)?
            };
            let had_chunks = !chunks.is_empty();
            for chunk in chunks {
                stream.accept_chunk(chunk, inference.as_mut(), context.sink)?;
            }

            if finalizing && !had_chunks {
                stream.flush(inference.as_mut(), context.sink)?;
                return Ok(());
            }
            if !had_chunks {
                thread::sleep(stream.poll_interval);
            }
        }
    }
}

#[derive(Clone)]
struct ManagedModelRegistry {
    artifacts: Arc<dyn ManagedWhisperArtifactResolver>,
    manifests: BTreeMap<String, ModelManifest>,
    runtime: Option<RuntimePlatform>,
}

impl ManagedModelRegistry {
    fn new(
        artifacts: Arc<dyn ManagedWhisperArtifactResolver>,
        manifests: impl IntoIterator<Item = ModelManifest>,
        runtime: Option<RuntimePlatform>,
    ) -> Result<Self, String> {
        let mut indexed = BTreeMap::new();
        for manifest in manifests {
            manifest
                .validate()
                .map_err(|error| format!("invalid managed Whisper manifest: {error}"))?;
            let model_id = manifest.model_id.as_str().to_string();
            if indexed.insert(model_id.clone(), manifest).is_some() {
                return Err(format!(
                    "managed Whisper catalog contains duplicate model '{model_id}'"
                ));
            }
        }
        if indexed.is_empty() {
            return Err("managed Whisper catalog cannot be empty".into());
        }
        Ok(Self {
            artifacts,
            manifests: indexed,
            runtime,
        })
    }

    fn verify(&self, model_id: &str) -> Result<VerifiedModelArtifact, String> {
        let runtime = self.runtime.ok_or_else(|| {
            "local Whisper transcription is supported only on macOS arm64 with Metal".to_string()
        })?;
        let manifest = self.manifests.get(model_id).ok_or_else(|| {
            format!("managed local transcription model '{model_id}' is not in Mimir's catalog")
        })?;
        if manifest.platform != runtime {
            return Err(format!(
                "managed local transcription model '{model_id}' does not support this runtime"
            ));
        }

        let path = self.artifacts.artifact_for_use(model_id)?;
        reject_symlink(&path, "managed model artifact")?;

        let mut artifact = File::open(&path).map_err(|error| {
            format!("managed local transcription model '{model_id}' is not installed: {error}")
        })?;
        let metadata = artifact.metadata().map_err(|error| {
            format!("could not inspect managed local transcription model '{model_id}': {error}")
        })?;
        if !metadata.is_file() || metadata.len() != manifest.artifact_bytes {
            return Err(format!(
                "managed local transcription model '{model_id}' failed its exact size check"
            ));
        }
        let digest = Sha256Digest::calculate(&mut artifact).map_err(|error| {
            format!("could not checksum managed local transcription model '{model_id}': {error}")
        })?;
        if digest != manifest.sha256 {
            return Err(format!(
                "managed local transcription model '{model_id}' failed its checksum check"
            ));
        }

        Ok(VerifiedModelArtifact {
            path,
            sha256: digest,
        })
    }
}

fn reject_symlink(path: &Path, label: &str) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(format!("{label} must not be a symbolic link"))
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("could not inspect {label}: {error}")),
    }
}

#[derive(Debug, Clone)]
struct VerifiedModelArtifact {
    path: PathBuf,
    sha256: Sha256Digest,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct WhisperRuntimeIdentity {
    id: String,
    version: String,
}

struct PreparedWhisperSession {
    artifact_path: PathBuf,
    artifact_sha256: Sha256Digest,
    runtime: WhisperRuntimeIdentity,
    session: Box<dyn WhisperInferenceSession>,
}

impl PreparedWhisperSession {
    fn matches(&self, artifact: &VerifiedModelArtifact) -> bool {
        self.artifact_path == artifact.path && self.artifact_sha256 == artifact.sha256
    }
}

#[derive(Debug, Clone, PartialEq)]
struct DecodedSegment {
    start_ms: u64,
    end_ms: u64,
    text: String,
    language: Option<String>,
    confidence: Option<f32>,
}

trait WhisperInferenceBackend: Send + Sync {
    fn prepare(&self, artifact: &VerifiedModelArtifact) -> Result<PreparedWhisperSession, String>;
}

trait WhisperInferenceSession: Send {
    fn transcribe(&mut self, samples: &[f32], history: &str)
        -> Result<Vec<DecodedSegment>, String>;
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn production_backend() -> Arc<dyn WhisperInferenceBackend> {
    Arc::new(MetalWhisperBackend)
}

#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
fn production_backend() -> Arc<dyn WhisperInferenceBackend> {
    Arc::new(UnsupportedWhisperBackend)
}

#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
struct UnsupportedWhisperBackend;

#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
impl WhisperInferenceBackend for UnsupportedWhisperBackend {
    fn prepare(&self, _artifact: &VerifiedModelArtifact) -> Result<PreparedWhisperSession, String> {
        Err("local Whisper runtime is unavailable: this build is not macOS arm64 with Metal".into())
    }
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
struct MetalWhisperBackend;

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
impl MetalWhisperBackend {
    fn load_context(
        &self,
        artifact: &VerifiedModelArtifact,
    ) -> Result<whisper_rs::WhisperContext, String> {
        whisper_rs::install_logging_hooks();
        require_metal_device()?;
        let mut parameters = whisper_rs::WhisperContextParameters::default();
        parameters.use_gpu(true).gpu_device(0).flash_attn(true);
        whisper_rs::WhisperContext::new_with_params(&artifact.path, parameters).map_err(|error| {
            format!("could not load the verified managed Whisper model with Metal: {error}")
        })
    }
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
impl WhisperInferenceBackend for MetalWhisperBackend {
    fn prepare(&self, artifact: &VerifiedModelArtifact) -> Result<PreparedWhisperSession, String> {
        let context = self.load_context(artifact)?;
        let _state = context.create_state().map_err(|error| {
            format!("could not initialize the managed Whisper runtime: {error}")
        })?;
        Ok(PreparedWhisperSession {
            artifact_path: artifact.path.clone(),
            artifact_sha256: artifact.sha256,
            runtime: WhisperRuntimeIdentity {
                id: "whisper.cpp-metal-aarch64".into(),
                version: whisper_rs::WHISPER_CPP_VERSION.into(),
            },
            session: Box::new(MetalWhisperSession { context }),
        })
    }
}

/// Confirms that the statically linked backend registry actually exposes a
/// Metal GPU. whisper.cpp otherwise permits a CPU fallback even when callers
/// request a GPU, which is intentionally not acceptable for this runner.
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn require_metal_device() -> Result<(), String> {
    use std::ffi::CStr;
    use whisper_rs::whisper_rs_sys as raw;

    // SAFETY: whisper.cpp owns this process-global registry for the lifetime of
    // the linked library. We only inspect stable device pointers and copy their
    // NUL-terminated names; no backend is mutated or freed.
    let found = unsafe {
        (0..raw::ggml_backend_dev_count()).any(|index| {
            let device = raw::ggml_backend_dev_get(index);
            if device.is_null() {
                return false;
            }
            let device_type = raw::ggml_backend_dev_type(device);
            if !matches!(
                device_type,
                raw::ggml_backend_dev_type_GGML_BACKEND_DEVICE_TYPE_GPU
                    | raw::ggml_backend_dev_type_GGML_BACKEND_DEVICE_TYPE_IGPU
            ) {
                return false;
            }
            let name = raw::ggml_backend_dev_name(device);
            let description = raw::ggml_backend_dev_description(device);
            let name = if name.is_null() {
                String::new()
            } else {
                CStr::from_ptr(name).to_string_lossy().into_owned()
            };
            let description = if description.is_null() {
                String::new()
            } else {
                CStr::from_ptr(description).to_string_lossy().into_owned()
            };
            name.to_ascii_lowercase().contains("metal")
                || description.to_ascii_lowercase().contains("metal")
                || name.to_ascii_lowercase().contains("apple")
        })
    };
    if found {
        Ok(())
    } else {
        Err(
            "the managed Whisper runtime was built with Metal, but no Metal device is available"
                .into(),
        )
    }
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
struct MetalWhisperSession {
    context: whisper_rs::WhisperContext,
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
impl WhisperInferenceSession for MetalWhisperSession {
    fn transcribe(
        &mut self,
        samples: &[f32],
        history: &str,
    ) -> Result<Vec<DecodedSegment>, String> {
        use whisper_rs::{FullParams, SamplingStrategy};

        if samples.is_empty() {
            return Ok(Vec::new());
        }
        let mut state = self
            .context
            .create_state()
            .map_err(|error| format!("could not create a local Whisper decoder state: {error}"))?;
        let mut parameters = FullParams::new(SamplingStrategy::Greedy { best_of: 2 });
        let threads = std::thread::available_parallelism()
            .map(usize::from)
            .unwrap_or(4)
            .div_ceil(2)
            .clamp(2, 8);
        parameters.set_n_threads(threads as i32);
        parameters.set_translate(false);
        parameters.set_language(None);
        parameters.set_no_context(true);
        parameters.set_no_timestamps(false);
        parameters.set_token_timestamps(true);
        parameters.set_split_on_word(true);
        parameters.set_suppress_blank(true);
        parameters.set_suppress_nst(true);
        parameters.set_print_special(false);
        parameters.set_print_progress(false);
        parameters.set_print_realtime(false);
        parameters.set_print_timestamps(false);
        if !history.is_empty() {
            parameters.set_initial_prompt(history);
        }
        state
            .full(parameters, samples)
            .map_err(|error| format!("local Whisper inference failed: {error}"))?;

        let language = whisper_rs::get_lang_str(state.full_lang_id_from_state()).map(str::to_owned);
        let duration_ms = samples.len() as u64 * 1_000 / SAMPLE_RATE_HZ as u64;
        let mut decoded = Vec::new();
        for segment in state.as_iter() {
            if segment.no_speech_probability() >= 0.80 {
                continue;
            }
            let text = segment
                .to_str_lossy()
                .map_err(|error| format!("local Whisper returned invalid segment text: {error}"))?
                .trim()
                .to_string();
            if text.is_empty() {
                continue;
            }
            let start_ms = timestamp_ms(segment.start_timestamp())?.min(duration_ms);
            let end_ms = timestamp_ms(segment.end_timestamp())?.min(duration_ms);
            if start_ms >= end_ms {
                continue;
            }
            let probabilities = (0..segment.n_tokens())
                .filter_map(|index| segment.get_token(index))
                .map(|token| token.token_probability())
                .filter(|value| value.is_finite() && (0.0..=1.0).contains(value))
                .collect::<Vec<_>>();
            let confidence = (!probabilities.is_empty())
                .then(|| probabilities.iter().copied().sum::<f32>() / probabilities.len() as f32);
            decoded.push(DecodedSegment {
                start_ms,
                end_ms,
                text,
                language: language.clone(),
                confidence,
            });
        }
        Ok(decoded)
    }
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn timestamp_ms(centiseconds: i64) -> Result<u64, String> {
    u64::try_from(centiseconds)
        .map(|value| value.saturating_mul(10))
        .map_err(|_| "local Whisper returned a negative timestamp".into())
}

struct StreamingState {
    next_sequence: u64,
    expected_sequence: Option<u64>,
    provider_sequence: u64,
    window_index: u64,
    window_samples: usize,
    poll_interval: Duration,
    run_component: String,
    microphone: ChannelWindow,
    system: ChannelWindow,
}

impl StreamingState {
    fn new(run_id: &str, window_chunks: usize, poll_interval: Duration) -> Self {
        Self {
            next_sequence: 0,
            expected_sequence: None,
            provider_sequence: 0,
            window_index: 0,
            window_samples: window_chunks.saturating_mul(SAMPLE_RATE_HZ),
            poll_interval,
            run_component: short_hash(run_id.as_bytes()),
            microphone: ChannelWindow::new("microphone", "You"),
            system: ChannelWindow::new("system", "Them"),
        }
    }

    fn accept_chunk(
        &mut self,
        chunk: PersistedAudioChunk,
        inference: &mut dyn WhisperInferenceSession,
        sink: &mut dyn NormalizedBatchSink,
    ) -> Result<(), String> {
        if self
            .expected_sequence
            .is_some_and(|expected| chunk.sequence != expected)
        {
            self.flush(inference, sink)?;
        }
        let (microphone, system) = split_stereo_f32le(&chunk.bytes)?;
        self.microphone
            .push(chunk.start_ms, chunk.end_ms, microphone)?;
        self.system.push(chunk.start_ms, chunk.end_ms, system)?;
        self.next_sequence = chunk.sequence.saturating_add(1);
        self.expected_sequence = Some(self.next_sequence);
        if self.microphone.samples.len() >= self.window_samples
            || self.system.samples.len() >= self.window_samples
        {
            self.flush(inference, sink)?;
        }
        Ok(())
    }

    fn flush(
        &mut self,
        inference: &mut dyn WhisperInferenceSession,
        sink: &mut dyn NormalizedBatchSink,
    ) -> Result<(), String> {
        let microphone = self.microphone.take();
        let system = self.system.take();
        self.emit_channel(microphone, inference, sink)?;
        self.emit_channel(system, inference, sink)?;
        self.window_index = self.window_index.saturating_add(1);
        Ok(())
    }

    fn emit_channel(
        &mut self,
        window: Option<ReadyWindow>,
        inference: &mut dyn WhisperInferenceSession,
        sink: &mut dyn NormalizedBatchSink,
    ) -> Result<(), String> {
        let Some(window) = window else {
            return Ok(());
        };
        if signal_rms(&window.samples) < SILENCE_RMS_THRESHOLD {
            return Ok(());
        }
        let decoded = inference.transcribe(&window.samples, &window.history)?;
        let duration_ms = window.end_ms.saturating_sub(window.start_ms);
        let mut partials = Vec::new();
        for (index, segment) in decoded.into_iter().enumerate() {
            let relative_start = segment.start_ms.min(duration_ms);
            let relative_end = segment.end_ms.min(duration_ms);
            if relative_start >= relative_end || segment.text.trim().is_empty() {
                continue;
            }
            let segment_id = WireId::new(format!(
                "local:{}:{}:{}:{}",
                self.run_component, window.channel_id, self.window_index, index
            ))
            .map_err(|error| error.to_string())?;
            partials.push(NormalizedSegment {
                segment_id,
                revision: 0,
                state: SegmentState::Partial,
                start_ms: window.start_ms.saturating_add(relative_start),
                end_ms: window.start_ms.saturating_add(relative_end),
                text: segment.text,
                channel_id: Some(
                    WireId::new(window.channel_id).map_err(|error| error.to_string())?,
                ),
                speaker: Some(window.speaker.into()),
                language: segment.language,
                confidence: segment.confidence,
            });
        }
        if partials.is_empty() {
            return Ok(());
        }

        self.provider_sequence = self.provider_sequence.saturating_add(1);
        sink.ingest(NormalizedTranscriptBatch {
            provider_sequence: self.provider_sequence,
            batch_id: WireId::new(format!(
                "local-batch:{}:{}:partial",
                self.run_component, self.provider_sequence
            ))
            .map_err(|error| error.to_string())?,
            segments: partials.clone(),
        })?;

        let mut finals = partials;
        for segment in &mut finals {
            segment.revision = 1;
            segment.state = SegmentState::Final;
        }
        let recognized = finals
            .iter()
            .map(|segment| segment.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        self.remember_history(window.channel_id, &recognized);
        self.provider_sequence = self.provider_sequence.saturating_add(1);
        sink.ingest(NormalizedTranscriptBatch {
            provider_sequence: self.provider_sequence,
            batch_id: WireId::new(format!(
                "local-batch:{}:{}:final",
                self.run_component, self.provider_sequence
            ))
            .map_err(|error| error.to_string())?,
            segments: finals,
        })
    }

    fn remember_history(&mut self, channel_id: &str, text: &str) {
        let target = if channel_id == self.microphone.channel_id {
            &mut self.microphone.history
        } else {
            &mut self.system.history
        };
        if !target.is_empty() {
            target.push(' ');
        }
        target.push_str(text.trim());
        if target.len() > MAX_HISTORY_BYTES {
            let mut boundary = target.len() - MAX_HISTORY_BYTES;
            while !target.is_char_boundary(boundary) {
                boundary += 1;
            }
            target.drain(..boundary);
        }
    }
}

struct ChannelWindow {
    channel_id: &'static str,
    speaker: &'static str,
    start_ms: Option<u64>,
    end_ms: u64,
    samples: Vec<f32>,
    history: String,
}

impl ChannelWindow {
    fn new(channel_id: &'static str, speaker: &'static str) -> Self {
        Self {
            channel_id,
            speaker,
            start_ms: None,
            end_ms: 0,
            samples: Vec::new(),
            history: String::new(),
        }
    }

    fn push(&mut self, start_ms: u64, end_ms: u64, samples: Vec<f32>) -> Result<(), String> {
        if start_ms >= end_ms {
            return Err("durable audio chunk has an invalid timeline range".into());
        }
        if self.start_ms.is_none() {
            self.start_ms = Some(start_ms);
        }
        self.end_ms = end_ms;
        self.samples.extend(samples);
        Ok(())
    }

    fn take(&mut self) -> Option<ReadyWindow> {
        let start_ms = self.start_ms.take()?;
        if self.samples.is_empty() {
            return None;
        }
        let samples = std::mem::take(&mut self.samples);
        let history = self.history.clone();
        Some(ReadyWindow {
            channel_id: self.channel_id,
            speaker: self.speaker,
            start_ms,
            end_ms: self.end_ms,
            samples,
            history,
        })
    }
}

struct ReadyWindow {
    channel_id: &'static str,
    speaker: &'static str,
    start_ms: u64,
    end_ms: u64,
    samples: Vec<f32>,
    history: String,
}

fn split_stereo_f32le(bytes: &[u8]) -> Result<(Vec<f32>, Vec<f32>), String> {
    if bytes.is_empty() || !bytes.len().is_multiple_of(BYTES_PER_FRAME) {
        return Err("durable local Whisper audio is not aligned stereo f32le".into());
    }
    let frames = bytes.len() / BYTES_PER_FRAME;
    let mut microphone = Vec::with_capacity(frames);
    let mut system = Vec::with_capacity(frames);
    for frame in bytes.chunks_exact(BYTES_PER_FRAME) {
        let left = f32::from_le_bytes(
            frame[..size_of::<f32>()]
                .try_into()
                .map_err(|_| "could not decode microphone audio")?,
        );
        let right = f32::from_le_bytes(
            frame[size_of::<f32>()..]
                .try_into()
                .map_err(|_| "could not decode system audio")?,
        );
        if !left.is_finite() || !right.is_finite() {
            return Err("durable local Whisper audio contains a non-finite sample".into());
        }
        microphone.push(left.clamp(-1.0, 1.0));
        system.push(right.clamp(-1.0, 1.0));
    }
    Ok((microphone, system))
}

fn signal_rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let mean_square = samples
        .iter()
        .map(|sample| f64::from(*sample) * f64::from(*sample))
        .sum::<f64>()
        / samples.len() as f64;
    mean_square.sqrt() as f32
}

fn short_hash(value: &[u8]) -> String {
    let digest = Sha256::digest(value);
    digest[..12]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meetings::{
        config::{
            ConfigIdentifier, ModelDownloadUrl, MIN_MODEL_DISK_RESERVE_BYTES,
            MODEL_MANIFEST_SCHEMA_VERSION,
        },
        transcriber::{LocalFinalizeCommand, PersistedAudioSource},
    };
    use std::{
        fs,
        str::FromStr,
        sync::{
            atomic::{AtomicUsize, Ordering},
            mpsc, Mutex,
        },
    };
    use tempfile::TempDir;

    fn manifest(bytes: &[u8]) -> ModelManifest {
        ModelManifest {
            schema_version: MODEL_MANIFEST_SCHEMA_VERSION,
            model_id: ConfigIdentifier::new("whisper-small", "model id").unwrap(),
            version: ConfigIdentifier::new("pinned", "model version").unwrap(),
            platform: RuntimePlatform::MACOS_AARCH64,
            artifact_bytes: bytes.len() as u64,
            sha256: Sha256Digest::calculate(bytes).unwrap(),
            download_url: ModelDownloadUrl::new("https://models.example.com/whisper-small.bin")
                .unwrap(),
            disk_reserve_bytes: MIN_MODEL_DISK_RESERVE_BYTES,
        }
    }

    fn install_model(root: &Path, manifest: &ModelManifest, bytes: &[u8]) {
        let directory = root
            .join(manifest.model_id.as_str())
            .join(manifest.version.as_str());
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("model.bin"), bytes).unwrap();
    }

    struct FixtureArtifacts(PathBuf);

    impl ManagedWhisperArtifactResolver for FixtureArtifacts {
        fn artifact_for_use(&self, model_id: &str) -> Result<PathBuf, String> {
            Ok(self.0.join(model_id).join("pinned").join("model.bin"))
        }
    }

    fn artifacts(root: impl Into<PathBuf>) -> Arc<dyn ManagedWhisperArtifactResolver> {
        Arc::new(FixtureArtifacts(root.into()))
    }

    struct FakeBackend {
        prepares: AtomicUsize,
        calls: Arc<Mutex<Vec<Vec<f32>>>>,
    }

    impl FakeBackend {
        fn new(calls: Arc<Mutex<Vec<Vec<f32>>>>) -> Self {
            Self {
                prepares: AtomicUsize::new(0),
                calls,
            }
        }
    }

    impl WhisperInferenceBackend for FakeBackend {
        fn prepare(
            &self,
            artifact: &VerifiedModelArtifact,
        ) -> Result<PreparedWhisperSession, String> {
            self.prepares.fetch_add(1, Ordering::SeqCst);
            Ok(PreparedWhisperSession {
                artifact_path: artifact.path.clone(),
                artifact_sha256: artifact.sha256,
                runtime: WhisperRuntimeIdentity {
                    id: "fake-metal".into(),
                    version: "test".into(),
                },
                session: Box::new(FakeSession {
                    calls: Arc::clone(&self.calls),
                }),
            })
        }
    }

    struct FakeSession {
        calls: Arc<Mutex<Vec<Vec<f32>>>>,
    }

    impl WhisperInferenceSession for FakeSession {
        fn transcribe(
            &mut self,
            samples: &[f32],
            _history: &str,
        ) -> Result<Vec<DecodedSegment>, String> {
            self.calls.lock().unwrap().push(samples.to_vec());
            Ok(vec![DecodedSegment {
                start_ms: 100,
                end_ms: samples.len() as u64 * 1_000 / SAMPLE_RATE_HZ as u64,
                text: if samples[0] > 0.0 {
                    "microphone speech".into()
                } else {
                    "system speech".into()
                },
                language: Some("en".into()),
                confidence: Some(0.9),
            }])
        }
    }

    #[derive(Default)]
    struct CollectingSink {
        batches: Vec<NormalizedTranscriptBatch>,
    }

    impl NormalizedBatchSink for CollectingSink {
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

    fn write_chunk(root: &Path, meeting_id: &str, sequence: u64, left: f32, right: f32) {
        for (channel, value) in [("microphone", left), ("system", right)] {
            let directory = root.join(meeting_id).join("audio").join(channel);
            fs::create_dir_all(&directory).unwrap();
            let mut bytes = Vec::with_capacity(SAMPLE_RATE_HZ * size_of::<f32>());
            for _ in 0..SAMPLE_RATE_HZ {
                bytes.extend_from_slice(&value.to_le_bytes());
            }
            fs::write(directory.join(format!("{sequence:08}.f32le")), bytes).unwrap();
        }
    }

    #[test]
    fn verify_requires_exact_managed_artifact_before_probing_runtime() {
        let temporary = TempDir::new().unwrap();
        let expected = b"verified managed whisper model";
        let manifest = manifest(expected);
        install_model(
            temporary.path(),
            &manifest,
            b"tampered managed whisper model",
        );
        let calls = Arc::new(Mutex::new(Vec::new()));
        let backend = Arc::new(FakeBackend::new(calls));
        let runner = ManagedWhisperTranscriber::new(
            ManagedModelRegistry::new(
                artifacts(temporary.path()),
                [manifest],
                Some(RuntimePlatform::MACOS_AARCH64),
            )
            .unwrap(),
            backend.clone(),
            2,
            Duration::from_millis(1),
        )
        .unwrap();

        let error = runner.verify("whisper-small").unwrap_err();

        assert!(error.contains("exact size check") || error.contains("checksum check"));
        assert_eq!(backend.prepares.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn finalization_tails_durable_channels_and_emits_partial_then_final_revisions() {
        let temporary = TempDir::new().unwrap();
        let model_root = temporary.path().join("models");
        let audio_root = temporary.path().join("meetings");
        let expected = b"verified managed whisper model";
        let manifest = manifest(expected);
        install_model(&model_root, &manifest, expected);
        write_chunk(&audio_root, "meeting-1", 0, 0.25, -0.25);
        write_chunk(&audio_root, "meeting-1", 1, 0.25, -0.25);
        let calls = Arc::new(Mutex::new(Vec::new()));
        let backend = Arc::new(FakeBackend::new(Arc::clone(&calls)));
        let runner = ManagedWhisperTranscriber::new(
            ManagedModelRegistry::new(
                artifacts(model_root),
                [manifest],
                Some(RuntimePlatform::MACOS_AARCH64),
            )
            .unwrap(),
            backend.clone(),
            2,
            Duration::from_millis(1),
        )
        .unwrap();
        let evidence = runner.verify("whisper-small").unwrap();
        assert_eq!(evidence.runtime_id, "fake-metal");
        let audio = PersistedAudioSource::new(audio_root, "meeting-1").unwrap();
        let (finalize_tx, finalize_rx) = mpsc::channel();
        finalize_tx
            .send(LocalFinalizeCommand {
                observed_at: "2026-07-31T10:00:00Z".into(),
            })
            .unwrap();
        let mut sink = CollectingSink::default();

        runner
            .run(LocalTranscriptionContext {
                meeting_id: "meeting-1",
                run_id: "run-1",
                model_id: "whisper-small",
                audio: &audio,
                finalize: &finalize_rx,
                sink: &mut sink,
            })
            .unwrap();

        assert_eq!(calls.lock().unwrap().len(), 2);
        assert_eq!(sink.batches.len(), 4);
        assert_eq!(
            sink.batches
                .iter()
                .map(|batch| batch.provider_sequence)
                .collect::<Vec<_>>(),
            vec![1, 2, 3, 4]
        );
        for pair in sink.batches.chunks_exact(2) {
            assert_eq!(pair[0].segments[0].revision, 0);
            assert_eq!(pair[0].segments[0].state, SegmentState::Partial);
            assert_eq!(pair[1].segments[0].revision, 1);
            assert_eq!(pair[1].segments[0].state, SegmentState::Final);
            assert_eq!(
                pair[0].segments[0].segment_id,
                pair[1].segments[0].segment_id
            );
            assert_eq!(pair[0].segments[0].start_ms, 100);
            assert_eq!(pair[0].segments[0].end_ms, 2_000);
        }
        assert_eq!(
            sink.batches[0].segments[0]
                .channel_id
                .as_ref()
                .unwrap()
                .as_str(),
            "microphone"
        );
        assert_eq!(
            sink.batches[2].segments[0]
                .channel_id
                .as_ref()
                .unwrap()
                .as_str(),
            "system"
        );
        assert_eq!(sink.final_segment_count(), 2);
        assert_eq!(backend.prepares.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn silence_never_fabricates_a_transcript() {
        let mut stream = StreamingState::new("run-1", 1, Duration::from_millis(1));
        let calls = Arc::new(Mutex::new(Vec::new()));
        let mut inference = FakeSession {
            calls: Arc::clone(&calls),
        };
        let mut sink = CollectingSink::default();
        let bytes = vec![0_u8; SAMPLE_RATE_HZ * BYTES_PER_FRAME];

        stream
            .accept_chunk(
                PersistedAudioChunk {
                    sequence: 0,
                    start_ms: 0,
                    end_ms: 1_000,
                    bytes,
                },
                &mut inference,
                &mut sink,
            )
            .unwrap();

        assert!(calls.lock().unwrap().is_empty());
        assert!(sink.batches.is_empty());
    }

    #[test]
    fn finalization_drains_every_bounded_tail_page_before_returning() {
        let temporary = TempDir::new().unwrap();
        let model_root = temporary.path().join("models");
        let audio_root = temporary.path().join("meetings");
        let expected = b"verified managed whisper model";
        let manifest = manifest(expected);
        install_model(&model_root, &manifest, expected);
        for sequence in 0..40 {
            write_chunk(&audio_root, "meeting-long", sequence, 0.2, -0.2);
        }
        let calls = Arc::new(Mutex::new(Vec::new()));
        let backend = Arc::new(FakeBackend::new(Arc::clone(&calls)));
        let runner = ManagedWhisperTranscriber::new(
            ManagedModelRegistry::new(
                artifacts(model_root),
                [manifest],
                Some(RuntimePlatform::MACOS_AARCH64),
            )
            .unwrap(),
            backend,
            8,
            Duration::from_millis(1),
        )
        .unwrap();
        let audio = PersistedAudioSource::new(audio_root, "meeting-long").unwrap();
        let (finalize_tx, finalize_rx) = mpsc::channel();
        finalize_tx
            .send(LocalFinalizeCommand {
                observed_at: "2026-07-31T10:00:00Z".into(),
            })
            .unwrap();
        let mut sink = CollectingSink::default();

        runner
            .run(LocalTranscriptionContext {
                meeting_id: "meeting-long",
                run_id: "run-long",
                model_id: "whisper-small",
                audio: &audio,
                finalize: &finalize_rx,
                sink: &mut sink,
            })
            .unwrap();

        // Five eight-second windows, independently transcribed per channel.
        assert_eq!(calls.lock().unwrap().len(), 10);
        assert_eq!(sink.final_segment_count(), 10);
        let last_end = sink
            .batches
            .iter()
            .flat_map(|batch| &batch.segments)
            .map(|segment| segment.end_ms)
            .max()
            .unwrap();
        assert_eq!(last_end, 40_000);
    }

    #[test]
    fn invalid_samples_fail_instead_of_poisoning_inference() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&f32::NAN.to_le_bytes());
        bytes.extend_from_slice(&0_f32.to_le_bytes());

        assert!(split_stereo_f32le(&bytes)
            .unwrap_err()
            .contains("non-finite"));
    }

    #[cfg(unix)]
    #[test]
    fn symbolic_link_model_artifacts_are_rejected() {
        use std::os::unix::fs::symlink;

        let temporary = TempDir::new().unwrap();
        let bytes = b"verified managed whisper model";
        let manifest = manifest(bytes);
        let directory = temporary
            .path()
            .join(manifest.model_id.as_str())
            .join(manifest.version.as_str());
        fs::create_dir_all(&directory).unwrap();
        let outside = temporary.path().join("outside.bin");
        fs::write(&outside, bytes).unwrap();
        symlink(outside, directory.join("model.bin")).unwrap();
        let registry = ManagedModelRegistry::new(
            artifacts(temporary.path()),
            [manifest],
            Some(RuntimePlatform::MACOS_AARCH64),
        )
        .unwrap();

        assert!(registry
            .verify("whisper-small")
            .unwrap_err()
            .contains("symbolic link"));
    }

    #[test]
    fn checksum_parser_fixture_is_exact() {
        let digest = Sha256Digest::from_str(
            "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
        )
        .unwrap();
        assert_eq!(
            digest.to_string(),
            "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
        );
    }

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[test]
    fn production_build_registers_a_metal_device() {
        require_metal_device().unwrap();
    }
}
