//! Runtime identity and public macOS permission boundaries for Scribe.
//!
//! macOS attributes TCC decisions to the responsible application. A bare
//! development binary launched from a terminal can therefore observe the
//! terminal's microphone decision. Scribe must never project that decision as
//! Mimir's. System-audio process taps intentionally use only public Core Audio
//! APIs; macOS exposes no public, non-prompting AudioCapture preflight API, so
//! the projection remains `prompt-on-start` until a separate known-playback
//! capture test verifies the signal path.

use mimir_meeting_detect::PermissionState;

pub const MIMIR_BUNDLE_IDENTIFIER: &str = "rs.shoulde.mimir";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionRuntimeIdentity {
    bundle_identifier: Option<String>,
}

impl PermissionRuntimeIdentity {
    pub fn from_bundle_identifier(bundle_identifier: Option<&str>) -> Self {
        Self {
            bundle_identifier: bundle_identifier.map(str::to_owned),
        }
    }

    pub fn is_installed_mimir(&self) -> bool {
        self.bundle_identifier.as_deref() == Some(MIMIR_BUNDLE_IDENTIFIER)
    }

    pub fn require_installed_mimir(&self) -> Result<(), String> {
        if self.is_installed_mimir() {
            return Ok(());
        }
        Err(self.unavailable_diagnostic())
    }

    pub fn unavailable_diagnostic(&self) -> String {
        let actual = self
            .bundle_identifier
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("no application bundle");
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

    pub fn project_system_audio(&self) -> &'static str {
        if self.is_installed_mimir() {
            // Public Core Audio prompts when the process tap is created, but
            // does not expose an AudioCapture authorization-status query.
            "prompt-on-start"
        } else {
            "development-host"
        }
    }
}

#[cfg(target_os = "macos")]
pub fn current_permission_runtime_identity() -> PermissionRuntimeIdentity {
    use objc2_foundation::NSBundle;

    let bundle_identifier = NSBundle::mainBundle()
        .bundleIdentifier()
        .map(|identifier| identifier.to_string());
    PermissionRuntimeIdentity { bundle_identifier }
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
        ] {
            assert_eq!(
                identity.project_microphone(PermissionState::Granted),
                "development-host"
            );
            assert_eq!(identity.project_system_audio(), "development-host");
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
        assert_eq!(installed.project_system_audio(), "prompt-on-start");
        assert!(installed.require_installed_mimir().is_ok());
    }
}
