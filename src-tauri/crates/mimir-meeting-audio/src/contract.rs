use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// The two independently captured, canonical meeting tracks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AudioSource {
    Microphone,
    SystemAudio,
}

impl AudioSource {
    pub(crate) const fn index(self) -> usize {
        match self {
            Self::Microphone => 0,
            Self::SystemAudio => 1,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct AudioFormat {
    pub sample_rate_hz: u32,
    pub channels: u16,
}

impl AudioFormat {
    /// Mimir capture backends currently emit mono source tracks.
    ///
    /// # Errors
    ///
    /// Returns [`CaptureError::InvalidConfig`] when the rate is zero.
    pub fn mono(sample_rate_hz: u32) -> Result<Self, CaptureError> {
        let format = Self {
            sample_rate_hz,
            channels: 1,
        };
        format.validate()?;
        Ok(format)
    }

    /// # Errors
    ///
    /// Returns [`CaptureError::InvalidConfig`] for a zero rate or channel count.
    pub fn validate(self) -> Result<(), CaptureError> {
        if self.sample_rate_hz == 0 {
            return Err(CaptureError::InvalidConfig(
                "sample_rate_hz must be non-zero".into(),
            ));
        }
        if self.channels == 0 {
            return Err(CaptureError::InvalidConfig(
                "channels must be non-zero".into(),
            ));
        }
        Ok(())
    }
}

/// Duration of one source frame. Both sources must use the same duration;
/// their sample counts may differ when their device rates differ.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct FrameDuration {
    milliseconds: u16,
}

impl FrameDuration {
    pub const DEFAULT: Self = Self { milliseconds: 20 };

    /// # Errors
    ///
    /// Returns [`CaptureError::InvalidConfig`] outside the supported
    /// 1–1000 ms interval.
    pub fn from_millis(milliseconds: u16) -> Result<Self, CaptureError> {
        if milliseconds == 0 || milliseconds > 1_000 {
            return Err(CaptureError::InvalidConfig(
                "frame duration must be between 1 and 1000 ms".into(),
            ));
        }
        Ok(Self { milliseconds })
    }

    #[must_use]
    pub const fn as_millis(self) -> u16 {
        self.milliseconds
    }

    /// # Errors
    ///
    /// Returns [`CaptureError::InvalidConfig`] when the rate is zero, the
    /// duration does not produce a whole sample count, or the result overflows.
    pub fn samples_at(self, sample_rate_hz: u32) -> Result<usize, CaptureError> {
        if sample_rate_hz == 0 {
            return Err(CaptureError::InvalidConfig(
                "sample rate must be non-zero".into(),
            ));
        }
        let numerator = u64::from(sample_rate_hz) * u64::from(self.milliseconds);
        if numerator % 1_000 != 0 {
            return Err(CaptureError::InvalidConfig(format!(
                "{sample_rate_hz} Hz cannot be divided into exact {} ms frames",
                self.milliseconds
            )));
        }
        usize::try_from(numerator / 1_000)
            .map_err(|_| CaptureError::InvalidConfig("frame size exceeds usize".into()))
    }
}

impl Default for FrameDuration {
    fn default() -> Self {
        Self::DEFAULT
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GapReason {
    /// Samples were dropped because the realtime ring was full.
    RealtimeOverflow,
    /// This source skipped a frame sequence.
    MissingSequence,
    /// The bounded join queue was forced to advance.
    JoinQueueOverflow,
    /// The source ended before its peer.
    SourceEnded,
}

/// An exact gap within a source's sample clock.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CaptureGap {
    pub source: AudioSource,
    pub start_sample: u64,
    /// `None` is used only when a whole peer frame never arrived and its
    /// native sample count is unknown.
    pub sample_count: Option<u64>,
    pub reason: GapReason,
}

/// One contiguous portion of a raw source frame.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RawAudioSpan {
    Samples {
        start_sample: u64,
        samples: Vec<f32>,
    },
    Gap(CaptureGap),
}

impl RawAudioSpan {
    #[must_use]
    pub fn sample_count(&self) -> u64 {
        match self {
            Self::Samples { samples, .. } => samples.len() as u64,
            Self::Gap(gap) => gap.sample_count.unwrap_or(0),
        }
    }
}

/// A fixed-duration canonical window from exactly one source.
///
/// Spans retain precise realtime-overflow gaps instead of replacing missing
/// audio with zeros. No span can contain samples from the other source.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RawAudioFrame {
    pub source: AudioSource,
    pub sequence: u64,
    pub format: AudioFormat,
    pub start_sample: u64,
    pub sample_count: u64,
    pub spans: Vec<RawAudioSpan>,
}

impl RawAudioFrame {
    /// # Errors
    ///
    /// Returns [`CaptureError::InvalidFrame`] when spans are empty-sized,
    /// non-contiguous, misattributed, or do not cover the declared frame.
    pub fn validate(&self) -> Result<(), CaptureError> {
        self.format.validate()?;
        if self.sample_count == 0 {
            return Err(CaptureError::InvalidFrame(
                "sample_count must be non-zero".into(),
            ));
        }
        let span_count = self
            .spans
            .iter()
            .try_fold(0_u64, |total, span| total.checked_add(span.sample_count()))
            .ok_or_else(|| CaptureError::InvalidFrame("span sample count overflow".into()))?;
        if span_count != self.sample_count {
            return Err(CaptureError::InvalidFrame(format!(
                "spans cover {span_count} samples, expected {}",
                self.sample_count
            )));
        }

        let mut expected = self.start_sample;
        for span in &self.spans {
            let start = match span {
                RawAudioSpan::Samples { start_sample, .. } => *start_sample,
                RawAudioSpan::Gap(gap) => {
                    if gap.source != self.source {
                        return Err(CaptureError::InvalidFrame(
                            "gap source differs from frame source".into(),
                        ));
                    }
                    gap.start_sample
                }
            };
            if start != expected {
                return Err(CaptureError::InvalidFrame(format!(
                    "non-contiguous span: got {start}, expected {expected}"
                )));
            }
            expected = expected
                .checked_add(span.sample_count())
                .ok_or_else(|| CaptureError::InvalidFrame("sample clock overflow".into()))?;
        }
        Ok(())
    }

    #[must_use]
    pub fn contains_gap(&self) -> bool {
        self.spans
            .iter()
            .any(|span| matches!(span, RawAudioSpan::Gap(_)))
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum JoinedTrack {
    Frame(RawAudioFrame),
    Missing {
        source: AudioSource,
        sequence: u64,
        reason: GapReason,
    },
}

impl JoinedTrack {
    #[must_use]
    pub const fn source(&self) -> AudioSource {
        match self {
            Self::Frame(frame) => frame.source,
            Self::Missing { source, .. } => *source,
        }
    }
}

/// A duration-aligned view that never merges or destroys the raw tracks.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DualRawFrame {
    pub sequence: u64,
    pub microphone: JoinedTrack,
    pub system_audio: JoinedTrack,
    pub health: CaptureHealthSnapshot,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceHealthSnapshot {
    pub alive: bool,
    pub dropped_samples: u64,
    pub dropped_frames: u64,
    pub callback_errors: u64,
    pub discontinuities: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CaptureHealthSnapshot {
    pub microphone: SourceHealthSnapshot,
    pub system_audio: SourceHealthSnapshot,
    pub emitted_gaps: u64,
    pub join_queue_overflows: u64,
    pub duplicate_frames: u64,
    pub late_frames: u64,
}

#[derive(Debug, Default)]
struct SourceHealth {
    alive: AtomicBool,
    dropped_samples: AtomicU64,
    dropped_frames: AtomicU64,
    callback_errors: AtomicU64,
    discontinuities: AtomicU64,
}

impl SourceHealth {
    fn snapshot(&self) -> SourceHealthSnapshot {
        SourceHealthSnapshot {
            alive: self.alive.load(Ordering::Acquire),
            dropped_samples: self.dropped_samples.load(Ordering::Relaxed),
            dropped_frames: self.dropped_frames.load(Ordering::Relaxed),
            callback_errors: self.callback_errors.load(Ordering::Relaxed),
            discontinuities: self.discontinuities.load(Ordering::Relaxed),
        }
    }
}

#[derive(Debug, Default)]
struct HealthInner {
    sources: [SourceHealth; 2],
    emitted_gaps: AtomicU64,
    join_queue_overflows: AtomicU64,
    duplicate_frames: AtomicU64,
    late_frames: AtomicU64,
}

/// Cloneable, lock-free health counters shared by realtime and async paths.
///
/// Counters are cumulative for the life of the capture session. Reading a
/// snapshot never resets evidence that recovery or UI code may still need.
#[derive(Debug, Clone, Default)]
pub struct CaptureHealth(Arc<HealthInner>);

impl CaptureHealth {
    #[must_use]
    pub fn snapshot(&self) -> CaptureHealthSnapshot {
        CaptureHealthSnapshot {
            microphone: self.0.sources[0].snapshot(),
            system_audio: self.0.sources[1].snapshot(),
            emitted_gaps: self.0.emitted_gaps.load(Ordering::Relaxed),
            join_queue_overflows: self.0.join_queue_overflows.load(Ordering::Relaxed),
            duplicate_frames: self.0.duplicate_frames.load(Ordering::Relaxed),
            late_frames: self.0.late_frames.load(Ordering::Relaxed),
        }
    }

    pub(crate) fn mark_started(&self, source: AudioSource) {
        self.0.sources[source.index()]
            .alive
            .store(true, Ordering::Release);
    }

    pub(crate) fn mark_stopped(&self, source: AudioSource) {
        self.0.sources[source.index()]
            .alive
            .store(false, Ordering::Release);
    }

    pub(crate) fn record_dropped_samples(&self, source: AudioSource, count: usize) {
        if count == 0 {
            return;
        }
        self.0.sources[source.index()]
            .dropped_samples
            .fetch_add(count as u64, Ordering::Relaxed);
    }

    pub(crate) fn record_dropped_frame(&self, source: AudioSource) {
        self.0.sources[source.index()]
            .dropped_frames
            .fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn record_callback_error(&self, source: AudioSource) {
        self.0.sources[source.index()]
            .callback_errors
            .fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn record_discontinuity(&self, source: AudioSource) {
        self.0.sources[source.index()]
            .discontinuities
            .fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn record_gap(&self) {
        self.0.emitted_gaps.fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn record_join_overflow(&self) {
        self.0.join_queue_overflows.fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn record_duplicate(&self) {
        self.0.duplicate_frames.fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn record_late(&self) {
        self.0.late_frames.fetch_add(1, Ordering::Relaxed);
    }
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum CaptureError {
    #[error("invalid capture configuration: {0}")]
    InvalidConfig(String),
    #[error("invalid raw audio frame: {0}")]
    InvalidFrame(String),
    #[error("audio capture is unsupported on {platform}")]
    UnsupportedPlatform { platform: &'static str },
    #[error("no microphone input device is available")]
    NoInputDevice,
    #[error("microphone '{0}' was not found")]
    InputDeviceNotFound(String),
    #[error("unsupported audio sample format: {0}")]
    UnsupportedSampleFormat(String),
    #[error("{component} capture failed: {detail}")]
    Backend {
        component: &'static str,
        detail: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_frame_rejects_hidden_holes() {
        let frame = RawAudioFrame {
            source: AudioSource::Microphone,
            sequence: 0,
            format: AudioFormat::mono(48_000).unwrap(),
            start_sample: 0,
            sample_count: 4,
            spans: vec![
                RawAudioSpan::Samples {
                    start_sample: 0,
                    samples: vec![0.1, 0.2],
                },
                RawAudioSpan::Samples {
                    start_sample: 3,
                    samples: vec![0.3, 0.4],
                },
            ],
        };
        assert!(frame.validate().is_err());
    }

    #[test]
    fn duration_requires_exact_device_windows() {
        assert_eq!(FrameDuration::DEFAULT.samples_at(48_000).unwrap(), 960);
        assert_eq!(FrameDuration::DEFAULT.samples_at(44_100).unwrap(), 882);
        assert!(FrameDuration::from_millis(7)
            .unwrap()
            .samples_at(44_100)
            .is_err());
    }
}
