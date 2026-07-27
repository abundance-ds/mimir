//! End-to-end MCP contract tests between the `mimx` Node CLI and the Rust
//! tool server.
//!
//! Each test boots the real axum tool server ([`mim_workbench::tool_server`])
//! on an ephemeral loopback port with a couple of synthetic core tools, then
//! exercises the wire protocol either through the actual `bin/mimx.mjs` CLI
//! (spawned via `node`) or through raw JSON-RPC over HTTP. This catches
//! protocol and serialization drift that the isolated unit tests on either
//! side cannot see.

use std::path::PathBuf;
use std::process::Output;

use serde_json::{json, Value};
use tokio::{sync::watch, task::JoinHandle};

use mim_workbench::{
    tool_bridge::register_core_tool,
    tool_registry::{ToolCallContext, ToolRegistry, ToolResult, ToolSource},
    tool_server::start_server,
};

const TEST_TOKEN: &str = "contract-test-token";

/// A minimal registry with two synthetic core tools:
///
/// * `test.echo` (`test_echo`) — echoes input plus caller metadata, so tests
///   can assert on argument round-trips and transport-assigned context.
/// * `editor.state` (`editor_state`) — canonical name that participates in
///   the lean `LEAN_AGENT_TOOLS` MCP projection (`mim_state`) and backs the
///   CLI's built-in `mimx state` command.
fn test_registry() -> ToolRegistry {
    let registry = ToolRegistry::new();
    register_core_tool(
        &registry,
        "test.echo",
        "test_echo",
        "Echo the provided text back to the caller.",
        json!({
            "type": "object",
            "properties": { "text": { "type": "string", "minLength": 1 } },
            "required": ["text"],
            "additionalProperties": false
        }),
        ToolSource::Native,
        |context: ToolCallContext, input: Value| async move {
            Ok(ToolResult::new(json!({
                "echo": input["text"],
                "caller": serde_json::to_value(&context.caller).expect("caller serializes"),
                "requestId": context.request_id,
            })))
        },
    )
    .expect("register test.echo");
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
    registry
}

struct TestServer {
    port: u16,
    shutdown_tx: watch::Sender<bool>,
    task: JoinHandle<()>,
}

impl TestServer {
    async fn boot() -> Self {
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

/// Run `node bin/mimx.mjs <args…>` against the test server. Returns `None`
/// when `node` is not on PATH so environments without Node skip gracefully.
async fn run_mimx(mcp_url: &str, args: &[&str]) -> Option<Output> {
    let cli = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri has a parent directory")
        .join("bin/mimx.mjs");
    let url = mcp_url.to_string();
    let args: Vec<String> = args.iter().map(|value| value.to_string()).collect();
    let result = tokio::task::spawn_blocking(move || {
        std::process::Command::new("node")
            .arg(cli)
            .args(&args)
            .env("MIMX_MCP_URL", url)
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
async fn mimx_cli_discovers_and_calls_tools_over_the_wire() {
    let server = TestServer::boot().await;
    let url = server.mcp_url();

    // `mimx tools` — the lean/core projection: editor.state is surfaced under
    // its projected alias, test.echo is hidden until --all.
    let Some(lean) = run_mimx(&url, &["tools"]).await else {
        eprintln!("skipping mimx contract test: `node` is not on PATH");
        server.shutdown().await;
        return;
    };
    assert_success(&lean, "mimx tools");
    let lean_stdout = stdout_of(&lean);
    assert!(
        lean_stdout.contains("mim_state\tGet active editor state."),
        "lean listing should project editor.state as mim_state, got: {lean_stdout}",
    );
    assert!(
        !lean_stdout.contains("test_echo"),
        "lean listing must not include non-core tools, got: {lean_stdout}",
    );

    // `mimx tools --all` — the full catalog includes the synthetic tool.
    let all = run_mimx(&url, &["tools", "--all"]).await.unwrap();
    assert_success(&all, "mimx tools --all");
    let all_stdout = stdout_of(&all);
    assert!(
        all_stdout.contains("test_echo\tEcho the provided text back to the caller."),
        "full listing should include test_echo, got: {all_stdout}",
    );
    assert!(all_stdout.contains("mim_state"), "got: {all_stdout}");

    // `mimx call` — arguments in, structuredContent out, transport metadata
    // (caller + request id) assigned by the server.
    let call = run_mimx(&url, &["call", "test_echo", r#"{"text":"round-trip"}"#])
        .await
        .unwrap();
    assert_success(&call, "mimx call test_echo");
    let payload: Value =
        serde_json::from_str(stdout_of(&call).trim()).expect("mimx call prints JSON");
    assert_eq!(payload["echo"], "round-trip");
    assert_eq!(payload["caller"]["kind"], "mcp");
    assert!(
        payload["requestId"]
            .as_str()
            .is_some_and(|id| !id.is_empty()),
        "server should derive request_id from the JSON-RPC id, got: {payload}",
    );

    // `mimx state` — a built-in CLI command calling by canonical tool name.
    let state = run_mimx(&url, &["state"]).await.unwrap();
    assert_success(&state, "mimx state");
    let state_payload: Value =
        serde_json::from_str(stdout_of(&state).trim()).expect("mimx state prints JSON");
    assert_eq!(state_payload["path"], "/workspace/README.md");
    assert_eq!(state_payload["content"], "");

    // Schema violations surface as CLI errors (exit 1, message on stderr).
    let invalid = run_mimx(&url, &["call", "test_echo", "{}"]).await.unwrap();
    assert_eq!(invalid.status.code(), Some(1), "invalid input should fail");
    assert!(
        stderr_of(&invalid).contains("invalid input for 'test.echo'"),
        "stderr should carry the structured validation message, got: {}",
        stderr_of(&invalid),
    );

    // Unknown tools surface the registry's not-found error.
    let missing = run_mimx(&url, &["call", "no_such_tool", "{}"])
        .await
        .unwrap();
    assert_eq!(missing.status.code(), Some(1), "missing tool should fail");
    assert!(
        stderr_of(&missing).contains("not registered"),
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
    assert_eq!(init["result"]["serverInfo"]["name"], "mim");
    assert_eq!(init["result"]["capabilities"]["tools"], json!({}));

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
    assert_eq!(lean_tools[0]["name"], "mim_state");
    assert_eq!(lean["result"]["_meta"]["mim/disclosure"], "core");

    // …and includeAll exposes the full catalog with canonical metadata.
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
    let echo = all_tools
        .iter()
        .find(|tool| tool["name"] == "test_echo")
        .unwrap_or_else(|| panic!("test_echo missing from full list: {all}"));
    assert_eq!(echo["_meta"]["mim/canonicalName"], "test.echo");
    assert_eq!(echo["inputSchema"]["required"][0], "text");
    assert_eq!(all["result"]["_meta"]["mim/disclosure"], "all");

    // tools/call round-trip via the lean alias: alias resolution, argument
    // delivery, text + structuredContent rendering, request id propagation.
    let call: Value = client
        .post(&url)
        .json(&json!({
            "jsonrpc": "2.0",
            "id": "call-9",
            "method": "tools/call",
            "params": { "name": "mim_state", "arguments": { "include_content": true } }
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
            "params": { "name": "test_echo", "arguments": { "text": 42 } }
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
    let echo = tools
        .iter()
        .find(|tool| tool["name"] == "test_echo")
        .unwrap_or_else(|| panic!("test_echo missing from legacy schema: {schema}"));
    assert_eq!(echo["canonical_name"], "test.echo");

    // Authenticated call round-trip, marked with the mimx caller.
    let call = client
        .post(server.api_url("/api/tools/call"))
        .bearer_auth(TEST_TOKEN)
        .json(&json!({
            "tool": "test.echo",
            "input": { "text": "legacy" },
            "requestId": "legacy-1"
        }))
        .send()
        .await
        .expect("legacy call request");
    assert_eq!(call.status(), reqwest::StatusCode::OK);
    let call_body: Value = call.json().await.expect("legacy call response");
    assert_eq!(call_body["result"]["echo"], "legacy");
    assert_eq!(call_body["result"]["caller"]["kind"], "mimx");
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
async fn mimx_cli_fails_cleanly_when_the_server_is_unreachable() {
    // No server: MIMX_MCP_URL points at a port nothing listens on.
    let url = format!("http://127.0.0.1:{}/mcp", unused_port());
    let Some(output) = run_mimx(&url, &["tools"]).await else {
        eprintln!("skipping mimx contract test: `node` is not on PATH");
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
        stderr.contains(&url),
        "stderr should name the URL the CLI tried, got: {stderr}",
    );
    assert!(
        stderr.contains("Mim workbench") && stderr.contains("MIMX_MCP_URL"),
        "stderr should hint that the workbench must be running and how the URL \
         is configured, got: {stderr}",
    );
    assert!(
        !stderr.contains("    at "),
        "stderr must stay a human-readable message, not a stack trace: {stderr}",
    );
}

#[tokio::test]
async fn mimx_cli_fails_fast_when_pointed_at_the_bearer_guarded_api() {
    // The MCP endpoint is deliberately unauthenticated and mimx never sends a
    // bearer token, so the closest thing to a token failure a user can hit is
    // pointing MIMX_MCP_URL at the bearer-guarded legacy API. That
    // misconfiguration must fail fast with a nonzero exit and the HTTP status
    // on stderr, not hang or dump JSON internals. Auth is decided before body
    // parsing, so the missing token surfaces as a 401.
    let server = TestServer::boot().await;
    let Some(output) = run_mimx(&server.api_url("/api/tools/call"), &["state"]).await else {
        eprintln!("skipping mimx contract test: `node` is not on PATH");
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
        stderr_of(&output).contains("mimx server returned HTTP 401"),
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
    let Some(wrong_type) = run_mimx(&url, &["call", "test_echo", r#"{"text":42}"#]).await else {
        eprintln!("skipping mimx contract test: `node` is not on PATH");
        server.shutdown().await;
        return;
    };
    assert_eq!(
        wrong_type.status.code(),
        Some(1),
        "wrong-typed input should fail",
    );
    assert!(
        stderr_of(&wrong_type).contains("invalid input for 'test.echo'"),
        "stderr should carry the canonical-name validation message, got: {}",
        stderr_of(&wrong_type),
    );
    assert_eq!(
        stdout_of(&wrong_type),
        "",
        "failed calls must not print results"
    );

    // Unparseable JSON never reaches the wire: the CLI rejects it itself.
    let bad_json = run_mimx(&url, &["call", "test_echo", "{not json"])
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
            "params": { "name": "test_echo", "arguments": { "text": "still-alive" } }
        }))
        .send()
        .await
        .expect("follow-up request")
        .json()
        .await
        .expect("follow-up response");
    assert_eq!(alive["result"]["structuredContent"]["echo"], "still-alive");

    server.shutdown().await;
}

#[tokio::test]
async fn unknown_tool_calls_name_the_tool_and_stay_inside_the_protocol() {
    let server = TestServer::boot().await;
    let url = server.mcp_url();

    // CLI: exit 1 with the offending tool name in the message.
    let Some(missing) = run_mimx(&url, &["call", "graph_qery", "{}"]).await else {
        eprintln!("skipping mimx contract test: `node` is not on PATH");
        server.shutdown().await;
        return;
    };
    assert_eq!(missing.status.code(), Some(1), "unknown tool should fail");
    assert!(
        stderr_of(&missing).contains("tool 'graph_qery' is not registered"),
        "stderr should name the missing tool, got: {}",
        stderr_of(&missing),
    );
    assert_eq!(
        stdout_of(&missing),
        "",
        "failed calls must not print results"
    );

    // Raw shape: the server keeps this an isError tool *result* carrying
    // `not_found` on HTTP 200 — no JSON-RPC protocol error, no 500.
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
    assert_eq!(body["result"]["isError"], true, "body: {body}");
    assert_eq!(body["result"]["structuredContent"]["error"], "not_found");
    assert!(body.get("error").is_none(), "body: {body}");

    server.shutdown().await;
}

#[tokio::test]
async fn mimx_cli_loop_discovers_the_lean_alias_and_round_trips_a_call() {
    let server = TestServer::boot().await;
    let url = server.mcp_url();

    // Discover: the machine-readable lean catalog projects editor.state under
    // its alias, and nothing else from the synthetic registry leaks in.
    let Some(listing) = run_mimx(&url, &["tools", "--json"]).await else {
        eprintln!("skipping mimx contract test: `node` is not on PATH");
        server.shutdown().await;
        return;
    };
    assert_success(&listing, "mimx tools --json");
    let catalog: Value =
        serde_json::from_str(stdout_of(&listing).trim()).expect("mimx tools --json prints JSON");
    let tools = catalog.as_array().expect("catalog is an array");
    assert_eq!(
        tools.len(),
        1,
        "lean projection should be exactly the core tools: {catalog}",
    );
    let alias = tools[0]["name"].as_str().expect("tool has a name");
    assert_eq!(alias, "mim_state");
    assert_eq!(
        tools[0]["inputSchema"]["properties"]["include_content"]["type"], "boolean",
        "the canonical tool's schema should ride along with the alias: {catalog}",
    );

    // Call the discovered alias: the server resolves mim_state back to
    // editor.state and the structured result round-trips as CLI JSON.
    let call = run_mimx(&url, &["call", alias, r#"{"include_content":true}"#])
        .await
        .unwrap();
    assert_success(&call, "mimx call mim_state");
    let payload: Value =
        serde_json::from_str(stdout_of(&call).trim()).expect("mimx call prints JSON");
    assert_eq!(payload["path"], "/workspace/README.md");
    assert_eq!(
        payload["content"], "# Contract",
        "arguments must reach the canonical handler through the alias: {payload}",
    );

    server.shutdown().await;
}
