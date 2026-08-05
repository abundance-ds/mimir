//! Runtime identity and macOS permission boundaries for Scribe.
//!
//! macOS attributes TCC decisions to the responsible application. A bare
//! development binary launched from a terminal can therefore observe the
//! terminal's microphone decision. Scribe must never project that decision as
//! Mimir's. macOS exposes no public AudioCapture request or preflight API.
//! Process taps can silently deliver zero-filled buffers when unauthorized, so
//! Scribe uses the native TCC request and preflight entry points that macOS uses
//! for this service. A known-playback test still verifies the signal path.

use mimir_meeting_detect::PermissionState;

pub const MIMIR_BUNDLE_IDENTIFIER: &str = "rs.shoulde.mimir";
#[cfg(target_os = "macos")]
const DEVELOPMENT_RESPONSIBILITY_GUARD: &str = "MIMIR_TCC_RESPONSIBILITY_DISCLAIMED";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionRuntimeIdentity {
    bundle_identifier: Option<String>,
    responsibility_verified: bool,
}

impl PermissionRuntimeIdentity {
    pub fn from_bundle_identifier(bundle_identifier: Option<&str>) -> Self {
        Self::from_runtime(bundle_identifier, true)
    }

    pub fn from_runtime(bundle_identifier: Option<&str>, responsibility_verified: bool) -> Self {
        Self {
            bundle_identifier: bundle_identifier.map(str::to_owned),
            responsibility_verified,
        }
    }

    pub fn is_installed_mimir(&self) -> bool {
        self.responsibility_verified
            && self.bundle_identifier.as_deref() == Some(MIMIR_BUNDLE_IDENTIFIER)
    }

    pub fn require_installed_mimir(&self) -> Result<(), String> {
        if self.is_installed_mimir() {
            return Ok(());
        }
        Err(self.unavailable_diagnostic())
    }

    pub fn unavailable_diagnostic(&self) -> String {
        let actual = if !self.responsibility_verified {
            "a terminal or development host"
        } else {
            self.bundle_identifier
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or("no application bundle")
        };
        format!(
            "Scribe permissions cannot be verified for Mimir because this process is running under {actual}. Open the installed Mimir application ({MIMIR_BUNDLE_IDENTIFIER}) and try again."
        )
    }

    pub fn project_microphone(&self, permission: PermissionState) -> &'static str {
        if self.is_installed_mimir() {
            permission_name(permission)
        } else {
            "development-host"
        }
    }

    pub fn project_system_audio(&self, permission: PermissionState) -> &'static str {
        if self.is_installed_mimir() {
            permission_name(permission)
        } else {
            "development-host"
        }
    }
}

#[cfg(all(target_os = "macos", not(test)))]
const TCC_FRAMEWORK: &str = "/System/Library/PrivateFrameworks/TCC.framework/Versions/A/TCC";
#[cfg(all(target_os = "macos", not(test)))]
const AUDIO_CAPTURE_SERVICE: &str = "kTCCServiceAudioCapture";

#[cfg(all(target_os = "macos", not(test)))]
fn tcc_library() -> Result<&'static libloading::Library, String> {
    static LIBRARY: std::sync::OnceLock<Result<libloading::Library, String>> =
        std::sync::OnceLock::new();
    match LIBRARY.get_or_init(|| {
        unsafe { libloading::Library::new(TCC_FRAMEWORK) }
            .map_err(|error| format!("could not load the macOS audio permission service: {error}"))
    }) {
        Ok(library) => Ok(library),
        Err(error) => Err(error.clone()),
    }
}

#[cfg(all(target_os = "macos", not(test)))]
pub fn current_system_audio_permission() -> PermissionState {
    match tcc_audio_capture_preflight() {
        Ok(0) => PermissionState::Granted,
        Ok(1) => PermissionState::Denied,
        Ok(2) => PermissionState::NotDetermined,
        Ok(_) | Err(_) => PermissionState::Error,
    }
}

#[cfg(any(not(target_os = "macos"), test))]
pub fn current_system_audio_permission() -> PermissionState {
    PermissionState::Unavailable
}

#[cfg(all(target_os = "macos", not(test)))]
pub fn request_system_audio_permission() -> Result<PermissionState, String> {
    use block2::{Block, RcBlock};
    use libloading::Symbol;
    use objc2_foundation::NSString;
    use std::ffi::c_void;
    use std::time::Duration;

    type Request = unsafe extern "C" fn(
        *const c_void,
        *const c_void,
        *mut Block<dyn Fn(objc2::runtime::Bool)>,
    );

    let library = tcc_library()?;
    let request: Symbol<'_, Request> = unsafe { library.get(b"TCCAccessRequest\0") }
        .map_err(|error| format!("macOS does not expose the audio permission request: {error}"))?;
    let service = NSString::from_str(AUDIO_CAPTURE_SERVICE);
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    let completion: RcBlock<dyn Fn(objc2::runtime::Bool)> =
        RcBlock::new(move |granted: objc2::runtime::Bool| {
            let _ = send.send(granted.as_bool());
        });

    unsafe {
        request(
            (&*service as *const NSString).cast(),
            std::ptr::null(),
            RcBlock::as_ptr(&completion),
        );
    }
    let granted = receive
        .recv_timeout(Duration::from_secs(60))
        .map_err(|_| "macOS did not complete the system-audio permission request".to_string())?;
    Ok(if granted {
        PermissionState::Granted
    } else {
        current_system_audio_permission()
    })
}

#[cfg(any(not(target_os = "macos"), test))]
pub fn request_system_audio_permission() -> Result<PermissionState, String> {
    Err("System-audio permission is available only in Mimir for macOS".into())
}

#[cfg(all(target_os = "macos", not(test)))]
fn tcc_audio_capture_preflight() -> Result<isize, String> {
    use libloading::Symbol;
    use objc2_foundation::NSString;
    use std::ffi::c_void;

    type Preflight = unsafe extern "C" fn(*const c_void, *const c_void) -> isize;

    let library = tcc_library()?;
    let preflight: Symbol<'_, Preflight> = unsafe { library.get(b"TCCAccessPreflight\0") }
        .map_err(|error| format!("macOS does not expose audio permission state: {error}"))?;
    let service = NSString::from_str(AUDIO_CAPTURE_SERVICE);
    Ok(unsafe { preflight((&*service as *const NSString).cast(), std::ptr::null()) })
}

#[cfg(target_os = "macos")]
pub fn current_permission_runtime_identity() -> PermissionRuntimeIdentity {
    use objc2_foundation::NSBundle;

    let bundle_identifier = NSBundle::mainBundle()
        .bundleIdentifier()
        .map(|identifier| identifier.to_string());
    let responsibility_verified = if cfg!(debug_assertions) {
        std::env::var_os(DEVELOPMENT_RESPONSIBILITY_GUARD).is_some()
    } else {
        true
    };
    PermissionRuntimeIdentity {
        bundle_identifier,
        responsibility_verified,
    }
}

#[cfg(not(target_os = "macos"))]
pub fn current_permission_runtime_identity() -> PermissionRuntimeIdentity {
    PermissionRuntimeIdentity::from_bundle_identifier(None)
}

pub fn permission_name(permission: PermissionState) -> &'static str {
    match permission {
        PermissionState::NotDetermined => "not-determined",
        PermissionState::Restricted => "restricted",
        PermissionState::Denied => "denied",
        PermissionState::Granted => "granted",
        PermissionState::Unavailable => "unavailable",
        PermissionState::Error => "error",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn development_host_permissions_are_never_projected_as_mimir_permissions() {
        for identity in [
            PermissionRuntimeIdentity::from_bundle_identifier(None),
            PermissionRuntimeIdentity::from_bundle_identifier(Some("com.mitchellh.ghostty")),
            PermissionRuntimeIdentity::from_bundle_identifier(Some("mimir-debug")),
            PermissionRuntimeIdentity::from_runtime(Some(MIMIR_BUNDLE_IDENTIFIER), false),
        ] {
            assert_eq!(
                identity.project_microphone(PermissionState::Granted),
                "development-host"
            );
            assert_eq!(
                identity.project_system_audio(PermissionState::Granted),
                "development-host"
            );
            assert!(identity
                .require_installed_mimir()
                .unwrap_err()
                .contains("Open the installed Mimir application (rs.shoulde.mimir)"));
        }

        let installed =
            PermissionRuntimeIdentity::from_bundle_identifier(Some(MIMIR_BUNDLE_IDENTIFIER));
        assert_eq!(
            installed.project_microphone(PermissionState::Granted),
            "granted"
        );
        assert_eq!(
            installed.project_system_audio(PermissionState::NotDetermined),
            "not-determined"
        );
        assert_eq!(
            installed.project_system_audio(PermissionState::Granted),
            "granted"
        );
        assert!(installed.require_installed_mimir().is_ok());
    }
}
