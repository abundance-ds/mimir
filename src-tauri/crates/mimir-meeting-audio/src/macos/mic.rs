// Adapted from Fastrepl Anarlog crates/audio-actual/src/mic.rs at
// 08aad83f0c5cef1317d74a31519ae3190d726504 (MIT).
// Mimir does exact device selection, supports CPAL PCM variants, preserves
// overflow positions, and surfaces callback failure through capture health.

use std::pin::Pin;
use std::task::{Context, Poll};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SizedSample};
use futures_util::Stream;

use crate::backend::FramedReader;
use crate::{
    realtime_bridge, AudioFormat, AudioSource, CaptureError, CaptureHealth, FrameDuration,
    RawAudioFrame,
};

use super::{CALLBACK_SCRATCH_SAMPLES, RING_SECONDS, TAP_DEVICE_NAME};

fn device_name(device: &cpal::Device) -> String {
    device
        .description()
        .map(|description| description.name().to_owned())
        .unwrap_or_else(|_| "Unknown Microphone".to_owned())
}

fn is_system_tap(device: &cpal::Device) -> bool {
    device_name(device).contains(TAP_DEVICE_NAME)
}

pub fn list_microphones() -> Result<Vec<String>, CaptureError> {
    let host = cpal::default_host();
    let devices = host
        .input_devices()
        .map_err(|error| CaptureError::Backend {
            component: "microphone enumeration",
            detail: error.to_string(),
        })?;
    Ok(devices
        .filter(|device| !is_system_tap(device))
        .map(|device| device_name(&device))
        .collect())
}

pub struct MicrophoneInput {
    _host: cpal::Host,
    device: cpal::Device,
    config: cpal::SupportedStreamConfig,
    name: String,
}

impl std::fmt::Debug for MicrophoneInput {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("MicrophoneInput")
            .field("name", &self.name)
            .field("sample_rate_hz", &self.sample_rate())
            .finish_non_exhaustive()
    }
}

impl MicrophoneInput {
    pub fn open(requested_name: Option<&str>) -> Result<Self, CaptureError> {
        let host = cpal::default_host();
        let mut devices = host
            .input_devices()
            .map_err(|error| CaptureError::Backend {
                component: "microphone enumeration",
                detail: error.to_string(),
            })?
            .filter(|device| !is_system_tap(device));

        let device = if let Some(requested) = requested_name {
            devices
                .find(|device| device_name(device) == requested)
                .ok_or_else(|| CaptureError::InputDeviceNotFound(requested.to_owned()))?
        } else {
            host.default_input_device()
                .filter(|device| !is_system_tap(device))
                .or_else(|| devices.next())
                .ok_or(CaptureError::NoInputDevice)?
        };
        let name = device_name(&device);
        let config = device
            .default_input_config()
            .map_err(|error| CaptureError::Backend {
                component: "microphone configuration",
                detail: error.to_string(),
            })?;

        Ok(Self {
            _host: host,
            device,
            config,
            name,
        })
    }

    pub fn sample_rate(&self) -> u32 {
        self.config.sample_rate()
    }

    pub fn device_name(&self) -> String {
        self.name.clone()
    }

    pub fn start(
        self,
        duration: FrameDuration,
        health: CaptureHealth,
    ) -> Result<MicrophoneStream, CaptureError> {
        let sample_rate = self.sample_rate();
        let frame_samples = duration.samples_at(sample_rate)?;
        let capacity = (sample_rate as usize)
            .checked_mul(RING_SECONDS)
            .ok_or_else(|| CaptureError::InvalidConfig("microphone ring size overflow".into()))?;
        let (writer, reader) = realtime_bridge(
            capacity,
            frame_samples,
            AudioSource::Microphone,
            health.clone(),
        )?;
        let failure = writer.failure_handle();
        let channels = self.config.channels() as usize;
        let stream_config = self.config.config();

        fn build<S>(
            device: &cpal::Device,
            config: &cpal::StreamConfig,
            channels: usize,
            mut writer: crate::RealtimeWriter,
            failure: crate::async_ring::RealtimeFailureHandle,
        ) -> Result<cpal::Stream, cpal::BuildStreamError>
        where
            S: SizedSample,
            f32: FromSample<S>,
        {
            let mut scratch = vec![0.0_f32; CALLBACK_SCRATCH_SAMPLES];
            device.build_input_stream::<S, _, _>(
                config,
                move |samples: &[S], _| {
                    writer.push_interleaved_downmix(
                        samples,
                        channels,
                        &mut scratch,
                        f32::from_sample,
                    );
                },
                move |_error| failure.fail(),
                None,
            )
        }

        let sample_format = self.config.sample_format();
        let stream = match sample_format {
            cpal::SampleFormat::I8 => {
                build::<i8>(&self.device, &stream_config, channels, writer, failure)
            }
            cpal::SampleFormat::I16 => {
                build::<i16>(&self.device, &stream_config, channels, writer, failure)
            }
            cpal::SampleFormat::I24 => {
                build::<cpal::I24>(&self.device, &stream_config, channels, writer, failure)
            }
            cpal::SampleFormat::I32 => {
                build::<i32>(&self.device, &stream_config, channels, writer, failure)
            }
            cpal::SampleFormat::I64 => {
                build::<i64>(&self.device, &stream_config, channels, writer, failure)
            }
            cpal::SampleFormat::U8 => {
                build::<u8>(&self.device, &stream_config, channels, writer, failure)
            }
            cpal::SampleFormat::U16 => {
                build::<u16>(&self.device, &stream_config, channels, writer, failure)
            }
            cpal::SampleFormat::U24 => {
                build::<cpal::U24>(&self.device, &stream_config, channels, writer, failure)
            }
            cpal::SampleFormat::U32 => {
                build::<u32>(&self.device, &stream_config, channels, writer, failure)
            }
            cpal::SampleFormat::U64 => {
                build::<u64>(&self.device, &stream_config, channels, writer, failure)
            }
            cpal::SampleFormat::F32 => {
                build::<f32>(&self.device, &stream_config, channels, writer, failure)
            }
            cpal::SampleFormat::F64 => {
                build::<f64>(&self.device, &stream_config, channels, writer, failure)
            }
            unsupported => {
                return Err(CaptureError::UnsupportedSampleFormat(
                    unsupported.to_string(),
                ));
            }
        }
        .map_err(|error| CaptureError::Backend {
            component: "microphone stream initialization",
            detail: error.to_string(),
        })?;
        stream.play().map_err(|error| CaptureError::Backend {
            component: "microphone stream start",
            detail: error.to_string(),
        })?;

        let reader = FramedReader::new(
            reader,
            AudioSource::Microphone,
            AudioFormat::mono(sample_rate)?,
            duration,
            health,
        )?;
        Ok(MicrophoneStream {
            reader,
            _stream: stream,
        })
    }
}

pub struct MicrophoneStream {
    // Drop the native stream before the reader so the callback producer closes
    // and wakes the async side during teardown.
    _stream: cpal::Stream,
    reader: FramedReader,
}

impl std::fmt::Debug for MicrophoneStream {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("MicrophoneStream")
            .field("reader", &self.reader)
            .finish_non_exhaustive()
    }
}

impl Stream for MicrophoneStream {
    type Item = RawAudioFrame;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        Pin::new(&mut self.get_mut().reader).poll_next(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires microphone permission and physical audio hardware"]
    fn opens_default_microphone() {
        let input = MicrophoneInput::open(None).unwrap();
        assert!(input.sample_rate() > 0);
    }
}
