use git2::{Diff, DiffOptions, Index, Oid, Patch, Repository, Sort, Status, StatusOptions, Tree};
use sha2::{Digest, Sha256};
use std::path::{Component, Path, PathBuf};

const MAX_REVIEW_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHistoryEntry {
    pub hash: String,
    pub short_hash: String,
    pub message: String,
    pub authored_at: String,
    pub author: String,
    pub binary: bool,
    pub size: usize,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHistoryVersion {
    pub hash: String,
    pub path: String,
    pub content: Option<String>,
    pub binary: bool,
    pub size: usize,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct GitStatusEntry {
    pub path: String,
    pub status: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChangeEntry {
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
    pub staged: bool,
    pub unstaged: bool,
    pub conflicted: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileDiff {
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
    pub scope: String,
    pub staged: bool,
    pub unstaged: bool,
    pub conflicted: bool,
    pub original: String,
    pub modified: String,
    pub patch: String,
    pub added: usize,
    pub removed: usize,
    pub binary: bool,
    pub unavailable_reason: Option<String>,
    pub snapshot: String,
}

struct WorkspaceRepository {
    workspace: PathBuf,
    workdir: PathBuf,
    repo: Repository,
}

/// Return the compact workspace status used by existing Files decorations.
#[tauri::command]
pub async fn git_status(path: String) -> Result<Vec<GitStatusEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || git_status_blocking(&path))
        .await
        .map_err(|error| format!("Git status task failed: {error}"))?
}

/// Return status with the index/worktree split needed by the Changes view.
#[tauri::command]
pub async fn git_changes(path: String) -> Result<Vec<GitChangeEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || git_changes_blocking(&path))
        .await
        .map_err(|error| format!("Git changes task failed: {error}"))?
}

/// Return one immutable review snapshot. The Editor never reads or writes the
/// file to construct this view, so proposal and dirty-buffer ownership stay
/// unchanged.
#[tauri::command]
pub async fn git_file_diff(
    path: String,
    file: String,
    scope: String,
) -> Result<GitFileDiff, String> {
    tauri::async_runtime::spawn_blocking(move || git_file_diff_blocking(&path, &file, &scope))
        .await
        .map_err(|error| format!("Git diff task failed: {error}"))?
}

/// Stage one complete file only when the review snapshot is still current.
#[tauri::command]
pub async fn git_stage_file(
    path: String,
    file: String,
    scope: String,
    expected_snapshot: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let review = verify_snapshot(&path, &file, &scope, &expected_snapshot)?;
        ensure_stage_scope(&review)?;
        git_stage_file_blocking(&path, &file)
    })
    .await
    .map_err(|error| format!("Git stage task failed: {error}"))?
}

/// Return one complete file to its HEAD state in the index. This never changes
/// the working file.
#[tauri::command]
pub async fn git_unstage_file(
    path: String,
    file: String,
    scope: String,
    expected_snapshot: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let review = verify_snapshot(&path, &file, &scope, &expected_snapshot)?;
        ensure_unstage_scope(&review)?;
        git_unstage_file_blocking(&path, &file)
    })
    .await
    .map_err(|error| format!("Git unstage task failed: {error}"))?
}

/// Lists committed versions of one file. This is also used by graph nodes,
/// whose source path lives inside the managed Team checkout.
#[tauri::command]
pub fn git_file_history_available(path: String) -> bool {
    open_history_path(Path::new(&path)).is_ok()
}

#[tauri::command]
pub async fn git_file_history(
    path: String,
    limit: Option<usize>,
) -> Result<Vec<GitHistoryEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git_file_history_blocking(Path::new(&path), limit.unwrap_or(50).clamp(1, 200))
    })
    .await
    .map_err(|error| format!("Git history task failed: {error}"))?
}

#[tauri::command]
pub async fn git_file_version(path: String, hash: String) -> Result<GitHistoryVersion, String> {
    tauri::async_runtime::spawn_blocking(move || git_file_version_blocking(Path::new(&path), &hash))
        .await
        .map_err(|error| format!("Git history task failed: {error}"))?
}

/// Restoring writes a new working-file change. Managed Git publishes it in
/// the next batch; repository history is never rewound.
#[tauri::command]
pub async fn git_restore_file_version(path: String, hash: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        git_restore_file_version_blocking(Path::new(&path), &hash)
    })
    .await
    .map_err(|error| format!("Git restore task failed: {error}"))?
}

struct HistoryPath {
    repo: Repository,
    absolute: PathBuf,
    relative: PathBuf,
}

fn open_history_path(path: &Path) -> Result<HistoryPath, String> {
    let absolute = std::fs::canonicalize(path)
        .map_err(|error| format!("Could not resolve {}: {error}", path.display()))?;
    if !absolute.is_file() {
        return Err(format!(
            "History is only available for files: {}",
            absolute.display()
        ));
    }
    let parent = absolute
        .parent()
        .ok_or_else(|| "The file has no parent folder.".to_string())?;
    let repo = Repository::discover(parent)
        .map_err(|error| format!("Could not find file history: {error}"))?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| "Bare Git repositories are not supported.".to_string())?;
    let relative = absolute
        .strip_prefix(workdir)
        .map(Path::to_path_buf)
        .map_err(|_| "The file is outside the Git worktree.".to_string())?;
    Ok(HistoryPath {
        repo,
        absolute,
        relative,
    })
}

fn git_file_history_blocking(path: &Path, limit: usize) -> Result<Vec<GitHistoryEntry>, String> {
    let context = open_history_path(path)?;
    let mut walk = context.repo.revwalk().map_err(|error| error.to_string())?;
    walk.push_head()
        .map_err(|error| format!("Could not read file history: {error}"))?;
    walk.set_sorting(Sort::TIME)
        .map_err(|error| error.to_string())?;
    let mut entries = Vec::new();
    for oid in walk {
        let commit = context
            .repo
            .find_commit(oid.map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
        let tree = commit.tree().map_err(|error| error.to_string())?;
        let current = tree
            .get_path(&context.relative)
            .ok()
            .map(|entry| entry.id());
        let previous = commit
            .parent(0)
            .ok()
            .and_then(|parent| parent.tree().ok())
            .and_then(|tree| {
                tree.get_path(&context.relative)
                    .ok()
                    .map(|entry| entry.id())
            });
        if current.is_none() || current == previous {
            continue;
        }
        let blob = context
            .repo
            .find_blob(current.unwrap())
            .map_err(|error| error.to_string())?;
        let binary = unavailable_reason(blob.content(), blob.content()).is_some();
        let seconds = commit.time().seconds();
        let authored_at = chrono::DateTime::<chrono::Utc>::from_timestamp(seconds, 0)
            .unwrap_or_default()
            .to_rfc3339();
        let hash = commit.id().to_string();
        entries.push(GitHistoryEntry {
            short_hash: hash.chars().take(8).collect(),
            hash,
            message: commit
                .summary()
                .ok()
                .flatten()
                .unwrap_or("Saved version")
                .to_string(),
            authored_at,
            author: commit.author().name().ok().unwrap_or("Unknown").to_string(),
            binary,
            size: blob.size(),
        });
        if entries.len() >= limit {
            break;
        }
    }
    Ok(entries)
}

fn history_blob(context: &HistoryPath, hash: &str) -> Result<(Oid, Vec<u8>), String> {
    let oid = Oid::from_str(hash).map_err(|_| "The history version is invalid.".to_string())?;
    let commit = context
        .repo
        .find_commit(oid)
        .map_err(|_| "The history version is unavailable.".to_string())?;
    let tree = commit.tree().map_err(|error| error.to_string())?;
    let entry = tree
        .get_path(&context.relative)
        .map_err(|_| "This file did not exist in that version.".to_string())?;
    let blob = context
        .repo
        .find_blob(entry.id())
        .map_err(|error| error.to_string())?;
    Ok((oid, blob.content().to_vec()))
}

fn git_file_version_blocking(path: &Path, hash: &str) -> Result<GitHistoryVersion, String> {
    let context = open_history_path(path)?;
    let (oid, bytes) = history_blob(&context, hash)?;
    let binary = unavailable_reason(&bytes, &bytes).is_some();
    Ok(GitHistoryVersion {
        hash: oid.to_string(),
        path: context.absolute.to_string_lossy().into_owned(),
        content: (!binary).then(|| String::from_utf8_lossy(&bytes).into_owned()),
        binary,
        size: bytes.len(),
    })
}

fn git_restore_file_version_blocking(path: &Path, hash: &str) -> Result<(), String> {
    let context = open_history_path(path)?;
    let (_, bytes) = history_blob(&context, hash)?;
    crate::persistence::write_bytes_atomic(&context.absolute, &bytes)
        .map_err(|error| format!("Could not restore {}: {error}", context.absolute.display()))
}

fn git_status_blocking(path: &str) -> Result<Vec<GitStatusEntry>, String> {
    Ok(git_changes_blocking(path)?
        .into_iter()
        .map(|entry| GitStatusEntry {
            path: entry.path,
            status: entry.status,
        })
        .collect())
}

fn git_changes_blocking(path: &str) -> Result<Vec<GitChangeEntry>, String> {
    let context = open_workspace_repository(path)?;
    collect_changes(&context)
}

fn collect_changes(context: &WorkspaceRepository) -> Result<Vec<GitChangeEntry>, String> {
    let statuses = context
        .repo
        .statuses(Some(
            StatusOptions::new()
                .include_untracked(true)
                .recurse_untracked_dirs(true)
                .renames_head_to_index(true)
                .renames_index_to_workdir(true)
                .disable_pathspec_match(true),
        ))
        .map_err(|error| format!("Could not read Git status: {error}"))?;

    let mut entries = statuses
        .iter()
        .filter_map(|entry| change_entry(context, &entry))
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(entries)
}

fn change_entry(
    context: &WorkspaceRepository,
    entry: &git2::StatusEntry<'_>,
) -> Option<GitChangeEntry> {
    let status = entry.status();
    let label = status_label(status)?;
    let repository_relative = entry.path().ok()?;
    let path = workspace_relative(context, Path::new(repository_relative))?;
    let old_repository_path = renamed_old_path(entry, status);
    let old_path = old_repository_path
        .as_deref()
        .and_then(|value| workspace_relative(context, value));

    Some(GitChangeEntry {
        path,
        old_path,
        status: label.to_string(),
        staged: has_index_change(status),
        unstaged: has_worktree_change(status),
        conflicted: status.is_conflicted(),
    })
}

fn status_label(status: Status) -> Option<&'static str> {
    if status.is_conflicted() {
        Some("conflicted")
    } else if status.is_index_renamed() || status.is_wt_renamed() {
        Some("renamed")
    } else if status.is_index_new() || status.is_wt_new() {
        Some("new")
    } else if status.is_index_deleted() || status.is_wt_deleted() {
        Some("deleted")
    } else if status.is_index_modified()
        || status.is_wt_modified()
        || status.is_index_typechange()
        || status.is_wt_typechange()
    {
        Some("modified")
    } else {
        None
    }
}

fn has_index_change(status: Status) -> bool {
    status.intersects(
        Status::INDEX_NEW
            | Status::INDEX_MODIFIED
            | Status::INDEX_DELETED
            | Status::INDEX_RENAMED
            | Status::INDEX_TYPECHANGE,
    )
}

fn has_worktree_change(status: Status) -> bool {
    status.intersects(
        Status::WT_NEW
            | Status::WT_MODIFIED
            | Status::WT_DELETED
            | Status::WT_RENAMED
            | Status::WT_TYPECHANGE,
    ) || status.is_conflicted()
}

fn renamed_old_path(entry: &git2::StatusEntry<'_>, status: Status) -> Option<PathBuf> {
    let delta = if status.is_wt_renamed() {
        entry.index_to_workdir()
    } else if status.is_index_renamed() {
        entry.head_to_index()
    } else {
        None
    }?;
    delta.old_file().path().map(Path::to_path_buf)
}

fn git_file_diff_blocking(path: &str, file: &str, scope: &str) -> Result<GitFileDiff, String> {
    let normalized_scope = normalize_scope(scope)?;
    let context = open_workspace_repository(path)?;
    let workspace_relative = normalize_relative_file(file)?;
    let changes = collect_changes(&context)?;
    let change = changes
        .into_iter()
        .find(|entry| Path::new(&entry.path) == workspace_relative)
        .ok_or_else(|| {
            format!(
                "{} has no Git changes to review.",
                workspace_relative.display()
            )
        })?;

    if normalized_scope == "staged" && !change.staged {
        return Err(format!("{} has no staged changes.", change.path));
    }
    if normalized_scope == "unstaged" && !change.unstaged {
        return Err(format!("{} has no unstaged changes.", change.path));
    }

    let repository_relative = to_repository_relative(&context, &workspace_relative)?;
    let old_repository_relative = change
        .old_path
        .as_deref()
        .map(normalize_relative_file)
        .transpose()?
        .map(|old| to_repository_relative(&context, &old))
        .transpose()?;
    let index = context
        .repo
        .index()
        .map_err(|error| format!("Could not read the Git index: {error}"))?;
    let head_tree = head_tree(&context.repo)?;

    let base_path = old_repository_relative
        .as_deref()
        .unwrap_or(repository_relative.as_path());
    let original_bytes = match normalized_scope {
        "unstaged" => index_blob(&context.repo, &index, base_path)?,
        _ => tree_blob(&context.repo, head_tree.as_ref(), base_path)?,
    };
    let modified_bytes = match normalized_scope {
        "staged" => index_blob(&context.repo, &index, &repository_relative)?,
        _ => workdir_blob(&context, &workspace_relative)?,
    };

    let unavailable_reason = unavailable_reason(&original_bytes, &modified_bytes);
    let binary = unavailable_reason.is_some();
    let original = if binary {
        String::new()
    } else {
        String::from_utf8(original_bytes.clone())
            .map_err(|_| "The original Git blob is not UTF-8 text.".to_string())?
    };
    let modified = if binary {
        String::new()
    } else {
        String::from_utf8(modified_bytes.clone())
            .map_err(|_| "The working Git blob is not UTF-8 text.".to_string())?
    };

    let diff = build_diff(
        &context.repo,
        head_tree.as_ref(),
        &index,
        &repository_relative,
        normalized_scope,
    )?;
    let stats = diff
        .stats()
        .map_err(|error| format!("Could not calculate Git diff statistics: {error}"))?;
    let patch = if binary {
        String::new()
    } else {
        patch_text(&diff)?
    };
    let snapshot = review_snapshot(
        normalized_scope,
        &change,
        &original_bytes,
        &modified_bytes,
        &index,
        base_path,
        &repository_relative,
    );

    Ok(GitFileDiff {
        path: change.path,
        old_path: change.old_path,
        status: change.status,
        scope: normalized_scope.to_string(),
        staged: change.staged,
        unstaged: change.unstaged,
        conflicted: change.conflicted,
        original,
        modified,
        patch,
        added: stats.insertions(),
        removed: stats.deletions(),
        binary,
        unavailable_reason,
        snapshot,
    })
}

fn build_diff<'repo>(
    repo: &'repo Repository,
    head: Option<&Tree<'repo>>,
    index: &Index,
    repository_relative: &Path,
    scope: &str,
) -> Result<Diff<'repo>, String> {
    let mut options = DiffOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .show_untracked_content(true)
        .include_typechange(true)
        .disable_pathspec_match(true)
        .pathspec(repository_relative);
    match scope {
        "staged" => repo.diff_tree_to_index(head, Some(index), Some(&mut options)),
        "unstaged" => repo.diff_index_to_workdir(Some(index), Some(&mut options)),
        _ => repo.diff_tree_to_workdir_with_index(head, Some(&mut options)),
    }
    .map_err(|error| format!("Could not build the Git diff: {error}"))
}

fn patch_text(diff: &Diff<'_>) -> Result<String, String> {
    let mut bytes = Vec::new();
    for index in 0..diff.deltas().len() {
        let Some(mut patch) = Patch::from_diff(diff, index)
            .map_err(|error| format!("Could not read the Git patch: {error}"))?
        else {
            continue;
        };
        let buffer = patch
            .to_buf()
            .map_err(|error| format!("Could not format the Git patch: {error}"))?;
        bytes.extend_from_slice(buffer.as_ref());
        if bytes.len() > MAX_REVIEW_BYTES {
            return Ok(String::new());
        }
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn unavailable_reason(original: &[u8], modified: &[u8]) -> Option<String> {
    if original.len() > MAX_REVIEW_BYTES || modified.len() > MAX_REVIEW_BYTES {
        return Some(
            "This file is too large for an inline review. Open it in its default app.".into(),
        );
    }
    if original.contains(&0) || modified.contains(&0) {
        return Some("Binary files do not have a text diff.".into());
    }
    if std::str::from_utf8(original).is_err() || std::str::from_utf8(modified).is_err() {
        return Some("This file is not UTF-8 text.".into());
    }
    None
}

fn tree_blob(repo: &Repository, tree: Option<&Tree<'_>>, path: &Path) -> Result<Vec<u8>, String> {
    let Some(tree) = tree else {
        return Ok(Vec::new());
    };
    let Ok(entry) = tree.get_path(path) else {
        return Ok(Vec::new());
    };
    let object = entry
        .to_object(repo)
        .map_err(|error| format!("Could not read the HEAD object: {error}"))?;
    let blob = object
        .peel_to_blob()
        .map_err(|error| format!("The HEAD object is not a file: {error}"))?;
    Ok(blob.content().to_vec())
}

fn index_blob(repo: &Repository, index: &Index, path: &Path) -> Result<Vec<u8>, String> {
    let Some(entry) = index.get_path(path, 0) else {
        return Ok(Vec::new());
    };
    let blob = repo
        .find_blob(entry.id)
        .map_err(|error| format!("Could not read the indexed file: {error}"))?;
    Ok(blob.content().to_vec())
}

fn workdir_blob(context: &WorkspaceRepository, path: &Path) -> Result<Vec<u8>, String> {
    let absolute = context.workspace.join(path);
    let metadata = match std::fs::symlink_metadata(&absolute) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(format!("Could not inspect {}: {error}", absolute.display()));
        }
    };
    if metadata.file_type().is_symlink() {
        let target = std::fs::read_link(&absolute)
            .map_err(|error| format!("Could not read link {}: {error}", absolute.display()))?;
        return Ok(target.as_os_str().as_encoded_bytes().to_vec());
    }
    if !metadata.is_file() {
        return Err(format!("{} is not a regular file.", absolute.display()));
    }
    std::fs::read(&absolute)
        .map_err(|error| format!("Could not read {}: {error}", absolute.display()))
}

fn head_tree(repo: &Repository) -> Result<Option<Tree<'_>>, String> {
    match repo.head() {
        Ok(head) => head
            .peel_to_tree()
            .map(Some)
            .map_err(|error| format!("Could not read the HEAD tree: {error}")),
        Err(error) if error.code() == git2::ErrorCode::UnbornBranch => Ok(None),
        Err(error) if error.code() == git2::ErrorCode::NotFound => Ok(None),
        Err(error) => Err(format!("Could not read HEAD: {error}")),
    }
}

fn verify_snapshot(
    path: &str,
    file: &str,
    scope: &str,
    expected: &str,
) -> Result<GitFileDiff, String> {
    let current = git_file_diff_blocking(path, file, scope)?;
    if current.snapshot != expected {
        return Err(
            "This change moved after the review loaded. Refresh it before changing Git state."
                .into(),
        );
    }
    Ok(current)
}

fn ensure_stage_scope(review: &GitFileDiff) -> Result<(), String> {
    if review.scope == "staged" {
        return Err("Review the Unstaged scope before staging this file.".into());
    }
    if review.scope == "all" && review.staged && review.unstaged {
        return Err(
            "This file has staged and unstaged changes. Review the Unstaged scope before staging it."
                .into(),
        );
    }
    Ok(())
}

fn ensure_unstage_scope(review: &GitFileDiff) -> Result<(), String> {
    if review.scope == "unstaged" {
        return Err("Review the Staged scope before unstaging this file.".into());
    }
    if review.scope == "all" && review.staged && review.unstaged {
        return Err(
            "This file has staged and unstaged changes. Review the Staged scope before unstaging it."
                .into(),
        );
    }
    Ok(())
}

fn git_stage_file_blocking(path: &str, file: &str) -> Result<(), String> {
    let context = open_workspace_repository(path)?;
    let workspace_relative = normalize_relative_file(file)?;
    let change = collect_changes(&context)?
        .into_iter()
        .find(|entry| Path::new(&entry.path) == workspace_relative)
        .ok_or_else(|| {
            format!(
                "{} has no Git changes to stage.",
                workspace_relative.display()
            )
        })?;
    if change.conflicted {
        return Err("Resolve this conflict before staging it in Mimir.".into());
    }
    if !change.unstaged {
        return Err(format!("{} has no unstaged changes.", change.path));
    }

    let repository_relative = to_repository_relative(&context, &workspace_relative)?;
    let mut index = context
        .repo
        .index()
        .map_err(|error| format!("Could not read the Git index: {error}"))?;
    if let Some(old_path) = change.old_path.as_deref() {
        let old_workspace_relative = normalize_relative_file(old_path)?;
        let old_repository_relative = to_repository_relative(&context, &old_workspace_relative)?;
        if index.get_path(&old_repository_relative, 0).is_some() {
            index
                .remove_path(&old_repository_relative)
                .map_err(|error| format!("Could not stage the renamed source: {error}"))?;
        }
    }
    let absolute = context.workspace.join(&workspace_relative);
    let workdir_file = match std::fs::symlink_metadata(&absolute) {
        Ok(metadata) => metadata.is_file() || metadata.file_type().is_symlink(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => {
            return Err(format!("Could not inspect {}: {error}", absolute.display()));
        }
    };
    if workdir_file {
        index
            .add_path(&repository_relative)
            .map_err(|error| format!("Could not stage {}: {error}", change.path))?;
    } else if index.get_path(&repository_relative, 0).is_some() {
        index
            .remove_path(&repository_relative)
            .map_err(|error| format!("Could not stage deletion of {}: {error}", change.path))?;
    }
    index
        .write()
        .map_err(|error| format!("Could not write the Git index: {error}"))
}

fn git_unstage_file_blocking(path: &str, file: &str) -> Result<(), String> {
    let context = open_workspace_repository(path)?;
    let workspace_relative = normalize_relative_file(file)?;
    let change = collect_changes(&context)?
        .into_iter()
        .find(|entry| Path::new(&entry.path) == workspace_relative)
        .ok_or_else(|| {
            format!(
                "{} has no Git changes to unstage.",
                workspace_relative.display()
            )
        })?;
    if !change.staged {
        return Err(format!("{} has no staged changes.", change.path));
    }

    let repository_relative = to_repository_relative(&context, &workspace_relative)?;
    let mut paths = vec![repository_relative];
    if let Some(old_path) = change.old_path.as_deref() {
        let old_workspace_relative = normalize_relative_file(old_path)?;
        paths.push(to_repository_relative(&context, &old_workspace_relative)?);
    }

    let result = match context.repo.head() {
        Ok(head) => {
            let object = head
                .peel(git2::ObjectType::Commit)
                .map_err(|error| format!("Could not read HEAD: {error}"))?;
            context
                .repo
                .reset_default(Some(&object), paths.iter())
                .map_err(|error| format!("Could not unstage {}: {error}", change.path))
        }
        Err(error)
            if error.code() == git2::ErrorCode::UnbornBranch
                || error.code() == git2::ErrorCode::NotFound =>
        {
            context
                .repo
                .reset_default::<&PathBuf, _>(None, paths.iter())
                .map_err(|error| format!("Could not unstage {}: {error}", change.path))
        }
        Err(error) => Err(format!("Could not read HEAD: {error}")),
    };
    result
}

fn open_workspace_repository(path: &str) -> Result<WorkspaceRepository, String> {
    let workspace = std::fs::canonicalize(path)
        .map_err(|error| format!("Could not resolve workspace {path}: {error}"))?;
    let repo = Repository::discover(&workspace)
        .map_err(|error| format!("Could not find a Git repository from {path}: {error}"))?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| "Bare Git repositories are not supported.".to_string())?
        .to_path_buf();
    let workdir = std::fs::canonicalize(&workdir)
        .map_err(|error| format!("Could not resolve the Git worktree: {error}"))?;
    if !workspace.starts_with(&workdir) {
        return Err("The workspace is outside the discovered Git worktree.".into());
    }
    Ok(WorkspaceRepository {
        workspace,
        workdir,
        repo,
    })
}

fn normalize_relative_file(path: &str) -> Result<PathBuf, String> {
    let value = Path::new(path);
    if value.as_os_str().is_empty() || value.is_absolute() {
        return Err("The Git path must be relative to the workspace.".into());
    }
    if !value
        .components()
        .all(|component| matches!(component, Component::Normal(_)))
    {
        return Err("The Git path must stay inside the workspace.".into());
    }
    Ok(value.to_path_buf())
}

fn to_repository_relative(
    context: &WorkspaceRepository,
    workspace_relative: &Path,
) -> Result<PathBuf, String> {
    context
        .workspace
        .join(workspace_relative)
        .strip_prefix(&context.workdir)
        .map(Path::to_path_buf)
        .map_err(|_| "The Git path is outside the repository worktree.".into())
}

fn workspace_relative(context: &WorkspaceRepository, repository_relative: &Path) -> Option<String> {
    context
        .workdir
        .join(repository_relative)
        .strip_prefix(&context.workspace)
        .ok()
        .map(|path| path.to_string_lossy().into_owned())
}

fn normalize_scope(scope: &str) -> Result<&'static str, String> {
    match scope.trim().to_ascii_lowercase().as_str() {
        "all" => Ok("all"),
        "unstaged" => Ok("unstaged"),
        "staged" => Ok("staged"),
        _ => Err("Git diff scope must be all, unstaged, or staged.".into()),
    }
}

fn review_snapshot(
    scope: &str,
    change: &GitChangeEntry,
    original: &[u8],
    modified: &[u8],
    index: &Index,
    base_path: &Path,
    target_path: &Path,
) -> String {
    let mut digest = Sha256::new();
    hash_part(&mut digest, scope.as_bytes());
    hash_part(&mut digest, change.path.as_bytes());
    hash_part(
        &mut digest,
        change.old_path.as_deref().unwrap_or("").as_bytes(),
    );
    hash_part(&mut digest, change.status.as_bytes());
    hash_part(
        &mut digest,
        &[
            change.staged as u8,
            change.unstaged as u8,
            change.conflicted as u8,
        ],
    );
    hash_part(&mut digest, original);
    hash_part(&mut digest, modified);
    for entry in index.iter().filter(|entry| {
        entry.path.as_slice() == base_path.as_os_str().as_encoded_bytes()
            || entry.path.as_slice() == target_path.as_os_str().as_encoded_bytes()
    }) {
        hash_part(&mut digest, &entry.path);
        hash_part(&mut digest, entry.id.as_bytes());
        hash_part(&mut digest, &entry.mode.to_le_bytes());
        hash_part(&mut digest, &entry.flags.to_le_bytes());
        hash_part(&mut digest, &entry.flags_extended.to_le_bytes());
    }
    format!("{:x}", digest.finalize())
}

fn hash_part(digest: &mut Sha256, value: &[u8]) {
    digest.update((value.len() as u64).to_le_bytes());
    digest.update(value);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn commit_file(repo: &Repository, relative: &str, content: &str) {
        let workdir = repo.workdir().unwrap();
        let absolute = workdir.join(relative);
        if let Some(parent) = absolute.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(&absolute, content).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new(relative)).unwrap();
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        let signature = git2::Signature::now("Mimir", "mimir@example.test").unwrap();
        let parents = repo
            .head()
            .ok()
            .and_then(|head| head.peel_to_commit().ok())
            .into_iter()
            .collect::<Vec<_>>();
        let parent_refs = parents.iter().collect::<Vec<_>>();
        repo.commit(
            Some("HEAD"),
            &signature,
            &signature,
            "initial",
            &tree,
            &parent_refs,
        )
        .unwrap();
    }

    #[test]
    fn status_discovers_repository_from_nested_workspace() {
        let root = tempfile::tempdir().unwrap();
        Repository::init(root.path()).unwrap();
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

    #[test]
    fn file_history_lists_versions_and_restore_creates_a_worktree_change() {
        let root = tempfile::tempdir().unwrap();
        let repo = Repository::init(root.path()).unwrap();
        commit_file(&repo, "graph/resource.md", "first");
        let first = repo.head().unwrap().target().unwrap().to_string();
        commit_file(&repo, "graph/resource.md", "second");
        let path = root.path().join("graph/resource.md");

        let entries = git_file_history_blocking(&path, 10).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(
            git_file_version_blocking(&path, &first)
                .unwrap()
                .content
                .as_deref(),
            Some("first")
        );

        git_restore_file_version_blocking(&path, &first).unwrap();
        assert_eq!(std::fs::read_to_string(path).unwrap(), "first");
        assert!(!repo.statuses(None).unwrap().is_empty());
    }

    #[test]
    fn file_history_availability_discovers_nested_repositories() {
        let root = tempfile::tempdir().unwrap();
        let repo = Repository::init(root.path()).unwrap();
        commit_file(&repo, "nested/resource.md", "first");
        let outside = tempfile::NamedTempFile::new().unwrap();

        assert!(git_file_history_available(
            root.path()
                .join("nested/resource.md")
                .to_string_lossy()
                .into_owned()
        ));
        assert!(!git_file_history_available(
            outside.path().to_string_lossy().into_owned()
        ));
    }

    #[cfg(unix)]
    #[test]
    fn review_reads_a_symlink_target_name_without_following_it() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        Repository::init(root.path()).unwrap();
        let outside = root.path().join("outside.txt");
        std::fs::write(&outside, "private contents").unwrap();
        symlink(&outside, root.path().join("linked.txt")).unwrap();
        let context = open_workspace_repository(&root.path().to_string_lossy()).unwrap();

        let bytes = workdir_blob(&context, Path::new("linked.txt")).unwrap();
        assert_eq!(bytes, outside.as_os_str().as_encoded_bytes());
        assert_ne!(bytes, b"private contents");
    }

    #[test]
    fn changes_keep_staged_and_unstaged_state_separate() {
        let root = tempfile::tempdir().unwrap();
        let repo = Repository::init(root.path()).unwrap();
        commit_file(&repo, "doc.md", "before\n");
        std::fs::write(root.path().join("doc.md"), "after\n").unwrap();
        std::fs::write(root.path().join("new.md"), "new\n").unwrap();

        let changes = git_changes_blocking(&root.path().to_string_lossy()).unwrap();
        let modified = changes.iter().find(|entry| entry.path == "doc.md").unwrap();
        let new = changes.iter().find(|entry| entry.path == "new.md").unwrap();
        assert!(!modified.staged);
        assert!(modified.unstaged);
        assert_eq!(modified.status, "modified");
        assert_eq!(new.status, "new");
        assert!(new.unstaged);
    }

    #[test]
    fn file_diff_returns_an_immutable_text_snapshot() {
        let root = tempfile::tempdir().unwrap();
        let repo = Repository::init(root.path()).unwrap();
        commit_file(&repo, "doc.md", "before\n");
        std::fs::write(root.path().join("doc.md"), "after\n").unwrap();

        let diff = git_file_diff_blocking(&root.path().to_string_lossy(), "doc.md", "all").unwrap();
        assert_eq!(diff.original, "before\n");
        assert_eq!(diff.modified, "after\n");
        assert_eq!(diff.added, 1);
        assert_eq!(diff.removed, 1);
        assert!(!diff.snapshot.is_empty());
        assert!(diff.patch.contains("after"));
    }

    #[test]
    fn stage_and_unstage_change_only_the_index() {
        let root = tempfile::tempdir().unwrap();
        let repo = Repository::init(root.path()).unwrap();
        commit_file(&repo, "doc.md", "before\n");
        std::fs::write(root.path().join("doc.md"), "after\n").unwrap();

        let before =
            git_file_diff_blocking(&root.path().to_string_lossy(), "doc.md", "all").unwrap();
        verify_snapshot(
            &root.path().to_string_lossy(),
            "doc.md",
            "all",
            &before.snapshot,
        )
        .unwrap();
        git_stage_file_blocking(&root.path().to_string_lossy(), "doc.md").unwrap();
        let staged = git_changes_blocking(&root.path().to_string_lossy()).unwrap();
        assert!(staged[0].staged);
        assert!(!staged[0].unstaged);
        assert_eq!(
            std::fs::read_to_string(root.path().join("doc.md")).unwrap(),
            "after\n"
        );

        git_unstage_file_blocking(&root.path().to_string_lossy(), "doc.md").unwrap();
        let unstaged = git_changes_blocking(&root.path().to_string_lossy()).unwrap();
        assert!(!unstaged[0].staged);
        assert!(unstaged[0].unstaged);
        assert_eq!(
            std::fs::read_to_string(root.path().join("doc.md")).unwrap(),
            "after\n"
        );
    }

    #[test]
    fn stale_snapshot_cannot_change_the_index() {
        let root = tempfile::tempdir().unwrap();
        let repo = Repository::init(root.path()).unwrap();
        commit_file(&repo, "doc.md", "before\n");
        std::fs::write(root.path().join("doc.md"), "after\n").unwrap();
        let diff = git_file_diff_blocking(&root.path().to_string_lossy(), "doc.md", "all").unwrap();
        std::fs::write(root.path().join("doc.md"), "moved again\n").unwrap();

        let error = verify_snapshot(
            &root.path().to_string_lossy(),
            "doc.md",
            "all",
            &diff.snapshot,
        )
        .unwrap_err();
        assert!(error.contains("Refresh"));
    }

    #[test]
    fn all_snapshot_tracks_index_state() {
        let root = tempfile::tempdir().unwrap();
        let repo = Repository::init(root.path()).unwrap();
        commit_file(&repo, "doc.md", "before\n");
        std::fs::write(root.path().join("doc.md"), "after\n").unwrap();
        let review =
            git_file_diff_blocking(&root.path().to_string_lossy(), "doc.md", "all").unwrap();

        let mut index = repo.index().unwrap();
        index.add_path(Path::new("doc.md")).unwrap();
        index.write().unwrap();

        let error = verify_snapshot(
            &root.path().to_string_lossy(),
            "doc.md",
            "all",
            &review.snapshot,
        )
        .unwrap_err();
        assert!(error.contains("Refresh"));
    }

    #[test]
    fn mixed_index_state_requires_the_exact_action_scope() {
        let root = tempfile::tempdir().unwrap();
        let repo = Repository::init(root.path()).unwrap();
        commit_file(&repo, "doc.md", "before\n");
        std::fs::write(root.path().join("doc.md"), "staged\n").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("doc.md")).unwrap();
        index.write().unwrap();
        std::fs::write(root.path().join("doc.md"), "unstaged\n").unwrap();

        let all = git_file_diff_blocking(&root.path().to_string_lossy(), "doc.md", "all").unwrap();
        assert!(all.staged && all.unstaged);
        assert!(ensure_stage_scope(&all).unwrap_err().contains("Unstaged"));
        assert!(ensure_unstage_scope(&all).unwrap_err().contains("Staged"));

        let staged =
            git_file_diff_blocking(&root.path().to_string_lossy(), "doc.md", "staged").unwrap();
        assert!(ensure_unstage_scope(&staged).is_ok());
        assert!(ensure_stage_scope(&staged).is_err());

        let unstaged =
            git_file_diff_blocking(&root.path().to_string_lossy(), "doc.md", "unstaged").unwrap();
        assert!(ensure_stage_scope(&unstaged).is_ok());
        assert!(ensure_unstage_scope(&unstaged).is_err());
    }
}
