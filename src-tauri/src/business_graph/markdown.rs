use super::model::{
    canonical_kind, is_known_kind, is_valid_id, GraphDiagnostic, GraphNode, GraphProvenance,
    GraphRelation, GraphScopeKind, GraphSourceFormat, ISSUE_PRIORITIES, ISSUE_STATUSES,
};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::path::Path;
use thiserror::Error;

const COMMON_FIELDS: &[&str] = &[
    "id",
    "title",
    "type",
    "kind",
    "summary",
    "tags",
    "links",
    "relations",
    "created",
    "created_at",
    "updated",
    "updated_at",
    "body",
];

const ISSUE_FIELDS: &[&str] = &[
    "title",
    "status",
    "priority",
    "dueDate",
    "due_date",
    "project",
    "assignee",
    "labels",
    "tags",
    "waiting_for",
    "waitingFor",
    "snooze_until",
    "snoozeUntil",
    "remind_at",
    "remindAt",
    "deliverables",
    "created",
    "created_at",
    "updated",
    "updated_at",
    "links",
    "relations",
];

#[derive(Debug, Error)]
pub enum GraphMarkdownError {
    #[error("graph source has no Markdown filename: {0}")]
    MissingFileName(String),
    #[error("graph source id is invalid: {0}")]
    InvalidId(String),
    #[error("could not parse YAML frontmatter: {0}")]
    InvalidFrontmatter(String),
    #[error("graph frontmatter must be a YAML object")]
    FrontmatterNotObject,
    #[error("could not serialize graph frontmatter: {0}")]
    SerializeFrontmatter(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedGraphNode {
    pub node: GraphNode,
    pub diagnostics: Vec<GraphDiagnostic>,
}

pub fn parse_graph_markdown(
    path: &Path,
    scope_id: &str,
    scope_kind: GraphScopeKind,
    source_format: GraphSourceFormat,
    raw: &str,
) -> Result<ParsedGraphNode, GraphMarkdownError> {
    let id = path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| GraphMarkdownError::MissingFileName(path.display().to_string()))?
        .to_string();
    if !is_valid_id(&id) {
        return Err(GraphMarkdownError::InvalidId(id));
    }

    let (frontmatter, body) = split_frontmatter(raw);
    let meta = parse_frontmatter(frontmatter)?;
    let source_path = path.to_string_lossy().into_owned();
    let provenance = GraphProvenance {
        scope_id: scope_id.to_string(),
        scope_kind,
        source_path: source_path.clone(),
        source_revision: source_revision(raw),
        source_format,
    };

    let mut parsed = match source_format {
        GraphSourceFormat::Knowledge => parse_knowledge(id, meta, body, provenance),
        GraphSourceFormat::Issue => parse_issue(id, meta, body, provenance),
    };
    validate_node(&mut parsed);
    Ok(parsed)
}

pub fn serialize_graph_markdown(node: &GraphNode) -> Result<String, GraphMarkdownError> {
    let mut meta = Map::new();
    match node.provenance.source_format {
        GraphSourceFormat::Knowledge => serialize_knowledge(node, &mut meta),
        GraphSourceFormat::Issue => serialize_issue(node, &mut meta),
    }
    let mut yaml = serde_yaml::to_string(&Value::Object(meta))
        .map_err(|error| GraphMarkdownError::SerializeFrontmatter(error.to_string()))?;
    if let Some(without_marker) = yaml.strip_prefix("---\n") {
        yaml = without_marker.to_string();
    }
    Ok(format!("---\n{}---\n{}", yaml, node.body))
}

pub fn source_revision(raw: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(raw.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn serialize_knowledge(node: &GraphNode, meta: &mut Map<String, Value>) {
    meta.insert("title".into(), Value::String(node.title.clone()));
    meta.insert("type".into(), Value::String(node.kind.clone()));
    if !node.summary.is_empty() {
        meta.insert("summary".into(), Value::String(node.summary.clone()));
    }
    if !node.tags.is_empty() {
        meta.insert(
            "tags".into(),
            Value::Array(node.tags.iter().cloned().map(Value::String).collect()),
        );
    }
    insert_relations(node, meta);
    for (key, value) in &node.properties {
        if !COMMON_FIELDS.contains(&key.as_str()) {
            meta.insert(key.clone(), value.clone());
        }
    }
    if !node.created_at.is_empty() {
        meta.insert("created".into(), Value::String(node.created_at.clone()));
    }
    if !node.updated_at.is_empty() {
        meta.insert("updated".into(), Value::String(node.updated_at.clone()));
    }
}

fn serialize_issue(node: &GraphNode, meta: &mut Map<String, Value>) {
    meta.insert("title".into(), Value::String(node.title.clone()));
    meta.insert(
        "status".into(),
        Value::String(node.status().unwrap_or("backlog").to_string()),
    );
    meta.insert(
        "priority".into(),
        Value::String(node.priority().unwrap_or("normal").to_string()),
    );
    copy_property(node, meta, "dueDate", "dueDate");
    copy_property(node, meta, "legacyProject", "project");
    copy_property(node, meta, "legacyAssignee", "assignee");
    copy_property(node, meta, "labels", "labels");
    copy_property(node, meta, "waitingFor", "waiting_for");
    copy_property(node, meta, "snoozeUntil", "snooze_until");
    copy_property(node, meta, "remindAt", "remind_at");
    copy_property(node, meta, "deliverables", "deliverables");
    insert_relations(node, meta);
    for (key, value) in &node.properties {
        if ![
            "status",
            "priority",
            "dueDate",
            "legacyProject",
            "legacyAssignee",
            "labels",
            "waitingFor",
            "snoozeUntil",
            "remindAt",
            "deliverables",
        ]
        .contains(&key.as_str())
            && !ISSUE_FIELDS.contains(&key.as_str())
        {
            meta.insert(key.clone(), value.clone());
        }
    }
    if !node.created_at.is_empty() {
        meta.insert("created".into(), Value::String(node.created_at.clone()));
    }
    if !node.updated_at.is_empty() {
        meta.insert("updated".into(), Value::String(node.updated_at.clone()));
    }
}

fn insert_relations(node: &GraphNode, meta: &mut Map<String, Value>) {
    let relations = node
        .relations
        .iter()
        .filter(|relation| {
            !(node.kind == "issue"
                && relation.legacy
                && relation.relation == "part_of"
                && node.properties.get("legacyProject").and_then(Value::as_str)
                    == Some(relation.target.as_str()))
        })
        .map(|relation| {
            serde_json::json!({
                "relation": relation.relation,
                "target": relation.target,
            })
        })
        .collect::<Vec<_>>();
    if !relations.is_empty() {
        meta.insert("links".into(), Value::Array(relations));
    }
}

fn copy_property(
    node: &GraphNode,
    meta: &mut Map<String, Value>,
    property: &str,
    frontmatter: &str,
) {
    if let Some(value) = node.properties.get(property) {
        meta.insert(frontmatter.into(), value.clone());
    }
}

fn parse_knowledge(
    id: String,
    mut meta: Map<String, Value>,
    body: String,
    provenance: GraphProvenance,
) -> ParsedGraphNode {
    let kind_raw = string_field(&meta, "type")
        .or_else(|| string_field(&meta, "kind"))
        .unwrap_or_else(|| "note".into());
    let kind = canonical_kind(&kind_raw);
    let title = string_field(&meta, "title").unwrap_or_default();
    let summary = string_field(&meta, "summary").unwrap_or_default();
    let tags = string_list(meta.get("tags"));
    let relations = relation_list(meta.get("links").or_else(|| meta.get("relations")));
    let created_at = string_field(&meta, "created")
        .or_else(|| string_field(&meta, "created_at"))
        .unwrap_or_default();
    let updated_at = string_field(&meta, "updated")
        .or_else(|| string_field(&meta, "updated_at"))
        .unwrap_or_default();
    remove_fields(&mut meta, COMMON_FIELDS);

    ParsedGraphNode {
        node: GraphNode {
            id,
            kind,
            title,
            summary,
            body,
            tags,
            relations,
            properties: meta,
            created_at,
            updated_at,
            provenance,
        },
        diagnostics: Vec::new(),
    }
}

fn parse_issue(
    id: String,
    mut meta: Map<String, Value>,
    body: String,
    provenance: GraphProvenance,
) -> ParsedGraphNode {
    let title = string_field(&meta, "title").unwrap_or_default();
    let status = string_field(&meta, "status").unwrap_or_else(|| "backlog".into());
    let priority = string_field(&meta, "priority").unwrap_or_else(|| "normal".into());
    let labels = normalize_labels(meta.get("labels"), meta.get("tags"));
    let tags = labels
        .iter()
        .filter_map(|label| label.get("name").and_then(Value::as_str))
        .map(str::to_string)
        .collect();
    let mut relations = relation_list(meta.get("links").or_else(|| meta.get("relations")));
    let legacy_project = string_field(&meta, "project").unwrap_or_default();
    if is_valid_id(&legacy_project) && legacy_project.starts_with("project-") {
        relations.push(GraphRelation {
            relation: "part_of".into(),
            target: legacy_project.clone(),
            legacy: true,
        });
    }

    let created_at = string_field(&meta, "created")
        .or_else(|| string_field(&meta, "created_at"))
        .unwrap_or_default();
    let updated_at = string_field(&meta, "updated")
        .or_else(|| string_field(&meta, "updated_at"))
        .unwrap_or_default();

    let mut properties = Map::new();
    properties.insert("status".into(), Value::String(status));
    properties.insert("priority".into(), Value::String(priority));
    if !labels.is_empty() {
        properties.insert("labels".into(), Value::Array(labels));
    }
    copy_string_property(&meta, &mut properties, &["dueDate", "due_date"], "dueDate");
    copy_string_property(
        &meta,
        &mut properties,
        &["waitingFor", "waiting_for"],
        "waitingFor",
    );
    copy_string_property(
        &meta,
        &mut properties,
        &["snoozeUntil", "snooze_until"],
        "snoozeUntil",
    );
    copy_string_property(
        &meta,
        &mut properties,
        &["remindAt", "remind_at"],
        "remindAt",
    );
    copy_string_property(&meta, &mut properties, &["assignee"], "legacyAssignee");
    copy_string_property(&meta, &mut properties, &["project"], "legacyProject");
    if let Some(deliverables) = meta.get("deliverables") {
        properties.insert("deliverables".into(), deliverables.clone());
    }

    remove_fields(&mut meta, ISSUE_FIELDS);
    properties.extend(meta);

    ParsedGraphNode {
        node: GraphNode {
            id,
            kind: "issue".into(),
            title,
            summary: String::new(),
            body,
            tags,
            relations,
            properties,
            created_at,
            updated_at,
            provenance,
        },
        diagnostics: Vec::new(),
    }
}

fn validate_node(parsed: &mut ParsedGraphNode) {
    let node = &parsed.node;
    let source_path = Some(node.provenance.source_path.clone());
    if node.title.trim().is_empty() {
        parsed.diagnostics.push(GraphDiagnostic::warning(
            "missing-title",
            format!("Graph node '{}' has no title.", node.id),
            Some(node.id.clone()),
            source_path.clone(),
        ));
    }
    if !is_known_kind(&node.kind) {
        parsed.diagnostics.push(GraphDiagnostic::warning(
            "unknown-kind",
            format!(
                "Graph node '{}' uses unsupported kind '{}'. It remains readable but cannot be created through ontology v1 tools.",
                node.id, node.kind
            ),
            Some(node.id.clone()),
            source_path.clone(),
        ));
    }
    if node.kind == "issue" {
        if let Some(status) = node.status() {
            if !ISSUE_STATUSES.contains(&status) {
                parsed.diagnostics.push(GraphDiagnostic::warning(
                    "invalid-issue-status",
                    format!("Issue '{}' uses unsupported status '{}'.", node.id, status),
                    Some(node.id.clone()),
                    source_path.clone(),
                ));
            }
        }
        if let Some(priority) = node.priority() {
            if !ISSUE_PRIORITIES.contains(&priority) {
                parsed.diagnostics.push(GraphDiagnostic::warning(
                    "invalid-issue-priority",
                    format!(
                        "Issue '{}' uses unsupported priority '{}'.",
                        node.id, priority
                    ),
                    Some(node.id.clone()),
                    source_path,
                ));
            }
        }
    }
}

fn split_frontmatter(raw: &str) -> (&str, String) {
    let mut lines = raw.split_inclusive('\n');
    let Some(first) = lines.next() else {
        return ("", String::new());
    };
    if first.trim() != "---" {
        return ("", raw.to_string());
    }

    let frontmatter_start = first.len();
    let mut cursor = frontmatter_start;
    for line in lines {
        if line.trim() == "---" {
            let body_start = cursor + line.len();
            return (
                &raw[frontmatter_start..cursor],
                raw[body_start..].to_string(),
            );
        }
        cursor += line.len();
    }
    ("", raw.to_string())
}

fn parse_frontmatter(raw: &str) -> Result<Map<String, Value>, GraphMarkdownError> {
    if raw.trim().is_empty() {
        return Ok(Map::new());
    }
    let value: Value = serde_yaml::from_str(raw)
        .map_err(|error| GraphMarkdownError::InvalidFrontmatter(error.to_string()))?;
    value
        .as_object()
        .cloned()
        .ok_or(GraphMarkdownError::FrontmatterNotObject)
}

fn string_field(meta: &Map<String, Value>, key: &str) -> Option<String> {
    meta.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn string_list(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.as_str().map(str::trim))
            .filter(|item| !item.is_empty())
            .map(str::to_string)
            .collect(),
        Some(Value::String(value)) => value
            .split([',', '\n'])
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

fn relation_list(value: Option<&Value>) -> Vec<GraphRelation> {
    let items = match value {
        Some(Value::Array(items)) => items.as_slice(),
        _ => return Vec::new(),
    };
    items
        .iter()
        .filter_map(|item| match item {
            Value::String(value) => {
                let mut parts = value.split_whitespace();
                let relation = parts.next()?;
                let target = parts.next()?;
                Some(GraphRelation {
                    relation: relation.to_string(),
                    target: target.to_string(),
                    legacy: true,
                })
            }
            Value::Object(value) => {
                let relation = value
                    .get("relation")
                    .or_else(|| value.get("rel"))
                    .and_then(Value::as_str)?;
                let target = value.get("target").and_then(Value::as_str)?;
                Some(GraphRelation {
                    relation: relation.trim().to_string(),
                    target: target.trim().to_string(),
                    legacy: false,
                })
            }
            _ => None,
        })
        .filter(|relation| !relation.relation.is_empty() && is_valid_id(&relation.target))
        .collect()
}

fn normalize_labels(labels: Option<&Value>, tags: Option<&Value>) -> Vec<Value> {
    let mut normalized = Vec::new();
    if let Some(Value::Array(items)) = labels {
        for item in items {
            match item {
                Value::Object(label) if label.get("name").and_then(Value::as_str).is_some() => {
                    let mut value = label.clone();
                    value
                        .entry("color")
                        .or_insert_with(|| Value::String("gray".into()));
                    normalized.push(Value::Object(value));
                }
                Value::String(name) if !name.trim().is_empty() => {
                    normalized.push(serde_json::json!({
                        "name": name.trim(),
                        "color": "gray",
                    }));
                }
                _ => {}
            }
        }
    }
    if normalized.is_empty() {
        for name in string_list(tags) {
            normalized.push(serde_json::json!({ "name": name, "color": "gray" }));
        }
    }
    normalized
}

fn copy_string_property(
    source: &Map<String, Value>,
    destination: &mut Map<String, Value>,
    source_keys: &[&str],
    destination_key: &str,
) {
    if let Some(value) = source_keys.iter().find_map(|key| string_field(source, key)) {
        destination.insert(destination_key.into(), Value::String(value));
    }
}

fn remove_fields(meta: &mut Map<String, Value>, fields: &[&str]) {
    for field in fields {
        meta.remove(*field);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn parse(source_format: GraphSourceFormat, raw: &str) -> ParsedGraphNode {
        let path = match source_format {
            GraphSourceFormat::Knowledge => PathBuf::from("/work/knowledge/eversana.md"),
            GraphSourceFormat::Issue => PathBuf::from("/work/issues/issue-1784943918-d4c5.md"),
        };
        parse_graph_markdown(
            &path,
            "project:work",
            GraphScopeKind::Project,
            source_format,
            raw,
        )
        .unwrap()
    }

    #[test]
    fn parses_legacy_knowledge_and_preserves_business_properties() {
        let parsed = parse(
            GraphSourceFormat::Knowledge,
            r#"---
title: "EVERSANA"
type: org
summary: "Global HEOR services organization."
tags: [heor, client]
links:
  - "has_contact nicole-ferko"
kind_of_company: "client"
created: "2026-06-24T09:11:18.664Z"
updated: "2026-06-25T09:11:18.664Z"
---
Durable body.
"#,
        );

        assert_eq!(parsed.node.id, "eversana");
        assert_eq!(parsed.node.kind, "company");
        assert_eq!(parsed.node.tags, ["heor", "client"]);
        assert_eq!(parsed.node.body, "Durable body.\n");
        assert_eq!(
            parsed.node.properties["kind_of_company"],
            Value::String("client".into())
        );
        assert_eq!(
            parsed.node.relations,
            [GraphRelation {
                relation: "has_contact".into(),
                target: "nicole-ferko".into(),
                legacy: true,
            }]
        );
        assert!(parsed.diagnostics.is_empty());
        assert_eq!(parsed.node.provenance.source_revision.len(), 64);
    }

    #[test]
    fn parses_legacy_issue_fields_and_derives_a_project_relation() {
        let parsed = parse(
            GraphSourceFormat::Issue,
            r#"---
title: "HEOR evidence map"
status: "in-progress"
priority: "urgent"
project: "project-eversana"
assignee: "Nicole Ferko"
labels:
  - name: "heor"
    color: "blue"
waiting_for: "Client evidence package"
deliverables:
  - path: "analysis/evidence-map.md"
created: "2026-07-25T01:45:18.000Z"
updated: "2026-07-25T02:45:18.000Z"
---
## Objective

Build the map.
"#,
        );

        assert_eq!(parsed.node.kind, "issue");
        assert_eq!(parsed.node.status(), Some("in-progress"));
        assert_eq!(parsed.node.priority(), Some("urgent"));
        assert_eq!(parsed.node.tags, ["heor"]);
        assert_eq!(
            parsed.node.properties["legacyAssignee"],
            Value::String("Nicole Ferko".into())
        );
        assert_eq!(
            parsed.node.relations,
            [GraphRelation {
                relation: "part_of".into(),
                target: "project-eversana".into(),
                legacy: true,
            }]
        );
        assert!(parsed.diagnostics.is_empty());
    }

    #[test]
    fn diagnoses_unknown_kinds_and_invalid_issue_enums_without_hiding_nodes() {
        let unknown = parse(
            GraphSourceFormat::Knowledge,
            "---\ntitle: Odd\nkind: anything-goes\n---\n",
        );
        assert_eq!(unknown.node.kind, "anything-goes");
        assert_eq!(unknown.diagnostics[0].code, "unknown-kind");

        let issue = parse(
            GraphSourceFormat::Issue,
            "---\ntitle: Odd issue\nstatus: someday\npriority: massive\n---\n",
        );
        assert_eq!(issue.diagnostics.len(), 2);
        assert_eq!(issue.diagnostics[0].code, "invalid-issue-status");
        assert_eq!(issue.diagnostics[1].code, "invalid-issue-priority");
    }

    #[test]
    fn treats_markdown_without_frontmatter_as_a_readable_node() {
        let parsed = parse(GraphSourceFormat::Knowledge, "# Untitled knowledge\n");
        assert_eq!(parsed.node.body, "# Untitled knowledge\n");
        assert_eq!(parsed.node.kind, "note");
        assert_eq!(parsed.diagnostics[0].code, "missing-title");
    }

    #[test]
    fn serializes_knowledge_without_losing_unknown_properties_or_relations() {
        let mut parsed = parse(
            GraphSourceFormat::Knowledge,
            "---\ntitle: EVERSANA\ntype: org\nkind_of_company: client\nlinks:\n  - \"has_contact nicole-ferko\"\n---\nBody.",
        );
        parsed.node.title = "EVERSANA Health".into();
        let serialized = serialize_graph_markdown(&parsed.node).unwrap();
        let reparsed = parse(GraphSourceFormat::Knowledge, &serialized);
        assert_eq!(reparsed.node.kind, "company");
        assert_eq!(reparsed.node.title, "EVERSANA Health");
        assert_eq!(
            reparsed.node.properties["kind_of_company"],
            Value::String("client".into())
        );
        assert_eq!(
            reparsed
                .node
                .relations
                .iter()
                .map(|relation| (&relation.relation, &relation.target))
                .collect::<Vec<_>>(),
            parsed
                .node
                .relations
                .iter()
                .map(|relation| (&relation.relation, &relation.target))
                .collect::<Vec<_>>()
        );
        assert!(!reparsed.node.relations[0].legacy);
        assert_eq!(reparsed.node.body, "Body.");
    }

    #[test]
    fn serializes_issues_in_a_legacy_compatible_shape() {
        let parsed = parse(
            GraphSourceFormat::Issue,
            "---\ntitle: Evidence map\nstatus: plan\npriority: high\nproject: project-eversana\nassignee: Nicole\nwaiting_for: Evidence\n---\nBody.",
        );
        let serialized = serialize_graph_markdown(&parsed.node).unwrap();
        assert!(serialized.contains("project: project-eversana"));
        assert!(serialized.contains("assignee: Nicole"));
        assert!(serialized.contains("waiting_for: Evidence"));
        assert!(!serialized.contains("relation: part_of"));
        let reparsed = parse(GraphSourceFormat::Issue, &serialized);
        assert_eq!(reparsed.node.status(), Some("plan"));
        assert_eq!(
            reparsed.node.properties["legacyProject"],
            "project-eversana"
        );
    }
}
