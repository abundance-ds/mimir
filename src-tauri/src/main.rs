fn main() {
    #[cfg(all(target_os = "macos", debug_assertions))]
    if let Err(error) = become_own_tcc_identity() {
        eprintln!("Mimir could not establish its macOS development permission identity: {error}");
    }

    mimir::run()
}

#[cfg(all(target_os = "macos", debug_assertions))]
fn become_own_tcc_identity() -> Result<(), String> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStringExt;

    const GUARD: &str = "MIMIR_TCC_RESPONSIBILITY_DISCLAIMED";
    if std::env::var_os(GUARD).is_some() {
        return Ok(());
    }

    unsafe extern "C" {
        fn responsibility_spawnattrs_setdisclaim(
            attributes: *mut libc::posix_spawnattr_t,
            disclaim: libc::c_int,
        ) -> libc::c_int;
        static mut environ: *mut *mut libc::c_char;
    }

    let executable = std::env::current_exe()
        .map_err(|error| format!("could not resolve the development executable: {error}"))?;
    let executable = CString::new(executable.into_os_string().into_vec())
        .map_err(|_| "the development executable path contains a null byte".to_string())?;
    let arguments = std::env::args_os()
        .map(|argument| {
            CString::new(argument.into_vec())
                .map_err(|_| "a development argument contains a null byte".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut argument_pointers = arguments
        .iter()
        .map(|argument| argument.as_ptr().cast_mut())
        .collect::<Vec<_>>();
    argument_pointers.push(std::ptr::null_mut());

    // This runs before Tauri creates any threads. SETEXEC keeps the same PID,
    // so Cargo continues to supervise the application across Rust rebuilds.
    unsafe {
        let mut attributes: libc::posix_spawnattr_t = std::mem::zeroed();
        let initialized = libc::posix_spawnattr_init(&mut attributes);
        if initialized != 0 {
            return Err(os_error(
                "could not initialize macOS spawn attributes",
                initialized,
            ));
        }

        let result = (|| {
            let disclaimed = responsibility_spawnattrs_setdisclaim(&mut attributes, 1);
            if disclaimed != 0 {
                return Err(os_error(
                    "could not disclaim the terminal permission identity",
                    disclaimed,
                ));
            }
            let flags = libc::posix_spawnattr_setflags(
                &mut attributes,
                libc::POSIX_SPAWN_SETEXEC as libc::c_short,
            );
            if flags != 0 {
                return Err(os_error("could not configure same-PID re-exec", flags));
            }

            std::env::set_var(GUARD, "1");
            let mut pid = 0;
            let spawned = libc::posix_spawn(
                &mut pid,
                executable.as_ptr(),
                std::ptr::null(),
                &attributes,
                argument_pointers.as_ptr(),
                environ,
            );
            std::env::remove_var(GUARD);
            Err(os_error(
                "could not re-exec with Mimir as the responsible application",
                spawned,
            ))
        })();
        libc::posix_spawnattr_destroy(&mut attributes);
        result
    }
}

#[cfg(all(target_os = "macos", debug_assertions))]
fn os_error(context: &str, code: libc::c_int) -> String {
    format!("{context}: {}", std::io::Error::from_raw_os_error(code))
}
