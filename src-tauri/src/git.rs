#[derive(Debug, Clone, serde::Serialize)]
pub struct GitStatusEntry {
    pub path: String,
    pub status: String,
}

/// Return workspace changes used for Files decorations and summaries.
#[tauri::command]
pub async fn git_status(path: String) -> Result<Vec<GitStatusEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || git_status_blocking(&path))
        .await
        .map_err(|error| format!("Git status task failed: {error}"))?
}

fn git_status_blocking(path: &str) -> Result<Vec<GitStatusEntry>, String> {
    let workspace = std::fs::canonicalize(path)
        .map_err(|error| format!("Could not resolve workspace {}: {}", path, error))?;
    let repo = git2::Repository::discover(path)
        .map_err(|error| format!("Could not find a Git repository from {}: {}", path, error))?;

    let workdir = repo
        .workdir()
        .ok_or_else(|| "Bare Git repositories are not supported.".to_string())?;
    let statuses = repo
        .statuses(Some(
            git2::StatusOptions::new()
                .include_untracked(true)
                .recurse_untracked_dirs(true)
                .renames_head_to_index(true)
                .renames_index_to_workdir(true),
        ))
        .map_err(|error| format!("Could not read Git status: {}", error))?;

    let mut entries = statuses
        .iter()
        .filter_map(|entry| {
            let repository_relative = entry.path().ok()?;
            let status = entry.status();
            let label = if status.is_index_new() || status.is_wt_new() {
                "new"
            } else if status.is_index_modified() || status.is_wt_modified() {
                "modified"
            } else if status.is_index_deleted() || status.is_wt_deleted() {
                "deleted"
            } else if status.is_index_renamed() || status.is_wt_renamed() {
                "renamed"
            } else {
                return None;
            };
            let absolute = workdir.join(repository_relative);
            let workspace_relative = absolute.strip_prefix(&workspace).ok()?;
            Some(GitStatusEntry {
                path: workspace_relative.to_string_lossy().into_owned(),
                status: label.to_string(),
            })
        })
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_discovers_repository_from_nested_workspace() {
        let root = tempfile::tempdir().unwrap();
        git2::Repository::init(root.path()).unwrap();
        let nested = root.path().join("notes");
        std::fs::create_dir_all(&nested).unwrap();
        let changed = nested.join("draft.md");
        std::fs::write(&changed, "hello").unwrap();

        let entries = git_status_blocking(&nested.to_string_lossy()).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "draft.md");
        assert_eq!(entries[0].status, "new");
    }

    #[test]
    fn status_reports_non_repository_clearly() {
        let root = tempfile::tempdir().unwrap();
        let error = git_status_blocking(&root.path().to_string_lossy()).unwrap_err();
        assert!(error.contains("Could not find a Git repository"));
    }
}
