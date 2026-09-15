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

// These fields carry workflow meaning that a general note does not have. Keep
// this narrower than ISSUE_FIELDS: title, tags, timestamps, and relations are
// valid on every graph node and must not turn a kindless note into an issue.
const ISSUE_DISCRIMINATOR_FIELDS: &[&str] = &[
    "status",
    "priority",
    "dueDate",
    "due_date",
    "waiting_for",
    "waitingFor",
    "snooze_until",
    "snoozeUntil",
    "remind_at",
    "remindAt",
    "deliverables",
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
    let body = body.to_string();
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
        GraphSourceFormat::Graph => {
            let explicit_kind = string_field(&meta, "kind")
                .or_else(|| string_field(&meta, "type"))
                .map(|kind| canonical_kind(&kind));
            let looks_like_issue = explicit_kind.as_deref() == Some("issue")
                || (explicit_kind.is_none()
                    && ISSUE_DISCRIMINATOR_FIELDS
                        .iter()
                        .any(|field| meta.contains_key(*field)));
            let mut parsed = if looks_like_issue {
                parse_issue(id, meta, body, provenance)
            } else {
                parse_knowledge(id, meta, body, provenance)
            };
            parsed.node.provenance.source_format = GraphSourceFormat::Graph;
            parsed
        }
        GraphSourceFormat::Knowledge => parse_knowledge(id, meta, body, provenance),
        GraphSourceFormat::Issue => parse_issue(id, meta, body, provenance),
    };
    validate_node(&mut parsed);
    Ok(parsed)
}

pub fn serialize_graph_markdown(node: &GraphNode) -> Result<String, GraphMarkdownError> {
    let mut meta = Map::new();
    match node.provenance.source_format {
        GraphSourceFormat::Graph => serialize_graph(node, &mut meta),
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

fn serialize_graph(node: &GraphNode, meta: &mut Map<String, Value>) {
    meta.insert("kind".into(), Value::String(node.kind.clone()));
    meta.insert("title".into(), Value::String(node.title.clone()));
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
            !(node.provenance.source_format == GraphSourceFormat::Issue
                && node.kind == "issue"
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
    let summary = string_field(&meta, "summary").unwrap_or_default();
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
    remove_fields(&mut meta, COMMON_FIELDS);
    properties.extend(meta);

    ParsedGraphNode {
        node: GraphNode {
            id,
            kind: "issue".into(),
            title,
            summary,
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
    for problem in super::timesheet::problems(node) {
        parsed.diagnostics.push(GraphDiagnostic::warning(
            "invalid-timesheet",
            problem,
            Some(node.id.clone()),
            source_path.clone(),
        ));
    }
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

/// True for a frontmatter delimiter line: an UNINDENTED `---`, allowing only
/// trailing whitespace (which keeps CRLF files working — `trim_end` eats the
/// `\r`). Indented `---` lines must NOT match: serde_yaml writes multi-line
/// string values as literal block scalars whose content lines are always
/// indented, so `  ---` can be legitimate frontmatter *content*. Matching it
/// (the old `line.trim() == "---"`) truncated the frontmatter mid-value and
/// silently corrupted the node on reload.
///
/// The serializer can never emit a bare column-zero `---` inside the
/// frontmatter mapping: key lines carry a `:`, sequence items render as
/// `- item`, block-scalar content is indented, and the only document marker
/// serde_yaml emits is the leading `---\n` that `serialize_graph_markdown`
/// strips. This is pinned empirically by
/// `frontmatter_value_with_dash_line_roundtrips` and the round-trip property
/// tests, whose generators produce `---` lines inside values.
fn is_frontmatter_delimiter(line: &str) -> bool {
    line.trim_end() == "---"
}

pub(super) fn split_frontmatter(raw: &str) -> (&str, &str) {
    let mut lines = raw.split_inclusive('\n');
    let Some(first) = lines.next() else {
        return ("", "");
    };
    if !is_frontmatter_delimiter(first) {
        return ("", raw);
    }

    let frontmatter_start = first.len();
    let mut cursor = frontmatter_start;
    for line in lines {
        if is_frontmatter_delimiter(line) {
            let body_start = cursor + line.len();
            return (&raw[frontmatter_start..cursor], &raw[body_start..]);
        }
        cursor += line.len();
    }
    ("", raw)
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
            GraphSourceFormat::Graph => PathBuf::from("/work/graph/eversana.md"),
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
    fn unified_graph_infers_a_migrated_issue_without_rewriting_it() {
        let parsed = parse(
            GraphSourceFormat::Graph,
            r#"---
title: "Evidence review"
status: review
priority: high
project: project-atlas
assignee: person-alex
---
Check the extraction grid.
"#,
        );

        assert_eq!(parsed.node.kind, "issue");
        assert_eq!(parsed.node.status(), Some("review"));
        assert_eq!(parsed.node.priority(), Some("high"));
        assert_eq!(
            parsed.node.provenance.source_format,
            GraphSourceFormat::Graph
        );
        let serialized = serialize_graph_markdown(&parsed.node).unwrap();
        assert!(serialized.contains("kind: issue"));
        assert!(serialized.contains("status: review"));
        assert!(serialized.contains("legacyProject: project-atlas"));
        let reparsed = parse(GraphSourceFormat::Graph, &serialized);
        assert_eq!(reparsed.node.status(), Some("review"));
        assert_eq!(reparsed.node.priority(), Some("high"));
        assert_eq!(
            reparsed.node.properties["legacyAssignee"],
            Value::String("person-alex".into())
        );
        assert!(reparsed
            .node
            .relations
            .iter()
            .any(|relation| relation.relation == "part_of" && relation.target == "project-atlas"));
    }

    #[test]
    fn unified_graph_defaults_kindless_general_metadata_to_note() {
        let parsed = parse(
            GraphSourceFormat::Graph,
            r#"---
title: "Working context"
tags: [research, draft]
created: 2026-08-16T10:00:00Z
updated: 2026-08-16T11:00:00Z
---
Capture the useful context without forcing an ontology choice.
"#,
        );

        assert_eq!(parsed.node.kind, "note");
        assert!(parsed.diagnostics.is_empty());
        let serialized = serialize_graph_markdown(&parsed.node).unwrap();
        assert!(serialized.contains("kind: note"));
    }

    #[test]
    fn unified_graph_preserves_an_explicit_unknown_kind_for_repair() {
        let parsed = parse(
            GraphSourceFormat::Graph,
            "---\ntitle: Experimental\nkind: hypothesis-map\n---\nBody.\n",
        );

        assert_eq!(parsed.node.kind, "hypothesis-map");
        assert_eq!(parsed.diagnostics.len(), 1);
        assert_eq!(parsed.diagnostics[0].code, "unknown-kind");
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
    fn indented_dash_lines_are_frontmatter_content_not_delimiters() {
        let parsed = parse(
            GraphSourceFormat::Knowledge,
            "---\ntitle: |-\n  before\n  ---\n  after\ntype: note\n---\nBody.\n",
        );
        assert_eq!(parsed.node.title, "before\n---\nafter");
        assert_eq!(parsed.node.kind, "note");
        assert_eq!(parsed.node.body, "Body.\n");
    }

    #[test]
    fn closing_delimiter_tolerates_trailing_whitespace_and_crlf() {
        let parsed = parse(
            GraphSourceFormat::Knowledge,
            "---\r\ntitle: Windows\r\ntype: note\r\n---\r\nBody.\r\n",
        );
        assert_eq!(parsed.node.title, "Windows");
        assert_eq!(parsed.node.body, "Body.\r\n");

        let padded = parse(
            GraphSourceFormat::Knowledge,
            "--- \ntitle: Padded\n---  \nBody.\n",
        );
        assert_eq!(padded.node.title, "Padded");
        assert_eq!(padded.node.body, "Body.\n");
    }

    #[test]
    fn indented_closing_delimiter_falls_back_to_body_without_losing_content() {
        // A hand-written file whose only closer is indented no longer parses
        // as frontmatter; the entire raw text is preserved as the body.
        let raw = "---\ntitle: Handmade\n  ---\nBody.\n";
        let parsed = parse(GraphSourceFormat::Knowledge, raw);
        assert_eq!(parsed.node.body, raw);
        assert_eq!(parsed.node.title, "");
        assert!(parsed.node.properties.is_empty());
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

/// Property-based round-trip coverage: Markdown files are the canonical
/// database, so `serialize → parse` must reproduce the node exactly and
/// re-serializing the parsed node must be byte-identical (canonical form).
#[cfg(test)]
mod proptest_roundtrip {
    use super::*;
    use crate::business_graph::model::ENTITY_KINDS;
    use proptest::prelude::*;
    use proptest::test_runner::TestCaseError;

    /// Characters that stress YAML quoting: indicators, quotes, whitespace,
    /// and non-ASCII text.
    const SCALAR_CHARS: &[char] = &[
        'a', 'b', 'z', 'A', 'Z', '0', '9', ' ', ':', '#', '-', '[', ']', '\'', '"', '|', '.', ',',
        '_', '/', '&', '?', '*', '@', '`', '\\', '\t', '<', '>', 'ä', 'ß', 'é', '中', 'λ', '🦀',
        '😀',
    ];

    /// Hand-picked scalars that look like YAML syntax or non-string types.
    const NASTY_SCALARS: &[&str] = &[
        "---",
        "----",
        ": #not-a-comment",
        "- [ ] task",
        "'single' \"double\"",
        "|pipe >fold",
        "  padded  ",
        "true",
        "null",
        "~",
        "0x1f",
        "1e3",
        "-42",
        ".inf",
        "{flow}",
        "[seq]",
        "a: b",
        "🦀 emoji ünïcode 中文",
    ];

    /// Keys the issue serializer maps to dedicated frontmatter fields; custom
    /// properties must avoid them (as well as the schema field lists).
    const RESERVED_PROPERTY_KEYS: &[&str] = &[
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
    ];

    fn config() -> ProptestConfig {
        ProptestConfig {
            // Small fixed default keeps the suite fast; CI can raise it via
            // the standard PROPTEST_CASES environment variable.
            cases: std::env::var("PROPTEST_CASES")
                .ok()
                .and_then(|cases| cases.parse().ok())
                .unwrap_or(64),
            // Never write failure-seed files into the source tree; a failing
            // seed is printed and can be replayed by hand.
            failure_persistence: None,
            ..ProptestConfig::default()
        }
    }

    fn single_line() -> impl Strategy<Value = String> {
        prop_oneof![
            4 => prop::collection::vec(prop::sample::select(SCALAR_CHARS), 0..20)
                .prop_map(|chars| chars.into_iter().collect()),
            1 => prop::sample::select(NASTY_SCALARS).prop_map(str::to_string),
        ]
    }

    /// Free-form frontmatter string value: possibly multi-line, possibly with
    /// leading/trailing whitespace or a trailing newline. Multi-line values
    /// containing `---` lines are deliberately generated: serde_yaml emits
    /// them as indented block-scalar content, which `split_frontmatter` must
    /// not mistake for the closing delimiter.
    fn frontmatter_text() -> impl Strategy<Value = String> {
        (prop::collection::vec(single_line(), 1..3), any::<bool>()).prop_map(
            |(lines, trailing_newline)| {
                let mut text = lines.join("\n");
                if trailing_newline {
                    text.push('\n');
                }
                text
            },
        )
    }

    /// For fields read back through `string_field`, which trims: generated
    /// values must be trim-stable or they cannot round-trip.
    fn trimmed_text() -> impl Strategy<Value = String> {
        frontmatter_text().prop_map(|text| text.trim().to_string())
    }

    /// `string_field` also drops empty values, so optional fields must be
    /// non-empty when present.
    fn nonempty_trimmed_text() -> impl Strategy<Value = String> {
        trimmed_text().prop_map(|text| if text.is_empty() { "x".into() } else { text })
    }

    /// Slugs accepted by `is_valid_id` (relation targets and node ids).
    fn graph_id() -> impl Strategy<Value = String> {
        "[a-z0-9][a-z0-9-]{0,16}[a-z0-9]"
    }

    fn timestamp() -> impl Strategy<Value = String> {
        (2000u32..2100u32, 1u32..13u32, 1u32..29u32, 0u32..86400u32).prop_map(
            |(year, month, day, second)| {
                format!(
                    "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.000Z",
                    second / 3600,
                    (second / 60) % 60,
                    second % 60
                )
            },
        )
    }

    /// Empty timestamps are legal: serialize omits the field, parse defaults
    /// the model field to "".
    fn optional_timestamp() -> impl Strategy<Value = String> {
        prop_oneof![1 => Just(String::new()), 3 => timestamp()]
    }

    /// Kinds must be `canonical_kind` fixed points (lowercase, no org alias,
    /// non-empty); unknown kinds only warn and must still round-trip.
    fn knowledge_kind() -> impl Strategy<Value = String> {
        prop_oneof![
            4 => prop::sample::select(ENTITY_KINDS).prop_map(str::to_string),
            1 => "[a-z][a-z-]{0,10}[a-z]"
                .prop_filter("kind must be canonical", |kind| canonical_kind(kind) == *kind),
        ]
    }

    /// Generated relations are always `legacy: false`: the object form in
    /// `links` parses as non-legacy, so a `legacy: true` flag cannot survive
    /// (issue project relations are derived separately in `issue_node`).
    fn relation() -> impl Strategy<Value = GraphRelation> {
        (
            prop_oneof![
                3 => prop::sample::select(
                    &["part_of", "depends_on", "references", "related_to", "has_contact", "assigned_to"][..],
                )
                .prop_map(str::to_string),
                1 => "[a-z][a-z_]{0,14}",
            ],
            graph_id(),
        )
            .prop_map(|(relation, target)| GraphRelation {
                relation,
                target,
                legacy: false,
            })
    }

    fn custom_key() -> impl Strategy<Value = String> {
        "[a-z][a-zA-Z0-9_]{0,11}".prop_filter("custom keys must not collide with schema", |key| {
            !COMMON_FIELDS.contains(&key.as_str())
                && !ISSUE_FIELDS.contains(&key.as_str())
                && !RESERVED_PROPERTY_KEYS.contains(&key.as_str())
        })
    }

    /// Business property values are copied verbatim, so anything that
    /// survives YAML is legal. Floats are excluded (not schema-realistic and
    /// their text formatting is not round-trip guaranteed).
    fn custom_value() -> impl Strategy<Value = Value> {
        prop_oneof![
            4 => frontmatter_text().prop_map(Value::String),
            1 => any::<i64>().prop_map(Value::from),
            1 => any::<bool>().prop_map(Value::Bool),
            1 => Just(Value::Null),
            1 => prop::collection::vec(frontmatter_text().prop_map(Value::String), 0..3)
                .prop_map(Value::Array),
            1 => (custom_key(), frontmatter_text())
                .prop_map(|(key, value)| serde_json::json!({ key: value })),
        ]
    }

    fn custom_properties() -> impl Strategy<Value = Map<String, Value>> {
        prop::collection::btree_map(custom_key(), custom_value(), 0..4)
            .prop_map(|properties| properties.into_iter().collect())
    }

    /// Bodies live after the closing delimiter and round-trip verbatim, so
    /// delimiter lines, code fences, and blank lines are all legal here.
    fn body_text() -> impl Strategy<Value = String> {
        (
            prop::collection::vec(
                prop_oneof![
                    3 => single_line(),
                    1 => prop::sample::select(
                        &["---", "```", "```rust", "- [ ] task", "# heading", "  indented", "| a | b |", ""][..],
                    )
                    .prop_map(str::to_string),
                ],
                0..5,
            ),
            any::<bool>(),
        )
            .prop_map(|(lines, trailing_newline)| {
                let mut body = lines.join("\n");
                if trailing_newline {
                    body.push('\n');
                }
                body
            })
    }

    fn provenance_for(id: &str, source_format: GraphSourceFormat) -> GraphProvenance {
        let directory = match source_format {
            GraphSourceFormat::Graph => "graph",
            GraphSourceFormat::Knowledge => "knowledge",
            GraphSourceFormat::Issue => "issues",
        };
        GraphProvenance {
            scope_id: "project:work".into(),
            scope_kind: GraphScopeKind::Project,
            source_path: format!("/work/{directory}/{id}.md"),
            // Patched to the serialized content hash inside `assert_roundtrip`.
            source_revision: String::new(),
            source_format,
        }
    }

    fn knowledge_node() -> impl Strategy<Value = GraphNode> {
        (
            graph_id(),
            knowledge_kind(),
            trimmed_text(),
            trimmed_text(),
            body_text(),
            prop::collection::vec(nonempty_trimmed_text(), 0..4),
            prop::collection::vec(relation(), 0..4),
            custom_properties(),
            (optional_timestamp(), optional_timestamp()),
        )
            .prop_map(
                |(
                    id,
                    kind,
                    title,
                    summary,
                    body,
                    tags,
                    relations,
                    properties,
                    (created_at, updated_at),
                )| {
                    let provenance = provenance_for(&id, GraphSourceFormat::Knowledge);
                    GraphNode {
                        id,
                        kind,
                        title,
                        summary,
                        body,
                        tags,
                        relations,
                        properties,
                        created_at,
                        updated_at,
                        provenance,
                    }
                },
            )
    }

    /// Projects that are `project-` slugs derive a legacy relation on parse;
    /// non-slug projects stay plain `legacyProject` strings.
    fn project_value() -> impl Strategy<Value = String> {
        prop_oneof![
            3 => "[a-z0-9][a-z0-9-]{0,12}[a-z0-9]".prop_map(|slug| format!("project-{slug}")),
            1 => Just("Acme Health GmbH".to_string()),
        ]
    }

    /// Label objects round-trip verbatim as long as `name` is a string and
    /// `color` is present (parse fills a missing color with gray).
    fn issue_label() -> impl Strategy<Value = (String, String)> {
        (
            frontmatter_text(),
            prop::sample::select(&["gray", "blue", "red", "teal"][..]).prop_map(str::to_string),
        )
    }

    fn deliverables_value() -> impl Strategy<Value = Value> {
        prop::collection::vec(
            frontmatter_text().prop_map(|path| serde_json::json!({ "path": path })),
            1..3,
        )
        .prop_map(Value::Array)
    }

    fn issue_node() -> impl Strategy<Value = GraphNode> {
        (
            (
                graph_id(),
                trimmed_text(),
                prop::sample::select(ISSUE_STATUSES).prop_map(str::to_string),
                prop::sample::select(ISSUE_PRIORITIES).prop_map(str::to_string),
            ),
            prop::collection::vec(issue_label(), 0..3),
            prop::option::of(project_value()),
            (
                prop::option::of(timestamp()),
                prop::option::of(nonempty_trimmed_text()),
                prop::option::of(timestamp()),
                prop::option::of(timestamp()),
            ),
            prop::option::of(nonempty_trimmed_text()),
            prop::option::of(deliverables_value()),
            prop::collection::vec(relation(), 0..3),
            custom_properties(),
            body_text(),
            (optional_timestamp(), optional_timestamp()),
        )
            .prop_map(
                |(
                    (id, title, status, priority),
                    labels,
                    project,
                    (due_date, waiting_for, snooze_until, remind_at),
                    assignee,
                    deliverables,
                    mut relations,
                    custom,
                    body,
                    (created_at, updated_at),
                )| {
                    // Mirror `parse_issue`'s property layout exactly.
                    let mut properties = Map::new();
                    properties.insert("status".into(), Value::String(status));
                    properties.insert("priority".into(), Value::String(priority));
                    if !labels.is_empty() {
                        properties.insert(
                            "labels".into(),
                            Value::Array(
                                labels
                                    .iter()
                                    .map(|(name, color)| {
                                        serde_json::json!({ "name": name, "color": color })
                                    })
                                    .collect(),
                            ),
                        );
                    }
                    for (key, value) in [
                        ("dueDate", &due_date),
                        ("waitingFor", &waiting_for),
                        ("snoozeUntil", &snooze_until),
                        ("remindAt", &remind_at),
                        ("legacyAssignee", &assignee),
                        ("legacyProject", &project),
                    ] {
                        if let Some(value) = value {
                            properties.insert(key.into(), Value::String(value.clone()));
                        }
                    }
                    if let Some(deliverables) = deliverables {
                        properties.insert("deliverables".into(), deliverables);
                    }
                    properties.extend(custom);

                    // Parsing derives a trailing legacy `part_of` relation
                    // from a slug-shaped `project:` field, so the generated
                    // node must already carry it to be a fixed point.
                    if let Some(project) = &project {
                        if is_valid_id(project) && project.starts_with("project-") {
                            relations.push(GraphRelation {
                                relation: "part_of".into(),
                                target: project.clone(),
                                legacy: true,
                            });
                        }
                    }

                    let provenance = provenance_for(&id, GraphSourceFormat::Issue);
                    GraphNode {
                        id,
                        kind: "issue".into(),
                        title,
                        // `parse_issue` always resets issue summaries.
                        summary: String::new(),
                        body,
                        // Issue tags are derived from label names on parse.
                        tags: labels.into_iter().map(|(name, _)| name).collect(),
                        relations,
                        properties,
                        created_at,
                        updated_at,
                        provenance,
                    }
                },
            )
    }

    fn assert_roundtrip(node: &GraphNode) -> Result<(), TestCaseError> {
        let serialized = serialize_graph_markdown(node)
            .map_err(|error| TestCaseError::fail(format!("serialize failed: {error}")))?;
        let serialized_again = serialize_graph_markdown(node)
            .map_err(|error| TestCaseError::fail(format!("serialize failed: {error}")))?;
        prop_assert_eq!(
            &serialized,
            &serialized_again,
            "serialize must be deterministic"
        );

        let parsed = parse_graph_markdown(
            Path::new(&node.provenance.source_path),
            &node.provenance.scope_id,
            node.provenance.scope_kind,
            node.provenance.source_format,
            &serialized,
        )
        .map_err(|error| TestCaseError::fail(format!("reparse failed: {error}\n{serialized}")))?;

        // (a) Semantic identity, up to the recomputed content hash.
        let mut expected = node.clone();
        expected.provenance.source_revision = source_revision(&serialized);
        prop_assert_eq!(
            &parsed.node,
            &expected,
            "parse(serialize(node)) must preserve the node\n{}",
            serialized
        );

        // (b) Canonical form: re-serializing the parsed node is byte-stable.
        let reserialized = serialize_graph_markdown(&parsed.node)
            .map_err(|error| TestCaseError::fail(format!("re-serialize failed: {error}")))?;
        prop_assert_eq!(
            &serialized,
            &reserialized,
            "canonical form must be byte-stable"
        );
        Ok(())
    }

    proptest! {
        #![proptest_config(config())]

        #[test]
        fn knowledge_nodes_roundtrip_through_markdown(node in knowledge_node()) {
            assert_roundtrip(&node)?;
        }

        #[test]
        fn issue_nodes_roundtrip_through_markdown(node in issue_node()) {
            assert_roundtrip(&node)?;
        }
    }

    // Regression (found by these property tests): serde_yaml writes
    // multi-line strings as literal block scalars, so a frontmatter value
    // containing a line of exactly `---` is emitted as an indented `---`
    // content line. `split_frontmatter` used to match `line.trim() == "---"`,
    // mistake that content line for the closing delimiter, and truncate the
    // frontmatter — silently corrupting the node on the next load. Fixed by
    // accepting only unindented delimiters.
    #[test]
    fn frontmatter_value_with_dash_line_roundtrips() {
        let node = GraphNode {
            id: "dash-title".into(),
            kind: "note".into(),
            title: "before\n---\nafter".into(),
            summary: String::new(),
            body: "Body.\n".into(),
            tags: Vec::new(),
            relations: Vec::new(),
            properties: Map::new(),
            created_at: String::new(),
            updated_at: String::new(),
            provenance: provenance_for("dash-title", GraphSourceFormat::Knowledge),
        };
        assert_roundtrip(&node).unwrap();
    }
}
