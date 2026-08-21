//! `research.*` tools: evidence capture beside any graph focus.

use super::knowledge::knowledge_full;
use super::support::{
    definition, mutation_error, optional_string, require_node, required_string, string_array,
    string_schema, string_vec,
};
use super::NativeExecution;
use crate::business_graph::{GraphNodeCreate, GraphRelation, GraphRuntime};
use crate::tool_registry::ToolError;
use serde_json::{json, Map, Value};

pub(super) fn execute(
    runtime: &GraphRuntime,
    name: &str,
    input: Value,
) -> Result<NativeExecution, ToolError> {
    match name {
        "research.capture_evidence" => research_capture_evidence(runtime, &input),
        _ => Err(super::unknown_tool(name)),
    }
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
    let project_id = optional_string(input, "project")
        .filter(|value| !value.is_empty())
        .or_else(|| {
            (focus.kind == "project")
                .then(|| focus.id.clone())
                .or_else(|| {
                    focus
                        .relations
                        .iter()
                        .find(|edge| edge.relation == "part_of")
                        .map(|edge| edge.target.clone())
                })
        });
    let mut relations = vec![GraphRelation {
        relation: "related_to".into(),
        target: focus.id,
        legacy: false,
    }];
    if let Some(project_id) = project_id {
        relations.push(GraphRelation {
            relation: "part_of".into(),
            target: project_id,
            legacy: false,
        });
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
            relations,
            properties,
        })
        .map_err(mutation_error)?;
    Ok(NativeExecution::mutation(
        knowledge_full(&created),
        created.provenance.source_path,
    ))
}

pub(super) fn definitions() -> Vec<(&'static str, &'static str, &'static str, Value)> {
    vec![definition(
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
        &["focusId", "title"],
    )]
}
