//! The team canvas is one field of a Project, independent of its context body.
use super::markdown::{parse_graph_markdown, serialize_graph_markdown};
use super::{GraphActor, GraphNode, GraphScopeKind, GraphSourceFormat};
use serde_json::{json, Value};
use std::path::Path;

pub(crate) fn canvas(node: &GraphNode) -> &str {
    if node.kind != "project" {
        return "";
    }
    node.properties
        .get("home")
        .and_then(|home| home.get("canvas"))
        .and_then(Value::as_str)
        .unwrap_or("")
}

pub(crate) fn stamp(
    node: &mut GraphNode,
    previous: Option<&Value>,
    actor: &GraphActor,
) -> Result<(), String> {
    if node.kind != "project" {
        return Ok(());
    }
    let Some(home) = node.properties.get_mut("home") else {
        return Ok(());
    };
    let home = home
        .as_object_mut()
        .ok_or("Project home must be an object with a canvas string.")?;
    let text = home
        .get("canvas")
        .and_then(Value::as_str)
        .ok_or("Project home.canvas must be a Markdown string.")?;
    let before = previous
        .and_then(|home| home.get("canvas"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if text != before {
        home.insert(
            "updatedAt".into(),
            json!(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
        );
        home.insert("updatedBy".into(), json!(actor));
    } else {
        // Metadata edits cannot make an unchanged canvas look current.
        for key in ["updatedAt", "updatedBy"] {
            match previous.and_then(|home| home.get(key)) {
                Some(value) => {
                    home.insert(key.into(), value.clone());
                }
                None => {
                    home.remove(key);
                }
            }
        }
    }
    Ok(())
}

/// Merge home separately from all other Project fields. Both Git parents retain
/// competing versions. Unknown properties follow the existing file winner rule.
pub(crate) fn merge_sources(
    path: &Path,
    base: &str,
    local: &str,
    remote: &str,
    remote_wins: bool,
) -> Option<String> {
    let parse = |text| {
        parse_graph_markdown(
            path,
            "merge",
            GraphScopeKind::Team,
            GraphSourceFormat::Graph,
            text,
        )
        .ok()
        .map(|parsed| parsed.node)
    };
    let (base, local, remote) = (parse(base)?, parse(local)?, parse(remote)?);
    if [&base, &local, &remote]
        .iter()
        .any(|node| node.kind != "project")
    {
        return None;
    }
    let home = |node: &GraphNode| node.properties.get("home").cloned();
    let (bh, lh, rh) = (home(&base), home(&local), home(&remote));
    if bh.is_none() && lh.is_none() && rh.is_none() {
        return None;
    }
    let context = |node: &GraphNode| {
        let mut node = node.clone();
        node.properties.remove("home");
        node.updated_at.clear();
        node.provenance.source_revision.clear();
        node
    };
    let mut merged = if context(&local) == context(&base) {
        remote.clone()
    } else if context(&remote) == context(&base) || !remote_wins {
        local.clone()
    } else {
        remote.clone()
    };
    let canvas_time = |home: &Option<Value>| {
        home.as_ref()?
            .get("updatedAt")?
            .as_str()
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
    };
    let remote_canvas_wins = match (canvas_time(&lh), canvas_time(&rh)) {
        (Some(local), Some(remote)) if local != remote => remote > local,
        _ => remote_wins,
    };
    let chosen = if lh == bh {
        rh
    } else if rh == bh || !remote_canvas_wins {
        lh
    } else {
        rh
    };
    match chosen {
        Some(value) => {
            merged.properties.insert("home".into(), value);
        }
        None => {
            merged.properties.remove("home");
        }
    }
    merged.updated_at = local.updated_at.max(remote.updated_at);
    serialize_graph_markdown(&merged).ok()
}

/// A stale Source edit can advance only when the disk change was confined to
/// home, and the source draft did not edit home itself.
pub(crate) fn rebase_context_source(
    path: &Path,
    base: &str,
    draft: &str,
    disk: &str,
) -> Option<String> {
    let parse = |text| {
        parse_graph_markdown(
            path,
            "merge",
            GraphScopeKind::Team,
            GraphSourceFormat::Graph,
            text,
        )
        .ok()
        .map(|parsed| parsed.node)
    };
    let (base_node, draft_node, disk_node) = (parse(base)?, parse(draft)?, parse(disk)?);
    if [&base_node, &draft_node, &disk_node]
        .iter()
        .any(|node| node.kind != "project")
    {
        return None;
    }
    let context = |mut node: GraphNode| {
        node.properties.remove("home");
        node.updated_at.clear();
        node.provenance.source_revision.clear();
        node
    };
    if context(base_node.clone()) != context(disk_node)
        || base_node.properties.get("home") != draft_node.properties.get("home")
    {
        return None;
    }
    merge_sources(path, base, draft, disk, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn source(body: &str, canvas: &str) -> String {
        format!("---\ntype: project\ntitle: Atlas\nhome:\n  canvas: {canvas}\n---\n{body}")
    }
    #[test]
    fn independent_fields_survive_in_either_commit_order() {
        for remote_wins in [false, true] {
            let merged = merge_sources(
                Path::new("atlas.md"),
                &source("Context", "Old"),
                &source("New context", "Old"),
                &source("Context", "New canvas"),
                remote_wins,
            )
            .unwrap();
            assert!(merged.contains("New context"));
            assert!(merged.contains("New canvas"));
        }
    }
    #[test]
    fn competing_canvases_follow_winner_but_keep_independent_context() {
        let merged = merge_sources(
            Path::new("atlas.md"),
            &source("Context", "Old"),
            &source("New context", "Local"),
            &source("Context", "Remote"),
            true,
        )
        .unwrap();
        assert!(merged.contains("New context"));
        assert!(merged.contains("Remote"));
        assert!(!merged.contains("Local"));
    }
}
