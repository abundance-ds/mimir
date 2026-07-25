//! Transport-neutral bridge between [`ToolRegistry`](crate::tool_registry::ToolRegistry)
//! and tool implementations hosted in the UI or an app.
//!
//! Tauri integration only needs to implement [`ToolBridgeEventSink`] and relay
//! responses back to the appropriate provider. The bridge itself owns request
//! correlation, lifecycle cleanup, timeouts, and registry reconciliation.

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tokio::sync::{oneshot, watch, Mutex};

use crate::tool_registry::{
    ReconcileReport, RegistryError, RegistrySnapshot, ToolCallContext, ToolCallResult, ToolCaller,
    ToolDescriptor, ToolError, ToolErrorCode, ToolHandler, ToolOwner, ToolRegistration,
    ToolRegistry, ToolResult, ToolSource,
};

static NEXT_RELAY_REQUEST_ID: AtomicU64 = AtomicU64::new(1);

// ── Public command/event DTOs ────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallRequest {
    pub tool: String,
    #[serde(default = "empty_object")]
    pub input: Value,
    #[serde(default = "default_caller")]
    pub caller: ToolCaller,
    pub request_id: Option<String>,
    pub cwd: Option<String>,
    #[serde(default)]
    pub metadata: Map<String, Value>,
}

impl ToolCallRequest {
    pub fn new(tool: impl Into<String>, input: Value, caller: ToolCaller) -> Self {
        Self {
            tool: tool.into(),
            input,
            caller,
            request_id: None,
            cwd: None,
            metadata: Map::new(),
        }
    }

    pub fn context(&self) -> ToolCallContext {
        ToolCallContext {
            request_id: self.request_id.clone(),
            caller: self.caller.clone(),
            cwd: self.cwd.clone(),
            metadata: self.metadata.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallResponse {
    pub tool: String,
    pub result: Option<ToolResult>,
    pub error: Option<ToolError>,
}

impl ToolCallResponse {
    pub fn from_result(tool: impl Into<String>, result: ToolCallResult) -> Self {
        let tool = tool.into();
        match result {
            Ok(result) => Self {
                tool,
                result: Some(result),
                error: None,
            },
            Err(error) => Self {
                tool,
                result: None,
                error: Some(error),
            },
        }
    }

    pub fn into_result(self) -> ToolCallResult {
        match (self.result, self.error) {
            (Some(result), None) => Ok(result),
            (None, Some(error)) => Err(error),
            _ => Err(ToolError::new(
                ToolErrorCode::Internal,
                "malformed tool response: expected exactly one of result or error",
            )),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolSnapshotResponse {
    pub revision: u64,
    pub tools: Vec<ToolDescriptor>,
}

impl From<RegistrySnapshot> for ToolSnapshotResponse {
    fn from(snapshot: RegistrySnapshot) -> Self {
        Self {
            revision: snapshot.revision,
            tools: snapshot.tools,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolListResponse {
    pub revision: u64,
    pub tools: Vec<ToolDescriptor>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryRevisionEvent {
    pub revision: u64,
}

/// Async command-shaped facade used by Tauri commands, the local CLI bridge,
/// and tests. The calls are cheap but intentionally async so no transport needs
/// a special synchronous path.
pub async fn snapshot(registry: &ToolRegistry) -> ToolSnapshotResponse {
    registry.snapshot().into()
}

pub async fn list(registry: &ToolRegistry) -> ToolListResponse {
    let snapshot = registry.snapshot();
    ToolListResponse {
        revision: snapshot.revision,
        tools: snapshot.tools,
    }
}

pub async fn call(registry: &ToolRegistry, request: ToolCallRequest) -> ToolCallResponse {
    let tool = request.tool.clone();
    let context = request.context();
    ToolCallResponse::from_result(
        tool,
        registry.call(&request.tool, context, request.input).await,
    )
}

/// Pull-based revision observer. A Tauri adapter can await `changed` and emit
/// `tools-list-changed`; MCP can use the same signal for its notification.
pub struct RegistryRevisionObserver {
    receiver: watch::Receiver<u64>,
}

impl RegistryRevisionObserver {
    pub fn current(&self) -> RegistryRevisionEvent {
        RegistryRevisionEvent {
            revision: *self.receiver.borrow(),
        }
    }

    pub async fn changed(&mut self) -> Option<RegistryRevisionEvent> {
        self.receiver.changed().await.ok()?;
        Some(self.current())
    }
}

pub fn observe_revisions(registry: &ToolRegistry) -> RegistryRevisionObserver {
    RegistryRevisionObserver {
        receiver: registry.subscribe_revision(),
    }
}

/// Provider-owned definition. Ownership and implementation source are assigned
/// by the provider so an app cannot accidentally reconcile another provider.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DynamicToolDefinition {
    pub canonical_name: String,
    pub mcp_alias: String,
    pub description: String,
    pub input_schema: Value,
}

impl DynamicToolDefinition {
    pub fn new(
        canonical_name: impl Into<String>,
        mcp_alias: impl Into<String>,
        description: impl Into<String>,
        input_schema: Value,
    ) -> Self {
        Self {
            canonical_name: canonical_name.into(),
            mcp_alias: mcp_alias.into(),
            description: description.into(),
            input_schema,
        }
    }

    fn descriptor(&self, owner: ToolOwner, source: ToolSource) -> ToolDescriptor {
        ToolDescriptor::new(
            self.canonical_name.clone(),
            self.mcp_alias.clone(),
            self.description.clone(),
            self.input_schema.clone(),
            owner,
            source,
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ToolRelayTarget {
    UiWindow {
        provider_id: String,
        window_id: String,
    },
    App {
        app_id: String,
        instance_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolRelayRequest {
    pub id: String,
    pub target: ToolRelayTarget,
    pub tool: String,
    pub input: Value,
    pub context: ToolCallContext,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolRelayResponse {
    pub id: String,
    pub result: Option<ToolResult>,
    pub error: Option<ToolError>,
}

impl ToolRelayResponse {
    pub fn success(id: impl Into<String>, result: impl Into<ToolResult>) -> Self {
        Self {
            id: id.into(),
            result: Some(result.into()),
            error: None,
        }
    }

    pub fn error(id: impl Into<String>, error: ToolError) -> Self {
        Self {
            id: id.into(),
            result: None,
            error: Some(error),
        }
    }

    fn into_result(self) -> ToolCallResult {
        match (self.result, self.error) {
            (Some(result), None) => Ok(result),
            (None, Some(error)) => Err(error),
            _ => Err(ToolError::new(
                ToolErrorCode::Internal,
                "malformed relay response: expected exactly one of result or error",
            )),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolRelayCancellation {
    pub id: String,
    pub target: ToolRelayTarget,
    pub tool: String,
    pub reason: ToolRelayCancellationReason,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolRelayCancellationReason {
    CallerCancelled,
    TimedOut,
    Disconnected,
    ProviderUnregistered,
}

/// Minimal injected boundary implemented later with `AppHandle::emit`.
pub trait ToolBridgeEventSink: Send + Sync + 'static {
    fn emit_tool_call(&self, request: ToolRelayRequest) -> Result<(), String>;

    fn emit_tool_cancellation(&self, _cancellation: ToolRelayCancellation) -> Result<(), String> {
        Ok(())
    }
}

struct PendingCall {
    tool: String,
    sender: oneshot::Sender<ToolCallResult>,
    timeout_task: Option<tokio::task::AbortHandle>,
}

struct RelayInner {
    target: ToolRelayTarget,
    timeout: Duration,
    sink: Arc<dyn ToolBridgeEventSink>,
    accepting_calls: std::sync::atomic::AtomicBool,
    pending: Mutex<HashMap<String, PendingCall>>,
}

#[derive(Clone)]
struct RelayProvider {
    inner: Arc<RelayInner>,
}

impl RelayProvider {
    fn new(target: ToolRelayTarget, timeout: Duration, sink: Arc<dyn ToolBridgeEventSink>) -> Self {
        Self {
            inner: Arc::new(RelayInner {
                target,
                timeout,
                sink,
                accepting_calls: std::sync::atomic::AtomicBool::new(true),
                pending: Mutex::new(HashMap::new()),
            }),
        }
    }

    fn handler(&self, tool: String) -> Arc<dyn ToolHandler> {
        let relay = self.clone();
        Arc::new(move |context: ToolCallContext, input: Value| {
            let relay = relay.clone();
            let tool = tool.clone();
            async move { relay.call(tool, context, input).await }
        })
    }

    async fn call(&self, tool: String, context: ToolCallContext, input: Value) -> ToolCallResult {
        if !self.inner.accepting_calls.load(Ordering::Acquire) {
            return Err(ToolError::new(
                ToolErrorCode::Unavailable,
                format!("provider for tool '{tool}' is disconnected"),
            ));
        }

        let sequence = NEXT_RELAY_REQUEST_ID.fetch_add(1, Ordering::Relaxed);
        let request_id = format!("relay-{sequence}");
        let (sender, receiver) = oneshot::channel();

        self.inner.pending.lock().await.insert(
            request_id.clone(),
            PendingCall {
                tool: tool.clone(),
                sender,
                timeout_task: None,
            },
        );
        // Close the check/insert race with `deactivate`: either this removes
        // the just-inserted call, or `cancel_all` sees and resolves it.
        if !self.inner.accepting_calls.load(Ordering::Acquire) {
            self.inner.pending.lock().await.remove(&request_id);
            return Err(ToolError::new(
                ToolErrorCode::Unavailable,
                format!("provider for tool '{tool}' disconnected"),
            ));
        }

        let relay_request = ToolRelayRequest {
            id: request_id.clone(),
            target: self.inner.target.clone(),
            tool: tool.clone(),
            input,
            context,
        };
        if let Err(message) = self.inner.sink.emit_tool_call(relay_request) {
            self.inner.pending.lock().await.remove(&request_id);
            return Err(ToolError::new(
                ToolErrorCode::Unavailable,
                format!("could not relay tool '{tool}': {message}"),
            ));
        }

        // The timeout owns its own task rather than this call future. If an
        // HTTP/MCP client disconnects and drops the future, the pending relay
        // is still cleaned up deterministically.
        let timeout_relay = self.clone();
        let timeout_id = request_id.clone();
        let timeout_tool = tool.clone();
        let timeout_task = tokio::spawn(async move {
            tokio::time::sleep(timeout_relay.inner.timeout).await;
            timeout_relay.expire(timeout_id, timeout_tool).await;
        });
        let timeout_abort = timeout_task.abort_handle();
        let mut pending = self.inner.pending.lock().await;
        if let Some(pending_call) = pending.get_mut(&request_id) {
            pending_call.timeout_task = Some(timeout_abort);
        } else {
            timeout_abort.abort();
        }
        drop(pending);

        match receiver.await {
            Ok(result) => result,
            Err(_) => {
                self.inner.pending.lock().await.remove(&request_id);
                Err(ToolError::new(
                    ToolErrorCode::Unavailable,
                    format!("relay for tool '{tool}' disconnected"),
                ))
            }
        }
    }

    async fn expire(&self, id: String, tool: String) {
        let Some(pending) = self.inner.pending.lock().await.remove(&id) else {
            return;
        };
        let _ = self.inner.sink.emit_tool_cancellation(self.cancellation(
            id,
            tool.clone(),
            ToolRelayCancellationReason::TimedOut,
        ));
        let _ = pending.sender.send(Err(ToolError::new(
            ToolErrorCode::Timeout,
            format!(
                "tool '{tool}' timed out after {} ms",
                self.inner.timeout.as_millis()
            ),
        )));
    }

    async fn resolve(&self, response: ToolRelayResponse) -> bool {
        let id = response.id.clone();
        let Some(pending) = self.inner.pending.lock().await.remove(&id) else {
            return false;
        };
        if let Some(timeout_task) = pending.timeout_task {
            timeout_task.abort();
        }
        pending.sender.send(response.into_result()).is_ok()
    }

    async fn cancel(&self, id: &str) -> bool {
        let Some(pending) = self.inner.pending.lock().await.remove(id) else {
            return false;
        };
        if let Some(timeout_task) = pending.timeout_task {
            timeout_task.abort();
        }
        let _ = self.inner.sink.emit_tool_cancellation(self.cancellation(
            id.to_string(),
            pending.tool.clone(),
            ToolRelayCancellationReason::CallerCancelled,
        ));
        pending
            .sender
            .send(Err(ToolError::new(
                ToolErrorCode::Cancelled,
                format!("tool call '{id}' was cancelled"),
            )))
            .is_ok()
    }

    async fn cancel_all(
        &self,
        reason: ToolRelayCancellationReason,
        code: ToolErrorCode,
        message: &str,
    ) -> usize {
        let pending = {
            let mut pending = self.inner.pending.lock().await;
            std::mem::take(&mut *pending)
        };
        let count = pending.len();
        for (id, pending) in pending {
            if let Some(timeout_task) = pending.timeout_task {
                timeout_task.abort();
            }
            let _ = self.inner.sink.emit_tool_cancellation(self.cancellation(
                id.clone(),
                pending.tool,
                reason,
            ));
            let _ = pending
                .sender
                .send(Err(ToolError::new(code, message.to_string())));
        }
        count
    }

    async fn pending_count(&self) -> usize {
        self.inner.pending.lock().await.len()
    }

    fn activate(&self) {
        self.inner.accepting_calls.store(true, Ordering::Release);
    }

    fn deactivate(&self) {
        self.inner.accepting_calls.store(false, Ordering::Release);
    }

    fn cancellation(
        &self,
        id: String,
        tool: String,
        reason: ToolRelayCancellationReason,
    ) -> ToolRelayCancellation {
        ToolRelayCancellation {
            id,
            target: self.inner.target.clone(),
            tool,
            reason,
        }
    }
}

/// UI-hosted tool provider, normally scoped to one Tauri window.
#[derive(Clone)]
pub struct UiToolProvider {
    registry: ToolRegistry,
    owner: ToolOwner,
    window_id: String,
    relay: RelayProvider,
}

impl UiToolProvider {
    pub fn new(
        registry: ToolRegistry,
        provider_id: impl Into<String>,
        window_id: impl Into<String>,
        timeout: Duration,
        sink: Arc<dyn ToolBridgeEventSink>,
    ) -> Self {
        let provider_id = provider_id.into();
        let window_id = window_id.into();
        Self {
            registry,
            owner: ToolOwner::Provider(format!("ui:{provider_id}:{window_id}")),
            relay: RelayProvider::new(
                ToolRelayTarget::UiWindow {
                    provider_id,
                    window_id: window_id.clone(),
                },
                timeout,
                sink,
            ),
            window_id,
        }
    }

    pub fn owner(&self) -> &ToolOwner {
        &self.owner
    }

    pub fn reconcile(
        &self,
        definitions: Vec<DynamicToolDefinition>,
    ) -> Result<ReconcileReport, RegistryError> {
        self.relay.activate();
        let registrations = definitions
            .into_iter()
            .map(|definition| {
                let descriptor = definition.descriptor(self.owner.clone(), ToolSource::Ui);
                ToolRegistration::from_arc(
                    descriptor,
                    self.relay.handler(definition.canonical_name),
                )
            })
            .collect();
        self.registry
            .reconcile_owner(self.owner.clone(), registrations)
    }

    /// Register stable core descriptors whose implementation is hosted by this
    /// UI relay. Intended for Mim's built-in editor/settings surfaces; dynamic
    /// third-party tools should use [`Self::reconcile`] instead.
    pub fn register_core(
        &self,
        definitions: Vec<DynamicToolDefinition>,
    ) -> Result<Vec<u64>, RegistryError> {
        let mut revisions = Vec::with_capacity(definitions.len());
        for definition in definitions {
            let descriptor = definition.descriptor(ToolOwner::Core, ToolSource::Ui);
            revisions.push(self.registry.register(ToolRegistration::from_arc(
                descriptor,
                self.relay.handler(definition.canonical_name),
            ))?);
        }
        Ok(revisions)
    }

    pub async fn unregister(&self) -> u64 {
        self.relay.deactivate();
        let revision = self.registry.unregister_owner(&self.owner);
        self.relay
            .cancel_all(
                ToolRelayCancellationReason::ProviderUnregistered,
                ToolErrorCode::Unavailable,
                "UI tool provider was unregistered",
            )
            .await;
        revision
    }

    pub async fn resolve(&self, response: ToolRelayResponse) -> bool {
        self.relay.resolve(response).await
    }

    pub async fn cancel(&self, request_id: &str) -> bool {
        self.relay.cancel(request_id).await
    }

    /// A disconnect for another window is ignored, making this safe to call
    /// from a global Tauri `Destroyed` listener.
    pub async fn window_disconnected(&self, window_id: &str) -> usize {
        if window_id != self.window_id {
            return 0;
        }
        self.relay.deactivate();
        self.relay
            .cancel_all(
                ToolRelayCancellationReason::Disconnected,
                ToolErrorCode::Unavailable,
                "UI tool provider window disconnected",
            )
            .await
    }

    pub async fn pending_count(&self) -> usize {
        self.relay.pending_count().await
    }
}

/// Dynamic app-owned tools. App implementations may live in an iframe, TUI,
/// local process, or native Rust; the event sink decides where the request goes.
#[derive(Clone)]
pub struct AppToolProvider {
    registry: ToolRegistry,
    app_id: String,
    owner: ToolOwner,
    relay: RelayProvider,
}

impl AppToolProvider {
    pub fn new(
        registry: ToolRegistry,
        app_id: impl Into<String>,
        instance_id: impl Into<String>,
        timeout: Duration,
        sink: Arc<dyn ToolBridgeEventSink>,
    ) -> Self {
        let app_id = app_id.into();
        Self {
            registry,
            owner: ToolOwner::App(app_id.clone()),
            relay: RelayProvider::new(
                ToolRelayTarget::App {
                    app_id: app_id.clone(),
                    instance_id: instance_id.into(),
                },
                timeout,
                sink,
            ),
            app_id,
        }
    }

    pub fn app_id(&self) -> &str {
        &self.app_id
    }

    pub fn reconcile(
        &self,
        definitions: Vec<DynamicToolDefinition>,
    ) -> Result<ReconcileReport, RegistryError> {
        self.relay.activate();
        let registrations = definitions
            .into_iter()
            .map(|definition| {
                let descriptor =
                    definition.descriptor(self.owner.clone(), ToolSource::App(self.app_id.clone()));
                ToolRegistration::from_arc(
                    descriptor,
                    self.relay.handler(definition.canonical_name),
                )
            })
            .collect();
        self.registry
            .reconcile_owner(self.owner.clone(), registrations)
    }

    pub async fn unregister(&self) -> u64 {
        self.relay.deactivate();
        let revision = self.registry.unregister_owner(&self.owner);
        self.relay
            .cancel_all(
                ToolRelayCancellationReason::ProviderUnregistered,
                ToolErrorCode::Unavailable,
                "app tool provider was unregistered",
            )
            .await;
        revision
    }

    pub async fn resolve(&self, response: ToolRelayResponse) -> bool {
        self.relay.resolve(response).await
    }

    pub async fn cancel(&self, request_id: &str) -> bool {
        self.relay.cancel(request_id).await
    }

    pub async fn disconnected(&self) -> usize {
        self.relay.deactivate();
        self.relay
            .cancel_all(
                ToolRelayCancellationReason::Disconnected,
                ToolErrorCode::Unavailable,
                "app tool provider disconnected",
            )
            .await
    }

    pub async fn pending_count(&self) -> usize {
        self.relay.pending_count().await
    }
}

/// Construct a canonical core descriptor without repeating ownership fields.
pub fn core_tool_descriptor(
    canonical_name: impl Into<String>,
    mcp_alias: impl Into<String>,
    description: impl Into<String>,
    input_schema: Value,
    source: ToolSource,
) -> ToolDescriptor {
    ToolDescriptor::new(
        canonical_name,
        mcp_alias,
        description,
        input_schema,
        ToolOwner::Core,
        source,
    )
}

/// Register a native or UI-backed core handler in one call.
pub fn register_core_tool<H>(
    registry: &ToolRegistry,
    canonical_name: impl Into<String>,
    mcp_alias: impl Into<String>,
    description: impl Into<String>,
    input_schema: Value,
    source: ToolSource,
    handler: H,
) -> Result<u64, RegistryError>
where
    H: ToolHandler,
{
    registry.register(ToolRegistration::new(
        core_tool_descriptor(canonical_name, mcp_alias, description, input_schema, source),
        handler,
    ))
}

fn empty_object() -> Value {
    Value::Object(Map::new())
}

fn default_caller() -> ToolCaller {
    ToolCaller::Internal
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use serde_json::json;
    use tokio::sync::mpsc;

    use super::*;

    struct ChannelSink {
        calls: mpsc::UnboundedSender<ToolRelayRequest>,
        cancellations: mpsc::UnboundedSender<ToolRelayCancellation>,
        fail_calls: AtomicBool,
    }

    impl ToolBridgeEventSink for ChannelSink {
        fn emit_tool_call(&self, request: ToolRelayRequest) -> Result<(), String> {
            if self.fail_calls.load(Ordering::SeqCst) {
                return Err("event channel unavailable".to_string());
            }
            self.calls
                .send(request)
                .map_err(|_| "call receiver closed".to_string())
        }

        fn emit_tool_cancellation(
            &self,
            cancellation: ToolRelayCancellation,
        ) -> Result<(), String> {
            self.cancellations
                .send(cancellation)
                .map_err(|_| "cancellation receiver closed".to_string())
        }
    }

    fn channel_sink() -> (
        Arc<ChannelSink>,
        mpsc::UnboundedReceiver<ToolRelayRequest>,
        mpsc::UnboundedReceiver<ToolRelayCancellation>,
    ) {
        let (call_tx, call_rx) = mpsc::unbounded_channel();
        let (cancel_tx, cancel_rx) = mpsc::unbounded_channel();
        (
            Arc::new(ChannelSink {
                calls: call_tx,
                cancellations: cancel_tx,
                fail_calls: AtomicBool::new(false),
            }),
            call_rx,
            cancel_rx,
        )
    }

    fn definition(name: &str, alias: &str) -> DynamicToolDefinition {
        DynamicToolDefinition::new(
            name,
            alias,
            format!("Call {name}"),
            json!({
                "type": "object",
                "properties": {
                    "value": { "type": "string" }
                },
                "required": ["value"],
                "additionalProperties": false
            }),
        )
    }

    #[tokio::test]
    async fn command_facade_preserves_caller_context_and_cwd() {
        let registry = ToolRegistry::new();
        register_core_tool(
            &registry,
            "editor.context",
            "editor_context",
            "Inspect context",
            json!({
                "type": "object",
                "properties": { "value": { "type": "string" } },
                "required": ["value"]
            }),
            ToolSource::Native,
            |context: ToolCallContext, input: Value| async move {
                Ok(ToolResult::new(json!({
                    "caller": context.caller,
                    "requestId": context.request_id,
                    "cwd": context.cwd,
                    "metadata": context.metadata,
                    "input": input
                })))
            },
        )
        .unwrap();

        let mut request = ToolCallRequest::new(
            "editor_context",
            json!({ "value": "hello" }),
            ToolCaller::Mimx,
        );
        request.request_id = Some("outer-42".into());
        request.cwd = Some("/workspace".into());
        request.metadata.insert("session".into(), json!("agent-1"));
        let response = call(&registry, request).await;
        let value = response.into_result().unwrap().value;
        assert_eq!(value["caller"]["kind"], "mimx");
        assert_eq!(value["requestId"], "outer-42");
        assert_eq!(value["cwd"], "/workspace");
        assert_eq!(value["metadata"]["session"], "agent-1");

        let snapshot = snapshot(&registry).await;
        let listed = list(&registry).await;
        assert_eq!(snapshot.revision, listed.revision);
        assert_eq!(snapshot.tools, listed.tools);
    }

    #[tokio::test]
    async fn ui_provider_relays_and_resolves_with_full_context() {
        let registry = ToolRegistry::new();
        let (sink, mut calls, _cancellations) = channel_sink();
        let provider = UiToolProvider::new(
            registry.clone(),
            "editor",
            "main",
            Duration::from_secs(1),
            sink,
        );
        provider
            .reconcile(vec![definition("editor.selection", "editor_selection")])
            .unwrap();

        let call_registry = registry.clone();
        let task = tokio::spawn(async move {
            call_registry
                .call(
                    "editor_selection",
                    ToolCallContext {
                        request_id: Some("mcp-7".into()),
                        caller: ToolCaller::Mcp,
                        cwd: Some("/project".into()),
                        metadata: Map::new(),
                    },
                    json!({ "value": "selected" }),
                )
                .await
        });
        let relay = calls.recv().await.unwrap();
        assert_eq!(relay.tool, "editor.selection");
        assert_eq!(relay.context.request_id.as_deref(), Some("mcp-7"));
        assert_eq!(relay.context.caller, ToolCaller::Mcp);
        assert_eq!(relay.context.cwd.as_deref(), Some("/project"));
        assert_eq!(relay.input["value"], "selected");
        assert_eq!(
            relay.target,
            ToolRelayTarget::UiWindow {
                provider_id: "editor".into(),
                window_id: "main".into()
            }
        );

        assert!(
            provider
                .resolve(ToolRelayResponse::success(
                    relay.id,
                    ToolResult::new(json!({ "text": "selected" })),
                ))
                .await
        );
        assert_eq!(task.await.unwrap().unwrap().value["text"], "selected");
        assert_eq!(provider.pending_count().await, 0);
    }

    #[tokio::test]
    async fn timeout_resolves_call_clears_pending_and_notifies_host() {
        let registry = ToolRegistry::new();
        let (sink, mut calls, mut cancellations) = channel_sink();
        let provider = UiToolProvider::new(
            registry.clone(),
            "slow",
            "main",
            Duration::from_millis(10),
            sink,
        );
        provider
            .reconcile(vec![definition("slow.wait", "slow_wait")])
            .unwrap();

        let error = registry
            .call(
                "slow_wait",
                ToolCallContext::default(),
                json!({ "value": "wait" }),
            )
            .await
            .unwrap_err();
        let relay = calls.recv().await.unwrap();
        let cancellation = cancellations.recv().await.unwrap();
        assert_eq!(error.code, ToolErrorCode::Timeout);
        assert_eq!(cancellation.id, relay.id);
        assert_eq!(cancellation.reason, ToolRelayCancellationReason::TimedOut);
        assert_eq!(provider.pending_count().await, 0);
        assert!(
            !provider
                .resolve(ToolRelayResponse::success(
                    relay.id,
                    ToolResult::new(json!(null))
                ))
                .await
        );
    }

    #[tokio::test]
    async fn timeout_cleans_pending_even_when_caller_drops_its_future() {
        let registry = ToolRegistry::new();
        let (sink, mut calls, mut cancellations) = channel_sink();
        let provider = UiToolProvider::new(
            registry.clone(),
            "abandoned",
            "main",
            Duration::from_millis(10),
            sink,
        );
        provider
            .reconcile(vec![definition("abandoned.call", "abandoned_call")])
            .unwrap();

        let call_registry = registry.clone();
        let task = tokio::spawn(async move {
            call_registry
                .call(
                    "abandoned_call",
                    ToolCallContext::default(),
                    json!({ "value": "drop me" }),
                )
                .await
        });
        let relay = calls.recv().await.unwrap();
        task.abort();
        assert_eq!(provider.pending_count().await, 1);

        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(provider.pending_count().await, 0);
        let cancellation = cancellations.recv().await.unwrap();
        assert_eq!(cancellation.id, relay.id);
        assert_eq!(cancellation.reason, ToolRelayCancellationReason::TimedOut);
    }

    #[tokio::test]
    async fn explicit_cancel_resolves_the_pending_call() {
        let registry = ToolRegistry::new();
        let (sink, mut calls, mut cancellations) = channel_sink();
        let provider = UiToolProvider::new(
            registry.clone(),
            "editor",
            "main",
            Duration::from_secs(2),
            sink,
        );
        provider
            .reconcile(vec![definition("editor.long", "editor_long")])
            .unwrap();

        let call_registry = registry.clone();
        let task = tokio::spawn(async move {
            call_registry
                .call(
                    "editor_long",
                    ToolCallContext::default(),
                    json!({ "value": "run" }),
                )
                .await
        });
        let relay = calls.recv().await.unwrap();
        assert!(provider.cancel(&relay.id).await);
        let error = task.await.unwrap().unwrap_err();
        assert_eq!(error.code, ToolErrorCode::Cancelled);
        assert_eq!(
            cancellations.recv().await.unwrap().reason,
            ToolRelayCancellationReason::CallerCancelled
        );
        assert_eq!(provider.pending_count().await, 0);
    }

    #[tokio::test]
    async fn matching_window_disconnect_resolves_every_pending_call() {
        let registry = ToolRegistry::new();
        let (sink, mut calls, _cancellations) = channel_sink();
        let provider = UiToolProvider::new(
            registry.clone(),
            "editor",
            "main",
            Duration::from_secs(2),
            sink,
        );
        provider
            .reconcile(vec![definition("editor.long", "editor_long")])
            .unwrap();

        let first_registry = registry.clone();
        let first = tokio::spawn(async move {
            first_registry
                .call(
                    "editor_long",
                    ToolCallContext::default(),
                    json!({ "value": "one" }),
                )
                .await
        });
        let second_registry = registry.clone();
        let second = tokio::spawn(async move {
            second_registry
                .call(
                    "editor_long",
                    ToolCallContext::default(),
                    json!({ "value": "two" }),
                )
                .await
        });
        calls.recv().await.unwrap();
        calls.recv().await.unwrap();

        assert_eq!(provider.window_disconnected("other").await, 0);
        assert_eq!(provider.window_disconnected("main").await, 2);
        for task in [first, second] {
            assert_eq!(
                task.await.unwrap().unwrap_err().code,
                ToolErrorCode::Unavailable
            );
        }
        assert_eq!(provider.pending_count().await, 0);
    }

    #[tokio::test]
    async fn failed_event_delivery_resolves_immediately() {
        let registry = ToolRegistry::new();
        let (sink, _calls, _cancellations) = channel_sink();
        sink.fail_calls.store(true, Ordering::SeqCst);
        let provider = UiToolProvider::new(
            registry.clone(),
            "offline",
            "main",
            Duration::from_secs(2),
            sink,
        );
        provider
            .reconcile(vec![definition("offline.call", "offline_call")])
            .unwrap();

        let error = registry
            .call(
                "offline_call",
                ToolCallContext::default(),
                json!({ "value": "now" }),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, ToolErrorCode::Unavailable);
        assert_eq!(provider.pending_count().await, 0);
    }

    #[tokio::test]
    async fn app_provider_reconciles_relays_and_unregisters_dynamically() {
        let registry = ToolRegistry::new();
        let (sink, mut calls, _cancellations) = channel_sink();
        let provider = AppToolProvider::new(
            registry.clone(),
            "commute",
            "activity-9",
            Duration::from_secs(1),
            sink,
        );
        let report = provider
            .reconcile(vec![
                definition("commute.status", "commute_status"),
                definition("commute.routes", "commute_routes"),
            ])
            .unwrap();
        assert_eq!(
            report.added,
            ["commute.routes".to_string(), "commute.status".to_string()]
        );

        let call_registry = registry.clone();
        let task = tokio::spawn(async move {
            call_registry
                .call(
                    "commute_status",
                    ToolCallContext::new(ToolCaller::Routine("morning".into())),
                    json!({ "value": "RB24" }),
                )
                .await
        });
        let relay = calls.recv().await.unwrap();
        assert_eq!(
            relay.target,
            ToolRelayTarget::App {
                app_id: "commute".into(),
                instance_id: "activity-9".into()
            }
        );
        provider
            .resolve(ToolRelayResponse::success(
                relay.id,
                ToolResult::new(json!({ "ok": true })),
            ))
            .await;
        assert_eq!(task.await.unwrap().unwrap().value["ok"], true);

        let report = provider
            .reconcile(vec![definition("commute.status", "commute_status")])
            .unwrap();
        assert_eq!(report.removed, ["commute.routes"]);
        let revision = provider.unregister().await;
        assert_eq!(revision, 3);
        assert!(registry.descriptor("commute_status").is_none());
    }

    #[tokio::test]
    async fn registry_revisions_are_observable_for_list_changed_events() {
        let registry = ToolRegistry::new();
        let mut observer = observe_revisions(&registry);
        assert_eq!(observer.current().revision, 0);

        register_core_tool(
            &registry,
            "files.read",
            "files_read",
            "Read a file",
            json!({ "type": "object" }),
            ToolSource::Native,
            |_context, _input| async { Ok(ToolResult::new(json!(null))) },
        )
        .unwrap();
        assert_eq!(observer.changed().await.unwrap().revision, 1);
    }
}
