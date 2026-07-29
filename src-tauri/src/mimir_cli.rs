use std::{
    env,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
};

use sha2::{Digest, Sha256};

const MIMIR_CLI_SOURCE: &str = include_str!("../../bin/mimir.mjs");
const MIMIR_SKILLS_SOURCE: &str = include_str!("../../bin/mimir-skills.mjs");
const PI_EXTENSION_SOURCE: &str = include_str!("../../bin/pi-mimir-extension.ts");
const MIMIR_CONFIG_SKILL: &str = include_str!("../../skills/mimir-config/SKILL.md");
const LEGACY_MIMIR_CONFIG_SKILL_V1: &str = r#"---
name: mimir-config
description: Locate and safely edit Mimir settings, launchers, routines, apps, and skills.
---

# Mimir configuration

Authored sources live in `~/.mimir`: `settings.json`, `launchers.json`, `routines/*.toml`, `apps/`, and `skills/{catalog,personal,projects}/`.

Do not edit runtime state (`session.json`, `routines-state.json`, `activities/`, `app-data/`, graph event files) or credentials. Use Mimir’s graph tools for graph data; credentials live in the OS keychain and are changed in Settings.
"#;

pub fn install() -> Result<PathBuf, String> {
    let directory = install_dir()?;
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not create Mimir CLI directory: {error}"))?;
    install_builtin_skills()?;
    install_pi_extension()?;
    write_if_changed(
        &directory.join("mimir-skills.mjs"),
        MIMIR_SKILLS_SOURCE.as_bytes(),
    )?;

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

fn install_builtin_skills() -> Result<(), String> {
    let home = dirs::home_dir()
        .ok_or_else(|| "Could not resolve the home directory for skills.".to_string())?;
    install_builtin_skills_at(&home)
}

fn install_builtin_skills_at(home: &Path) -> Result<(), String> {
    let skills_root = home.join(".mimir").join("skills");
    let destination = home
        .join(".mimir")
        .join("skills")
        .join("catalog")
        .join("mimir-config")
        .join("SKILL.md");
    let marker = skills_root
        .join(".builtin-sources")
        .join("mimir-config.json");
    install_managed_builtin_skill(
        &destination,
        &marker,
        MIMIR_CONFIG_SKILL.as_bytes(),
        &[LEGACY_MIMIR_CONFIG_SKILL_V1.as_bytes()],
    )
}

fn install_managed_builtin_skill(
    destination: &Path,
    marker: &Path,
    packaged: &[u8],
    recognized_legacy: &[&[u8]],
) -> Result<(), String> {
    let existing = fs::read(destination).ok();
    let packaged_hash = content_hash(packaged);
    let managed_hash = fs::read_to_string(marker)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|value| {
            value
                .get("sourceHash")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        });
    let replace = match existing.as_deref() {
        None => true,
        Some(contents) if contents == packaged => false,
        Some(contents) if managed_hash.as_deref() == Some(&content_hash(contents)) => true,
        Some(contents) => recognized_legacy.contains(&contents),
    };
    if existing.is_some() && !replace && existing.as_deref() != Some(packaged) {
        return Ok(());
    }
    let parent = destination
        .parent()
        .expect("Mimir config skill has a parent");
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create Mimir skill directory: {error}"))?;
    if replace {
        write_if_changed(destination, packaged)?;
    }
    let marker_parent = marker.parent().expect("Mimir builtin marker has a parent");
    fs::create_dir_all(marker_parent)
        .map_err(|error| format!("Could not create Mimir skill marker directory: {error}"))?;
    let metadata = serde_json::to_vec_pretty(&serde_json::json!({
        "version": 1,
        "sourceHash": packaged_hash,
    }))
    .map_err(|error| error.to_string())?;
    write_if_changed(marker, &metadata)
}

fn content_hash(contents: &[u8]) -> String {
    format!("{:x}", Sha256::digest(contents))
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

    #[test]
    fn managed_builtin_skills_upgrade_only_untouched_sources() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("catalog/demo/SKILL.md");
        let marker = directory.path().join(".builtin-sources/demo.json");

        install_managed_builtin_skill(&destination, &marker, b"version one", &[]).unwrap();
        assert_eq!(fs::read(&destination).unwrap(), b"version one");

        install_managed_builtin_skill(&destination, &marker, b"version two", &[]).unwrap();
        assert_eq!(fs::read(&destination).unwrap(), b"version two");

        fs::write(&destination, b"user edit").unwrap();
        install_managed_builtin_skill(&destination, &marker, b"version three", &[]).unwrap();
        assert_eq!(fs::read(&destination).unwrap(), b"user edit");
    }

    #[test]
    fn known_pre_marker_builtin_is_migrated_safely() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("catalog/demo/SKILL.md");
        let marker = directory.path().join(".builtin-sources/demo.json");
        fs::create_dir_all(destination.parent().unwrap()).unwrap();
        fs::write(&destination, b"known old source").unwrap();

        install_managed_builtin_skill(
            &destination,
            &marker,
            b"current source",
            &[b"known old source"],
        )
        .unwrap();

        assert_eq!(fs::read(&destination).unwrap(), b"current source");
        assert!(marker.exists());
    }

    #[test]
    fn builtin_config_uses_the_catalog_path() {
        let home = tempfile::tempdir().unwrap();
        install_builtin_skills_at(home.path()).unwrap();
        let installed = home
            .path()
            .join(".mimir/skills/catalog/mimir-config/SKILL.md");
        assert_eq!(fs::read_to_string(installed).unwrap(), MIMIR_CONFIG_SKILL);
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
        assert!(MIMIR_CLI_SOURCE.contains("command === 'tool'"));
        assert!(MIMIR_CLI_SOURCE.contains("command === 'tools'"));
        assert!(MIMIR_CLI_SOURCE.contains("command === 'call'"));
        assert!(MIMIR_CLI_SOURCE.contains("command === 'doctor'"));
        assert!(MIMIR_CLI_SOURCE.contains("command === 'skill'"));
        assert!(MIMIR_CLI_SOURCE.contains("command === 'mcp-proxy'"));
        assert!(MIMIR_CLI_SOURCE.contains("includeAll"));
        assert!(MIMIR_SKILLS_SOURCE.contains("export async function findSkill"));
        assert!(MIMIR_SKILLS_SOURCE.contains("export async function prepareSkills"));
        assert!(MIMIR_CONFIG_SKILL.contains("name: mimir-config"));
        assert!(MIMIR_CLI_SOURCE.starts_with("#!/usr/bin/env node"));
    }

    #[test]
    fn embedded_pi_extension_registers_the_default_discovered_tools() {
        assert!(PI_EXTENSION_SOURCE.contains("\"tools/list\""));
        assert!(PI_EXTENSION_SOURCE.contains("pi.registerTool"));
        assert!(PI_EXTENSION_SOURCE.contains("startsWith(\"mimir_\")"));
        assert!(PI_EXTENSION_SOURCE.contains("\"tools/call\""));
        assert!(PI_EXTENSION_SOURCE.contains("\"initialize\""));
        assert!(PI_EXTENSION_SOURCE.contains("before_agent_start"));
        assert_eq!(
            pi_extension_path_at(Path::new("/Users/mimir")),
            Path::new("/Users/mimir/.mimir/pi/mimir-tools.ts")
        );
    }
}
