// Adapted in design from Fastrepl Anarlog
// crates/audio-actual/src/rt_ring.rs at
// 08aad83f0c5cef1317d74a31519ae3190d726504 (MIT).
// Mimir stamps every source sample before enqueueing so overflow becomes an
// exact gap instead of only a log counter.

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PushStats {
    pub input_samples: usize,
    pub pushed_samples: usize,
    pub dropped_samples: usize,
    /// Input values after the final complete interleaved frame.
    pub trailing_input_values: usize,
}

pub(crate) trait SampleSink {
    /// Attempts to enqueue one sample and advances the source clock whether or
    /// not the bounded queue has capacity.
    fn push_sample(&mut self, sample: f32) -> bool;
}

pub(crate) fn push_f32<S>(data: &[f32], sink: &mut S) -> PushStats
where
    S: SampleSink,
{
    push_converted(data, &mut [], sink, |sample| sample)
}

pub(crate) fn push_converted<T, S>(
    data: &[T],
    scratch: &mut [f32],
    sink: &mut S,
    mut convert: impl FnMut(T) -> f32,
) -> PushStats
where
    T: Copy,
    S: SampleSink,
{
    if data.is_empty() {
        return PushStats::default();
    }

    let mut stats = PushStats {
        input_samples: data.len(),
        ..PushStats::default()
    };

    if scratch.is_empty() {
        for &sample in data {
            if sink.push_sample(convert(sample)) {
                stats.pushed_samples += 1;
            } else {
                stats.dropped_samples += 1;
            }
        }
        return stats;
    }

    for chunk in data.chunks(scratch.len()) {
        for (slot, &sample) in scratch.iter_mut().zip(chunk) {
            *slot = convert(sample);
        }
        for &sample in &scratch[..chunk.len()] {
            if sink.push_sample(sample) {
                stats.pushed_samples += 1;
            } else {
                stats.dropped_samples += 1;
            }
        }
    }
    stats
}

pub(crate) fn push_interleaved_downmix<T, S>(
    data: &[T],
    channels: usize,
    scratch: &mut [f32],
    sink: &mut S,
    mut convert: impl FnMut(T) -> f32,
) -> PushStats
where
    T: Copy,
    S: SampleSink,
{
    if channels == 0 {
        return PushStats {
            trailing_input_values: data.len(),
            ..PushStats::default()
        };
    }

    let complete_values = data.len() - (data.len() % channels);
    let frame_count = complete_values / channels;
    let mut stats = PushStats {
        input_samples: frame_count,
        trailing_input_values: data.len() - complete_values,
        ..PushStats::default()
    };

    if frame_count == 0 {
        return stats;
    }

    let scratch_len = scratch.len().max(1);
    for frame_chunk_start in (0..frame_count).step_by(scratch_len) {
        let count = (frame_count - frame_chunk_start).min(scratch_len);

        if scratch.is_empty() {
            for frame_index in frame_chunk_start..frame_chunk_start + count {
                let input_start = frame_index * channels;
                let sum = data[input_start..input_start + channels]
                    .iter()
                    .fold(0.0_f32, |total, &sample| total + convert(sample));
                if sink.push_sample(sum / channels as f32) {
                    stats.pushed_samples += 1;
                } else {
                    stats.dropped_samples += 1;
                }
            }
            continue;
        }

        for (output_index, slot) in scratch.iter_mut().take(count).enumerate() {
            let input_start = (frame_chunk_start + output_index) * channels;
            let sum = data[input_start..input_start + channels]
                .iter()
                .fold(0.0_f32, |total, &sample| total + convert(sample));
            *slot = sum / channels as f32;
        }

        for &sample in &scratch[..count] {
            if sink.push_sample(sample) {
                stats.pushed_samples += 1;
            } else {
                stats.dropped_samples += 1;
            }
        }
    }
    stats
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::*;

    #[derive(Default)]
    struct LimitedSink {
        capacity: usize,
        values: Vec<f32>,
        observed: usize,
    }

    impl SampleSink for LimitedSink {
        fn push_sample(&mut self, sample: f32) -> bool {
            self.observed += 1;
            if self.values.len() == self.capacity {
                false
            } else {
                self.values.push(sample);
                true
            }
        }
    }

    #[test]
    fn downmix_is_bounded_and_accounts_for_every_frame() {
        let mut sink = LimitedSink {
            capacity: 2,
            ..LimitedSink::default()
        };
        let mut scratch = [0.0; 1];
        let stats = push_interleaved_downmix(
            &[0.2_f32, 0.6, 0.1, 0.5, 0.8, -0.2],
            2,
            &mut scratch,
            &mut sink,
            |sample| sample,
        );

        assert_eq!(sink.values, vec![0.4, 0.3]);
        assert_eq!(stats.input_samples, 3);
        assert_eq!(stats.pushed_samples, 2);
        assert_eq!(stats.dropped_samples, 1);
        assert_eq!(sink.observed, 3);
    }

    #[test]
    fn incomplete_interleaved_frame_is_reported() {
        let mut sink = LimitedSink {
            capacity: 8,
            ..LimitedSink::default()
        };
        let stats = push_interleaved_downmix(&[1_i16, 3, 7], 2, &mut [], &mut sink, f32::from);
        assert_eq!(stats.input_samples, 1);
        assert_eq!(stats.trailing_input_values, 1);
        assert_eq!(sink.values, vec![2.0]);
    }

    proptest! {
        #[test]
        fn accounting_never_loses_a_complete_input_frame(
            data in prop::collection::vec(any::<i16>(), 0..1_024),
            channels in 1_usize..9,
            capacity in 0_usize..256,
            scratch_len in 0_usize..64,
        ) {
            let mut sink = LimitedSink {
                capacity,
                ..LimitedSink::default()
            };
            let mut scratch = vec![0.0; scratch_len];
            let stats = push_interleaved_downmix(
                &data,
                channels,
                &mut scratch,
                &mut sink,
                f32::from,
            );
            prop_assert_eq!(
                stats.pushed_samples + stats.dropped_samples,
                stats.input_samples
            );
            prop_assert_eq!(
                stats.input_samples * channels + stats.trailing_input_values,
                data.len()
            );
        }
    }
}
