//! `knowledge.*` tools: the legacy Knowledge facade over non-issue graph nodes.

use super::support::{
    all_nodes, definition, delete_execution, expected_revision, id_properties, integer_schema,
    internal_error, invalid_input, merge, mutation_error, mutation_id_properties, object_field,
    optional_string, relation_array, relation_vec, require_node, required_string, scope_ids,
    scopes_properties, string_array, string_schema, string_vec, usize_field,
};
use super::NativeExecution;
use crate::business_graph::{
    GraphNeighbor, GraphNode, GraphNodeCreate, GraphNodeDelete, GraphNodePatch,
    GraphRelationDirection, GraphRuntime, ENTITY_KINDS,
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
        "knowledge.list" => knowledge_list(runtime, &input),
        "knowledge.catalog" => knowledge_catalog(runtime, &input),
        "knowledge.get" => knowledge_get(runtime, &input),
        "knowledge.search" => knowledge_search(runtime, &input),
        "knowledge.neighbors" => knowledge_neighbors(runtime, &input),
        "knowledge.graph" => knowledge_graph(runtime, &input),
        "knowledge.create" => knowledge_create(runtime, &input),
        "knowledge.update" => knowledge_update(runtime, &input),
        "knowledge.delete" => knowledge_delete(runtime, &input),
        _ => Err(super::unknown_tool(name)),
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
    if let Some(redact) = input.get("redactFromContext").and_then(Value::as_bool) {
        properties.insert("sensitive".into(), Value::Bool(redact));
    }
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
    let mut set_properties = object_field(input, "extra");
    if let Some(redact) = input.get("redactFromContext").and_then(Value::as_bool) {
        set_properties.insert("sensitive".into(), Value::Bool(redact));
    }
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
        set_properties,
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

pub(super) fn knowledge_full(node: &GraphNode) -> Value {
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
    value.insert(
        "redactFromContext".into(),
        json!(
            node.kind == "record"
                || node
                    .properties
                    .get("sensitive")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
        ),
    );
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

pub(super) fn definitions() -> Vec<(&'static str, &'static str, &'static str, Value)> {
    let scopes = scopes_properties();
    let id = id_properties();
    let mut definitions = Vec::new();
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
    ] {
        definitions.push(definition(name, alias, description, properties, &required));
    }
    definitions
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
        "redactFromContext": {
            "type": "boolean",
            "default": false,
            "description": "Exclude human content from automatic graph context. Direct reads and searches still return it."
        },
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
