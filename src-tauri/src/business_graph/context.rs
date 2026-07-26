use super::{GraphNode, GraphNodeSummary, GraphQuery, GraphRelation, GraphRuntime, GraphScopeKind};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{BTreeSet, HashSet, VecDeque};

const DEFAULT_CONTEXT_NODES: usize = 12;
const MAX_CONTEXT_NODES: usize = 40;
const MAX_BODY_CHARS_PER_NODE: usize = 2_400;
const MAX_BODY_CHARS_TOTAL: usize = 12_000;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphContextRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focus_id: Option<String>,
    #[serde(default)]
    pub scope_ids: BTreeSet<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_nodes: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphContextPack {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub focus_id: Option<String>,
    pub scope_ids: Vec<String>,
    pub nodes: Vec<GraphContextNode>,
    pub markdown: String,
    pub total_visible_nodes: usize,
    pub omitted_nodes: usize,
    pub sensitive_nodes_redacted: usize,
    pub truncated_bodies: usize,
    pub graph_revision: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphContextNode {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub summary: String,
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<String>,
    pub scope_id: String,
    pub scope_kind: GraphScopeKind,
    pub source_path: String,
    pub source_revision: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body_excerpt: Option<String>,
    #[serde(default)]
    pub relations: Vec<GraphRelation>,
    #[serde(default)]
    pub properties: Map<String, Value>,
    pub redacted: bool,
}

impl GraphRuntime {
    pub fn context(&self, request: GraphContextRequest) -> Result<GraphContextPack, String> {
        let max_nodes = request
            .max_nodes
            .unwrap_or(DEFAULT_CONTEXT_NODES)
            .clamp(1, MAX_CONTEXT_NODES);
        let catalog = self.query(&GraphQuery {
            scope_ids: request.scope_ids.clone(),
            limit: 500,
            ..GraphQuery::default()
        })?;
        let visible_ids = catalog
            .items
            .iter()
            .map(|node| node.id.clone())
            .collect::<HashSet<_>>();
        let selected = select_context_nodes(
            self,
            request.focus_id.as_deref(),
            &request.scope_ids,
            &catalog.items,
            &visible_ids,
            max_nodes,
        )?;

        let mut nodes = Vec::new();
        let mut body_budget = MAX_BODY_CHARS_TOTAL;
        let mut sensitive_nodes_redacted = 0;
        let mut truncated_bodies = 0;
        for id in selected {
            let Some(node) = self.get(&id)? else {
                continue;
            };
            nodes.push(context_node(
                node,
                &visible_ids,
                &mut body_budget,
                &mut sensitive_nodes_redacted,
                &mut truncated_bodies,
            ));
        }
        let status = self.open_result()?;
        let markdown = render_context_markdown(request.focus_id.as_deref(), &nodes);
        Ok(GraphContextPack {
            focus_id: request.focus_id,
            scope_ids: request.scope_ids.into_iter().collect(),
            omitted_nodes: catalog.total.saturating_sub(nodes.len()),
            total_visible_nodes: catalog.total,
            sensitive_nodes_redacted,
            truncated_bodies,
            graph_revision: status.graph_revision,
            nodes,
            markdown,
        })
    }
}

fn select_context_nodes(
    runtime: &GraphRuntime,
    focus_id: Option<&str>,
    scope_ids: &BTreeSet<String>,
    catalog: &[GraphNodeSummary],
    visible_ids: &HashSet<String>,
    limit: usize,
) -> Result<Vec<String>, String> {
    let Some(focus_id) = focus_id.map(str::trim).filter(|id| !id.is_empty()) else {
        return Ok(catalog
            .iter()
            .take(limit)
            .map(|node| node.id.clone())
            .collect());
    };
    if !visible_ids.contains(focus_id) {
        return Err(format!(
            "Graph context focus is missing or outside the selected scopes: {focus_id}"
        ));
    }

    let mut selected = Vec::new();
    let mut visited = HashSet::new();
    let mut queue = VecDeque::from([focus_id.to_string()]);
    while let Some(id) = queue.pop_front() {
        if !visited.insert(id.clone()) {
            continue;
        }
        selected.push(id.clone());
        if selected.len() >= limit {
            break;
        }
        for neighbor in runtime.neighbors(&id, scope_ids)? {
            if visible_ids.contains(&neighbor.node.id) && !visited.contains(&neighbor.node.id) {
                queue.push_back(neighbor.node.id);
            }
        }
    }
    Ok(selected)
}

fn context_node(
    node: GraphNode,
    visible_ids: &HashSet<String>,
    body_budget: &mut usize,
    sensitive_nodes_redacted: &mut usize,
    truncated_bodies: &mut usize,
) -> GraphContextNode {
    let sensitive = node.kind == "record"
        || node
            .properties
            .get("sensitive")
            .and_then(Value::as_bool)
            .unwrap_or(false);
    if sensitive {
        *sensitive_nodes_redacted += 1;
        return GraphContextNode {
            id: node.id,
            kind: node.kind,
            title: "[sensitive record redacted]".into(),
            summary: String::new(),
            tags: Vec::new(),
            status: None,
            priority: None,
            scope_id: node.provenance.scope_id,
            scope_kind: node.provenance.scope_kind,
            source_path: node.provenance.source_path,
            source_revision: node.provenance.source_revision,
            body_excerpt: None,
            relations: Vec::new(),
            properties: Map::new(),
            redacted: true,
        };
    }

    let (body_excerpt, truncated) =
        bounded_excerpt(&node.body, (*body_budget).min(MAX_BODY_CHARS_PER_NODE));
    if truncated {
        *truncated_bodies += 1;
    }
    *body_budget = body_budget.saturating_sub(
        body_excerpt
            .as_deref()
            .map(|body| body.chars().count())
            .unwrap_or_default(),
    );
    let status = node.status().map(str::to_string);
    let priority = node.priority().map(str::to_string);
    GraphContextNode {
        id: node.id,
        kind: node.kind,
        title: node.title,
        summary: node.summary,
        tags: node.tags,
        status,
        priority,
        scope_id: node.provenance.scope_id,
        scope_kind: node.provenance.scope_kind,
        source_path: node.provenance.source_path,
        source_revision: node.provenance.source_revision,
        body_excerpt,
        relations: node
            .relations
            .into_iter()
            .filter(|relation| visible_ids.contains(&relation.target))
            .collect(),
        properties: safe_properties(node.properties),
        redacted: false,
    }
}

fn bounded_excerpt(body: &str, limit: usize) -> (Option<String>, bool) {
    let body = body.trim();
    if body.is_empty() || limit == 0 {
        return (None, !body.is_empty());
    }
    if body.chars().count() <= limit {
        return (Some(body.into()), false);
    }
    let excerpt = body.chars().take(limit).collect::<String>();
    (Some(format!("{}…", excerpt.trim_end())), true)
}

fn safe_properties(properties: Map<String, Value>) -> Map<String, Value> {
    properties
        .into_iter()
        .filter(|(key, _)| !matches!(key.as_str(), "sensitive" | "secret" | "token" | "apiKey"))
        .collect()
}

fn render_context_markdown(focus_id: Option<&str>, nodes: &[GraphContextNode]) -> String {
    let mut output = String::from("# Business graph context\n\n");
    if let Some(focus_id) = focus_id {
        output.push_str(&format!("Focus: `{focus_id}`\n\n"));
    }
    for node in nodes {
        output.push_str(&format!(
            "## {} · {} (`{}`)\n\nScope: `{}` · Source: `{}`\n\n",
            node.kind, node.title, node.id, node.scope_id, node.source_path
        ));
        if node.redacted {
            output.push_str("Sensitive record metadata and contents were redacted.\n\n");
            continue;
        }
        if !node.summary.is_empty() {
            output.push_str(&node.summary);
            output.push_str("\n\n");
        }
        if let Some(body) = &node.body_excerpt {
            output.push_str(body);
            output.push_str("\n\n");
        }
        if !node.relations.is_empty() {
            output.push_str("Relations: ");
            output.push_str(
                &node
                    .relations
                    .iter()
                    .map(|relation| format!("{} → {}", relation.relation, relation.target))
                    .collect::<Vec<_>>()
                    .join("; "),
            );
            output.push_str("\n\n");
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::business_graph::{GraphScopeKind, GraphSourceRoot};
    use std::path::PathBuf;

    fn golden_runtime() -> GraphRuntime {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("business-graph");
        GraphRuntime::from_roots(vec![GraphSourceRoot::new(
            "project:golden",
            GraphScopeKind::Project,
            root,
        )])
    }

    #[test]
    fn builds_bounded_traversal_context_with_provenance() {
        let context = golden_runtime()
            .context(GraphContextRequest {
                focus_id: Some("project-atlas".into()),
                max_nodes: Some(4),
                ..GraphContextRequest::default()
            })
            .unwrap();
        assert_eq!(context.nodes[0].id, "project-atlas");
        assert_eq!(context.nodes.len(), 4);
        assert_eq!(context.nodes[0].scope_id, "project:golden");
        assert!(context.markdown.contains("Business graph context"));
        assert!(context.omitted_nodes > 0);
    }

    #[test]
    fn redacts_sensitive_records_from_agent_ready_context() {
        let context = golden_runtime()
            .context(GraphContextRequest {
                focus_id: Some("record-contract".into()),
                max_nodes: Some(3),
                ..GraphContextRequest::default()
            })
            .unwrap();
        let record = context
            .nodes
            .iter()
            .find(|node| node.id == "record-contract")
            .unwrap();
        assert!(record.redacted);
        assert_eq!(record.title, "[sensitive record redacted]");
        assert!(record.body_excerpt.is_none());
        assert!(record.properties.is_empty());
        assert_eq!(context.sensitive_nodes_redacted, 1);
        assert!(!context.markdown.contains("administrative record"));
    }

    #[test]
    fn rejects_focus_nodes_outside_selected_physical_scopes() {
        let error = golden_runtime()
            .context(GraphContextRequest {
                focus_id: Some("project-atlas".into()),
                scope_ids: BTreeSet::from(["team:main".into()]),
                max_nodes: None,
            })
            .unwrap_err();
        assert!(error.contains("outside the selected scopes"));
    }
}
