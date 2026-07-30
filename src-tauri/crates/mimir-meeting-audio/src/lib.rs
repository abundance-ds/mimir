//! Lean capture primitives for Mimir meeting recordings.
//!
//! Canonical capture data always keeps microphone and system audio separate.
//! This crate performs no AEC, VAD, resampling, encoding, or transcription.
//!
//! Portions of the design were adapted from Fastrepl Anarlog at commit
//! `08aad83f0c5cef1317d74a31519ae3190d726504` (MIT):
//! <https://github.com/fastrepl/anarlog>. See each adapted module for the
//! precise upstream paths. Mimir owns this API and its stricter gap/health
//! semantics.

mod async_ring;
mod backend;
mod contract;
mod drift;
mod joiner;
mod rt_ring;

pub use async_ring::{realtime_bridge, AsyncRingReader, BridgeEvent, RealtimeWriter};
pub use backend::{
    list_microphones, MicrophoneInput, MicrophoneStream, SystemAudioInput, SystemAudioStream,
};
pub use contract::{
    AudioFormat, AudioSource, CaptureError, CaptureGap, CaptureHealth, CaptureHealthSnapshot,
    DualRawFrame, FrameDuration, GapReason, JoinedTrack, RawAudioFrame, RawAudioSpan,
    SourceHealthSnapshot,
};
pub use drift::{
    DriftConfig, DriftConfigError, DriftResetReason, DriftSnapshot, DriftTracker, DriftUpdate,
};
pub use joiner::{FrameJoiner, JoinError, JoinerConfig};
pub use rt_ring::PushStats;
