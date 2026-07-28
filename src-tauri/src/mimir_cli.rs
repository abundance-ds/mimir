use std::{
    env,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
};

const MIMIR_CLI_SOURCE: &str = include_str!("../../bin/mimir.mjs");
const PI_EXTENSION_SOURCE: &str = include_str!("../../bin/pi-mimir-extension.ts");

pub fn install() -> Result<PathBuf, String> {
    let directory = install_dir()?;
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not create Mimir CLI directory: {error}"))?;
    install_pi_extension()?;

    #[cfg(windows)]
    {
        let script = directory.join("mimir.mjs");
        write_if_changed(&script, MIMIR_CLI_SOURCE.as_bytes())?;
        let wrapper = directory.join("mimir.cmd");
        write_if_changed(&wrapper, b"@echo off\r\nnode \"%~dp0mimir.mjs\" %*\r\n")?;
        Ok(directory)
    }

    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;
        let executable = directory.join("mimir");
        write_if_changed(&executable, MIMIR_CLI_SOURCE.as_bytes())?;
        let mut permissions = fs::metadata(&executable)
            .map_err(|error| format!("Could not inspect installed mimir: {error}"))?
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&executable, permissions)
            .map_err(|error| format!("Could not make mimir executable: {error}"))?;
        Ok(directory)
    }
}

pub fn install_pi_extension() -> Result<PathBuf, String> {
    let path = pi_extension_path()?;
    write_if_changed(&path, PI_EXTENSION_SOURCE.as_bytes())?;
    Ok(path)
}

/// Atomically write `contents` to `path`, skipping the write (and its fsyncs)
/// when the file already holds exactly those bytes. Install runs on every app
/// start before the window shows, so the common case must not pay for four
/// fsyncs. Any read failure falls through to the normal atomic write.
fn write_if_changed(path: &Path, contents: &[u8]) -> Result<(), String> {
    if matches!(fs::read(path), Ok(existing) if existing == contents) {
        return Ok(());
    }
    crate::persistence::write_bytes_atomic(path, contents).map_err(|error| error.to_string())
}

pub fn pi_extension_path() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|home| pi_extension_path_at(&home))
        .ok_or_else(|| "Could not resolve the home directory for the Pi extension.".into())
}

pub fn pi_extension_path_at(home: &Path) -> PathBuf {
    home.join(".mimir").join("pi").join("mimir-tools.ts")
}

pub fn install_dir() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|home| home.join(".mimir").join("bin"))
        .ok_or_else(|| "Could not resolve the home directory for mimir.".into())
}

pub fn path_with_mimir(current_path: Option<&std::ffi::OsStr>) -> Result<OsString, String> {
    prepend_to_path(&install_dir()?, current_path)
}

pub fn path_with_mimir_at(
    home: &Path,
    current_path: Option<&std::ffi::OsStr>,
) -> Result<OsString, String> {
    prepend_to_path(&home.join(".mimir").join("bin"), current_path)
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
        let directory = Path::new("/tmp/mimir-bin");
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

    #[cfg(unix)]
    #[test]
    fn write_if_changed_skips_identical_contents_and_replaces_differing_ones() {
        use std::os::unix::fs::MetadataExt;

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("mimir");

        write_if_changed(&path, b"one").unwrap();
        let original_inode = fs::metadata(&path).unwrap().ino();

        // Identical contents: the atomic rename (which would allocate a new
        // inode) must be skipped entirely.
        write_if_changed(&path, b"one").unwrap();
        assert_eq!(fs::metadata(&path).unwrap().ino(), original_inode);
        assert_eq!(fs::read(&path).unwrap(), b"one");

        // Differing contents still replace the file.
        write_if_changed(&path, b"two").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"two");
        assert_ne!(fs::metadata(&path).unwrap().ino(), original_inode);
    }

    #[test]
    fn embedded_cli_exposes_discovery_and_generic_calls() {
        assert!(MIMIR_CLI_SOURCE.contains("command === 'tools'"));
        assert!(MIMIR_CLI_SOURCE.contains("command === 'call'"));
        assert!(MIMIR_CLI_SOURCE.contains("mimir help <topic>"));
        assert!(MIMIR_CLI_SOURCE.contains("includeAll"));
        assert!(MIMIR_CLI_SOURCE.starts_with("#!/usr/bin/env node"));
    }

    #[test]
    fn embedded_pi_extension_registers_the_default_discovered_tools() {
        assert!(PI_EXTENSION_SOURCE.contains("\"tools/list\""));
        assert!(PI_EXTENSION_SOURCE.contains("pi.registerTool"));
        assert!(PI_EXTENSION_SOURCE.contains("startsWith(\"mimir_\")"));
        assert!(PI_EXTENSION_SOURCE.contains("\"tools/call\""));
        assert_eq!(
            pi_extension_path_at(Path::new("/Users/mimir")),
            Path::new("/Users/mimir/.mimir/pi/mimir-tools.ts")
        );
    }
}
