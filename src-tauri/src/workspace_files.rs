use crate::file_index_commands::FileIndexState;
use serde::{Deserialize, Serialize};
use std::ffi::OsStr;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::Command;

const HIDDEN_NOISE: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    ".cache",
    ".next",
    ".nuxt",
    ".parcel-cache",
    ".turbo",
    ".venv",
    "__pycache__",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "out",
    "target",
];

const KNOWN_TEXT_EXTENSIONS: &[&str] = &[
    "bash",
    "bib",
    "c",
    "cc",
    "cfg",
    "conf",
    "cpp",
    "css",
    "csv",
    "dockerfile",
    "fish",
    "go",
    "h",
    "hpp",
    "htm",
    "html",
    "ini",
    "java",
    "js",
    "json",
    "jsonc",
    "jsx",
    "kt",
    "kts",
    "less",
    "lua",
    "m",
    "markdown",
    "md",
    "mdown",
    "mkd",
    "mm",
    "mjs",
    "mts",
    "php",
    "pl",
    "properties",
    "py",
    "r",
    "rb",
    "rs",
    "scss",
    "sh",
    "sql",
    "svg",
    "swift",
    "toml",
    "ts",
    "tsx",
    "txt",
    "vue",
    "xml",
    "yaml",
    "yml",
    "zsh",
];

const KNOWN_EXTERNAL_EXTENSIONS: &[&str] = &[
    "7z", "a", "avi", "bmp", "class", "db", "dll", "dylib", "eot", "exe", "gif", "gz", "ico",
    "jar", "jpeg", "jpg", "mkv", "mov", "mp3", "mp4", "o", "otf", "png", "rar", "so", "sqlite",
    "sqlite3", "tar", "tiff", "ttf", "wav", "wasm", "webp", "woff", "woff2", "zip",
];

/// Outcome of dropping outside files onto the workspace tree.
///
/// A drop is a batch, so one unreadable item must not discard the rest: each
/// source lands completely or not at all, and whatever failed is described in
/// `failures` instead of failing the call. `skipped_links` counts symbolic
/// links passed over inside imported folders — copying them could plant a live
/// pointer outside the workspace, so they are left behind and reported.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub entries: Vec<WorkspaceEntry>,
    pub skipped_links: usize,
    pub failures: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    pub path: String,
    pub relative_path: String,
    pub name: String,
    pub is_directory: bool,
    pub mtime: i64,
    pub size: u64,
    pub text_readable: bool,
    pub open_behavior: String,
}

#[tauri::command]
pub async fn workspace_file_list_directory(
    state: tauri::State<'_, FileIndexState>,
    directory: String,
) -> Result<Vec<WorkspaceEntry>, String> {
    let root = state.index()?.workspace();
    tauri::async_runtime::spawn_blocking(move || list_directory(&root, &directory))
        .await
        .map_err(|error| format!("File browser task failed: {error}"))?
}

#[tauri::command]
pub async fn workspace_file_inspect(
    state: tauri::State<'_, FileIndexState>,
    path: String,
) -> Result<WorkspaceEntry, String> {
    let root = state.index()?.workspace();
    tauri::async_runtime::spawn_blocking(move || {
        let target = resolve_existing(&root, &path)?;
        entry_for_path(&canonical_root(&root)?, &target)
    })
    .await
    .map_err(|error| format!("File inspection task failed: {error}"))?
}

#[tauri::command]
pub async fn workspace_file_create(
    state: tauri::State<'_, FileIndexState>,
    relative_path: String,
    directory: bool,
) -> Result<WorkspaceEntry, String> {
    let root = state.index()?.workspace();
    tauri::async_runtime::spawn_blocking(move || create_entry(&root, &relative_path, directory))
        .await
        .map_err(|error| format!("File creation task failed: {error}"))?
}

#[tauri::command]
pub async fn workspace_file_rename(
    state: tauri::State<'_, FileIndexState>,
    path: String,
    new_name: String,
) -> Result<WorkspaceEntry, String> {
    let root = state.index()?.workspace();
    tauri::async_runtime::spawn_blocking(move || rename_entry(&root, &path, &new_name))
        .await
        .map_err(|error| format!("File rename task failed: {error}"))?
}

#[tauri::command]
pub async fn workspace_file_move(
    state: tauri::State<'_, FileIndexState>,
    path: String,
    destination: String,
) -> Result<WorkspaceEntry, String> {
    let root = state.index()?.workspace();
    tauri::async_runtime::spawn_blocking(move || move_entry(&root, &path, &destination))
        .await
        .map_err(|error| format!("File move task failed: {error}"))?
}

#[tauri::command]
pub async fn workspace_file_duplicate(
    state: tauri::State<'_, FileIndexState>,
    path: String,
) -> Result<WorkspaceEntry, String> {
    let root = state.index()?.workspace();
    tauri::async_runtime::spawn_blocking(move || duplicate_entry(&root, &path))
        .await
        .map_err(|error| format!("File duplicate task failed: {error}"))?
}

#[tauri::command]
pub async fn workspace_file_import(
    state: tauri::State<'_, FileIndexState>,
    destination: String,
    sources: Vec<String>,
) -> Result<ImportReport, String> {
    let root = state.index()?.workspace();
    tauri::async_runtime::spawn_blocking(move || import_entries(&root, &destination, &sources))
        .await
        .map_err(|error| format!("File import task failed: {error}"))?
}

#[tauri::command]
pub async fn workspace_file_trash(
    state: tauri::State<'_, FileIndexState>,
    paths: Vec<String>,
) -> Result<Vec<String>, String> {
    let root = state.index()?.workspace();
    tauri::async_runtime::spawn_blocking(move || {
        let targets = validate_trash_targets(&root, &paths)?;
        let mut trashed = Vec::with_capacity(targets.len());
        for target in targets {
            let relative = display_relative(&root, &target);
            trash::delete(&target)
                .map_err(|error| format!("Could not move {relative} to the Trash: {error}"))?;
            trashed.push(relative);
        }
        Ok(trashed)
    })
    .await
    .map_err(|error| format!("File trash task failed: {error}"))?
}

#[tauri::command]
pub fn workspace_file_open_native(
    state: tauri::State<'_, FileIndexState>,
    path: String,
) -> Result<(), String> {
    let root = state.index()?.workspace();
    let target = resolve_existing(&root, &path)?;

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(&target);
        command
    };
    #[cfg(target_os = "linux")]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(&target);
        command
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("explorer");
        command.arg(&target);
        command
    };

    command.spawn().map_err(|error| {
        format!(
            "Could not open {}: {error}",
            display_relative(&root, &target)
        )
    })?;
    Ok(())
}

#[tauri::command]
pub fn workspace_file_reveal(
    state: tauri::State<'_, FileIndexState>,
    path: String,
) -> Result<(), String> {
    let root = state.index()?.workspace();
    let target = resolve_existing(&root, &path)?;

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg("-R").arg(&target);
        command
    };
    #[cfg(target_os = "linux")]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(target.parent().unwrap_or(&target));
        command
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("explorer");
        command.arg("/select,").arg(&target);
        command
    };

    command.spawn().map_err(|error| {
        format!(
            "Could not reveal {}: {error}",
            display_relative(&root, &target)
        )
    })?;
    Ok(())
}

fn create_entry(
    root: &Path,
    relative_path: &str,
    directory: bool,
) -> Result<WorkspaceEntry, String> {
    let root = canonical_root(root)?;
    let path = resolve_new_path(&root, relative_path)?;
    if path.exists() {
        return Err(format!(
            "{} already exists.",
            display_relative(&root, &path)
        ));
    }
    if directory {
        fs::create_dir(&path).map_err(|error| format!("Could not create folder: {error}"))?;
    } else {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
            .map_err(|error| format!("Could not create file: {error}"))?;
        file.flush()
            .map_err(|error| format!("Could not finish creating file: {error}"))?;
    }
    entry_for_path(&root, &path)
}

fn rename_entry(root: &Path, path: &str, new_name: &str) -> Result<WorkspaceEntry, String> {
    let root = canonical_root(root)?;
    let source = resolve_existing(&root, path)?;
    ensure_not_root(&root, &source)?;
    let name = validate_name(new_name)?;
    let destination = source
        .parent()
        .ok_or_else(|| "The workspace root cannot be renamed.".to_string())?
        .join(name);
    if destination == source {
        return entry_for_path(&root, &source);
    }
    if destination.exists() {
        return Err(format!(
            "{} already exists.",
            display_relative(&root, &destination)
        ));
    }
    fs::rename(&source, &destination).map_err(|error| {
        format!(
            "Could not rename {}: {error}",
            display_relative(&root, &source)
        )
    })?;
    entry_for_path(&root, &destination)
}

/// Move an existing entry into `destination` (a workspace-relative folder,
/// empty for the root), keeping its name. Unlike import this relocates the
/// original, so it is reserved for drags that start inside the workspace.
fn move_entry(root: &Path, path: &str, destination: &str) -> Result<WorkspaceEntry, String> {
    let root = canonical_root(root)?;
    let source = resolve_existing(&root, path)?;
    ensure_not_root(&root, &source)?;
    let target = resolve_destination_directory(&root, destination)?;
    if target == source || target.starts_with(&source) {
        return Err(format!(
            "{} cannot be moved into itself.",
            display_relative(&root, &source)
        ));
    }
    let name = source
        .file_name()
        .ok_or_else(|| "The item has no name.".to_string())?;
    let moved = target.join(name);
    if moved == source {
        return entry_for_path(&root, &source);
    }
    if moved.exists() {
        return Err(format!(
            "{} already exists.",
            display_relative(&root, &moved)
        ));
    }
    fs::rename(&source, &moved).map_err(|error| {
        format!(
            "Could not move {}: {error}",
            display_relative(&root, &source)
        )
    })?;
    entry_for_path(&root, &moved)
}

fn duplicate_entry(root: &Path, path: &str) -> Result<WorkspaceEntry, String> {
    let root = canonical_root(root)?;
    let source = resolve_existing(&root, path)?;
    ensure_not_root(&root, &source)?;
    let destination = duplicate_destination(&source)?;
    let metadata = fs::symlink_metadata(&source)
        .map_err(|error| format!("Could not inspect source: {error}"))?;
    if metadata.file_type().is_symlink() {
        return Err("Symbolic links cannot be duplicated from Files.".into());
    }
    if metadata.is_dir() {
        copy_directory(&source, &destination)?;
    } else {
        fs::copy(&source, &destination)
            .map_err(|error| format!("Could not duplicate file: {error}"))?;
    }
    entry_for_path(&root, &destination)
}

/// Copy files and folders dropped from outside into `destination` (a folder
/// relative to, or inside, the workspace). Sources are copied rather than
/// moved: a drop must never remove someone's original from the Desktop.
fn import_entries(
    root: &Path,
    destination: &str,
    sources: &[String],
) -> Result<ImportReport, String> {
    if sources.is_empty() {
        return Err("Nothing was dropped.".into());
    }
    let root = canonical_root(root)?;
    let target = resolve_destination_directory(&root, destination)?;
    let mut entries = Vec::with_capacity(sources.len());
    let mut failures = Vec::new();
    let mut skipped_links = 0_usize;

    for source in sources {
        match import_one(&root, &target, source) {
            Ok((entry, skipped)) => {
                entries.push(entry);
                skipped_links += skipped;
            }
            Err(failure) => failures.push(failure),
        }
    }

    Ok(ImportReport {
        entries,
        skipped_links,
        failures,
    })
}

/// Copy one dropped item, leaving nothing behind if it does not finish. The
/// destination name is always fresh, so removing a partial copy can only
/// remove what this call just created.
fn import_one(root: &Path, target: &Path, source: &str) -> Result<(WorkspaceEntry, usize), String> {
    let supplied = Path::new(source.trim());
    if !supplied.is_absolute() {
        return Err("Dropped items must have a full path.".into());
    }
    // Canonicalizing follows a dropped alias to what it points at, so the copy
    // holds real content instead of a dangling link.
    let source = supplied
        .canonicalize()
        .map_err(|error| format!("{} could not be read: {error}", supplied.display()))?;
    let name = source
        .file_name()
        .ok_or_else(|| "A dropped item has no name.".to_string())?;
    if target == source || target.starts_with(&source) {
        return Err(format!(
            "{} cannot be added to itself.",
            name.to_string_lossy()
        ));
    }
    let path = available_destination(target, name)?;
    let metadata = fs::metadata(&source)
        .map_err(|error| format!("Could not inspect {}: {error}", source.display()))?;

    let skipped = if metadata.is_dir() {
        copy_imported_directory(&source, &path).inspect_err(|_| {
            let _ = fs::remove_dir_all(&path);
        })?
    } else {
        fs::copy(&source, &path)
            .map_err(|error| format!("Could not add {}: {error}", name.to_string_lossy()))
            .inspect_err(|_| {
                let _ = fs::remove_file(&path);
            })?;
        0
    };
    Ok((entry_for_path(root, &path)?, skipped))
}

fn resolve_destination_directory(root: &Path, destination: &str) -> Result<PathBuf, String> {
    let destination = destination.trim();
    let path = if destination.is_empty() {
        root.to_path_buf()
    } else {
        resolve_existing(root, destination)?
    };
    if !path.is_dir() {
        return Err(format!(
            "{} is not a folder.",
            display_relative(root, &path)
        ));
    }
    Ok(path)
}

/// Never overwrite what is already in the destination: fall back to the same
/// " copy" naming the Duplicate action uses.
fn available_destination(directory: &Path, name: &OsStr) -> Result<PathBuf, String> {
    let candidate = directory.join(name);
    if candidate.exists() {
        return duplicate_destination(&candidate);
    }
    Ok(candidate)
}

/// Recursive copy for imports, returning how many symbolic links were skipped.
/// Unlike `copy_directory` this never aborts part-way: a dropped folder that
/// happens to contain a link still lands, minus the link.
fn copy_imported_directory(source: &Path, destination: &Path) -> Result<usize, String> {
    fs::create_dir(destination).map_err(|error| {
        format!(
            "Could not create {}: {error}",
            destination
                .file_name()
                .map(|value| value.to_string_lossy().into_owned())
                .unwrap_or_else(|| destination.display().to_string())
        )
    })?;
    let mut skipped = 0_usize;
    for item in fs::read_dir(source)
        .map_err(|error| format!("Could not read {}: {error}", source.display()))?
    {
        let item = item.map_err(|error| format!("Could not read a dropped entry: {error}"))?;
        let file_type = item
            .file_type()
            .map_err(|error| format!("Could not inspect a dropped entry: {error}"))?;
        if file_type.is_symlink() {
            skipped += 1;
            continue;
        }
        let target = destination.join(item.file_name());
        if file_type.is_dir() {
            skipped += copy_imported_directory(&item.path(), &target)?;
        } else {
            fs::copy(item.path(), target).map_err(|error| {
                format!(
                    "Could not add {}: {error}",
                    item.file_name().to_string_lossy()
                )
            })?;
        }
    }
    Ok(skipped)
}

fn list_directory(root: &Path, directory: &str) -> Result<Vec<WorkspaceEntry>, String> {
    let canonical_root = canonical_root(root)?;
    let path = if directory.trim().is_empty() {
        canonical_root.clone()
    } else {
        resolve_existing(&canonical_root, directory)?
    };
    if !path.is_dir() {
        return Err(format!(
            "{} is not a folder.",
            display_relative(&canonical_root, &path)
        ));
    }

    let mut entries = Vec::new();
    let read = fs::read_dir(&path).map_err(|error| {
        format!(
            "Could not read {}: {error}",
            display_relative(&canonical_root, &path)
        )
    })?;
    for item in read {
        let item = item.map_err(|error| format!("Could not read a folder entry: {error}"))?;
        let name = item.file_name().to_string_lossy().into_owned();
        if HIDDEN_NOISE.contains(&name.as_str())
            || matches!(name.as_str(), ".DS_Store" | "Thumbs.db")
        {
            continue;
        }
        let candidate = item.path();
        // Only symlinked entries can point outside the workspace: the listed
        // directory is itself canonical, so a plain entry's real path is just
        // the joined path. Canonicalizing every entry is expensive, so resolve
        // only actual symlinks to enforce the root boundary (escaping or
        // dangling links are excluded, exactly as before).
        let file_type = match item.file_type() {
            Ok(value) => value,
            Err(_) => continue,
        };
        if file_type.is_symlink() {
            let canonical = match candidate.canonicalize() {
                Ok(value) => value,
                Err(_) => continue,
            };
            if !canonical.starts_with(&canonical_root) {
                continue;
            }
        }
        entries.push(entry_for_path(&canonical_root, &candidate)?);
    }
    entries.sort_by(|left, right| {
        right
            .is_directory
            .cmp(&left.is_directory)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok(entries)
}

fn canonical_root(root: &Path) -> Result<PathBuf, String> {
    root.canonicalize()
        .map_err(|error| format!("Could not access workspace {}: {error}", root.display()))
}

fn resolve_existing(root: &Path, supplied: &str) -> Result<PathBuf, String> {
    let root = canonical_root(root)?;
    let supplied = supplied.trim();
    let candidate = if Path::new(supplied).is_absolute() {
        PathBuf::from(supplied)
    } else {
        reject_relative_traversal(supplied)?;
        root.join(supplied)
    };
    let canonical = candidate.canonicalize().map_err(|error| {
        format!(
            "{} does not exist or cannot be accessed: {error}",
            candidate.display()
        )
    })?;
    if !canonical.starts_with(&root) {
        return Err("The path must stay inside the open workspace.".into());
    }
    Ok(canonical)
}

fn resolve_new_path(root: &Path, supplied: &str) -> Result<PathBuf, String> {
    let root = canonical_root(root)?;
    let supplied = supplied.trim();
    if supplied.is_empty() {
        return Err("Enter a name.".into());
    }
    let relative = Path::new(supplied);
    if relative.is_absolute() {
        return Err("New paths must be relative to the workspace.".into());
    }
    reject_relative_traversal(supplied)?;
    let file_name = relative
        .file_name()
        .ok_or_else(|| "Enter a name.".to_string())?;
    let parent = relative.parent().unwrap_or_else(|| Path::new(""));
    let canonical_parent = root
        .join(parent)
        .canonicalize()
        .map_err(|error| format!("The destination folder cannot be accessed: {error}"))?;
    if !canonical_parent.starts_with(&root) {
        return Err("The path must stay inside the open workspace.".into());
    }
    Ok(canonical_parent.join(file_name))
}

fn reject_relative_traversal(path: &str) -> Result<(), String> {
    if Path::new(path)
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("The path must stay inside the open workspace.".into());
    }
    Ok(())
}

fn validate_name(name: &str) -> Result<&str, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Enter a name.".into());
    }
    let path = Path::new(name);
    let mut components = path.components();
    if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
        return Err("A name cannot contain folder separators.".into());
    }
    Ok(name)
}

fn ensure_not_root(root: &Path, path: &Path) -> Result<(), String> {
    if path == canonical_root(root)? {
        return Err("The workspace root cannot be changed from Files.".into());
    }
    Ok(())
}

fn validate_trash_targets(root: &Path, paths: &[String]) -> Result<Vec<PathBuf>, String> {
    if paths.is_empty() {
        return Err("Select at least one file or folder.".into());
    }
    let mut targets = Vec::with_capacity(paths.len());
    for path in paths {
        let target = resolve_existing(root, path)?;
        ensure_not_root(root, &target)?;
        if !targets.contains(&target) {
            targets.push(target);
        }
    }
    Ok(targets)
}

fn duplicate_destination(source: &Path) -> Result<PathBuf, String> {
    let parent = source
        .parent()
        .ok_or_else(|| "The workspace root cannot be duplicated.".to_string())?;
    let is_directory = source.is_dir();
    let stem = if is_directory {
        source
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "The item name is not valid UTF-8.".to_string())?
            .to_string()
    } else {
        source
            .file_stem()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "The item name is not valid UTF-8.".to_string())?
            .to_string()
    };
    let extension = if is_directory {
        String::new()
    } else {
        source
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| format!(".{value}"))
            .unwrap_or_default()
    };
    for index in 1..=10_000 {
        let suffix = if index == 1 {
            " copy".to_string()
        } else {
            format!(" copy {index}")
        };
        let candidate = parent.join(format!("{stem}{suffix}{extension}"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("Could not choose an available duplicate name.".into())
}

fn copy_directory(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir(destination)
        .map_err(|error| format!("Could not create duplicate folder: {error}"))?;
    for item in
        fs::read_dir(source).map_err(|error| format!("Could not read source folder: {error}"))?
    {
        let item = item.map_err(|error| format!("Could not read a source entry: {error}"))?;
        let metadata = item
            .file_type()
            .map_err(|error| format!("Could not inspect a source entry: {error}"))?;
        if metadata.is_symlink() {
            return Err(
                "Folders containing symbolic links cannot be duplicated from Files.".into(),
            );
        }
        let target = destination.join(item.file_name());
        if metadata.is_dir() {
            copy_directory(&item.path(), &target)?;
        } else {
            fs::copy(item.path(), target)
                .map_err(|error| format!("Could not duplicate a folder entry: {error}"))?;
        }
    }
    Ok(())
}

fn entry_for_path(root: &Path, path: &Path) -> Result<WorkspaceEntry, String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Could not inspect {}: {error}", path.display()))?;
    let is_directory = metadata.is_dir();
    let mtime = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0);
    let open_behavior = classify_open_behavior(path, is_directory);
    Ok(WorkspaceEntry {
        path: path.to_string_lossy().into_owned(),
        relative_path: display_relative(root, path),
        name: path
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| "workspace".into()),
        is_directory,
        mtime,
        size: if is_directory { 0 } else { metadata.len() },
        text_readable: open_behavior == "text",
        open_behavior: open_behavior.into(),
    })
}

fn display_relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn text_readable(path: &Path) -> bool {
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    let mut buffer = [0_u8; 8192];
    let Ok(read) = file.read(&mut buffer) else {
        return false;
    };
    !buffer[..read].contains(&0) && std::str::from_utf8(&buffer[..read]).is_ok()
}

fn classify_open_behavior(path: &Path, is_directory: bool) -> &'static str {
    if is_directory {
        return "directory";
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if extension == "pdf" {
        return "pdf";
    }
    if KNOWN_TEXT_EXTENSIONS.contains(&extension.as_str()) {
        return "text";
    }
    if KNOWN_EXTERNAL_EXTENSIONS.contains(&extension.as_str()) {
        return "external";
    }
    if text_readable(path) {
        "text"
    } else {
        "external"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::slice;
    use tempfile::tempdir;

    #[test]
    fn directory_listing_is_folder_first_and_hides_build_noise() {
        let temp = tempdir().unwrap();
        fs::create_dir(temp.path().join("z-folder")).unwrap();
        fs::create_dir(temp.path().join("node_modules")).unwrap();
        fs::write(temp.path().join("b.md"), "b").unwrap();
        fs::write(temp.path().join("A.md"), "a").unwrap();

        let entries = list_directory(temp.path(), "").unwrap();
        assert_eq!(
            entries
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            ["z-folder", "A.md", "b.md"]
        );
    }

    #[cfg(unix)]
    #[test]
    fn listing_excludes_escaping_and_dangling_symlinks_but_keeps_internal_ones() {
        use std::os::unix::fs::symlink;

        let temp = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), "outside").unwrap();
        fs::write(temp.path().join("inside.md"), "inside").unwrap();
        symlink(
            outside.path().join("secret.txt"),
            temp.path().join("escape.txt"),
        )
        .unwrap();
        symlink(temp.path().join("inside.md"), temp.path().join("alias.md")).unwrap();
        symlink(
            temp.path().join("never-existed.md"),
            temp.path().join("dangling.md"),
        )
        .unwrap();

        let names = list_directory(temp.path(), "")
            .unwrap()
            .into_iter()
            .map(|entry| entry.name)
            .collect::<Vec<_>>();
        assert!(names.contains(&"inside.md".to_string()));
        assert!(names.contains(&"alias.md".to_string()));
        assert!(!names.contains(&"escape.txt".to_string()));
        assert!(!names.contains(&"dangling.md".to_string()));
    }

    #[test]
    fn path_resolution_rejects_traversal_and_symlink_escape() {
        let temp = tempdir().unwrap();
        assert!(resolve_new_path(temp.path(), "../escape.md")
            .unwrap_err()
            .contains("inside"));
        assert!(resolve_existing(temp.path(), "/tmp")
            .unwrap_err()
            .contains("inside"));
    }

    #[test]
    fn create_and_rename_refuse_overwrites() {
        let temp = tempdir().unwrap();
        let created = create_entry(temp.path(), "notes.md", false).unwrap();
        assert_eq!(created.relative_path, "notes.md");
        let folder = create_entry(temp.path(), "docs", true).unwrap();
        assert!(folder.is_directory);
        assert!(create_entry(temp.path(), "notes.md", false)
            .unwrap_err()
            .contains("already exists"));
        fs::write(temp.path().join("taken.md"), "occupied").unwrap();

        assert!(rename_entry(temp.path(), "notes.md", "taken.md")
            .unwrap_err()
            .contains("already exists"));
        let renamed = rename_entry(temp.path(), "notes.md", "ideas.md").unwrap();
        assert_eq!(renamed.relative_path, "ideas.md");
        assert_eq!(
            validate_name("../moved.md").unwrap_err(),
            "A name cannot contain folder separators."
        );
    }

    #[test]
    fn move_relocates_into_and_out_of_subfolders() {
        let temp = tempdir().unwrap();
        fs::create_dir(temp.path().join("docs")).unwrap();
        fs::write(temp.path().join("notes.md"), "n").unwrap();

        let moved = move_entry(temp.path(), "notes.md", "docs").unwrap();
        assert_eq!(moved.relative_path, "docs/notes.md");
        assert!(temp.path().join("docs/notes.md").exists());
        assert!(!temp.path().join("notes.md").exists());

        let back = move_entry(temp.path(), "docs/notes.md", "").unwrap();
        assert_eq!(back.relative_path, "notes.md");
        assert!(temp.path().join("notes.md").exists());
    }

    #[test]
    fn move_refuses_overwrites_and_keeps_same_parent_a_no_op() {
        let temp = tempdir().unwrap();
        fs::create_dir(temp.path().join("docs")).unwrap();
        fs::write(temp.path().join("notes.md"), "root").unwrap();
        fs::write(temp.path().join("docs/notes.md"), "taken").unwrap();

        assert!(move_entry(temp.path(), "notes.md", "docs")
            .unwrap_err()
            .contains("already exists"));
        assert_eq!(
            fs::read_to_string(temp.path().join("docs/notes.md")).unwrap(),
            "taken"
        );

        let unchanged = move_entry(temp.path(), "notes.md", "").unwrap();
        assert_eq!(unchanged.relative_path, "notes.md");
        assert!(temp.path().join("notes.md").exists());
    }

    #[test]
    fn move_rejects_folders_into_themselves_and_bad_destinations() {
        let temp = tempdir().unwrap();
        fs::create_dir_all(temp.path().join("docs/deep")).unwrap();
        fs::write(temp.path().join("plain.md"), "p").unwrap();

        assert!(move_entry(temp.path(), "docs", "docs")
            .unwrap_err()
            .contains("itself"));
        assert!(move_entry(temp.path(), "docs", "docs/deep")
            .unwrap_err()
            .contains("itself"));
        assert!(move_entry(temp.path(), "plain.md", "plain.md")
            .unwrap_err()
            .contains("not a folder"));
        assert!(move_entry(temp.path(), "", "docs")
            .unwrap_err()
            .contains("workspace root"));
    }

    #[test]
    fn duplicate_names_are_deterministic_and_preserve_extensions() {
        let temp = tempdir().unwrap();
        let source = temp.path().join("brief.final.md");
        fs::write(&source, "one").unwrap();
        assert_eq!(
            duplicate_destination(&source).unwrap().file_name().unwrap(),
            "brief.final copy.md"
        );
        fs::write(temp.path().join("brief.final copy.md"), "two").unwrap();
        assert_eq!(
            duplicate_destination(&source).unwrap().file_name().unwrap(),
            "brief.final copy 2.md"
        );
        let duplicated = duplicate_entry(temp.path(), "brief.final.md").unwrap();
        assert_eq!(duplicated.relative_path, "brief.final copy 2.md");
        assert_eq!(fs::read_to_string(duplicated.path).unwrap(), "one");
    }

    #[test]
    fn import_copies_files_and_folders_into_a_subfolder() {
        let temp = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::create_dir(temp.path().join("docs")).unwrap();
        fs::write(outside.path().join("brief.md"), "brief").unwrap();
        fs::create_dir_all(outside.path().join("assets/deep")).unwrap();
        fs::write(outside.path().join("assets/deep/logo.svg"), "svg").unwrap();

        let report = import_entries(
            temp.path(),
            "docs",
            &[
                outside
                    .path()
                    .join("brief.md")
                    .to_string_lossy()
                    .to_string(),
                outside.path().join("assets").to_string_lossy().to_string(),
            ],
        )
        .unwrap();

        assert_eq!(
            report
                .entries
                .iter()
                .map(|entry| entry.relative_path.as_str())
                .collect::<Vec<_>>(),
            ["docs/brief.md", "docs/assets"]
        );
        assert_eq!(report.skipped_links, 0);
        assert_eq!(
            fs::read_to_string(temp.path().join("docs/brief.md")).unwrap(),
            "brief"
        );
        assert_eq!(
            fs::read_to_string(temp.path().join("docs/assets/deep/logo.svg")).unwrap(),
            "svg"
        );
        // The source stays where it was dropped from.
        assert!(outside.path().join("brief.md").exists());
    }

    #[test]
    fn import_keeps_existing_files_by_renaming_the_arrival() {
        let temp = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::write(temp.path().join("notes.md"), "mine").unwrap();
        fs::write(outside.path().join("notes.md"), "theirs").unwrap();
        let source = outside
            .path()
            .join("notes.md")
            .to_string_lossy()
            .to_string();

        let report = import_entries(temp.path(), "", slice::from_ref(&source)).unwrap();
        assert_eq!(report.entries[0].relative_path, "notes copy.md");
        let again = import_entries(temp.path(), "", &[source]).unwrap();
        assert_eq!(again.entries[0].relative_path, "notes copy 2.md");
        assert_eq!(
            fs::read_to_string(temp.path().join("notes.md")).unwrap(),
            "mine"
        );
    }

    #[test]
    fn import_fails_the_whole_call_only_for_batch_level_problems() {
        let temp = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::create_dir(temp.path().join("docs")).unwrap();
        let source = outside.path().to_string_lossy().to_string();

        assert!(
            import_entries(temp.path(), "../escape", slice::from_ref(&source))
                .unwrap_err()
                .contains("inside")
        );
        assert!(import_entries(temp.path(), "", &[])
            .unwrap_err()
            .contains("dropped"));
    }

    #[test]
    fn import_reports_a_bad_source_without_discarding_the_rest_of_the_drop() {
        let temp = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::create_dir(temp.path().join("docs")).unwrap();
        fs::write(outside.path().join("good.md"), "good").unwrap();

        let report = import_entries(
            temp.path(),
            "docs",
            &[
                "relative/path.md".into(),
                outside.path().join("good.md").to_string_lossy().to_string(),
                outside.path().join("gone.md").to_string_lossy().to_string(),
                // Dropping the workspace itself onto one of its own folders.
                temp.path().to_string_lossy().to_string(),
            ],
        )
        .unwrap();

        assert_eq!(
            report
                .entries
                .iter()
                .map(|entry| entry.relative_path.as_str())
                .collect::<Vec<_>>(),
            ["docs/good.md"]
        );
        assert_eq!(report.failures.len(), 3);
        assert!(report.failures[0].contains("full path"));
        assert!(report.failures[1].contains("could not be read"));
        assert!(report.failures[2].contains("itself"));
        assert!(temp.path().join("docs/good.md").exists());
    }

    #[cfg(unix)]
    #[test]
    fn import_leaves_no_half_copied_folder_when_a_copy_fails() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::create_dir_all(outside.path().join("bundle/locked")).unwrap();
        fs::write(outside.path().join("bundle/readable.txt"), "fine").unwrap();
        fs::write(outside.path().join("bundle/locked/secret.txt"), "no").unwrap();
        // An unreadable subdirectory fails the copy part-way through.
        fs::set_permissions(
            outside.path().join("bundle/locked"),
            fs::Permissions::from_mode(0o000),
        )
        .unwrap();

        let report = import_entries(
            temp.path(),
            "",
            &[outside.path().join("bundle").to_string_lossy().to_string()],
        )
        .unwrap();

        assert!(report.entries.is_empty());
        assert_eq!(report.failures.len(), 1);
        assert!(!temp.path().join("bundle").exists());

        fs::set_permissions(
            outside.path().join("bundle/locked"),
            fs::Permissions::from_mode(0o755),
        )
        .unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn import_skips_symlinks_inside_folders_and_follows_a_dropped_one() {
        use std::os::unix::fs::symlink;

        let temp = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::create_dir(outside.path().join("bundle")).unwrap();
        fs::write(outside.path().join("bundle/real.txt"), "real").unwrap();
        fs::write(outside.path().join("target.txt"), "target").unwrap();
        symlink(
            outside.path().join("target.txt"),
            outside.path().join("bundle/alias.txt"),
        )
        .unwrap();
        symlink(
            outside.path().join("bundle"),
            outside.path().join("bundle-alias"),
        )
        .unwrap();

        let report = import_entries(
            temp.path(),
            "",
            &[outside.path().join("bundle").to_string_lossy().to_string()],
        )
        .unwrap();
        assert_eq!(report.skipped_links, 1);
        assert!(temp.path().join("bundle/real.txt").exists());
        assert!(!temp.path().join("bundle/alias.txt").exists());

        // A dropped alias imports what it points at, under the alias's name.
        let followed = import_entries(
            temp.path(),
            "",
            &[outside
                .path()
                .join("bundle-alias")
                .to_string_lossy()
                .to_string()],
        )
        .unwrap();
        assert_eq!(followed.entries[0].relative_path, "bundle copy");
        assert!(temp.path().join("bundle copy/real.txt").exists());
    }

    #[test]
    fn trash_validation_deduplicates_and_protects_the_workspace_root() {
        let temp = tempdir().unwrap();
        fs::write(temp.path().join("one.md"), "one").unwrap();
        let path = temp.path().join("one.md").to_string_lossy().to_string();
        let targets = validate_trash_targets(temp.path(), &[path.clone(), path]).unwrap();
        assert_eq!(targets.len(), 1);
        assert!(
            validate_trash_targets(temp.path(), &[temp.path().to_string_lossy().to_string()])
                .unwrap_err()
                .contains("root")
        );
    }
}
