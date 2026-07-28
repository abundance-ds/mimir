//! Canonical, provider-agnostic registry for every tool exposed by Mimir.
//!
//! The registry deliberately knows nothing about Tauri, HTTP, MCP transport, or
//! the UI event bridge. Those layers register handlers here and render
//! [`ToolDescriptor`]s in the shape their protocol expects. Keeping dispatch in
//! one place ensures `mimir`, MCP clients, apps, routines, and native callers all
//! see the same catalog and validation behavior.

use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fmt,
    future::Future,
    pin::Pin,
    sync::{Arc, RwLock, RwLockReadGuard, RwLockWriteGuard},
};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tokio::sync::watch;

/// Identity that owns a registered tool.
///
/// Ownership is used for atomic provider reconciliation and, importantly, to
/// prevent one app/provider from replacing another one's handler.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", content = "id", rename_all = "snake_case")]
pub enum ToolOwner {
    Core,
    App(String),
    Provider(String),
}

impl ToolOwner {
    fn is_core(&self) -> bool {
        matches!(self, Self::Core)
    }
}

impl fmt::Display for ToolOwner {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Core => f.write_str("core"),
            Self::App(id) => write!(f, "app:{id}"),
            Self::Provider(id) => write!(f, "provider:{id}"),
        }
    }
}

/// Where a tool's implementation is hosted.
///
/// `owner` answers who may replace/unregister a tool; `source` tells dispatch
/// and diagnostics how the implementation is reached.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "id", rename_all = "snake_case")]
pub enum ToolSource {
    Native,
    Ui,
    App(String),
    Integration(String),
    External(String),
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolAnnotations {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_only_hint: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destructive_hint: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idempotent_hint: Option<bool>,
}

impl ToolAnnotations {
    pub fn is_empty(&self) -> bool {
        self.read_only_hint.is_none()
            && self.destructive_hint.is_none()
            && self.idempotent_hint.is_none()
    }
}

/// Public catalog entry. Canonical names are stable internal identifiers while
/// `mcp_alias` is the protocol-facing spelling accepted by MCP clients.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDescriptor {
    pub canonical_name: String,
    pub mcp_alias: String,
    pub description: String,
    pub input_schema: Value,
    pub owner: ToolOwner,
    pub source: ToolSource,
    #[serde(default, skip_serializing_if = "ToolAnnotations::is_empty")]
    pub annotations: ToolAnnotations,
}

impl ToolDescriptor {
    pub fn new(
        canonical_name: impl Into<String>,
        mcp_alias: impl Into<String>,
        description: impl Into<String>,
        input_schema: Value,
        owner: ToolOwner,
        source: ToolSource,
    ) -> Self {
        let canonical_name = canonical_name.into();
        Self {
            annotations: inferred_annotations(&canonical_name),
            canonical_name,
            mcp_alias: mcp_alias.into(),
            description: description.into(),
            input_schema,
            owner,
            source,
        }
    }

    pub fn with_annotations(mut self, annotations: ToolAnnotations) -> Self {
        self.annotations = annotations;
        self
    }
}

fn inferred_annotations(canonical_name: &str) -> ToolAnnotations {
    let action = canonical_name.rsplit('.').next().unwrap_or(canonical_name);
    let read_only = [
        "active",
        "board",
        "browse",
        "catalog",
        "comments",
        "content",
        "context",
        "diagnostics",
        "events",
        "find",
        "get",
        "graph",
        "list",
        "migration_report",
        "neighbors",
        "query",
        "read",
        "resolve_reference",
        "search",
        "selection",
        "state",
        "status",
        "tabs",
    ]
    .contains(&action);
    let destructive = ["clear", "delete", "stop", "trash"].contains(&action);
    ToolAnnotations {
        read_only_hint: Some(read_only),
        destructive_hint: Some(destructive),
        idempotent_hint: read_only.then_some(true),
    }
}

/// The origin of an individual invocation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "id", rename_all = "snake_case")]
pub enum ToolCaller {
    Mcp,
    MimirCli,
    Ui,
    App(String),
    Routine(String),
    Internal,
}

/// Transport-neutral metadata supplied to every handler.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallContext {
    pub request_id: Option<String>,
    pub caller: ToolCaller,
    pub cwd: Option<String>,
    #[serde(default)]
    pub metadata: Map<String, Value>,
}

impl ToolCallContext {
    pub fn new(caller: ToolCaller) -> Self {
        Self {
            request_id: None,
            caller,
            cwd: None,
            metadata: Map::new(),
        }
    }
}

impl Default for ToolCallContext {
    fn default() -> Self {
        Self::new(ToolCaller::Internal)
    }
}

/// Successful transport-neutral handler output.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    pub value: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_text: Option<String>,
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub metadata: Map<String, Value>,
}

impl ToolResult {
    pub fn new(value: Value) -> Self {
        Self {
            value,
            display_text: None,
            metadata: Map::new(),
        }
    }

    pub fn with_display_text(value: Value, display_text: impl Into<String>) -> Self {
        Self {
            value,
            display_text: Some(display_text.into()),
            metadata: Map::new(),
        }
    }
}

impl From<Value> for ToolResult {
    fn from(value: Value) -> Self {
        Self::new(value)
    }
}

/// Stable error categories that transports can map to JSON-RPC, CLI, or UI
/// representations without inspecting prose.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolErrorCode {
    NotFound,
    InvalidInput,
    Cancelled,
    Timeout,
    Unavailable,
    Handler,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolError {
    pub code: ToolErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl ToolError {
    pub fn new(code: ToolErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }

    pub fn with_data(mut self, data: Value) -> Self {
        self.data = Some(data);
        self
    }
}

impl fmt::Display for ToolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ToolError {}

pub type ToolCallResult = Result<ToolResult, ToolError>;
pub type ToolFuture = Pin<Box<dyn Future<Output = ToolCallResult> + Send + 'static>>;

/// Object-safe async handler without requiring `async-trait`.
pub trait ToolHandler: Send + Sync + 'static {
    fn call(&self, context: ToolCallContext, input: Value) -> ToolFuture;
}

impl<F, Fut> ToolHandler for F
where
    F: Fn(ToolCallContext, Value) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = ToolCallResult> + Send + 'static,
{
    fn call(&self, context: ToolCallContext, input: Value) -> ToolFuture {
        Box::pin((self)(context, input))
    }
}

#[derive(Clone)]
pub struct ToolRegistration {
    pub descriptor: ToolDescriptor,
    pub handler: Arc<dyn ToolHandler>,
}

impl ToolRegistration {
    pub fn new<H>(descriptor: ToolDescriptor, handler: H) -> Self
    where
        H: ToolHandler,
    {
        Self {
            descriptor,
            handler: Arc::new(handler),
        }
    }

    pub fn from_arc(descriptor: ToolDescriptor, handler: Arc<dyn ToolHandler>) -> Self {
        Self {
            descriptor,
            handler,
        }
    }
}

impl fmt::Debug for ToolRegistration {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ToolRegistration")
            .field("descriptor", &self.descriptor)
            .field("handler", &"<async handler>")
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RegistryError {
    InvalidDescriptor {
        field: &'static str,
        message: String,
    },
    ReservedCoreName(String),
    ReservedCoreAlias(String),
    NameCollision {
        name: String,
        existing_owner: ToolOwner,
    },
    AliasCollision {
        alias: String,
        existing_owner: ToolOwner,
    },
    OwnerMismatch {
        tool: String,
        expected: ToolOwner,
        actual: ToolOwner,
    },
    DuplicateInBatch(String),
    NotFound(String),
}

impl fmt::Display for RegistryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidDescriptor { field, message } => {
                write!(f, "invalid tool descriptor field '{field}': {message}")
            }
            Self::ReservedCoreName(name) => {
                write!(f, "tool name '{name}' is reserved for the core")
            }
            Self::ReservedCoreAlias(alias) => {
                write!(f, "MCP alias '{alias}' is reserved for the core")
            }
            Self::NameCollision {
                name,
                existing_owner,
            } => write!(f, "tool name '{name}' is already owned by {existing_owner}"),
            Self::AliasCollision {
                alias,
                existing_owner,
            } => write!(
                f,
                "MCP alias '{alias}' is already owned by {existing_owner}"
            ),
            Self::OwnerMismatch {
                tool,
                expected,
                actual,
            } => write!(
                f,
                "tool '{tool}' is owned by {actual}, not requested owner {expected}"
            ),
            Self::DuplicateInBatch(value) => {
                write!(
                    f,
                    "duplicate name or alias '{value}' in reconciliation batch"
                )
            }
            Self::NotFound(name) => write!(f, "tool '{name}' is not registered"),
        }
    }
}

impl std::error::Error for RegistryError {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrySnapshot {
    pub revision: u64,
    pub tools: Vec<ToolDescriptor>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReconcileReport {
    pub added: Vec<String>,
    pub updated: Vec<String>,
    pub removed: Vec<String>,
    pub revision: u64,
}

#[derive(Clone)]
struct RegisteredTool {
    descriptor: ToolDescriptor,
    handler: Arc<dyn ToolHandler>,
}

#[derive(Clone, Default)]
struct RegistryState {
    tools: BTreeMap<String, RegisteredTool>,
    aliases: HashMap<String, String>,
    reserved_core_names: HashSet<String>,
    reserved_core_aliases: HashSet<String>,
    revision: u64,
}

struct RegistryInner {
    state: RwLock<RegistryState>,
    revision_tx: watch::Sender<u64>,
}

/// Thread-safe canonical tool registry.
///
/// Every successful catalog mutation advances a monotonically increasing
/// revision. Consumers can subscribe to that revision and emit MCP
/// `notifications/tools/list_changed` (or refresh native UI) without coupling
/// the registry to either transport.
#[derive(Clone)]
pub struct ToolRegistry {
    inner: Arc<RegistryInner>,
}

impl fmt::Debug for ToolRegistry {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let state = self.read_state();
        f.debug_struct("ToolRegistry")
            .field("revision", &state.revision)
            .field("tool_count", &state.tools.len())
            .finish()
    }
}

impl Default for ToolRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl ToolRegistry {
    pub fn new() -> Self {
        let (revision_tx, _revision_rx) = watch::channel(0);
        Self {
            inner: Arc::new(RegistryInner {
                state: RwLock::new(RegistryState::default()),
                revision_tx,
            }),
        }
    }

    /// Permanently reserve exact canonical names and aliases before dynamic
    /// providers load. Core registration also reserves its name and alias.
    pub fn reserve_core_tool(
        &self,
        canonical_name: impl Into<String>,
        mcp_alias: impl Into<String>,
    ) -> Result<(), RegistryError> {
        let canonical_name = canonical_name.into();
        let mcp_alias = mcp_alias.into();
        validate_canonical_name(&canonical_name)?;
        validate_mcp_alias(&mcp_alias)?;

        let mut state = self.write_state();
        if let Some(existing) = state.tools.get(&canonical_name) {
            if !existing.descriptor.owner.is_core() {
                return Err(RegistryError::NameCollision {
                    name: canonical_name,
                    existing_owner: existing.descriptor.owner.clone(),
                });
            }
        }
        if let Some(existing_name) = state.aliases.get(&canonical_name) {
            let existing = state
                .tools
                .get(existing_name)
                .expect("alias index must point to a registered tool");
            if !existing.descriptor.owner.is_core() {
                return Err(RegistryError::NameCollision {
                    name: canonical_name,
                    existing_owner: existing.descriptor.owner.clone(),
                });
            }
        }
        if let Some(existing) = state.tools.get(&mcp_alias) {
            if !existing.descriptor.owner.is_core() {
                return Err(RegistryError::AliasCollision {
                    alias: mcp_alias,
                    existing_owner: existing.descriptor.owner.clone(),
                });
            }
        }
        if let Some(existing_name) = state.aliases.get(&mcp_alias) {
            let existing = state
                .tools
                .get(existing_name)
                .expect("alias index must point to a registered tool");
            if !existing.descriptor.owner.is_core() {
                return Err(RegistryError::AliasCollision {
                    alias: mcp_alias,
                    existing_owner: existing.descriptor.owner.clone(),
                });
            }
        }

        state.reserved_core_names.insert(canonical_name);
        state.reserved_core_aliases.insert(mcp_alias);
        Ok(())
    }

    pub fn register(&self, registration: ToolRegistration) -> Result<u64, RegistryError> {
        validate_descriptor(&registration.descriptor)?;

        let revision = {
            let mut state = self.write_state();
            let mut working = state.clone();

            if let Some(existing) = working.tools.get(&registration.descriptor.canonical_name) {
                if existing.descriptor.owner == registration.descriptor.owner {
                    remove_tool(&mut working, &registration.descriptor.canonical_name);
                }
            }

            insert_tool(&mut working, registration)?;
            working.revision = state.revision.saturating_add(1);
            let revision = working.revision;
            *state = working;
            revision
        };

        self.publish_revision(revision);
        Ok(revision)
    }

    /// Atomically replace all tools owned by `owner` with `registrations`.
    ///
    /// Failed validation/collision leaves the previous provider catalog intact.
    /// Existing tools from other owners are never displaced: therefore the
    /// first app/provider to claim a name or alias wins until it unregisters.
    pub fn reconcile_owner(
        &self,
        owner: ToolOwner,
        registrations: Vec<ToolRegistration>,
    ) -> Result<ReconcileReport, RegistryError> {
        validate_reconcile_batch(&owner, &registrations)?;

        let report = {
            let mut state = self.write_state();
            let old_names: HashSet<String> = state
                .tools
                .values()
                .filter(|tool| tool.descriptor.owner == owner)
                .map(|tool| tool.descriptor.canonical_name.clone())
                .collect();
            let new_names: HashSet<String> = registrations
                .iter()
                .map(|registration| registration.descriptor.canonical_name.clone())
                .collect();

            if old_names.is_empty() && new_names.is_empty() {
                return Ok(ReconcileReport {
                    revision: state.revision,
                    ..ReconcileReport::default()
                });
            }

            let mut working = state.clone();
            for name in &old_names {
                remove_tool(&mut working, name);
            }
            for registration in registrations {
                insert_tool(&mut working, registration)?;
            }

            working.revision = state.revision.saturating_add(1);
            let report = ReconcileReport {
                added: sorted_difference(&new_names, &old_names),
                updated: sorted_intersection(&old_names, &new_names),
                removed: sorted_difference(&old_names, &new_names),
                revision: working.revision,
            };
            *state = working;
            report
        };

        self.publish_revision(report.revision);
        Ok(report)
    }

    /// Unregister by canonical name or MCP alias, requiring exact ownership.
    pub fn unregister(&self, identifier: &str, owner: &ToolOwner) -> Result<u64, RegistryError> {
        let revision = {
            let mut state = self.write_state();
            let canonical_name = resolve_name(&state, identifier)
                .ok_or_else(|| RegistryError::NotFound(identifier.to_string()))?
                .to_string();
            let existing = state
                .tools
                .get(&canonical_name)
                .expect("resolved name must exist");
            if &existing.descriptor.owner != owner {
                return Err(RegistryError::OwnerMismatch {
                    tool: canonical_name,
                    expected: owner.clone(),
                    actual: existing.descriptor.owner.clone(),
                });
            }
            remove_tool(&mut state, &canonical_name);
            state.revision = state.revision.saturating_add(1);
            state.revision
        };

        self.publish_revision(revision);
        Ok(revision)
    }

    pub fn unregister_owner(&self, owner: &ToolOwner) -> u64 {
        let changed_revision = {
            let mut state = self.write_state();
            let names: Vec<String> = state
                .tools
                .values()
                .filter(|tool| &tool.descriptor.owner == owner)
                .map(|tool| tool.descriptor.canonical_name.clone())
                .collect();
            if names.is_empty() {
                return state.revision;
            }
            for name in names {
                remove_tool(&mut state, &name);
            }
            state.revision = state.revision.saturating_add(1);
            state.revision
        };

        self.publish_revision(changed_revision);
        changed_revision
    }

    pub fn revision(&self) -> u64 {
        self.read_state().revision
    }

    pub fn subscribe_revision(&self) -> watch::Receiver<u64> {
        self.inner.revision_tx.subscribe()
    }

    pub fn snapshot(&self) -> RegistrySnapshot {
        let state = self.read_state();
        RegistrySnapshot {
            revision: state.revision,
            tools: state
                .tools
                .values()
                .map(|tool| tool.descriptor.clone())
                .collect(),
        }
    }

    pub fn list(&self) -> Vec<ToolDescriptor> {
        self.snapshot().tools
    }

    pub fn descriptor(&self, identifier: &str) -> Option<ToolDescriptor> {
        let state = self.read_state();
        let canonical_name = resolve_name(&state, identifier)?;
        state
            .tools
            .get(canonical_name)
            .map(|tool| tool.descriptor.clone())
    }

    pub async fn call(
        &self,
        identifier: &str,
        context: ToolCallContext,
        input: Value,
    ) -> ToolCallResult {
        // Clone the handler and schema before awaiting so a slow UI/app tool
        // never holds the registry lock or blocks catalog reconciliation.
        let (descriptor, handler) = {
            let state = self.read_state();
            let canonical_name = resolve_name(&state, identifier).ok_or_else(|| {
                ToolError::new(
                    ToolErrorCode::NotFound,
                    format!("tool '{identifier}' is not registered"),
                )
            })?;
            let registered = state
                .tools
                .get(canonical_name)
                .expect("resolved name must exist");
            (
                registered.descriptor.clone(),
                Arc::clone(&registered.handler),
            )
        };

        if !input.is_object() {
            return Err(ToolError::new(
                ToolErrorCode::InvalidInput,
                format!(
                    "invalid input for '{}': arguments must be a JSON object",
                    descriptor.canonical_name
                ),
            ));
        }
        let validation_errors = collect_json_errors(&input, &descriptor.input_schema, "$");
        if !validation_errors.is_empty() {
            return Err(ToolError::new(
                ToolErrorCode::InvalidInput,
                format!(
                    "invalid input for '{}':\n- {}",
                    descriptor.canonical_name,
                    validation_errors.join("\n- ")
                ),
            )
            .with_data(serde_json::json!({ "errors": validation_errors })));
        }

        handler.call(context, input).await
    }

    fn read_state(&self) -> RwLockReadGuard<'_, RegistryState> {
        self.inner
            .state
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn write_state(&self) -> RwLockWriteGuard<'_, RegistryState> {
        self.inner
            .state
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn publish_revision(&self, revision: u64) {
        // Mutations are serialized by the state lock, but publishers release
        // that lock before waking listeners. A delayed thread must therefore
        // never be allowed to overwrite a newer watched revision.
        self.inner.revision_tx.send_if_modified(|published| {
            if revision > *published {
                *published = revision;
                true
            } else {
                false
            }
        });
    }
}

fn resolve_name<'a>(state: &'a RegistryState, identifier: &str) -> Option<&'a str> {
    if let Some((canonical_name, _)) = state.tools.get_key_value(identifier) {
        return Some(canonical_name.as_str());
    }
    state.aliases.get(identifier).map(String::as_str)
}

fn remove_tool(state: &mut RegistryState, canonical_name: &str) -> Option<RegisteredTool> {
    let removed = state.tools.remove(canonical_name)?;
    if state
        .aliases
        .get(&removed.descriptor.mcp_alias)
        .is_some_and(|name| name == canonical_name)
    {
        state.aliases.remove(&removed.descriptor.mcp_alias);
    }
    Some(removed)
}

fn insert_tool(
    state: &mut RegistryState,
    registration: ToolRegistration,
) -> Result<(), RegistryError> {
    let descriptor = &registration.descriptor;
    let is_core = descriptor.owner.is_core();

    if !is_core
        && state
            .reserved_core_names
            .contains(&descriptor.canonical_name)
    {
        return Err(RegistryError::ReservedCoreName(
            descriptor.canonical_name.clone(),
        ));
    }
    if !is_core && state.reserved_core_aliases.contains(&descriptor.mcp_alias) {
        return Err(RegistryError::ReservedCoreAlias(
            descriptor.mcp_alias.clone(),
        ));
    }

    if let Some(existing) = state.tools.get(&descriptor.canonical_name) {
        return Err(RegistryError::NameCollision {
            name: descriptor.canonical_name.clone(),
            existing_owner: existing.descriptor.owner.clone(),
        });
    }
    if let Some(existing_name) = state.aliases.get(&descriptor.canonical_name) {
        let existing = state
            .tools
            .get(existing_name)
            .expect("alias index must point to a registered tool");
        return Err(RegistryError::NameCollision {
            name: descriptor.canonical_name.clone(),
            existing_owner: existing.descriptor.owner.clone(),
        });
    }

    if descriptor.mcp_alias != descriptor.canonical_name {
        if let Some(existing) = state.tools.get(&descriptor.mcp_alias) {
            return Err(RegistryError::AliasCollision {
                alias: descriptor.mcp_alias.clone(),
                existing_owner: existing.descriptor.owner.clone(),
            });
        }
    }
    if let Some(existing_name) = state.aliases.get(&descriptor.mcp_alias) {
        let existing = state
            .tools
            .get(existing_name)
            .expect("alias index must point to a registered tool");
        return Err(RegistryError::AliasCollision {
            alias: descriptor.mcp_alias.clone(),
            existing_owner: existing.descriptor.owner.clone(),
        });
    }

    if is_core {
        state
            .reserved_core_names
            .insert(descriptor.canonical_name.clone());
        state
            .reserved_core_aliases
            .insert(descriptor.mcp_alias.clone());
    }
    state.aliases.insert(
        descriptor.mcp_alias.clone(),
        descriptor.canonical_name.clone(),
    );
    state.tools.insert(
        descriptor.canonical_name.clone(),
        RegisteredTool {
            descriptor: registration.descriptor,
            handler: registration.handler,
        },
    );
    Ok(())
}

fn validate_reconcile_batch(
    owner: &ToolOwner,
    registrations: &[ToolRegistration],
) -> Result<(), RegistryError> {
    let mut names = HashSet::new();
    let mut aliases = HashSet::new();
    for registration in registrations {
        let descriptor = &registration.descriptor;
        validate_descriptor(descriptor)?;
        if &descriptor.owner != owner {
            return Err(RegistryError::OwnerMismatch {
                tool: descriptor.canonical_name.clone(),
                expected: owner.clone(),
                actual: descriptor.owner.clone(),
            });
        }
        if !names.insert(descriptor.canonical_name.clone()) {
            return Err(RegistryError::DuplicateInBatch(
                descriptor.canonical_name.clone(),
            ));
        }
        if !aliases.insert(descriptor.mcp_alias.clone()) {
            return Err(RegistryError::DuplicateInBatch(
                descriptor.mcp_alias.clone(),
            ));
        }
    }

    for name in &names {
        if aliases.contains(name)
            && !registrations.iter().any(|registration| {
                registration.descriptor.canonical_name == *name
                    && registration.descriptor.mcp_alias == *name
            })
        {
            return Err(RegistryError::DuplicateInBatch(name.clone()));
        }
    }
    Ok(())
}

fn validate_descriptor(descriptor: &ToolDescriptor) -> Result<(), RegistryError> {
    validate_canonical_name(&descriptor.canonical_name)?;
    validate_mcp_alias(&descriptor.mcp_alias)?;
    if descriptor.description.trim().is_empty() {
        return Err(RegistryError::InvalidDescriptor {
            field: "description",
            message: "must not be empty".to_string(),
        });
    }
    if descriptor.description.len() > 4_096 {
        return Err(RegistryError::InvalidDescriptor {
            field: "description",
            message: "must be at most 4096 bytes".to_string(),
        });
    }
    validate_schema_definition(&descriptor.input_schema, "$").map_err(|message| {
        RegistryError::InvalidDescriptor {
            field: "inputSchema",
            message,
        }
    })?;
    Ok(())
}

fn validate_canonical_name(name: &str) -> Result<(), RegistryError> {
    if name.len() > 128 {
        return Err(RegistryError::InvalidDescriptor {
            field: "canonicalName",
            message: "must be at most 128 bytes".to_string(),
        });
    }
    let parts: Vec<&str> = name.split('.').collect();
    if parts.len() < 2
        || parts
            .iter()
            .any(|part| !is_valid_name_component(part, false))
    {
        return Err(RegistryError::InvalidDescriptor {
            field: "canonicalName",
            message: "must be a dotted lowercase name such as 'editor.get_state'".to_string(),
        });
    }
    Ok(())
}

fn validate_mcp_alias(alias: &str) -> Result<(), RegistryError> {
    if alias.len() > 128 || !is_valid_name_component(alias, true) {
        return Err(RegistryError::InvalidDescriptor {
            field: "mcpAlias",
            message: "must contain only ASCII letters, digits, '.', '_', or '-' and start with a letter or '_'"
                .to_string(),
        });
    }
    Ok(())
}

fn is_valid_name_component(value: &str, allow_dot: bool) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first.is_ascii_alphabetic() || first == '_') {
        return false;
    }
    chars.all(|character| {
        character.is_ascii_alphanumeric()
            || character == '_'
            || character == '-'
            || (allow_dot && character == '.')
    })
}

fn sorted_difference(left: &HashSet<String>, right: &HashSet<String>) -> Vec<String> {
    let mut values: Vec<String> = left.difference(right).cloned().collect();
    values.sort();
    values
}

fn sorted_intersection(left: &HashSet<String>, right: &HashSet<String>) -> Vec<String> {
    let mut values: Vec<String> = left.intersection(right).cloned().collect();
    values.sort();
    values
}

// ── Lightweight JSON Schema validation ──────────────────────────
//
// MCP tool arguments are JSON objects. Supporting the practical validation
// subset here avoids a heavyweight dependency while still catching malformed
// provider schemas and bad calls. Unknown annotation/extension keywords remain
// forward-compatible and are ignored.

const JSON_TYPES: &[&str] = &[
    "null", "boolean", "object", "array", "number", "integer", "string",
];

fn validate_schema_definition(schema: &Value, path: &str) -> Result<(), String> {
    validate_schema_definition_inner(schema, path, false)
}

fn validate_schema_definition_inner(
    schema: &Value,
    path: &str,
    allow_boolean_schema: bool,
) -> Result<(), String> {
    if schema.is_boolean() && allow_boolean_schema {
        return Ok(());
    }
    let object = schema
        .as_object()
        .ok_or_else(|| format!("{path} must be a JSON object"))?;

    if let Some(schema_type) = object.get("type") {
        match schema_type {
            Value::String(value) if JSON_TYPES.contains(&value.as_str()) => {}
            Value::Array(values)
                if !values.is_empty()
                    && values.iter().all(|value| {
                        value
                            .as_str()
                            .is_some_and(|value| JSON_TYPES.contains(&value))
                    }) => {}
            _ => {
                return Err(format!(
                    "{path}.type must be a JSON Schema type or non-empty array of types"
                ));
            }
        }
    }

    if let Some(required) = object.get("required") {
        let values = required
            .as_array()
            .ok_or_else(|| format!("{path}.required must be an array"))?;
        let mut seen = HashSet::new();
        for value in values {
            let field = value
                .as_str()
                .ok_or_else(|| format!("{path}.required entries must be strings"))?;
            if !seen.insert(field) {
                return Err(format!("{path}.required contains duplicate '{field}'"));
            }
        }
    }

    if let Some(properties) = object.get("properties") {
        let properties = properties
            .as_object()
            .ok_or_else(|| format!("{path}.properties must be an object"))?;
        for (name, property_schema) in properties {
            validate_schema_definition_inner(
                property_schema,
                &format!("{path}.properties.{name}"),
                true,
            )?;
        }
    }

    if let Some(additional) = object.get("additionalProperties") {
        if !additional.is_boolean() {
            validate_schema_definition_inner(
                additional,
                &format!("{path}.additionalProperties"),
                true,
            )?;
        }
    }

    if let Some(items) = object.get("items") {
        validate_schema_definition_inner(items, &format!("{path}.items"), true)?;
    }

    for keyword in ["allOf", "anyOf", "oneOf"] {
        if let Some(branches) = object.get(keyword) {
            let branches = branches
                .as_array()
                .filter(|branches| !branches.is_empty())
                .ok_or_else(|| format!("{path}.{keyword} must be a non-empty array"))?;
            for (index, branch) in branches.iter().enumerate() {
                validate_schema_definition_inner(
                    branch,
                    &format!("{path}.{keyword}[{index}]"),
                    true,
                )?;
            }
        }
    }

    if let Some(not_schema) = object.get("not") {
        validate_schema_definition_inner(not_schema, &format!("{path}.not"), true)?;
    }
    if object
        .get("enum")
        .is_some_and(|value| value.as_array().is_none_or(Vec::is_empty))
    {
        return Err(format!("{path}.enum must be a non-empty array"));
    }

    for keyword in ["minLength", "maxLength", "minItems", "maxItems"] {
        if object
            .get(keyword)
            .is_some_and(|value| value.as_u64().is_none())
        {
            return Err(format!("{path}.{keyword} must be a non-negative integer"));
        }
    }
    if let Some(pattern) = object.get("pattern") {
        let pattern = pattern
            .as_str()
            .ok_or_else(|| format!("{path}.pattern must be a string"))?;
        regex::Regex::new(pattern)
            .map_err(|error| format!("{path}.pattern is invalid: {error}"))?;
    }
    if object
        .get("uniqueItems")
        .is_some_and(|value| value.as_bool().is_none())
    {
        return Err(format!("{path}.uniqueItems must be a boolean"));
    }
    for keyword in ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"] {
        if object
            .get(keyword)
            .is_some_and(|value| value.as_f64().is_none())
        {
            return Err(format!("{path}.{keyword} must be a number"));
        }
    }

    Ok(())
}

fn validate_json_value(value: &Value, schema: &Value, path: &str) -> Result<(), String> {
    if let Some(allowed) = schema.as_bool() {
        return if allowed {
            Ok(())
        } else {
            Err(format!("{path} is forbidden by the schema"))
        };
    }
    let object = schema
        .as_object()
        .expect("registered schemas are validated before use");

    if let Some(expected) = object.get("type") {
        let matches = match expected {
            Value::String(expected) => value_matches_type(value, expected),
            Value::Array(expected) => expected
                .iter()
                .filter_map(Value::as_str)
                .any(|expected| value_matches_type(value, expected)),
            _ => false,
        };
        if !matches {
            return Err(format!(
                "{path} must be {}, got {}",
                render_expected_type(expected),
                json_type(value)
            ));
        }
    }

    if let Some(expected) = object.get("const") {
        if value != expected {
            return Err(format!("{path} must equal {expected}"));
        }
    }
    if let Some(allowed) = object.get("enum").and_then(Value::as_array) {
        if !allowed.contains(value) {
            return Err(format!(
                "{path} must be one of {}",
                Value::Array(allowed.clone())
            ));
        }
    }

    if let Some(branches) = object.get("allOf").and_then(Value::as_array) {
        for branch in branches {
            validate_json_value(value, branch, path)?;
        }
    }
    if let Some(branches) = object.get("anyOf").and_then(Value::as_array) {
        if !branches
            .iter()
            .any(|branch| validate_json_value(value, branch, path).is_ok())
        {
            return Err(format!("{path} does not match any allowed schema"));
        }
    }
    if let Some(branches) = object.get("oneOf").and_then(Value::as_array) {
        let matches = branches
            .iter()
            .filter(|branch| validate_json_value(value, branch, path).is_ok())
            .count();
        if matches != 1 {
            return Err(format!(
                "{path} must match exactly one allowed schema (matched {matches})"
            ));
        }
    }
    if let Some(not_schema) = object.get("not") {
        if validate_json_value(value, not_schema, path).is_ok() {
            return Err(format!("{path} matches a forbidden schema"));
        }
    }

    if let Some(value) = value.as_object() {
        validate_object(value, object, path)?;
    }
    if let Some(value) = value.as_array() {
        validate_array(value, object, path)?;
    }
    if let Some(value) = value.as_str() {
        validate_string(value, object, path)?;
    }
    if let Some(value) = value.as_f64() {
        validate_number(value, object, path)?;
    }
    Ok(())
}

fn collect_json_errors(value: &Value, schema: &Value, path: &str) -> Vec<String> {
    let mut errors = Vec::new();
    collect_json_errors_into(value, schema, path, &mut errors);
    errors
}

fn collect_json_errors_into(value: &Value, schema: &Value, path: &str, errors: &mut Vec<String>) {
    if let Some(allowed) = schema.as_bool() {
        if !allowed {
            errors.push(format!("{path} is forbidden by the schema"));
        }
        return;
    }
    let object = schema
        .as_object()
        .expect("registered schemas are validated before use");

    if let Some(expected) = object.get("type") {
        let matches = match expected {
            Value::String(expected) => value_matches_type(value, expected),
            Value::Array(expected) => expected
                .iter()
                .filter_map(Value::as_str)
                .any(|expected| value_matches_type(value, expected)),
            _ => false,
        };
        if !matches {
            errors.push(format!(
                "{path} must be {}, got {}",
                render_expected_type(expected),
                json_type(value)
            ));
            return;
        }
    }

    if let Some(expected) = object.get("const") {
        if value != expected {
            errors.push(format!("{path} must equal {expected}"));
        }
    }
    if let Some(allowed) = object.get("enum").and_then(Value::as_array) {
        if !allowed.contains(value) {
            errors.push(format!(
                "{path} must be one of {}",
                Value::Array(allowed.clone())
            ));
        }
    }

    if let Some(branches) = object.get("allOf").and_then(Value::as_array) {
        for branch in branches {
            collect_json_errors_into(value, branch, path, errors);
        }
    }
    if let Some(branches) = object.get("anyOf").and_then(Value::as_array) {
        if !branches
            .iter()
            .any(|branch| validate_json_value(value, branch, path).is_ok())
        {
            errors.push(format!("{path} does not match any allowed schema"));
        }
    }
    if let Some(branches) = object.get("oneOf").and_then(Value::as_array) {
        let matches = branches
            .iter()
            .filter(|branch| validate_json_value(value, branch, path).is_ok())
            .count();
        if matches != 1 {
            errors.push(format!(
                "{path} must match exactly one allowed schema (matched {matches})"
            ));
        }
    }
    if let Some(not_schema) = object.get("not") {
        if validate_json_value(value, not_schema, path).is_ok() {
            errors.push(format!("{path} matches a forbidden schema"));
        }
    }

    if let Some(value) = value.as_object() {
        if let Some(required) = object.get("required").and_then(Value::as_array) {
            for field in required.iter().filter_map(Value::as_str) {
                if !value.contains_key(field) {
                    errors.push(format!("{path} is missing required property '{field}'"));
                }
            }
        }
        let properties = object.get("properties").and_then(Value::as_object);
        for (field, field_value) in value {
            let field_path = format!("{path}.{field}");
            if let Some(field_schema) = properties.and_then(|properties| properties.get(field)) {
                collect_json_errors_into(field_value, field_schema, &field_path, errors);
                continue;
            }
            match object.get("additionalProperties") {
                Some(Value::Bool(false)) => {
                    errors.push(format!("{path} contains unknown property '{field}'"));
                }
                Some(additional_schema)
                    if additional_schema.is_object() || additional_schema.is_boolean() =>
                {
                    collect_json_errors_into(field_value, additional_schema, &field_path, errors);
                }
                _ => {}
            }
        }
    }
    if let Some(value) = value.as_array() {
        if let Some(minimum) = object.get("minItems").and_then(Value::as_u64) {
            if value.len() < minimum as usize {
                errors.push(format!("{path} must contain at least {minimum} items"));
            }
        }
        if let Some(maximum) = object.get("maxItems").and_then(Value::as_u64) {
            if value.len() > maximum as usize {
                errors.push(format!("{path} must contain at most {maximum} items"));
            }
        }
        if object
            .get("uniqueItems")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            && value
                .iter()
                .enumerate()
                .any(|(index, item)| value[..index].contains(item))
        {
            errors.push(format!("{path} must contain unique items"));
        }
        if let Some(item_schema) = object.get("items") {
            for (index, item) in value.iter().enumerate() {
                collect_json_errors_into(item, item_schema, &format!("{path}[{index}]"), errors);
            }
        }
    }
    if let Some(value) = value.as_str() {
        let character_count = value.chars().count();
        if let Some(minimum) = object.get("minLength").and_then(Value::as_u64) {
            if character_count < minimum as usize {
                errors.push(format!("{path} must contain at least {minimum} characters"));
            }
        }
        if let Some(maximum) = object.get("maxLength").and_then(Value::as_u64) {
            if character_count > maximum as usize {
                errors.push(format!("{path} must contain at most {maximum} characters"));
            }
        }
        if let Some(pattern) = object.get("pattern").and_then(Value::as_str) {
            if !regex::Regex::new(pattern)
                .expect("registered schema patterns are validated")
                .is_match(value)
            {
                errors.push(format!("{path} must match pattern {pattern:?}"));
            }
        }
    }
    if let Some(value) = value.as_f64() {
        if let Some(minimum) = object.get("minimum").and_then(Value::as_f64) {
            if value < minimum {
                errors.push(format!("{path} must be at least {minimum}"));
            }
        }
        if let Some(maximum) = object.get("maximum").and_then(Value::as_f64) {
            if value > maximum {
                errors.push(format!("{path} must be at most {maximum}"));
            }
        }
        if let Some(minimum) = object.get("exclusiveMinimum").and_then(Value::as_f64) {
            if value <= minimum {
                errors.push(format!("{path} must be greater than {minimum}"));
            }
        }
        if let Some(maximum) = object.get("exclusiveMaximum").and_then(Value::as_f64) {
            if value >= maximum {
                errors.push(format!("{path} must be less than {maximum}"));
            }
        }
    }
}

fn validate_object(
    value: &Map<String, Value>,
    schema: &Map<String, Value>,
    path: &str,
) -> Result<(), String> {
    if let Some(required) = schema.get("required").and_then(Value::as_array) {
        for field in required.iter().filter_map(Value::as_str) {
            if !value.contains_key(field) {
                return Err(format!("{path} is missing required property '{field}'"));
            }
        }
    }

    let properties = schema.get("properties").and_then(Value::as_object);
    for (field, field_value) in value {
        if let Some(field_schema) = properties.and_then(|properties| properties.get(field)) {
            validate_json_value(field_value, field_schema, &format!("{path}.{field}"))?;
            continue;
        }
        match schema.get("additionalProperties") {
            Some(Value::Bool(false)) => {
                return Err(format!("{path} contains unknown property '{field}'"));
            }
            Some(additional_schema) if additional_schema.is_object() => {
                validate_json_value(field_value, additional_schema, &format!("{path}.{field}"))?;
            }
            _ => {}
        }
    }
    Ok(())
}

fn validate_array(value: &[Value], schema: &Map<String, Value>, path: &str) -> Result<(), String> {
    if let Some(minimum) = schema.get("minItems").and_then(Value::as_u64) {
        if value.len() < minimum as usize {
            return Err(format!("{path} must contain at least {minimum} items"));
        }
    }
    if let Some(maximum) = schema.get("maxItems").and_then(Value::as_u64) {
        if value.len() > maximum as usize {
            return Err(format!("{path} must contain at most {maximum} items"));
        }
    }
    if schema
        .get("uniqueItems")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        for (index, item) in value.iter().enumerate() {
            if value[..index].contains(item) {
                return Err(format!("{path} must contain unique items"));
            }
        }
    }
    if let Some(item_schema) = schema.get("items") {
        for (index, item) in value.iter().enumerate() {
            validate_json_value(item, item_schema, &format!("{path}[{index}]"))?;
        }
    }
    Ok(())
}

fn validate_string(value: &str, schema: &Map<String, Value>, path: &str) -> Result<(), String> {
    let character_count = value.chars().count();
    if let Some(minimum) = schema.get("minLength").and_then(Value::as_u64) {
        if character_count < minimum as usize {
            return Err(format!("{path} must contain at least {minimum} characters"));
        }
    }
    if let Some(maximum) = schema.get("maxLength").and_then(Value::as_u64) {
        if character_count > maximum as usize {
            return Err(format!("{path} must contain at most {maximum} characters"));
        }
    }
    if let Some(pattern) = schema.get("pattern").and_then(Value::as_str) {
        if !regex::Regex::new(pattern)
            .expect("registered schema patterns are validated")
            .is_match(value)
        {
            return Err(format!("{path} must match pattern {pattern:?}"));
        }
    }
    Ok(())
}

fn validate_number(value: f64, schema: &Map<String, Value>, path: &str) -> Result<(), String> {
    if let Some(minimum) = schema.get("minimum").and_then(Value::as_f64) {
        if value < minimum {
            return Err(format!("{path} must be at least {minimum}"));
        }
    }
    if let Some(maximum) = schema.get("maximum").and_then(Value::as_f64) {
        if value > maximum {
            return Err(format!("{path} must be at most {maximum}"));
        }
    }
    if let Some(minimum) = schema.get("exclusiveMinimum").and_then(Value::as_f64) {
        if value <= minimum {
            return Err(format!("{path} must be greater than {minimum}"));
        }
    }
    if let Some(maximum) = schema.get("exclusiveMaximum").and_then(Value::as_f64) {
        if value >= maximum {
            return Err(format!("{path} must be less than {maximum}"));
        }
    }
    Ok(())
}

fn value_matches_type(value: &Value, expected: &str) -> bool {
    match expected {
        "null" => value.is_null(),
        "boolean" => value.is_boolean(),
        "object" => value.is_object(),
        "array" => value.is_array(),
        "number" => value.is_number(),
        "integer" => {
            value.as_i64().is_some()
                || value.as_u64().is_some()
                || value.as_f64().is_some_and(|number| number.fract() == 0.0)
        }
        "string" => value.is_string(),
        _ => false,
    }
}

fn render_expected_type(expected: &Value) -> String {
    match expected {
        Value::String(value) => value.clone(),
        Value::Array(values) => values
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(" or "),
        _ => "the declared type".to_string(),
    }
}

fn json_type(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use serde_json::json;

    use super::*;

    fn schema() -> Value {
        json!({
            "type": "object",
            "properties": {
                "text": { "type": "string", "minLength": 1 },
                "count": { "type": "integer", "minimum": 1 }
            },
            "required": ["text"],
            "additionalProperties": false
        })
    }

    fn descriptor(canonical_name: &str, alias: &str, owner: ToolOwner) -> ToolDescriptor {
        ToolDescriptor::new(
            canonical_name,
            alias,
            format!("Call {canonical_name}"),
            schema(),
            owner,
            ToolSource::Native,
        )
    }

    fn registration(
        canonical_name: &str,
        alias: &str,
        owner: ToolOwner,
        marker: &'static str,
    ) -> ToolRegistration {
        ToolRegistration::new(
            descriptor(canonical_name, alias, owner),
            move |_context, input: Value| async move {
                Ok(ToolResult::new(json!({
                    "marker": marker,
                    "input": input,
                })))
            },
        )
    }

    #[test]
    fn find_is_inferred_as_read_only() {
        let descriptor = descriptor("graph.find", "graph_find", ToolOwner::Core);
        assert_eq!(descriptor.annotations.read_only_hint, Some(true));
        assert_eq!(descriptor.annotations.idempotent_hint, Some(true));
    }

    #[test]
    fn validates_names_descriptions_and_schema_definitions() {
        let registry = ToolRegistry::new();
        let handler = |_context, _input| async { Ok(json!(null).into()) };

        let invalid_name = ToolRegistration::new(
            descriptor("not_dotted", "valid_alias", ToolOwner::Core),
            handler,
        );
        assert!(matches!(
            registry.register(invalid_name),
            Err(RegistryError::InvalidDescriptor {
                field: "canonicalName",
                ..
            })
        ));

        let mut invalid_schema = descriptor("editor.invalid", "editor_invalid", ToolOwner::Core);
        invalid_schema.input_schema = json!({
            "type": "object",
            "required": "path"
        });
        assert!(matches!(
            registry.register(ToolRegistration::new(
                invalid_schema,
                |_context, _input| async { Ok(json!(null).into()) }
            )),
            Err(RegistryError::InvalidDescriptor {
                field: "inputSchema",
                ..
            })
        ));
        assert_eq!(registry.revision(), 0);
    }

    #[tokio::test]
    async fn lists_in_canonical_order_and_calls_by_name_or_alias() {
        let registry = ToolRegistry::new();
        registry
            .register(registration(
                "files.search",
                "files_search",
                ToolOwner::Core,
                "files",
            ))
            .unwrap();
        registry
            .register(registration(
                "editor.get_state",
                "editor_get_state",
                ToolOwner::Core,
                "editor",
            ))
            .unwrap();

        assert_eq!(
            registry
                .list()
                .into_iter()
                .map(|tool| tool.canonical_name)
                .collect::<Vec<_>>(),
            ["editor.get_state", "files.search"]
        );
        assert_eq!(
            registry
                .descriptor("editor_get_state")
                .unwrap()
                .canonical_name,
            "editor.get_state"
        );

        let result = registry
            .call(
                "editor_get_state",
                ToolCallContext::new(ToolCaller::Mcp),
                json!({ "text": "hello" }),
            )
            .await
            .unwrap();
        assert_eq!(result.value["marker"], "editor");

        let result = registry
            .call(
                "files.search",
                ToolCallContext::new(ToolCaller::MimirCli),
                json!({ "text": "needle", "count": 2 }),
            )
            .await
            .unwrap();
        assert_eq!(result.value["marker"], "files");
    }

    #[tokio::test]
    async fn rejects_invalid_arguments_before_invoking_handler() {
        let calls = Arc::new(AtomicUsize::new(0));
        let handler_calls = Arc::clone(&calls);
        let registry = ToolRegistry::new();
        registry
            .register(ToolRegistration::new(
                descriptor("editor.replace", "editor_replace", ToolOwner::Core),
                move |_context, _input| {
                    let handler_calls = Arc::clone(&handler_calls);
                    async move {
                        handler_calls.fetch_add(1, Ordering::SeqCst);
                        Ok(json!({}).into())
                    }
                },
            ))
            .unwrap();

        for invalid in [
            json!("not an object"),
            json!({}),
            json!({ "text": "" }),
            json!({ "text": "ok", "count": 0 }),
            json!({ "text": "ok", "unknown": true }),
        ] {
            let error = registry
                .call("editor.replace", ToolCallContext::default(), invalid)
                .await
                .unwrap_err();
            assert_eq!(error.code, ToolErrorCode::InvalidInput);
        }
        let error = registry
            .call(
                "editor.replace",
                ToolCallContext::default(),
                json!({ "text": 5, "count": 0, "unknown": true }),
            )
            .await
            .unwrap_err();
        let errors = error
            .data
            .as_ref()
            .and_then(|data| data.get("errors"))
            .and_then(Value::as_array)
            .unwrap();
        assert_eq!(errors.len(), 3);
        assert!(error.message.contains("$.text must be string"));
        assert!(error.message.contains("$.count must be at least 1"));
        assert!(error.message.contains("unknown property 'unknown'"));
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn core_names_and_aliases_remain_reserved_after_unregister() {
        let registry = ToolRegistry::new();
        registry
            .reserve_core_tool("editor.open", "editor_open")
            .unwrap();

        let app_owner = ToolOwner::App("notes".into());
        assert!(matches!(
            registry.register(registration(
                "editor.open",
                "notes_open",
                app_owner.clone(),
                "app"
            )),
            Err(RegistryError::ReservedCoreName(_))
        ));
        assert!(matches!(
            registry.register(registration(
                "notes.open",
                "editor_open",
                app_owner.clone(),
                "app"
            )),
            Err(RegistryError::ReservedCoreAlias(_))
        ));

        registry
            .register(registration(
                "editor.open",
                "editor_open",
                ToolOwner::Core,
                "core",
            ))
            .unwrap();
        registry
            .unregister("editor_open", &ToolOwner::Core)
            .unwrap();

        assert!(matches!(
            registry.register(registration("editor.open", "editor_open", app_owner, "app")),
            Err(RegistryError::ReservedCoreName(_))
        ));
    }

    #[test]
    fn core_reservation_detects_cross_index_app_collisions() {
        let registry = ToolRegistry::new();
        let owner = ToolOwner::App("calendar".into());
        registry
            .register(registration(
                "calendar.today",
                "calendar.bridge",
                owner,
                "app",
            ))
            .unwrap();

        assert!(matches!(
            registry.reserve_core_tool("calendar.bridge", "core_calendar_today"),
            Err(RegistryError::NameCollision { .. })
        ));
        assert!(matches!(
            registry.reserve_core_tool("core.calendar", "calendar.today"),
            Err(RegistryError::AliasCollision { .. })
        ));
    }

    #[tokio::test]
    async fn first_app_owner_wins_until_it_unregisters() {
        let registry = ToolRegistry::new();
        let first = ToolOwner::App("first".into());
        let second = ToolOwner::App("second".into());

        registry
            .register(registration(
                "weather.forecast",
                "weather_forecast",
                first.clone(),
                "first",
            ))
            .unwrap();
        assert!(matches!(
            registry.register(registration(
                "weather.forecast",
                "other_alias",
                second.clone(),
                "second"
            )),
            Err(RegistryError::NameCollision { .. })
        ));
        assert!(matches!(
            registry.register(registration(
                "weather.current",
                "weather_forecast",
                second.clone(),
                "second"
            )),
            Err(RegistryError::AliasCollision { .. })
        ));

        let result = registry
            .call(
                "weather_forecast",
                ToolCallContext::default(),
                json!({ "text": "Berlin" }),
            )
            .await
            .unwrap();
        assert_eq!(result.value["marker"], "first");

        registry.unregister("weather.forecast", &first).unwrap();
        registry
            .register(registration(
                "weather.forecast",
                "weather_forecast",
                second,
                "second",
            ))
            .unwrap();
    }

    #[tokio::test]
    async fn same_owner_can_atomically_replace_a_handler_and_alias() {
        let registry = ToolRegistry::new();
        let owner = ToolOwner::Provider("ui-bridge".into());
        registry
            .register(registration(
                "editor.selection",
                "editor_selection",
                owner.clone(),
                "old",
            ))
            .unwrap();
        let revision = registry
            .register(registration(
                "editor.selection",
                "selection_get",
                owner,
                "new",
            ))
            .unwrap();

        assert_eq!(revision, 2);
        assert!(registry.descriptor("editor_selection").is_none());
        let result = registry
            .call(
                "selection_get",
                ToolCallContext::default(),
                json!({ "text": "selection" }),
            )
            .await
            .unwrap();
        assert_eq!(result.value["marker"], "new");
    }

    #[tokio::test]
    async fn reconcile_is_atomic_reports_changes_and_notifies_revision() {
        let registry = ToolRegistry::new();
        let owner = ToolOwner::App("commute".into());
        let mut revisions = registry.subscribe_revision();

        let report = registry
            .reconcile_owner(
                owner.clone(),
                vec![
                    registration("commute.status", "commute_status", owner.clone(), "v1"),
                    registration("commute.alerts", "commute_alerts", owner.clone(), "v1"),
                ],
            )
            .unwrap();
        assert_eq!(
            report.added,
            ["commute.alerts".to_string(), "commute.status".to_string()]
        );
        assert!(report.updated.is_empty());
        assert!(report.removed.is_empty());
        revisions.changed().await.unwrap();
        assert_eq!(*revisions.borrow_and_update(), 1);

        let report = registry
            .reconcile_owner(
                owner.clone(),
                vec![
                    registration("commute.status", "commute_status", owner.clone(), "v2"),
                    registration("commute.routes", "commute_routes", owner, "v2"),
                ],
            )
            .unwrap();
        assert_eq!(report.added, ["commute.routes"]);
        assert_eq!(report.updated, ["commute.status"]);
        assert_eq!(report.removed, ["commute.alerts"]);
        assert_eq!(report.revision, 2);
        assert!(registry.descriptor("commute_alerts").is_none());

        let result = registry
            .call(
                "commute_status",
                ToolCallContext::default(),
                json!({ "text": "RB24" }),
            )
            .await
            .unwrap();
        assert_eq!(result.value["marker"], "v2");
    }

    #[test]
    fn revision_notifications_never_move_backwards() {
        let registry = ToolRegistry::new();
        let revisions = registry.subscribe_revision();
        registry.publish_revision(7);
        registry.publish_revision(3);
        assert_eq!(*revisions.borrow(), 7);
    }

    #[test]
    fn failed_reconcile_rolls_back_entire_provider_catalog() {
        let registry = ToolRegistry::new();
        let core = ToolOwner::Core;
        registry
            .register(registration("files.read", "files_read", core, "core"))
            .unwrap();

        let app = ToolOwner::App("notes".into());
        registry
            .register(registration(
                "notes.create",
                "notes_create",
                app.clone(),
                "old",
            ))
            .unwrap();
        let before = registry.snapshot();

        let error = registry
            .reconcile_owner(
                app.clone(),
                vec![
                    registration("notes.updated", "notes_updated", app.clone(), "new"),
                    registration("files.read", "notes_read", app, "collision"),
                ],
            )
            .unwrap_err();
        assert!(matches!(
            error,
            RegistryError::NameCollision { .. } | RegistryError::ReservedCoreName(_)
        ));
        assert_eq!(registry.snapshot(), before);
    }

    #[test]
    fn unregister_requires_owner_and_owner_unregistration_is_idempotent() {
        let registry = ToolRegistry::new();
        let owner = ToolOwner::App("notes".into());
        registry
            .register(registration(
                "notes.create",
                "notes_create",
                owner.clone(),
                "app",
            ))
            .unwrap();
        assert!(matches!(
            registry.unregister("notes_create", &ToolOwner::App("other".into())),
            Err(RegistryError::OwnerMismatch { .. })
        ));
        assert!(registry.descriptor("notes.create").is_some());

        assert_eq!(registry.unregister_owner(&owner), 2);
        assert_eq!(registry.unregister_owner(&owner), 2);
        assert!(registry.list().is_empty());
    }

    #[tokio::test]
    async fn context_and_handler_errors_are_preserved() {
        let registry = ToolRegistry::new();
        registry
            .register(ToolRegistration::new(
                descriptor("shell.run", "shell_run", ToolOwner::Core),
                |context: ToolCallContext, _input| async move {
                    assert_eq!(context.request_id.as_deref(), Some("request-7"));
                    assert_eq!(context.cwd.as_deref(), Some("/workspace"));
                    Err(
                        ToolError::new(ToolErrorCode::Unavailable, "shell provider is offline")
                            .with_data(json!({ "retryable": true })),
                    )
                },
            ))
            .unwrap();

        let mut context = ToolCallContext::new(ToolCaller::Routine("morning".into()));
        context.request_id = Some("request-7".into());
        context.cwd = Some("/workspace".into());
        let error = registry
            .call("shell_run", context, json!({ "text": "pwd" }))
            .await
            .unwrap_err();
        assert_eq!(error.code, ToolErrorCode::Unavailable);
        assert_eq!(error.data.unwrap()["retryable"], true);
    }

    #[tokio::test]
    async fn supports_composed_and_nested_schema_validation() {
        let registry = ToolRegistry::new();
        let mut descriptor = descriptor("files.batch", "files_batch", ToolOwner::Core);
        descriptor.input_schema = json!({
            "type": "object",
            "properties": {
                "mode": { "enum": ["read", "write"] },
                "paths": {
                    "type": "array",
                    "minItems": 1,
                    "uniqueItems": true,
                    "items": { "type": "string", "minLength": 1 }
                },
                "limit": {
                    "oneOf": [
                        { "type": "integer", "minimum": 1, "maximum": 10 },
                        { "type": "null" }
                    ]
                }
            },
            "required": ["mode", "paths"],
            "additionalProperties": false
        });
        registry
            .register(ToolRegistration::new(
                descriptor,
                |_context, input: Value| async move { Ok(input.into()) },
            ))
            .unwrap();

        assert!(registry
            .call(
                "files_batch",
                ToolCallContext::default(),
                json!({ "mode": "read", "paths": ["a", "b"], "limit": null }),
            )
            .await
            .is_ok());
        for invalid in [
            json!({ "mode": "delete", "paths": ["a"] }),
            json!({ "mode": "read", "paths": [] }),
            json!({ "mode": "read", "paths": ["a", "a"] }),
            json!({ "mode": "write", "paths": ["a"], "limit": 20 }),
        ] {
            assert_eq!(
                registry
                    .call("files_batch", ToolCallContext::default(), invalid)
                    .await
                    .unwrap_err()
                    .code,
                ToolErrorCode::InvalidInput
            );
        }
    }

    #[tokio::test]
    async fn supports_boolean_schemas_in_nested_positions() {
        let registry = ToolRegistry::new();
        let mut descriptor = descriptor("files.strict", "files_strict", ToolOwner::Core);
        descriptor.input_schema = json!({
            "type": "object",
            "properties": {
                "allowed": true,
                "forbidden": false
            },
            "additionalProperties": false
        });
        registry
            .register(ToolRegistration::new(
                descriptor,
                |_context, input: Value| async move { Ok(input.into()) },
            ))
            .unwrap();

        assert!(registry
            .call(
                "files_strict",
                ToolCallContext::default(),
                json!({ "allowed": { "anything": true } }),
            )
            .await
            .is_ok());
        assert_eq!(
            registry
                .call(
                    "files_strict",
                    ToolCallContext::default(),
                    json!({ "forbidden": null }),
                )
                .await
                .unwrap_err()
                .code,
            ToolErrorCode::InvalidInput
        );
    }

    #[tokio::test]
    async fn unknown_tools_return_structured_not_found_errors() {
        let error = ToolRegistry::new()
            .call("missing_tool", ToolCallContext::default(), json!({}))
            .await
            .unwrap_err();
        assert_eq!(error.code, ToolErrorCode::NotFound);
        assert!(error.message.contains("missing_tool"));
    }
}
