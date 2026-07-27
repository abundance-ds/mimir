//! `projects.*` tools: semantic project actions over the business graph.

use super::knowledge::knowledge_full;
use super::support::{
    definition, expected_revision, invalid_input, merge, mutation_error, mutation_id_properties,
    optional_string, require_node, required_string, string_schema,
};
use super::NativeExecution;
use crate::business_graph::{GraphNodeCreate, GraphNodePatch, GraphRelation, GraphRuntime};
use crate::tool_registry::ToolError;
use serde_json::{json, Map, Value};

pub(super) fn execute(
    runtime: &GraphRuntime,
    name: &str,
    input: Value,
) -> Result<NativeExecution, ToolError> {
    match name {
        "projects.link_company" => {
            project_relation(runtime, &input, "companyId", "company", "for_company", true)
        }
        "projects.add_contact" => {
            project_relation(runtime, &input, "personId", "person", "has_contact", false)
        }
        "projects.record_decision" => project_record_decision(runtime, &input),
        _ => Err(super::unknown_tool(name)),
    }
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

pub(super) fn definitions() -> Vec<(&'static str, &'static str, &'static str, Value)> {
    let mut definitions = Vec::new();
    for (name, alias, description, properties, required) in [
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
    ] {
        definitions.push(definition(name, alias, description, properties, &required));
    }
    definitions
}
