mod framed;

#[cfg(target_os = "macos")]
#[path = "../macos/mod.rs"]
mod platform;
#[cfg(not(target_os = "macos"))]
mod platform;
// Compile and test the unsupported-platform contract on macOS too, so the
// Linux-safe path does not silently rot between cross-target CI runs.
#[cfg(all(test, target_os = "macos"))]
#[path = "platform.rs"]
mod unsupported_platform_contract;

pub use platform::{
    list_microphones, MicrophoneInput, MicrophoneStream, SystemAudioInput, SystemAudioStream,
};

pub(crate) use framed::FramedReader;
