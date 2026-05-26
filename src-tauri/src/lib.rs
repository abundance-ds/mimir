use base64::Engine;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::PathBuf,
};
use tauri::{Emitter, Manager};

mod ai;
mod ai_keys;
mod ai_models;
mod ai_providers;
mod ai_proxy;
mod ai_transport;
mod ai_usage;
mod apps;
mod audit;
mod docx_worker;
mod file_open;
mod file_search;
mod git;
mod pty;
mod references;
mod search;
mod shell_exec;
mod tool_server;
mod typst_export;
mod usage;

#[cfg(target_os = "macos")]
fn enable_macos_spellcheck() {
    use objc2_foundation::{NSString, NSUserDefaults};
    let defaults = NSUserDefaults::standardUserDefaults();
    let key = NSString::from_str("WebContinuousSpellCheckingEnabled");
    defaults.setBool_forKey(true, &key);
}

#[cfg(target_os = "macos")]
fn ensure_traffic_lights_visible(ns_ptr_val: usize) {
    use objc2_app_kit::{NSWindow, NSWindowButton};

    let ns_window: &NSWindow = unsafe { &*(ns_ptr_val as *const NSWindow) };

    let close = ns_window.standardWindowButton(NSWindowButton::CloseButton);
    log::debug!("[traffic-lights] close button exists: {}", close.is_some());

    if let Some(close) = close {
        let frame = close.frame();
        log::debug!(
            "[traffic-lights] close btn frame: x={} y={} w={} h={}",
            frame.origin.x,
            frame.origin.y,
            frame.size.width,
            frame.size.height
        );
        log::debug!(
            "[traffic-lights] close btn hidden={} alpha={}",
            close.isHidden(),
            close.alphaValue()
        );

        unsafe {
            let mut depth = 0;
            let mut view_opt = close.superview();
            while let Some(view) = view_opt {
                let vf = view.frame();
                log::debug!(
                    "[traffic-lights]   ancestor[{}]: hidden={} alpha={:.2} frame={}x{} at ({},{})",
                    depth,
                    view.isHidden(),
                    view.alphaValue(),
                    vf.size.width,
                    vf.size.height,
                    vf.origin.x,
                    vf.origin.y
                );
                view.setHidden(false);
                view.setAlphaValue(1.0);
                view_opt = view.superview();
                depth += 1;
            }
        }
    }
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
    if let Some(parent) = path_buf.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Could not create {}: {}", parent.display(), err))?;
    }
    fs::write(&path_buf, content).map_err(|err| format!("Could not write {}: {}", path, err))
}

#[tauri::command]
fn read_binary_file(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("Could not read {}: {}", path, e))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

#[tauri::command]
fn write_binary_file(path: String, data_base64: String) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data_base64)
        .map_err(|e| format!("Invalid base64: {}", e))?;
    let path_buf = PathBuf::from(&path);
    if let Some(parent) = path_buf.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Could not create {}: {}", parent.display(), err))?;
    }
    fs::write(&path_buf, bytes).map_err(|err| format!("Could not write {}: {}", path, err))
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
fn copy_dir(src: String, dest: String) -> Result<(), String> {
    fn copy_recursive(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
        fs::create_dir_all(to)?;
        for entry in fs::read_dir(from)? {
            let entry = entry?;
            let target = to.join(entry.file_name());
            if entry.file_type()?.is_dir() {
                copy_recursive(&entry.path(), &target)?;
            } else {
                fs::copy(entry.path(), target)?;
            }
        }
        Ok(())
    }
    copy_recursive(std::path::Path::new(&src), std::path::Path::new(&dest))
        .map_err(|e| format!("Could not copy {} → {}: {}", src, dest, e))
}

#[tauri::command]
fn symlink_dir(src: String, dest: String) -> Result<(), String> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&src, &dest)
            .map_err(|e| format!("Could not symlink {} → {}: {}", src, dest, e))
    }
    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_dir(&src, &dest)
            .map_err(|e| format!("Could not symlink {} → {}: {}", src, dest, e))
    }
}

#[tauri::command]
fn delete_path(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Ok(());
    }
    if p.is_dir() {
        fs::remove_dir_all(&p).map_err(|e| format!("Could not remove {}: {}", path, e))
    } else {
        fs::remove_file(&p).map_err(|e| format!("Could not remove {}: {}", path, e))
    }
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

#[derive(Default)]
struct ProposalStore {
    proposals: Vec<serde_json::Value>,
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
) -> Option<serde_json::Value> {
    let proposal = store
        .proposals
        .iter_mut()
        .find(|p| proposal_id(p) == Some(id))?;
    if let Some(obj) = proposal.as_object_mut() {
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

fn pending_proposals(store: &ProposalStore) -> Vec<serde_json::Value> {
    store
        .proposals
        .iter()
        .filter(|p| proposal_status(p) == "pending")
        .cloned()
        .collect()
}

fn broadcast_proposal_state(app: &tauri::AppHandle, proposals: &[serde_json::Value]) {
    if let Some(panel) = app.get_webview_window("main") {
        let _ = panel.emit("shoulders://proposals-state", proposals);
    }
    let pending: Vec<serde_json::Value> = proposals
        .iter()
        .filter(|p| proposal_status(p) == "pending")
        .cloned()
        .collect();
    for window in app.webview_windows().values() {
        if window.label().starts_with("editor-") {
            let _ = window.emit("shoulders://proposals-changed", &pending);
        }
    }
}

fn broadcast_proposal_result(
    app: &tauri::AppHandle,
    proposal: &serde_json::Value,
    status: &str,
    detail: &str,
) {
    if let Some(panel) = app.get_webview_window("main") {
        let result = serde_json::json!({
            "id": proposal_id(proposal).unwrap_or(""),
            "sessionId": proposal_session_id(proposal),
            "status": status,
            "detail": detail,
        });
        let _ = panel.emit("shoulders://proposal-result", &result);
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
) -> Vec<serde_json::Value> {
    let store = state.0.lock().unwrap_or_else(|e| e.into_inner());
    pending_proposals(&store)
        .iter()
        .filter(|p| {
            p.get("path").and_then(|v| v.as_str()) == Some(path.as_str())
                || p.get("absolutePath").and_then(|v| v.as_str()) == Some(path.as_str())
        })
        .cloned()
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
fn proposal_list(state: tauri::State<ProposalState>) -> Vec<serde_json::Value> {
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
                let _ = window.emit("shoulders://proposal-apply", &proposal);
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
fn proposal_send(
    app: tauri::AppHandle,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let mut targets = Vec::new();
    for window in app.webview_windows().values() {
        let label = window.label().to_string();
        if label.starts_with("editor-") {
            let _ = window.emit("shoulders://proposal-apply", &payload);
            targets.push(label);
        }
    }
    Ok(serde_json::json!({
        "delivered": !targets.is_empty(),
        "targets": targets,
    }))
}

#[tauri::command]
fn diff_open(
    app: tauri::AppHandle,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let mut targets = Vec::new();
    for window in app.webview_windows().values() {
        let label = window.label().to_string();
        if label.starts_with("editor-") {
            let _ = window.emit("shoulders://diff-open", &payload);
            targets.push(label);
        }
    }
    Ok(serde_json::json!({
        "delivered": !targets.is_empty(),
        "targets": targets,
    }))
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
    if let Some(panel) = app.get_webview_window("main") {
        let _ = panel.emit("shoulders://proposal-result", &result);
    }
    Ok(())
}

#[tauri::command]
fn notify_file_updated(app: tauri::AppHandle, path: String, content: String) -> Result<(), String> {
    let payload = serde_json::json!({ "path": path, "content": content });
    for window in app.webview_windows().values() {
        if window.label().starts_with("editor-") {
            let _ = window.emit("shoulders://file-updated", &payload);
        }
    }
    Ok(())
}

#[tauri::command]
fn document_context_send(app: tauri::AppHandle, payload: serde_json::Value) -> Result<(), String> {
    if let Some(panel) = app.get_webview_window("main") {
        let _ = panel.emit("shoulders://document-changed", &payload);
    }
    Ok(())
}

#[tauri::command]
fn comments_submit(app: tauri::AppHandle, payload: serde_json::Value) -> Result<(), String> {
    if let Some(panel) = app.get_webview_window("main") {
        let _ = panel.emit("shoulders://comments-submit", &payload);
    }
    Ok(())
}

#[tauri::command]
fn board_send_to_agent(app: tauri::AppHandle, file_path: String, entry_id: String) -> Result<(), String> {
    if let Some(panel) = app.get_webview_window("main") {
        let payload = serde_json::json!({ "filePath": file_path, "entryId": entry_id });
        let _ = panel.emit("shoulders://board-send-to-agent", &payload);
        let _ = panel.set_focus();
    }
    Ok(())
}

fn create_panel_window<M: Manager<tauri::Wry>>(manager: &M) -> tauri::Result<tauri::WebviewWindow> {
    let mut builder =
        tauri::WebviewWindowBuilder::new(manager, "main", tauri::WebviewUrl::App("/".into()))
            .title("Mim Panel")
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

    builder.build()
}

#[tauri::command]
fn focus_main_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        win.set_focus().map_err(|e| e.to_string())
    } else {
        create_panel_window(&app).map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[tauri::command]
fn settings_changed(window: tauri::WebviewWindow) -> Result<(), String> {
    let caller = window.label().to_string();
    for (label, w) in window.app_handle().webview_windows() {
        if label != caller {
            let _ = w.emit("shoulders://settings-changed", ());
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn get_cursor_screen_position() -> Option<(f64, f64)> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSEvent, NSScreen};
    let point = NSEvent::mouseLocation();
    let mtm = unsafe { MainThreadMarker::new_unchecked() };
    let screens = NSScreen::screens(mtm);
    if screens.count() == 0 {
        return None;
    }
    let main_screen = screens.objectAtIndex(0);
    let screen_height = main_screen.frame().size.height;
    Some((point.x, screen_height - point.y))
}

#[cfg(not(target_os = "macos"))]
fn get_cursor_screen_position() -> Option<(f64, f64)> {
    None
}

#[tauri::command]
fn get_cursor_position(screen_x: f64, screen_y: f64) -> (f64, f64) {
    get_cursor_screen_position().unwrap_or((screen_x, screen_y))
}

#[tauri::command]
fn tab_drag_resolve(
    app: tauri::AppHandle,
    source_label: String,
    screen_x: f64,
    screen_y: f64,
    file_data: serde_json::Value,
) -> Result<String, String> {
    let os_cursor = get_cursor_screen_position();
    let (sx, sy) = os_cursor.unwrap_or((screen_x, screen_y));

    for window in app.webview_windows().values() {
        let label = window.label().to_string();
        if !label.starts_with("editor-") || label == source_label {
            continue;
        }
        if window.is_minimized().unwrap_or(false) {
            continue;
        }

        let pos = match window.outer_position() {
            Ok(p) => p,
            Err(_) => {
                continue;
            }
        };
        let size = match window.outer_size() {
            Ok(s) => s,
            Err(_) => {
                continue;
            }
        };
        let scale = window.scale_factor().unwrap_or(1.0);

        let x = pos.x as f64 / scale;
        let y = pos.y as f64 / scale;
        let w = size.width as f64 / scale;
        let h = size.height as f64 / scale;

        let hit = sx >= x && sx <= x + w && sy >= y && sy <= y + h;

        if hit {
            let _ = app.emit_to(&label, "shoulders://tab-receive", &file_data);
            let _ = window.set_focus();
            return Ok("transferred".to_string());
        }
    }
    Ok("create_new".to_string())
}

#[tauri::command]
fn read_bundled_profile(app: tauri::AppHandle) -> Result<String, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("No resource dir: {e}"))?;
    let path = resource_dir.join("profile.json");
    std::fs::read_to_string(&path).map_err(|e| format!("Could not read profile.json: {e}"))
}

#[derive(serde::Serialize)]
struct BundledSkillEntry {
    id: String,
    content: String,
}

#[tauri::command]
fn list_bundled_skills(app: tauri::AppHandle) -> Result<Vec<BundledSkillEntry>, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("No resource dir: {e}"))?;
    let skills_dir = resource_dir.join("bundled-skills");

    let mut entries = Vec::new();
    let read_dir = match std::fs::read_dir(&skills_dir) {
        Ok(rd) => rd,
        Err(_) => return Ok(entries),
    };

    for entry in read_dir.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let skill_path = entry.path().join("SKILL.md");
        if let Ok(content) = std::fs::read_to_string(&skill_path) {
            entries.push(BundledSkillEntry {
                id: entry.file_name().to_string_lossy().into_owned(),
                content,
            });
        }
    }

    Ok(entries)
}

#[derive(serde::Serialize)]
struct BundledFileEntry {
    path: String,
    content: String,
}

#[derive(serde::Serialize)]
struct BundledAppEntry {
    id: String,
    manifest: String,
    files: Vec<BundledFileEntry>,
}

#[tauri::command]
fn list_bundled_apps(app: tauri::AppHandle) -> Result<Vec<BundledAppEntry>, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("No resource dir: {e}"))?;
    let apps_dir = resource_dir.join("bundled-apps");

    let mut entries = Vec::new();
    let read_dir = match std::fs::read_dir(&apps_dir) {
        Ok(rd) => rd,
        Err(_) => return Ok(entries),
    };

    for entry in read_dir.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let app_dir = entry.path();
        let manifest_path = app_dir.join("manifest.json");
        let manifest = match std::fs::read_to_string(&manifest_path) {
            Ok(m) => m,
            Err(_) => continue,
        };

        let mut files = Vec::new();
        let mut dirs_to_scan = vec![app_dir.clone()];
        while let Some(dir) = dirs_to_scan.pop() {
            if let Ok(dir_entries) = std::fs::read_dir(&dir) {
                for file_entry in dir_entries.flatten() {
                    let rel = file_entry
                        .path()
                        .strip_prefix(&app_dir)
                        .unwrap_or(file_entry.path().as_path())
                        .to_string_lossy()
                        .into_owned();
                    if rel == "manifest.json" || rel.starts_with("data/") {
                        continue;
                    }
                    if file_entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                        dirs_to_scan.push(file_entry.path());
                    } else if file_entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                        if let Ok(content) = std::fs::read_to_string(file_entry.path()) {
                            files.push(BundledFileEntry { path: rel, content });
                        }
                    }
                }
            }
        }

        entries.push(BundledAppEntry {
            id: entry.file_name().to_string_lossy().into_owned(),
            manifest,
            files,
        });
    }

    Ok(entries)
}

fn serve_workflow_file(request: tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    let path = request.uri().path().trim_start_matches('/');

    if path.contains("..") || path.is_empty() {
        return tauri::http::Response::builder()
            .status(403)
            .body(b"Forbidden".to_vec())
            .unwrap();
    }

    let home = match std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        Some(h) => h,
        None => {
            return tauri::http::Response::builder()
                .status(500)
                .body(b"No home dir".to_vec())
                .unwrap()
        }
    };

    let file_path = PathBuf::from(home)
        .join(".shoulders-v3")
        .join("workflows")
        .join(path);

    match fs::read(&file_path) {
        Ok(content) => {
            let mime = match path.rsplit('.').next().unwrap_or("") {
                "js" | "mjs" => "application/javascript",
                "json" => "application/json",
                "css" => "text/css",
                "txt" | "md" => "text/plain",
                _ => "application/octet-stream",
            };
            tauri::http::Response::builder()
                .status(200)
                .header("Content-Type", mime)
                .header("Access-Control-Allow-Origin", "*")
                .body(content)
                .unwrap()
        }
        Err(_) => tauri::http::Response::builder()
            .status(404)
            .body(format!("Not found: {}", path).into_bytes())
            .unwrap(),
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .register_uri_scheme_protocol("wf", |_app, request| serve_workflow_file(request))
        .register_uri_scheme_protocol("app", |_app, request| apps::serve_app_file(request))
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let paths = file_open::filter_file_args(&args);
            file_open::do_open_files_in_editor(app, paths);
        }))
        .manage(ProposalState::default())
        .manage(ai_proxy::AiStreamState::default())
        .manage(usage::UsageDbState::default())
        .manage(audit::AuditDbState::default())
        .manage(pty::PtyState::default())
        .manage(file_open::PendingFilePaths::default())
        .manage(tool_server::ToolServerState::default())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            enable_macos_spellcheck();

            let panel = create_panel_window(app)?;

            let cli_files = file_open::filter_file_args(&std::env::args().collect::<Vec<_>>());
            if !cli_files.is_empty() {
                let state = app.state::<file_open::PendingFilePaths>();
                *state.0.lock().unwrap() = cli_files;
                file_open::create_editor_window(app)?;
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            #[cfg(target_os = "macos")]
            if let tauri::WindowEvent::Focused(false) = event {
                log::debug!(
                    "[traffic-lights] window='{}' lost focus, scheduling fix in 200ms",
                    window.label()
                );
                let ns_ptr = window.ns_window().ok().map(|p| p as usize);
                let handle = window.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                    log::debug!(
                        "[traffic-lights] 200ms elapsed, running fix (ptr={})",
                        ns_ptr.is_some()
                    );
                    if let Some(ptr) = ns_ptr {
                        let _ = handle.run_on_main_thread(move || {
                            ensure_traffic_lights_visible(ptr);
                        });
                    }
                });
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = (window, event);
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
            read_text_file,
            read_binary_file,
            write_text_file,
            write_binary_file,
            path_exists,
            create_dir,
            list_dir,
            copy_dir,
            symlink_dir,
            delete_path,
            references::ref_dir,
            references::ref_list,
            references::ref_add,
            references::ref_remove,
            references::ref_update,
            typst_export::export_pdf,
            usage::usage_record,
            usage::usage_query_month,
            usage::usage_query_daily,
            usage::usage_get_setting,
            usage::usage_set_setting,
            usage::tool_execution_record,
            usage::tool_execution_query,
            usage::usage_query_month_csv,
            audit::audit_log,
            audit::audit_query,
            audit::audit_query_summary,
            audit::audit_export_csv,
            git::git_clone,
            git::git_clone_authenticated,
            git::git_init,
            git::git_status,
            git::git_file_log,
            git::git_file_at_revision,
            push_proposals,
            get_proposals_for_path,
            proposal_create,
            proposal_list,
            proposal_register_editor,
            proposal_apply,
            proposal_reject,
            proposal_send,
            proposal_respond,
            notify_file_updated,
            diff_open,
            document_context_send,
            comments_submit,
            board_send_to_agent,
            settings_changed,
            focus_main_window,
            spell_suggest,
            docx_worker::docx_annotate,
            docx_worker::docx_read_comments,
            docx_worker::docx_validate,
            shell_exec::shell_exec,
            get_cursor_position,
            tab_drag_resolve,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            file_open::take_pending_files,
            file_open::open_files_in_editor,
            apps::app_discover,
            apps::app_create,
            apps::app_write_file,
            apps::app_delete,
            apps::app_open_window,
            apps::app_data_load,
            apps::app_data_save,
            apps::app_data_delete,
            apps::app_data_keys,
            apps::app_http_request,
            search::search_sessions,
            file_search::search_file_content,
            reveal_in_finder,
            read_bundled_profile,
            list_bundled_skills,
            list_bundled_apps,
            tool_server::tool_server_start,
            tool_server::tool_server_stop,
            tool_server::tool_server_status,
            tool_server::tool_call_response,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Mim Panel")
        .run(|app_handle, event| {
            let _ = &app_handle;
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = event {
                let paths: Vec<String> = urls
                    .into_iter()
                    .filter_map(|u| {
                        if u.scheme() == "file" {
                            Some(u.path().to_string())
                        } else {
                            None
                        }
                    })
                    .collect();
                file_open::do_open_files_in_editor(app_handle, paths);
            }
        });
}
