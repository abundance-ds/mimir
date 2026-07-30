use std::pin::Pin;
use std::task::{Context, Poll};

use futures_util::Stream;

use crate::{CaptureError, CaptureHealth, FrameDuration, RawAudioFrame};

fn unsupported() -> CaptureError {
    CaptureError::UnsupportedPlatform {
        platform: std::env::consts::OS,
    }
}

#[derive(Debug)]
pub struct MicrophoneInput;

impl MicrophoneInput {
    pub fn open(_device_name: Option<&str>) -> Result<Self, CaptureError> {
        Err(unsupported())
    }

    pub const fn sample_rate(&self) -> u32 {
        0
    }

    pub fn device_name(&self) -> String {
        String::new()
    }

    pub fn start(
        self,
        _duration: FrameDuration,
        _health: CaptureHealth,
    ) -> Result<MicrophoneStream, CaptureError> {
        Err(unsupported())
    }
}

pub fn list_microphones() -> Result<Vec<String>, CaptureError> {
    Err(unsupported())
}

#[derive(Debug)]
pub struct MicrophoneStream;

impl Stream for MicrophoneStream {
    type Item = RawAudioFrame;

    fn poll_next(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        Poll::Ready(None)
    }
}

#[derive(Debug)]
pub struct SystemAudioInput;

impl SystemAudioInput {
    pub fn open() -> Result<Self, CaptureError> {
        Err(unsupported())
    }

    pub const fn sample_rate(&self) -> u32 {
        0
    }

    pub fn start(
        self,
        _duration: FrameDuration,
        _health: CaptureHealth,
    ) -> Result<SystemAudioStream, CaptureError> {
        Err(unsupported())
    }
}

#[derive(Debug)]
pub struct SystemAudioStream;

impl Stream for SystemAudioStream {
    type Item = RawAudioFrame;

    fn poll_next(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        Poll::Ready(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsupported_backends_fail_explicitly() {
        assert!(matches!(
            MicrophoneInput::open(None),
            Err(CaptureError::UnsupportedPlatform { .. })
        ));
        assert!(matches!(
            SystemAudioInput::open(),
            Err(CaptureError::UnsupportedPlatform { .. })
        ));
        assert!(matches!(
            list_microphones(),
            Err(CaptureError::UnsupportedPlatform { .. })
        ));

        let microphone = MicrophoneInput;
        assert_eq!(microphone.sample_rate(), 0);
        assert!(microphone.device_name().is_empty());
        assert!(matches!(
            microphone.start(FrameDuration::DEFAULT, CaptureHealth::default()),
            Err(CaptureError::UnsupportedPlatform { .. })
        ));

        let system = SystemAudioInput;
        assert_eq!(system.sample_rate(), 0);
        assert!(matches!(
            system.start(FrameDuration::DEFAULT, CaptureHealth::default()),
            Err(CaptureError::UnsupportedPlatform { .. })
        ));

        let mut microphone_stream = MicrophoneStream;
        let mut system_stream = SystemAudioStream;
        let waker = futures_util::task::noop_waker();
        let mut context = Context::from_waker(&waker);
        assert!(matches!(
            Pin::new(&mut microphone_stream).poll_next(&mut context),
            Poll::Ready(None)
        ));
        assert!(matches!(
            Pin::new(&mut system_stream).poll_next(&mut context),
            Poll::Ready(None)
        ));
    }
}
