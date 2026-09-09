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
use cidre::{arc, av, core_audio as ca, os};
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

// Keep the native calls at one boundary so device changes and failures can be
// tested without changing the host's audio devices or microphone permission.
pub(crate) trait AudioHardware {
    fn default_input_device(&self) -> os::Result<ca::Device>;
    fn add_listener(
        &self,
        object: ca::Obj,
        address: &ca::PropAddr,
        callback: &mut ca::PropListenerBlock,
    ) -> os::Result;
    fn remove_listener(
        &self,
        object: ca::Obj,
        address: &ca::PropAddr,
        callback: &mut ca::PropListenerBlock,
    ) -> os::Result;
}

pub(crate) struct CoreAudio;

impl AudioHardware for CoreAudio {
    fn default_input_device(&self) -> os::Result<ca::Device> {
        ca::System::default_input_device()
    }

    fn add_listener(
        &self,
        object: ca::Obj,
        address: &ca::PropAddr,
        callback: &mut ca::PropListenerBlock,
    ) -> os::Result {
        object.add_prop_listener_block(address, None, callback)
    }

    fn remove_listener(
        &self,
        object: ca::Obj,
        address: &ca::PropAddr,
        callback: &mut ca::PropListenerBlock,
    ) -> os::Result {
        object.remove_prop_listener_block(address, None, callback)
    }
}

pub(crate) struct MacObservationSource<H: AudioHardware = CoreAudio> {
    // Declaration order is teardown order. Listeners are removed before their
    // Arc-backed callback context is released.
    listeners: Vec<ListenerRegistration<H>>,
    wake: Arc<WakeSignal>,
    hardware: Arc<H>,
    listener_diagnostic: Option<String>,
}

impl MacObservationSource {
    pub(crate) fn new(wake: Arc<WakeSignal>) -> Self {
        Self::with_hardware(wake, Arc::new(CoreAudio))
    }
}

impl<H: AudioHardware> MacObservationSource<H> {
    fn with_hardware(wake: Arc<WakeSignal>, hardware: Arc<H>) -> Self {
        Self {
            listeners: Vec::new(),
            wake,
            hardware,
            listener_diagnostic: None,
        }
    }

    fn ensure_listeners(&mut self) {
        // Every refresh retries missing listeners and unresolved removal errors.
        // Only failures from this attempt belong in the current snapshot.
        self.listener_diagnostic = None;
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
        self.listener_diagnostic = None;
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
        if failures.is_empty() {
            Ok(())
        } else {
            Err(DetectError::Native(failures.join("; ")))
        }
    }

    fn register_system_listener(&mut self, address: ca::PropAddr, label: &'static str) {
        match ListenerRegistration::register(
            self.hardware.clone(),
            *ca::System::OBJ,
            address,
            &self.wake,
            label,
        ) {
            Ok(listener) => self.listeners.push(listener),
            Err(error) => self.add_listener_diagnostic(error.to_string()),
        }
    }

    fn refresh_default_input_listener(&mut self) {
        let device = match self.hardware.default_input_device() {
            Ok(device) => device,
            Err(error) => {
                self.add_listener_diagnostic(format!(
                    "Could not resolve the default input device: {error:?}"
                ));
                return;
            }
        };
        if let Some(index) = self
            .listeners
            .iter()
            .position(|listener| listener.label == "Core Audio input-running listener")
        {
            // A device is tracked only while its listener is registered. A
            // failed registration must be retried even if the device is unchanged.
            if self.listeners[index].object == device.0 {
                return;
            }
            if let Err(error) = self.listeners[index].unregister() {
                self.add_listener_diagnostic(error.to_string());
                return;
            }
            self.listeners.remove(index);
        }
        if device.0 == ca::Obj::UNKNOWN {
            return;
        }
        match ListenerRegistration::register(
            self.hardware.clone(),
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

impl<H: AudioHardware> ObservationSource for MacObservationSource<H> {
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

struct ListenerRegistration<H: AudioHardware> {
    object: ca::Obj,
    address: ca::PropAddr,
    callback: arc::R<ca::PropListenerBlock>,
    hardware: Arc<H>,
    label: &'static str,
    registered: bool,
}

impl<H: AudioHardware> ListenerRegistration<H> {
    fn register(
        hardware: Arc<H>,
        object: ca::Obj,
        address: ca::PropAddr,
        wake: &Arc<WakeSignal>,
        label: &'static str,
    ) -> Result<Self, DetectError> {
        let wake = wake.clone();
        let mut callback = cidre::blocks::EscBlock::<
            fn(number_addresses: u32, addresses: *const ca::PropAddr),
        >::new2(move |_number_addresses, _addresses| wake.wake());
        hardware
            .add_listener(object, &address, &mut callback)
            .map_err(|error| {
                DetectError::Native(format!("Could not register {label}: {error:?}"))
            })?;
        Ok(Self {
            object,
            address,
            callback,
            hardware,
            label,
            registered: true,
        })
    }

    fn unregister(&mut self) -> Result<(), DetectError> {
        if !self.registered {
            return Ok(());
        }
        match self
            .hardware
            .remove_listener(self.object, &self.address, &mut self.callback)
        {
            Ok(()) => {}
            // Devices can disappear before we remove their listeners. There is
            // no live object left to unregister from; retire this registration
            // so replacement, disable, and shutdown can complete.
            Err(error) if error == ca::hardware_err::BAD_OBJ => {}
            Err(error) => {
                return Err(DetectError::Native(format!(
                    "Could not remove {}: {error:?}",
                    self.label
                )));
            }
        }
        self.registered = false;
        Ok(())
    }
}

impl<H: AudioHardware> Drop for ListenerRegistration<H> {
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
    use std::{sync::Mutex, thread, time::Duration};

    struct FakeHardware {
        state: Mutex<FakeHardwareState>,
    }

    struct FakeHardwareState {
        default_input: os::Result<ca::Device>,
        add_error: Option<(ca::Obj, os::Error)>,
        remove_error: Option<(ca::Obj, os::Error)>,
        additions: Vec<ca::Obj>,
        removals: Vec<ca::Obj>,
    }

    impl AudioHardware for FakeHardware {
        fn default_input_device(&self) -> os::Result<ca::Device> {
            self.state.lock().unwrap().default_input
        }

        fn add_listener(
            &self,
            object: ca::Obj,
            _address: &ca::PropAddr,
            _callback: &mut ca::PropListenerBlock,
        ) -> os::Result {
            let mut state = self.state.lock().unwrap();
            state.additions.push(object);
            match state.add_error {
                Some((failed, error)) if failed == object => Err(error),
                _ => Ok(()),
            }
        }

        fn remove_listener(
            &self,
            object: ca::Obj,
            _address: &ca::PropAddr,
            _callback: &mut ca::PropListenerBlock,
        ) -> os::Result {
            let mut state = self.state.lock().unwrap();
            state.removals.push(object);
            match state.remove_error {
                Some((failed, error)) if failed == object => Err(error),
                _ => Ok(()),
            }
        }
    }

    fn fake_source(device: u32) -> (MacObservationSource<FakeHardware>, Arc<FakeHardware>) {
        let hardware = Arc::new(FakeHardware {
            state: Mutex::new(FakeHardwareState {
                default_input: Ok(ca::Device(ca::Obj(device))),
                add_error: None,
                remove_error: None,
                additions: Vec::new(),
                removals: Vec::new(),
            }),
        });
        let source =
            MacObservationSource::with_hardware(Arc::new(WakeSignal::new()), hardware.clone());
        (source, hardware)
    }

    #[test]
    fn removed_input_device_does_not_block_replacement_or_retry_removal_on_drop() {
        let (mut source, hardware) = fake_source(41);
        source.ensure_listeners();
        {
            let mut state = hardware.state.lock().unwrap();
            state.default_input = Ok(ca::Device(ca::Obj(42)));
            state.remove_error = Some((ca::Obj(41), ca::hardware_err::BAD_OBJ));
        }

        source.ensure_listeners();

        assert!(source.listener_diagnostic.is_none());
        assert!(hardware
            .state
            .lock()
            .unwrap()
            .additions
            .contains(&ca::Obj(42)));
        assert_eq!(source.listeners.len(), 3);
        drop(source);
        assert_eq!(
            hardware
                .state
                .lock()
                .unwrap()
                .removals
                .iter()
                .filter(|id| **id == ca::Obj(41))
                .count(),
            1
        );
    }

    #[test]
    fn failed_input_registration_retries_same_device_and_clears_error() {
        let (mut source, hardware) = fake_source(41);
        hardware.state.lock().unwrap().add_error = Some((ca::Obj(41), ca::hardware_err::BAD_OBJ));
        source.ensure_listeners();
        assert!(source.listener_diagnostic.is_some());
        assert_eq!(source.listeners.len(), 2);

        hardware.state.lock().unwrap().add_error = None;
        source.ensure_listeners();

        assert_eq!(source.listeners.len(), 3);
        assert!(source.listener_diagnostic.is_none());
        assert_eq!(
            hardware
                .state
                .lock()
                .unwrap()
                .additions
                .iter()
                .filter(|id| **id == ca::Obj(41))
                .count(),
            2
        );
    }

    #[test]
    fn no_default_input_waits_for_a_device_without_registering_object_zero() {
        let (mut source, hardware) = fake_source(0);
        source.ensure_listeners();
        source.ensure_listeners();
        assert_eq!(source.listeners.len(), 2);
        assert!(!hardware
            .state
            .lock()
            .unwrap()
            .additions
            .contains(&ca::Obj::UNKNOWN));
        assert!(source.listener_diagnostic.is_none());

        hardware.state.lock().unwrap().default_input = Ok(ca::Device(ca::Obj(42)));
        source.ensure_listeners();
        assert_eq!(source.listeners.len(), 3);

        {
            let mut state = hardware.state.lock().unwrap();
            state.default_input = Ok(ca::Device(ca::Obj::UNKNOWN));
            state.remove_error = Some((ca::Obj(42), ca::hardware_err::BAD_OBJ));
        }
        source.ensure_listeners();
        assert_eq!(source.listeners.len(), 2);
        assert!(source.listener_diagnostic.is_none());
        assert!(!hardware
            .state
            .lock()
            .unwrap()
            .additions
            .contains(&ca::Obj::UNKNOWN));
    }

    #[test]
    fn other_removal_errors_remain_visible_until_retry_succeeds() {
        let (mut source, hardware) = fake_source(41);
        source.ensure_listeners();
        {
            let mut state = hardware.state.lock().unwrap();
            state.default_input = Ok(ca::Device(ca::Obj(42)));
            state.remove_error = Some((ca::Obj(41), ca::hardware_err::ILLEGAL_OP));
        }

        for _ in 0..2 {
            source.ensure_listeners();
            assert!(source
                .listener_diagnostic
                .as_deref()
                .unwrap()
                .contains("Could not remove"));
            assert!(!hardware
                .state
                .lock()
                .unwrap()
                .additions
                .contains(&ca::Obj(42)));
        }
        hardware.state.lock().unwrap().remove_error = None;
        source.ensure_listeners();

        assert!(source.listener_diagnostic.is_none());
        assert!(hardware
            .state
            .lock()
            .unwrap()
            .additions
            .contains(&ca::Obj(42)));
    }

    #[test]
    fn system_listener_registration_recovers_and_clears_error() {
        let (mut source, hardware) = fake_source(41);
        hardware.state.lock().unwrap().add_error =
            Some((*ca::System::OBJ, ca::hardware_err::ILLEGAL_OP));
        source.ensure_listeners();
        assert!(source.listener_diagnostic.is_some());
        assert_eq!(source.listeners.len(), 1);

        hardware.state.lock().unwrap().add_error = None;
        source.ensure_listeners();
        assert_eq!(source.listeners.len(), 3);
        assert!(source.listener_diagnostic.is_none());
    }

    #[test]
    fn default_input_query_error_clears_after_same_device_recovers() {
        let (mut source, hardware) = fake_source(41);
        source.ensure_listeners();
        hardware.state.lock().unwrap().default_input = Err(ca::hardware_err::NOT_RUNNING);
        source.ensure_listeners();
        assert!(source
            .listener_diagnostic
            .as_deref()
            .unwrap()
            .contains("Could not resolve"));

        hardware.state.lock().unwrap().default_input = Ok(ca::Device(ca::Obj(41)));
        source.ensure_listeners();
        assert!(source.listener_diagnostic.is_none());
        assert_eq!(hardware.state.lock().unwrap().additions.len(), 3);
    }

    #[test]
    fn shutdown_accepts_a_removed_device_and_is_idempotent() {
        let (mut source, hardware) = fake_source(41);
        source.ensure_listeners();
        hardware.state.lock().unwrap().remove_error =
            Some((ca::Obj(41), ca::hardware_err::BAD_OBJ));

        source.shutdown().unwrap();
        source.shutdown().unwrap();
        assert!(source.listeners.is_empty());
        drop(source);
        assert_eq!(hardware.state.lock().unwrap().removals.len(), 3);
    }

    #[test]
    fn partial_disable_does_not_prevent_input_registration_when_reenabled() {
        let (mut source, hardware) = fake_source(41);
        source.ensure_listeners();
        hardware.state.lock().unwrap().remove_error =
            Some((*ca::System::OBJ, ca::hardware_err::ILLEGAL_OP));
        assert!(source.remove_listeners().is_err());
        assert_eq!(source.listeners.len(), 2);

        hardware.state.lock().unwrap().remove_error = None;
        source.ensure_listeners();
        assert_eq!(source.listeners.len(), 3);
        assert!(source.listener_diagnostic.is_none());
    }

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
        assert!(monitor.snapshot().diagnostic.is_none());
        // stop must surface native cleanup errors, including on repeated calls.
        monitor.stop().unwrap();
        monitor.stop().unwrap();
    }
}
