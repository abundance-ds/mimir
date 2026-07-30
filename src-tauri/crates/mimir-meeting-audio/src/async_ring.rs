// Adapted in design from Fastrepl Anarlog
// crates/audio-actual/src/async_ring.rs at
// 08aad83f0c5cef1317d74a31519ae3190d726504 (MIT).
// Unlike upstream, counters are cumulative and each ring entry carries its
// source sample index, allowing deterministic overflow-gap reconstruction.

use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};

use futures_util::task::AtomicWaker;
use futures_util::Stream;
use ringbuf::traits::{Consumer, Producer, Split};
use ringbuf::{HeapCons, HeapProd, HeapRb};

use crate::contract::{AudioSource, CaptureGap, CaptureHealth, GapReason};
use crate::rt_ring::{self, PushStats, SampleSink};

#[derive(Debug, Clone, Copy, Default)]
struct RingSample {
    index: u64,
    value: f32,
}

#[derive(Debug)]
struct SignalInner {
    alive: AtomicBool,
    next_sample: AtomicU64,
    wake_pending: AtomicBool,
    waker: AtomicWaker,
}

#[derive(Debug, Clone)]
struct RealtimeSignal(Arc<SignalInner>);

impl RealtimeSignal {
    fn new() -> Self {
        Self(Arc::new(SignalInner {
            alive: AtomicBool::new(true),
            next_sample: AtomicU64::new(0),
            wake_pending: AtomicBool::new(false),
            waker: AtomicWaker::new(),
        }))
    }

    fn wake_reader(&self) {
        if self.0.wake_pending.swap(false, Ordering::AcqRel) {
            self.0.waker.wake();
        }
    }

    fn stop(&self) {
        self.0.alive.store(false, Ordering::Release);
        self.0.waker.wake();
    }
}

#[derive(Debug, Clone)]
pub(crate) struct RealtimeFailureHandle {
    signal: RealtimeSignal,
    source: AudioSource,
    health: CaptureHealth,
}

impl RealtimeFailureHandle {
    pub(crate) fn fail(&self) {
        self.health.record_callback_error(self.source);
        self.health.mark_stopped(self.source);
        self.signal.stop();
    }
}

/// Realtime callback handle. Its push methods allocate nothing and never
/// block. The caller owns conversion scratch storage.
pub struct RealtimeWriter {
    producer: HeapProd<RingSample>,
    signal: RealtimeSignal,
    source: AudioSource,
    health: CaptureHealth,
    next_sample: u64,
}

impl std::fmt::Debug for RealtimeWriter {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RealtimeWriter")
            .field("source", &self.source)
            .field("next_sample", &self.next_sample)
            .finish_non_exhaustive()
    }
}

impl RealtimeWriter {
    pub fn push_f32(&mut self, samples: &[f32]) -> PushStats {
        let stats = rt_ring::push_f32(samples, self);
        self.finish_push(stats)
    }

    pub fn push_converted<T>(
        &mut self,
        samples: &[T],
        scratch: &mut [f32],
        convert: impl FnMut(T) -> f32,
    ) -> PushStats
    where
        T: Copy,
    {
        let stats = rt_ring::push_converted(samples, scratch, self, convert);
        self.finish_push(stats)
    }

    pub fn push_interleaved_downmix<T>(
        &mut self,
        samples: &[T],
        channels: usize,
        scratch: &mut [f32],
        convert: impl FnMut(T) -> f32,
    ) -> PushStats
    where
        T: Copy,
    {
        let stats = rt_ring::push_interleaved_downmix(samples, channels, scratch, self, convert);
        self.finish_push(stats)
    }

    fn finish_push(&self, stats: PushStats) -> PushStats {
        self.signal
            .0
            .next_sample
            .store(self.next_sample, Ordering::Release);
        self.health
            .record_dropped_samples(self.source, stats.dropped_samples);
        if stats.pushed_samples > 0 {
            self.signal.wake_reader();
        }
        stats
    }

    /// Marks a backend callback failure and lets the reader terminate after
    /// draining all samples and reconstructing the final gap.
    pub fn mark_failed(&self) {
        self.health.record_callback_error(self.source);
        self.health.mark_stopped(self.source);
        self.signal.stop();
    }

    pub(crate) fn failure_handle(&self) -> RealtimeFailureHandle {
        RealtimeFailureHandle {
            signal: self.signal.clone(),
            source: self.source,
            health: self.health.clone(),
        }
    }
}

impl SampleSink for RealtimeWriter {
    fn push_sample(&mut self, sample: f32) -> bool {
        let stamped = RingSample {
            index: self.next_sample,
            value: sample,
        };
        self.next_sample = self.next_sample.saturating_add(1);
        self.producer.try_push(stamped).is_ok()
    }
}

impl Drop for RealtimeWriter {
    fn drop(&mut self) {
        self.signal
            .0
            .next_sample
            .store(self.next_sample, Ordering::Release);
        self.health.mark_stopped(self.source);
        self.signal.stop();
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum BridgeEvent {
    Samples {
        start_sample: u64,
        samples: Vec<f32>,
    },
    Gap(CaptureGap),
}

/// Async side of the bounded realtime bridge.
pub struct AsyncRingReader {
    consumer: HeapCons<RingSample>,
    signal: RealtimeSignal,
    source: AudioSource,
    health: CaptureHealth,
    chunk_samples: usize,
    expected_sample: u64,
    lookahead: Option<RingSample>,
}

impl std::fmt::Debug for AsyncRingReader {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AsyncRingReader")
            .field("source", &self.source)
            .field("chunk_samples", &self.chunk_samples)
            .field("expected_sample", &self.expected_sample)
            .finish_non_exhaustive()
    }
}

impl AsyncRingReader {
    fn try_event(&mut self) -> Option<BridgeEvent> {
        let first = self.lookahead.take().or_else(|| self.consumer.try_pop())?;
        if first.index > self.expected_sample {
            let gap = CaptureGap {
                source: self.source,
                start_sample: self.expected_sample,
                sample_count: Some(first.index - self.expected_sample),
                reason: GapReason::RealtimeOverflow,
            };
            self.expected_sample = first.index;
            self.lookahead = Some(first);
            self.health.record_discontinuity(self.source);
            self.health.record_gap();
            return Some(BridgeEvent::Gap(gap));
        }
        if first.index < self.expected_sample {
            // A stamped SPSC ring should never regress. Skip defensively and
            // let the next poll re-establish the expected position.
            self.health.record_discontinuity(self.source);
            return self.try_event();
        }

        let start_sample = first.index;
        let mut samples = Vec::with_capacity(self.chunk_samples);
        samples.push(first.value);
        self.expected_sample = self.expected_sample.saturating_add(1);

        while samples.len() < self.chunk_samples {
            let Some(next) = self.consumer.try_pop() else {
                break;
            };
            if next.index != self.expected_sample {
                self.lookahead = Some(next);
                break;
            }
            samples.push(next.value);
            self.expected_sample = self.expected_sample.saturating_add(1);
        }

        Some(BridgeEvent::Samples {
            start_sample,
            samples,
        })
    }

    fn final_gap(&mut self) -> Option<BridgeEvent> {
        let observed_end = self.signal.0.next_sample.load(Ordering::Acquire);
        if observed_end <= self.expected_sample {
            return None;
        }
        let gap = CaptureGap {
            source: self.source,
            start_sample: self.expected_sample,
            sample_count: Some(observed_end - self.expected_sample),
            reason: GapReason::RealtimeOverflow,
        };
        self.expected_sample = observed_end;
        self.health.record_discontinuity(self.source);
        self.health.record_gap();
        Some(BridgeEvent::Gap(gap))
    }
}

impl Stream for AsyncRingReader {
    type Item = BridgeEvent;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if let Some(event) = self.try_event() {
            return Poll::Ready(Some(event));
        }

        if !self.signal.0.alive.load(Ordering::Acquire) {
            return Poll::Ready(self.final_gap());
        }

        self.signal.0.wake_pending.store(true, Ordering::Release);
        self.signal.0.waker.register(cx.waker());

        if let Some(event) = self.try_event() {
            self.signal.0.wake_pending.store(false, Ordering::Release);
            return Poll::Ready(Some(event));
        }
        if !self.signal.0.alive.load(Ordering::Acquire) {
            self.signal.0.wake_pending.store(false, Ordering::Release);
            return Poll::Ready(self.final_gap());
        }

        Poll::Pending
    }
}

/// Creates a single-producer/single-consumer bridge.
///
/// `capacity_samples` and `chunk_samples` must both be non-zero.
///
/// # Errors
///
/// Returns [`crate::CaptureError::InvalidConfig`] for a zero capacity or
/// chunk size.
pub fn realtime_bridge(
    capacity_samples: usize,
    chunk_samples: usize,
    source: AudioSource,
    health: CaptureHealth,
) -> Result<(RealtimeWriter, AsyncRingReader), crate::CaptureError> {
    if capacity_samples == 0 || chunk_samples == 0 {
        return Err(crate::CaptureError::InvalidConfig(
            "ring capacity and read chunk size must be non-zero".into(),
        ));
    }
    let ring = HeapRb::<RingSample>::new(capacity_samples);
    let (producer, consumer) = ring.split();
    let signal = RealtimeSignal::new();
    health.mark_started(source);
    Ok((
        RealtimeWriter {
            producer,
            signal: signal.clone(),
            source,
            health: health.clone(),
            next_sample: 0,
        },
        AsyncRingReader {
            consumer,
            signal,
            source,
            health,
            chunk_samples,
            expected_sample: 0,
            lookahead: None,
        },
    ))
}

#[cfg(test)]
mod tests {
    use futures_util::StreamExt;

    use super::*;

    #[test]
    fn overflow_is_reconstructed_at_its_exact_source_position() {
        futures_executor::block_on(async {
            let health = CaptureHealth::default();
            let (mut writer, mut reader) =
                realtime_bridge(2, 8, AudioSource::Microphone, health.clone()).unwrap();

            assert_eq!(writer.push_f32(&[1.0, 2.0, 3.0]).dropped_samples, 1);
            assert_eq!(
                reader.next().await,
                Some(BridgeEvent::Samples {
                    start_sample: 0,
                    samples: vec![1.0, 2.0],
                })
            );
            writer.push_f32(&[4.0]);
            assert_eq!(
                reader.next().await,
                Some(BridgeEvent::Gap(CaptureGap {
                    source: AudioSource::Microphone,
                    start_sample: 2,
                    sample_count: Some(1),
                    reason: GapReason::RealtimeOverflow,
                }))
            );
            assert_eq!(
                reader.next().await,
                Some(BridgeEvent::Samples {
                    start_sample: 3,
                    samples: vec![4.0],
                })
            );
            assert_eq!(health.snapshot().microphone.dropped_samples, 1);
            assert_eq!(health.snapshot().emitted_gaps, 1);
        });
    }

    #[test]
    fn terminal_overflow_is_not_lost_when_writer_stops() {
        futures_executor::block_on(async {
            let health = CaptureHealth::default();
            let (mut writer, mut reader) =
                realtime_bridge(1, 8, AudioSource::SystemAudio, health).unwrap();
            writer.push_f32(&[1.0, 2.0]);
            assert!(matches!(
                reader.next().await,
                Some(BridgeEvent::Samples { .. })
            ));
            drop(writer);
            assert!(matches!(
                reader.next().await,
                Some(BridgeEvent::Gap(CaptureGap {
                    start_sample: 1,
                    sample_count: Some(1),
                    ..
                }))
            ));
            assert_eq!(reader.next().await, None);
        });
    }
}
