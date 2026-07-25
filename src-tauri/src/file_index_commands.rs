use crate::file_index::{
    ContentSearchReport, ContentSearchRequest, ContentSearchToken, FileFilterHit, FileIndexEntry,
    IndexRefresh, WorkspaceFileIndex,
};
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub struct FileIndexState(Mutex<Option<Arc<WorkspaceFileIndex>>>);

impl FileIndexState {
    fn index(&self) -> Result<Arc<WorkspaceFileIndex>, String> {
        self.0
            .lock()
            .map_err(|error| error.to_string())?
            .clone()
            .ok_or_else(|| "No workspace file index is open.".into())
    }
}

#[tauri::command]
pub async fn file_index_open(
    state: tauri::State<'_, FileIndexState>,
    workspace: String,
) -> Result<Vec<FileIndexEntry>, String> {
    let index = tauri::async_runtime::spawn_blocking(move || WorkspaceFileIndex::open(workspace))
        .await
        .map_err(|error| format!("File index task failed: {error}"))?
        .map_err(|error| error.to_string())?;
    let files = index.files();
    *state.0.lock().map_err(|error| error.to_string())? = Some(Arc::new(index));
    Ok(files)
}

#[tauri::command]
pub fn file_index_files(
    state: tauri::State<'_, FileIndexState>,
) -> Result<Vec<FileIndexEntry>, String> {
    Ok(state.index()?.files())
}

#[tauri::command]
pub fn file_index_filter(
    state: tauri::State<'_, FileIndexState>,
    query: String,
    max_results: Option<usize>,
) -> Result<Vec<FileFilterHit>, String> {
    Ok(state.index()?.filter_files(&query, max_results))
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
