use std::collections::HashMap;
use std::sync::Arc;

use axum::{
    extract::State,
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Json},
    routing::{get, post},
    Router,
};
use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tokio::sync::{oneshot, watch, Mutex};

pub struct ToolServerState {
    shutdown_tx: Mutex<Option<watch::Sender<bool>>>,
    port: Mutex<u16>,
    token: Mutex<String>,
    hub: Mutex<Option<Arc<ToolHub>>>,
}

impl Default for ToolServerState {
    fn default() -> Self {
        Self {
            shutdown_tx: Mutex::new(None),
            port: Mutex::new(0),
            token: Mutex::new(String::new()),
            hub: Mutex::new(None),
        }
    }
}

struct ToolHub {
    app_handle: tauri::AppHandle,
    pending: Mutex<HashMap<String, oneshot::Sender<ToolResponse>>>,
}

#[derive(Serialize)]
struct ToolRequest {
    id: String,
    tool: String,
    input: serde_json::Value,
    cwd: Option<String>,
}

#[derive(Deserialize, Clone)]
pub struct ToolResponse {
    pub result: Option<serde_json::Value>,
    pub error: Option<String>,
}

#[derive(Deserialize)]
struct CallBody {
    tool: String,
    input: Option<serde_json::Value>,
    cwd: Option<String>,
}

#[derive(Clone)]
struct AppState {
    hub: Arc<ToolHub>,
    token: String,
}

// ── Shared dispatch (event bridge) ───────────────────────────────

async fn dispatch(
    hub: &ToolHub,
    tool: &str,
    input: serde_json::Value,
    cwd: Option<String>,
    timeout_secs: u64,
) -> Result<ToolResponse, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();
    hub.pending.lock().await.insert(id.clone(), tx);

    let request = ToolRequest {
        id: id.clone(),
        tool: tool.to_string(),
        input,
        cwd,
    };

    if let Err(e) = hub.app_handle.emit("tool-call-request", &request) {
        hub.pending.lock().await.remove(&id);
        return Err(format!("Event emit failed: {}", e));
    }

    match tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), rx).await {
        Ok(Ok(resp)) => Ok(resp),
        Ok(Err(_)) => {
            hub.pending.lock().await.remove(&id);
            Err("Channel closed".into())
        }
        Err(_) => {
            hub.pending.lock().await.remove(&id);
            Err(format!("Timeout after {}s", timeout_secs))
        }
    }
}

// ── Bearer auth (legacy HTTP API only) ───────────────────────────

fn check_auth(
    headers: &HeaderMap,
    expected: &str,
) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
    let auth = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if let Some(token) = auth.strip_prefix("Bearer ") {
        if token == expected {
            return Ok(());
        }
    }
    Err((
        StatusCode::UNAUTHORIZED,
        Json(serde_json::json!({
            "error": "unauthorized",
            "message": "Missing or invalid Bearer token"
        })),
    ))
}

// ── Legacy HTTP API (kept for curl/debugging) ────────────────────

async fn handle_call(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CallBody>,
) -> impl IntoResponse {
    if let Err(e) = check_auth(&headers, &state.token) {
        return e.into_response();
    }
    match dispatch(
        &state.hub,
        &body.tool,
        body.input.unwrap_or(serde_json::json!({})),
        body.cwd,
        120,
    )
    .await
    {
        Ok(resp) if resp.error.is_some() => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "tool_error", "message": resp.error })),
        )
            .into_response(),
        Ok(resp) => Json(serde_json::json!({ "result": resp.result })).into_response(),
        Err(e) => (
            StatusCode::GATEWAY_TIMEOUT,
            Json(serde_json::json!({ "error": "timeout", "message": e })),
        )
            .into_response(),
    }
}

async fn handle_schema(State(state): State<AppState>, headers: HeaderMap) -> impl IntoResponse {
    if let Err(e) = check_auth(&headers, &state.token) {
        return e.into_response();
    }
    match dispatch(&state.hub, "__schema__", serde_json::json!({}), None, 10).await {
        Ok(resp) => Json(serde_json::json!({ "tools": resp.result })).into_response(),
        Err(e) => (
            StatusCode::GATEWAY_TIMEOUT,
            Json(serde_json::json!({ "error": "timeout", "message": e })),
        )
            .into_response(),
    }
}

// ── MCP (Model Context Protocol) ─────────────────────────────────

fn jsonrpc_ok(id: &serde_json::Value, result: serde_json::Value) -> serde_json::Value {
    serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn jsonrpc_err(id: &serde_json::Value, code: i32, message: &str) -> serde_json::Value {
    serde_json::json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

async fn handle_mcp(
    State(state): State<AppState>,
    Json(req): Json<serde_json::Value>,
) -> impl IntoResponse {
    let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let id = req.get("id").unwrap_or(&serde_json::Value::Null);

    if req.get("id").is_none() {
        return StatusCode::ACCEPTED.into_response();
    }

    match method {
        "initialize" => {
            let session_id = uuid::Uuid::new_v4().to_string();
            let body = jsonrpc_ok(
                id,
                serde_json::json!({
                    "protocolVersion": "2025-03-26",
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "shoulders", "version": "0.3.0" }
                }),
            );
            (
                [(
                    axum::http::header::HeaderName::from_static("mcp-session-id"),
                    axum::http::HeaderValue::from_str(&session_id).unwrap(),
                )],
                Json(body),
            )
                .into_response()
        }

        "tools/list" => {
            match dispatch(&state.hub, "__schema__", serde_json::json!({}), None, 10).await {
                Ok(resp) => {
                    let tools: Vec<serde_json::Value> = resp
                        .result
                        .as_ref()
                        .and_then(|v| v.as_array())
                        .map(|arr| {
                            arr.iter()
                                .map(|t| {
                                    serde_json::json!({
                                        "name": t.get("name"),
                                        "description": t.get("description"),
                                        "inputSchema": t.get("input_schema")
                                            .unwrap_or(&serde_json::json!({"type": "object"})),
                                    })
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    Json(jsonrpc_ok(id, serde_json::json!({ "tools": tools }))).into_response()
                }
                Err(e) => Json(jsonrpc_err(id, -32603, &e)).into_response(),
            }
        }

        "tools/call" => {
            let params = req.get("params").cloned().unwrap_or(serde_json::json!({}));
            let name = params.get("name").and_then(|n| n.as_str()).unwrap_or("");
            let arguments = params
                .get("arguments")
                .cloned()
                .unwrap_or(serde_json::json!({}));

            match dispatch(&state.hub, name, arguments, None, 120).await {
                Ok(resp) if resp.error.is_some() => Json(jsonrpc_ok(
                    id,
                    serde_json::json!({
                        "content": [{ "type": "text", "text": resp.error.unwrap() }],
                        "isError": true
                    }),
                ))
                .into_response(),
                Ok(resp) => {
                    let text = match resp.result {
                        Some(serde_json::Value::String(s)) => s,
                        Some(v) => serde_json::to_string_pretty(&v).unwrap_or_default(),
                        None => String::new(),
                    };
                    Json(jsonrpc_ok(
                        id,
                        serde_json::json!({
                            "content": [{ "type": "text", "text": text }]
                        }),
                    ))
                    .into_response()
                }
                Err(e) => Json(jsonrpc_err(id, -32603, &e)).into_response(),
            }
        }

        _ => Json(jsonrpc_err(id, -32601, "Method not found")).into_response(),
    }
}

// ── Server startup ───────────────────────────────────────────────

const DEFAULT_PORT: u16 = 17532;

async fn start_server(
    app: tauri::AppHandle,
    port: u16,
    token: String,
) -> Result<(Arc<ToolHub>, watch::Sender<bool>, u16), String> {
    let hub = Arc::new(ToolHub {
        app_handle: app,
        pending: Mutex::new(HashMap::new()),
    });

    let state = AppState {
        hub: hub.clone(),
        token,
    };

    let router = Router::new()
        .route("/api/tools/call", post(handle_call))
        .route("/api/tools", get(handle_schema))
        .route("/mcp", post(handle_mcp))
        .with_state(state);

    let addr: std::net::SocketAddr = ([127, 0, 0, 1], port).into();
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| format!("Failed to bind tool server on port {}: {}", port, e))?;

    let bound_port = listener
        .local_addr()
        .map_err(|e| format!("Failed to get local addr: {}", e))?
        .port();

    let (shutdown_tx, mut shutdown_rx) = watch::channel(false);

    tokio::spawn(async move {
        let server = axum::serve(listener, router);
        tokio::select! {
            result = server => {
                if let Err(e) = result {
                    eprintln!("[tool_server] Server error: {}", e);
                }
            }
            _ = shutdown_rx.changed() => {}
        }
    });

    eprintln!("[tool_server] MCP at http://127.0.0.1:{}/mcp", bound_port);
    Ok((hub, shutdown_tx, bound_port))
}

// ── Tauri commands ───────────────────────────────────────────────

#[tauri::command]
pub async fn tool_server_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, ToolServerState>,
    port: Option<u16>,
) -> Result<serde_json::Value, String> {
    if state.shutdown_tx.lock().await.is_some() {
        let p = *state.port.lock().await;
        let t = state.token.lock().await.clone();
        return Ok(serde_json::json!({ "port": p, "token": t }));
    }

    let port = port.unwrap_or(DEFAULT_PORT);
    let token = uuid::Uuid::new_v4().to_string();
    let (hub, shutdown_tx, bound_port) = start_server(app, port, token.clone()).await?;

    *state.hub.lock().await = Some(hub);
    *state.shutdown_tx.lock().await = Some(shutdown_tx);
    *state.port.lock().await = bound_port;
    *state.token.lock().await = token.clone();

    Ok(serde_json::json!({ "port": bound_port, "token": token }))
}

#[tauri::command]
pub async fn tool_server_stop(state: tauri::State<'_, ToolServerState>) -> Result<(), String> {
    let shutdown_tx = state.shutdown_tx.lock().await.take();
    if let Some(tx) = shutdown_tx {
        let _ = tx.send(true);
    }
    *state.hub.lock().await = None;
    *state.port.lock().await = 0;
    *state.token.lock().await = String::new();
    Ok(())
}

#[tauri::command]
pub async fn tool_server_status(
    state: tauri::State<'_, ToolServerState>,
) -> Result<serde_json::Value, String> {
    let running = state.shutdown_tx.lock().await.is_some();
    let port = *state.port.lock().await;
    Ok(serde_json::json!({ "running": running, "port": port }))
}

#[tauri::command]
pub async fn tool_call_response(
    state: tauri::State<'_, ToolServerState>,
    id: String,
    result: Option<serde_json::Value>,
    error: Option<String>,
) -> Result<(), String> {
    let hub = state.hub.lock().await;
    if let Some(hub) = hub.as_ref() {
        if let Some(tx) = hub.pending.lock().await.remove(&id) {
            let _ = tx.send(ToolResponse { result, error });
        }
    }
    Ok(())
}
