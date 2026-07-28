//! `graph.*` tools: typed, source-aware access to the whole business graph.

use super::issues::{issue_value, require_issue};
use super::support::{
    definition, expected_revision, id_properties, integer_schema, internal_error, invalid_input,
    merge, mutation_error, mutation_id_properties, mutation_value, parse_input, relation_array,
    require_node, required_string, scopes_properties, string_array, string_schema, string_set,
    usize_field, value,
};
use super::NativeExecution;
use crate::business_graph::{
    GraphContextRequest, GraphEventQuery, GraphNodeCreate, GraphNodeDelete, GraphNodePatch,
    GraphQuery, GraphRelation, GraphRestoreRequest, GraphRuntime, ENTITY_KINDS,
};
use crate::tool_registry::ToolError;
use serde_json::{json, Map, Value};

pub(super) fn execute(
    runtime: &GraphRuntime,
    name: &str,
    input: Value,
) -> Result<NativeExecution, ToolError> {
    match name {
        "graph.status" => value(runtime.open_result().map_err(internal_error)?),
        "graph.find" => find(runtime, input),
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
        "graph.events" => value(
            runtime
                .events(&parse_input::<GraphEventQuery>(input)?)
                .map_err(internal_error)?,
        ),
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
        _ => Err(super::unknown_tool(name)),
    }
}

fn find(runtime: &GraphRuntime, input: Value) -> Result<NativeExecution, ToolError> {
    let query_text = input
        .get("query")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let relation = input
        .get("relation")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let target_id = input
        .get("targetId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let updated_after = input
        .get("updatedAfter")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let updated_before = input
        .get("updatedBefore")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let offset = usize_field(&input, "offset").unwrap_or(0);
    let limit = usize_field(&input, "limit").unwrap_or(25).clamp(1, 100);
    let mut query = parse_input::<GraphQuery>(input.clone())?;
    query.offset = 0;
    query.limit = 500;
    let result = runtime.query(&query).map_err(internal_error)?;
    let scores = query_text.map(|text| {
        runtime
            .search(text, &query.scope_ids, 100)
            .map_err(internal_error)
            .map(|items| {
                items
                    .into_iter()
                    .map(|item| (item.node.id, item.score))
                    .collect::<std::collections::HashMap<_, _>>()
            })
    });
    let scores = match scores {
        Some(result) => Some(result?),
        None => None,
    };
    let mut items = result
        .items
        .into_iter()
        .filter(|node| {
            scores
                .as_ref()
                .is_none_or(|scores| scores.contains_key(&node.id))
                && relation.is_none_or(|expected| {
                    node.relations.iter().any(|edge| {
                        edge.relation == expected
                            && target_id.is_none_or(|target| edge.target == target)
                    })
                })
                && (relation.is_some()
                    || target_id.is_none_or(|target| {
                        node.relations.iter().any(|edge| edge.target == target)
                    }))
                && updated_after.is_none_or(|after| node.updated_at.as_str() >= after)
                && updated_before.is_none_or(|before| node.updated_at.as_str() <= before)
        })
        .collect::<Vec<_>>();
    if let Some(scores) = scores.as_ref() {
        items.sort_by(|left, right| {
            scores[&right.id]
                .cmp(&scores[&left.id])
                .then_with(|| right.updated_at.cmp(&left.updated_at))
                .then_with(|| left.id.cmp(&right.id))
        });
    }
    let total = items.len();
    let items = items
        .into_iter()
        .skip(offset)
        .take(limit)
        .collect::<Vec<_>>();
    value(json!({
        "items": items,
        "total": total,
        "offset": offset.min(total),
        "limit": limit,
        "graphRevision": result.graph_revision,
    }))
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

pub(super) fn definitions() -> Vec<(&'static str, &'static str, &'static str, Value)> {
    let scopes = scopes_properties();
    let id = id_properties();
    vec![
        definition(
            "graph.find",
            "graph_find",
            "Find graph nodes by text, physical scope, kind, tags, issue status, relation, or update time.",
            merge(
                query_properties(),
                json!({
                    "query": { "type": "string", "minLength": 1, "maxLength": 500 },
                    "relation": string_schema("Required outgoing relation name."),
                    "targetId": string_schema("Required outgoing relation target id."),
                    "updatedAfter": string_schema("Inclusive ISO-8601 lower update bound."),
                    "updatedBefore": string_schema("Inclusive ISO-8601 upper update bound."),
                }),
            ),
            &[],
        ),
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
            "graph.events",
            "graph_events",
            "List the durable authored change stream for the selected physical graph scopes.",
            merge(
                scopes.clone(),
                json!({
                    "offset": integer_schema(0, 1000000),
                    "limit": integer_schema(1, 500),
                }),
            ),
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
            "Patch one graph node with conflict-safe source-revision checking; an omitted expectedRevision defaults to the last-loaded revision.",
            graph_update_properties(),
            &["id"],
        ),
        definition(
            "graph.delete",
            "graph_delete",
            "Move one graph node source to the operating-system Trash after a conflict-safe source-revision check.",
            mutation_id_properties(),
            &["id"],
        ),
        definition(
            "graph.restore",
            "graph_restore",
            "Restore one recently Trashed graph source using the undo token returned by graph_delete.",
            json!({
                "undoToken": string_schema("Undo token returned by graph_delete."),
            }),
            &["undoToken"],
        ),
    ]
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
        "expectedRevision": string_schema(
            "Optional source revision for optimistic concurrency. Omitted, the check uses the revision last loaded by the workbench, so stale writes are rejected either way.",
        ),
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
