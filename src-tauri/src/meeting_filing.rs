use crate::{
    business_graph::{
        runtime::{emit_mutation_changed, GraphRuntime},
        GraphActor, GraphNode, GraphNodeCreate, GraphRelation,
    },
    meetings::runtime::MeetingRuntime,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use tauri::AppHandle;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingFileRequest {
    pub meeting_id: String,
    pub scope_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default)]
    pub people_ids: Vec<String>,
}

#[tauri::command]
pub fn meetings_file_to_graph(
    app: AppHandle,
    meetings: tauri::State<'_, MeetingRuntime>,
    graph: tauri::State<'_, GraphRuntime>,
    request: MeetingFileRequest,
) -> Result<GraphNode, String> {
    let source = meetings
        .filing_source(&request.meeting_id)
        .map_err(|error| error.to_string())?;
    let graph_id = source
        .graph_node_id
        .clone()
        .unwrap_or_else(|| source.id.clone());

    if let Some(existing) = graph.get(&graph_id)? {
        validate_existing_link(&existing, &source.id)?;
        meetings
            .link_graph_node(&source.id, &existing.id)
            .map_err(|error| error.to_string())?;
        return Ok(existing);
    }
    if source.graph_node_id.is_some() {
        return Err(format!(
            "Linked Graph meeting '{}' is not mounted or no longer exists",
            graph_id
        ));
    }

    let project_id = clean_optional(request.project_id);
    if let Some(project_id) = project_id.as_deref() {
        require_kind(&graph, project_id, "project")?;
    }
    let people_ids = unique_ids(request.people_ids);
    for person_id in &people_ids {
        require_kind(&graph, person_id, "person")?;
    }

    let mut relations = Vec::new();
    if let Some(project_id) = project_id {
        relations.push(GraphRelation {
            relation: "part_of".into(),
            target: project_id,
            legacy: false,
        });
    }
    relations.extend(people_ids.into_iter().map(|person_id| GraphRelation {
        relation: "attended_by".into(),
        target: person_id,
        legacy: false,
    }));

    let mut properties = Map::new();
    properties.insert("sourceMeetingId".into(), Value::String(source.id.clone()));
    properties.insert(
        "sourceSummaryHash".into(),
        Value::String(format!("{:x}", Sha256::digest(source.summary.as_bytes()))),
    );
    properties.insert("durationMs".into(), Value::from(source.duration_ms));
    if let Some(started_at) = source.started_at.clone() {
        properties.insert("occurredAt".into(), Value::String(started_at));
    }

    let created = graph
        .create(GraphNodeCreate {
            scope_id: Some(request.scope_id.trim().to_string()),
            id: Some(graph_id),
            kind: "meeting".into(),
            title: source.title.trim().to_string(),
            summary: retrieval_summary(&source.summary),
            body: source.summary,
            tags: Vec::new(),
            relations,
            properties,
        })
        .map_err(|error| error.to_string())?;
    graph.record_mutation(
        "meeting.file",
        GraphActor::human(),
        None,
        Some(created.clone()),
        created.provenance.source_path.clone(),
    )?;
    emit_mutation_changed(&app, &graph, created.provenance.source_path.clone())?;
    meetings
        .link_graph_node(&source.id, &created.id)
        .map_err(|error| error.to_string())?;
    Ok(created)
}

fn validate_existing_link(node: &GraphNode, meeting_id: &str) -> Result<(), String> {
    if node.kind == "meeting"
        && node
            .properties
            .get("sourceMeetingId")
            .and_then(Value::as_str)
            == Some(meeting_id)
    {
        return Ok(());
    }
    Err(format!(
        "Graph id '{}' already belongs to another item",
        node.id
    ))
}

fn require_kind(graph: &GraphRuntime, id: &str, expected: &str) -> Result<(), String> {
    let node = graph
        .get(id)?
        .ok_or_else(|| format!("Graph {expected} '{id}' is not mounted"))?;
    if node.kind != expected {
        return Err(format!("Graph item '{id}' is not a {expected}"));
    }
    Ok(())
}

fn clean_optional(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn unique_ids(values: Vec<String>) -> Vec<String> {
    let mut result = Vec::new();
    for value in values {
        let value = value.trim().to_string();
        if !value.is_empty() && !result.contains(&value) {
            result.push(value);
        }
    }
    result
}

fn retrieval_summary(body: &str) -> String {
    body.lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with('#'))
        .map(|line| line.trim_start_matches(['-', '*', '•', ' ']).trim())
        .unwrap_or("Meeting brief")
        .chars()
        .take(280)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retrieval_summary_uses_the_bluf_bullet() {
        assert_eq!(
            retrieval_summary("- Ship the release on Friday.\n- Owner: Ana"),
            "Ship the release on Friday."
        );
    }

    #[test]
    fn people_ids_are_small_and_unique() {
        assert_eq!(
            unique_ids(vec![
                "person-a".into(),
                " person-a ".into(),
                "person-b".into()
            ]),
            vec!["person-a", "person-b"]
        );
    }
}
