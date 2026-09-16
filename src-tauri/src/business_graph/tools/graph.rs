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
use crate::tool_registry::{ToolError, ToolErrorCode};
use serde_json::{json, Map, Value};

pub(super) fn execute(
    runtime: &GraphRuntime,
    name: &str,
    input: Value,
) -> Result<NativeExecution, ToolError> {
    match name {
        "graph.status" => value(runtime.open_result().map_err(internal_error)?),
        "graph.resource_add" => resource_add(runtime, input),
        "graph.find" => find(runtime, input),
        "graph.list" | "graph.query" => {
            let query = parse_input::<GraphQuery>(input)?;
            value(runtime.query(&query).map_err(internal_error)?)
        }
        "graph.get" => {
            let id = required_string(&input, "id")?;
            let node = require_node(runtime, id)?;
            let mut result = serde_json::to_value(node).map_err(internal_error)?;
            result["bodyReferences"] = serde_json::to_value(
                runtime
                    .references(id, &string_set(input.get("scopeIds")))
                    .map_err(internal_error)?,
            )
            .map_err(internal_error)?;
            value(result)
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
                .create(parse_input::<GraphNodeCreate>(normalize_relation_alias(
                    input,
                ))?)
                .map_err(mutation_error)?;
            mutation_value(created.clone(), created.provenance.source_path)
        }
        "graph.update" => {
            let updated = runtime
                .update(parse_input::<GraphNodePatch>(normalize_relation_alias(
                    input,
                ))?)
                .map_err(mutation_error)?;
            mutation_value(updated.clone(), updated.provenance.source_path)
        }
        "graph.delete" => {
            let mut input = input;
            if let Some(fields) = input.as_object_mut() {
                if let Some(revision) = fields.remove("sourceRevision") {
                    fields.entry("expectedRevision").or_insert(revision);
                }
            }
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

fn normalize_relation_alias(mut input: Value) -> Value {
    if let Some(relations) = input.get_mut("relations").and_then(Value::as_array_mut) {
        for relation in relations {
            if let Some(fields) = relation.as_object_mut() {
                if let Some(alias) = fields.remove("rel") {
                    fields.entry("relation").or_insert(alias);
                }
            }
        }
    }
    input
}

fn resource_add(runtime: &GraphRuntime, input: Value) -> Result<NativeExecution, ToolError> {
    let source_path = required_string(&input, "sourcePath")?;
    let resource_id = input
        .get("resourceId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let existing = if let Some(id) = resource_id {
        let expected = required_string(&input, "expectedRevision")?;
        let node = require_node(runtime, id)?;
        if node.kind != "resource" || node.provenance.scope_id != "team:main" {
            return Err(invalid_input(
                "resourceId must identify a Resource node in the Team scope",
            ));
        }
        if node.provenance.source_revision != expected {
            return Err(ToolError::new(
                ToolErrorCode::Handler,
                "The Resource changed. Read it again before adding the file.",
            )
            .with_data(json!({
                "conflict": true,
                "id": node.id,
                "expectedRevision": expected,
                "actualRevision": node.provenance.source_revision,
            })));
        }
        Some(node)
    } else {
        None
    };
    let relative_path = crate::managed_git::import_team_resource(source_path)
        .map_err(|error| ToolError::new(ToolErrorCode::Unavailable, error))?;
    let label = input
        .get("label")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let file = match label {
        Some(label) => json!({ "path": relative_path, "label": label }),
        None => json!({ "path": relative_path }),
    };
    if let Some(node) = existing {
        let mut files = node
            .properties
            .get("files")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        files.push(file);
        let updated = runtime
            .update(GraphNodePatch {
                id: node.id,
                expected_revision: expected_revision(&input),
                set_properties: Map::from_iter([("files".into(), Value::Array(files))]),
                ..GraphNodePatch::default()
            })
            .map_err(mutation_error)?;
        return mutation_value(updated.clone(), updated.provenance.source_path);
    }
    let title = input
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            std::path::Path::new(source_path)
                .file_stem()
                .and_then(|value| value.to_str())
                .map(str::to_string)
        })
        .ok_or_else(|| invalid_input("title is required when the source file has no name"))?;
    let created = runtime
        .create(GraphNodeCreate {
            scope_id: Some("team:main".into()),
            kind: "resource".into(),
            title,
            properties: Map::from_iter([("files".into(), Value::Array(vec![file]))]),
            ..GraphNodeCreate::default()
        })
        .map_err(mutation_error)?;
    mutation_value(created.clone(), created.provenance.source_path)
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
    let mut result = runtime.query(&query).map_err(internal_error)?;
    let graph_revision = result.graph_revision;
    let mut candidates = std::mem::take(&mut result.items);
    while candidates.len() < result.total {
        query.offset = candidates.len();
        result = runtime.query(&query).map_err(internal_error)?;
        if result.items.is_empty() {
            break;
        }
        candidates.extend(std::mem::take(&mut result.items));
    }
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
    let candidates = candidates
        .into_iter()
        .map(|node| {
            let relations = if relation.is_some() || target_id.is_some() {
                runtime
                    .effective_relations(&node.id)
                    .map_err(internal_error)?
            } else {
                Vec::new()
            };
            Ok((node, relations))
        })
        .collect::<Result<Vec<_>, ToolError>>()?;
    let mut items = candidates
        .into_iter()
        .filter(|(node, relations)| {
            scores
                .as_ref()
                .is_none_or(|scores| scores.contains_key(&node.id))
                && relation.is_none_or(|expected| {
                    relations.iter().any(|edge| {
                        edge.relation == expected
                            && target_id.is_none_or(|target| edge.target == target)
                    })
                })
                && (relation.is_some()
                    || target_id
                        .is_none_or(|target| relations.iter().any(|edge| edge.target == target)))
                && updated_after.is_none_or(|after| node.updated_at.as_str() >= after)
                && updated_before.is_none_or(|before| node.updated_at.as_str() <= before)
        })
        .map(|(node, _)| node)
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
        "graphRevision": graph_revision,
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
            "Find graph nodes by text and filters.",
            merge(
                query_properties(),
                json!({
                    "query": { "type": "string", "minLength": 1, "maxLength": 500,
                        "description": "Plain text." },
                    "relation": string_schema("Outgoing relation."),
                    "targetId": string_schema("Outgoing target node ID."),
                    "updatedAfter": string_schema("UTC ISO-8601 timestamp, inclusive."),
                    "updatedBefore": string_schema("UTC ISO-8601 timestamp, inclusive."),
                    "limit": integer_schema(1, 100),
                }),
            ),
            &[],
        ),
        definition(
            "graph.status",
            "graph_status",
            "Read mounted graph scopes and counts.",
            json!({}),
            &[],
        ),
        definition(
            "graph.resource_add",
            "graph_resource_add",
            "Copy a local file into a Team Resource.",
            json!({
                "sourcePath": string_schema("Absolute local path."),
                "resourceId": string_schema("Existing Team Resource; omit to create one."),
                "title": string_schema("For new Resources."),
                "label": { "type": "string" },
                "expectedRevision": string_schema("Required with resourceId; use its provenance.sourceRevision."),
            }),
            &["sourcePath"],
        ),
        definition(
            "graph.list",
            "graph_list",
            "List graph nodes matching filters.",
            query_properties(),
            &[],
        ),
        definition(
            "graph.query",
            "graph_query",
            "List graph nodes matching filters.",
            query_properties(),
            &[],
        ),
        definition(
            "graph.get",
            "graph_get",
            "Read a complete graph node.",
            id.clone(),
            &["id"],
        ),
        definition(
            "graph.search",
            "graph_search",
            "Search graph text.",
            merge(
                scopes.clone(),
                json!({
                    "query": string_schema("Plain text."),
                    "limit": integer_schema(1, 100),
                }),
            ),
            &["query"],
        ),
        definition(
            "graph.neighbors",
            "graph_neighbors",
            "Read incoming and outgoing graph neighbors.",
            merge(scopes.clone(), id.clone()),
            &["id"],
        ),
        definition(
            "graph.diagnostics",
            "graph_diagnostics",
            "Report graph validation problems.",
            json!({}),
            &[],
        ),
        definition(
            "graph.events",
            "graph_events",
            "Read graph change history.",
            merge(
                scopes.clone(),
                json!({
                    "since": string_schema("RFC 3339 timestamp, inclusive."),
                    "offset": integer_schema(0, 1000000),
                    "limit": integer_schema(1, 500),
                }),
            ),
            &[],
        ),
        definition(
            "graph.migration_report",
            "graph_migration_report",
            "Preview legacy graph migration.",
            json!({}),
            &[],
        ),
        definition(
            "graph.context",
            "graph_context",
            "Read context around a graph node.",
            merge(
                scopes.clone(),
                json!({
                    "focusId": string_schema("Start node; omit for recently updated nodes."),
                    "maxNodes": integer_schema(1, 40),
                }),
            ),
            &[],
        ),
        definition(
            "graph.resolve_reference",
            "graph_resolve_reference",
            "Resolve legacy issue references.",
            merge(
                mutation_id_properties(),
                json!({
                    "field": { "type": "string", "enum": ["project", "assignee"] },
                    "targetId": { "type": "string" },
                }),
            ),
            &["id", "field", "targetId"],
        ),
        definition(
            "graph.create",
            "graph_create",
            "Create a graph node.",
            graph_create_properties(),
            &["kind", "title"],
        ),
        definition(
            "graph.update",
            "graph_update",
            "Update a graph node.",
            graph_update_properties(),
            &["id"],
        ),
        definition(
            "graph.delete",
            "graph_delete",
            "Move a graph node to Trash.",
            mutation_id_properties(),
            &["id"],
        ),
        definition(
            "graph.restore",
            "graph_restore",
            "Restore with a graph_delete undo token.",
            json!({
                "undoToken": { "type": "string" },
            }),
            &["undoToken"],
        ),
    ]
}

fn query_properties() -> Value {
    json!({
        "scopeIds": string_array("Empty or omitted: all mounted scopes."),
        "kinds": {
            "type": "array",
            "items": { "type": "string", "enum": ENTITY_KINDS },
            "uniqueItems": true,
        },
        "tags": string_array("All must match."),
        "status": { "type": "string" },
        "offset": integer_schema(0, 100000),
        "limit": integer_schema(1, 500),
    })
}

fn graph_create_properties() -> Value {
    json!({
        "scopeId": string_schema("Default: configured workspace scope; otherwise prefers Team (Journal: Private)."),
        "id": string_schema("Lowercase slug; generated if omitted."),
        "kind": { "type": "string", "enum": ENTITY_KINDS },
        "title": { "type": "string" },
        "summary": { "type": "string", "maxLength": 1000 },
        "body": string_schema("Markdown; graph links: [Title](mimir://graph/<id>)."),
        "tags": { "type": "array", "items": { "type": "string" }, "uniqueItems": true },
        "relations": relation_array(),
        "properties": { "type": "object", "additionalProperties": true,
            "description": "Timesheet: period YYYY-MM; entries [{id, date, minutes, description, invoice?}]. IDs unique/stable; dates within period; minutes integer 1–1440; invoice nonempty reference string (absent=Open)." },
    })
}

fn graph_update_properties() -> Value {
    json!({
        "id": { "type": "string" },
        "expectedRevision": string_schema(
            "Use provenance.sourceRevision; defaults to Mimir's last loaded revision.",
        ),
        "kind": { "type": "string", "enum": ENTITY_KINDS },
        "title": { "type": "string" },
        "summary": { "type": "string", "maxLength": 1000 },
        "body": string_schema("Markdown; graph links: [Title](mimir://graph/<id>)."),
        "tags": string_array("Replaces all tags."),
        "relations": merge(relation_array(), json!({
            "description": "Replaces all outgoing links; use {relation, target}."
        })),
        "setProperties": { "type": "object", "additionalProperties": true,
            "description": "Replaces whole property values, including arrays/objects. Timesheet: preserve other rows, IDs and unknown fields; invoice: nonempty reference string (absent=Open)." },
        "removeProperties": { "type": "array", "items": { "type": "string" }, "uniqueItems": true },
    })
}
