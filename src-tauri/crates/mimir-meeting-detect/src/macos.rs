// Adapted from Fastrepl Anarlog
// crates/detect/src/list/macos.rs and
// crates/detect/src/mic/macos/device.rs at
// 08aad83f0c5cef1317d74a31519ae3190d726504 (MIT).
// https://github.com/fastrepl/anarlog
//
// The upstream parked polling threads and leaked listener client data. Mimir
// instead owns every listener in this worker source, explicitly unregisters
// it during shutdown, and joins the worker before releasing callback state.

use crate::{
    worker::{Observation, ObservationSource, WakeSignal},
    AppEvidence, DetectError, PermissionSnapshot, PermissionState,
};
use cidre::{arc, av, core_audio as ca};
use objc2::rc::autoreleasepool;
use objc2_app_kit::NSRunningApplication;
use objc2_foundation::NSString;
use std::sync::Arc;

const APPLE_CALL_DAEMON_IDS: &[&str] = &[
    "/usr/libexec/avconferenced",
    "com.apple.avconferenced",
    "com.apple.TelephonyUtilities",
    "com.apple.TelephonyUtilities.callservicesd",
];

pub(crate) struct MacObservationSource {
    // Declaration order is teardown order. Listeners are removed before their
    // Arc-backed callback context is released.
    listeners: Vec<ListenerRegistration>,
    wake: Arc<WakeSignal>,
    default_input: Option<ca::Device>,
    listener_diagnostic: Option<String>,
}

impl MacObservationSource {
    pub(crate) fn new(wake: Arc<WakeSignal>) -> Self {
        Self {
            listeners: Vec::new(),
            wake,
            default_input: None,
            listener_diagnostic: None,
        }
    }

    fn ensure_listeners(&mut self) {
        if !self
            .listeners
            .iter()
            .any(|listener| listener.label == "Core Audio process-list listener")
        {
            self.register_system_listener(
                ca::PropSelector::HW_PROCESS_OBJ_LIST.global_addr(),
                "Core Audio process-list listener",
            );
        }
        if !self
            .listeners
            .iter()
            .any(|listener| listener.label == "Core Audio default-input listener")
        {
            self.register_system_listener(
                ca::PropSelector::HW_DEFAULT_INPUT_DEVICE.global_addr(),
                "Core Audio default-input listener",
            );
        }
        self.refresh_default_input_listener();
    }

    fn remove_listeners(&mut self) -> Result<(), DetectError> {
        let mut failures = Vec::new();
        let mut index = 0;
        while index < self.listeners.len() {
            match self.listeners[index].unregister() {
                Ok(()) => {
                    self.listeners.remove(index);
                }
                Err(error) => {
                    failures.push(error.to_string());
                    index += 1;
                }
            }
        }
        if self.listeners.is_empty() {
            self.default_input = None;
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(DetectError::Native(failures.join("; ")))
        }
    }

    fn register_system_listener(&mut self, address: ca::PropAddr, label: &'static str) {
        match ListenerRegistration::register(*ca::System::OBJ, address, &self.wake, label) {
            Ok(listener) => self.listeners.push(listener),
            Err(error) => self.add_listener_diagnostic(error.to_string()),
        }
    }

    fn refresh_default_input_listener(&mut self) {
        let device = match ca::System::default_input_device() {
            Ok(device) => device,
            Err(error) => {
                self.add_listener_diagnostic(format!(
                    "Could not resolve the default input device: {error:?}"
                ));
                return;
            }
        };
        if self.default_input == Some(device) {
            return;
        }

        if let Some(index) = self
            .listeners
            .iter()
            .position(|listener| listener.label == "Core Audio input-running listener")
        {
            if let Err(error) = self.listeners[index].unregister() {
                self.add_listener_diagnostic(error.to_string());
                return;
            }
            self.listeners.remove(index);
        }
        self.default_input = Some(device);
        match ListenerRegistration::register(
            device.0,
            ca::PropSelector::DEVICE_IS_RUNNING_SOMEWHERE.global_addr(),
            &self.wake,
            "Core Audio input-running listener",
        ) {
            Ok(listener) => self.listeners.push(listener),
            Err(error) => self.add_listener_diagnostic(error.to_string()),
        }
    }

    fn add_listener_diagnostic(&mut self, diagnostic: String) {
        match &mut self.listener_diagnostic {
            Some(existing) if existing.contains(&diagnostic) => {}
            Some(existing) => {
                existing.push_str("; ");
                existing.push_str(&diagnostic);
            }
            None => self.listener_diagnostic = Some(diagnostic),
        }
    }
}

impl ObservationSource for MacObservationSource {
    fn observe(&mut self, include_active_apps: bool) -> Observation {
        let permission = microphone_permission();
        if include_active_apps {
            self.ensure_listeners();
        } else if let Err(error) = self.remove_listeners() {
            self.add_listener_diagnostic(error.to_string());
        }
        let mut diagnostic = self.listener_diagnostic.clone();
        let active_apps = if include_active_apps && permission.state == PermissionState::Granted {
            match list_mic_using_apps() {
                Ok(apps) => apps,
                Err(error) => {
                    append_diagnostic(&mut diagnostic, error.to_string());
                    Vec::new()
                }
            }
        } else {
            Vec::new()
        };

        Observation {
            permission,
            active_apps,
            diagnostic,
        }
    }

    fn shutdown(&mut self) -> Result<(), DetectError> {
        self.remove_listeners()
    }
}

struct ListenerRegistration {
    object: ca::Obj,
    address: ca::PropAddr,
    callback: arc::R<ca::PropListenerBlock>,
    label: &'static str,
    registered: bool,
}

impl ListenerRegistration {
    fn register(
        object: ca::Obj,
        address: ca::PropAddr,
        wake: &Arc<WakeSignal>,
        label: &'static str,
    ) -> Result<Self, DetectError> {
        let wake = wake.clone();
        let mut callback = cidre::blocks::EscBlock::<
            fn(number_addresses: u32, addresses: *const ca::PropAddr),
        >::new2(move |_number_addresses, _addresses| wake.wake());
        object
            .add_prop_listener_block(&address, None, &mut callback)
            .map_err(|error| {
                DetectError::Native(format!("Could not register {label}: {error:?}"))
            })?;
        Ok(Self {
            object,
            address,
            callback,
            label,
            registered: true,
        })
    }

    fn unregister(&mut self) -> Result<(), DetectError> {
        if !self.registered {
            return Ok(());
        }
        self.object
            .remove_prop_listener_block(&self.address, None, &mut self.callback)
            .map_err(|error| {
                DetectError::Native(format!("Could not remove {}: {error:?}", self.label))
            })?;
        self.registered = false;
        Ok(())
    }
}

impl Drop for ListenerRegistration {
    fn drop(&mut self) {
        let _ = self.unregister();
    }
}

pub(crate) fn microphone_permission() -> PermissionSnapshot {
    match av::CaptureDevice::authorization_status_for_media_type(av::MediaType::audio()) {
        Ok(av::AuthorizationStatus::Authorized) => PermissionSnapshot {
            state: PermissionState::Granted,
            can_request: false,
            remediation: None,
        },
        Ok(av::AuthorizationStatus::NotDetermined) => PermissionSnapshot {
            state: PermissionState::NotDetermined,
            can_request: true,
            remediation: Some(
                "Choose Enable Microphone to let Mimir detect and record meetings".into(),
            ),
        },
        Ok(av::AuthorizationStatus::Denied) => PermissionSnapshot {
            state: PermissionState::Denied,
            can_request: false,
            remediation: Some(
                "Enable Mimir in System Settings > Privacy & Security > Microphone, then return to Mimir"
                    .into(),
            ),
        },
        Ok(av::AuthorizationStatus::Restricted) => PermissionSnapshot {
            state: PermissionState::Restricted,
            can_request: false,
            remediation: Some(
                "Microphone access is restricted by macOS policy; ask the device administrator to allow Mimir"
                    .into(),
            ),
        },
        Err(error) => PermissionSnapshot {
            state: PermissionState::Error,
            can_request: false,
            remediation: Some(format!(
                "Could not read microphone authorization from macOS: {error:?}"
            )),
        },
    }
}

pub(crate) fn request_microphone_permission(
    callback: impl FnOnce(PermissionSnapshot) + Send + 'static,
) -> Result<(), DetectError> {
    let current = microphone_permission();
    if current.state != PermissionState::NotDetermined {
        callback(current);
        return Ok(());
    }

    let mut callback = Some(callback);
    let mut completion = cidre::blocks::SendBlock::<fn(bool)>::new1(move |_granted| {
        if let Some(callback) = callback.take() {
            callback(microphone_permission());
        }
    });
    av::CaptureDevice::request_access_for_media_type_ch(av::MediaType::audio(), &mut completion)
        .map_err(|error| {
            DetectError::Native(format!(
                "Could not present the macOS microphone permission request: {error:?}"
            ))
        })
}

fn list_mic_using_apps() -> Result<Vec<AppEvidence>, DetectError> {
    let processes = ca::System::processes().map_err(|error| {
        DetectError::Native(format!(
            "Could not query Core Audio process objects: {error:?}"
        ))
    })?;

    autoreleasepool(|_| {
        let mut apps = Vec::new();
        for process in processes {
            let Ok(running_input) = process.is_running_input() else {
                // Processes routinely disappear between list and property
                // reads. A raced process must not suppress valid evidence.
                continue;
            };
            if !running_input {
                continue;
            }
            let Ok(pid) = process.pid() else {
                continue;
            };
            let core_audio_bundle = process
                .bundle_id()
                .ok()
                .map(|value| value.to_string())
                .filter(|value| !value.trim().is_empty());
            let running_app = NSRunningApplication::runningApplicationWithProcessIdentifier(pid);
            let app_bundle = running_app
                .as_ref()
                .and_then(|app| app.bundleIdentifier())
                .map(|value| value.to_string())
                .filter(|value| !value.trim().is_empty());
            let bundle_id = app_bundle.or(core_audio_bundle);
            let app_name = running_app
                .as_ref()
                .and_then(|app| app.localizedName())
                .map(|value| value.to_string())
                .filter(|value| !value.trim().is_empty())
                .or_else(|| apple_call_name(bundle_id.as_deref()))
                .or_else(|| bundle_id.as_deref().and_then(bundle_leaf_name))
                .unwrap_or_else(|| format!("Process {pid}"));

            apps.push(AppEvidence {
                process_id: pid,
                bundle_id,
                app_name,
            });
        }
        Ok(apps)
    })
}

fn apple_call_name(bundle_id: Option<&str>) -> Option<String> {
    if !bundle_id.is_some_and(|id| APPLE_CALL_DAEMON_IDS.contains(&id)) {
        return None;
    }
    let face_time = running_apple_app("com.apple.FaceTime");
    let phone = running_apple_app("com.apple.mobilephone");
    match (face_time, phone) {
        (Some((true, name)), _) => Some(name),
        (_, Some((true, name))) => Some(name),
        (Some((false, name)), None) => Some(name),
        (None, Some((false, name))) => Some(name),
        _ => None,
    }
}

fn running_apple_app(bundle_id: &str) -> Option<(bool, String)> {
    let bundle_id = NSString::from_str(bundle_id);
    let apps = NSRunningApplication::runningApplicationsWithBundleIdentifier(&bundle_id);
    let app = apps.iter().next()?;
    let active = app.isActive();
    let name = app
        .localizedName()
        .map(|value| value.to_string())
        .unwrap_or_else(|| bundle_id.to_string());
    Some((active, name))
}

fn bundle_leaf_name(bundle_id: &str) -> Option<String> {
    bundle_id
        .rsplit(['.', '/'])
        .find(|part| !part.trim().is_empty())
        .map(str::to_owned)
}

fn append_diagnostic(target: &mut Option<String>, diagnostic: String) {
    match target {
        Some(existing) => {
            existing.push_str("; ");
            existing.push_str(&diagnostic);
        }
        None => *target = Some(diagnostic),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::DetectionConfig;
    use std::{thread, time::Duration};

    #[test]
    fn bundle_leaf_is_safe_for_fallback_display() {
        assert_eq!(
            bundle_leaf_name("com.microsoft.teams2").as_deref(),
            Some("teams2")
        );
        assert_eq!(
            bundle_leaf_name("/usr/libexec/avconferenced").as_deref(),
            Some("avconferenced")
        );
        assert_eq!(bundle_leaf_name(""), None);
    }

    #[test]
    #[ignore = "reads the host TCC decision and requires a packaged macOS identity"]
    fn microphone_permission_smoke() {
        let permission = microphone_permission();
        assert_ne!(permission.state, PermissionState::Unavailable);
    }

    #[test]
    #[ignore = "requires macOS audio hardware and verifies listener registration/removal"]
    fn core_audio_listener_teardown_smoke() {
        let monitor = crate::DetectionMonitor::start_without_callback(DetectionConfig {
            poll_interval: Duration::from_millis(100),
            ..DetectionConfig::default()
        })
        .unwrap();
        thread::sleep(Duration::from_millis(250));
        monitor.stop().unwrap();
    }
}
