use std::{
    env,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
};

const MIMX_SOURCE: &str = include_str!("../../bin/mimx.mjs");
const PI_EXTENSION_SOURCE: &str = include_str!("../../bin/pi-mim-extension.ts");

pub fn install() -> Result<PathBuf, String> {
    let directory = install_dir()?;
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not create Mim CLI directory: {error}"))?;
    install_pi_extension()?;

    #[cfg(windows)]
    {
        let script = directory.join("mimx.mjs");
        crate::persistence::write_bytes_atomic(&script, MIMX_SOURCE.as_bytes())
            .map_err(|error| error.to_string())?;
        let wrapper = directory.join("mimx.cmd");
        crate::persistence::write_bytes_atomic(
            &wrapper,
            b"@echo off\r\nnode \"%~dp0mimx.mjs\" %*\r\n",
        )
        .map_err(|error| error.to_string())?;
        Ok(directory)
    }

    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;
        let executable = directory.join("mimx");
        crate::persistence::write_bytes_atomic(&executable, MIMX_SOURCE.as_bytes())
            .map_err(|error| error.to_string())?;
        let mut permissions = fs::metadata(&executable)
            .map_err(|error| format!("Could not inspect installed mimx: {error}"))?
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&executable, permissions)
            .map_err(|error| format!("Could not make mimx executable: {error}"))?;
        Ok(directory)
    }
}

pub fn install_pi_extension() -> Result<PathBuf, String> {
    let path = pi_extension_path()?;
    crate::persistence::write_bytes_atomic(&path, PI_EXTENSION_SOURCE.as_bytes())
        .map_err(|error| error.to_string())?;
    Ok(path)
}

pub fn pi_extension_path() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|home| pi_extension_path_at(&home))
        .ok_or_else(|| "Could not resolve the home directory for the Pi extension.".into())
}

pub fn pi_extension_path_at(home: &Path) -> PathBuf {
    home.join(".mim").join("pi").join("mim-tools.ts")
}

pub fn install_dir() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|home| home.join(".mim").join("bin"))
        .ok_or_else(|| "Could not resolve the home directory for mimx.".into())
}

pub fn path_with_mimx(current_path: Option<&std::ffi::OsStr>) -> Result<OsString, String> {
    prepend_to_path(&install_dir()?, current_path)
}

pub fn path_with_mimx_at(
    home: &Path,
    current_path: Option<&std::ffi::OsStr>,
) -> Result<OsString, String> {
    prepend_to_path(&home.join(".mim").join("bin"), current_path)
}

fn prepend_to_path(
    directory: &Path,
    current_path: Option<&std::ffi::OsStr>,
) -> Result<OsString, String> {
    let mut paths = vec![directory.to_path_buf()];
    if let Some(current) = current_path {
        paths.extend(env::split_paths(current).filter(|path| path != directory));
    }
    env::join_paths(paths).map_err(|error| format!("Could not construct terminal PATH: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepends_once_without_destroying_existing_path_entries() {
        let directory = Path::new("/tmp/mim-bin");
        let existing = env::join_paths([
            Path::new("/usr/local/bin"),
            directory,
            Path::new("/usr/bin"),
        ])
        .unwrap();
        let result = prepend_to_path(directory, Some(existing.as_os_str())).unwrap();
        let paths = env::split_paths(&result).collect::<Vec<_>>();
        assert_eq!(paths[0], directory);
        assert_eq!(paths.iter().filter(|path| *path == directory).count(), 1);
        assert!(paths.contains(&PathBuf::from("/usr/local/bin")));
        assert!(paths.contains(&PathBuf::from("/usr/bin")));
    }

    #[test]
    fn embedded_cli_exposes_discovery_and_generic_calls() {
        assert!(MIMX_SOURCE.contains("command === 'tools'"));
        assert!(MIMX_SOURCE.contains("command === 'call'"));
        assert!(MIMX_SOURCE.starts_with("#!/usr/bin/env node"));
    }

    #[test]
    fn embedded_pi_extension_discovers_and_registers_every_tool() {
        assert!(PI_EXTENSION_SOURCE.contains("\"tools/list\""));
        assert!(PI_EXTENSION_SOURCE.contains("pi.registerTool"));
        assert!(PI_EXTENSION_SOURCE.contains("\"tools/call\""));
        assert_eq!(
            pi_extension_path_at(Path::new("/Users/mim")),
            Path::new("/Users/mim/.mim/pi/mim-tools.ts")
        );
    }
}
