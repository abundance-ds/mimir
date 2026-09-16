//! Shared plumbing for the native business graph tools: input parsing,
//! result and error shaping, node lookups, and JSON schema builders.

use super::NativeExecution;
use crate::business_graph::{
    GraphDeleteResult, GraphMutationError, GraphNode, GraphQuery, GraphRelation, GraphRuntime,
};
use crate::tool_registry::{ToolError, ToolErrorCode};
use serde::de::DeserializeOwned;
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;

pub(super) fn all_nodes(
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

pub(super) fn relation_vec(value: Option<&Value>) -> Result<Vec<GraphRelation>, ToolError> {
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

pub(super) fn require_node(runtime: &GraphRuntime, id: &str) -> Result<GraphNode, ToolError> {
    runtime.get(id).map_err(internal_error)?.ok_or_else(|| {
        ToolError::new(
            ToolErrorCode::NotFound,
            format!("graph node not found: {id}"),
        )
    })
}

pub(super) fn delete_execution(deleted: GraphDeleteResult) -> Result<NativeExecution, ToolError> {
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

pub(super) fn parse_input<T: DeserializeOwned>(input: Value) -> Result<T, ToolError> {
    serde_json::from_value(input).map_err(|error| invalid_input(error.to_string()))
}

pub(super) fn value<T: serde::Serialize>(value: T) -> Result<NativeExecution, ToolError> {
    serde_json::to_value(value)
        .map(NativeExecution::read)
        .map_err(internal_error)
}

pub(super) fn mutation_value<T: serde::Serialize>(
    value: T,
    path: String,
) -> Result<NativeExecution, ToolError> {
    serde_json::to_value(value)
        .map(|value| NativeExecution::mutation(value, path))
        .map_err(internal_error)
}

pub(super) fn required_string<'a>(input: &'a Value, field: &str) -> Result<&'a str, ToolError> {
    input
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid_input(format!("{field} is required")))
}

pub(super) fn optional_string(input: &Value, field: &str) -> Option<String> {
    input.get(field).and_then(Value::as_str).map(str::to_string)
}

pub(super) fn expected_revision(input: &Value) -> Option<String> {
    optional_string(input, "expectedRevision").or_else(|| optional_string(input, "sourceRevision"))
}

pub(super) fn usize_field(input: &Value, field: &str) -> Option<usize> {
    input
        .get(field)
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
}

pub(super) fn object_field(input: &Value, field: &str) -> Map<String, Value> {
    input
        .get(field)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

pub(super) fn string_vec(value: Option<&Value>) -> Vec<String> {
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

pub(super) fn string_set(value: Option<&Value>) -> BTreeSet<String> {
    string_vec(value).into_iter().collect()
}

pub(super) fn scope_ids(input: &Value) -> BTreeSet<String> {
    string_set(input.get("scopeIds"))
}

pub(super) fn mutation_error(error: GraphMutationError) -> ToolError {
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

pub(super) fn invalid_input(message: impl Into<String>) -> ToolError {
    ToolError::new(ToolErrorCode::InvalidInput, message)
}

pub(super) fn internal_error(error: impl std::fmt::Display) -> ToolError {
    ToolError::new(ToolErrorCode::Internal, error.to_string())
}

pub(super) fn definition(
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

pub(super) fn scopes_properties() -> Value {
    json!({
        "scopeIds": string_array("Empty or omitted: all mounted scopes.")
    })
}

pub(super) fn id_properties() -> Value {
    json!({ "id": { "type": "string" } })
}

pub(super) fn mutation_id_properties() -> Value {
    json!({
        "id": { "type": "string" },
        "expectedRevision": string_schema("Source revision; defaults to Mimir's last loaded revision."),
        "sourceRevision": string_schema("Legacy; use expectedRevision."),
    })
}

pub(super) fn relation_array() -> Value {
    json!({
        "type": "array",
        "description": "Use {relation, target}.",
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

pub(super) fn string_schema(description: &str) -> Value {
    json!({ "type": "string", "description": description })
}

pub(super) fn string_array(description: &str) -> Value {
    json!({
        "type": "array",
        "items": { "type": "string" },
        "uniqueItems": true,
        "description": description,
    })
}

pub(super) fn integer_schema(minimum: usize, maximum: usize) -> Value {
    json!({
        "type": "integer",
        "minimum": minimum,
        "maximum": maximum,
    })
}

pub(super) fn merge(mut left: Value, right: Value) -> Value {
    left.as_object_mut()
        .expect("left schema properties")
        .extend(right.as_object().expect("right schema properties").clone());
    left
}
