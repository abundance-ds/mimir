//! Native business graph tools.
//!
//! This module owns the shared registration plumbing and routes each tool
//! call to the domain submodule (`graph`, `knowledge`, `issues`, `projects`,
//! `research`) that defines its schema and handler.

mod graph;
mod issues;
mod knowledge;
mod projects;
mod research;
mod support;
#[cfg(test)]
mod tests;

use super::{GraphActor, GraphActorKind, GraphNode, GraphRuntime, GraphScopeKind};
use crate::tool_registry::{
    ToolCallContext, ToolCaller, ToolDescriptor, ToolError, ToolErrorCode, ToolOwner,
    ToolRegistration, ToolRegistry, ToolResult, ToolSource,
};
use crate::workspace_config::{self, WorkspaceConfig, WorkspaceGraphScope};
use serde_json::Value;
use std::path::PathBuf;
use support::internal_error;
use tauri::{Emitter, Manager};

const GRAPH_CHANGED_EVENT: &str = "mimir://graph-changed";
const PRIVATE_SCOPE_WARNING: &str =
    "Private scope: do not put this data in another scope unless the user asked.";

#[derive(Debug)]
struct NativeExecution {
    value: Value,
    changed_path: Option<String>,
}

impl NativeExecution {
    fn read(value: Value) -> Self {
        Self {
            value,
            changed_path: None,
        }
    }

    fn mutation(value: Value, changed_path: String) -> Self {
        Self {
            value,
            changed_path: Some(changed_path),
        }
    }
}

pub(crate) fn register_native_tools(
    registry: &ToolRegistry,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    for (name, alias, description, schema) in native_tool_definitions() {
        let app = app.clone();
        let dispatch_name = name.to_string();
        let registration = ToolRegistration::new(
            ToolDescriptor::new(
                name,
                alias,
                description,
                schema,
                ToolOwner::Core,
                ToolSource::Native,
            ),
            move |context: ToolCallContext, mut input: Value| {
                let app = app.clone();
                let dispatch_name = dispatch_name.clone();
                async move {
                    ensure_open(&app, &context)?;
                    let runtime = app.state::<GraphRuntime>();
                    let workspace = agent_workspace_config(&context)?;
                    apply_workspace_defaults(
                        &runtime,
                        &context,
                        &dispatch_name,
                        &mut input,
                        workspace.as_ref(),
                    )?;
                    let before = mutation_before(&runtime, &dispatch_name, &input)?;
                    let execution = execute_native_tool(&runtime, &dispatch_name, input)?;
                    if let Some(path) = execution.changed_path.as_ref() {
                        let after = mutation_after(&runtime, &dispatch_name, &execution.value)?;
                        runtime
                            .record_mutation(
                                dispatch_name.clone(),
                                graph_actor(&context),
                                before,
                                after,
                                path.clone(),
                            )
                            .map_err(internal_error)?;
                        emit_changed(&app, &runtime, path.clone())?;
                    }
                    Ok(ToolResult::new(execution.value))
                }
            },
        );
        registry
            .register(registration)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn apply_workspace_defaults(
    runtime: &GraphRuntime,
    context: &ToolCallContext,
    action: &str,
    input: &mut Value,
    config: Option<&WorkspaceConfig>,
) -> Result<(), ToolError> {
    if !is_create_action(action) {
        return Ok(());
    }
    let Some(config) = config else {
        return Ok(());
    };
    let Some(object) = input.as_object_mut() else {
        return Ok(());
    };
    if !object.contains_key("scopeId") {
        let scope_id = configured_scope_id(runtime, context, config)?;
        object.insert("scopeId".into(), Value::String(scope_id));
    }
    let Some(project_id) = config.project_id.as_deref() else {
        return Ok(());
    };
    match action {
        "issues.create" => {
            object
                .entry("project")
                .or_insert_with(|| Value::String(project_id.into()));
        }
        "graph.create" => {
            let kind = object
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if project_bound_kind(kind) {
                add_project_relation(object, "relations", project_id);
            }
        }
        "knowledge.create" => {
            let kind = object.get("type").and_then(Value::as_str).unwrap_or("note");
            if project_bound_kind(kind) {
                add_project_relation(object, "links", project_id);
            }
        }
        "research.capture_evidence" => {
            object
                .entry("project")
                .or_insert_with(|| Value::String(project_id.into()));
        }
        _ => {}
    }
    Ok(())
}

fn agent_workspace_config(context: &ToolCallContext) -> Result<Option<WorkspaceConfig>, ToolError> {
    let workspace_bound = context
        .metadata
        .get("activityId")
        .and_then(Value::as_str)
        .is_some()
        || matches!(
            context.caller,
            ToolCaller::Mcp | ToolCaller::MimirCli | ToolCaller::Routine(_)
        );
    if !workspace_bound {
        return Ok(None);
    }
    let Some(cwd) = context.cwd.as_deref() else {
        return Ok(None);
    };
    workspace_config::read_workspace_config(cwd)
        .map_err(|error| ToolError::new(ToolErrorCode::Unavailable, error))
}

fn configured_scope_id(
    runtime: &GraphRuntime,
    context: &ToolCallContext,
    config: &WorkspaceConfig,
) -> Result<String, ToolError> {
    let status = runtime.open_result().map_err(internal_error)?;
    match config.graph_scope {
        WorkspaceGraphScope::Team => status
            .scopes
            .iter()
            .find(|scope| scope.kind == GraphScopeKind::Team)
            .map(|scope| scope.id.clone())
            .ok_or_else(|| {
                ToolError::new(
                    ToolErrorCode::Unavailable,
                    "This workspace writes to Team, but no Team graph is mounted.",
                )
            }),
        WorkspaceGraphScope::Workspace => {
            let cwd = context.cwd.as_deref().unwrap_or_default();
            let canonical = std::fs::canonicalize(cwd).map_err(|error| {
                ToolError::new(
                    ToolErrorCode::Unavailable,
                    format!("Could not resolve the Activity workspace: {error}"),
                )
            })?;
            status
                .scopes
                .iter()
                .find(|scope| {
                    scope.kind == GraphScopeKind::Project
                        && std::fs::canonicalize(&scope.root).ok().as_ref() == Some(&canonical)
                })
                .map(|scope| scope.id.clone())
                .ok_or_else(|| {
                    ToolError::new(
                        ToolErrorCode::Unavailable,
                        "This Activity's Workspace graph is not mounted.",
                    )
                })
        }
    }
}

fn project_bound_kind(kind: &str) -> bool {
    !matches!(kind, "" | "company" | "person" | "project" | "journal")
}

fn add_project_relation(
    object: &mut serde_json::Map<String, Value>,
    field: &str,
    project_id: &str,
) {
    let relations = object
        .entry(field)
        .or_insert_with(|| Value::Array(Vec::new()));
    let Some(relations) = relations.as_array_mut() else {
        return;
    };
    if relations.iter().any(|edge| {
        edge.get("relation").and_then(Value::as_str) == Some("part_of")
            || edge.get("rel").and_then(Value::as_str) == Some("part_of")
    }) {
        return;
    }
    relations.push(serde_json::json!({
        "relation": "part_of",
        "target": project_id,
    }));
}

fn mutation_before(
    runtime: &GraphRuntime,
    action: &str,
    input: &Value,
) -> Result<Option<GraphNode>, ToolError> {
    if is_create_action(action) || action == "graph.restore" {
        return Ok(None);
    }
    let Some(id) = input.get("id").and_then(Value::as_str) else {
        return Ok(None);
    };
    runtime.get(id).map_err(internal_error)
}

fn mutation_after(
    runtime: &GraphRuntime,
    action: &str,
    output: &Value,
) -> Result<Option<GraphNode>, ToolError> {
    if action.ends_with(".delete") || action == "graph.delete" {
        return Ok(None);
    }
    let Some(id) = output.get("id").and_then(Value::as_str) else {
        return Ok(None);
    };
    runtime.get(id).map_err(internal_error)
}

fn is_create_action(action: &str) -> bool {
    action.ends_with(".create")
        || matches!(
            action,
            "projects.record_decision" | "issues.create_next_action" | "research.capture_evidence"
        )
}

fn graph_actor(context: &ToolCallContext) -> GraphActor {
    let activity_id = context
        .metadata
        .get("activityId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let agent_id = context
        .metadata
        .get("agentId")
        .and_then(Value::as_str)
        .unwrap_or("agent");
    if activity_id.is_some() || matches!(context.caller, ToolCaller::Routine(_)) {
        return GraphActor {
            kind: GraphActorKind::Agent,
            id: agent_id.into(),
            label: human_agent(agent_id),
            initials: agent_initials(agent_id),
            activity_id,
        };
    }
    match &context.caller {
        ToolCaller::Ui | ToolCaller::MimirCli => GraphActor::human(),
        ToolCaller::App(id) => GraphActor {
            kind: GraphActorKind::System,
            id: id.clone(),
            label: format!("App · {id}"),
            initials: "APP".into(),
            activity_id: None,
        },
        ToolCaller::Routine(id) => GraphActor {
            kind: GraphActorKind::Agent,
            id: id.clone(),
            label: format!("Routine · {id}"),
            initials: "RT".into(),
            activity_id: None,
        },
        ToolCaller::Mcp | ToolCaller::Internal => GraphActor::external(),
    }
}

fn human_agent(value: &str) -> String {
    match value {
        "codex" => "Codex".into(),
        "claude" => "Claude".into(),
        "pi" => "Pi".into(),
        other => other.replace(['-', '_'], " "),
    }
}

fn agent_initials(value: &str) -> String {
    match value {
        "codex" => "CX".into(),
        "claude" => "CL".into(),
        "pi" => "PI".into(),
        _ => value
            .split(['-', '_', ' '])
            .filter_map(|part| part.chars().next())
            .take(3)
            .collect::<String>()
            .to_uppercase(),
    }
}

fn ensure_open(app: &tauri::AppHandle, context: &ToolCallContext) -> Result<(), ToolError> {
    let runtime = app.state::<GraphRuntime>();
    let status = runtime.open_result().map_err(internal_error)?;
    if !status.scopes.is_empty() {
        return Ok(());
    }
    let cwd = context.cwd.as_deref().ok_or_else(|| {
        ToolError::new(
            ToolErrorCode::Unavailable,
            "the business graph needs an open workspace or a tool call cwd",
        )
    })?;
    runtime
        .open(app, PathBuf::from(cwd), None)
        .map_err(|error| ToolError::new(ToolErrorCode::Unavailable, error))?;
    Ok(())
}

fn emit_changed(
    app: &tauri::AppHandle,
    runtime: &GraphRuntime,
    path: String,
) -> Result<(), ToolError> {
    let status = runtime.open_result().map_err(internal_error)?;
    app.emit(
        GRAPH_CHANGED_EVENT,
        super::GraphChanged {
            graph_revision: status.graph_revision,
            node_count: status.node_count,
            diagnostic_count: status.diagnostic_count,
            paths: vec![path],
        },
    )
    .map_err(|error| ToolError::new(ToolErrorCode::Internal, error.to_string()))
}

fn execute_native_tool(
    runtime: &GraphRuntime,
    name: &str,
    input: Value,
) -> Result<NativeExecution, ToolError> {
    let mut execution = match name.split('.').next().unwrap_or_default() {
        "graph" => graph::execute(runtime, name, input),
        "knowledge" => knowledge::execute(runtime, name, input),
        "issues" => issues::execute(runtime, name, input),
        "projects" => projects::execute(runtime, name, input),
        "research" => research::execute(runtime, name, input),
        _ => Err(unknown_tool(name)),
    }?;
    workspace_config::enrich_graph_result(name, &mut execution.value);
    add_private_scope_warning(name, &mut execution.value);
    Ok(execution)
}

fn add_private_scope_warning(name: &str, value: &mut Value) {
    if !matches!(
        name,
        "graph.find" | "graph.get" | "graph.context" | "graph.events"
    ) || !contains_private_scope(value)
    {
        return;
    }
    let Some(output) = value.as_object_mut() else {
        return;
    };
    if name == "graph.context" {
        let Some(markdown) = output.get("markdown").and_then(Value::as_str) else {
            return;
        };
        let header = "# Business graph context\n\n";
        let rest = markdown.strip_prefix(header).unwrap_or(markdown);
        let markdown = format!("{header}> {PRIVATE_SCOPE_WARNING}\n\n{rest}");
        output.insert("markdown".into(), Value::String(markdown));
    } else {
        output.insert(
            "scopeWarning".into(),
            Value::String(PRIVATE_SCOPE_WARNING.into()),
        );
    }
}

fn contains_private_scope(value: &Value) -> bool {
    match value {
        Value::Array(items) => items.iter().any(contains_private_scope),
        Value::Object(object) => {
            object
                .get("scopeId")
                .and_then(Value::as_str)
                .is_some_and(|scope| scope.starts_with("private:"))
                || object
                    .get("scopeKind")
                    .and_then(Value::as_str)
                    .is_some_and(|kind| kind == "private")
                || object.values().any(contains_private_scope)
        }
        _ => false,
    }
}

fn unknown_tool(name: &str) -> ToolError {
    ToolError::new(
        ToolErrorCode::NotFound,
        format!("unknown native business graph tool: {name}"),
    )
}

fn native_tool_definitions() -> Vec<(&'static str, &'static str, &'static str, Value)> {
    let mut definitions = graph::definitions();
    definitions.extend(knowledge::definitions());
    definitions.extend(issues::definitions());
    definitions.extend(projects::definitions());
    definitions.extend(research::definitions());
    definitions
}
