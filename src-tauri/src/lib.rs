use base64::Engine;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::PathBuf,
};
use tauri::{Emitter, Manager};

pub mod activities;
mod activity_commands;
mod ai;
mod ai_keys;
mod ai_models;
mod ai_providers;
mod ai_proxy;
mod ai_transport;
mod ai_usage;
mod apps;
pub mod business_graph;
pub mod file_index;
mod file_index_commands;
mod file_open;
mod git;
mod launchers;
mod local_settings;
pub mod mimx;
mod persistence;
pub mod routine_runtime;
pub mod routines;
mod session;
mod shell_exec;
pub mod tool_bridge;
pub mod tool_registry;
mod tool_runtime;
mod tool_server;
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
        std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
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

fn broadcast_proposal_state(app: &tauri::AppHandle, proposals: &[SharedProposal]) {
    let pending: Vec<SharedProposal> = proposals
        .iter()
        .filter(|p| proposal_status(p) == "pending")
        .cloned()
        .collect();
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.emit("mim://proposals-state", proposals);
        let _ = main.emit("mim://proposals-changed", &pending);
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
        let _ = main.emit("mim://proposal-result", &result);
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
fn push_proposals(
    app: tauri::AppHandle,
    state: tauri::State<ProposalState>,
    proposals: Vec<serde_json::Value>,
) -> Result<(), String> {
    let proposals_snapshot = {
        let mut store = state.0.lock().map_err(|e| e.to_string())?;
        let incoming_ids: HashSet<String> = proposals
            .iter()
            .filter_map(|p| proposal_id(p).map(|id| id.to_string()))
            .collect();
        store.proposals.retain(|p| {
            let status = proposal_status(p);
            status != "pending"
                || proposal_id(p)
                    .map(|id| incoming_ids.contains(id))
                    .unwrap_or(false)
        });
        for proposal in proposals {
            upsert_proposal(&mut store, proposal)?;
        }
        store.proposals.clone()
    };
    broadcast_proposal_state(&app, &proposals_snapshot);
    Ok(())
}

#[tauri::command]
fn get_proposals_for_path(
    state: tauri::State<ProposalState>,
    path: String,
) -> Vec<SharedProposal> {
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
    broadcast_proposal_state(&app, &proposals_snapshot);
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
                broadcast_proposal_state(&app, &snapshot);
                return Ok(serde_json::json!({ "status": "conflict", "detail": detail }));
            }
        };
        set_proposal_status(&mut store, &id, "applying", None);
        (proposal, owner, store.proposals.clone())
    };
    broadcast_proposal_state(&app, &applying_snapshot);

    if let Some((label, should_delegate)) = owner {
        if should_delegate {
            if let Some(window) = app.get_webview_window(&label) {
                let _ = window.emit("mim://proposal-apply", &proposal);
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
            broadcast_proposal_state(&app, &proposals_snapshot);
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
        broadcast_proposal_state(&app, &snapshot);
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
    broadcast_proposal_state(&app, &proposals_snapshot);
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
    broadcast_proposal_state(&app, &proposals_snapshot);
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.emit("mim://proposal-result", &result);
    }
    Ok(())
}

#[tauri::command]
fn notify_file_updated(app: tauri::AppHandle, path: String, content: String) -> Result<(), String> {
    let payload = serde_json::json!({ "path": path, "content": content });
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.emit("mim://file-updated", &payload);
    }
    Ok(())
}

fn create_main_window<M: Manager<tauri::Wry>>(manager: &M) -> tauri::Result<tauri::WebviewWindow> {
    let mut builder =
        tauri::WebviewWindowBuilder::new(manager, "main", tauri::WebviewUrl::App("/".into()))
            .title("Mim")
            .inner_size(1280.0, 800.0)
            .min_inner_size(520.0, 420.0)
            .decorations(true);

    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(tauri::Position::Logical(tauri::LogicalPosition::new(
                14.0, 14.0,
            )));
    }

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
            let _ = w.emit("mim://settings-changed", ());
        }
    }
    Ok(())
}

#[tauri::command]
fn app_quit_confirmed(app: tauri::AppHandle) {
    app.exit(0);
}

pub fn run() {
    let tool_registry = tool_registry::ToolRegistry::default();
    let tool_runtime = tool_runtime::ToolRuntime::new(tool_registry.clone());
    let activity_supervisor =
        activities::ActivitySupervisor::new(activities::ActivitySupervisorConfig::default())
            .expect("activity supervisor must initialize");
    let routine_runtime = routine_runtime::RoutineRuntime::new(
        routine_runtime::RoutineRuntimeConfig::default(),
        activity_supervisor.clone(),
    )
    .expect("routine runtime must initialize");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .register_uri_scheme_protocol("app", |_app, request| apps::serve_app_file(request))
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            let paths = file_open::resolve_file_args(&args, std::path::Path::new(&cwd));
            file_open::do_open_files_in_editor(app, paths);
        }))
        .manage(ProposalState::default())
        .manage(activity_supervisor)
        .manage(routine_runtime)
        .manage(ai_proxy::AiStreamState::default())
        .manage(business_graph::GraphRuntime::default())
        .manage(file_open::PendingFilePaths::default())
        .manage(file_index_commands::FileIndexState::default())
        .manage(tool_server::ToolServerState::default())
        .manage(tool_registry)
        .manage(tool_runtime)
        .setup(|app| {
            #[cfg(target_os = "macos")]
            enable_macos_spellcheck();

            mimx::install().map_err(std::io::Error::other)?;
            create_main_window(app)?;
            let supervisor = app.state::<activities::ActivitySupervisor>();
            activity_commands::TauriActivitySink::install(app.handle(), &supervisor);
            let routines = app.state::<routine_runtime::RoutineRuntime>();
            routine_runtime::TauriRoutineSink::install(app.handle(), &routines);
            routines.start().map_err(std::io::Error::other)?;
            app.state::<tool_runtime::ToolRuntime>()
                .initialize(app.handle())
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
            business_graph::runtime::graph_migration_report,
            business_graph::runtime::graph_context,
            business_graph::runtime::graph_refresh,
            business_graph::runtime::graph_update,
            business_graph::runtime::graph_create,
            business_graph::runtime::graph_delete,
            business_graph::runtime::graph_restore,
            git::git_status,
            push_proposals,
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
            spell_suggest,
            shell_exec::shell_exec,
            activity_commands::activity_list,
            activity_commands::activity_spawn,
            activity_commands::activity_snapshot,
            activity_commands::activity_write,
            activity_commands::activity_resize,
            activity_commands::activity_stop,
            activity_commands::activity_rename,
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
            routine_runtime::routine_create,
            routine_runtime::routine_update,
            routine_runtime::routine_duplicate,
            routine_runtime::routine_trash,
            routine_runtime::routine_reveal,
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
            workspace_files::workspace_file_duplicate,
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
        ])
        .build(tauri::generate_context!())
        .expect("error while building Mim")
        .run(|app_handle, event| match event {
            tauri::RunEvent::ExitRequested { api, code, .. } => {
                if code.is_none() {
                    if let Some(main) = app_handle.get_webview_window("main") {
                        api.prevent_exit();
                        let _ = main.emit("mim://quit-requested", ());
                        let _ = main.set_focus();
                    }
                }
            }
            tauri::RunEvent::Exit => {
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
                } else if let Err(error) = create_main_window(app_handle) {
                    log::error!("Could not recreate the main window: {error}");
                }
            }
            _ => {}
        });
}
