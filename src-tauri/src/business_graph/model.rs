use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeSet;
use std::path::PathBuf;

pub const ENTITY_KINDS: &[&str] = &[
    "issue",
    "person",
    "company",
    "project",
    "note",
    "decision",
    "record",
    "study",
    "evidence",
    "dataset",
    "analysis",
    "model",
    "endpoint",
    "publication",
    "submission",
    "research-question",
    "method",
    "client-request",
];

pub const ISSUE_STATUSES: &[&str] = &[
    "backlog",
    "plan",
    "in-progress",
    "waiting",
    "review",
    "done",
    "cancelled",
];

pub const ISSUE_PRIORITIES: &[&str] = &["low", "normal", "high", "urgent"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GraphScopeKind {
    Private,
    Project,
    Team,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphSourceRoot {
    pub scope_id: String,
    pub scope_kind: GraphScopeKind,
    pub root: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphScopeDescriptor {
    pub id: String,
    pub kind: GraphScopeKind,
    pub root: String,
}

impl GraphSourceRoot {
    pub fn new(
        scope_id: impl Into<String>,
        scope_kind: GraphScopeKind,
        root: impl Into<PathBuf>,
    ) -> Self {
        Self {
            scope_id: scope_id.into(),
            scope_kind,
            root: root.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GraphSourceFormat {
    Knowledge,
    Issue,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphProvenance {
    pub scope_id: String,
    pub scope_kind: GraphScopeKind,
    pub source_path: String,
    pub source_revision: String,
    pub source_format: GraphSourceFormat,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphRelation {
    pub relation: String,
    pub target: String,
    #[serde(default)]
    pub legacy: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    pub id: String,
    pub kind: String,
    pub title: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub relations: Vec<GraphRelation>,
    #[serde(default)]
    pub properties: Map<String, Value>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    pub provenance: GraphProvenance,
}

impl GraphNode {
    pub fn status(&self) -> Option<&str> {
        self.properties.get("status").and_then(Value::as_str)
    }

    pub fn priority(&self) -> Option<&str> {
        self.properties.get("priority").and_then(Value::as_str)
    }

    pub fn compact(&self) -> GraphNodeSummary {
        let relation_target = |relation: &str| {
            self.relations
                .iter()
                .find(|edge| edge.relation == relation)
                .map(|edge| edge.target.clone())
        };
        GraphNodeSummary {
            id: self.id.clone(),
            kind: self.kind.clone(),
            title: self.title.clone(),
            summary: self.summary.clone(),
            tags: self.tags.clone(),
            status: self.status().map(str::to_string),
            priority: self.priority().map(str::to_string),
            due_date: self
                .properties
                .get("dueDate")
                .and_then(Value::as_str)
                .map(str::to_string),
            project_id: relation_target("part_of").or_else(|| {
                self.properties
                    .get("legacyProject")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
            }),
            assignee_id: relation_target("assigned_to").or_else(|| {
                self.properties
                    .get("legacyAssignee")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
            }),
            waiting_for: self
                .properties
                .get("waitingFor")
                .and_then(Value::as_str)
                .map(str::to_string),
            remind_at: self
                .properties
                .get("remindAt")
                .and_then(Value::as_str)
                .map(str::to_string),
            snooze_until: self
                .properties
                .get("snoozeUntil")
                .and_then(Value::as_str)
                .map(str::to_string),
            relations: self.relations.clone(),
            updated_at: self.updated_at.clone(),
            scope_id: self.provenance.scope_id.clone(),
            source_revision: self.provenance.source_revision.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNodeSummary {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub summary: String,
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assignee_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub waiting_for: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remind_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snooze_until: Option<String>,
    #[serde(default)]
    pub relations: Vec<GraphRelation>,
    pub updated_at: String,
    pub scope_id: String,
    pub source_revision: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GraphDiagnosticLevel {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphDiagnostic {
    pub level: GraphDiagnosticLevel,
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
}

impl GraphDiagnostic {
    pub fn warning(
        code: impl Into<String>,
        message: impl Into<String>,
        node_id: Option<String>,
        source_path: Option<String>,
    ) -> Self {
        Self {
            level: GraphDiagnosticLevel::Warning,
            code: code.into(),
            message: message.into(),
            node_id,
            source_path,
        }
    }

    pub fn error(
        code: impl Into<String>,
        message: impl Into<String>,
        source_path: Option<String>,
    ) -> Self {
        Self {
            level: GraphDiagnosticLevel::Error,
            code: code.into(),
            message: message.into(),
            node_id: None,
            source_path,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphQuery {
    #[serde(default)]
    pub scope_ids: BTreeSet<String>,
    #[serde(default)]
    pub kinds: BTreeSet<String>,
    #[serde(default)]
    pub tags: BTreeSet<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default)]
    pub offset: usize,
    #[serde(default = "default_query_limit")]
    pub limit: usize,
}

fn default_query_limit() -> usize {
    100
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphQueryResult {
    pub items: Vec<GraphNodeSummary>,
    pub total: usize,
    pub offset: usize,
    pub limit: usize,
    pub graph_revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphSearchResult {
    pub node: GraphNodeSummary,
    pub score: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNodePatch {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relations: Option<Vec<GraphRelation>>,
    #[serde(default)]
    pub set_properties: Map<String, Value>,
    #[serde(default)]
    pub remove_properties: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNodeCreate {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub kind: String,
    pub title: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub relations: Vec<GraphRelation>,
    #[serde(default)]
    pub properties: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNodeDelete {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphDeleteResult {
    pub id: String,
    pub source_path: String,
    pub graph_revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub undo_token: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphRestoreRequest {
    pub undo_token: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNeighbor {
    pub relation: String,
    pub node: GraphNodeSummary,
    pub direction: GraphRelationDirection,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphOpenResult {
    pub scopes: Vec<GraphScopeDescriptor>,
    pub node_count: usize,
    pub diagnostic_count: usize,
    pub graph_revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphChanged {
    pub graph_revision: u64,
    pub node_count: usize,
    pub diagnostic_count: usize,
    #[serde(default)]
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GraphRelationDirection {
    Outgoing,
    Incoming,
}

pub fn canonical_kind(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "" => "note".into(),
        "org" | "organization" => "company".into(),
        other => other.to_string(),
    }
}

pub fn is_known_kind(value: &str) -> bool {
    ENTITY_KINDS.contains(&value)
}

pub fn is_valid_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.is_empty() || bytes.len() > 120 {
        return false;
    }
    if !bytes[0].is_ascii_alphanumeric() || !bytes[bytes.len() - 1].is_ascii_alphanumeric() {
        return false;
    }
    bytes
        .iter()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonicalizes_the_bounded_business_ontology() {
        assert_eq!(canonical_kind("org"), "company");
        assert_eq!(canonical_kind(" Organization "), "company");
        assert_eq!(canonical_kind("PERSON"), "person");
        assert_eq!(canonical_kind(""), "note");
        assert!(is_known_kind("issue"));
        assert!(is_known_kind("evidence"));
        assert!(is_known_kind("research-question"));
        assert!(!is_known_kind("anything-goes"));
    }

    #[test]
    fn validates_stable_slug_ids() {
        assert!(is_valid_id("issue-1784943918-d4c5"));
        assert!(is_valid_id("eversana-engagement"));
        assert!(!is_valid_id(""));
        assert!(!is_valid_id("-private"));
        assert!(!is_valid_id("Has Capitals"));
        assert!(!is_valid_id("path/escape"));
    }
}
