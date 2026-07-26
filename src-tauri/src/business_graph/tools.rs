use super::{
    GraphContextRequest, GraphDeleteResult, GraphMutationError, GraphNeighbor, GraphNode,
    GraphNodeCreate, GraphNodeDelete, GraphNodePatch, GraphQuery, GraphRelation,
    GraphRelationDirection, GraphRestoreRequest, GraphRuntime, ENTITY_KINDS,
};
use crate::tool_registry::{
    ToolCallContext, ToolDescriptor, ToolError, ToolErrorCode, ToolOwner, ToolRegistration,
    ToolRegistry, ToolResult, ToolSource,
};
use serde::de::DeserializeOwned;
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;
use std::path::PathBuf;
use tauri::{Emitter, Manager};

const GRAPH_CHANGED_EVENT: &str = "mim://graph-changed";

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
                    let execution = execute_native_tool(&runtime, &dispatch_name, input)?;
                    if let Some(path) = execution.changed_path.as_ref() {
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
    match name {
        "graph.status" => value(runtime.open_result().map_err(internal_error)?),
        "graph.list" | "graph.query" => {
            let query = parse_input::<GraphQuery>(input)?;
            value(runtime.query(&query).map_err(internal_error)?)
        }
        "graph.get" => {
            let id = required_string(&input, "id")?;
            let node = require_node(runtime, id)?;
            value(node)
        }
        "graph.search" => {
            let query = required_string(&input, "query")?;
            let scopes = string_set(input.get("scopeIds"));
            let limit = usize_field(&input, "limit").unwrap_or(25);
            value(
                runtime
                    .search(query, &scopes, limit)
                    .map_err(internal_error)?,
            )
        }
        "graph.neighbors" => {
            let id = required_string(&input, "id")?;
            let scopes = string_set(input.get("scopeIds"));
            value(runtime.neighbors(id, &scopes).map_err(internal_error)?)
        }
        "graph.diagnostics" => value(runtime.diagnostics().map_err(internal_error)?),
        "graph.migration_report" => value(runtime.migration_report().map_err(internal_error)?),
        "graph.context" => value(
            runtime
                .context(parse_input::<GraphContextRequest>(input)?)
                .map_err(internal_error)?,
        ),
        "graph.resolve_reference" => resolve_legacy_reference(runtime, &input),
        "graph.create" => {
            let created = runtime
                .create(parse_input::<GraphNodeCreate>(input)?)
                .map_err(mutation_error)?;
            mutation_value(created.clone(), created.provenance.source_path)
        }
        "graph.update" => {
            let updated = runtime
                .update(parse_input::<GraphNodePatch>(input)?)
                .map_err(mutation_error)?;
            mutation_value(updated.clone(), updated.provenance.source_path)
        }
        "graph.delete" => {
            let deleted = runtime
                .delete(parse_input::<GraphNodeDelete>(input)?)
                .map_err(mutation_error)?;
            mutation_value(deleted.clone(), deleted.source_path)
        }
        "graph.restore" => {
            let restored = runtime
                .restore(parse_input::<GraphRestoreRequest>(input)?)
                .map_err(mutation_error)?;
            mutation_value(restored.clone(), restored.provenance.source_path)
        }
        "knowledge.list" => knowledge_list(runtime, &input),
        "knowledge.catalog" => knowledge_catalog(runtime, &input),
        "knowledge.get" => knowledge_get(runtime, &input),
        "knowledge.search" => knowledge_search(runtime, &input),
        "knowledge.neighbors" => knowledge_neighbors(runtime, &input),
        "knowledge.graph" => knowledge_graph(runtime, &input),
        "knowledge.create" => knowledge_create(runtime, &input),
        "knowledge.update" => knowledge_update(runtime, &input),
        "knowledge.delete" => knowledge_delete(runtime, &input),
        "issues.list" => issues_list(runtime, &input),
        "issues.get" => issues_get(runtime, &input),
        "issues.create" => issues_create(runtime, &input),
        "issues.update" => issues_update(runtime, &input),
        "issues.delete" => issues_delete(runtime, &input),
        "issues.move" => issues_move(runtime, &input),
        "issues.assign" => issues_assign(runtime, &input),
        "issues.complete" => issues_complete(runtime, &input),
        "projects.link_company" => {
            project_relation(runtime, &input, "companyId", "company", "for_company", true)
        }
        "projects.add_contact" => {
            project_relation(runtime, &input, "personId", "person", "has_contact", false)
        }
        "projects.record_decision" => project_record_decision(runtime, &input),
        "issues.add_deliverable" => issues_add_deliverable(runtime, &input),
        "issues.create_next_action" => issues_create_next_action(runtime, &input),
        "research.capture_evidence" => research_capture_evidence(runtime, &input),
        _ => Err(ToolError::new(
            ToolErrorCode::NotFound,
            format!("unknown native business graph tool: {name}"),
        )),
    }
}

fn knowledge_list(runtime: &GraphRuntime, input: &Value) -> Result<NativeExecution, ToolError> {
    let nodes = knowledge_nodes(runtime, &scope_ids(input))?;
    let total = nodes.len();
    let offset = usize_field(input, "offset").unwrap_or(0).min(total);
    let limit = usize_field(input, "limit").unwrap_or(100).clamp(1, 100);
    let items = nodes
        .into_iter()
        .skip(offset)
        .take(limit)
        .map(|node| knowledge_summary(&node))
        .collect::<Vec<_>>();
    let next_offset = (offset + items.len() < total).then_some(offset + items.len());
    Ok(NativeExecution::read(json!({
        "folderPresent": true,
        "total": total,
        "offset": offset,
        "limit": limit,
        "nextOffset": next_offset,
        "items": items,
    })))
}

fn knowledge_catalog(runtime: &GraphRuntime, input: &Value) -> Result<NativeExecution, ToolError> {
    let entries = knowledge_nodes(runtime, &scope_ids(input))?
        .iter()
        .map(knowledge_summary)
        .collect::<Vec<_>>();
    Ok(NativeExecution::read(json!({ "entries": entries })))
}

fn knowledge_get(runtime: &GraphRuntime, input: &Value) -> Result<NativeExecution, ToolError> {
    let node = require_node(runtime, required_string(input, "id")?)?;
    require_knowledge(&node)?;
    Ok(NativeExecution::read(knowledge_full(&node)))
}

fn knowledge_search(runtime: &GraphRuntime, input: &Value) -> Result<NativeExecution, ToolError> {
    let query = required_string(input, "query")?;
    let scopes = scope_ids(input);
    let limit = usize_field(input, "limit").unwrap_or(25).clamp(1, 100);
    let items = runtime
        .search(query, &scopes, 100)
        .map_err(internal_error)?
        .into_iter()
        .filter(|result| result.node.kind != "issue")
        .take(limit)
        .map(|result| {
            let mut summary = knowledge_summary_fields(
                &result.node.id,
                &result.node.kind,
                &result.node.title,
                &result.node.summary,
                &result.node.tags,
                &result.node.scope_id,
                &result.node.source_revision,
            );
            summary.insert("score".into(), json!(result.score));
            Value::Object(summary)
        })
        .collect::<Vec<_>>();
    Ok(NativeExecution::read(
        json!({ "items": items, "index": "rust" }),
    ))
}

fn knowledge_neighbors(
    runtime: &GraphRuntime,
    input: &Value,
) -> Result<NativeExecution, ToolError> {
    let id = required_string(input, "id")?;
    let node = require_node(runtime, id)?;
    require_knowledge(&node)?;
    let neighbors = runtime
        .neighbors(id, &scope_ids(input))
        .map_err(internal_error)?;
    let outgoing = neighbor_values(
        neighbors
            .iter()
            .filter(|neighbor| neighbor.direction == GraphRelationDirection::Outgoing),
    );
    let incoming = neighbor_values(
        neighbors
            .iter()
            .filter(|neighbor| neighbor.direction == GraphRelationDirection::Incoming),
    );
    Ok(NativeExecution::read(json!({
        "id": id,
        "outgoing": outgoing,
        "incoming": incoming,
    })))
}

fn knowledge_graph(runtime: &GraphRuntime, input: &Value) -> Result<NativeExecution, ToolError> {
    let nodes = knowledge_nodes(runtime, &scope_ids(input))?;
    let ids = nodes
        .iter()
        .map(|node| node.id.as_str())
        .collect::<BTreeSet<_>>();
    let edges = nodes
        .iter()
        .flat_map(|node| {
            node.relations.iter().map(|relation| {
                json!({
                    "source": node.id,
                    "target": relation.target,
                    "rel": relation.relation,
                    "missing": !ids.contains(relation.target.as_str()),
                })
            })
        })
        .collect::<Vec<_>>();
    let nodes = nodes.iter().map(knowledge_summary).collect::<Vec<_>>();
    Ok(NativeExecution::read(
        json!({ "nodes": nodes, "edges": edges }),
    ))
}

fn knowledge_create(runtime: &GraphRuntime, input: &Value) -> Result<NativeExecution, ToolError> {
    let title = required_string(input, "title")?.to_string();
    let mut properties = object_field(input, "extra");
    let kind = input
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("note")
        .to_string();
    if kind == "issue" {
        return Err(invalid_input(
            "knowledge.create cannot create issue nodes; use issues.create",
        ));
    }
    let created = runtime
        .create(GraphNodeCreate {
            scope_id: optional_string(input, "scopeId"),
            id: optional_string(input, "id"),
            kind,
            title,
            summary: optional_string(input, "summary").unwrap_or_default(),
            body: optional_string(input, "body").unwrap_or_default(),
            tags: string_vec(input.get("tags")),
            relations: relation_vec(input.get("links"))?,
            properties: std::mem::take(&mut properties),
        })
        .map_err(mutation_error)?;
    Ok(NativeExecution::mutation(
        knowledge_full(&created),
        created.provenance.source_path,
    ))
}

fn knowledge_update(runtime: &GraphRuntime, input: &Value) -> Result<NativeExecution, ToolError> {
    let id = required_string(input, "id")?.to_string();
    let existing = require_node(runtime, &id)?;
    require_knowledge(&existing)?;
    let patch = GraphNodePatch {
        id,
        expected_revision: expected_revision(input),
        kind: optional_string(input, "type"),
        title: optional_string(input, "title"),
        summary: optional_string(input, "summary"),
        body: optional_string(input, "body"),
        tags: input.get("tags").map(|value| string_vec(Some(value))),
        relations: input
            .get("links")
            .map(|value| relation_vec(Some(value)))
            .transpose()?,
        set_properties: object_field(input, "extra"),
        ..GraphNodePatch::default()
    };
    if patch.kind.as_deref() == Some("issue") {
        return Err(invalid_input(
            "knowledge.update cannot convert a knowledge node into an issue",
        ));
    }
    for key in patch.set_properties.keys() {
        if key == "id" || key == "kind" || key == "type" {
            return Err(invalid_input("extra cannot replace graph identity fields"));
        }
    }
    let updated = runtime.update(patch).map_err(mutation_error)?;
    Ok(NativeExecution::mutation(
        knowledge_full(&updated),
        updated.provenance.source_path,
    ))
}

fn knowledge_delete(runtime: &GraphRuntime, input: &Value) -> Result<NativeExecution, ToolError> {
    let id = required_string(input, "id")?.to_string();
    require_knowledge(&require_node(runtime, &id)?)?;
    let deleted = runtime
        .delete(GraphNodeDelete {
            id,
            expected_revision: expected_revision(input),
        })
        .map_err(mutation_error)?;
    delete_execution(deleted)
}

fn issues_list(runtime: &GraphRuntime, input: &Value) -> Result<NativeExecution, ToolError> {
    let nodes = issue_nodes(runtime, &scope_ids(input))?;
    Ok(NativeExecution::read(json!({
        "folderPresent": true,
        "items": nodes.iter().map(|node| issue_value(node, false)).collect::<Vec<_>>(),
    })))
}

fn issues_get(runtime: &GraphRuntime, input: &Value) -> Result<NativeExecution, ToolError> {
    let node = require_node(runtime, required_string(input, "id")?)?;
    require_issue(&node)?;
    Ok(NativeExecution::read(issue_value(&node, true)))
}

fn issues_create(runtime: &GraphRuntime, input: &Value) -> Result<NativeExecution, ToolError> {
    let title = required_string(input, "title")?.to_string();
    let (tags, properties) = issue_properties(input, true)?;
    let relations = issue_relations(runtime, input, Vec::new())?;
    let created = runtime
        .create(GraphNodeCreate {
            scope_id: optional_string(input, "scopeId"),
            id: optional_string(input, "id"),
            kind: "issue".into(),
            title,
            body: optional_string(input, "body").unwrap_or_default(),
            tags,
            relations,
            properties,
            ..GraphNodeCreate::default()
        })
        .map_err(mutation_error)?;
    Ok(NativeExecution::mutation(
        issue_value(&created, true),
        created.provenance.source_path,
    ))
}

fn issues_update(runtime: &GraphRuntime, input: &Value) -> Result<NativeExecution, ToolError> {
    let id = required_string(input, "id")?.to_string();
    let existing = require_node(runtime, &id)?;
    require_issue(&existing)?;
    let (tags, set_properties) = issue_properties(input, false)?;
    let relations = issue_relations(runtime, input, existing.relations.clone())?;
    let mut remove_properties = Vec::new();
    for (input_key, property_key) in [
        ("dueDate", "dueDate"),
        ("project", "legacyProject"),
        ("assignee", "legacyAssignee"),
        ("waitingFor", "waitingFor"),
        ("snoozeUntil", "snoozeUntil"),
        ("remindAt", "remindAt"),
    ] {
        if input.get(input_key).and_then(Value::as_str) == Some("") {
            remove_properties.push(property_key.into());
        }
    }
    let updated = runtime
        .update(GraphNodePatch {
            id,
            expected_revision: expected_revision(input),
            title: optional_string(input, "title"),
            body: optional_string(input, "body"),
            tags: input.get("labels").map(|_| tags),
            relations: (input.get("project").is_some()
                || input.get("assignee").is_some()
                || input.get("links").is_some())
            .then_some(relations),
            set_properties,
            remove_properties,
            ..GraphNodePatch::default()
        })
        .map_err(mutation_error)?;
    Ok(NativeExecution::mutation(
        issue_value(&updated, true),
        updated.provenance.source_path,
    ))
}

fn issues_delete(runtime: &GraphRuntime, input: &Value) -> Result<NativeExecution, ToolError> {
    let id = required_string(input, "id")?.to_string();
    require_issue(&require_node(runtime, &id)?)?;
    let deleted = runtime
        .delete(GraphNodeDelete {
            id,
            expected_revision: expected_revision(input),
        })
        .map_err(mutation_error)?;
    delete_execution(deleted)
}

fn issues_move(runtime: &GraphRuntime, input: &Value) -> Result<NativeExecution, ToolError> {
    update_issue_status(
        runtime,
        input,
        required_string(input, "status")?.to_string(),
    )
}

fn issues_complete(runtime: &GraphRuntime, input: &Value) -> Result<NativeExecution, ToolError> {
    update_issue_status(runtime, input, "done".into())
}

fn update_issue_status(
    runtime: &GraphRuntime,
    input: &Value,
    status: String,
) -> Result<NativeExecution, ToolError> {
    let id = required_string(input, "id")?.to_string();
    require_issue(&require_node(runtime, &id)?)?;
    let updated = runtime
        .update(GraphNodePatch {
            id,
            expected_revision: expected_revision(input),
            set_properties: Map::from_iter([("status".into(), Value::String(status))]),
            ..GraphNodePatch::default()
        })
        .map_err(mutation_error)?;
    Ok(NativeExecution::mutation(
        issue_value(&updated, true),
        updated.provenance.source_path,
    ))
}

fn issues_assign(runtime: &GraphRuntime, input: &Value) -> Result<NativeExecution, ToolError> {
    let id = required_string(input, "id")?.to_string();
    let issue = require_node(runtime, &id)?;
    require_issue(&issue)?;
    let person_id = optional_string(input, "personId").unwrap_or_default();
    if !person_id.is_empty() {
        let person = require_node(runtime, &person_id)?;
        if person.kind != "person" {
            return Err(invalid_input(format!(
                "'{}' is {}, not a person",
                person.id, person.kind
            )));
        }
    }
    let relations = issue
        .relations
        .iter()
        .filter(|edge| edge.relation != "assigned_to")
        .cloned()
        .chain((!person_id.is_empty()).then(|| GraphRelation {
            relation: "assigned_to".into(),
            target: person_id.clone(),
            legacy: false,
        }))
        .collect();
    let (set_properties, remove_properties) = if person_id.is_empty() {
        (Map::new(), vec!["legacyAssignee".into()])
    } else {
        (
            Map::from_iter([("legacyAssignee".into(), Value::String(person_id.clone()))]),
            Vec::new(),
        )
    };
    let updated = runtime
        .update(GraphNodePatch {
            id,
            expected_revision: expected_revision(input),
            relations: Some(relations),
            set_properties,
            remove_properties,
            ..GraphNodePatch::default()
        })
        .map_err(mutation_error)?;
    Ok(NativeExecution::mutation(
        issue_value(&updated, true),
        updated.provenance.source_path,
    ))
}

fn project_relation(
    runtime: &GraphRuntime,
    input: &Value,
    target_field: &str,
    target_kind: &str,
    relation: &str,
    replace: bool,
) -> Result<NativeExecution, ToolError> {
    let id = required_string(input, "id")?.to_string();
    let target_id = required_string(input, target_field)?.to_string();
    let project = require_node(runtime, &id)?;
    if project.kind != "project" {
        return Err(invalid_input(format!(
            "'{}' is {}, not a project",
            project.id, project.kind
        )));
    }
    let target = require_node(runtime, &target_id)?;
    if target.kind != target_kind {
        return Err(invalid_input(format!(
            "'{}' is {}, not a {target_kind}",
            target.id, target.kind
        )));
    }
    let mut relations = project.relations;
    if replace {
        relations.retain(|edge| edge.relation != relation);
    }
    if !relations
        .iter()
        .any(|edge| edge.relation == relation && edge.target == target_id)
    {
        relations.push(GraphRelation {
            relation: relation.into(),
            target: target_id,
            legacy: false,
        });
    }
    let updated = runtime
        .update(GraphNodePatch {
            id,
            expected_revision: expected_revision(input),
            relations: Some(relations),
            ..GraphNodePatch::default()
        })
        .map_err(mutation_error)?;
    Ok(NativeExecution::mutation(
        knowledge_full(&updated),
        updated.provenance.source_path,
    ))
}

fn resolve_legacy_reference(
    runtime: &GraphRuntime,
    input: &Value,
) -> Result<NativeExecution, ToolError> {
    let id = required_string(input, "id")?.to_string();
    let field = required_string(input, "field")?;
    let target_id = required_string(input, "targetId")?.to_string();
    let issue = require_node(runtime, &id)?;
    require_issue(&issue)?;
    let (relation, expected_kind, property) = match field {
        "project" => ("part_of", "project", "legacyProject"),
        "assignee" => ("assigned_to", "person", "legacyAssignee"),
        _ => {
            return Err(invalid_input(
                "field must be either 'project' or 'assignee'",
            ))
        }
    };
    let target = require_node(runtime, &target_id)?;
    if target.kind != expected_kind {
        return Err(invalid_input(format!(
            "'{}' is {}, not a {expected_kind}",
            target.id, target.kind
        )));
    }
    let mut relations = issue.relations;
    relations.retain(|edge| edge.relation != relation);
    relations.push(GraphRelation {
        relation: relation.into(),
        target: target_id.clone(),
        legacy: false,
    });
    let updated = runtime
        .update(GraphNodePatch {
            id,
            expected_revision: expected_revision(input),
            relations: Some(relations),
            set_properties: Map::from_iter([(property.into(), Value::String(target_id))]),
            ..GraphNodePatch::default()
        })
        .map_err(mutation_error)?;
    Ok(NativeExecution::mutation(
        issue_value(&updated, true),
        updated.provenance.source_path,
    ))
}

fn project_record_decision(
    runtime: &GraphRuntime,
    input: &Value,
) -> Result<NativeExecution, ToolError> {
    let project = require_node(runtime, required_string(input, "id")?)?;
    if project.kind != "project" {
        return Err(invalid_input(format!(
            "'{}' is {}, not a project",
            project.id, project.kind
        )));
    }
    let mut properties = Map::new();
    if let Some(rationale) = optional_string(input, "rationale").filter(|value| !value.is_empty()) {
        properties.insert("rationale".into(), Value::String(rationale));
    }
    let created = runtime
        .create(GraphNodeCreate {
            scope_id: Some(project.provenance.scope_id),
            id: optional_string(input, "decisionId").filter(|value| !value.is_empty()),
            kind: "decision".into(),
            title: required_string(input, "title")?.into(),
            summary: optional_string(input, "summary").unwrap_or_default(),
            body: optional_string(input, "body").unwrap_or_default(),
            tags: vec!["decision".into()],
            relations: vec![GraphRelation {
                relation: "part_of".into(),
                target: project.id,
                legacy: false,
            }],
            properties,
        })
        .map_err(mutation_error)?;
    Ok(NativeExecution::mutation(
        knowledge_full(&created),
        created.provenance.source_path,
    ))
}

fn issues_add_deliverable(
    runtime: &GraphRuntime,
    input: &Value,
) -> Result<NativeExecution, ToolError> {
    let id = required_string(input, "id")?.to_string();
    let issue = require_node(runtime, &id)?;
    require_issue(&issue)?;
    let path = required_string(input, "path")?.to_string();
    let label = optional_string(input, "label").unwrap_or_default();
    let mut deliverables = issue
        .properties
        .get("deliverables")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if !deliverables.iter().any(|item| {
        item.as_str() == Some(path.as_str())
            || item.get("path").and_then(Value::as_str) == Some(path.as_str())
    }) {
        deliverables.push(json!({
            "path": path,
            "label": label,
        }));
    }
    let updated = runtime
        .update(GraphNodePatch {
            id,
            expected_revision: expected_revision(input),
            set_properties: Map::from_iter([("deliverables".into(), Value::Array(deliverables))]),
            ..GraphNodePatch::default()
        })
        .map_err(mutation_error)?;
    Ok(NativeExecution::mutation(
        issue_value(&updated, true),
        updated.provenance.source_path,
    ))
}

fn issues_create_next_action(
    runtime: &GraphRuntime,
    input: &Value,
) -> Result<NativeExecution, ToolError> {
    let parent = require_node(runtime, required_string(input, "id")?)?;
    require_issue(&parent)?;
    let mut relations = vec![GraphRelation {
        relation: "related_to".into(),
        target: parent.id.clone(),
        legacy: false,
    }];
    if let Some(project_id) = parent
        .relations
        .iter()
        .find(|edge| edge.relation == "part_of")
        .map(|edge| edge.target.clone())
    {
        relations.push(GraphRelation {
            relation: "part_of".into(),
            target: project_id,
            legacy: false,
        });
    }
    let mut properties = Map::from_iter([
        ("status".into(), json!("plan")),
        (
            "priority".into(),
            input
                .get("priority")
                .cloned()
                .unwrap_or_else(|| json!("normal")),
        ),
    ]);
    if let Some(due_date) = optional_string(input, "dueDate").filter(|value| !value.is_empty()) {
        properties.insert("dueDate".into(), Value::String(due_date));
    }
    if let Some(person_id) = optional_string(input, "assigneeId").filter(|value| !value.is_empty())
    {
        let person = require_node(runtime, &person_id)?;
        if person.kind != "person" {
            return Err(invalid_input(format!(
                "'{}' is {}, not a person",
                person.id, person.kind
            )));
        }
        relations.push(GraphRelation {
            relation: "assigned_to".into(),
            target: person_id.clone(),
            legacy: false,
        });
        properties.insert("legacyAssignee".into(), Value::String(person_id));
    }
    let created = runtime
        .create(GraphNodeCreate {
            scope_id: Some(parent.provenance.scope_id),
            id: None,
            kind: "issue".into(),
            title: required_string(input, "title")?.into(),
            summary: String::new(),
            body: optional_string(input, "body").unwrap_or_default(),
            tags: string_vec(input.get("tags")),
            relations,
            properties,
        })
        .map_err(mutation_error)?;
    Ok(NativeExecution::mutation(
        issue_value(&created, true),
        created.provenance.source_path,
    ))
}

fn research_capture_evidence(
    runtime: &GraphRuntime,
    input: &Value,
) -> Result<NativeExecution, ToolError> {
    let focus = require_node(runtime, required_string(input, "focusId")?)?;
    let mut properties = Map::new();
    for key in ["citation", "source", "certainty"] {
        if let Some(value) = optional_string(input, key).filter(|value| !value.is_empty()) {
            properties.insert(key.into(), Value::String(value));
        }
    }
    let created = runtime
        .create(GraphNodeCreate {
            scope_id: Some(focus.provenance.scope_id),
            id: optional_string(input, "evidenceId").filter(|value| !value.is_empty()),
            kind: "evidence".into(),
            title: required_string(input, "title")?.into(),
            summary: optional_string(input, "summary").unwrap_or_default(),
            body: optional_string(input, "body").unwrap_or_default(),
            tags: string_vec(input.get("tags")),
            relations: vec![GraphRelation {
                relation: "related_to".into(),
                target: focus.id,
                legacy: false,
            }],
            properties,
        })
        .map_err(mutation_error)?;
    Ok(NativeExecution::mutation(
        knowledge_full(&created),
        created.provenance.source_path,
    ))
}

fn knowledge_nodes(
    runtime: &GraphRuntime,
    scopes: &BTreeSet<String>,
) -> Result<Vec<GraphNode>, ToolError> {
    all_nodes(runtime, scopes).map(|nodes| {
        nodes
            .into_iter()
            .filter(|node| node.kind != "issue")
            .collect()
    })
}

fn issue_nodes(
    runtime: &GraphRuntime,
    scopes: &BTreeSet<String>,
) -> Result<Vec<GraphNode>, ToolError> {
    all_nodes(runtime, scopes).map(|nodes| {
        nodes
            .into_iter()
            .filter(|node| node.kind == "issue")
            .collect()
    })
}

fn all_nodes(
    runtime: &GraphRuntime,
    scopes: &BTreeSet<String>,
) -> Result<Vec<GraphNode>, ToolError> {
    let result = runtime
        .query(&GraphQuery {
            scope_ids: scopes.clone(),
            limit: 500,
            ..GraphQuery::default()
        })
        .map_err(internal_error)?;
    result
        .items
        .iter()
        .map(|summary| require_node(runtime, &summary.id))
        .collect()
}

fn knowledge_summary(node: &GraphNode) -> Value {
    Value::Object(knowledge_summary_fields(
        &node.id,
        &node.kind,
        &node.title,
        &node.summary,
        &node.tags,
        &node.provenance.scope_id,
        &node.provenance.source_revision,
    ))
}

fn knowledge_summary_fields(
    id: &str,
    kind: &str,
    title: &str,
    summary: &str,
    tags: &[String],
    scope_id: &str,
    source_revision: &str,
) -> Map<String, Value> {
    Map::from_iter([
        ("id".into(), json!(id)),
        ("type".into(), json!(kind)),
        ("title".into(), json!(title)),
        ("summary".into(), json!(summary)),
        ("tags".into(), json!(tags)),
        ("scopeId".into(), json!(scope_id)),
        ("sourceRevision".into(), json!(source_revision)),
    ])
}

fn knowledge_full(node: &GraphNode) -> Value {
    let mut value = knowledge_summary_fields(
        &node.id,
        &node.kind,
        &node.title,
        &node.summary,
        &node.tags,
        &node.provenance.scope_id,
        &node.provenance.source_revision,
    );
    value.insert(
        "links".into(),
        Value::Array(
            node.relations
                .iter()
                .map(|relation| json!({ "rel": relation.relation, "target": relation.target }))
                .collect(),
        ),
    );
    value.insert("extra".into(), Value::Object(node.properties.clone()));
    value.insert("created".into(), json!(node.created_at));
    value.insert("updated".into(), json!(node.updated_at));
    value.insert("body".into(), json!(node.body));
    Value::Object(value)
}

fn neighbor_values<'a>(neighbors: impl Iterator<Item = &'a GraphNeighbor>) -> Vec<Value> {
    neighbors
        .filter(|neighbor| neighbor.node.kind != "issue")
        .map(|neighbor| {
            json!({
                "rel": neighbor.relation,
                "id": neighbor.node.id,
                "type": neighbor.node.kind,
                "title": neighbor.node.title,
                "summary": neighbor.node.summary,
                "scopeId": neighbor.node.scope_id,
            })
        })
        .collect()
}

fn issue_value(node: &GraphNode, include_body: bool) -> Value {
    let relation_target = |relation: &str| {
        node.relations
            .iter()
            .find(|edge| edge.relation == relation)
            .map(|edge| edge.target.clone())
    };
    let mut value = Map::from_iter([
        ("id".into(), json!(node.id)),
        ("title".into(), json!(node.title)),
        (
            "status".into(),
            node.properties
                .get("status")
                .cloned()
                .unwrap_or_else(|| json!("backlog")),
        ),
        (
            "priority".into(),
            node.properties
                .get("priority")
                .cloned()
                .unwrap_or_else(|| json!("normal")),
        ),
        ("tags".into(), json!(node.tags)),
        (
            "project".into(),
            node.properties
                .get("legacyProject")
                .cloned()
                .or_else(|| relation_target("part_of").map(Value::String))
                .unwrap_or_else(|| json!("")),
        ),
        (
            "assignee".into(),
            node.properties
                .get("legacyAssignee")
                .cloned()
                .or_else(|| relation_target("assigned_to").map(Value::String))
                .unwrap_or_else(|| json!("")),
        ),
        (
            "labels".into(),
            node.properties
                .get("labels")
                .cloned()
                .unwrap_or_else(|| json!([])),
        ),
        (
            "deliverables".into(),
            node.properties
                .get("deliverables")
                .cloned()
                .unwrap_or_else(|| json!([])),
        ),
        ("created".into(), json!(node.created_at)),
        ("updated".into(), json!(node.updated_at)),
        ("scopeId".into(), json!(node.provenance.scope_id)),
        (
            "sourceRevision".into(),
            json!(node.provenance.source_revision),
        ),
    ]);
    for field in ["dueDate", "waitingFor", "snoozeUntil", "remindAt"] {
        if let Some(property) = node.properties.get(field) {
            value.insert(field.into(), property.clone());
        }
    }
    if include_body {
        value.insert("body".into(), json!(node.body));
        value.insert(
            "links".into(),
            Value::Array(
                node.relations
                    .iter()
                    .map(|edge| json!({"rel": edge.relation, "target": edge.target}))
                    .collect(),
            ),
        );
    }
    Value::Object(value)
}

fn issue_properties(
    input: &Value,
    include_defaults: bool,
) -> Result<(Vec<String>, Map<String, Value>), ToolError> {
    let mut properties = Map::new();
    if include_defaults || input.get("status").is_some() {
        properties.insert(
            "status".into(),
            input
                .get("status")
                .cloned()
                .unwrap_or_else(|| json!("backlog")),
        );
    }
    if include_defaults || input.get("priority").is_some() {
        properties.insert(
            "priority".into(),
            input
                .get("priority")
                .cloned()
                .unwrap_or_else(|| json!("normal")),
        );
    }
    for (input_key, property_key) in [
        ("dueDate", "dueDate"),
        ("project", "legacyProject"),
        ("assignee", "legacyAssignee"),
        ("waitingFor", "waitingFor"),
        ("snoozeUntil", "snoozeUntil"),
        ("remindAt", "remindAt"),
        ("deliverables", "deliverables"),
    ] {
        if let Some(value) = input.get(input_key) {
            if value.as_str() != Some("") {
                properties.insert(property_key.into(), value.clone());
            }
        }
    }
    let labels = input.get("labels").cloned().unwrap_or_else(|| json!([]));
    if include_defaults || input.get("labels").is_some() {
        let labels_array = labels
            .as_array()
            .ok_or_else(|| invalid_input("labels must be an array"))?;
        for label in labels_array {
            if label.get("name").and_then(Value::as_str).is_none() {
                return Err(invalid_input("each label needs a name"));
            }
        }
        properties.insert("labels".into(), labels);
    }
    let tags = properties
        .get("labels")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|label| label.get("name").and_then(Value::as_str))
        .map(str::to_string)
        .collect();
    Ok((tags, properties))
}

fn issue_relations(
    runtime: &GraphRuntime,
    input: &Value,
    mut relations: Vec<GraphRelation>,
) -> Result<Vec<GraphRelation>, ToolError> {
    if let Some(links) = input.get("links") {
        relations = relation_vec(Some(links))?;
    }
    for (field, relation_name, expected_kind) in [
        ("project", "part_of", "project"),
        ("assignee", "assigned_to", "person"),
    ] {
        if let Some(target) = input.get(field).and_then(Value::as_str) {
            relations.retain(|edge| edge.relation != relation_name);
            if !target.is_empty() {
                if let Ok(node) = require_node(runtime, target) {
                    if node.kind == expected_kind {
                        relations.push(GraphRelation {
                            relation: relation_name.into(),
                            target: target.into(),
                            legacy: false,
                        });
                    }
                }
            }
        }
    }
    Ok(relations)
}

fn relation_vec(value: Option<&Value>) -> Result<Vec<GraphRelation>, ToolError> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let items = match value {
        Value::Array(items) => items.clone(),
        Value::String(value) => value
            .split([',', '\n'])
            .map(|item| Value::String(item.trim().to_string()))
            .filter(|item| item.as_str() != Some(""))
            .collect(),
        _ => return Err(invalid_input("links must be an array or string")),
    };
    items
        .into_iter()
        .map(|item| match item {
            Value::String(value) => {
                let mut parts = value.split_whitespace();
                let relation = parts.next().unwrap_or_default();
                let target = parts.next().unwrap_or_default();
                if relation.is_empty() || target.is_empty() {
                    return Err(invalid_input("links use the form 'relation target-id'"));
                }
                Ok(GraphRelation {
                    relation: relation.into(),
                    target: target.into(),
                    legacy: true,
                })
            }
            Value::Object(value) => {
                let relation = value
                    .get("relation")
                    .or_else(|| value.get("rel"))
                    .and_then(Value::as_str)
                    .ok_or_else(|| invalid_input("each link needs rel or relation"))?;
                let target = value
                    .get("target")
                    .and_then(Value::as_str)
                    .ok_or_else(|| invalid_input("each link needs target"))?;
                Ok(GraphRelation {
                    relation: relation.into(),
                    target: target.into(),
                    legacy: false,
                })
            }
            _ => Err(invalid_input("each link must be a string or object")),
        })
        .collect()
}

fn require_node(runtime: &GraphRuntime, id: &str) -> Result<GraphNode, ToolError> {
    runtime.get(id).map_err(internal_error)?.ok_or_else(|| {
        ToolError::new(
            ToolErrorCode::NotFound,
            format!("graph node not found: {id}"),
        )
    })
}

fn require_knowledge(node: &GraphNode) -> Result<(), ToolError> {
    if node.kind == "issue" {
        Err(invalid_input(format!(
            "'{}' is an issue; use issues.get",
            node.id
        )))
    } else {
        Ok(())
    }
}

fn require_issue(node: &GraphNode) -> Result<(), ToolError> {
    if node.kind != "issue" {
        Err(invalid_input(format!(
            "'{}' is {}; use knowledge.get",
            node.id, node.kind
        )))
    } else {
        Ok(())
    }
}

fn delete_execution(deleted: GraphDeleteResult) -> Result<NativeExecution, ToolError> {
    Ok(NativeExecution::mutation(
        json!({
            "ok": true,
            "id": deleted.id,
            "graphRevision": deleted.graph_revision,
            "undoToken": deleted.undo_token,
        }),
        deleted.source_path,
    ))
}

fn parse_input<T: DeserializeOwned>(input: Value) -> Result<T, ToolError> {
    serde_json::from_value(input).map_err(|error| invalid_input(error.to_string()))
}

fn value<T: serde::Serialize>(value: T) -> Result<NativeExecution, ToolError> {
    serde_json::to_value(value)
        .map(NativeExecution::read)
        .map_err(internal_error)
}

fn mutation_value<T: serde::Serialize>(
    value: T,
    path: String,
) -> Result<NativeExecution, ToolError> {
    serde_json::to_value(value)
        .map(|value| NativeExecution::mutation(value, path))
        .map_err(internal_error)
}

fn required_string<'a>(input: &'a Value, field: &str) -> Result<&'a str, ToolError> {
    input
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid_input(format!("{field} is required")))
}

fn optional_string(input: &Value, field: &str) -> Option<String> {
    input.get(field).and_then(Value::as_str).map(str::to_string)
}

fn expected_revision(input: &Value) -> Option<String> {
    optional_string(input, "expectedRevision").or_else(|| optional_string(input, "sourceRevision"))
}

fn usize_field(input: &Value, field: &str) -> Option<usize> {
    input
        .get(field)
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
}

fn object_field(input: &Value, field: &str) -> Map<String, Value> {
    input
        .get(field)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn string_vec(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .collect(),
        Some(Value::String(value)) => value
            .split([',', '\n'])
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

fn string_set(value: Option<&Value>) -> BTreeSet<String> {
    string_vec(value).into_iter().collect()
}

fn scope_ids(input: &Value) -> BTreeSet<String> {
    string_set(input.get("scopeIds"))
}

fn mutation_error(error: GraphMutationError) -> ToolError {
    match error {
        GraphMutationError::NotFound(_) => {
            ToolError::new(ToolErrorCode::NotFound, error.to_string())
        }
        GraphMutationError::Conflict {
            ref id,
            ref expected,
            ref actual,
        } => ToolError::new(ToolErrorCode::Handler, error.to_string()).with_data(json!({
            "conflict": true,
            "id": id,
            "expectedRevision": expected,
            "actualRevision": actual,
        })),
        GraphMutationError::Exists(_)
        | GraphMutationError::ScopeNotFound(_)
        | GraphMutationError::Invalid(_) => {
            ToolError::new(ToolErrorCode::InvalidInput, error.to_string())
        }
        GraphMutationError::Read { .. }
        | GraphMutationError::Serialize { .. }
        | GraphMutationError::Write { .. }
        | GraphMutationError::Delete { .. } => {
            ToolError::new(ToolErrorCode::Handler, error.to_string())
        }
    }
}

fn invalid_input(message: impl Into<String>) -> ToolError {
    ToolError::new(ToolErrorCode::InvalidInput, message)
}

fn internal_error(error: impl std::fmt::Display) -> ToolError {
    ToolError::new(ToolErrorCode::Internal, error.to_string())
}

fn native_tool_definitions() -> Vec<(&'static str, &'static str, &'static str, Value)> {
    let scopes = json!({
        "scopeIds": string_array("Physical private, project, or team scope ids. Empty means all mounted scopes.")
    });
    let id = json!({ "id": string_schema("Stable graph node id.") });
    let mut definitions = vec![
        definition(
            "graph.status",
            "graph_status",
            "Describe mounted private, project, and team graph scopes and the current graph revision.",
            json!({}),
            &[],
        ),
        definition(
            "graph.list",
            "graph_list",
            "List graph nodes through a bounded, source-aware projection query.",
            query_properties(),
            &[],
        ),
        definition(
            "graph.query",
            "graph_query",
            "Query graph nodes by physical scopes, ontology kinds, tags, and issue status.",
            query_properties(),
            &[],
        ),
        definition(
            "graph.get",
            "graph_get",
            "Get one full graph node including body, relations, properties, scope, and source revision.",
            id.clone(),
            &["id"],
        ),
        definition(
            "graph.search",
            "graph_search",
            "Rank graph nodes using bounded text search across visible physical scopes.",
            merge(
                scopes.clone(),
                json!({
                    "query": string_schema("Plain-text terms."),
                    "limit": integer_schema(1, 100),
                }),
            ),
            &["query"],
        ),
        definition(
            "graph.neighbors",
            "graph_neighbors",
            "Traverse incoming and outgoing relations around one node, constrained to visible scopes.",
            merge(scopes.clone(), id.clone()),
            &["id"],
        ),
        definition(
            "graph.diagnostics",
            "graph_diagnostics",
            "Return malformed source, duplicate id, dangling relation, and ontology diagnostics.",
            json!({}),
            &[],
        ),
        definition(
            "graph.migration_report",
            "graph_migration_report",
            "Dry-run the mounted legacy sources and report counts, aliases, collisions, dangling links, and identity resolution without writing.",
            json!({}),
            &[],
        ),
        definition(
            "graph.context",
            "graph_context",
            "Build a bounded agent-ready graph context around one focus, preserving scope and source provenance while redacting sensitive records.",
            merge(
                scopes.clone(),
                json!({
                    "focusId": string_schema("Optional focus node id. Traversal begins here."),
                    "maxNodes": integer_schema(1, 40),
                }),
            ),
            &[],
        ),
        definition(
            "graph.resolve_reference",
            "graph_resolve_reference",
            "Resolve one legacy issue project or assignee string to a validated real graph entity.",
            merge(
                mutation_id_properties(),
                json!({
                    "field": { "type": "string", "enum": ["project", "assignee"] },
                    "targetId": string_schema("Validated project or person node id."),
                }),
            ),
            &["id", "field", "targetId"],
        ),
        definition(
            "graph.create",
            "graph_create",
            "Create one typed Markdown-backed graph node in a selected private, project, or team scope.",
            graph_create_properties(),
            &["kind", "title"],
        ),
        definition(
            "graph.update",
            "graph_update",
            "Patch one graph node with optional optimistic source-revision checking.",
            graph_update_properties(),
            &["id"],
        ),
        definition(
            "graph.delete",
            "graph_delete",
            "Move one graph node source to the operating-system Trash, optionally checking its source revision.",
            mutation_id_properties(),
            &["id"],
        ),
        definition(
            "graph.restore",
            "graph_restore",
            "Restore one recently Trashed graph source using the undo token returned by graph.delete.",
            json!({
                "undoToken": string_schema("Undo token returned by graph.delete."),
            }),
            &["undoToken"],
        ),
    ];
    for (name, alias, description, properties, required) in [
        (
            "knowledge.list",
            "knowledge_list",
            "List non-issue knowledge summaries with legacy-compatible pagination.",
            merge(
                scopes.clone(),
                json!({
                    "limit": integer_schema(1, 100),
                    "offset": integer_schema(0, 100000),
                }),
            ),
            Vec::new(),
        ),
        (
            "knowledge.catalog",
            "knowledge_catalog",
            "Return a compact catalog of non-issue graph nodes without bodies.",
            scopes.clone(),
            Vec::new(),
        ),
        (
            "knowledge.get",
            "knowledge_get",
            "Get one full non-issue knowledge node in the legacy Knowledge shape.",
            id.clone(),
            vec!["id"],
        ),
        (
            "knowledge.search",
            "knowledge_search",
            "Search knowledge through the native Rust index and return summaries without bodies.",
            merge(
                scopes.clone(),
                json!({
                    "query": string_schema("Plain-text terms."),
                    "limit": integer_schema(1, 100),
                }),
            ),
            vec!["query"],
        ),
        (
            "knowledge.neighbors",
            "knowledge_neighbors",
            "Return incoming and outgoing knowledge links around one entry.",
            merge(scopes.clone(), id.clone()),
            vec!["id"],
        ),
        (
            "knowledge.graph",
            "knowledge_graph",
            "Return compact knowledge nodes and directed edges for graph visualization.",
            scopes.clone(),
            Vec::new(),
        ),
        (
            "knowledge.create",
            "knowledge_create",
            "Create a typed non-issue knowledge node while preserving the legacy Knowledge input shape.",
            knowledge_write_properties(true),
            vec!["title"],
        ),
        (
            "knowledge.update",
            "knowledge_update",
            "Update one knowledge node through the shared graph engine.",
            knowledge_write_properties(false),
            vec!["id"],
        ),
        (
            "knowledge.delete",
            "knowledge_delete",
            "Move one knowledge Markdown source to the operating-system Trash.",
            mutation_id_properties(),
            vec!["id"],
        ),
        (
            "issues.list",
            "issues_list",
            "List issue summaries from all selected physical graph scopes.",
            scopes.clone(),
            Vec::new(),
        ),
        (
            "issues.get",
            "issues_get",
            "Get one full issue including body, graph links, scope, and source revision.",
            id.clone(),
            vec!["id"],
        ),
        (
            "issues.create",
            "issues_create",
            "Create a typed issue node with the proven Issue Board field contract.",
            issue_write_properties(true),
            vec!["title"],
        ),
        (
            "issues.update",
            "issues_update",
            "Update issue fields and translate project or assignee ids into graph relations.",
            issue_write_properties(false),
            vec!["id"],
        ),
        (
            "issues.delete",
            "issues_delete",
            "Move one issue Markdown source to the operating-system Trash.",
            mutation_id_properties(),
            vec!["id"],
        ),
    ] {
        definitions.push(definition(
            name,
            alias,
            description,
            properties,
            &required,
        ));
    }
    for (name, alias, description, properties, required) in [
        (
            "issues.move",
            "issues_move",
            "Move an issue to one validated board status with optional revision checking.",
            merge(
                mutation_id_properties(),
                json!({ "status": { "type": "string", "enum": super::ISSUE_STATUSES } }),
            ),
            vec!["id", "status"],
        ),
        (
            "issues.assign",
            "issues_assign",
            "Assign an issue to one real person node, or pass an empty personId to unassign it.",
            merge(
                mutation_id_properties(),
                json!({ "personId": { "type": "string" } }),
            ),
            vec!["id", "personId"],
        ),
        (
            "issues.complete",
            "issues_complete",
            "Complete one issue without exposing a generic property patch.",
            mutation_id_properties(),
            vec!["id"],
        ),
        (
            "projects.link_company",
            "projects_link_company",
            "Link one project to one real company node as its business client or owner.",
            merge(
                mutation_id_properties(),
                json!({ "companyId": string_schema("Target company node id.") }),
            ),
            vec!["id", "companyId"],
        ),
        (
            "projects.add_contact",
            "projects_add_contact",
            "Add one real person node as a project contact without duplicating the relation.",
            merge(
                mutation_id_properties(),
                json!({ "personId": string_schema("Target person node id.") }),
            ),
            vec!["id", "personId"],
        ),
        (
            "projects.record_decision",
            "projects_record_decision",
            "Create a durable decision in a project's physical scope with rationale and a real project relation.",
            merge(
                mutation_id_properties(),
                json!({
                    "decisionId": string_schema("Optional stable decision id."),
                    "title": string_schema("Decision title."),
                    "summary": { "type": "string" },
                    "body": { "type": "string" },
                    "rationale": { "type": "string" },
                }),
            ),
            vec!["id", "title"],
        ),
        (
            "issues.add_deliverable",
            "issues_add_deliverable",
            "Associate a reviewable workspace deliverable with an issue without duplicating its path.",
            merge(
                mutation_id_properties(),
                json!({
                    "path": string_schema("Workspace-relative or absolute deliverable path."),
                    "label": { "type": "string" },
                }),
            ),
            vec!["id", "path"],
        ),
        (
            "issues.create_next_action",
            "issues_create_next_action",
            "Create a planned follow-up issue in the same scope and project as an existing issue.",
            merge(
                mutation_id_properties(),
                json!({
                    "title": string_schema("Next-action title."),
                    "body": { "type": "string" },
                    "priority": { "type": "string", "enum": super::ISSUE_PRIORITIES },
                    "dueDate": { "type": "string" },
                    "assigneeId": { "type": "string" },
                    "tags": string_array("Operational tags."),
                }),
            ),
            vec!["id", "title"],
        ),
        (
            "research.capture_evidence",
            "research_capture_evidence",
            "Capture a source-aware evidence node beside a project, question, study, analysis, or other graph focus.",
            json!({
                "focusId": string_schema("Graph focus the evidence belongs with."),
                "evidenceId": string_schema("Optional stable evidence id."),
                "title": string_schema("Evidence title."),
                "summary": { "type": "string" },
                "body": { "type": "string" },
                "citation": { "type": "string" },
                "source": { "type": "string" },
                "certainty": { "type": "string" },
                "tags": string_array("Evidence tags."),
            }),
            vec!["focusId", "title"],
        ),
    ] {
        definitions.push(definition(name, alias, description, properties, &required));
    }
    definitions
}

fn definition(
    name: &'static str,
    alias: &'static str,
    description: &'static str,
    properties: Value,
    required: &[&str],
) -> (&'static str, &'static str, &'static str, Value) {
    (
        name,
        alias,
        description,
        json!({
            "type": "object",
            "properties": properties,
            "required": required,
            "additionalProperties": false,
        }),
    )
}

fn query_properties() -> Value {
    json!({
        "scopeIds": string_array("Physical scope ids."),
        "kinds": {
            "type": "array",
            "items": { "type": "string", "enum": ENTITY_KINDS },
            "uniqueItems": true,
        },
        "tags": string_array("Required tags."),
        "status": { "type": "string" },
        "offset": integer_schema(0, 100000),
        "limit": integer_schema(1, 500),
    })
}

fn graph_create_properties() -> Value {
    json!({
        "scopeId": string_schema("Target physical scope id. Defaults to the current project."),
        "id": string_schema("Optional stable lowercase slug id."),
        "kind": { "type": "string", "enum": ENTITY_KINDS },
        "title": string_schema("Human-readable title."),
        "summary": { "type": "string", "maxLength": 1000 },
        "body": { "type": "string" },
        "tags": string_array("Topic labels."),
        "relations": relation_array(),
        "properties": { "type": "object", "additionalProperties": true },
    })
}

fn graph_update_properties() -> Value {
    json!({
        "id": string_schema("Stable graph node id."),
        "expectedRevision": string_schema("Optional source revision for optimistic concurrency."),
        "kind": { "type": "string", "enum": ENTITY_KINDS },
        "title": { "type": "string" },
        "summary": { "type": "string", "maxLength": 1000 },
        "body": { "type": "string" },
        "tags": string_array("Replacement tags."),
        "relations": relation_array(),
        "setProperties": { "type": "object", "additionalProperties": true },
        "removeProperties": string_array("Property names to remove."),
    })
}

fn knowledge_write_properties(create: bool) -> Value {
    let mut properties = json!({
        "scopeId": string_schema("Target physical scope id. Defaults to the current project."),
        "id": string_schema("Stable lowercase slug id."),
        "type": { "type": "string", "enum": ENTITY_KINDS },
        "title": { "type": "string" },
        "summary": { "type": "string", "maxLength": 1000 },
        "tags": {
            "oneOf": [
                string_array("Topic labels."),
                { "type": "string" }
            ]
        },
        "links": {
            "oneOf": [
                relation_array(),
                { "type": "array", "items": { "type": "string" } },
                { "type": "string" }
            ]
        },
        "extra": { "type": "object", "additionalProperties": true },
        "body": { "type": "string" },
        "expectedRevision": string_schema("Optional source revision for optimistic concurrency."),
        "sourceRevision": string_schema("Legacy spelling of expectedRevision."),
    });
    if create {
        properties
            .as_object_mut()
            .expect("properties object")
            .remove("expectedRevision");
        properties
            .as_object_mut()
            .expect("properties object")
            .remove("sourceRevision");
    }
    properties
}

fn issue_write_properties(create: bool) -> Value {
    let mut properties = json!({
        "scopeId": string_schema("Target physical scope id. Defaults to the current project."),
        "id": string_schema("Optional issue id."),
        "title": { "type": "string" },
        "status": { "type": "string", "enum": super::ISSUE_STATUSES },
        "priority": { "type": "string", "enum": super::ISSUE_PRIORITIES },
        "dueDate": { "type": "string" },
        "project": { "type": "string" },
        "assignee": { "type": "string" },
        "labels": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": { "type": "string" },
                    "color": { "type": "string" },
                },
                "required": ["name"],
                "additionalProperties": false,
            }
        },
        "waitingFor": { "type": "string" },
        "snoozeUntil": { "type": "string" },
        "remindAt": { "type": "string" },
        "deliverables": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "label": { "type": "string" },
                },
                "required": ["path"],
                "additionalProperties": false,
            }
        },
        "links": relation_array(),
        "body": { "type": "string" },
        "expectedRevision": string_schema("Optional source revision for optimistic concurrency."),
        "sourceRevision": string_schema("Legacy spelling of expectedRevision."),
    });
    if create {
        properties
            .as_object_mut()
            .expect("properties object")
            .remove("expectedRevision");
        properties
            .as_object_mut()
            .expect("properties object")
            .remove("sourceRevision");
    }
    properties
}

fn mutation_id_properties() -> Value {
    json!({
        "id": string_schema("Stable graph node id."),
        "expectedRevision": string_schema("Optional source revision for optimistic concurrency."),
        "sourceRevision": string_schema("Legacy spelling of expectedRevision."),
    })
}

fn relation_array() -> Value {
    json!({
        "type": "array",
        "items": {
            "type": "object",
            "properties": {
                "relation": { "type": "string" },
                "rel": { "type": "string" },
                "target": { "type": "string" },
            },
            "required": ["target"],
            "additionalProperties": false,
        }
    })
}

fn string_schema(description: &str) -> Value {
    json!({ "type": "string", "description": description })
}

fn string_array(description: &str) -> Value {
    json!({
        "type": "array",
        "items": { "type": "string" },
        "uniqueItems": true,
        "description": description,
    })
}

fn integer_schema(minimum: usize, maximum: usize) -> Value {
    json!({
        "type": "integer",
        "minimum": minimum,
        "maximum": maximum,
    })
}

fn merge(mut left: Value, right: Value) -> Value {
    left.as_object_mut()
        .expect("left schema properties")
        .extend(right.as_object().expect("right schema properties").clone());
    left
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::business_graph::{GraphScopeKind, GraphSourceRoot};
    use std::fs;
    use tempfile::TempDir;

    fn fixture() -> (TempDir, GraphRuntime) {
        let root = TempDir::new().unwrap();
        fs::create_dir_all(root.path().join("knowledge")).unwrap();
        fs::create_dir_all(root.path().join("issues")).unwrap();
        fs::write(
            root.path().join("knowledge/client.md"),
            "---\ntitle: Client\ntype: company\n---\n",
        )
        .unwrap();
        fs::write(
            root.path().join("knowledge/project-alpha.md"),
            "---\ntitle: Project Alpha\ntype: project\nlinks: [\"for_company client\"]\n---\n",
        )
        .unwrap();
        fs::write(
            root.path().join("knowledge/alex.md"),
            "---\ntitle: Alex Researcher\ntype: person\n---\n",
        )
        .unwrap();
        fs::write(
            root.path().join("issues/issue-1.md"),
            "---\ntitle: Extract evidence\nstatus: plan\npriority: high\nproject: project-alpha\n---\nBody",
        )
        .unwrap();
        let runtime = GraphRuntime::from_roots(vec![GraphSourceRoot::new(
            "project:test",
            GraphScopeKind::Project,
            root.path(),
        )]);
        (root, runtime)
    }

    #[test]
    fn definitions_are_accepted_by_the_canonical_registry() {
        let registry = ToolRegistry::new();
        for (name, alias, description, schema) in native_tool_definitions() {
            registry
                .register(ToolRegistration::new(
                    ToolDescriptor::new(
                        name,
                        alias,
                        description,
                        schema,
                        ToolOwner::Core,
                        ToolSource::Native,
                    ),
                    |_context, _input| async { Ok(ToolResult::new(Value::Null)) },
                ))
                .unwrap();
        }
        assert_eq!(registry.list().len(), 37);
    }

    #[test]
    fn legacy_facades_and_generic_queries_share_one_store() {
        let (_root, runtime) = fixture();
        let graph = execute_native_tool(
            &runtime,
            "graph.query",
            json!({ "kinds": ["issue"], "limit": 10 }),
        )
        .unwrap();
        assert_eq!(graph.value["total"], 1);

        let issues = execute_native_tool(&runtime, "issues.list", json!({})).unwrap();
        assert_eq!(issues.value["items"][0]["id"], "issue-1");
        assert_eq!(issues.value["items"][0]["project"], json!("project-alpha"));

        let catalog = execute_native_tool(&runtime, "knowledge.catalog", json!({})).unwrap();
        assert_eq!(catalog.value["entries"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn compatibility_writes_create_real_relations_and_revisions() {
        let (root, runtime) = fixture();
        let created = execute_native_tool(
            &runtime,
            "issues.create",
            json!({
                "title": "Draft value story",
                "project": "project-alpha",
                "labels": [{ "name": "strategy", "color": "purple" }]
            }),
        )
        .unwrap();
        let id = created.value["id"].as_str().unwrap();
        assert!(root
            .path()
            .join("issues")
            .join(format!("{id}.md"))
            .is_file());
        assert!(created.value["sourceRevision"].as_str().unwrap().len() > 20);
        let full = runtime.get(id).unwrap().unwrap();
        assert!(full
            .relations
            .iter()
            .any(|edge| edge.relation == "part_of" && edge.target == "project-alpha"));
    }

    #[test]
    fn semantic_issue_actions_validate_and_mutate_real_entities() {
        let (_root, runtime) = fixture();
        let moved = execute_native_tool(
            &runtime,
            "issues.move",
            json!({ "id": "issue-1", "status": "in-progress" }),
        )
        .unwrap();
        assert_eq!(moved.value["status"], "in-progress");

        let assigned = execute_native_tool(
            &runtime,
            "issues.assign",
            json!({ "id": "issue-1", "personId": "alex" }),
        )
        .unwrap();
        assert_eq!(assigned.value["assignee"], "alex");
        let issue = runtime.get("issue-1").unwrap().unwrap();
        assert!(issue
            .relations
            .iter()
            .any(|edge| edge.relation == "assigned_to" && edge.target == "alex"));

        let invalid = execute_native_tool(
            &runtime,
            "issues.assign",
            json!({ "id": "issue-1", "personId": "client" }),
        )
        .unwrap_err();
        assert_eq!(invalid.code, ToolErrorCode::InvalidInput);
    }

    #[test]
    fn semantic_project_actions_are_idempotent_and_kind_safe() {
        let (_root, runtime) = fixture();
        execute_native_tool(
            &runtime,
            "projects.link_company",
            json!({ "id": "project-alpha", "companyId": "client" }),
        )
        .unwrap();
        execute_native_tool(
            &runtime,
            "projects.add_contact",
            json!({ "id": "project-alpha", "personId": "alex" }),
        )
        .unwrap();
        execute_native_tool(
            &runtime,
            "projects.add_contact",
            json!({ "id": "project-alpha", "personId": "alex" }),
        )
        .unwrap();

        let project = runtime.get("project-alpha").unwrap().unwrap();
        assert_eq!(
            project
                .relations
                .iter()
                .filter(|edge| edge.relation == "for_company" && edge.target == "client")
                .count(),
            1
        );
        assert_eq!(
            project
                .relations
                .iter()
                .filter(|edge| edge.relation == "has_contact" && edge.target == "alex")
                .count(),
            1
        );

        let invalid = execute_native_tool(
            &runtime,
            "projects.link_company",
            json!({ "id": "project-alpha", "companyId": "alex" }),
        )
        .unwrap_err();
        assert_eq!(invalid.code, ToolErrorCode::InvalidInput);
    }

    #[test]
    fn migration_report_tool_is_read_only_and_exposes_legacy_references() {
        let (root, runtime) = fixture();
        let issue_path = root.path().join("issues/issue-1.md");
        let before = fs::read_to_string(&issue_path).unwrap();

        let report = execute_native_tool(&runtime, "graph.migration_report", json!({})).unwrap();

        assert_eq!(report.value["dryRun"], true);
        assert_eq!(report.value["sourceCount"], 4);
        assert_eq!(
            report.value["legacyReferences"][0]["resolution"],
            "exact-id"
        );
        assert_eq!(fs::read_to_string(issue_path).unwrap(), before);
    }

    #[test]
    fn context_tool_returns_bounded_agent_ready_provenance() {
        let (_root, runtime) = fixture();
        let context = execute_native_tool(
            &runtime,
            "graph.context",
            json!({ "focusId": "issue-1", "maxNodes": 2 }),
        )
        .unwrap();
        assert_eq!(context.value["focusId"], "issue-1");
        assert_eq!(context.value["nodes"][0]["id"], "issue-1");
        assert_eq!(context.value["nodes"].as_array().unwrap().len(), 2);
        assert!(context.value["markdown"]
            .as_str()
            .unwrap()
            .contains("Business graph context"));
    }

    #[test]
    fn explicit_migration_resolution_replaces_legacy_text_with_a_valid_relation() {
        let (_root, runtime) = fixture();
        let resolved = execute_native_tool(
            &runtime,
            "graph.resolve_reference",
            json!({
                "id": "issue-1",
                "field": "assignee",
                "targetId": "alex"
            }),
        )
        .unwrap();
        assert_eq!(resolved.value["assignee"], "alex");
        let issue = runtime.get("issue-1").unwrap().unwrap();
        assert!(issue
            .relations
            .iter()
            .any(|edge| edge.relation == "assigned_to" && edge.target == "alex"));

        let invalid = execute_native_tool(
            &runtime,
            "graph.resolve_reference",
            json!({
                "id": "issue-1",
                "field": "assignee",
                "targetId": "client"
            }),
        )
        .unwrap_err();
        assert_eq!(invalid.code, ToolErrorCode::InvalidInput);
    }

    #[test]
    fn heor_workflow_actions_persist_decisions_evidence_deliverables_and_follow_up() {
        let (root, runtime) = fixture();
        let deliverable = execute_native_tool(
            &runtime,
            "issues.add_deliverable",
            json!({
                "id": "issue-1",
                "path": "outputs/evidence-map.md",
                "label": "Evidence map"
            }),
        )
        .unwrap();
        assert_eq!(
            deliverable.value["deliverables"][0]["path"],
            "outputs/evidence-map.md"
        );

        let next = execute_native_tool(
            &runtime,
            "issues.create_next_action",
            json!({
                "id": "issue-1",
                "title": "QA extracted outcomes",
                "priority": "high",
                "assigneeId": "alex"
            }),
        )
        .unwrap();
        let next_id = next.value["id"].as_str().unwrap().to_string();
        assert_eq!(next.value["project"], "project-alpha");
        assert_eq!(next.value["assignee"], "alex");

        execute_native_tool(
            &runtime,
            "projects.record_decision",
            json!({
                "id": "project-alpha",
                "decisionId": "decision-extraction",
                "title": "Double extract pivotal outcomes",
                "rationale": "Reduce transcription risk"
            }),
        )
        .unwrap();
        execute_native_tool(
            &runtime,
            "research.capture_evidence",
            json!({
                "focusId": "project-alpha",
                "evidenceId": "evidence-landmark",
                "title": "Landmark comparative study",
                "certainty": "moderate",
                "source": "doi:10.example/sanitized"
            }),
        )
        .unwrap();

        let reopened = GraphRuntime::from_roots(vec![GraphSourceRoot::new(
            "project:test",
            GraphScopeKind::Project,
            root.path(),
        )]);
        let follow_up = reopened.get(&next_id).unwrap().unwrap();
        assert!(follow_up
            .relations
            .iter()
            .any(|edge| edge.relation == "related_to" && edge.target == "issue-1"));
        assert_eq!(
            reopened
                .get("decision-extraction")
                .unwrap()
                .unwrap()
                .properties["rationale"],
            "Reduce transcription risk"
        );
        assert_eq!(
            reopened
                .get("evidence-landmark")
                .unwrap()
                .unwrap()
                .properties["certainty"],
            "moderate"
        );
        assert!(
            reopened.get("issue-1").unwrap().unwrap().properties["deliverables"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["path"] == "outputs/evidence-map.md")
        );
    }
}
