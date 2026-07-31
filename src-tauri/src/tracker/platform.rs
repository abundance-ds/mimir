use super::model::{Observation, PermissionStatus, TrackerConfig};

pub fn supported() -> bool {
    cfg!(target_os = "macos")
}

pub fn permission_status(config: &TrackerConfig) -> PermissionStatus {
    PermissionStatus {
        platform_supported: supported(),
        accessibility: accessibility_trusted(),
        accessibility_required: config.collect_window_titles,
        browser_automation_enabled: config.collect_browser_domains,
        notifications: None,
    }
}

pub fn request_accessibility() -> Result<(), String> {
    request_accessibility_impl()
}

pub fn prompt_accessibility() -> bool {
    prompt_accessibility_impl()
}

pub fn legacy_argus_running() -> bool {
    legacy_argus_running_impl()
}

pub fn sample(config: &TrackerConfig, mimir_context: Option<&str>) -> Result<Observation, String> {
    sample_impl(config, mimir_context)
}

#[cfg(target_os = "macos")]
fn accessibility_trusted() -> bool {
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
    }

    // SAFETY: AXIsProcessTrusted takes no arguments, has no ownership effects,
    // and is available on every supported macOS version.
    unsafe { AXIsProcessTrusted() }
}

#[cfg(not(target_os = "macos"))]
fn accessibility_trusted() -> bool {
    false
}

#[cfg(target_os = "macos")]
fn prompt_accessibility_impl() -> bool {
    use std::ffi::{c_char, c_void};

    type CfRef = *const c_void;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrustedWithOptions(options: CfRef) -> bool;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        static kCFBooleanTrue: CfRef;
        static kCFTypeDictionaryKeyCallBacks: u8;
        static kCFTypeDictionaryValueCallBacks: u8;
        fn CFDictionaryCreate(
            allocator: CfRef,
            keys: *const CfRef,
            values: *const CfRef,
            count: isize,
            key_callbacks: *const c_void,
            value_callbacks: *const c_void,
        ) -> CfRef;
        fn CFRelease(value: CfRef);
        fn CFStringCreateWithCString(
            allocator: CfRef,
            value: *const c_char,
            encoding: u32,
        ) -> CfRef;
    }

    const UTF8: u32 = 0x0800_0100;
    // SAFETY: all byte strings are static and NUL terminated. Create-rule
    // Core Foundation objects stay alive for the synchronous AX call and are
    // released exactly once afterwards. Standard CFType callbacks compare the
    // newly-created key by value with kAXTrustedCheckOptionPrompt.
    unsafe {
        let key = CFStringCreateWithCString(
            std::ptr::null(),
            c"AXTrustedCheckOptionPrompt".as_ptr(),
            UTF8,
        );
        if key.is_null() {
            return false;
        }
        let keys = [key];
        let values = [kCFBooleanTrue];
        let options = CFDictionaryCreate(
            std::ptr::null(),
            keys.as_ptr(),
            values.as_ptr(),
            1,
            std::ptr::addr_of!(kCFTypeDictionaryKeyCallBacks).cast(),
            std::ptr::addr_of!(kCFTypeDictionaryValueCallBacks).cast(),
        );
        if options.is_null() {
            CFRelease(key);
            return false;
        }
        let trusted = AXIsProcessTrustedWithOptions(options);
        CFRelease(options);
        CFRelease(key);
        trusted
    }
}

#[cfg(not(target_os = "macos"))]
fn prompt_accessibility_impl() -> bool {
    false
}

#[cfg(target_os = "macos")]
fn request_accessibility_impl() -> Result<(), String> {
    let status = std::process::Command::new("/usr/bin/open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
        .status()
        .map_err(|error| format!("Could not open Accessibility settings: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("macOS could not open Accessibility settings.".into())
    }
}

#[cfg(all(target_os = "macos", not(test)))]
fn legacy_argus_running_impl() -> bool {
    std::process::Command::new("/usr/bin/pgrep")
        .args(["-f", "/Applications/Argus.app/Contents/MacOS/Argus"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

#[cfg(any(not(target_os = "macos"), test))]
fn legacy_argus_running_impl() -> bool {
    false
}

#[cfg(not(target_os = "macos"))]
fn request_accessibility_impl() -> Result<(), String> {
    Err("Tracker window sampling is currently available on macOS only.".into())
}

#[cfg(target_os = "macos")]
fn sample_impl(config: &TrackerConfig, mimir_context: Option<&str>) -> Result<Observation, String> {
    let (app_name, bundle_id, process_id) = frontmost_application()?;
    let window_title = if config.collect_window_titles {
        active_window_title(process_id)
    } else {
        None
    };
    let domain = if config.collect_browser_domains {
        browser_domain(&app_name)?
    } else {
        None
    };
    let is_mimir =
        bundle_id.as_deref() == Some("rs.shoulde.mimir") || app_name.eq_ignore_ascii_case("Mimir");

    Ok(Observation {
        observed_at_ms: chrono::Utc::now().timestamp_millis(),
        idle_seconds: idle_seconds(),
        app_name,
        bundle_id,
        domain,
        window_title,
        mimir_context: is_mimir
            .then(|| mimir_context.map(str::to_string))
            .flatten(),
    })
}

#[cfg(target_os = "macos")]
fn frontmost_application() -> Result<(String, Option<String>, i32), String> {
    use objc2_app_kit::NSWorkspace;

    let application = NSWorkspace::sharedWorkspace()
        .frontmostApplication()
        .ok_or_else(|| "macOS did not report a frontmost application.".to_string())?;
    let app_name = application
        .localizedName()
        .map(|value| value.to_string())
        .and_then(|value| clean_string(value, 256))
        .ok_or_else(|| "macOS did not report a frontmost application name.".to_string())?;
    let bundle_id = application
        .bundleIdentifier()
        .map(|value| value.to_string())
        .and_then(|value| clean_string(value, 256));
    Ok((app_name, bundle_id, application.processIdentifier()))
}

#[cfg(target_os = "macos")]
fn active_window_title(process_id: i32) -> Option<String> {
    use std::ffi::{c_char, c_void, CStr};

    type CfRef = *const c_void;
    type CfStringRef = *const c_void;
    type AxUiElementRef = *const c_void;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXUIElementCreateApplication(pid: i32) -> AxUiElementRef;
        fn AXUIElementCopyAttributeValue(
            element: AxUiElementRef,
            attribute: CfStringRef,
            value: *mut CfRef,
        ) -> i32;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(value: CfRef);
        fn CFGetTypeID(value: CfRef) -> usize;
        fn CFStringCreateWithCString(
            allocator: CfRef,
            value: *const c_char,
            encoding: u32,
        ) -> CfStringRef;
        fn CFStringGetTypeID() -> usize;
        fn CFStringGetLength(value: CfStringRef) -> isize;
        fn CFStringGetMaximumSizeForEncoding(length: isize, encoding: u32) -> isize;
        fn CFStringGetCString(
            value: CfStringRef,
            buffer: *mut c_char,
            buffer_size: isize,
            encoding: u32,
        ) -> bool;
    }

    struct OwnedCf(CfRef);
    impl Drop for OwnedCf {
        fn drop(&mut self) {
            // SAFETY: OwnedCf is constructed only from create/copy-rule
            // CoreFoundation references and owns exactly one retain.
            unsafe { CFRelease(self.0) };
        }
    }

    unsafe fn copied_attribute(element: AxUiElementRef, attribute: CfStringRef) -> Option<OwnedCf> {
        let mut value: CfRef = std::ptr::null();
        // SAFETY: element and attribute are live Accessibility/CoreFoundation
        // references; the out pointer is valid for one CF reference.
        if unsafe { AXUIElementCopyAttributeValue(element, attribute, &mut value) } != 0
            || value.is_null()
        {
            return None;
        }
        Some(OwnedCf(value))
    }

    unsafe fn owned_string(value: &'static [u8], encoding: u32) -> Option<OwnedCf> {
        debug_assert_eq!(value.last(), Some(&0));
        // SAFETY: value is a static, NUL-terminated byte string. A null
        // allocator selects Core Foundation's default allocator.
        let string =
            unsafe { CFStringCreateWithCString(std::ptr::null(), value.as_ptr().cast(), encoding) };
        (!string.is_null()).then(|| OwnedCf(string))
    }

    const UTF8: u32 = 0x0800_0100;
    // SAFETY: the PID came from a retained NSRunningApplication. Each returned
    // create/copy-rule reference is wrapped immediately and released once.
    unsafe {
        // The SDK exposes these names as header constants, but not every SDK
        // exports linkable kAX* symbols. Owned CF strings work across both cases.
        let focused_window_attribute = owned_string(b"AXFocusedWindow\0", UTF8)?;
        let title_attribute = owned_string(b"AXTitle\0", UTF8)?;
        let application = AXUIElementCreateApplication(process_id);
        if application.is_null() {
            return None;
        }
        let application = OwnedCf(application);
        let window = copied_attribute(application.0, focused_window_attribute.0)?;
        let title = copied_attribute(window.0, title_attribute.0)?;
        if CFGetTypeID(title.0) != CFStringGetTypeID() {
            return None;
        }
        let length = CFStringGetLength(title.0);
        let capacity = CFStringGetMaximumSizeForEncoding(length, UTF8).saturating_add(1);
        if capacity <= 1 {
            return None;
        }
        let mut buffer = vec![0u8; capacity as usize];
        if !CFStringGetCString(title.0, buffer.as_mut_ptr().cast(), capacity, UTF8) {
            return None;
        }
        let value = CStr::from_ptr(buffer.as_ptr().cast())
            .to_string_lossy()
            .into_owned();
        clean_string(value, 512)
    }
}

#[cfg(not(target_os = "macos"))]
fn sample_impl(
    _config: &TrackerConfig,
    _mimir_context: Option<&str>,
) -> Result<Observation, String> {
    Err("Tracker window sampling is currently available on macOS only.".into())
}

#[cfg(target_os = "macos")]
fn browser_domain(app_name: &str) -> Result<Option<String>, String> {
    let script = match app_name {
        "Google Chrome" | "Brave Browser" | "Microsoft Edge" | "Vivaldi" | "Chromium" | "Opera"
        | "Arc" | "Orion" => format!(
            "tell application {} to get URL of active tab of front window",
            apple_script_string(app_name)
        ),
        "Safari" => "tell application \"Safari\" to get URL of front document".into(),
        // Firefox intentionally has no URL path: it exposes no reliable AppleScript API.
        _ => return Ok(None),
    };
    let output = match run_with_timeout(
        "/usr/bin/osascript",
        &["-e", &script],
        std::time::Duration::from_secs(5),
    ) {
        Ok(output) => output,
        // Browser automation is optional. A denied per-browser permission degrades
        // to app-level tracking without stopping the collector.
        Err(_) => return Ok(None),
    };
    let value = output.trim();
    if value.is_empty() {
        return Ok(None);
    }
    let url = url::Url::parse(value).ok();
    Ok(url.as_ref().and_then(url::Url::host_str).map(|host| {
        host.strip_prefix("www.")
            .unwrap_or(host)
            .to_ascii_lowercase()
    }))
}

#[cfg(target_os = "macos")]
fn idle_seconds() -> u64 {
    idle_seconds_iokit().unwrap_or_else(idle_seconds_command)
}

#[cfg(target_os = "macos")]
fn idle_seconds_iokit() -> Option<u64> {
    use std::ffi::{c_char, c_void};

    type CfRef = *const c_void;

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOServiceMatching(name: *const c_char) -> *mut c_void;
        fn IOServiceGetMatchingService(main_port: u32, matching: *mut c_void) -> u32;
        fn IORegistryEntryCreateCFProperty(
            entry: u32,
            key: CfRef,
            allocator: CfRef,
            options: u32,
        ) -> CfRef;
        fn IOObjectRelease(object: u32) -> i32;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithCString(
            allocator: CfRef,
            value: *const c_char,
            encoding: u32,
        ) -> CfRef;
        fn CFNumberGetValue(number: CfRef, number_type: i32, value: *mut c_void) -> bool;
        fn CFGetTypeID(value: CfRef) -> usize;
        fn CFNumberGetTypeID() -> usize;
        fn CFRelease(value: CfRef);
    }

    struct OwnedIo(u32);
    impl Drop for OwnedIo {
        fn drop(&mut self) {
            // SAFETY: the handle was returned by IOKit with one owned reference.
            unsafe { IOObjectRelease(self.0) };
        }
    }
    struct OwnedCf(CfRef);
    impl Drop for OwnedCf {
        fn drop(&mut self) {
            // SAFETY: the value came from a Core Foundation create/copy rule.
            unsafe { CFRelease(self.0) };
        }
    }

    const UTF8: u32 = 0x0800_0100;
    const CF_NUMBER_SINT64: i32 = 4;
    // SAFETY: both C strings are static and NUL-terminated. IOKit consumes the
    // matching dictionary, while the returned service and created CF values are
    // released exactly once by the guards above.
    unsafe {
        let matching = IOServiceMatching(c"IOHIDSystem".as_ptr());
        if matching.is_null() {
            return None;
        }
        let service = IOServiceGetMatchingService(0, matching);
        if service == 0 {
            return None;
        }
        let service = OwnedIo(service);
        let key = CFStringCreateWithCString(std::ptr::null(), c"HIDIdleTime".as_ptr(), UTF8);
        if key.is_null() {
            return None;
        }
        let key = OwnedCf(key);
        let property = IORegistryEntryCreateCFProperty(service.0, key.0, std::ptr::null(), 0);
        if property.is_null() {
            return None;
        }
        let property = OwnedCf(property);
        if CFGetTypeID(property.0) != CFNumberGetTypeID() {
            return None;
        }
        let mut nanoseconds = 0_i64;
        if !CFNumberGetValue(
            property.0,
            CF_NUMBER_SINT64,
            std::ptr::addr_of_mut!(nanoseconds).cast(),
        ) || nanoseconds < 0
        {
            return None;
        }
        Some(nanoseconds as u64 / 1_000_000_000)
    }
}

#[cfg(target_os = "macos")]
fn idle_seconds_command() -> u64 {
    let output = run_with_timeout(
        "/usr/sbin/ioreg",
        &["-c", "IOHIDSystem"],
        std::time::Duration::from_secs(5),
    )
    .unwrap_or_default();
    output
        .lines()
        .find_map(|line| {
            let (_, value) = line.split_once("HIDIdleTime")?.1.split_once('=')?;
            value.split_whitespace().next()?.parse::<u64>().ok()
        })
        .map(|nanoseconds| nanoseconds / 1_000_000_000)
        .unwrap_or(0)
}

#[cfg(target_os = "macos")]
fn run_with_timeout(
    program: &str,
    arguments: &[&str],
    timeout: std::time::Duration,
) -> Result<String, String> {
    use std::io::Read;

    fn drain(
        pipe: impl Read + Send + 'static,
    ) -> std::thread::JoinHandle<std::io::Result<Vec<u8>>> {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let mut pipe = pipe;
            pipe.read_to_end(&mut bytes)?;
            Ok(bytes)
        })
    }

    fn finish(
        reader: Option<std::thread::JoinHandle<std::io::Result<Vec<u8>>>>,
        stream: &str,
        program: &str,
    ) -> Result<String, String> {
        let bytes = reader
            .ok_or_else(|| format!("Could not capture {program} {stream}."))?
            .join()
            .map_err(|_| format!("The {program} {stream} reader panicked."))?
            .map_err(|error| format!("Could not read {program} {stream}: {error}"))?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }

    let mut child = std::process::Command::new(program)
        .args(arguments)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|error| format!("Could not start {}: {error}", program))?;
    let mut stdout_reader = child.stdout.take().map(drain);
    let mut stderr_reader = child.stderr.take().map(drain);
    let started = std::time::Instant::now();
    loop {
        match child
            .try_wait()
            .map_err(|error| format!("Could not poll {}: {error}", program))?
        {
            Some(status) => {
                let stdout = finish(stdout_reader.take(), "output", program)?;
                let stderr = finish(stderr_reader.take(), "error output", program)?;
                if status.success() {
                    return Ok(stdout);
                }
                return Err(format!(
                    "{} failed: {}",
                    program,
                    stderr.trim().replace('\n', " ")
                ));
            }
            None if started.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = finish(stdout_reader.take(), "output", program);
                let _ = finish(stderr_reader.take(), "error output", program);
                return Err(format!("{} timed out.", program));
            }
            None => std::thread::sleep(std::time::Duration::from_millis(20)),
        }
    }
}

#[cfg(target_os = "macos")]
fn clean_string(value: String, maximum_chars: usize) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.chars().take(maximum_chars).collect())
}

#[cfg(target_os = "macos")]
fn apple_script_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "macos")]
    #[test]
    fn apple_script_strings_are_quoted() {
        assert_eq!(super::apple_script_string("Arc"), "\"Arc\"");
        assert_eq!(super::apple_script_string("A \"B\""), "\"A \\\"B\\\"\"");
    }
}
