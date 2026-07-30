// Adapted in design from Fastrepl Anarlog
// crates/audio-actual/src/capture/joiner.rs at
// 08aad83f0c5cef1317d74a31519ae3190d726504 (MIT).
// Upstream silently substituted zero-filled vectors and discarded queue
// entries. Mimir instead emits typed missing tracks and cumulative health.

use std::collections::BTreeMap;

use thiserror::Error;

use crate::{AudioSource, CaptureHealth, DualRawFrame, GapReason, JoinedTrack, RawAudioFrame};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct JoinerConfig {
    pub max_lag_windows: u64,
    pub max_pending_windows: usize,
    pub first_sequence: u64,
}

impl JoinerConfig {
    pub fn validate(self) -> Result<Self, JoinError> {
        if self.max_lag_windows == 0 {
            return Err(JoinError::InvalidConfig("max_lag_windows must be non-zero"));
        }
        if self.max_pending_windows == 0 {
            return Err(JoinError::InvalidConfig(
                "max_pending_windows must be non-zero",
            ));
        }
        Ok(self)
    }
}

impl Default for JoinerConfig {
    fn default() -> Self {
        Self {
            max_lag_windows: 4,
            max_pending_windows: 30,
            first_sequence: 0,
        }
    }
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum JoinError {
    #[error("invalid joiner configuration: {0}")]
    InvalidConfig(&'static str),
    #[error("invalid frame: {0}")]
    InvalidFrame(String),
    #[error("{track:?} frame {sequence} arrived more than once")]
    Duplicate { track: AudioSource, sequence: u64 },
    #[error("{track:?} frame {sequence} arrived after the joiner advanced")]
    Late { track: AudioSource, sequence: u64 },
}

#[derive(Debug, Default)]
struct Slot {
    microphone: Option<RawAudioFrame>,
    system_audio: Option<RawAudioFrame>,
}

impl Slot {
    fn get_mut(&mut self, source: AudioSource) -> &mut Option<RawAudioFrame> {
        match source {
            AudioSource::Microphone => &mut self.microphone,
            AudioSource::SystemAudio => &mut self.system_audio,
        }
    }
}

/// Bounded sequence joiner for already duration-aligned source frames.
#[derive(Debug)]
pub struct FrameJoiner {
    config: JoinerConfig,
    health: CaptureHealth,
    next_sequence: u64,
    slots: BTreeMap<u64, Slot>,
    highest_seen: [Option<u64>; 2],
    closed: [bool; 2],
}

impl FrameJoiner {
    pub fn new(config: JoinerConfig, health: CaptureHealth) -> Result<Self, JoinError> {
        let config = config.validate()?;
        Ok(Self {
            next_sequence: config.first_sequence,
            config,
            health,
            slots: BTreeMap::new(),
            highest_seen: [None, None],
            closed: [false, false],
        })
    }

    pub fn push(&mut self, frame: RawAudioFrame) -> Result<(), JoinError> {
        frame
            .validate()
            .map_err(|error| JoinError::InvalidFrame(error.to_string()))?;
        let source = frame.source;
        let sequence = frame.sequence;
        if sequence < self.next_sequence {
            self.health.record_late();
            return Err(JoinError::Late {
                track: source,
                sequence,
            });
        }
        let slot = self.slots.entry(sequence).or_default();
        let target = slot.get_mut(source);
        if target.is_some() {
            self.health.record_duplicate();
            return Err(JoinError::Duplicate {
                track: source,
                sequence,
            });
        }
        *target = Some(frame);
        self.highest_seen[source.index()] =
            Some(self.highest_seen[source.index()].map_or(sequence, |old| old.max(sequence)));
        Ok(())
    }

    pub fn close(&mut self, source: AudioSource) {
        self.closed[source.index()] = true;
    }

    pub fn close_all(&mut self) {
        self.closed = [true, true];
    }

    pub fn next_sequence(&self) -> u64 {
        self.next_sequence
    }

    pub fn is_drained(&self) -> bool {
        self.slots.is_empty()
    }

    fn highest_any(&self) -> Option<u64> {
        self.highest_seen.into_iter().flatten().max()
    }

    fn missing_is_ready(&self, source: AudioSource, pressure: bool) -> bool {
        if pressure || self.closed[source.index()] {
            return true;
        }
        self.highest_any().is_some_and(|highest| {
            highest.saturating_sub(self.next_sequence) >= self.config.max_lag_windows
        })
    }

    fn missing_reason(&self, source: AudioSource, pressure: bool) -> GapReason {
        if pressure {
            GapReason::JoinQueueOverflow
        } else if self.closed[source.index()] {
            GapReason::SourceEnded
        } else {
            GapReason::MissingSequence
        }
    }

    /// Returns the next pair when both tracks exist or bounded lag/closure
    /// makes a typed missing track necessary.
    pub fn pop_ready(&mut self) -> Option<DualRawFrame> {
        let sequence = self.next_sequence;
        let highest = self.highest_any()?;
        if sequence > highest {
            return None;
        }

        let pressure = self.slots.len() > self.config.max_pending_windows;
        let slot = self.slots.get(&sequence);
        let has_mic = slot.and_then(|value| value.microphone.as_ref()).is_some();
        let has_system = slot.and_then(|value| value.system_audio.as_ref()).is_some();

        if !has_mic && !self.missing_is_ready(AudioSource::Microphone, pressure) {
            return None;
        }
        if !has_system && !self.missing_is_ready(AudioSource::SystemAudio, pressure) {
            return None;
        }

        if pressure {
            self.health.record_join_overflow();
        }
        let mut slot = self.slots.remove(&sequence).unwrap_or_default();
        let microphone = slot.microphone.take().map_or_else(
            || {
                self.health.record_gap();
                self.health.record_dropped_frame(AudioSource::Microphone);
                JoinedTrack::Missing {
                    source: AudioSource::Microphone,
                    sequence,
                    reason: self.missing_reason(AudioSource::Microphone, pressure),
                }
            },
            JoinedTrack::Frame,
        );
        let system_audio = slot.system_audio.take().map_or_else(
            || {
                self.health.record_gap();
                self.health.record_dropped_frame(AudioSource::SystemAudio);
                JoinedTrack::Missing {
                    source: AudioSource::SystemAudio,
                    sequence,
                    reason: self.missing_reason(AudioSource::SystemAudio, pressure),
                }
            },
            JoinedTrack::Frame,
        );
        self.next_sequence = self.next_sequence.saturating_add(1);

        Some(DualRawFrame {
            sequence,
            microphone,
            system_audio,
            health: self.health.snapshot(),
        })
    }
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::*;
    use crate::{AudioFormat, RawAudioSpan};

    fn frame(source: AudioSource, sequence: u64) -> RawAudioFrame {
        RawAudioFrame {
            source,
            sequence,
            format: AudioFormat::mono(1_000).unwrap(),
            start_sample: sequence * 2,
            sample_count: 2,
            spans: vec![RawAudioSpan::Samples {
                start_sample: sequence * 2,
                samples: vec![sequence as f32, source.index() as f32],
            }],
        }
    }

    #[test]
    fn lag_emits_explicit_missing_track_without_zero_fill() {
        let health = CaptureHealth::default();
        let mut joiner = FrameJoiner::new(
            JoinerConfig {
                max_lag_windows: 2,
                ..JoinerConfig::default()
            },
            health,
        )
        .unwrap();
        joiner.push(frame(AudioSource::Microphone, 0)).unwrap();
        joiner.push(frame(AudioSource::Microphone, 1)).unwrap();
        joiner.push(frame(AudioSource::Microphone, 2)).unwrap();

        let joined = joiner.pop_ready().unwrap();
        assert!(matches!(joined.microphone, JoinedTrack::Frame(_)));
        assert!(matches!(
            joined.system_audio,
            JoinedTrack::Missing {
                reason: GapReason::MissingSequence,
                ..
            }
        ));
        assert_eq!(joined.health.emitted_gaps, 1);
    }

    #[test]
    fn closure_flushes_unpaired_tail_then_stops() {
        let health = CaptureHealth::default();
        let mut joiner = FrameJoiner::new(JoinerConfig::default(), health).unwrap();
        joiner.push(frame(AudioSource::SystemAudio, 0)).unwrap();
        joiner.close_all();
        let joined = joiner.pop_ready().unwrap();
        assert!(matches!(
            joined.microphone,
            JoinedTrack::Missing {
                reason: GapReason::SourceEnded,
                ..
            }
        ));
        assert!(joiner.pop_ready().is_none());
        assert!(joiner.is_drained());
    }

    #[test]
    fn duplicate_and_late_frames_are_visible_in_health() {
        let health = CaptureHealth::default();
        let mut joiner = FrameJoiner::new(JoinerConfig::default(), health.clone()).unwrap();
        joiner.push(frame(AudioSource::Microphone, 0)).unwrap();
        assert!(matches!(
            joiner.push(frame(AudioSource::Microphone, 0)),
            Err(JoinError::Duplicate { .. })
        ));
        joiner.close_all();
        joiner.pop_ready().unwrap();
        assert!(matches!(
            joiner.push(frame(AudioSource::Microphone, 0)),
            Err(JoinError::Late { .. })
        ));
        let snapshot = health.snapshot();
        assert_eq!(snapshot.duplicate_frames, 1);
        assert_eq!(snapshot.late_frames, 1);
    }

    proptest! {
        #[test]
        fn emitted_sequences_are_monotonic_and_tracks_never_swap(
            mic_sequences in prop::collection::btree_set(0_u64..64, 0..64),
            system_sequences in prop::collection::btree_set(0_u64..64, 0..64),
        ) {
            let health = CaptureHealth::default();
            let mut joiner = FrameJoiner::new(
                JoinerConfig {
                    max_lag_windows: 3,
                    max_pending_windows: 8,
                    first_sequence: 0,
                },
                health,
            ).unwrap();
            for sequence in mic_sequences {
                joiner.push(frame(AudioSource::Microphone, sequence)).unwrap();
            }
            for sequence in system_sequences {
                joiner.push(frame(AudioSource::SystemAudio, sequence)).unwrap();
            }
            joiner.close_all();

            let mut expected = 0;
            while let Some(joined) = joiner.pop_ready() {
                prop_assert_eq!(joined.sequence, expected);
                prop_assert_eq!(joined.microphone.source(), AudioSource::Microphone);
                prop_assert_eq!(joined.system_audio.source(), AudioSource::SystemAudio);
                expected += 1;
            }
        }
    }
}
