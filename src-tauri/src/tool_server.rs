use axum::{
    extract::State,
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Json},
    routing::{get, post},
    Router,
};
use serde::Deserialize;
use tokio::sync::{watch, Mutex};

use crate::{
    tool_registry::{
        RegistrySnapshot, ToolCallContext, ToolCaller, ToolError, ToolErrorCode, ToolRegistry,
        ToolResult,
    },
    tool_runtime::{self, ToolRuntime},
};

pub struct ToolServerState {
    shutdown_tx: Mutex<Option<watch::Sender<bool>>>,
    port: Mutex<u16>,
    token: Mutex<String>,
}

impl Default for ToolServerState {
    fn default() -> Self {
        Self {
            shutdown_tx: Mutex::new(None),
            port: Mutex::new(0),
            token: Mutex::new(String::new()),
        }
    }
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

// ── Legacy HTTP API (curl/debugging/mimx) ────────────────────────

async fn handle_call(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CallBody>,
) -> impl IntoResponse {
    if let Err(error) = check_auth(&headers, &state.token) {
        return error.into_response();
    }

    let context = ToolCallContext {
        request_id: body.request_id,
        caller: ToolCaller::Mimx,
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

fn mcp_tool_list(snapshot: &RegistrySnapshot) -> serde_json::Value {
    let tools: Vec<serde_json::Value> = snapshot
        .tools
        .iter()
        .map(|tool| {
            serde_json::json!({
                "name": tool.mcp_alias,
                "description": tool.description,
                "inputSchema": tool.input_schema,
                "_meta": {
                    "mim/canonicalName": tool.canonical_name,
                    "mim/owner": tool.owner,
                    "mim/source": tool.source,
                    "mim/registryRevision": snapshot.revision,
                }
            })
        })
        .collect();
    serde_json::json!({
        "tools": tools,
        "_meta": { "mim/registryRevision": snapshot.revision }
    })
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

async fn handle_mcp(
    State(state): State<AppState>,
    Json(request): Json<serde_json::Value>,
) -> impl IntoResponse {
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
            let session_id = uuid::Uuid::new_v4().to_string();
            let requested_protocol = request
                .pointer("/params/protocolVersion")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("2025-03-26");
            let body = jsonrpc_ok(
                id,
                serde_json::json!({
                    "protocolVersion": requested_protocol,
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "mim", "version": env!("CARGO_PKG_VERSION") }
                }),
            );
            (
                [(
                    axum::http::header::HeaderName::from_static("mcp-session-id"),
                    axum::http::HeaderValue::from_str(&session_id)
                        .expect("UUID is a valid header value"),
                )],
                Json(body),
            )
                .into_response()
        }
        "ping" => Json(jsonrpc_ok(id, serde_json::json!({}))).into_response(),
        "tools/list" => {
            let snapshot = state.registry.snapshot();
            Json(jsonrpc_ok(id, mcp_tool_list(&snapshot))).into_response()
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
            let context = ToolCallContext {
                request_id,
                caller: ToolCaller::Mcp,
                cwd: None,
                metadata: request
                    .pointer("/params/_meta")
                    .and_then(serde_json::Value::as_object)
                    .cloned()
                    .unwrap_or_default(),
            };
            let result = match state.registry.call(name, context, arguments).await {
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

async fn start_server(
    registry: ToolRegistry,
    port: u16,
    token: String,
) -> Result<(watch::Sender<bool>, u16), String> {
    let state = AppState { registry, token };
    let router = Router::new()
        .route("/api/tools/call", post(handle_call))
        .route("/api/tools", get(handle_schema))
        .route("/mcp", post(handle_mcp))
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

    tokio::spawn(async move {
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
    Ok((shutdown_tx, bound_port))
}

// ── Tauri commands ───────────────────────────────────────────────

#[tauri::command]
pub async fn tool_server_start(
    state: tauri::State<'_, ToolServerState>,
    registry: tauri::State<'_, ToolRegistry>,
    port: Option<u16>,
) -> Result<serde_json::Value, String> {
    if state.shutdown_tx.lock().await.is_some() {
        let port = *state.port.lock().await;
        let token = state.token.lock().await.clone();
        return Ok(serde_json::json!({ "port": port, "token": token }));
    }

    let requested_port = port.unwrap_or(DEFAULT_PORT);
    let token = uuid::Uuid::new_v4().to_string();
    let (shutdown_tx, bound_port) =
        start_server(registry.inner().clone(), requested_port, token.clone()).await?;

    *state.shutdown_tx.lock().await = Some(shutdown_tx);
    *state.port.lock().await = bound_port;
    *state.token.lock().await = token.clone();
    Ok(serde_json::json!({ "port": bound_port, "token": token }))
}

#[tauri::command]
pub async fn tool_server_stop(state: tauri::State<'_, ToolServerState>) -> Result<(), String> {
    if let Some(shutdown_tx) = state.shutdown_tx.lock().await.take() {
        let _ = shutdown_tx.send(true);
    }
    *state.port.lock().await = 0;
    *state.token.lock().await = String::new();
    Ok(())
}

#[tauri::command]
pub async fn tool_server_status(
    state: tauri::State<'_, ToolServerState>,
    registry: tauri::State<'_, ToolRegistry>,
) -> Result<serde_json::Value, String> {
    let running = state.shutdown_tx.lock().await.is_some();
    let port = *state.port.lock().await;
    Ok(serde_json::json!({
        "running": running,
        "port": port,
        "registryRevision": registry.revision(),
    }))
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
    fn mcp_list_uses_aliases_and_preserves_canonical_metadata() {
        let registry = ToolRegistry::new();
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
        let list = mcp_tool_list(&registry.snapshot());
        assert_eq!(list["tools"][0]["name"], "editor_selection");
        assert_eq!(
            list["tools"][0]["_meta"]["mim/canonicalName"],
            "editor.selection"
        );
        assert_eq!(list["_meta"]["mim/registryRevision"], 1);
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
            "editor.selection",
            "editor_selection",
            "Read selection",
            json!({
                "type": "object",
                "properties": { "includeText": { "type": "boolean" } },
                "additionalProperties": false
            }),
            ToolSource::Native,
            |context: ToolCallContext, input: serde_json::Value| async move {
                assert_eq!(context.caller, ToolCaller::Mcp);
                assert_eq!(context.request_id.as_deref(), Some("call-1"));
                Ok(ToolResult::new(json!({
                    "text": if input["includeText"] == true { "selected" } else { "" }
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
        assert_eq!(list_json["result"]["tools"][0]["name"], "editor_selection");

        let call_response = handle_mcp(
            State(state),
            Json(json!({
                "jsonrpc": "2.0",
                "id": "call-1",
                "method": "tools/call",
                "params": {
                    "name": "editor_selection",
                    "arguments": { "includeText": true }
                }
            })),
        )
        .await
        .into_response();
        let call_body = axum::body::to_bytes(call_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let call_json: serde_json::Value = serde_json::from_slice(&call_body).unwrap();
        assert_eq!(call_json["result"]["structuredContent"]["text"], "selected");
        assert_eq!(call_json["result"]["isError"], serde_json::Value::Null);
    }
}
