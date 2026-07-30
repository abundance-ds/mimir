use std::pin::Pin;
use std::task::{Context, Poll};

use futures_util::Stream;

use crate::{
    AsyncRingReader, AudioFormat, AudioSource, BridgeEvent, CaptureGap, CaptureHealth,
    FrameDuration, GapReason, RawAudioFrame, RawAudioSpan,
};

#[derive(Debug)]
enum Pending {
    Samples {
        start: u64,
        values: Vec<f32>,
        offset: usize,
    },
    Gap {
        gap: CaptureGap,
        consumed: u64,
    },
}

impl From<BridgeEvent> for Pending {
    fn from(event: BridgeEvent) -> Self {
        match event {
            BridgeEvent::Samples {
                start_sample,
                samples,
            } => Self::Samples {
                start: start_sample,
                values: samples,
                offset: 0,
            },
            BridgeEvent::Gap(gap) => Self::Gap { gap, consumed: 0 },
        }
    }
}

/// Converts exact sample/gap events into fixed-duration source frames.
pub(crate) struct FramedReader {
    inner: AsyncRingReader,
    source: AudioSource,
    format: AudioFormat,
    frame_samples: usize,
    sequence: u64,
    frame_start: u64,
    spans: Vec<RawAudioSpan>,
    filled: usize,
    pending: Option<Pending>,
    source_ended: bool,
    emitted_final: bool,
    health: CaptureHealth,
}

impl std::fmt::Debug for FramedReader {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("FramedReader")
            .field("source", &self.source)
            .field("format", &self.format)
            .field("frame_samples", &self.frame_samples)
            .field("sequence", &self.sequence)
            .finish_non_exhaustive()
    }
}

impl FramedReader {
    pub(crate) fn new(
        inner: AsyncRingReader,
        source: AudioSource,
        format: AudioFormat,
        duration: FrameDuration,
        health: CaptureHealth,
    ) -> Result<Self, crate::CaptureError> {
        format.validate()?;
        if format.channels != 1 {
            return Err(crate::CaptureError::InvalidConfig(
                "framed capture currently requires mono source tracks".into(),
            ));
        }
        let frame_samples = duration.samples_at(format.sample_rate_hz)?;
        Ok(Self {
            inner,
            source,
            format,
            frame_samples,
            sequence: 0,
            frame_start: 0,
            spans: Vec::new(),
            filled: 0,
            pending: None,
            source_ended: false,
            emitted_final: false,
            health,
        })
    }

    fn consume_pending(&mut self) {
        let remaining_in_frame = self.frame_samples - self.filled;
        let Some(pending) = self.pending.take() else {
            return;
        };
        match pending {
            Pending::Samples {
                start,
                values,
                offset,
            } => {
                let available = values.len() - offset;
                let take = available.min(remaining_in_frame);
                self.spans.push(RawAudioSpan::Samples {
                    start_sample: start + offset as u64,
                    samples: values[offset..offset + take].to_vec(),
                });
                self.filled += take;
                if take < available {
                    self.pending = Some(Pending::Samples {
                        start,
                        values,
                        offset: offset + take,
                    });
                }
            }
            Pending::Gap { gap, consumed } => {
                let total = gap.sample_count.unwrap_or(0);
                let available = total.saturating_sub(consumed);
                let take = available.min(remaining_in_frame as u64);
                if take > 0 {
                    let take_usize =
                        usize::try_from(take).expect("take is bounded by a usize frame size");
                    self.spans.push(RawAudioSpan::Gap(CaptureGap {
                        source: gap.source,
                        start_sample: gap.start_sample + consumed,
                        sample_count: Some(take),
                        reason: gap.reason,
                    }));
                    self.filled += take_usize;
                }
                if take < available {
                    self.pending = Some(Pending::Gap {
                        gap,
                        consumed: consumed + take,
                    });
                }
            }
        }
    }

    fn finish_frame(&mut self) -> RawAudioFrame {
        let frame = RawAudioFrame {
            source: self.source,
            sequence: self.sequence,
            format: self.format,
            start_sample: self.frame_start,
            sample_count: self.frame_samples as u64,
            spans: std::mem::take(&mut self.spans),
        };
        debug_assert!(frame.validate().is_ok());
        self.sequence = self.sequence.saturating_add(1);
        self.frame_start = self.frame_start.saturating_add(self.frame_samples as u64);
        self.filled = 0;
        frame
    }
}

impl Stream for FramedReader {
    type Item = RawAudioFrame;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        loop {
            if self.filled == self.frame_samples {
                return Poll::Ready(Some(self.finish_frame()));
            }
            if self.pending.is_some() {
                self.consume_pending();
                continue;
            }
            if self.source_ended {
                if self.filled == 0 || self.emitted_final {
                    return Poll::Ready(None);
                }
                let missing = self.frame_samples - self.filled;
                let source = self.source;
                let start_sample = self.frame_start + self.filled as u64;
                self.spans.push(RawAudioSpan::Gap(CaptureGap {
                    source,
                    start_sample,
                    sample_count: Some(missing as u64),
                    reason: GapReason::SourceEnded,
                }));
                self.filled = self.frame_samples;
                self.emitted_final = true;
                self.health.record_gap();
                self.health.record_dropped_frame(self.source);
                continue;
            }

            match Pin::new(&mut self.inner).poll_next(cx) {
                Poll::Ready(Some(event)) => self.pending = Some(event.into()),
                Poll::Ready(None) => self.source_ended = true,
                Poll::Pending => return Poll::Pending,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use futures_util::StreamExt;

    use super::*;
    use crate::realtime_bridge;

    #[test]
    fn frame_keeps_partial_samples_and_exact_overflow_gap() {
        futures_executor::block_on(async {
            let health = CaptureHealth::default();
            let (mut writer, reader) =
                realtime_bridge(2, 8, AudioSource::Microphone, health.clone()).unwrap();
            let format = AudioFormat::mono(1_000).unwrap();
            let duration = FrameDuration::from_millis(4).unwrap();
            let mut framed =
                FramedReader::new(reader, AudioSource::Microphone, format, duration, health)
                    .unwrap();

            writer.push_f32(&[1.0, 2.0, 3.0]);
            // Drain the first two samples, then place the post-gap sample.
            assert!(matches!(futures_util::poll!(framed.next()), Poll::Pending));
            writer.push_f32(&[4.0]);
            let frame = framed.next().await.unwrap();
            assert_eq!(frame.sample_count, 4);
            assert!(frame.contains_gap());
            assert_eq!(
                frame.spans,
                vec![
                    RawAudioSpan::Samples {
                        start_sample: 0,
                        samples: vec![1.0, 2.0],
                    },
                    RawAudioSpan::Gap(CaptureGap {
                        source: AudioSource::Microphone,
                        start_sample: 2,
                        sample_count: Some(1),
                        reason: GapReason::RealtimeOverflow,
                    }),
                    RawAudioSpan::Samples {
                        start_sample: 3,
                        samples: vec![4.0],
                    },
                ]
            );
            frame.validate().unwrap();
        });
    }
}
