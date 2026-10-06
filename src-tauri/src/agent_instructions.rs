//! Create project instructions once. Existing entries always belong to the user.

use serde::Serialize;
use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::Path,
};

const DEFAULT_TEMPLATE: &str = include_str!("../../src/shared/agents-starter.md");

#[derive(Debug, Serialize)]
pub struct InstructionsResult {
    created: bool,
}

fn ensure_at(workspace: &Path, template: Option<&str>) -> Result<InstructionsResult, String> {
    if !workspace.is_absolute() {
        return Err("Workspace path must be absolute.".into());
    }
    let root = workspace
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !root.is_dir() {
        return Err("Workspace path must be a directory.".into());
    }
    let target = root.join("AGENTS.md");
    match fs::symlink_metadata(&target) {
        Ok(metadata) if metadata.is_dir() => {
            return Err("AGENTS.md is a directory. Move it before creating instructions.".into());
        }
        Ok(_) => return Ok(InstructionsResult { created: false }),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }

    let content = template
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(DEFAULT_TEMPLATE);
    let temporary = root.join(format!(".AGENTS.md.{}.tmp", uuid::Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| error.to_string())?;
    // Publish only complete contents. A hard link fails if any entry already
    // occupies the target, including a dangling symlink or a concurrent writer.
    let result = (|| {
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        match fs::hard_link(&temporary, &target) {
            Ok(()) => Ok(InstructionsResult { created: true }),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                Ok(InstructionsResult { created: false })
            }
            Err(error) => Err(error),
        }
    })();
    drop(file);
    if let Err(error) = fs::remove_file(&temporary) {
        log::warn!("Could not remove instruction temporary file: {error}");
    }
    result.map_err(|error: io::Error| error.to_string())
}

#[tauri::command]
pub async fn workspace_agents_ensure(
    workspace: String,
    template: Option<String>,
) -> Result<InstructionsResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        ensure_at(Path::new(&workspace), template.as_deref())
    })
    .await
    .map_err(|error| format!("Instruction creation task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn creates_default_and_custom_templates_without_replacing_existing_content() {
        let root = tempdir().unwrap();
        assert!(ensure_at(root.path(), None).unwrap().created);
        let target = root.path().join("AGENTS.md");
        assert_eq!(fs::read_to_string(&target).unwrap(), DEFAULT_TEMPLATE);
        assert!(!ensure_at(root.path(), Some("different")).unwrap().created);
        assert_eq!(fs::read_to_string(&target).unwrap(), DEFAULT_TEMPLATE);
        fs::remove_file(&target).unwrap();
        let custom = "# Project\n\nUse German.\n";
        assert!(ensure_at(root.path(), Some(custom)).unwrap().created);
        assert_eq!(fs::read_to_string(&target).unwrap(), custom);
        fs::write(&target, "").unwrap();
        assert!(!ensure_at(root.path(), None).unwrap().created);
        assert_eq!(fs::read_to_string(&target).unwrap(), "");
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
    }

    #[test]
    fn invalid_roots_and_directory_collisions_do_not_create_files() {
        let root = tempdir().unwrap();
        assert!(ensure_at(Path::new("relative"), None).is_err());
        assert!(ensure_at(&root.path().join("missing"), None).is_err());
        let target = root.path().join("AGENTS.md");
        fs::create_dir(&target).unwrap();
        assert!(ensure_at(root.path(), None).is_err());
        assert!(target.is_dir());
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
    }

    #[test]
    fn concurrent_creation_publishes_exactly_one_complete_template() {
        let root = tempdir().unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
        let workers: Vec<_> = (0..8)
            .map(|i| {
                let path = root.path().to_path_buf();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    ensure_at(&path, Some(&format!("writer {i}\n")))
                        .unwrap()
                        .created
                })
            })
            .collect();
        assert_eq!(
            workers
                .into_iter()
                .filter_map(|worker| worker.join().unwrap().then_some(()))
                .count(),
            1
        );
        let text = fs::read_to_string(root.path().join("AGENTS.md")).unwrap();
        assert!((0..8).any(|i| text == format!("writer {i}\n")));
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn preserves_symlinks_including_broken_links_and_external_targets() {
        let root = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let external = outside.path().join("instructions");
        let target = root.path().join("AGENTS.md");
        std::os::unix::fs::symlink(&external, &target).unwrap();
        assert!(!ensure_at(root.path(), None).unwrap().created);
        assert!(!external.exists());
        fs::write(&external, "Keep this.").unwrap();
        assert!(!ensure_at(root.path(), None).unwrap().created);
        assert_eq!(fs::read_to_string(&external).unwrap(), "Keep this.");
        assert_eq!(fs::read_link(&target).unwrap(), external);
    }

    #[cfg(unix)]
    #[test]
    fn reports_write_failure_and_can_read_existing_instructions_in_read_only_roots() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempdir().unwrap();
        fs::set_permissions(root.path(), fs::Permissions::from_mode(0o555)).unwrap();
        let result = ensure_at(root.path(), None);
        fs::set_permissions(root.path(), fs::Permissions::from_mode(0o755)).unwrap();
        assert!(result.is_err());
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
        fs::write(root.path().join("AGENTS.md"), "Keep this.").unwrap();
        fs::set_permissions(root.path(), fs::Permissions::from_mode(0o555)).unwrap();
        let result = ensure_at(root.path(), None);
        fs::set_permissions(root.path(), fs::Permissions::from_mode(0o755)).unwrap();
        assert!(!result.unwrap().created);
    }
}
