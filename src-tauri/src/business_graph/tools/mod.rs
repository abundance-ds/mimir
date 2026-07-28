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

use super::{GraphActor, GraphActorKind, GraphNode, GraphRuntime};
use crate::tool_registry::{
    ToolCallContext, ToolCaller, ToolDescriptor, ToolError, ToolErrorCode, ToolOwner,
    ToolRegistration, ToolRegistry, ToolResult, ToolSource,
};
use serde_json::Value;
use std::path::PathBuf;
use support::internal_error;
use tauri::{Emitter, Manager};

const GRAPH_CHANGED_EVENT: &str = "mimir://graph-changed";

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
            move |context: ToolCallContext, input: Value| {
                let app = app.clone();
                let dispatch_name = dispatch_name.clone();
                async move {
                    ensure_open(&app, &context)?;
                    let runtime = app.state::<GraphRuntime>();
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
    match name.split('.').next().unwrap_or_default() {
        "graph" => graph::execute(runtime, name, input),
        "knowledge" => knowledge::execute(runtime, name, input),
        "issues" => issues::execute(runtime, name, input),
        "projects" => projects::execute(runtime, name, input),
        "research" => research::execute(runtime, name, input),
        _ => Err(unknown_tool(name)),
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
