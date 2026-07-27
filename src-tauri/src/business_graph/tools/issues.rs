//! `issues.*` tools: the Issue Board facade over issue graph nodes.

use super::support::{
    all_nodes, definition, delete_execution, expected_revision, id_properties, invalid_input,
    merge, mutation_error, mutation_id_properties, optional_string, relation_array, relation_vec,
    require_node, required_string, scope_ids, scopes_properties, string_array, string_schema,
    string_vec,
};
use super::NativeExecution;
use crate::business_graph::{
    GraphNode, GraphNodeCreate, GraphNodeDelete, GraphNodePatch, GraphRelation, GraphRuntime,
    ISSUE_PRIORITIES, ISSUE_STATUSES,
};
use crate::tool_registry::ToolError;
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;

pub(super) fn execute(
    runtime: &GraphRuntime,
    name: &str,
    input: Value,
) -> Result<NativeExecution, ToolError> {
    match name {
        "issues.list" => issues_list(runtime, &input),
        "issues.get" => issues_get(runtime, &input),
        "issues.create" => issues_create(runtime, &input),
        "issues.update" => issues_update(runtime, &input),
        "issues.delete" => issues_delete(runtime, &input),
        "issues.move" => issues_move(runtime, &input),
        "issues.assign" => issues_assign(runtime, &input),
        "issues.complete" => issues_complete(runtime, &input),
        "issues.add_deliverable" => issues_add_deliverable(runtime, &input),
        "issues.create_next_action" => issues_create_next_action(runtime, &input),
        _ => Err(super::unknown_tool(name)),
    }
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

pub(super) fn issue_value(node: &GraphNode, include_body: bool) -> Value {
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

pub(super) fn require_issue(node: &GraphNode) -> Result<(), ToolError> {
    if node.kind != "issue" {
        Err(invalid_input(format!(
            "'{}' is {}; use knowledge.get",
            node.id, node.kind
        )))
    } else {
        Ok(())
    }
}

pub(super) fn definitions() -> Vec<(&'static str, &'static str, &'static str, Value)> {
    let scopes = scopes_properties();
    let id = id_properties();
    let mut definitions = Vec::new();
    for (name, alias, description, properties, required) in [
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
        (
            "issues.move",
            "issues_move",
            "Move an issue to one validated board status with optional revision checking.",
            merge(
                mutation_id_properties(),
                json!({ "status": { "type": "string", "enum": ISSUE_STATUSES } }),
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
                    "priority": { "type": "string", "enum": ISSUE_PRIORITIES },
                    "dueDate": { "type": "string" },
                    "assigneeId": { "type": "string" },
                    "tags": string_array("Operational tags."),
                }),
            ),
            vec!["id", "title"],
        ),
    ] {
        definitions.push(definition(name, alias, description, properties, &required));
    }
    definitions
}

fn issue_write_properties(create: bool) -> Value {
    let mut properties = json!({
        "scopeId": string_schema("Target physical scope id. Defaults to the current project."),
        "id": string_schema("Optional issue id."),
        "title": { "type": "string" },
        "status": { "type": "string", "enum": ISSUE_STATUSES },
        "priority": { "type": "string", "enum": ISSUE_PRIORITIES },
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
