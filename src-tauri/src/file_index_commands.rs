use crate::file_index::{
    ContentSearchReport, ContentSearchRequest, ContentSearchToken, FileFilterHit, FileIndexEntry,
    FileIndexSnapshot, FileMove, IndexRefresh, WorkspaceFileIndex,
};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{mpsc, Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Emitter};

#[derive(Default)]
pub struct FileIndexState {
    index: Mutex<Option<Arc<WorkspaceFileIndex>>>,
    watcher: Mutex<Option<RecommendedWatcher>>,
}

impl FileIndexState {
    pub(crate) fn index(&self) -> Result<Arc<WorkspaceFileIndex>, String> {
        self.index
            .lock()
            .map_err(|error| error.to_string())?
            .clone()
            .ok_or_else(|| "No workspace file index is open.".into())
    }
}

#[tauri::command]
pub async fn file_index_open(
    app: AppHandle,
    state: tauri::State<'_, FileIndexState>,
    workspace: String,
) -> Result<FileIndexSnapshot, String> {
    let index = tauri::async_runtime::spawn_blocking(move || WorkspaceFileIndex::open(workspace))
        .await
        .map_err(|error| format!("File index task failed: {error}"))?
        .map_err(|error| error.to_string())?;
    let files = index.files();
    let index = Arc::new(index);
    let watcher = match watch_workspace(index.clone(), app) {
        Ok(watcher) => Some(watcher),
        Err(error) => {
            log::warn!("Workspace file watching is unavailable: {error}");
            None
        }
    };
    *state.index.lock().map_err(|error| error.to_string())? = Some(index);
    *state.watcher.lock().map_err(|error| error.to_string())? = watcher;
    Ok(files)
}

#[tauri::command]
pub async fn file_index_files(
    state: tauri::State<'_, FileIndexState>,
) -> Result<FileIndexSnapshot, String> {
    let index = state.index()?;
    tauri::async_runtime::spawn_blocking(move || index.files())
        .await
        .map_err(|error| format!("File index task failed: {error}"))
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceChanged {
    report: IndexRefresh,
    paths: Vec<String>,
    replace_all: bool,
    files: Vec<FileIndexEntry>,
    /// Files recognized under a new path (same filesystem identity): external
    /// moves the renderer must reconcile into open editor buffers.
    moves: Vec<FileMove>,
}

fn watch_workspace(
    index: Arc<WorkspaceFileIndex>,
    app: AppHandle,
) -> Result<RecommendedWatcher, String> {
    let root = index.workspace();
    let event_root = root.clone();
    let (sender, receiver) = mpsc::channel::<Vec<PathBuf>>();
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
        let Ok(event) = result else {
            return;
        };
        let paths: Vec<_> = event
            .paths
            .into_iter()
            .filter(|path| !ignored_watch_path(&event_root, path))
            .collect();
        if !paths.is_empty() {
            let _ = sender.send(paths);
        }
    })
    .map_err(|error| error.to_string())?;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|error| error.to_string())?;

    std::thread::Builder::new()
        .name("mimir-workspace-watch".into())
        .spawn(move || {
            while let Ok(first) = receiver.recv() {
                let mut changed = first;
                loop {
                    match receiver.recv_timeout(Duration::from_millis(110)) {
                        Ok(paths) => changed.extend(paths),
                        Err(mpsc::RecvTimeoutError::Timeout) => break,
                        Err(mpsc::RecvTimeoutError::Disconnected) => return,
                    }
                }
                let mut seen = HashSet::new();
                changed.retain(|path| seen.insert(path.clone()));
                match index.refresh_paths(&changed) {
                    Ok((report, moves)) => {
                        // Ordinary content edits only replace metadata for the
                        // touched files. Structural changes are rarer and send
                        // one authoritative snapshot to preserve ignore and
                        // rename semantics.
                        let replace_all = report.added > 0 || report.removed > 0;
                        let files = if replace_all {
                            // Structural changes are rare enough that an owned
                            // copy of the snapshot is fine here.
                            index.files().to_entries()
                        } else {
                            index.files_for_paths(&changed)
                        };
                        let payload = WorkspaceChanged {
                            report,
                            paths: changed
                                .iter()
                                .map(|path| path.to_string_lossy().into_owned())
                                .collect(),
                            replace_all,
                            files,
                            moves,
                        };
                        let _ = app.emit("mimir://workspace-files-changed", payload);
                    }
                    Err(error) => log::warn!("Workspace refresh after file change failed: {error}"),
                }
            }
        })
        .map_err(|error| error.to_string())?;

    Ok(watcher)
}

fn ignored_watch_path(root: &Path, path: &Path) -> bool {
    const NOISE: &[&str] = &[
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
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .filter_map(|component| component.as_os_str().to_str())
        .any(|component| NOISE.contains(&component))
}

#[tauri::command]
pub async fn file_index_filter(
    state: tauri::State<'_, FileIndexState>,
    query: String,
    max_results: Option<usize>,
) -> Result<Vec<FileFilterHit>, String> {
    let index = state.index()?;
    tauri::async_runtime::spawn_blocking(move || index.filter_files(&query, max_results))
        .await
        .map_err(|error| format!("File filter task failed: {error}"))
}

#[tauri::command]
pub async fn file_index_refresh(
    state: tauri::State<'_, FileIndexState>,
) -> Result<IndexRefresh, String> {
    let index = state.index()?;
    tauri::async_runtime::spawn_blocking(move || index.refresh())
        .await
        .map_err(|error| format!("File index refresh task failed: {error}"))?
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn file_index_begin_search(
    state: tauri::State<'_, FileIndexState>,
) -> Result<ContentSearchToken, String> {
    Ok(state.index()?.begin_content_search())
}

#[tauri::command]
pub fn file_index_cancel_search(
    state: tauri::State<'_, FileIndexState>,
    token: ContentSearchToken,
) -> Result<bool, String> {
    Ok(state.index()?.cancel_content_search(token))
}

#[tauri::command]
pub async fn file_index_search(
    state: tauri::State<'_, FileIndexState>,
    token: ContentSearchToken,
    request: ContentSearchRequest,
) -> Result<ContentSearchReport, String> {
    let index = state.index()?;
    tauri::async_runtime::spawn_blocking(move || index.search_content(token, &request))
        .await
        .map_err(|error| format!("File content search task failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_state_reports_missing_workspace() {
        let state = FileIndexState::default();
        assert_eq!(
            state.index().unwrap_err(),
            "No workspace file index is open."
        );
    }
}
