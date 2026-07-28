use axum::{
    body::Bytes,
    extract::{Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Json},
    routing::{get, post},
    Router,
};
use serde::Deserialize;
use std::collections::HashSet;
use tokio::{
    sync::{watch, Mutex},
    task::JoinHandle,
};

use crate::{
    tool_registry::{
        RegistrySnapshot, ToolCallContext, ToolCaller, ToolDescriptor, ToolError, ToolErrorCode,
        ToolRegistry, ToolResult,
    },
    tool_runtime::{self, ToolRuntime, LEAN_AGENT_TOOLS},
};

pub struct ToolServerState {
    lifecycle: Mutex<ToolServerLifecycle>,
}

impl Default for ToolServerState {
    fn default() -> Self {
        Self {
            lifecycle: Mutex::new(ToolServerLifecycle::default()),
        }
    }
}

#[derive(Default)]
struct ToolServerLifecycle {
    running: Option<RunningToolServer>,
}

struct RunningToolServer {
    shutdown_tx: watch::Sender<bool>,
    task: JoinHandle<()>,
    port: u16,
    token: String,
    clients: HashSet<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CallBody {
    tool: String,
    input: Option<serde_json::Value>,
    cwd: Option<String>,
    request_id: Option<String>,
}

#[derive(Clone)]
struct AppState {
    registry: ToolRegistry,
    token: String,
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpClientContext {
    activity_id: Option<String>,
    agent_id: Option<String>,
}

// ── Bearer auth (legacy HTTP API only) ───────────────────────────

fn check_auth(
    headers: &HeaderMap,
    expected: &str,
) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
    let auth = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if auth
        .strip_prefix("Bearer ")
        .is_some_and(|token| token == expected)
    {
        return Ok(());
    }
    Err((
        StatusCode::UNAUTHORIZED,
        Json(serde_json::json!({
            "error": "unauthorized",
            "message": "Missing or invalid Bearer token"
        })),
    ))
}

// ── Legacy HTTP API (curl/debugging/mimir) ────────────────────────

async fn handle_call(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    // Auth is decided before the body is parsed: the `Json` extractor would
    // otherwise reject a malformed body with 422 before `check_auth` ran.
    if let Err(error) = check_auth(&headers, &state.token) {
        return error.into_response();
    }

    let body: CallBody = match serde_json::from_slice(&body) {
        Ok(body) => body,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": "invalid_request",
                    "message": format!("Invalid JSON body: {error}"),
                })),
            )
                .into_response();
        }
    };

    let context = ToolCallContext {
        request_id: body.request_id,
        caller: ToolCaller::MimirCli,
        cwd: body.cwd,
        metadata: serde_json::Map::new(),
    };
    match state
        .registry
        .call(
            &body.tool,
            context,
            body.input.unwrap_or_else(|| serde_json::json!({})),
        )
        .await
    {
        Ok(result) => Json(serde_json::json!({
            "result": result.value,
            "displayText": result.display_text,
            "metadata": result.metadata,
        }))
        .into_response(),
        Err(error) => (
            http_status_for_tool_error(error.code),
            Json(serde_json::json!({
                "error": tool_error_name(error.code),
                "message": error.message,
                "data": error.data,
            })),
        )
            .into_response(),
    }
}

async fn handle_schema(State(state): State<AppState>, headers: HeaderMap) -> impl IntoResponse {
    if let Err(error) = check_auth(&headers, &state.token) {
        return error.into_response();
    }
    let snapshot = state.registry.snapshot();
    Json(serde_json::json!({
        "revision": snapshot.revision,
        "tools": legacy_tool_schema(&snapshot),
    }))
    .into_response()
}

fn legacy_tool_schema(snapshot: &RegistrySnapshot) -> Vec<serde_json::Value> {
    snapshot
        .tools
        .iter()
        .map(|tool| {
            serde_json::json!({
                "name": tool.mcp_alias,
                "canonical_name": tool.canonical_name,
                "description": tool.description,
                "input_schema": tool.input_schema,
                "owner": tool.owner,
                "source": tool.source,
            })
        })
        .collect()
}

fn http_status_for_tool_error(code: ToolErrorCode) -> StatusCode {
    match code {
        ToolErrorCode::NotFound => StatusCode::NOT_FOUND,
        ToolErrorCode::InvalidInput => StatusCode::BAD_REQUEST,
        ToolErrorCode::Cancelled => StatusCode::CONFLICT,
        ToolErrorCode::Timeout => StatusCode::GATEWAY_TIMEOUT,
        ToolErrorCode::Unavailable => StatusCode::SERVICE_UNAVAILABLE,
        ToolErrorCode::Handler | ToolErrorCode::Internal => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

fn tool_error_name(code: ToolErrorCode) -> &'static str {
    match code {
        ToolErrorCode::NotFound => "not_found",
        ToolErrorCode::InvalidInput => "invalid_input",
        ToolErrorCode::Cancelled => "cancelled",
        ToolErrorCode::Timeout => "timeout",
        ToolErrorCode::Unavailable => "unavailable",
        ToolErrorCode::Handler => "tool_error",
        ToolErrorCode::Internal => "internal",
    }
}

// ── MCP (Model Context Protocol) ─────────────────────────────────

const LATEST_PROTOCOL_VERSION: &str = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS: [&str; 2] = [LATEST_PROTOCOL_VERSION, "2025-03-26"];

fn negotiate_protocol_version(requested: Option<&str>) -> &'static str {
    requested
        .and_then(|version| {
            SUPPORTED_PROTOCOL_VERSIONS
                .iter()
                .copied()
                .find(|supported| supported == &version)
        })
        .unwrap_or(LATEST_PROTOCOL_VERSION)
}

fn jsonrpc_ok(id: &serde_json::Value, result: serde_json::Value) -> serde_json::Value {
    serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn jsonrpc_err(
    id: &serde_json::Value,
    code: i32,
    message: &str,
    data: Option<serde_json::Value>,
) -> serde_json::Value {
    let mut error = serde_json::json!({ "code": code, "message": message });
    if let Some(data) = data {
        error["data"] = data;
    }
    serde_json::json!({ "jsonrpc": "2.0", "id": id, "error": error })
}

fn mcp_tool_list(snapshot: &RegistrySnapshot, include_all: bool) -> serde_json::Value {
    let tools: Vec<serde_json::Value> = if include_all {
        snapshot.tools.iter().map(full_mcp_tool).collect()
    } else {
        LEAN_AGENT_TOOLS
            .iter()
            .filter_map(|(canonical_name, alias, description)| {
                snapshot
                    .tools
                    .iter()
                    .find(|tool| tool.canonical_name == *canonical_name)
                    .map(|tool| {
                        serde_json::json!({
                            "name": alias,
                            "description": description,
                            "inputSchema": tool.input_schema,
                        })
                    })
            })
            .collect()
    };
    serde_json::json!({
        "tools": tools,
        "_meta": {
            "mimir/registryRevision": snapshot.revision,
            "mimir/disclosure": if include_all { "all" } else { "core" },
        }
    })
}

fn full_mcp_tool(tool: &ToolDescriptor) -> serde_json::Value {
    let projection = LEAN_AGENT_TOOLS
        .iter()
        .find(|(canonical_name, _, _)| *canonical_name == tool.canonical_name);
    let name = projection
        .map(|(_, alias, _)| *alias)
        .unwrap_or(tool.mcp_alias.as_str());
    let description = projection
        .map(|(_, _, description)| *description)
        .unwrap_or(tool.description.as_str());
    serde_json::json!({
        "name": name,
        "description": description,
        "inputSchema": tool.input_schema,
        "_meta": {
            "mimir/canonicalName": tool.canonical_name,
            "mimir/owner": tool.owner,
            "mimir/source": tool.source,
        }
    })
}

fn resolve_mcp_tool_name(name: &str) -> &str {
    LEAN_AGENT_TOOLS
        .iter()
        .find(|(_, alias, _)| *alias == name)
        .map(|(canonical_name, _, _)| *canonical_name)
        .unwrap_or(name)
}

fn render_tool_result(result: ToolResult) -> serde_json::Value {
    let text = result.display_text.unwrap_or_else(|| match &result.value {
        serde_json::Value::String(value) => value.clone(),
        value => serde_json::to_string_pretty(value).unwrap_or_default(),
    });
    serde_json::json!({
        "content": [{ "type": "text", "text": text }],
        "structuredContent": result.value,
        "_meta": result.metadata,
    })
}

fn render_tool_error(error: ToolError) -> serde_json::Value {
    serde_json::json!({
        "content": [{ "type": "text", "text": error.message }],
        "structuredContent": {
            "error": tool_error_name(error.code),
            "message": error.message,
            "data": error.data,
        },
        "isError": true,
    })
}

#[cfg(test)]
async fn handle_mcp(
    State(state): State<AppState>,
    Json(request): Json<serde_json::Value>,
) -> axum::response::Response {
    handle_mcp_request(state, McpClientContext::default(), request).await
}

async fn handle_mcp_http(
    Query(client): Query<McpClientContext>,
    State(state): State<AppState>,
    Json(request): Json<serde_json::Value>,
) -> axum::response::Response {
    handle_mcp_request(state, client, request).await
}

async fn handle_mcp_request(
    state: AppState,
    client: McpClientContext,
    request: serde_json::Value,
) -> axum::response::Response {
    let method = request
        .get("method")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let Some(id) = request.get("id") else {
        // Notifications are accepted and intentionally have no response body.
        return StatusCode::ACCEPTED.into_response();
    };

    match method {
        "initialize" => {
            let protocol_version = negotiate_protocol_version(
                request
                    .pointer("/params/protocolVersion")
                    .and_then(serde_json::Value::as_str),
            );
            Json(jsonrpc_ok(
                id,
                serde_json::json!({
                    "protocolVersion": protocol_version,
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "mimir", "version": env!("CARGO_PKG_VERSION") }
                }),
            ))
            .into_response()
        }
        "ping" => Json(jsonrpc_ok(id, serde_json::json!({}))).into_response(),
        "tools/list" => {
            let snapshot = state.registry.snapshot();
            let include_all = request
                .pointer("/params/includeAll")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            Json(jsonrpc_ok(id, mcp_tool_list(&snapshot, include_all))).into_response()
        }
        "tools/call" => {
            let Some(name) = request
                .pointer("/params/name")
                .and_then(serde_json::Value::as_str)
            else {
                return Json(jsonrpc_err(id, -32602, "Missing tool name", None)).into_response();
            };
            let arguments = request
                .pointer("/params/arguments")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            let request_id = match id {
                serde_json::Value::String(value) => Some(value.clone()),
                serde_json::Value::Number(value) => Some(value.to_string()),
                _ => None,
            };
            let mut metadata = request
                .pointer("/params/_meta")
                .and_then(serde_json::Value::as_object)
                .cloned()
                .unwrap_or_default();
            if let Some(activity_id) = client.activity_id {
                metadata
                    .entry("activityId")
                    .or_insert(serde_json::Value::String(activity_id));
            }
            if let Some(agent_id) = client.agent_id {
                metadata
                    .entry("agentId")
                    .or_insert(serde_json::Value::String(agent_id));
            }
            let context = ToolCallContext {
                request_id,
                caller: ToolCaller::Mcp,
                cwd: None,
                metadata,
            };
            let result = match state
                .registry
                .call(resolve_mcp_tool_name(name), context, arguments)
                .await
            {
                Ok(result) => render_tool_result(result),
                Err(error) => render_tool_error(error),
            };
            Json(jsonrpc_ok(id, result)).into_response()
        }
        _ => Json(jsonrpc_err(id, -32601, "Method not found", None)).into_response(),
    }
}

// ── Server startup ───────────────────────────────────────────────

const DEFAULT_PORT: u16 = 17532;

/// Boot the loopback tool server. Public so integration tests (see
/// `tests/mimir_contract.rs`) can run the real transport against an
/// ephemeral port; production code goes through [`tool_server_start`].
pub async fn start_server(
    registry: ToolRegistry,
    port: u16,
    token: String,
) -> Result<(watch::Sender<bool>, JoinHandle<()>, u16), String> {
    let state = AppState { registry, token };
    let router = Router::new()
        .route("/api/tools/call", post(handle_call))
        .route("/api/tools", get(handle_schema))
        .route("/mcp", post(handle_mcp_http))
        .with_state(state);

    let address: std::net::SocketAddr = ([127, 0, 0, 1], port).into();
    let listener = tokio::net::TcpListener::bind(address)
        .await
        .map_err(|error| format!("Failed to bind tool server on port {port}: {error}"))?;
    let bound_port = listener
        .local_addr()
        .map_err(|error| format!("Failed to get tool server address: {error}"))?
        .port();
    let (shutdown_tx, mut shutdown_rx) = watch::channel(false);

    let task = tokio::spawn(async move {
        let server = axum::serve(listener, router);
        tokio::select! {
            result = server => {
                if let Err(error) = result {
                    eprintln!("[tool_server] Server error: {error}");
                }
            }
            _ = shutdown_rx.changed() => {}
        }
    });
    eprintln!("[tool_server] MCP at http://127.0.0.1:{bound_port}/mcp");
    Ok((shutdown_tx, task, bound_port))
}

// ── Tauri commands ───────────────────────────────────────────────

fn runtime_client_id(client_id: Option<String>) -> String {
    client_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "legacy-renderer".into())
}

async fn acquire_server(
    state: &ToolServerState,
    registry: ToolRegistry,
    port: Option<u16>,
    client_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let client_id = runtime_client_id(client_id);
    let mut lifecycle = state.lifecycle.lock().await;
    if let Some(running) = lifecycle.running.as_mut() {
        running.clients.insert(client_id);
        return Ok(serde_json::json!({
            "port": running.port,
            "token": running.token,
            "clients": running.clients.len(),
        }));
    }

    let requested_port = port.unwrap_or(DEFAULT_PORT);
    let token = uuid::Uuid::new_v4().to_string();
    let (shutdown_tx, task, bound_port) =
        start_server(registry, requested_port, token.clone()).await?;
    let clients = HashSet::from([client_id]);
    lifecycle.running = Some(RunningToolServer {
        shutdown_tx,
        task,
        port: bound_port,
        token: token.clone(),
        clients,
    });
    Ok(serde_json::json!({ "port": bound_port, "token": token, "clients": 1 }))
}

async fn stop_running_server(running: RunningToolServer) {
    let _ = running.shutdown_tx.send(true);
    let _ = running.task.await;
}

async fn release_server(state: &ToolServerState, client_id: Option<String>) {
    let client_id = runtime_client_id(client_id);
    let mut lifecycle = state.lifecycle.lock().await;
    let Some(running) = lifecycle.running.as_mut() else {
        return;
    };
    running.clients.remove(&client_id);
    if !running.clients.is_empty() {
        return;
    }
    if let Some(running) = lifecycle.running.take() {
        // Keep the lifecycle lock until the listener has actually closed so a
        // dev-HMR replacement cannot race a new bind against the old server.
        stop_running_server(running).await;
    }
}

pub(crate) async fn shutdown_all(state: &ToolServerState) {
    let mut lifecycle = state.lifecycle.lock().await;
    if let Some(running) = lifecycle.running.take() {
        stop_running_server(running).await;
    }
}

async fn server_status(state: &ToolServerState, revision: u64) -> serde_json::Value {
    let lifecycle = state.lifecycle.lock().await;
    let running = lifecycle.running.as_ref();
    serde_json::json!({
        "running": running.is_some(),
        "port": running.map_or(0, |server| server.port),
        "clients": running.map_or(0, |server| server.clients.len()),
        "registryRevision": revision,
    })
}

#[tauri::command]
pub async fn tool_server_start(
    state: tauri::State<'_, ToolServerState>,
    registry: tauri::State<'_, ToolRegistry>,
    port: Option<u16>,
    client_id: Option<String>,
) -> Result<serde_json::Value, String> {
    acquire_server(state.inner(), registry.inner().clone(), port, client_id).await
}

#[tauri::command]
pub async fn tool_server_stop(
    state: tauri::State<'_, ToolServerState>,
    client_id: Option<String>,
) -> Result<(), String> {
    release_server(state.inner(), client_id).await;
    Ok(())
}

#[tauri::command]
pub async fn tool_server_status(
    state: tauri::State<'_, ToolServerState>,
    registry: tauri::State<'_, ToolRegistry>,
) -> Result<serde_json::Value, String> {
    Ok(server_status(state.inner(), registry.revision()).await)
}

/// Compatibility response command used by the existing editor tool service.
#[tauri::command]
pub async fn tool_call_response(
    runtime: tauri::State<'_, ToolRuntime>,
    id: String,
    result: Option<serde_json::Value>,
    error: Option<String>,
) -> Result<(), String> {
    tool_runtime::resolve_legacy_response(runtime.inner(), id, result, error).await
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::{
        tool_bridge::register_core_tool,
        tool_registry::{ToolCallContext, ToolOwner, ToolSource},
    };

    use super::*;

    #[test]
    fn mcp_list_is_lean_by_default_and_full_on_request() {
        let registry = ToolRegistry::new();
        register_core_tool(
            &registry,
            "editor.state",
            "editor_state",
            "Verbose internal state description",
            json!({ "type": "object" }),
            ToolSource::Native,
            |_context: ToolCallContext, _input| async {
                Ok(ToolResult::new(json!({ "text": "hello" })))
            },
        )
        .unwrap();
        register_core_tool(
            &registry,
            "editor.selection",
            "editor_selection",
            "Read selection",
            json!({ "type": "object" }),
            ToolSource::Native,
            |_context: ToolCallContext, _input| async {
                Ok(ToolResult::new(json!({ "text": "hello" })))
            },
        )
        .unwrap();

        let list = mcp_tool_list(&registry.snapshot(), false);
        assert_eq!(list["tools"].as_array().unwrap().len(), 1);
        assert_eq!(list["tools"][0]["name"], "mimir_state");
        assert_eq!(list["tools"][0]["description"], "Get active editor state.");
        assert!(list["tools"][0].get("_meta").is_none());
        assert_eq!(list["_meta"]["mimir/disclosure"], "core");

        let full = mcp_tool_list(&registry.snapshot(), true);
        assert_eq!(full["tools"].as_array().unwrap().len(), 2);
        assert_eq!(
            full["tools"][0]["_meta"]["mimir/canonicalName"],
            "editor.selection",
        );
        let projected_state = full["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["_meta"]["mimir/canonicalName"] == "editor.state")
            .unwrap();
        assert_eq!(projected_state["name"], "mimir_state");
        assert_eq!(projected_state["description"], "Get active editor state.");
        assert_eq!(full["_meta"]["mimir/registryRevision"], 2);
        assert_eq!(full["_meta"]["mimir/disclosure"], "all");
    }

    #[test]
    fn structured_tool_errors_remain_mcp_tool_results() {
        let rendered = render_tool_error(
            ToolError::new(ToolErrorCode::InvalidInput, "path is required")
                .with_data(json!({ "path": "$.path" })),
        );
        assert_eq!(rendered["isError"], true);
        assert_eq!(rendered["structuredContent"]["error"], "invalid_input");
        assert_eq!(rendered["structuredContent"]["data"]["path"], "$.path");
    }

    #[test]
    fn protocol_negotiation_accepts_supported_versions_and_rejects_blind_echoes() {
        assert_eq!(negotiate_protocol_version(Some("2025-03-26")), "2025-03-26");
        assert_eq!(
            negotiate_protocol_version(Some("2025-06-18")),
            LATEST_PROTOCOL_VERSION
        );
        assert_eq!(
            negotiate_protocol_version(Some("2099-01-01")),
            LATEST_PROTOCOL_VERSION
        );
        assert_eq!(negotiate_protocol_version(None), LATEST_PROTOCOL_VERSION);
    }

    #[tokio::test]
    async fn initialize_is_stateless_and_returns_the_negotiated_version() {
        let state = AppState {
            registry: ToolRegistry::new(),
            token: "unused-for-mcp".into(),
        };
        let response = handle_mcp(
            State(state),
            Json(json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": { "protocolVersion": "2099-01-01" }
            })),
        )
        .await
        .into_response();

        assert!(response.headers().get("mcp-session-id").is_none());
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["result"]["protocolVersion"], LATEST_PROTOCOL_VERSION);
        assert_eq!(json["result"]["capabilities"]["tools"], json!({}));
    }

    #[tokio::test]
    async fn notifications_are_accepted_without_a_jsonrpc_body() {
        let state = AppState {
            registry: ToolRegistry::new(),
            token: "unused-for-mcp".into(),
        };
        let response = handle_mcp(
            State(state),
            Json(json!({
                "jsonrpc": "2.0",
                "method": "notifications/initialized"
            })),
        )
        .await
        .into_response();

        assert_eq!(response.status(), StatusCode::ACCEPTED);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert!(body.is_empty());
    }

    #[tokio::test]
    async fn renderer_leases_survive_hmr_and_release_the_port_before_restart() {
        let state = ToolServerState::default();
        let registry = ToolRegistry::new();

        let first = acquire_server(
            &state,
            registry.clone(),
            Some(0),
            Some("renderer-old".into()),
        )
        .await
        .unwrap();
        let port = first["port"].as_u64().unwrap() as u16;
        assert_ne!(port, 0);

        let second = acquire_server(
            &state,
            registry.clone(),
            Some(0),
            Some("renderer-new".into()),
        )
        .await
        .unwrap();
        assert_eq!(second["port"], first["port"]);
        assert_eq!(second["clients"], 2);

        release_server(&state, Some("renderer-old".into())).await;
        let active = server_status(&state, registry.revision()).await;
        assert_eq!(active["running"], true);
        assert_eq!(active["clients"], 1);

        release_server(&state, Some("renderer-new".into())).await;
        assert_eq!(
            server_status(&state, registry.revision()).await["running"],
            false
        );

        let restarted = acquire_server(
            &state,
            registry.clone(),
            Some(port),
            Some("renderer-restarted".into()),
        )
        .await
        .unwrap();
        assert_eq!(restarted["port"], port);
        shutdown_all(&state).await;
    }

    #[test]
    fn legacy_schema_is_deterministic_and_contains_owner() {
        let registry = ToolRegistry::new();
        register_core_tool(
            &registry,
            "files.read",
            "read",
            "Read file",
            json!({ "type": "object" }),
            ToolSource::Native,
            |_context: ToolCallContext, _input| async { Ok(ToolResult::new(json!(null))) },
        )
        .unwrap();
        let schema = legacy_tool_schema(&registry.snapshot());
        assert_eq!(schema[0]["name"], "read");
        assert_eq!(schema[0]["canonical_name"], "files.read");
        assert_eq!(schema[0]["owner"]["kind"], "core");
        assert_eq!(registry.list()[0].owner, ToolOwner::Core);
    }

    #[tokio::test]
    async fn mcp_endpoint_lists_and_calls_the_canonical_registry() {
        let registry = ToolRegistry::new();
        register_core_tool(
            &registry,
            "editor.state",
            "editor_state",
            "Read state",
            json!({
                "type": "object",
                "properties": { "include_content": { "type": "boolean" } },
                "additionalProperties": false
            }),
            ToolSource::Native,
            |context: ToolCallContext, input: serde_json::Value| async move {
                assert_eq!(context.caller, ToolCaller::Mcp);
                assert_eq!(context.request_id.as_deref(), Some("call-1"));
                Ok(ToolResult::new(json!({
                    "content": if input["include_content"] == true { "document" } else { "" }
                })))
            },
        )
        .unwrap();
        let state = AppState {
            registry,
            token: "unused-for-mcp".into(),
        };

        let list_response = handle_mcp(
            State(state.clone()),
            Json(json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" })),
        )
        .await
        .into_response();
        let list_body = axum::body::to_bytes(list_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let list_json: serde_json::Value = serde_json::from_slice(&list_body).unwrap();
        assert_eq!(list_json["result"]["tools"][0]["name"], "mimir_state");

        let call_response = handle_mcp(
            State(state),
            Json(json!({
                "jsonrpc": "2.0",
                "id": "call-1",
                "method": "tools/call",
                "params": {
                    "name": "mimir_state",
                    "arguments": { "include_content": true }
                }
            })),
        )
        .await
        .into_response();
        let call_body = axum::body::to_bytes(call_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let call_json: serde_json::Value = serde_json::from_slice(&call_body).unwrap();
        assert_eq!(
            call_json["result"]["structuredContent"]["content"],
            "document"
        );
        assert_eq!(call_json["result"]["isError"], serde_json::Value::Null);
    }
}
