mod mic;
mod system_audio;

pub use mic::{list_microphone_devices, list_microphones, MicrophoneInput, MicrophoneStream};
pub use system_audio::{SystemAudioInput, SystemAudioStream};

pub(super) const TAP_DEVICE_NAME: &str = "Mimir Meeting System Audio";
pub(super) const CALLBACK_SCRATCH_SAMPLES: usize = 8_192;
pub(super) const RING_SECONDS: usize = 2;
