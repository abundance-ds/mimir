//! End-to-end MCP contract tests between the `mimir` Node CLI and the Rust
//! tool server.
//!
//! Each test boots the real axum tool server ([`mimir::tool_server`])
//! on an ephemeral loopback port with synthetic core tools, then
//! exercises the wire protocol either through the actual `bin/mimir.mjs` CLI
//! (spawned via `node`) or through raw JSON-RPC over HTTP. This catches
//! protocol and serialization drift that the isolated unit tests on either
//! side cannot see.

use std::path::PathBuf;
use std::process::Output;

use serde_json::{json, Value};
use tokio::{sync::watch, task::JoinHandle};

use mimir::{
    tool_bridge::register_core_tool,
    tool_registry::{ToolCallContext, ToolRegistry, ToolResult, ToolSource},
    tool_server::start_server,
};

const TEST_TOKEN: &str = "contract-test-token";

/// A minimal registry with five synthetic core tools:
///
/// * `graph.get` (`graph_get`) — returns input plus caller metadata, so tests
///   can assert on public-tool round-trips and transport-assigned context.
/// * `graph.events` (`graph_events`) — proves graph history survives the public
///   allowlist and CLI transport rather than existing only as a private handler.
/// * `editor.state` (`editor_state`) — backs the direct `mimir_state` tool.
/// * `graph.status` (`graph_status`) — supplies scopes for `mimir doctor`.
/// * `meetings.get` (`meetings_get`) — keeps the focused Scribe drawer backed.
fn test_registry() -> ToolRegistry {
    let registry = ToolRegistry::new();
    register_core_tool(
        &registry,
        "graph.get",
        "graph_get",
        "Get one graph node.",
        json!({
            "type": "object",
            "properties": { "id": { "type": "string", "minLength": 1 } },
            "required": ["id"],
            "additionalProperties": false
        }),
        ToolSource::Native,
        |context: ToolCallContext, input: Value| async move {
            Ok(ToolResult::new(json!({
                "id": input["id"],
                "caller": serde_json::to_value(&context.caller).expect("caller serializes"),
                "requestId": context.request_id,
            })))
        },
    )
    .expect("register graph.get");
    register_core_tool(
        &registry,
        "graph.events",
        "graph_events",
        "List recent graph events.",
        json!({
            "type": "object",
            "properties": {
                "scopeIds": {
                    "type": "array",
                    "items": { "type": "string" }
                },
                "since": { "type": "string" },
                "offset": { "type": "integer", "minimum": 0 },
                "limit": { "type": "integer", "minimum": 1, "maximum": 500 }
            },
            "additionalProperties": false
        }),
        ToolSource::Native,
        |context: ToolCallContext, input: Value| async move {
            Ok(ToolResult::new(json!({
                "items": [{
                    "id": "event-contract",
                    "action": "graph.update",
                    "scopeId": input["scopeIds"][0],
                    "since": input["since"],
                }],
                "offset": input["offset"],
                "limit": input["limit"],
                "caller": serde_json::to_value(&context.caller).expect("caller serializes"),
            })))
        },
    )
    .expect("register graph.events");
    register_core_tool(
        &registry,
        "editor.state",
        "editor_state",
        "Get active editor state.",
        json!({
            "type": "object",
            "properties": { "include_content": { "type": "boolean" } },
            "additionalProperties": false
        }),
        ToolSource::Native,
        |_context: ToolCallContext, input: Value| async move {
            Ok(ToolResult::new(json!({
                "path": "/workspace/README.md",
                "content": if input["include_content"] == true { "# Contract" } else { "" },
            })))
        },
    )
    .expect("register editor.state");
    register_core_tool(
        &registry,
        "graph.status",
        "graph_status",
        "Get mounted graph scopes.",
        json!({
            "type": "object",
            "properties": {},
            "additionalProperties": false
        }),
        ToolSource::Native,
        |_context: ToolCallContext, _input: Value| async move {
            Ok(ToolResult::new(json!({
                "scopes": [
                    { "id": "private:local" },
                    { "id": "project:contract" }
                ]
            })))
        },
    )
    .expect("register graph.status");
    register_core_tool(
        &registry,
        "meetings.get",
        "meetings_get",
        "Read one Mimir Scribe meeting.",
        json!({
            "type": "object",
            "properties": {
                "meeting_id": { "type": "string", "minLength": 1 }
            },
            "required": ["meeting_id"],
            "additionalProperties": false
        }),
        ToolSource::Native,
        |_context: ToolCallContext, input: Value| async move {
            Ok(ToolResult::new(json!({
                "id": input["meeting_id"],
                "title": "Contract meeting"
            })))
        },
    )
    .expect("register meetings.get");
    registry
}

struct TestServer {
    port: u16,
    shutdown_tx: watch::Sender<bool>,
    task: JoinHandle<()>,
}

impl TestServer {
    async fn boot() -> Self {
        // Contract tests must never touch or prompt for the developer's real
        // OS keychain now that production macOS builds use the native backend.
        keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
        let (shutdown_tx, task, port) = start_server(test_registry(), 0, TEST_TOKEN.into())
            .await
            .expect("tool server boots on an ephemeral port");
        Self {
            port,
            shutdown_tx,
            task,
        }
    }

    fn mcp_url(&self) -> String {
        format!("http://127.0.0.1:{}/mcp", self.port)
    }

    fn api_url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }

    async fn shutdown(self) {
        let _ = self.shutdown_tx.send(true);
        let _ = self.task.await;
    }
}

/// Run `node bin/mimir.mjs <args…>` against the test server. Returns `None`
/// when `node` is not on PATH so environments without Node skip gracefully.
async fn run_mimir(mcp_url: &str, args: &[&str]) -> Option<Output> {
    let cli = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri has a parent directory")
        .join("bin/mimir.mjs");
    let url = mcp_url.to_string();
    let args: Vec<String> = args.iter().map(|value| value.to_string()).collect();
    let result = tokio::task::spawn_blocking(move || {
        std::process::Command::new("node")
            .arg(cli)
            .args(&args)
            .env("MIMIR_MCP_URL", url)
            .output()
    })
    .await
    .expect("spawn_blocking completes");
    match result {
        Ok(output) => Some(output),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => panic!("failed to launch node: {error}"),
    }
}

/// Reserve an ephemeral port and immediately release it, yielding a loopback
/// port with (almost certainly) no listener behind it.
fn unused_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
    let port = listener
        .local_addr()
        .expect("listener has a local addr")
        .port();
    drop(listener);
    port
}

fn stdout_of(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn stderr_of(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

fn assert_success(output: &Output, label: &str) {
    assert_eq!(
        output.status.code(),
        Some(0),
        "{label} should exit 0; stderr: {}",
        stderr_of(output),
    );
}

#[tokio::test]
async fn mimir_cli_discovers_and_calls_tools_over_the_wire() {
    let server = TestServer::boot().await;
    let url = server.mcp_url();

    // `mimir tools` — one concise list of every public tool currently backed
    // by the registry.
    let Some(lean) = run_mimir(&url, &["tools"]).await else {
        eprintln!("skipping mimir contract test: `node` is not on PATH");
        server.shutdown().await;
        return;
    };
    assert_success(&lean, "mimir tools");
    let lean_stdout = stdout_of(&lean);
    assert!(
        lean_stdout.contains("mimir_state"),
        "listing should project editor.state as mimir_state, got: {lean_stdout}",
    );
    assert!(
        lean_stdout.contains("graph_get")
            && lean_stdout.contains("WORKBENCH")
            && lean_stdout.contains("GRAPH"),
        "listing should group every public tool, got: {lean_stdout}",
    );
    assert!(
        lean_stdout.contains("mimir tools workbench") && lean_stdout.contains("mimir tools graph"),
        "the global catalog should advertise focused drawers, got: {lean_stdout}",
    );

    let graph_drawer = run_mimir(&url, &["tools", "graph"]).await.unwrap();
    assert_success(&graph_drawer, "mimir tools graph");
    let graph_stdout = stdout_of(&graph_drawer);
    assert!(graph_stdout.starts_with("GRAPH\n\n"));
    assert!(graph_stdout.contains("graph_get id  [read]"));
    assert!(graph_stdout.contains("graph_events"));
    assert!(graph_stdout.contains("graph_get.sourceRevision"));
    assert!(!graph_stdout.contains("mimir_state"));

    let meetings_drawer = run_mimir(&url, &["tools", "meetings"]).await.unwrap();
    assert_success(&meetings_drawer, "mimir tools meetings");
    let meetings_stdout = stdout_of(&meetings_drawer);
    assert!(meetings_stdout.starts_with("MEETINGS\n\n"));
    assert!(meetings_stdout.contains("meetings_get"));
    assert!(meetings_stdout.contains("meetings_delete"));
    assert!(meetings_stdout.contains("explicit user request"));
    assert!(meetings_stdout.contains("Recording controls remain human-only"));
    assert!(!meetings_stdout.contains("meetings_start"));
    assert!(!meetings_stdout.contains("meetings_stop"));

    let graph_json = run_mimir(&url, &["tools", "graph", "--json"])
        .await
        .unwrap();
    assert_success(&graph_json, "mimir tools graph --json");
    let graph_catalog: Value =
        serde_json::from_str(stdout_of(&graph_json).trim()).expect("drawer JSON");
    assert!(graph_catalog
        .as_array()
        .is_some_and(|tools| !tools.is_empty()
            && tools
                .iter()
                .all(|tool| tool["_meta"]["mimir/group"] == "graph")));

    let unknown_drawer = run_mimir(&url, &["tools", "unknown"]).await.unwrap();
    assert_eq!(unknown_drawer.status.code(), Some(1));
    assert!(stderr_of(&unknown_drawer).contains("Unknown tool group 'unknown'"));

    // There is no second, hidden "all" catalog.
    let old_all = run_mimir(&url, &["tools", "--all"]).await.unwrap();
    assert_eq!(old_all.status.code(), Some(1));
    assert!(stderr_of(&old_all).contains("Unknown option: --all"));

    // Focused discovery returns the exact inputs and a ready call without a
    // catalog dump or trial invocation.
    let focused = run_mimir(&url, &["tool", "graph_get"]).await.unwrap();
    assert_success(&focused, "mimir tool graph_get");
    let focused_stdout = stdout_of(&focused);
    assert!(focused_stdout.contains("graph_get — Read one complete graph node."));
    assert!(focused_stdout.contains("Required:\n  id: string"));
    assert!(focused_stdout.contains("mimir call graph_get"));
    assert!(!focused_stdout.contains("graph_status"));

    let focused_help = run_mimir(&url, &["call", "graph_get", "--help"])
        .await
        .unwrap();
    assert_success(&focused_help, "mimir call graph_get --help");
    assert_eq!(stdout_of(&focused_help), focused_stdout);

    // Command-family help is parsed before any network access.
    let offline_help = run_mimir(
        "http://127.0.0.1:1/mcp?activityId=secret",
        &["call", "--help"],
    )
    .await
    .unwrap();
    assert_success(&offline_help, "mimir call --help");
    assert!(stdout_of(&offline_help).contains("Usage: mimir call"));

    // `mimir call` — arguments in, structuredContent out, transport metadata
    // (caller + request id) assigned by the server.
    let call = run_mimir(&url, &["call", "graph_get", r#"{"id":"round-trip"}"#])
        .await
        .unwrap();
    assert_success(&call, "mimir call graph_get");
    let payload: Value =
        serde_json::from_str(stdout_of(&call).trim()).expect("mimir call prints JSON");
    assert_eq!(payload["id"], "round-trip");
    assert_eq!(payload["caller"]["kind"], "mcp");
    assert!(
        payload["requestId"]
            .as_str()
            .is_some_and(|id| !id.is_empty()),
        "server should derive request_id from the JSON-RPC id, got: {payload}",
    );

    let events = run_mimir(
        &url,
        &[
            "call",
            "graph_events",
            r#"{"scopeIds":["project:contract"],"since":"2026-07-01T00:00:00Z","offset":0,"limit":50}"#,
        ],
    )
    .await
    .unwrap();
    assert_success(&events, "mimir call graph_events");
    let event_payload: Value =
        serde_json::from_str(stdout_of(&events).trim()).expect("graph_events prints JSON");
    assert_eq!(event_payload["items"][0]["id"], "event-contract");
    assert_eq!(event_payload["items"][0]["scopeId"], "project:contract");
    assert_eq!(event_payload["items"][0]["since"], "2026-07-01T00:00:00Z");
    assert_eq!(event_payload["limit"], 50);

    // Schema violations surface as CLI errors (exit 1, message on stderr).
    let invalid = run_mimir(&url, &["call", "graph_get", "{}"]).await.unwrap();
    assert_eq!(invalid.status.code(), Some(1), "invalid input should fail");
    assert!(
        stderr_of(&invalid).contains("invalid input for 'graph_get'"),
        "stderr should carry the structured validation message, got: {}",
        stderr_of(&invalid),
    );

    // Unknown tools surface the exact rejected name.
    let missing = run_mimir(&url, &["call", "no_such_tool", "{}"])
        .await
        .unwrap();
    assert_eq!(missing.status.code(), Some(1), "missing tool should fail");
    assert!(
        stderr_of(&missing).contains("Unknown tool 'no_such_tool'."),
        "stderr should carry the not-found message, got: {}",
        stderr_of(&missing),
    );

    server.shutdown().await;
}

#[tokio::test]
async fn raw_jsonrpc_handshake_matches_the_mcp_contract() {
    let server = TestServer::boot().await;
    let url = server.mcp_url();
    let client = reqwest::Client::new();

    // initialize: version negotiation + server identity.
    let init: Value = client
        .post(&url)
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": { "name": "contract-test", "version": "0" }
            }
        }))
        .send()
        .await
        .expect("initialize request")
        .json()
        .await
        .expect("initialize response is JSON");
    assert_eq!(init["jsonrpc"], "2.0");
    assert_eq!(init["id"], 1);
    assert_eq!(init["result"]["protocolVersion"], "2025-03-26");
    assert_eq!(init["result"]["serverInfo"]["name"], "mimir");
    assert_eq!(init["result"]["capabilities"]["tools"], json!({}));
    assert_eq!(
        init["result"]["instructions"],
        "Mimir: On the first substantive user turn, call `mimir_title` once with a concise 3-8 word task title. Discover other capabilities with `mimir tools` (all), `mimir tools <workbench|graph|meetings|chat|connections>`, `mimir tool <name>`, `mimir skill <query>`, and `mimir doctor`. If a work connection is missing, ask the user to open Mimir Settings → Connections."
    );

    // notifications (no id) are accepted with 202 and an empty body.
    let notification = client
        .post(&url)
        .json(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))
        .send()
        .await
        .expect("notification request");
    assert_eq!(notification.status(), reqwest::StatusCode::ACCEPTED);
    assert!(notification.bytes().await.expect("body").is_empty());

    // ping.
    let ping: Value = client
        .post(&url)
        .json(&json!({ "jsonrpc": "2.0", "id": 2, "method": "ping" }))
        .send()
        .await
        .expect("ping request")
        .json()
        .await
        .expect("ping response");
    assert_eq!(ping["result"], json!({}));

    // tools/list defaults to the lean core projection…
    let lean: Value = client
        .post(&url)
        .json(&json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/list" }))
        .send()
        .await
        .expect("tools/list request")
        .json()
        .await
        .expect("tools/list response");
    let lean_tools = lean["result"]["tools"].as_array().expect("tools array");
    assert_eq!(lean_tools.len(), 1, "lean list: {lean}");
    assert_eq!(lean_tools[0]["name"], "mimir_state");
    assert_eq!(lean["result"]["_meta"]["mimir/disclosure"], "core");

    // …and includeAll exposes only the wider public catalog, with one name
    // per tool and compact grouping metadata.
    let all: Value = client
        .post(&url)
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 4,
            "method": "tools/list",
            "params": { "includeAll": true }
        }))
        .send()
        .await
        .expect("tools/list includeAll request")
        .json()
        .await
        .expect("tools/list includeAll response");
    let all_tools = all["result"]["tools"].as_array().expect("tools array");
    let graph = all_tools
        .iter()
        .find(|tool| tool["name"] == "graph_get")
        .unwrap_or_else(|| panic!("graph_get missing from public list: {all}"));
    assert!(graph["_meta"].get("mimir/canonicalName").is_none());
    assert_eq!(graph["_meta"]["mimir/group"], "graph");
    assert_eq!(graph["inputSchema"]["required"][0], "id");
    assert_eq!(graph["annotations"]["readOnlyHint"], true);
    let state = all_tools
        .iter()
        .find(|tool| tool["name"] == "mimir_state")
        .unwrap_or_else(|| panic!("mimir_state missing from full list: {all}"));
    assert_eq!(state["annotations"]["readOnlyHint"], true);
    assert_eq!(state["annotations"]["idempotentHint"], true);
    assert_eq!(all["result"]["_meta"]["mimir/disclosure"], "public");

    // tools/call round-trip via the lean alias: alias resolution, argument
    // delivery, text + structuredContent rendering, request id propagation.
    let call: Value = client
        .post(&url)
        .json(&json!({
            "jsonrpc": "2.0",
            "id": "call-9",
            "method": "tools/call",
            "params": { "name": "mimir_state", "arguments": { "include_content": true } }
        }))
        .send()
        .await
        .expect("tools/call request")
        .json()
        .await
        .expect("tools/call response");
    assert_eq!(call["id"], "call-9");
    assert_eq!(call["result"]["structuredContent"]["content"], "# Contract");
    assert_eq!(call["result"]["content"][0]["type"], "text");
    assert!(
        call["result"]["content"][0]["text"]
            .as_str()
            .is_some_and(|text| text.contains("# Contract")),
        "text content should render the result: {call}",
    );
    assert_eq!(call["result"].get("isError"), None, "call: {call}");

    // Tool failures stay JSON-RPC *results* with isError, not protocol errors.
    let invalid: Value = client
        .post(&url)
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 5,
            "method": "tools/call",
            "params": { "name": "graph_get", "arguments": { "id": 42 } }
        }))
        .send()
        .await
        .expect("invalid tools/call request")
        .json()
        .await
        .expect("invalid tools/call response");
    assert_eq!(invalid["result"]["isError"], true);
    assert_eq!(
        invalid["result"]["structuredContent"]["error"],
        "invalid_input"
    );
    assert!(invalid.get("error").is_none(), "invalid: {invalid}");

    // Unknown methods are JSON-RPC errors.
    let unknown: Value = client
        .post(&url)
        .json(&json!({ "jsonrpc": "2.0", "id": 6, "method": "resources/list" }))
        .send()
        .await
        .expect("unknown method request")
        .json()
        .await
        .expect("unknown method response");
    assert_eq!(unknown["error"]["code"], -32601);

    server.shutdown().await;
}

#[tokio::test]
async fn mcp_http_rejects_remote_web_origins() {
    let server = TestServer::boot().await;
    let url = server.mcp_url();
    let client = reqwest::Client::new();
    let payload = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-11-25",
            "capabilities": {},
            "clientInfo": { "name": "origin-test", "version": "0" }
        }
    });

    let remote = client
        .post(&url)
        .header("origin", "https://attacker.example")
        .json(&payload)
        .send()
        .await
        .expect("remote-origin request");
    assert_eq!(remote.status(), reqwest::StatusCode::FORBIDDEN);

    let loopback = client
        .post(&url)
        .header("origin", "http://localhost:5173")
        .json(&payload)
        .send()
        .await
        .expect("loopback-origin request");
    assert_eq!(loopback.status(), reqwest::StatusCode::OK);

    server.shutdown().await;
}

#[tokio::test]
async fn mimir_doctor_reports_connection_context_scopes_and_catalog() {
    let server = TestServer::boot().await;
    let url = format!(
        "{}?activityId=agent%3Acontract&agentId=codex",
        server.mcp_url()
    );
    let Some(output) = run_mimir(&url, &["doctor"]).await else {
        eprintln!("skipping mimir contract test: `node` is not on PATH");
        server.shutdown().await;
        return;
    };
    assert_success(&output, "mimir doctor");
    assert_eq!(
        stdout_of(&output),
        "Mimir OK\nEndpoint   reachable\nContext    attached\nScopes     private, project\nConnection tools none\nTools      4\n"
    );
    assert!(!stdout_of(&output).contains("agent:contract"));
    assert!(!stdout_of(&output).contains("codex"));

    server.shutdown().await;
}

#[tokio::test]
async fn legacy_http_api_enforces_bearer_auth_and_maps_errors() {
    let server = TestServer::boot().await;
    let client = reqwest::Client::new();

    // Missing and wrong tokens are rejected.
    let unauthorized = client
        .get(server.api_url("/api/tools"))
        .send()
        .await
        .expect("unauthenticated request");
    assert_eq!(unauthorized.status(), reqwest::StatusCode::UNAUTHORIZED);
    let wrong = client
        .get(server.api_url("/api/tools"))
        .bearer_auth("wrong-token")
        .send()
        .await
        .expect("wrong-token request");
    assert_eq!(wrong.status(), reqwest::StatusCode::UNAUTHORIZED);

    // Auth is decided before the body is parsed: an unauthenticated call is
    // 401 even when the body is malformed or absent.
    let unauthed_bad_body = client
        .post(server.api_url("/api/tools/call"))
        .header("content-type", "application/json")
        .body("{not json")
        .send()
        .await
        .expect("unauthenticated malformed-body request");
    assert_eq!(
        unauthed_bad_body.status(),
        reqwest::StatusCode::UNAUTHORIZED
    );
    let unauthed_no_body = client
        .post(server.api_url("/api/tools/call"))
        .send()
        .await
        .expect("unauthenticated empty-body request");
    assert_eq!(unauthed_no_body.status(), reqwest::StatusCode::UNAUTHORIZED);

    // With a valid token, a malformed body is the caller's fault: 400.
    let authed_bad_body = client
        .post(server.api_url("/api/tools/call"))
        .bearer_auth(TEST_TOKEN)
        .header("content-type", "application/json")
        .body("{not json")
        .send()
        .await
        .expect("authenticated malformed-body request");
    assert_eq!(authed_bad_body.status(), reqwest::StatusCode::BAD_REQUEST);
    let authed_bad_body_json: Value = authed_bad_body
        .json()
        .await
        .expect("malformed-body response is JSON");
    assert_eq!(authed_bad_body_json["error"], "invalid_request");

    // The authenticated catalog exposes alias + canonical name.
    let schema: Value = client
        .get(server.api_url("/api/tools"))
        .bearer_auth(TEST_TOKEN)
        .send()
        .await
        .expect("schema request")
        .json()
        .await
        .expect("schema response");
    let tools = schema["tools"].as_array().expect("tools array");
    let graph = tools
        .iter()
        .find(|tool| tool["name"] == "graph_get")
        .unwrap_or_else(|| panic!("graph_get missing from legacy schema: {schema}"));
    assert_eq!(graph["canonical_name"], "graph.get");

    // Authenticated call round-trip, marked with the mimir caller.
    let call = client
        .post(server.api_url("/api/tools/call"))
        .bearer_auth(TEST_TOKEN)
        .json(&json!({
            "tool": "graph.get",
            "input": { "id": "legacy" },
            "requestId": "legacy-1"
        }))
        .send()
        .await
        .expect("legacy call request");
    assert_eq!(call.status(), reqwest::StatusCode::OK);
    let call_body: Value = call.json().await.expect("legacy call response");
    assert_eq!(call_body["result"]["id"], "legacy");
    assert_eq!(call_body["result"]["caller"]["kind"], "mimir_cli");
    assert_eq!(call_body["result"]["requestId"], "legacy-1");

    // Tool errors map onto HTTP status codes.
    let missing = client
        .post(server.api_url("/api/tools/call"))
        .bearer_auth(TEST_TOKEN)
        .json(&json!({ "tool": "no.such_tool", "input": {} }))
        .send()
        .await
        .expect("missing tool request");
    assert_eq!(missing.status(), reqwest::StatusCode::NOT_FOUND);
    let missing_body: Value = missing.json().await.expect("missing tool response");
    assert_eq!(missing_body["error"], "not_found");

    server.shutdown().await;
}

#[tokio::test]
async fn mimir_cli_fails_cleanly_when_the_server_is_unreachable() {
    // No server: MIMIR_MCP_URL points at a port nothing listens on.
    let base_url = format!("http://127.0.0.1:{}/mcp", unused_port());
    let url = format!("{base_url}?activityId=secret-activity&agentId=secret-agent");
    let Some(output) = run_mimir(&url, &["tools"]).await else {
        eprintln!("skipping mimir contract test: `node` is not on PATH");
        return;
    };
    assert_eq!(
        output.status.code(),
        Some(1),
        "an unreachable server should exit 1, not crash or hang",
    );
    assert_eq!(
        stdout_of(&output),
        "",
        "connection failures must not pollute stdout",
    );
    let stderr = stderr_of(&output);
    assert!(
        stderr.contains(&base_url),
        "stderr should name the safe endpoint, got: {stderr}",
    );
    assert!(
        stderr.contains("connection refused") && stderr.contains("mimir doctor"),
        "stderr should preserve the cause and useful remedy, got: {stderr}",
    );
    assert!(!stderr.contains("secret-activity") && !stderr.contains("secret-agent"));
    assert!(
        !stderr.contains("    at "),
        "stderr must stay a human-readable message, not a stack trace: {stderr}",
    );
}

#[tokio::test]
async fn mimir_cli_fails_fast_when_pointed_at_the_bearer_guarded_api() {
    // The MCP endpoint is deliberately unauthenticated and mimir never sends a
    // bearer token, so the closest thing to a token failure a user can hit is
    // pointing MIMIR_MCP_URL at the bearer-guarded legacy API. That
    // misconfiguration must fail fast with a nonzero exit and the HTTP status
    // on stderr, not hang or dump JSON internals. Auth is decided before body
    // parsing, so the missing token surfaces as a 401.
    let server = TestServer::boot().await;
    let Some(output) = run_mimir(&server.api_url("/api/tools/call"), &["tools"]).await else {
        eprintln!("skipping mimir contract test: `node` is not on PATH");
        server.shutdown().await;
        return;
    };
    assert_eq!(
        output.status.code(),
        Some(1),
        "a rejected request should exit 1; stderr: {}",
        stderr_of(&output),
    );
    assert_eq!(
        stdout_of(&output),
        "",
        "rejected requests must not print results"
    );
    assert!(
        stderr_of(&output).contains("returned HTTP 401"),
        "stderr should name the HTTP status, got: {}",
        stderr_of(&output),
    );
    server.shutdown().await;
}

#[tokio::test]
async fn malformed_tool_arguments_fail_the_cli_without_hurting_the_server() {
    let server = TestServer::boot().await;
    let url = server.mcp_url();

    // Wrong argument type: schema validation happens server-side and comes
    // back as an isError tool result the CLI maps to exit 1 plus stderr.
    let Some(wrong_type) = run_mimir(&url, &["call", "graph_get", r#"{"id":42}"#]).await else {
        eprintln!("skipping mimir contract test: `node` is not on PATH");
        server.shutdown().await;
        return;
    };
    assert_eq!(
        wrong_type.status.code(),
        Some(1),
        "wrong-typed input should fail",
    );
    assert!(
        stderr_of(&wrong_type).contains("invalid input for 'graph_get'"),
        "stderr should carry the public-name validation message, got: {}",
        stderr_of(&wrong_type),
    );
    assert_eq!(
        stdout_of(&wrong_type),
        "",
        "failed calls must not print results"
    );

    // Unparseable JSON never reaches the wire: the CLI rejects it itself.
    let bad_json = run_mimir(&url, &["call", "graph_get", "{not json"])
        .await
        .unwrap();
    assert_eq!(bad_json.status.code(), Some(1), "bad JSON should fail");
    assert!(
        stderr_of(&bad_json).contains("Invalid tool input JSON"),
        "stderr should explain the parse failure, got: {}",
        stderr_of(&bad_json),
    );

    // Raw JSON-RPC: tools/call without a tool name is a -32602 protocol error
    // riding HTTP 200 per MCP — never a 500.
    let client = reqwest::Client::new();
    let nameless = client
        .post(&url)
        .json(&json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {} }))
        .send()
        .await
        .expect("nameless tools/call request");
    assert_eq!(nameless.status(), reqwest::StatusCode::OK);
    let nameless_body: Value = nameless.json().await.expect("nameless tools/call response");
    assert_eq!(nameless_body["error"]["code"], -32602);
    assert_eq!(nameless_body["error"]["message"], "Missing tool name");

    // The server survives the abuse: a follow-up call still succeeds.
    let alive: Value = client
        .post(&url)
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 8,
            "method": "tools/call",
            "params": { "name": "graph_get", "arguments": { "id": "still-alive" } }
        }))
        .send()
        .await
        .expect("follow-up request")
        .json()
        .await
        .expect("follow-up response");
    assert_eq!(alive["result"]["structuredContent"]["id"], "still-alive");

    server.shutdown().await;
}

#[tokio::test]
async fn unknown_tool_calls_name_the_tool_and_stay_inside_the_protocol() {
    let server = TestServer::boot().await;
    let url = server.mcp_url();

    // CLI: exit 1 with the offending tool name in the message.
    let Some(missing) = run_mimir(&url, &["call", "graph_qery", "{}"]).await else {
        eprintln!("skipping mimir contract test: `node` is not on PATH");
        server.shutdown().await;
        return;
    };
    assert_eq!(missing.status.code(), Some(1), "unknown tool should fail");
    assert!(
        stderr_of(&missing).contains("Unknown tool 'graph_qery'."),
        "stderr should name the missing tool, got: {}",
        stderr_of(&missing),
    );
    assert_eq!(
        stdout_of(&missing),
        "",
        "failed calls must not print results"
    );

    // Unknown tool names are invalid request parameters, not tool execution
    // failures. The server returns a JSON-RPC error on HTTP 200.
    let client = reqwest::Client::new();
    let response = client
        .post(&url)
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 9,
            "method": "tools/call",
            "params": { "name": "graph_qery", "arguments": {} }
        }))
        .send()
        .await
        .expect("unknown tool request");
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let body: Value = response.json().await.expect("unknown tool response");
    assert_eq!(body["error"]["code"], -32602, "body: {body}");
    assert_eq!(body["error"]["message"], "Unknown tool");
    assert_eq!(body["error"]["data"]["name"], "graph_qery");
    assert!(body.get("result").is_none(), "body: {body}");

    server.shutdown().await;
}

#[tokio::test]
async fn mimir_cli_loop_discovers_the_lean_alias_and_round_trips_a_call() {
    let server = TestServer::boot().await;
    let url = server.mcp_url();

    // Discover: the machine-readable catalog exposes every backed public tool
    // and nothing else from the synthetic registry.
    let Some(listing) = run_mimir(&url, &["tools", "--json"]).await else {
        eprintln!("skipping mimir contract test: `node` is not on PATH");
        server.shutdown().await;
        return;
    };
    assert_success(&listing, "mimir tools --json");
    let catalog: Value =
        serde_json::from_str(stdout_of(&listing).trim()).expect("mimir tools --json prints JSON");
    let tools = catalog.as_array().expect("catalog is an array");
    assert_eq!(
        tools.len(),
        4,
        "public projection should include state, graph get, graph events, and meetings get: {catalog}",
    );
    let state = tools
        .iter()
        .find(|tool| tool["name"] == "mimir_state")
        .expect("mimir_state is public");
    let alias = state["name"].as_str().expect("tool has a name");
    assert_eq!(alias, "mimir_state");
    assert_eq!(
        state["inputSchema"]["properties"]["include_content"]["type"], "boolean",
        "the canonical tool's schema should ride along with the alias: {catalog}",
    );

    // Call the discovered alias: the server resolves mimir_state back to
    // editor.state and the structured result round-trips as CLI JSON.
    let call = run_mimir(&url, &["call", alias, r#"{"include_content":true}"#])
        .await
        .unwrap();
    assert_success(&call, "mimir call mimir_state");
    let payload: Value =
        serde_json::from_str(stdout_of(&call).trim()).expect("mimir call prints JSON");
    assert_eq!(payload["path"], "/workspace/README.md");
    assert_eq!(
        payload["content"], "# Contract",
        "arguments must reach the canonical handler through the alias: {payload}",
    );

    server.shutdown().await;
}
