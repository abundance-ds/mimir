// Adapted from Fastrepl Anarlog
// crates/audio-actual/src/speaker/macos.rs at
// 08aad83f0c5cef1317d74a31519ae3190d726504 (MIT).
// This is the macOS 14.2+ Core Audio process-tap path only. Mimir removes
// codecs/resampling/AEC and routes overflow into exact raw-track gaps.

use std::pin::Pin;
use std::task::{Context, Poll};

use cidre::core_audio as ca;
use cidre::{arc, av, cat, cf, ns, os};
use futures_util::Stream;

use crate::backend::FramedReader;
use crate::{
    realtime_bridge, AudioFormat, AudioSource, CaptureError, CaptureHealth, FrameDuration,
    RawAudioFrame, RealtimeWriter,
};

use super::{CALLBACK_SCRATCH_SAMPLES, RING_SECONDS, TAP_DEVICE_NAME};

use ca::aggregate_device_keys as aggregate_keys;

pub struct SystemAudioInput {
    tap: ca::TapGuard,
    aggregate_description: arc::Retained<cf::DictionaryOf<cf::String, cf::Type>>,
    sample_rate: u32,
}

impl std::fmt::Debug for SystemAudioInput {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SystemAudioInput")
            .field("sample_rate_hz", &self.sample_rate)
            .finish_non_exhaustive()
    }
}

struct CallbackContext {
    common_format: av::audio::CommonFormat,
    writer: RealtimeWriter,
    scratch: Vec<f32>,
}

impl SystemAudioInput {
    /// Creates a private mono global Core Audio process tap.
    ///
    /// The API requires macOS 14.2 or newer and Screen & System Audio
    /// Recording consent from the containing application.
    pub fn open() -> Result<Self, CaptureError> {
        let descriptor = ca::TapDesc::with_mono_global_tap_excluding_processes(&ns::Array::new());
        let tap = descriptor
            .create_process_tap()
            .map_err(|error| backend_error("system audio tap creation", error))?;
        let tap_uid = tap
            .uid()
            .map_err(|error| backend_error("system audio tap UID", error))?;
        let stream_description = tap
            .asbd()
            .map_err(|error| backend_error("system audio tap format", error))?;
        let sample_rate = stream_description.sample_rate as u32;
        AudioFormat::mono(sample_rate)?;

        let sub_tap = cf::DictionaryOf::with_keys_values(
            &[ca::sub_device_keys::uid()],
            &[tap_uid.as_type_ref()],
        );
        let aggregate_description = cf::DictionaryOf::with_keys_values(
            &[
                aggregate_keys::is_private(),
                aggregate_keys::tap_auto_start(),
                aggregate_keys::name(),
                aggregate_keys::uid(),
                aggregate_keys::tap_list(),
            ],
            &[
                cf::Boolean::value_true().as_type_ref(),
                cf::Boolean::value_false(),
                cf::String::from_str(TAP_DEVICE_NAME).as_ref(),
                &cf::Uuid::new().to_cf_string(),
                &cf::ArrayOf::from_slice(&[sub_tap.as_ref()]),
            ],
        );

        Ok(Self {
            tap,
            aggregate_description,
            sample_rate,
        })
    }

    pub const fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    fn start_device(
        &self,
        context: &mut Box<CallbackContext>,
    ) -> Result<ca::hardware::StartedDevice<ca::AggregateDevice>, CaptureError> {
        extern "C" fn callback(
            _device: ca::Device,
            _now: &cat::AudioTimeStamp,
            input_data: &cat::AudioBufList<1>,
            _input_time: &cat::AudioTimeStamp,
            _output_data: &mut cat::AudioBufList<1>,
            _output_time: &cat::AudioTimeStamp,
            context: Option<&mut CallbackContext>,
        ) -> os::Status {
            let Some(context) = context else {
                return os::Status::NO_ERR;
            };
            let first = &input_data.buffers[0];
            match context.common_format {
                av::audio::CommonFormat::PcmF32 => {
                    if let Some(samples) = read_samples::<f32>(first) {
                        context.writer.push_f32(samples);
                    }
                }
                av::audio::CommonFormat::PcmF64 => {
                    push_samples::<f64>(context, first, |sample| sample as f32);
                }
                av::audio::CommonFormat::PcmI32 => {
                    push_samples::<i32>(context, first, pcm_i32_to_f32);
                }
                av::audio::CommonFormat::PcmI16 => {
                    push_samples::<i16>(context, first, pcm_i16_to_f32);
                }
                _ => {}
            }
            os::Status::NO_ERR
        }

        let aggregate = ca::AggregateDevice::with_desc(&self.aggregate_description)
            .map_err(|error| backend_error("aggregate audio device creation", error))?;
        let process = aggregate
            .create_io_proc_id(callback, Some(context))
            .map_err(|error| backend_error("system audio callback registration", error))?;
        ca::device_start(aggregate, Some(process))
            .map_err(|error| backend_error("system audio device start", error))
    }

    pub fn start(
        self,
        duration: FrameDuration,
        health: CaptureHealth,
    ) -> Result<SystemAudioStream, CaptureError> {
        let frame_samples = duration.samples_at(self.sample_rate)?;
        let capacity = (self.sample_rate as usize)
            .checked_mul(RING_SECONDS)
            .ok_or_else(|| CaptureError::InvalidConfig("system audio ring size overflow".into()))?;
        let (writer, reader) = realtime_bridge(
            capacity,
            frame_samples,
            AudioSource::SystemAudio,
            health.clone(),
        )?;
        let stream_description = self
            .tap
            .asbd()
            .map_err(|error| backend_error("system audio tap format", error))?;
        let format = av::AudioFormat::with_asbd(&stream_description).ok_or_else(|| {
            CaptureError::UnsupportedSampleFormat("Core Audio stream description".into())
        })?;
        let common_format = format.common_format();
        if !matches!(
            common_format,
            av::audio::CommonFormat::PcmF32
                | av::audio::CommonFormat::PcmF64
                | av::audio::CommonFormat::PcmI32
                | av::audio::CommonFormat::PcmI16
        ) {
            return Err(CaptureError::UnsupportedSampleFormat(format!(
                "{common_format:?}"
            )));
        }
        let mut context = Box::new(CallbackContext {
            common_format,
            writer,
            scratch: vec![0.0; CALLBACK_SCRATCH_SAMPLES],
        });
        let device = self.start_device(&mut context)?;
        let framed = FramedReader::new(
            reader,
            AudioSource::SystemAudio,
            AudioFormat::mono(self.sample_rate)?,
            duration,
            health,
        )?;

        Ok(SystemAudioStream {
            // Declaration order is teardown order: stop native callbacks
            // before releasing their stable boxed context or tap.
            _device: device,
            _context: context,
            _tap: self.tap,
            reader: framed,
        })
    }
}

fn backend_error(component: &'static str, error: impl std::fmt::Debug) -> CaptureError {
    CaptureError::Backend {
        component,
        detail: format!("{error:?}"),
    }
}

fn read_samples<T: Copy>(buffer: &cat::AudioBuf) -> Option<&[T]> {
    let bytes = buffer.data_bytes_size as usize;
    if bytes == 0 || buffer.data.is_null() || bytes % std::mem::size_of::<T>() != 0 {
        return None;
    }
    let pointer = buffer.data.cast::<T>();
    if (pointer as usize) % std::mem::align_of::<T>() != 0 {
        return None;
    }
    let count = bytes / std::mem::size_of::<T>();
    // SAFETY: Core Audio owns `data` for the duration of this IO callback.
    // The null, alignment, byte-divisibility, and non-zero checks above make
    // the typed view valid for exactly `count` elements. It is read-only.
    Some(unsafe { std::slice::from_raw_parts(pointer, count) })
}

fn push_samples<T: Copy>(
    context: &mut CallbackContext,
    buffer: &cat::AudioBuf,
    convert: impl FnMut(T) -> f32,
) {
    let Some(samples) = read_samples::<T>(buffer) else {
        return;
    };
    context
        .writer
        .push_converted(samples, &mut context.scratch, convert);
}

fn pcm_i16_to_f32(sample: i16) -> f32 {
    f32::from(sample) / 32_768.0
}

fn pcm_i32_to_f32(sample: i32) -> f32 {
    sample as f32 / 2_147_483_648.0
}

pub struct SystemAudioStream {
    _device: ca::hardware::StartedDevice<ca::AggregateDevice>,
    _context: Box<CallbackContext>,
    _tap: ca::TapGuard,
    reader: FramedReader,
}

impl std::fmt::Debug for SystemAudioStream {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SystemAudioStream")
            .field("reader", &self.reader)
            .finish_non_exhaustive()
    }
}

impl Stream for SystemAudioStream {
    type Item = RawAudioFrame;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        Pin::new(&mut self.get_mut().reader).poll_next(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires macOS 14.2+, system-audio consent, and active playback"]
    fn opens_system_audio_tap() {
        let input = SystemAudioInput::open().unwrap();
        assert!(input.sample_rate() > 0);
    }
}
