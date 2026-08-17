use base64::Engine;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs, path::PathBuf};
use tauri::{Emitter, Manager};

#[derive(Debug, Clone, PartialEq, Eq)]
enum WindowlessMeetingQuit {
    Allow,
    Stop(String),
    RestoreForInspectionFailure,
}

fn windowless_meeting_quit(active_meeting_id: Result<Option<String>, ()>) -> WindowlessMeetingQuit {
    match active_meeting_id {
        Ok(Some(meeting_id)) => WindowlessMeetingQuit::Stop(meeting_id),
        Ok(None) => WindowlessMeetingQuit::Allow,
        Err(()) => WindowlessMeetingQuit::RestoreForInspectionFailure,
    }
}

fn finish_windowless_meeting_quit(
    quit: WindowlessMeetingQuit,
    stop: impl FnOnce(&str) -> Result<(), String>,
) -> Result<(), String> {
    match quit {
        WindowlessMeetingQuit::Stop(meeting_id) => stop(&meeting_id),
        WindowlessMeetingQuit::RestoreForInspectionFailure => {
            Err("native meeting state could not be inspected".to_string())
        }
        WindowlessMeetingQuit::Allow => Ok(()),
    }
}

fn guard_windowless_meeting_quit(
    quit: WindowlessMeetingQuit,
    prevent_exit: impl FnOnce(),
    restore_window: impl FnOnce() -> Result<(), String>,
) -> Option<(WindowlessMeetingQuit, Option<String>)> {
    if quit == WindowlessMeetingQuit::Allow {
        return None;
    }
    prevent_exit();
    let restore_error = restore_window().err();
    Some((quit, restore_error))
}

fn complete_windowless_meeting_quit(
    quit: WindowlessMeetingQuit,
    stop: impl FnOnce(&str) -> Result<(), String>,
    exit: impl FnOnce(),
    keep_open: impl FnOnce(String),
) {
    match finish_windowless_meeting_quit(quit, stop) {
        Ok(()) => exit(),
        Err(error) => keep_open(error),
    }
}

pub mod activities;
mod activity_commands;
pub mod agent_packages;
mod ai;
mod ai_keys;
mod ai_models;
mod ai_providers;
mod ai_proxy;
mod ai_transport;
mod ai_usage;
mod apps;
pub mod business_graph;
pub mod chat;
mod connections;
pub mod file_index;
mod file_index_commands;
mod file_open;
mod git;
#[cfg(test)]
mod ipc_fixtures;
mod launchers;
mod local_settings;
pub mod meetings;
pub mod mimir_cli;
mod persistence;
pub mod routine_runtime;
pub mod routines;
mod session;
mod shell_exec;
pub mod tool_bridge;
pub mod tool_registry;
mod tool_runtime;
pub mod tool_server;
pub mod tracker;
#[cfg(test)]
mod upgrade_fixtures;
mod workspace_files;

#[cfg(target_os = "macos")]
fn enable_macos_spellcheck() {
    use objc2_foundation::{NSString, NSUserDefaults};
    let defaults = NSUserDefaults::standardUserDefaults();
    let key = NSString::from_str("WebContinuousSpellCheckingEnabled");
    defaults.setBool_forKey(true, &key);
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn spell_suggest(word: String) -> Vec<String> {
    use objc2_app_kit::NSSpellChecker;
    use objc2_foundation::{NSRange, NSString};

    let checker = NSSpellChecker::sharedSpellChecker();
    let ns_word = NSString::from_str(&word);

    let bad = checker.checkSpellingOfString_startingAt(&ns_word, 0);
    if bad.length == 0 {
        return vec![];
    }

    let range = NSRange::new(0, ns_word.len());
    let guesses = checker
        .guessesForWordRange_inString_language_inSpellDocumentWithTag(range, &ns_word, None, 0);

    match guesses {
        Some(arr) => {
            let mut out = Vec::new();
            for i in 0..arr.count() {
                let s = arr.objectAtIndex(i);
                out.push(s.to_string());
            }
            out
        }
        None => vec![],
    }
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn spell_suggest(_word: String) -> Vec<String> {
    vec![]
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ReadTextResponse {
    path: String,
    content: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
}

#[tauri::command]
fn read_text_file(path: String) -> Result<ReadTextResponse, String> {
    let path_buf = PathBuf::from(&path);
    let content =
        fs::read_to_string(&path_buf).map_err(|err| format!("Could not read {}: {}", path, err))?;
    Ok(ReadTextResponse { path, content })
}

#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    persistence::write_bytes_atomic(&path_buf, content.as_bytes())
        .map_err(|err| format!("Could not write {}: {}", path, err))
}

#[tauri::command]
fn read_binary_file(path: String) -> Result<tauri::ipc::Response, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("Could not read {}: {}", path, e))?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
fn write_binary_file(path: String, data_base64: String) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data_base64)
        .map_err(|e| format!("Invalid base64: {}", e))?;
    let path_buf = PathBuf::from(&path);
    persistence::write_bytes_atomic(&path_buf, &bytes)
        .map_err(|err| format!("Could not write {}: {}", path, err))
}

#[tauri::command]
fn path_exists(path: String) -> bool {
    PathBuf::from(path).exists()
}

#[tauri::command]
fn create_dir(path: String) -> Result<(), String> {
    fs::create_dir_all(&path).map_err(|e| format!("Could not create {}: {}", path, e))
}

#[tauri::command]
fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let read = fs::read_dir(&path).map_err(|e| format!("Could not read {}: {}", path, e))?;
    let mut entries = Vec::new();
    for item in read {
        let item = item.map_err(|e| e.to_string())?;
        let meta = item.metadata().map_err(|e| e.to_string())?;
        entries.push(DirEntry {
            name: item.file_name().to_string_lossy().to_string(),
            path: item.path().to_string_lossy().to_string(),
            is_dir: meta.is_dir(),
        });
    }
    Ok(entries)
}

#[tauri::command]
fn reveal_in_finder(path: String) -> Result<(), String> {
    let _p = std::path::Path::new(&path);

    #[cfg(target_os = "macos")]
    {
        let mut command = std::process::Command::new("open");
        if _p.is_dir() {
            command.arg(&path);
        } else {
            command.arg("-R").arg(&path);
        }
        command
            .spawn()
            .map_err(|e| format!("Failed to reveal in Finder: {}", e))?;
        return Ok(());
    }

    #[cfg(target_os = "linux")]
    {
        let dir = if _p.is_dir() {
            &path
        } else {
            _p.parent()
                .map(|pp| pp.to_str().unwrap_or(&path))
                .unwrap_or(&path)
        };
        let _ = std::process::Command::new("xdg-open").arg(dir).spawn();
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg("/select,")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to reveal in Explorer: {}", e))?;
        return Ok(());
    }

    #[allow(unreachable_code)]
    Ok(())
}

// ---- Shared proposal coordinator ----

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EditorProposalDocument {
    path: String,
    dirty: bool,
    active: bool,
}

/// Shared handle to one proposal. Cloning copies a pointer, so store
/// snapshots taken for command replies and event broadcasts stay cheap, and
/// transparent serialization keeps the renderer-visible JSON identical to a
/// plain `serde_json::Value`.
#[derive(Clone, Debug)]
struct SharedProposal(std::sync::Arc<serde_json::Value>);

impl SharedProposal {
    fn new(value: serde_json::Value) -> Self {
        Self(std::sync::Arc::new(value))
    }
}

impl std::ops::Deref for SharedProposal {
    type Target = serde_json::Value;

    fn deref(&self) -> &serde_json::Value {
        &self.0
    }
}

impl Serialize for SharedProposal {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(serializer)
    }
}

#[derive(Default)]
struct ProposalStore {
    proposals: Vec<SharedProposal>,
    editor_documents: HashMap<String, Vec<EditorProposalDocument>>,
}

struct ProposalState(std::sync::Mutex<ProposalStore>);
impl Default for ProposalState {
    fn default() -> Self {
        Self(std::sync::Mutex::new(ProposalStore::default()))
    }
}

impl ProposalState {
    /// Restores undecided proposals from disk so an application restart does
    /// not lose a review the user has not answered yet.
    fn load() -> Self {
        let proposals = proposals_path()
            .map(|path| load_proposals_at(&path))
            .unwrap_or_default();
        Self(std::sync::Mutex::new(ProposalStore {
            proposals,
            editor_documents: HashMap::new(),
        }))
    }
}

fn proposals_path() -> Result<PathBuf, String> {
    Ok(ai_models::app_config_dir()?.join("proposals.json"))
}

fn proposal_is_undecided(proposal: &serde_json::Value) -> bool {
    matches!(proposal_status(proposal), "pending" | "applying")
}

/// Persists every undecided proposal. `applying` is written as-is and
/// normalized back to `pending` on load, so an apply interrupted by a crash
/// is offered for review again; `apply_proposal_to_file` detects an already
/// applied change on the retry.
fn persist_proposals_at(path: &std::path::Path, proposals: &[SharedProposal]) {
    let undecided: Vec<&SharedProposal> = proposals
        .iter()
        .filter(|p| proposal_is_undecided(p))
        .collect();
    if let Err(error) = persistence::write_json_atomic(path, &undecided) {
        log::warn!("Could not persist proposals: {error}");
    }
}

fn load_proposals_at(path: &std::path::Path) -> Vec<SharedProposal> {
    let Ok(Some(values)) = persistence::load_json_optional::<Vec<serde_json::Value>>(path) else {
        return Vec::new();
    };
    values
        .into_iter()
        .filter(|p| proposal_id(p).is_some() && proposal_is_undecided(p))
        .map(|mut p| {
            if proposal_status(&p) == "applying" {
                if let Some(obj) = p.as_object_mut() {
                    obj.insert(
                        "status".to_string(),
                        serde_json::Value::String("pending".to_string()),
                    );
                }
            }
            SharedProposal::new(p)
        })
        .collect()
}

fn proposal_id(proposal: &serde_json::Value) -> Option<&str> {
    proposal.get("id").and_then(|v| v.as_str())
}

fn proposal_status(proposal: &serde_json::Value) -> &str {
    proposal
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("pending")
}

fn proposal_session_id(proposal: &serde_json::Value) -> String {
    proposal
        .get("sessionId")
        .or_else(|| proposal.get("threadId"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

fn proposal_target_path(proposal: &serde_json::Value) -> Option<String> {
    proposal
        .get("absolutePath")
        .or_else(|| proposal.get("path"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

fn upsert_proposal(
    store: &mut ProposalStore,
    mut proposal: serde_json::Value,
) -> Result<(), String> {
    let id = proposal_id(&proposal)
        .ok_or_else(|| "Proposal is missing id".to_string())?
        .to_string();
    if proposal.get("status").is_none() {
        if let Some(obj) = proposal.as_object_mut() {
            obj.insert(
                "status".to_string(),
                serde_json::Value::String("pending".to_string()),
            );
        }
    }
    let proposal = SharedProposal::new(proposal);
    if let Some(existing) = store
        .proposals
        .iter_mut()
        .find(|p| proposal_id(p) == Some(id.as_str()))
    {
        *existing = proposal;
    } else {
        store.proposals.insert(0, proposal);
    }
    Ok(())
}

fn set_proposal_status(
    store: &mut ProposalStore,
    id: &str,
    status: &str,
    detail: Option<&str>,
) -> Option<SharedProposal> {
    let proposal = store
        .proposals
        .iter_mut()
        .find(|p| proposal_id(p) == Some(id))?;
    // Live snapshots may still share this Arc; make_mut clones only this one
    // proposal in that case instead of the whole store.
    if let Some(obj) = std::sync::Arc::make_mut(&mut proposal.0).as_object_mut() {
        obj.insert(
            "status".to_string(),
            serde_json::Value::String(status.to_string()),
        );
        if let Some(detail) = detail {
            obj.insert(
                "failReason".to_string(),
                serde_json::Value::String(detail.to_string()),
            );
        } else {
            obj.remove("failReason");
        }
    }
    Some(proposal.clone())
}

fn pending_proposals(store: &ProposalStore) -> Vec<SharedProposal> {
    store
        .proposals
        .iter()
        .filter(|p| proposal_status(p) == "pending")
        .cloned()
        .collect()
}

/// Publishes a store snapshot: persists undecided proposals, then emits the
/// state events. Every store mutation routes its snapshot through here, so
/// disk and renderer always see the same lifecycle transition.
fn publish_proposal_state(app: &tauri::AppHandle, proposals: &[SharedProposal]) {
    if let Ok(path) = proposals_path() {
        persist_proposals_at(&path, proposals);
    }
    let pending: Vec<SharedProposal> = proposals
        .iter()
        .filter(|p| proposal_status(p) == "pending")
        .cloned()
        .collect();
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.emit("mimir://proposals-state", proposals);
        let _ = main.emit("mimir://proposals-changed", &pending);
    }
}

fn broadcast_proposal_result(
    app: &tauri::AppHandle,
    proposal: &serde_json::Value,
    status: &str,
    detail: &str,
) {
    if let Some(main) = app.get_webview_window("main") {
        let result = serde_json::json!({
            "id": proposal_id(proposal).unwrap_or(""),
            "sessionId": proposal_session_id(proposal),
            "status": status,
            "detail": detail,
        });
        let _ = main.emit("mimir://proposal-result", &result);
    }
}

fn count_exact(haystack: &str, needle: &str) -> usize {
    if needle.is_empty() {
        return 0;
    }
    haystack.matches(needle).count()
}

fn find_editor_owner(
    store: &ProposalStore,
    proposal: &serde_json::Value,
) -> Result<Option<(String, bool)>, String> {
    let target_path = proposal_target_path(proposal).unwrap_or_default();
    let has_absolute_target = proposal
        .get("absolutePath")
        .and_then(|v| v.as_str())
        .is_some();

    if !has_absolute_target {
        for (label, docs) in &store.editor_documents {
            if docs.iter().any(|d| d.active) {
                return Ok(Some((label.clone(), true)));
            }
        }
        return Ok(None);
    }

    let mut clean_owner = None;
    for (label, docs) in &store.editor_documents {
        for doc in docs {
            if doc.path == target_path {
                if doc.dirty && !doc.active {
                    return Err(
                        "File is open with unsaved changes in an inactive editor tab".to_string(),
                    );
                }
                if doc.dirty && doc.active {
                    return Ok(Some((label.clone(), true)));
                }
                clean_owner = Some((label.clone(), false));
            }
        }
    }
    Ok(clean_owner)
}

fn apply_proposal_to_file(
    proposal: &serde_json::Value,
) -> (String, String, Option<(String, String)>) {
    let proposal_type = proposal
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("edit");
    let path = match proposal.get("absolutePath").and_then(|v| v.as_str()) {
        Some(path) if !path.is_empty() => path.to_string(),
        _ => {
            return (
                "failed".to_string(),
                "Proposal has no absolute file path".to_string(),
                None,
            )
        }
    };
    let replacement = proposal
        .get("replacement")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    if proposal_type == "create" {
        let path_buf = PathBuf::from(&path);
        if path_buf.exists() {
            match fs::read_to_string(&path_buf) {
                Ok(existing) if existing == replacement => {
                    return (
                        "accepted".to_string(),
                        "Proposal was already applied".to_string(),
                        None,
                    );
                }
                Ok(_) => {
                    return (
                        "conflict".to_string(),
                        "File already exists with different content".to_string(),
                        None,
                    )
                }
                Err(err) => {
                    return (
                        "failed".to_string(),
                        format!("Could not read existing file: {}", err),
                        None,
                    )
                }
            }
        }
        if let Err(err) = write_text_file(path.clone(), replacement.to_string()) {
            return ("failed".to_string(), err, None);
        }
        return (
            "accepted".to_string(),
            "Change applied successfully".to_string(),
            Some((path, replacement.to_string())),
        );
    }

    let target = proposal
        .get("targetText")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if target.is_empty() {
        return (
            "failed".to_string(),
            "Edit proposal has no target text".to_string(),
            None,
        );
    }

    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(err) => {
            return (
                "failed".to_string(),
                format!("Could not read {}: {}", path, err),
                None,
            )
        }
    };

    let target_count = count_exact(&content, target);
    if target_count > 1 {
        return (
            "conflict".to_string(),
            "Target text is ambiguous in file".to_string(),
            None,
        );
    }
    if target_count == 0 {
        if count_exact(&content, replacement) == 1 {
            return (
                "accepted".to_string(),
                "Proposal was already applied".to_string(),
                None,
            );
        }
        return (
            "stale".to_string(),
            "Target text no longer found in file".to_string(),
            None,
        );
    }

    let modified = content.replacen(target, replacement, 1);
    if let Err(err) = write_text_file(path.clone(), modified.clone()) {
        return ("failed".to_string(), err, None);
    }
    (
        "accepted".to_string(),
        "Change applied successfully".to_string(),
        Some((path, modified)),
    )
}

#[tauri::command]
fn get_proposals_for_path(state: tauri::State<ProposalState>, path: String) -> Vec<SharedProposal> {
    let store = state.0.lock().unwrap_or_else(|e| e.into_inner());
    pending_proposals(&store)
        .into_iter()
        .filter(|p| {
            p.get("path").and_then(|v| v.as_str()) == Some(path.as_str())
                || p.get("absolutePath").and_then(|v| v.as_str()) == Some(path.as_str())
        })
        .collect()
}

#[tauri::command]
fn proposal_create(
    app: tauri::AppHandle,
    state: tauri::State<ProposalState>,
    proposal: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let proposals_snapshot = {
        let mut store = state.0.lock().map_err(|e| e.to_string())?;
        upsert_proposal(&mut store, proposal.clone())?;
        store.proposals.clone()
    };
    publish_proposal_state(&app, &proposals_snapshot);
    Ok(proposal)
}

#[tauri::command]
fn proposal_list(state: tauri::State<ProposalState>) -> Vec<SharedProposal> {
    let store = state.0.lock().unwrap_or_else(|e| e.into_inner());
    store.proposals.clone()
}

#[tauri::command]
fn proposal_register_editor(
    state: tauri::State<ProposalState>,
    window_label: String,
    documents: Vec<EditorProposalDocument>,
) -> Result<(), String> {
    let mut store = state.0.lock().map_err(|e| e.to_string())?;
    store.editor_documents.insert(window_label, documents);
    Ok(())
}

#[tauri::command]
fn proposal_apply(
    app: tauri::AppHandle,
    state: tauri::State<ProposalState>,
    id: String,
) -> Result<serde_json::Value, String> {
    let (proposal, owner, applying_snapshot) = {
        let mut store = state.0.lock().map_err(|e| e.to_string())?;
        let proposal = store
            .proposals
            .iter()
            .find(|p| proposal_id(p) == Some(id.as_str()))
            .cloned()
            .ok_or_else(|| format!("Unknown proposal: {}", id))?;
        let owner = match find_editor_owner(&store, &proposal) {
            Ok(owner) => owner,
            Err(detail) => {
                let updated = set_proposal_status(&mut store, &id, "conflict", Some(&detail));
                let snapshot = store.proposals.clone();
                drop(store);
                if let Some(p) = &updated {
                    broadcast_proposal_result(&app, p, "conflict", &detail);
                }
                publish_proposal_state(&app, &snapshot);
                return Ok(serde_json::json!({ "status": "conflict", "detail": detail }));
            }
        };
        set_proposal_status(&mut store, &id, "applying", None);
        (proposal, owner, store.proposals.clone())
    };
    publish_proposal_state(&app, &applying_snapshot);

    if let Some((label, should_delegate)) = owner {
        if should_delegate {
            if let Some(window) = app.get_webview_window(&label) {
                let _ = window.emit("mimir://proposal-apply", &proposal);
                return Ok(serde_json::json!({ "status": "delegated", "target": label }));
            }
            let proposals_snapshot = {
                let mut store = state.0.lock().map_err(|e| e.to_string())?;
                let updated = set_proposal_status(
                    &mut store,
                    &id,
                    "failed",
                    Some("Owning editor window is no longer available"),
                );
                if let Some(p) = &updated {
                    broadcast_proposal_result(
                        &app,
                        p,
                        "failed",
                        "Owning editor window is no longer available",
                    );
                }
                store.proposals.clone()
            };
            publish_proposal_state(&app, &proposals_snapshot);
            return Ok(serde_json::json!({ "status": "failed" }));
        }
    }

    let (status, detail, file_update) = apply_proposal_to_file(&proposal);
    let updated = {
        let mut store = state.0.lock().map_err(|e| e.to_string())?;
        let updated = set_proposal_status(
            &mut store,
            &id,
            &status,
            if status == "accepted" {
                None
            } else {
                Some(&detail)
            },
        );
        let snapshot = store.proposals.clone();
        drop(store);
        publish_proposal_state(&app, &snapshot);
        updated
    };
    if let Some((path, content)) = file_update {
        let _ = notify_file_updated(app.clone(), path, content);
    }
    if let Some(proposal) = &updated {
        let result_status = if status == "accepted" {
            "applied"
        } else {
            status.as_str()
        };
        broadcast_proposal_result(&app, proposal, result_status, &detail);
    }
    Ok(serde_json::json!({ "status": status, "detail": detail }))
}

#[tauri::command]
fn proposal_reject(
    app: tauri::AppHandle,
    state: tauri::State<ProposalState>,
    id: String,
) -> Result<(), String> {
    let (updated, proposals_snapshot) = {
        let mut store = state.0.lock().map_err(|e| e.to_string())?;
        let updated = set_proposal_status(&mut store, &id, "rejected", None);
        (updated, store.proposals.clone())
    };
    if let Some(proposal) = &updated {
        broadcast_proposal_result(&app, proposal, "rejected", "User rejected the change");
    }
    publish_proposal_state(&app, &proposals_snapshot);
    Ok(())
}

#[tauri::command]
fn proposal_respond(
    app: tauri::AppHandle,
    state: tauri::State<ProposalState>,
    result: serde_json::Value,
) -> Result<(), String> {
    let id = result.get("id").and_then(|v| v.as_str()).unwrap_or("");
    let incoming_status = result
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("failed");
    let detail = result
        .get("detail")
        .and_then(|v| v.as_str())
        .unwrap_or("Proposal response received");
    let central_status = match incoming_status {
        "applied" => "accepted",
        "rejected" => "rejected",
        "not-found" => "stale",
        "stale" => "stale",
        "conflict" => "conflict",
        _ => "failed",
    };
    let proposals_snapshot = {
        let mut store = state.0.lock().map_err(|e| e.to_string())?;
        if !id.is_empty() {
            set_proposal_status(
                &mut store,
                id,
                central_status,
                if central_status == "accepted" || central_status == "rejected" {
                    None
                } else {
                    Some(detail)
                },
            );
        }
        store.proposals.clone()
    };
    publish_proposal_state(&app, &proposals_snapshot);
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.emit("mimir://proposal-result", &result);
    }
    Ok(())
}

#[tauri::command]
fn notify_file_updated(app: tauri::AppHandle, path: String, content: String) -> Result<(), String> {
    let payload = serde_json::json!({ "path": path, "content": content });
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.emit("mimir://file-updated", &payload);
    }
    Ok(())
}

fn create_main_window<M: Manager<tauri::Wry>>(
    manager: &M,
    visible: bool,
) -> tauri::Result<tauri::WebviewWindow> {
    let builder =
        tauri::WebviewWindowBuilder::new(manager, "main", tauri::WebviewUrl::App("/".into()))
            .title("Mimir")
            .inner_size(1280.0, 800.0)
            .min_inner_size(520.0, 420.0)
            .decorations(true)
            .visible(visible);

    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::Position::Logical(tauri::LogicalPosition::new(
            14.0, 14.0,
        )));

    let window = builder.build()?;

    // Apply the saved interface zoom before the first paint so startup does
    // not flash at 100%; the renderer settings store owns it from then on.
    let zoom = local_settings::initial_workbench_zoom_factor();
    if (zoom - 1.0).abs() > f64::EPSILON {
        let _ = window.set_zoom(zoom);
    }

    Ok(window)
}

#[tauri::command]
fn settings_changed(window: tauri::WebviewWindow) -> Result<(), String> {
    let caller = window.label().to_string();
    for (label, w) in window.app_handle().webview_windows() {
        if label != caller {
            let _ = w.emit("mimir://settings-changed", ());
        }
    }
    Ok(())
}

#[tauri::command]
fn app_quit_confirmed(
    app: tauri::AppHandle,
    meetings: tauri::State<'_, meetings::runtime::MeetingRuntime>,
) -> Result<(), String> {
    stop_active_meeting(meetings.inner())?;
    app.exit(0);
    Ok(())
}

#[tauri::command]
fn app_prepare_relaunch(
    meetings: tauri::State<'_, meetings::runtime::MeetingRuntime>,
) -> Result<(), String> {
    stop_active_meeting(meetings.inner())
}

fn stop_active_meeting(meetings: &meetings::runtime::MeetingRuntime) -> Result<(), String> {
    if let Some(meeting_id) = meetings
        .snapshot()
        .map_err(|error| error.to_string())?
        .active_meeting_id
    {
        meetings
            .stop(&meeting_id)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn run() {
    let tool_registry = tool_registry::ToolRegistry::default();
    let tool_runtime = tool_runtime::ToolRuntime::new(tool_registry.clone());
    let connection_manager = connections::ConnectionManager::new(tool_registry.clone())
        .expect("connection manager must initialize");
    let chat_runtime = chat::ChatRuntime::new().expect("chat runtime must initialize");
    let activity_supervisor =
        activities::ActivitySupervisor::new(activities::ActivitySupervisorConfig::default())
            .expect("activity supervisor must initialize");
    let routine_runtime = routine_runtime::RoutineRuntime::new(
        routine_runtime::RoutineRuntimeConfig::default(),
        activity_supervisor.clone(),
    )
    .expect("routine runtime must initialize");
    let tracker_runtime =
        tracker::TrackerRuntimeState::new(tracker::TrackerRuntimeConfig::default());

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--mimir-tracker-background"]),
        ))
        .register_uri_scheme_protocol("app", |_app, request| apps::serve_app_file(request))
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            let paths = file_open::resolve_file_args(&args, std::path::Path::new(&cwd));
            file_open::do_open_files_in_editor(app, paths);
        }))
        .manage(ProposalState::load())
        .manage(activity_supervisor)
        .manage(routine_runtime)
        .manage(tracker_runtime)
        .manage(ai_proxy::AiStreamState::default())
        .manage(business_graph::GraphRuntime::default())
        .manage(file_open::PendingFilePaths::default())
        .manage(file_index_commands::FileIndexState::default())
        .manage(tool_server::ToolServerState::default())
        .manage(tool_registry)
        .manage(tool_runtime)
        .manage(connection_manager)
        .manage(chat_runtime)
        .manage(meetings::commands::MeetingStartConsentAuthority::default())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            enable_macos_spellcheck();

            mimir_cli::install().map_err(std::io::Error::other)?;
            let meeting_engine =
                meetings::native::bootstrap_native_meeting_engine_for_user(app.handle())
                    .map_err(std::io::Error::other)?;
            let meeting_runtime = meeting_engine.runtime();
            let meeting_transcription = meeting_engine.transcription_port();
            let meeting_paths = meeting_engine.paths();
            if !app.manage(meeting_runtime.clone()) {
                return Err(
                    std::io::Error::other("Scribe meeting runtime was already registered").into(),
                );
            }
            if !app.manage(meeting_engine) {
                return Err(std::io::Error::other(
                    "Scribe native lifecycle was already registered",
                )
                .into());
            }
            let background_launch = std::env::args()
                .any(|argument| argument == "--mimir-tracker-background")
                && app
                    .state::<tracker::TrackerRuntimeState>()
                    .background_launch_enabled();
            create_main_window(app, !background_launch)?;
            let supervisor = app.state::<activities::ActivitySupervisor>();
            activity_commands::TauriActivitySink::install(app.handle(), &supervisor);
            let routines = app.state::<routine_runtime::RoutineRuntime>();
            routine_runtime::TauriRoutineSink::install(app.handle(), &routines);
            routines.start().map_err(std::io::Error::other)?;
            let meeting_jobs = meetings::jobs::MeetingJobWorker::start(
                meeting_runtime,
                meeting_transcription,
                routines.inner().clone(),
                supervisor.inner().clone(),
                meeting_paths,
            )
            .map_err(std::io::Error::other)?;
            if !app.manage(meeting_jobs) {
                return Err(std::io::Error::other(
                    "Scribe follow-up worker was already registered",
                )
                .into());
            }
            if let Err(error) = app
                .state::<tracker::TrackerRuntimeState>()
                .install(app.handle())
            {
                log::error!(
                    "Tracker could not install; Mimir will continue without collection: {error}"
                );
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.show();
                    let _ = main.set_focus();
                }
            }
            app.state::<tool_runtime::ToolRuntime>()
                .initialize(app.handle())
                .map_err(std::io::Error::other)?;
            app.state::<connections::ConnectionManager>()
                .install()
                .map_err(std::io::Error::other)?;
            app.state::<chat::ChatRuntime>()
                .install(
                    app.handle(),
                    app.state::<tool_registry::ToolRegistry>().inner(),
                )
                .map_err(std::io::Error::other)?;

            let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
            let cli_files =
                file_open::resolve_file_args(&std::env::args().collect::<Vec<_>>(), &cwd);
            if !cli_files.is_empty() {
                let state = app.state::<file_open::PendingFilePaths>();
                state.0.lock().unwrap().extend(cli_files);
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let app = window.app_handle().clone();
                let window_id = window.label().to_string();
                let audio_tests = app
                    .state::<meetings::native::NativeMeetingEngine>()
                    .audio_tests();
                let audio_window_id = window_id.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    if let Err(error) = audio_tests.stop_window(&audio_window_id) {
                        log::error!("Could not stop Scribe audio check for destroyed window: {error}");
                    }
                });
                tauri::async_runtime::spawn(async move {
                    app.state::<tool_runtime::ToolRuntime>()
                        .disconnect_window(&window_id)
                        .await;
                    if window_id == "main" {
                        tool_server::shutdown_all(
                            app.state::<tool_server::ToolServerState>().inner(),
                        )
                        .await;
                    }
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            ai::ai_config_dir,
            ai::ai_model_registry,
            ai::ai_key_status,
            ai::ai_set_api_key,
            ai::ai_generate,
            ai_proxy::ai_proxy_stream,
            ai_proxy::ai_abort,
            ai_proxy::ai_cleanup,
            session::session_load,
            session::session_save,
            local_settings::settings_load,
            local_settings::settings_save,
            local_settings::settings_save_editor,
            connections::connections_status,
            connections::connections_connect_google,
            connections::connections_connect_slack,
            connections::connections_connect_slack_token,
            connections::connections_connect_granola,
            connections::connections_disconnect,
            connections::connections_set_google_default,
            read_text_file,
            read_binary_file,
            write_text_file,
            write_binary_file,
            path_exists,
            create_dir,
            list_dir,
            business_graph::runtime::graph_open,
            business_graph::runtime::graph_status,
            business_graph::runtime::graph_get,
            business_graph::runtime::graph_query,
            business_graph::runtime::graph_search,
            business_graph::runtime::graph_neighbors,
            business_graph::runtime::graph_diagnostics,
            business_graph::runtime::graph_events,
            business_graph::runtime::graph_migration_report,
            business_graph::runtime::graph_context,
            business_graph::runtime::graph_refresh,
            business_graph::runtime::graph_update,
            business_graph::runtime::graph_create,
            business_graph::runtime::graph_delete,
            business_graph::runtime::graph_restore,
            git::git_status,
            git::git_changes,
            git::git_file_diff,
            git::git_stage_file,
            git::git_unstage_file,
            get_proposals_for_path,
            proposal_create,
            proposal_list,
            proposal_register_editor,
            proposal_apply,
            proposal_reject,
            proposal_respond,
            notify_file_updated,
            settings_changed,
            app_quit_confirmed,
            app_prepare_relaunch,
            meetings::commands::meetings_snapshot,
            meetings::commands::meetings_library_page,
            meetings::commands::meetings_search_library,
            meetings::commands::meetings_transcript_page,
            meetings::commands::meetings_request_microphone_permission,
            meetings::commands::meetings_request_system_audio_permission,
            meetings::commands::meetings_open_system_audio_settings,
            meetings::commands::meetings_check_audio,
            meetings::commands::meetings_microphone_devices,
            meetings::commands::meetings_audio_test_start,
            meetings::commands::meetings_audio_test_stop,
            meetings::commands::meetings_dismiss_candidate,
            meetings::commands::meetings_issue_start_consent,
            meetings::commands::meetings_start,
            meetings::commands::meetings_stop,
            meetings::commands::meetings_set_mic_muted,
            meetings::commands::meetings_update,
            meetings::commands::meetings_decide_kg,
            meetings::commands::meetings_retry_job,
            meetings::commands::meetings_run_summary,
            meetings::commands::meetings_follow_up_context,
            meetings::commands::meetings_retranscribe,
            meetings::commands::meetings_delete,
            meetings::commands::meetings_export,
            meetings::commands::meetings_update_config,
            meetings::commands::meetings_set_api_key,
            meetings::commands::meetings_clear_api_key,
            meetings::commands::meetings_install_model,
            meetings::commands::meetings_delete_model,
            spell_suggest,
            shell_exec::shell_exec,
            activity_commands::activity_list,
            activity_commands::activity_search_history,
            activity_commands::activity_spawn,
            activity_commands::activity_respawn,
            activity_commands::activity_snapshot,
            activity_commands::activity_terminal_attach,
            activity_commands::activity_terminal_checkpoint,
            activity_commands::activity_terminal_release,
            activity_commands::activity_write,
            activity_commands::activity_resize,
            activity_commands::activity_stop,
            activity_commands::activity_close,
            activity_commands::activity_rename,
            activity_commands::activity_provisional_title,
            activity_commands::activity_set_archived,
            activity_commands::activity_clear,
            activity_commands::activity_interrupt_all,
            activity_commands::activity_flush,
            launchers::launcher_detect_agents,
            launchers::launcher_load_config,
            launchers::launcher_save_config,
            launchers::launcher_resolve,
            routine_runtime::routine_catalog,
            routine_runtime::routine_reload,
            routine_runtime::routine_run_now,
            routine_runtime::agent_run,
            routine_runtime::agent_list,
            routine_runtime::scope_inventory,
            routine_runtime::routine_create,
            routine_runtime::routine_update,
            routine_runtime::routine_duplicate,
            routine_runtime::routine_trash,
            routine_runtime::routine_reveal,
            tracker::runtime::tracker_status,
            tracker::runtime::tracker_config_update,
            tracker::runtime::tracker_set_enabled,
            tracker::runtime::tracker_set_armed,
            tracker::runtime::tracker_start_break,
            tracker::runtime::tracker_end_break,
            tracker::runtime::tracker_query,
            tracker::runtime::tracker_report,
            tracker::runtime::tracker_classifications,
            tracker::runtime::tracker_classification_update,
            tracker::runtime::tracker_import_preview,
            tracker::runtime::tracker_import_argus,
            tracker::runtime::tracker_accessibility_request,
            tracker::runtime::tracker_context_update,
            file_open::take_pending_files,
            file_open::open_files_in_editor,
            file_index_commands::file_index_open,
            file_index_commands::file_index_files,
            file_index_commands::file_index_filter,
            file_index_commands::file_index_refresh,
            file_index_commands::file_index_begin_search,
            file_index_commands::file_index_cancel_search,
            file_index_commands::file_index_search,
            workspace_files::workspace_file_list_directory,
            workspace_files::workspace_file_inspect,
            workspace_files::workspace_file_create,
            workspace_files::workspace_file_rename,
            workspace_files::workspace_file_move,
            workspace_files::workspace_file_duplicate,
            workspace_files::workspace_file_import,
            workspace_files::workspace_file_trash,
            workspace_files::workspace_file_open_native,
            workspace_files::workspace_file_reveal,
            apps::app_catalog,
            apps::app_reload,
            apps::app_create,
            apps::app_duplicate,
            apps::app_update_title,
            apps::app_trash,
            apps::app_resolve,
            apps::app_open_window,
            apps::app_data_load,
            apps::app_data_save,
            apps::app_data_delete,
            apps::app_http_request,
            reveal_in_finder,
            tool_server::tool_server_start,
            tool_server::tool_server_stop,
            tool_server::tool_server_status,
            tool_server::tool_call_response,
            tool_runtime::tool_registry_snapshot,
            tool_runtime::tool_registry_list,
            tool_runtime::tool_registry_call,
            tool_runtime::tool_ui_provider_reconcile,
            tool_runtime::tool_ui_provider_unregister,
            tool_runtime::tool_provider_window_disconnected,
            tool_runtime::tool_app_provider_reconcile,
            tool_runtime::tool_app_provider_unregister,
            tool_runtime::tool_relay_response,
            tool_runtime::tool_relay_cancel,
            chat::chat_status,
            chat::chat_config,
            chat::chat_configure,
            chat::chat_update_config,
            chat::chat_reconnect,
            chat::chat_disconnect,
            chat::chat_set_enabled,
            chat::chat_targets,
            chat::chat_messages,
            chat::chat_messages_around,
            chat::chat_members,
            chat::chat_search,
            chat::chat_send,
            chat::chat_typing,
            chat::chat_react,
            chat::chat_edit,
            chat::chat_delete,
            chat::chat_upload_path,
            chat::chat_upload_base64,
            chat::chat_download_attachment,
            chat::chat_open_attachment,
            chat::chat_attachment_preview,
            chat::chat_create_channel,
            chat::chat_set_topic,
            chat::chat_join,
            chat::chat_leave,
            chat::chat_open_direct,
            chat::chat_close_direct,
            chat::chat_mark_read,
            chat::chat_set_muted,
            chat::chat_set_active,
            chat::chat_link_activity,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Mimir")
        .run(|app_handle, event| match event {
            tauri::RunEvent::ExitRequested { api, code, .. } => {
                if code.is_none() {
                    if let Some(main) = app_handle.get_webview_window("main") {
                        api.prevent_exit();
                        let _ = main.emit("mimir://quit-requested", ());
                        let _ = main.set_focus();
                    } else {
                        // A recording deliberately survives destruction of the
                        // renderer window. Dock/system Quit must therefore
                        // remain guarded by native state even when no window
                        // exists to receive the ordinary editor quit chain.
                        let meetings = app_handle.state::<meetings::runtime::MeetingRuntime>();
                        let quit = windowless_meeting_quit(
                            meetings
                                .snapshot()
                                .map(|snapshot| snapshot.active_meeting_id)
                                .map_err(|error| {
                                log::error!(
                                    "Could not inspect Scribe before windowless Quit: {error}"
                                );
                            }),
                        );
                        if let Some((quit, restore_error)) = guard_windowless_meeting_quit(
                            quit,
                            || api.prevent_exit(),
                            || {
                                create_main_window(app_handle, true)
                                    .map(|_| ())
                                    .map_err(|error| error.to_string())
                            },
                        ) {
                            let app = app_handle.clone();
                            if let Some(error) = restore_error {
                                log::error!(
                                    "Could not restore the main window for guarded Scribe Quit: {error}"
                                );
                            }
                            tauri::async_runtime::spawn_blocking(move || {
                                let runtime =
                                    app.state::<meetings::runtime::MeetingRuntime>();
                                let exit_app = app.clone();
                                let failure_app = app.clone();
                                complete_windowless_meeting_quit(
                                    quit,
                                    |meeting_id| {
                                        runtime.stop(meeting_id).map(|_| ()).map_err(|error| {
                                            format!(
                                                "Could not durably stop Scribe during windowless Quit: {error}"
                                            )
                                        })
                                    },
                                    move || exit_app.exit(0),
                                    move |error| {
                                        log::error!("{error}");
                                        if let Some(main) =
                                            failure_app.get_webview_window("main")
                                        {
                                            let _ = main.show();
                                            let _ = main.set_focus();
                                            let _ = main.emit(
                                                "mimir://meeting-windowless-quit-failed",
                                                error,
                                            );
                                        }
                                    },
                                );
                            });
                        }
                    }
                }
            }
            tauri::RunEvent::Exit => {
                app_handle.state::<chat::ChatRuntime>().disconnect();
                if let Err(error) = app_handle
                    .state::<tracker::TrackerRuntimeState>()
                    .shutdown()
                {
                    log::error!("Could not flush Tracker before exit: {error}");
                }
                app_handle
                    .state::<routine_runtime::RoutineRuntime>()
                    .stop_background();
                let supervisor = app_handle.state::<activities::ActivitySupervisor>();
                match supervisor.shutdown(std::time::Duration::from_millis(750)) {
                    Ok(report) if report.remaining > 0 => log::warn!(
                        "{} of {} interrupted activities had not settled before exit",
                        report.remaining,
                        report.interrupted
                    ),
                    Err(error) => {
                        log::error!("Could not flush activity persistence before exit: {error}")
                    }
                    _ => {}
                }
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Opened { urls } => {
                let paths = file_open::file_paths_from_urls(&urls);
                file_open::do_open_files_in_editor(app_handle, paths);
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                if let Some(main) = app_handle.get_webview_window("main") {
                    let _ = main.show();
                    let _ = main.set_focus();
                } else if let Err(error) = create_main_window(app_handle, true) {
                    log::error!("Could not recreate the main window: {error}");
                }
            }
            _ => {}
        });
}

#[cfg(test)]
mod proposal_persistence_tests {
    use super::*;
    use tempfile::tempdir;

    fn proposal(id: &str, status: &str) -> SharedProposal {
        SharedProposal::new(serde_json::json!({
            "id": id,
            "status": status,
            "path": "/w/a.md",
            "targetText": "old",
            "replacement": "new",
        }))
    }

    #[test]
    fn undecided_proposals_round_trip_and_applying_recovers_as_pending() {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("proposals.json");

        persist_proposals_at(
            &path,
            &[
                proposal("p-pending", "pending"),
                proposal("p-applying", "applying"),
                proposal("p-accepted", "accepted"),
                proposal("p-rejected", "rejected"),
            ],
        );

        let loaded = load_proposals_at(&path);
        let ids: Vec<&str> = loaded.iter().filter_map(|p| proposal_id(p)).collect();
        assert_eq!(ids, ["p-pending", "p-applying"]);
        assert!(loaded.iter().all(|p| proposal_status(p) == "pending"));
    }

    #[test]
    fn missing_and_malformed_files_load_as_empty() {
        let dir = tempdir().expect("tempdir");
        let missing = dir.path().join("absent.json");
        assert!(load_proposals_at(&missing).is_empty());

        let corrupt = dir.path().join("corrupt.json");
        fs::write(&corrupt, b"{not json").expect("write corrupt");
        assert!(load_proposals_at(&corrupt).is_empty());

        let wrong_shape = dir.path().join("wrong.json");
        fs::write(&wrong_shape, b"[{\"noId\":true}]").expect("write wrong shape");
        assert!(load_proposals_at(&wrong_shape).is_empty());
    }
}

#[cfg(test)]
mod windowless_quit_tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn windowless_quit_fails_closed_on_active_or_unknown_native_state() {
        assert_eq!(
            windowless_meeting_quit(Ok(Some("meeting-live".into()))),
            WindowlessMeetingQuit::Stop("meeting-live".into())
        );
        assert_eq!(
            windowless_meeting_quit(Err(())),
            WindowlessMeetingQuit::RestoreForInspectionFailure
        );
        assert_eq!(
            windowless_meeting_quit(Ok(None)),
            WindowlessMeetingQuit::Allow
        );
    }

    #[test]
    fn windowless_quit_stops_before_exit_and_failures_keep_process_open() {
        let order = RefCell::new(Vec::new());
        complete_windowless_meeting_quit(
            WindowlessMeetingQuit::Stop("meeting-live".into()),
            |meeting_id| {
                order.borrow_mut().push(format!("stop:{meeting_id}"));
                Ok(())
            },
            || order.borrow_mut().push("exit".into()),
            |error| order.borrow_mut().push(format!("failure:{error}")),
        );
        assert_eq!(*order.borrow(), ["stop:meeting-live", "exit"]);

        order.borrow_mut().clear();
        complete_windowless_meeting_quit(
            WindowlessMeetingQuit::Stop("meeting-failing".into()),
            |meeting_id| {
                order.borrow_mut().push(format!("stop:{meeting_id}"));
                Err("durable stop failed".into())
            },
            || order.borrow_mut().push("exit".into()),
            |error| order.borrow_mut().push(format!("failure:{error}")),
        );
        assert_eq!(
            *order.borrow(),
            ["stop:meeting-failing", "failure:durable stop failed"]
        );
        assert_eq!(
            finish_windowless_meeting_quit(
                WindowlessMeetingQuit::RestoreForInspectionFailure,
                |_meeting_id| panic!("inspection failure must not attempt an unknown stop")
            )
            .unwrap_err(),
            "native meeting state could not be inspected"
        );
    }

    #[test]
    fn windowless_quit_prevents_exit_before_attempting_window_recovery() {
        let order = RefCell::new(Vec::new());
        let guarded = guard_windowless_meeting_quit(
            WindowlessMeetingQuit::Stop("meeting-live".into()),
            || order.borrow_mut().push("prevent-exit"),
            || {
                order.borrow_mut().push("restore-window");
                Err("renderer unavailable".into())
            },
        )
        .expect("an active recording must guard windowless Quit");
        assert_eq!(*order.borrow(), ["prevent-exit", "restore-window"]);
        assert_eq!(
            guarded.0,
            WindowlessMeetingQuit::Stop("meeting-live".into())
        );
        assert_eq!(guarded.1.as_deref(), Some("renderer unavailable"));

        order.borrow_mut().clear();
        assert!(guard_windowless_meeting_quit(
            WindowlessMeetingQuit::Allow,
            || order.borrow_mut().push("unexpected-prevent"),
            || {
                order.borrow_mut().push("unexpected-restore");
                Ok(())
            },
        )
        .is_none());
        assert!(order.borrow().is_empty());
    }
}
