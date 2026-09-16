use super::{
    contained_join, controlled_output_exists, publish_immutable_hook_input, read_controlled_json,
    MeetingView, MAX_OUTPUT_BYTES,
};
use crate::business_graph::{GraphNode, GraphRuntime};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE", deny_unknown_fields)]
pub(super) struct SummaryContext {
    title: String,
    you: String,
    them: Vec<String>,
    project: Option<String>,
}

pub(super) fn resolve(
    graph: &GraphRuntime,
    meeting: &MeetingView,
    self_person_id: Option<&str>,
) -> Result<SummaryContext, String> {
    let (title, people_ids, project_id) = if let Some(id) = &meeting.graph_node_id {
        let node = require_node(graph, id, "meeting")?;
        if node
            .properties
            .get("sourceMeetingId")
            .and_then(|id| id.as_str())
            != Some(meeting.id.as_str())
        {
            return Err("This Graph record does not belong to the meeting".into());
        }
        let people = node
            .relations
            .iter()
            .filter(|relation| matches!(relation.relation.as_str(), "attended_by" | "attended-by"))
            .map(|relation| relation.target.clone())
            .collect();
        let project = node
            .relations
            .iter()
            .find(|relation| relation.relation == "part_of")
            .map(|relation| relation.target.clone());
        (node.title, people, project)
    } else {
        (
            meeting.title.clone(),
            meeting.graph_draft.people_ids.clone(),
            meeting.graph_draft.project_id.clone(),
        )
    };
    let you = self_person_id
        .map(|id| graph.get(id))
        .transpose()?
        .flatten()
        .filter(|node| node.kind == "person")
        .map(|node| node.title)
        .unwrap_or_else(|| "recording user".into());
    let mut them = Vec::new();
    for id in people_ids {
        if Some(id.as_str()) == self_person_id {
            continue;
        }
        let name = require_node(graph, &id, "person")?.title;
        if !them.contains(&name) {
            them.push(name);
        }
    }
    let project = project_id
        .map(|id| require_node(graph, &id, "project").map(|node| node.title))
        .transpose()?;
    Ok(SummaryContext {
        title,
        you,
        them,
        project,
    })
}

fn require_node(graph: &GraphRuntime, id: &str, kind: &str) -> Result<GraphNode, String> {
    let node = graph
        .get(id)?
        .ok_or_else(|| format!("Meeting context {kind} '{id}' is not available in Graph"))?;
    if node.kind != kind {
        return Err(format!("Meeting context item '{id}' is not a {kind}"));
    }
    Ok(node)
}

pub(super) fn materialize(
    job_root: &Path,
    load: impl FnOnce() -> Result<SummaryContext, String>,
) -> Result<PathBuf, String> {
    let path = contained_join(job_root, "meeting-context.json")?;
    if controlled_output_exists(&path)? {
        // A retry uses the same metadata snapshot as its first attempt.
        read_controlled_json::<SummaryContext>(&path)?;
    } else {
        let bytes = serde_json::to_vec_pretty(&load()?).map_err(|error| error.to_string())?;
        publish_immutable_hook_input(&path, &bytes, MAX_OUTPUT_BYTES, false)?;
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::business_graph::{GraphNodeCreate, GraphRelation, GraphScopeKind, GraphSourceRoot};
    use serde_json::json;
    use std::fs;
    use tempfile::TempDir;

    fn fixture() -> (TempDir, GraphRuntime, MeetingView) {
        let directory = TempDir::new().unwrap();
        let graph = GraphRuntime::from_roots(vec![GraphSourceRoot::new(
            "private:local",
            GraphScopeKind::Private,
            directory.path(),
        )]);
        for (id, kind, title) in [
            ("person-self", "person", "Paul Schneider"),
            ("person-a", "person", "Ana Smith"),
            ("person-b", "person", "Ben Jones"),
            ("project-a", "project", "Research tools"),
            ("project-b", "project", "Client study"),
        ] {
            graph
                .create(GraphNodeCreate {
                    id: Some(id.into()),
                    kind: kind.into(),
                    title: title.into(),
                    body: "Unrelated record body must not be sent.".into(),
                    ..GraphNodeCreate::default()
                })
                .unwrap();
        }
        let meeting = serde_json::from_value(json!({
            "id": "meeting-1", "title": "Weekly review", "lifecycle": "ready",
            "transcription": "final", "durationMs": 1000, "micMuted": false,
            "gapCount": 0, "transcriptRevision": 7, "transcriptFinal": true,
            "summaryState": "queued",
            "kgState": "not-offered",
            "graphDraft": {
                "projectResolved": true, "projectId": "project-a",
                "peopleIds": ["person-self", "person-a"]
            }
        }))
        .unwrap();
        (directory, graph, meeting)
    }

    #[test]
    fn selected_people_and_project_reach_summary_input_as_names() {
        let (directory, graph, meeting) = fixture();
        let path = materialize(directory.path(), || {
            resolve(&graph, &meeting, Some("person-self"))
        })
        .unwrap();
        let bytes = fs::read_to_string(path).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&bytes).unwrap(),
            json!({
                "TITLE": "Weekly review", "YOU": "Paul Schneider",
                "THEM": ["Ana Smith"], "PROJECT": "Research tools"
            })
        );
        assert!(!bytes.contains("Unrelated record body"));
        assert!(!bytes.contains("person-a"));
    }

    #[test]
    fn filed_meeting_uses_current_graph_context_instead_of_the_old_draft() {
        let (_directory, graph, mut meeting) = fixture();
        let node = graph
            .create(GraphNodeCreate {
                id: Some("filed-meeting".into()),
                kind: "meeting".into(),
                title: "Updated meeting title".into(),
                relations: vec![
                    GraphRelation {
                        relation: "attended_by".into(),
                        target: "person-b".into(),
                        legacy: false,
                    },
                    GraphRelation {
                        relation: "part_of".into(),
                        target: "project-b".into(),
                        legacy: false,
                    },
                ],
                properties: serde_json::from_value(json!({"sourceMeetingId": meeting.id})).unwrap(),
                ..GraphNodeCreate::default()
            })
            .unwrap();
        meeting.graph_node_id = Some(node.id);
        let context = resolve(&graph, &meeting, Some("person-self")).unwrap();
        assert_eq!(context.title, "Updated meeting title");
        assert_eq!(context.them, ["Ben Jones"]);
        assert_eq!(context.project.as_deref(), Some("Client study"));

        meeting.id = "different-source".into();
        assert!(resolve(&graph, &meeting, None)
            .unwrap_err()
            .contains("does not belong"));
    }

    #[test]
    fn multiple_or_missing_selections_are_explicit() {
        let (_directory, graph, mut meeting) = fixture();
        meeting.graph_draft.people_ids = vec!["person-a".into(), "person-b".into()];
        let context = resolve(&graph, &meeting, None).unwrap();
        assert_eq!(context.them, ["Ana Smith", "Ben Jones"]);
        assert_eq!(context.you, "recording user");

        meeting.graph_draft.people_ids.clear();
        meeting.graph_draft.project_id = None;
        let context = resolve(&graph, &meeting, None).unwrap();
        assert!(context.them.is_empty());
        assert!(context.project.is_none());

        meeting.graph_draft.people_ids = vec!["missing-person".into()];
        assert!(resolve(&graph, &meeting, None)
            .unwrap_err()
            .contains("not available"));
        meeting.graph_draft.people_ids = vec!["project-a".into()];
        assert!(resolve(&graph, &meeting, None)
            .unwrap_err()
            .contains("not a person"));
    }

    #[test]
    fn retry_keeps_context_snapshot_and_new_generation_reads_new_selection() {
        let (directory, graph, mut meeting) = fixture();
        let path = materialize(directory.path(), || resolve(&graph, &meeting, None)).unwrap();
        let before = fs::read(&path).unwrap();
        meeting.graph_draft.people_ids = vec!["person-b".into()];
        materialize(directory.path(), || {
            panic!("retry must use its frozen context")
        })
        .unwrap();
        assert_eq!(fs::read(path).unwrap(), before);

        let next_job = TempDir::new().unwrap();
        let next = materialize(next_job.path(), || resolve(&graph, &meeting, None)).unwrap();
        assert_eq!(
            read_controlled_json::<SummaryContext>(&next).unwrap().them,
            ["Ben Jones"]
        );
    }

    #[cfg(unix)]
    #[test]
    fn context_snapshot_rejects_symlinks() {
        let directory = TempDir::new().unwrap();
        let outside = directory.path().join("outside.json");
        fs::write(&outside, b"{}").unwrap();
        std::os::unix::fs::symlink(&outside, directory.path().join("meeting-context.json"))
            .unwrap();
        assert!(materialize(directory.path(), || panic!(
            "unsafe input must not be replaced"
        ))
        .is_err());
        assert_eq!(fs::read(outside).unwrap(), b"{}");
    }
}
