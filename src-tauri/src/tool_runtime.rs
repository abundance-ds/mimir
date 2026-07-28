//! Application integration for the canonical tool registry.
//!
//! This module owns live UI/app relay providers and exposes command-shaped
//! functions for Tauri. MCP and `mimir` use the same [`ToolRegistry`] instance.

use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::Emitter;
use tokio::sync::Mutex;

use crate::{
    tool_bridge::{
        self, AppToolProvider, DynamicToolDefinition, ToolBridgeEventSink, ToolCallRequest,
        ToolCallResponse, ToolListResponse, ToolRelayCancellation, ToolRelayRequest,
        ToolRelayResponse, ToolSnapshotResponse, UiToolProvider,
    },
    tool_registry::{ReconcileReport, ToolError, ToolErrorCode, ToolRegistry, ToolResult},
};

const DEFAULT_RELAY_TIMEOUT_MS: u64 = 120_000;
const MIN_RELAY_TIMEOUT_MS: u64 = 100;
const MAX_RELAY_TIMEOUT_MS: u64 = 600_000;
pub(crate) const LEAN_AGENT_TOOLS: [(&str, &str, &str); 3] = [
    ("editor.state", "mimir_state", "Get active editor state."),
    (
        "editor.reveal",
        "mimir_reveal",
        "Open a file in Mimir, optionally at a line.",
    ),
    (
        "editor.propose",
        "mimir_propose",
        "Propose one exact text replacement for review.",
    ),
];
const TOOL_RELAY_REQUEST_EVENT: &str = "mimir://tool-relay-request";
const TOOL_RELAY_CANCEL_EVENT: &str = "mimir://tool-relay-cancel";
const TOOL_LIST_CHANGED_EVENT: &str = "mimir://tools-list-changed";
const LEGACY_TOOL_REQUEST_EVENT: &str = "tool-call-request";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyToolRequest {
    id: String,
    tool: String,
    input: Value,
    cwd: Option<String>,
}

struct TauriToolEventSink {
    app: tauri::AppHandle,
    legacy_tools: HashSet<String>,
}

impl TauriToolEventSink {
    fn dynamic(app: tauri::AppHandle) -> Self {
        Self {
            app,
            legacy_tools: HashSet::new(),
        }
    }

    fn core(app: tauri::AppHandle) -> Self {
        Self {
            app,
            legacy_tools: legacy_tool_aliases()
                .into_iter()
                .map(str::to_string)
                .collect(),
        }
    }
}

impl ToolBridgeEventSink for TauriToolEventSink {
    fn emit_tool_call(&self, request: ToolRelayRequest) -> Result<(), String> {
        self.app
            .emit(TOOL_RELAY_REQUEST_EVENT, &request)
            .map_err(|error| error.to_string())?;

        // Preserve the exceptional existing editor/tool implementation while
        // the renderer adopts the richer relay DTO. New tools receive only the
        // canonical event, so the legacy allowlist cannot reject them first.
        let legacy_alias = canonical_legacy_alias(&request.tool);
        if self.legacy_tools.contains(&legacy_alias) {
            self.app
                .emit(
                    LEGACY_TOOL_REQUEST_EVENT,
                    LegacyToolRequest {
                        id: request.id,
                        tool: legacy_alias,
                        input: request.input,
                        cwd: request.context.cwd,
                    },
                )
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    fn emit_tool_cancellation(&self, cancellation: ToolRelayCancellation) -> Result<(), String> {
        self.app
            .emit(TOOL_RELAY_CANCEL_EVENT, cancellation)
            .map_err(|error| error.to_string())
    }
}

fn canonical_legacy_alias(canonical_name: &str) -> String {
    core_tool_definitions()
        .into_iter()
        .find(|definition| definition.canonical_name == canonical_name)
        .map(|definition| definition.mcp_alias)
        .unwrap_or_else(|| canonical_name.to_string())
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct UiProviderKey {
    provider_id: String,
    window_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct AppProviderKey {
    app_id: String,
    instance_id: String,
}

/// Managed application state around the canonical registry.
pub struct ToolRuntime {
    registry: ToolRegistry,
    core_ui: std::sync::Mutex<Option<UiToolProvider>>,
    ui_providers: Mutex<HashMap<UiProviderKey, UiToolProvider>>,
    app_providers: Mutex<HashMap<AppProviderKey, AppToolProvider>>,
    revision_events_started: AtomicBool,
}

impl ToolRuntime {
    pub fn new(registry: ToolRegistry) -> Self {
        Self {
            registry,
            core_ui: std::sync::Mutex::new(None),
            ui_providers: Mutex::new(HashMap::new()),
            app_providers: Mutex::new(HashMap::new()),
            revision_events_started: AtomicBool::new(false),
        }
    }

    pub fn registry(&self) -> &ToolRegistry {
        &self.registry
    }

    /// Install stable UI-backed core tools and begin emitting revision changes.
    pub fn initialize(&self, app: &tauri::AppHandle) -> Result<(), String> {
        for (canonical_name, alias, _) in LEAN_AGENT_TOOLS {
            self.registry
                .reserve_core_tool(canonical_name, alias)
                .map_err(|error| error.to_string())?;
        }
        let provider = UiToolProvider::new(
            self.registry.clone(),
            "mimir-core",
            "main",
            Duration::from_millis(DEFAULT_RELAY_TIMEOUT_MS),
            Arc::new(TauriToolEventSink::core(app.clone())),
        );
        provider
            .register_core(core_tool_definitions())
            .map_err(|error| error.to_string())?;
        crate::business_graph::tools::register_native_tools(&self.registry, app)?;
        *self
            .core_ui
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(provider);
        self.start_revision_events(app);
        Ok(())
    }

    fn start_revision_events(&self, app: &tauri::AppHandle) {
        if self.revision_events_started.swap(true, Ordering::AcqRel) {
            return;
        }
        let mut observer = tool_bridge::observe_revisions(&self.registry);
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(event) = observer.changed().await {
                let _ = app.emit(TOOL_LIST_CHANGED_EVENT, event);
            }
        });
    }

    async fn reconcile_ui(
        &self,
        app: &tauri::AppHandle,
        provider_id: String,
        window_id: String,
        definitions: Vec<DynamicToolDefinition>,
        timeout_ms: Option<u64>,
    ) -> Result<ProviderReconcileResponse, String> {
        let key = UiProviderKey {
            provider_id: provider_id.clone(),
            window_id: window_id.clone(),
        };
        let existing = self.ui_providers.lock().await.get(&key).cloned();
        let provider = existing.unwrap_or_else(|| {
            UiToolProvider::new(
                self.registry.clone(),
                provider_id,
                window_id,
                relay_timeout(timeout_ms),
                Arc::new(TauriToolEventSink::dynamic(app.clone())),
            )
        });
        let report = provider
            .reconcile(definitions)
            .map_err(|error| error.to_string())?;
        self.ui_providers.lock().await.insert(key, provider);
        Ok(report.into())
    }

    async fn unregister_ui(&self, provider_id: &str, window_id: &str) -> Option<u64> {
        let provider = self.ui_providers.lock().await.remove(&UiProviderKey {
            provider_id: provider_id.to_string(),
            window_id: window_id.to_string(),
        })?;
        Some(provider.unregister().await)
    }

    pub async fn disconnect_window(&self, window_id: &str) -> usize {
        let ui_providers = {
            let mut providers = self.ui_providers.lock().await;
            let keys: Vec<UiProviderKey> = providers
                .keys()
                .filter(|key| key.window_id == window_id)
                .cloned()
                .collect();
            keys.into_iter()
                .filter_map(|key| providers.remove(&key))
                .collect::<Vec<_>>()
        };
        let app_providers = {
            let mut providers = self.app_providers.lock().await;
            let keys: Vec<AppProviderKey> = providers
                .keys()
                .filter(|key| key.instance_id == window_id)
                .cloned()
                .collect();
            keys.into_iter()
                .filter_map(|key| providers.remove(&key))
                .collect::<Vec<_>>()
        };

        let mut cancelled = 0;
        for provider in ui_providers {
            cancelled += provider.window_disconnected(window_id).await;
            provider.unregister().await;
        }
        for provider in app_providers {
            cancelled += provider.disconnected().await;
            provider.unregister().await;
        }
        cancelled
    }

    async fn reconcile_app(
        &self,
        app: &tauri::AppHandle,
        app_id: String,
        instance_id: String,
        definitions: Vec<DynamicToolDefinition>,
        timeout_ms: Option<u64>,
    ) -> Result<ProviderReconcileResponse, String> {
        let key = AppProviderKey {
            app_id: app_id.clone(),
            instance_id: instance_id.clone(),
        };

        // An app owns one canonical tool set. Replacing its runtime instance
        // first retires older relays so responses can never go to stale UI.
        let stale = {
            let mut providers = self.app_providers.lock().await;
            let keys: Vec<AppProviderKey> = providers
                .keys()
                .filter(|candidate| candidate.app_id == app_id && **candidate != key)
                .cloned()
                .collect();
            keys.into_iter()
                .filter_map(|key| providers.remove(&key))
                .collect::<Vec<_>>()
        };
        for provider in stale {
            provider.unregister().await;
        }

        let existing = self.app_providers.lock().await.get(&key).cloned();
        let provider = existing.unwrap_or_else(|| {
            AppToolProvider::new(
                self.registry.clone(),
                app_id,
                instance_id,
                relay_timeout(timeout_ms),
                Arc::new(TauriToolEventSink::dynamic(app.clone())),
            )
        });
        let report = provider
            .reconcile(definitions)
            .map_err(|error| error.to_string())?;
        self.app_providers.lock().await.insert(key, provider);
        Ok(report.into())
    }

    async fn unregister_app(&self, app_id: &str, instance_id: &str) -> Option<u64> {
        let provider = self.app_providers.lock().await.remove(&AppProviderKey {
            app_id: app_id.to_string(),
            instance_id: instance_id.to_string(),
        })?;
        Some(provider.unregister().await)
    }

    pub async fn resolve(&self, response: ToolRelayResponse) -> bool {
        let core_provider = self
            .core_ui
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        if let Some(provider) = core_provider {
            if provider.resolve(response.clone()).await {
                return true;
            }
        }
        let ui: Vec<_> = self.ui_providers.lock().await.values().cloned().collect();
        for provider in ui {
            if provider.resolve(response.clone()).await {
                return true;
            }
        }
        let apps: Vec<_> = self.app_providers.lock().await.values().cloned().collect();
        for provider in apps {
            if provider.resolve(response.clone()).await {
                return true;
            }
        }
        false
    }

    pub async fn cancel(&self, request_id: &str) -> bool {
        let core_provider = self
            .core_ui
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        if let Some(provider) = core_provider {
            if provider.cancel(request_id).await {
                return true;
            }
        }
        let ui: Vec<_> = self.ui_providers.lock().await.values().cloned().collect();
        for provider in ui {
            if provider.cancel(request_id).await {
                return true;
            }
        }
        let apps: Vec<_> = self.app_providers.lock().await.values().cloned().collect();
        for provider in apps {
            if provider.cancel(request_id).await {
                return true;
            }
        }
        false
    }
}

fn relay_timeout(timeout_ms: Option<u64>) -> Duration {
    Duration::from_millis(
        timeout_ms
            .unwrap_or(DEFAULT_RELAY_TIMEOUT_MS)
            .clamp(MIN_RELAY_TIMEOUT_MS, MAX_RELAY_TIMEOUT_MS),
    )
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderReconcileResponse {
    pub added: Vec<String>,
    pub updated: Vec<String>,
    pub removed: Vec<String>,
    pub revision: u64,
}

impl From<ReconcileReport> for ProviderReconcileResponse {
    fn from(report: ReconcileReport) -> Self {
        Self {
            added: report.added,
            updated: report.updated,
            removed: report.removed,
            revision: report.revision,
        }
    }
}

#[tauri::command]
pub async fn tool_registry_snapshot(
    runtime: tauri::State<'_, ToolRuntime>,
) -> Result<ToolSnapshotResponse, String> {
    Ok(tool_bridge::snapshot(runtime.registry()).await)
}

#[tauri::command]
pub async fn tool_registry_list(
    runtime: tauri::State<'_, ToolRuntime>,
) -> Result<ToolListResponse, String> {
    Ok(tool_bridge::list(runtime.registry()).await)
}

#[tauri::command]
pub async fn tool_registry_call(
    runtime: tauri::State<'_, ToolRuntime>,
    request: ToolCallRequest,
) -> Result<ToolCallResponse, String> {
    Ok(tool_bridge::call(runtime.registry(), request).await)
}

#[tauri::command]
pub async fn tool_ui_provider_reconcile(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, ToolRuntime>,
    provider_id: String,
    window_id: String,
    definitions: Vec<DynamicToolDefinition>,
    timeout_ms: Option<u64>,
) -> Result<ProviderReconcileResponse, String> {
    runtime
        .reconcile_ui(&app, provider_id, window_id, definitions, timeout_ms)
        .await
}

#[tauri::command]
pub async fn tool_ui_provider_unregister(
    runtime: tauri::State<'_, ToolRuntime>,
    provider_id: String,
    window_id: String,
) -> Result<Option<u64>, String> {
    Ok(runtime.unregister_ui(&provider_id, &window_id).await)
}

#[tauri::command]
pub async fn tool_provider_window_disconnected(
    runtime: tauri::State<'_, ToolRuntime>,
    window_id: String,
) -> Result<usize, String> {
    Ok(runtime.disconnect_window(&window_id).await)
}

#[tauri::command]
pub async fn tool_app_provider_reconcile(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, ToolRuntime>,
    app_id: String,
    instance_id: String,
    definitions: Vec<DynamicToolDefinition>,
    timeout_ms: Option<u64>,
) -> Result<ProviderReconcileResponse, String> {
    runtime
        .reconcile_app(&app, app_id, instance_id, definitions, timeout_ms)
        .await
}

#[tauri::command]
pub async fn tool_app_provider_unregister(
    runtime: tauri::State<'_, ToolRuntime>,
    app_id: String,
    instance_id: String,
) -> Result<Option<u64>, String> {
    Ok(runtime.unregister_app(&app_id, &instance_id).await)
}

#[tauri::command]
pub async fn tool_relay_response(
    runtime: tauri::State<'_, ToolRuntime>,
    response: ToolRelayResponse,
) -> Result<bool, String> {
    Ok(runtime.resolve(response).await)
}

#[tauri::command]
pub async fn tool_relay_cancel(
    runtime: tauri::State<'_, ToolRuntime>,
    request_id: String,
) -> Result<bool, String> {
    Ok(runtime.cancel(&request_id).await)
}

pub async fn resolve_legacy_response(
    runtime: &ToolRuntime,
    id: String,
    result: Option<Value>,
    error: Option<String>,
) -> Result<(), String> {
    let response = match error {
        Some(message) => {
            ToolRelayResponse::error(id, ToolError::new(ToolErrorCode::Handler, message))
        }
        None => ToolRelayResponse::success(id, ToolResult::new(result.unwrap_or(Value::Null))),
    };
    if runtime.resolve(response).await {
        Ok(())
    } else {
        Err("tool response arrived after completion or for an unknown request".to_string())
    }
}

fn definition(
    canonical_name: &str,
    mcp_alias: &str,
    description: &str,
    input_schema: Value,
) -> DynamicToolDefinition {
    DynamicToolDefinition::new(canonical_name, mcp_alias, description, input_schema)
}

fn object_schema(properties: Value, required: &[&str]) -> Value {
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false
    })
}

fn core_tool_definitions() -> Vec<DynamicToolDefinition> {
    vec![
        definition(
            "files.read",
            "read",
            "Read the active editor or a workspace text file.",
            object_schema(
                json!({
                    "target": { "type": "string", "minLength": 1, "maxLength": 500 },
                    "show_comments": { "type": "boolean" },
                    "max_chars": { "type": "integer", "minimum": 500, "maximum": 60000 }
                }),
                &["target"],
            ),
        ),
        definition(
            "files.list",
            "list",
            "List files in a workspace directory.",
            object_schema(
                json!({
                    "target": { "type": "string", "minLength": 1, "maxLength": 500 },
                    "pattern": { "type": "string", "maxLength": 100 }
                }),
                &["target"],
            ),
        ),
        definition(
            "files.search",
            "search",
            "Search workspace file content.",
            object_schema(
                json!({
                    "scope": { "const": "project" },
                    "query": { "type": "string", "maxLength": 500 },
                    "file_pattern": { "type": "string", "maxLength": 100 },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 50 }
                }),
                &["scope", "query"],
            ),
        ),
        definition(
            "files.edit",
            "edit",
            "Edit one exact text occurrence in the editor or a workspace file.",
            object_schema(
                json!({
                    "target": { "type": "string", "minLength": 1, "maxLength": 500 },
                    "old_text": { "type": "string", "minLength": 1, "maxLength": 50000 },
                    "new_text": { "type": "string", "maxLength": 50000 },
                    "rationale": { "type": "string", "maxLength": 2000 }
                }),
                &["target", "old_text", "new_text"],
            ),
        ),
        definition(
            "files.create",
            "create",
            "Create a new text file without overwriting an existing file.",
            object_schema(
                json!({
                    "target": { "type": "string", "minLength": 1, "maxLength": 500 },
                    "content": { "type": "string", "minLength": 1, "maxLength": 100000 }
                }),
                &["target", "content"],
            ),
        ),
        definition(
            "files.browse",
            "files_browse",
            "List the immediate children of one workspace directory with file metadata. Paths are workspace-relative or exact paths inside the open workspace.",
            object_schema(
                json!({
                    "directory": { "type": "string", "maxLength": 1000 }
                }),
                &[],
            ),
        ),
        definition(
            "files.create_folder",
            "files_create_folder",
            "Create one new folder at a workspace-relative path without overwriting anything.",
            object_schema(
                json!({
                    "path": { "type": "string", "minLength": 1, "maxLength": 1000 }
                }),
                &["path"],
            ),
        ),
        definition(
            "files.rename",
            "files_rename",
            "Rename one exact file or folder inside the open workspace without moving it or overwriting another item.",
            object_schema(
                json!({
                    "path": { "type": "string", "minLength": 1, "maxLength": 1000 },
                    "new_name": { "type": "string", "minLength": 1, "maxLength": 255 }
                }),
                &["path", "new_name"],
            ),
        ),
        definition(
            "files.duplicate",
            "files_duplicate",
            "Duplicate one exact file or folder inside the open workspace to a deterministic available copy name.",
            object_schema(
                json!({
                    "path": { "type": "string", "minLength": 1, "maxLength": 1000 }
                }),
                &["path"],
            ),
        ),
        definition(
            "files.trash",
            "files_trash",
            "Move the exact listed workspace files or folders to the operating-system Trash. This is destructive to their workspace locations but recoverable from Trash; the workspace root and paths outside it are always rejected.",
            object_schema(
                json!({
                    "paths": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 100,
                        "uniqueItems": true,
                        "items": { "type": "string", "minLength": 1, "maxLength": 1000 }
                    }
                }),
                &["paths"],
            ),
        ),
        definition(
            "comments.add",
            "comment_add",
            "Add a pseudo-XML review comment anchored to an exact text passage.",
            object_schema(
                json!({
                    "target": { "type": "string", "minLength": 1, "maxLength": 500 },
                    "anchor_text": { "type": "string", "minLength": 1, "maxLength": 2000 },
                    "text": { "type": "string", "minLength": 1, "maxLength": 4000 }
                }),
                &["target", "anchor_text", "text"],
            ),
        ),
        definition(
            "comments.reply",
            "comment_reply",
            "Reply to an existing pseudo-XML comment thread.",
            object_schema(
                json!({
                    "target": { "type": "string", "minLength": 1, "maxLength": 500 },
                    "comment_id": { "type": "string", "minLength": 1 },
                    "text": { "type": "string", "minLength": 1, "maxLength": 4000 }
                }),
                &["target", "comment_id", "text"],
            ),
        ),
        definition(
            "comments.resolve",
            "comment_resolve",
            "Resolve a pseudo-XML comment thread in the active editor without deleting it.",
            object_schema(
                json!({ "comment_id": { "type": "string", "minLength": 1 } }),
                &["comment_id"],
            ),
        ),
        definition(
            "comments.reopen",
            "comment_reopen",
            "Reopen a resolved pseudo-XML comment thread in the active editor.",
            object_schema(
                json!({ "comment_id": { "type": "string", "minLength": 1 } }),
                &["comment_id"],
            ),
        ),
        definition(
            "comments.delete",
            "comment_delete",
            "Delete a pseudo-XML comment thread while preserving its anchored document text.",
            object_schema(
                json!({ "comment_id": { "type": "string", "minLength": 1 } }),
                &["comment_id"],
            ),
        ),
        definition(
            "web.search",
            "search_web",
            "Search OpenAlex, Crossref, or arXiv and return source metadata.",
            object_schema(
                json!({
                    "source": { "enum": ["openalex", "crossref", "arxiv"] },
                    "query": { "type": "string", "minLength": 1, "maxLength": 500 },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 20 }
                }),
                &["source", "query"],
            ),
        ),
        definition(
            "shell.run",
            "shell",
            "Execute a bounded shell command in the workspace.",
            object_schema(
                json!({
                    "command": { "type": "string", "minLength": 1, "maxLength": 2000 },
                    "cwd": { "type": "string", "maxLength": 500 },
                    "timeout": { "type": "integer", "minimum": 1, "maximum": 120 }
                }),
                &["command"],
            ),
        ),
        editor_definition(
            "editor.open",
            "editor_open",
            "Open a file path in the attached editor.",
            json!({ "path": { "type": "string", "minLength": 1 } }),
            &["path"],
        ),
        editor_definition(
            "editor.state",
            "editor_state",
            "Get active editor state.",
            json!({ "include_content": { "type": "boolean" } }),
            &[],
        ),
        editor_definition(
            "editor.active",
            "editor_active",
            "Return active editor tab metadata and optional content.",
            json!({ "includeContent": { "type": "boolean" } }),
            &[],
        ),
        editor_definition(
            "editor.tabs",
            "editor_tabs",
            "List open editor tabs.",
            json!({}),
            &[],
        ),
        editor_definition(
            "editor.content",
            "editor_content",
            "Return active editor metadata and full content.",
            json!({}),
            &[],
        ),
        editor_definition(
            "editor.selection",
            "editor_selection",
            "Return active editor selection text and offsets.",
            json!({}),
            &[],
        ),
        editor_definition(
            "editor.comments",
            "editor_comments",
            "Return canonical pseudo-XML comments for the active document.",
            json!({}),
            &[],
        ),
        editor_definition(
            "editor.replace_selection",
            "editor_replace_selection",
            "Replace the active editor selection.",
            json!({ "text": { "type": "string" } }),
            &["text"],
        ),
        editor_definition(
            "editor.set_content",
            "editor_set_content",
            "Replace the full active editor document content.",
            json!({ "content": { "type": "string" } }),
            &["content"],
        ),
        editor_definition(
            "editor.reveal",
            "editor_reveal",
            "Reveal a file path, line, or offset in the editor.",
            json!({
                "path": { "type": "string" },
                "line": { "type": "number" },
                "offset": { "type": "number" }
            }),
            &[],
        ),
        editor_definition(
            "editor.propose",
            "editor_propose",
            "Propose one exact text replacement for review.",
            json!({
                "path": { "type": "string", "minLength": 1, "maxLength": 500 },
                "old_text": { "type": "string", "minLength": 1, "maxLength": 50000 },
                "new_text": { "type": "string", "maxLength": 50000 },
                "rationale": { "type": "string", "maxLength": 2000 }
            }),
            &["old_text", "new_text"],
        ),
        editor_definition(
            "editor.save",
            "editor_save",
            "Save the active editor file.",
            json!({}),
            &[],
        ),
        definition(
            "activities.list",
            "activities_list",
            "List durable terminal, agent, app, files, and routine activities.",
            object_schema(json!({}), &[]),
        ),
        definition(
            "activities.spawn",
            "activities_spawn",
            "Launch an activity from a complete activity record.",
            object_schema(
                json!({
                    "record": { "type": "object" },
                    "cols": { "type": "integer", "minimum": 1 },
                    "rows": { "type": "integer", "minimum": 1 }
                }),
                &["record"],
            ),
        ),
        definition(
            "activities.stop",
            "activities_stop",
            "Stop a live terminal, agent, or routine Activity.",
            object_schema(
                json!({ "activity_id": { "type": "string", "minLength": 1 } }),
                &["activity_id"],
            ),
        ),
        definition(
            "activities.rename",
            "activities_rename",
            "Rename an Activity without changing its stable identity.",
            object_schema(
                json!({
                    "activity_id": { "type": "string", "minLength": 1 },
                    "title": { "type": "string", "minLength": 1, "maxLength": 200 }
                }),
                &["activity_id", "title"],
            ),
        ),
        definition(
            "activities.archive",
            "activities_archive",
            "Archive or restore an ended durable Activity.",
            object_schema(
                json!({
                    "activity_id": { "type": "string", "minLength": 1 },
                    "archived": { "type": "boolean" }
                }),
                &["activity_id", "archived"],
            ),
        ),
        definition(
            "activities.clear",
            "activities_clear",
            "Permanently clear an ended Activity and its persisted scrollback.",
            object_schema(
                json!({ "activity_id": { "type": "string", "minLength": 1 } }),
                &["activity_id"],
            ),
        ),
        definition(
            "apps.list",
            "apps_list",
            "List discovered hackable Mimir apps.",
            object_schema(json!({}), &[]),
        ),
        definition(
            "apps.launch",
            "apps_launch",
            "Launch an installed app as an activity or app window.",
            object_schema(
                json!({
                    "app_id": { "type": "string", "minLength": 1 },
                    "mode": { "enum": ["embedded", "terminal", "process", "window", "rust-helper", "action"] }
                }),
                &["app_id"],
            ),
        ),
        definition(
            "apps.reload",
            "apps_reload",
            "Reload local app definitions and return the current catalog and diagnostics.",
            object_schema(json!({}), &[]),
        ),
        definition(
            "apps.create",
            "apps_create",
            "Create a usable local embedded app scaffold under ~/.mimir/apps.",
            object_schema(
                json!({
                    "id": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 64,
                        "pattern": "^[A-Za-z0-9_-]+$"
                    },
                    "title": { "type": "string", "minLength": 1, "maxLength": 120 },
                    "description": { "type": "string", "maxLength": 500 }
                }),
                &["id", "title"],
            ),
        ),
        definition(
            "apps.duplicate",
            "apps_duplicate",
            "Duplicate one local app definition and its package files under a new stable id.",
            object_schema(
                json!({
                    "app_id": { "type": "string", "minLength": 1, "maxLength": 64 },
                    "new_id": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 64,
                        "pattern": "^[A-Za-z0-9_-]+$"
                    },
                    "title": { "type": "string", "minLength": 1, "maxLength": 120 }
                }),
                &["app_id", "new_id"],
            ),
        ),
        definition(
            "apps.update",
            "apps_update",
            "Rename a local app's display title while preserving its stable id, data, tools, and activities.",
            object_schema(
                json!({
                    "app_id": { "type": "string", "minLength": 1, "maxLength": 64 },
                    "title": { "type": "string", "minLength": 1, "maxLength": 120 }
                }),
                &["app_id", "title"],
            ),
        ),
        definition(
            "apps.trash",
            "apps_trash",
            "Move one exact local app definition or package to the operating-system Trash.",
            object_schema(
                json!({ "app_id": { "type": "string", "minLength": 1, "maxLength": 64 } }),
                &["app_id"],
            ),
        ),
        definition(
            "routines.list",
            "routines_list",
            "List file-defined routines (scheduled and manual) and their next run.",
            object_schema(json!({}), &[]),
        ),
        definition(
            "routines.run",
            "routines_run",
            "Run a file-defined routine now as a durable activity.",
            object_schema(
                json!({ "routine_id": { "type": "string", "minLength": 1 } }),
                &["routine_id"],
            ),
        ),
        definition(
            "routines.create",
            "routines_create",
            "Create one canonical TOML-backed routine. Omit schedule for a manual-only routine that runs on demand. Set interactive for a live agent session seeded with the prompt instead of a headless one-shot run. The stable id also becomes its definition filename.",
            object_schema(
                json!({ "definition": routine_definition_schema() }),
                &["definition"],
            ),
        ),
        definition(
            "routines.update",
            "routines_update",
            "Atomically replace one routine definition while preserving its stable id. Pass the source_revision returned by routines.list; stale revisions are rejected.",
            object_schema(
                json!({
                    "routine_id": routine_id_schema(),
                    "expected_revision": { "type": "string", "minLength": 1, "maxLength": 128 },
                    "definition": routine_definition_schema()
                }),
                &["routine_id", "expected_revision", "definition"],
            ),
        ),
        definition(
            "routines.duplicate",
            "routines_duplicate",
            "Copy one routine to a new stable id. The copy is always created paused so it cannot accidentally double-fire.",
            object_schema(
                json!({
                    "routine_id": routine_id_schema(),
                    "expected_revision": { "type": "string", "minLength": 1, "maxLength": 128 },
                    "new_id": routine_id_schema(),
                    "title": { "type": "string", "minLength": 1, "maxLength": 200 }
                }),
                &["routine_id", "expected_revision", "new_id"],
            ),
        ),
        definition(
            "routines.trash",
            "routines_trash",
            "Move one exact routine TOML definition to the operating-system Trash. Pass its current source_revision; stale revisions are rejected. Live Activities are not killed.",
            object_schema(
                json!({
                    "routine_id": routine_id_schema(),
                    "expected_revision": { "type": "string", "minLength": 1, "maxLength": 128 }
                }),
                &["routine_id", "expected_revision"],
            ),
        ),
        definition(
            "settings.get",
            "settings_get",
            "Read current Mimir settings exposed by the renderer.",
            object_schema(
                json!({ "keys": { "type": "array", "items": { "type": "string" } } }),
                &[],
            ),
        ),
        definition(
            "settings.update",
            "settings_update",
            "Update Mimir settings and notify all windows.",
            object_schema(json!({ "values": { "type": "object" } }), &["values"]),
        ),
    ]
}

fn routine_id_schema() -> Value {
    json!({
        "type": "string",
        "minLength": 1,
        "maxLength": 64,
        "pattern": "^[A-Za-z0-9_-]+$"
    })
}

fn routine_definition_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "id": routine_id_schema(),
            "title": { "type": "string", "minLength": 1, "maxLength": 200 },
            "enabled": { "type": "boolean" },
            "schedule": { "type": ["string", "null"], "minLength": 1, "maxLength": 500 },
            "timezone": { "type": "string", "minLength": 1, "maxLength": 100 },
            "preset": { "type": "string", "minLength": 1, "maxLength": 100 },
            "prompt": { "type": "string", "minLength": 1, "maxLength": 100000 },
            "overlap": { "enum": ["skip", "parallel"] },
            "missed": { "enum": ["skip", "run-once"] },
            "workspace": { "type": ["string", "null"], "minLength": 1, "maxLength": 1000 },
            "interactive": { "type": "boolean" }
        },
        "required": ["id", "title", "preset", "prompt"]
    })
}

fn editor_definition(
    canonical_name: &str,
    alias: &str,
    description: &str,
    properties: Value,
    required: &[&str],
) -> DynamicToolDefinition {
    definition(
        canonical_name,
        alias,
        description,
        object_schema(properties, required),
    )
}

fn legacy_tool_aliases() -> Vec<&'static str> {
    vec![
        "read",
        "list",
        "search",
        "edit",
        "create",
        "comment_add",
        "comment_reply",
        "comment_resolve",
        "comment_reopen",
        "comment_delete",
        "search_web",
        "shell",
        "editor_open",
        "editor_active",
        "editor_tabs",
        "editor_content",
        "editor_selection",
        "editor_comments",
        "editor_replace_selection",
        "editor_set_content",
        "editor_reveal",
        "editor_save",
    ]
}

#[cfg(test)]
mod tests {
    use crate::tool_registry::{
        ToolCallContext, ToolDescriptor, ToolOwner, ToolRegistration, ToolSource,
    };

    use super::*;

    #[test]
    fn core_catalog_has_unique_names_aliases_and_required_domains() {
        let definitions = core_tool_definitions();
        let names: HashSet<_> = definitions
            .iter()
            .map(|definition| definition.canonical_name.as_str())
            .collect();
        let aliases: HashSet<_> = definitions
            .iter()
            .map(|definition| definition.mcp_alias.as_str())
            .collect();
        assert_eq!(names.len(), definitions.len());
        assert_eq!(aliases.len(), definitions.len());
        for namespace in [
            "files.",
            "editor.",
            "comments.",
            "activities.",
            "apps.",
            "routines.",
            "settings.",
        ] {
            assert!(
                definitions
                    .iter()
                    .any(|definition| definition.canonical_name.starts_with(namespace)),
                "missing {namespace} core tools"
            );
        }
        for removed_alias in ["annotate_docx", "show"] {
            assert!(
                definitions
                    .iter()
                    .all(|definition| definition.mcp_alias != removed_alias),
                "kill-listed alias {removed_alias} returned to the core catalog"
            );
        }
        let search = definitions
            .iter()
            .find(|definition| definition.canonical_name == "files.search")
            .unwrap();
        let rendered_schema = search.input_schema.to_string();
        assert!(!rendered_schema.contains("references"));
        assert!(!rendered_schema.contains("citations"));
        assert_eq!(
            search.input_schema["properties"]["limit"]["maximum"],
            json!(50)
        );
    }

    #[test]
    fn every_legacy_tool_maps_to_a_core_alias() {
        let aliases: HashSet<_> = core_tool_definitions()
            .into_iter()
            .map(|definition| definition.mcp_alias)
            .collect();
        for legacy in legacy_tool_aliases() {
            assert!(aliases.contains(legacy), "missing legacy alias {legacy}");
        }
    }

    #[test]
    fn routine_and_files_mutation_contracts_are_explicit_and_revision_safe() {
        let definitions = core_tool_definitions();
        let by_name = |name: &str| {
            definitions
                .iter()
                .find(|definition| definition.canonical_name == name)
                .unwrap()
        };

        assert_eq!(by_name("files.browse").mcp_alias, "files_browse");
        assert_eq!(
            by_name("files.create").mcp_alias,
            "create",
            "the existing text-file creation alias is backwards compatible"
        );
        let trash = by_name("files.trash");
        assert!(trash.description.contains("operating-system Trash"));
        assert!(trash.description.contains("workspace root"));
        assert_eq!(trash.input_schema["properties"]["paths"]["minItems"], 1);

        for name in [
            "routines.create",
            "routines.update",
            "routines.duplicate",
            "routines.trash",
        ] {
            assert!(by_name(name).mcp_alias.starts_with("routines_"));
        }
        let update = by_name("routines.update");
        assert!(update.input_schema["required"]
            .as_array()
            .unwrap()
            .contains(&json!("expected_revision")));
        assert_eq!(
            update.input_schema["properties"]["definition"]["additionalProperties"],
            json!(false)
        );
        assert!(by_name("routines.duplicate")
            .description
            .contains("created paused"));
    }

    #[test]
    fn local_app_operations_have_stable_namespaced_mcp_contracts() {
        let definitions = core_tool_definitions();
        let by_name = |name: &str| {
            definitions
                .iter()
                .find(|definition| definition.canonical_name == name)
                .unwrap()
        };
        for name in [
            "apps.reload",
            "apps.create",
            "apps.duplicate",
            "apps.update",
            "apps.trash",
        ] {
            assert_eq!(
                by_name(name).mcp_alias,
                name.replace('.', "_"),
                "{name} must use its stable namespaced alias"
            );
        }
        assert_eq!(
            by_name("apps.create").input_schema["properties"]["id"]["pattern"],
            json!("^[A-Za-z0-9_-]+$")
        );
        assert!(by_name("apps.update")
            .description
            .contains("preserving its stable id"));
        assert!(by_name("apps.trash")
            .description
            .contains("operating-system Trash"));
    }

    #[test]
    fn complete_core_catalog_is_accepted_by_canonical_registry() {
        let registry = ToolRegistry::new();
        for definition in core_tool_definitions() {
            let descriptor = ToolDescriptor::new(
                definition.canonical_name,
                definition.mcp_alias,
                definition.description,
                definition.input_schema,
                ToolOwner::Core,
                ToolSource::Ui,
            );
            registry
                .register(ToolRegistration::new(
                    descriptor,
                    |_context: ToolCallContext, _input: Value| async {
                        Ok(ToolResult::new(Value::Null))
                    },
                ))
                .unwrap();
        }
        assert_eq!(registry.list().len(), core_tool_definitions().len());
    }

    #[test]
    fn relay_timeouts_are_bounded() {
        assert_eq!(
            relay_timeout(Some(1)),
            Duration::from_millis(MIN_RELAY_TIMEOUT_MS)
        );
        assert_eq!(
            relay_timeout(Some(u64::MAX)),
            Duration::from_millis(MAX_RELAY_TIMEOUT_MS)
        );
    }
}
