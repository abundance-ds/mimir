use super::{
    parse_graph_markdown, GraphDiagnostic, GraphDiagnosticLevel, GraphNode, GraphScopeKind,
    GraphSourceFormat, GraphSourceRoot,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphMigrationReport {
    pub dry_run: bool,
    pub source_count: usize,
    pub parsed_count: usize,
    pub knowledge_count: usize,
    pub issue_count: usize,
    pub kind_counts: BTreeMap<String, usize>,
    pub alias_counts: BTreeMap<String, usize>,
    pub scopes: Vec<GraphMigrationScope>,
    pub collisions: Vec<GraphMigrationCollision>,
    pub legacy_references: Vec<GraphMigrationReference>,
    pub diagnostics: Vec<GraphDiagnostic>,
    pub ready_for_cutover: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphMigrationScope {
    pub id: String,
    pub kind: GraphScopeKind,
    pub root: String,
    pub source_count: usize,
    pub parsed_count: usize,
    pub knowledge_count: usize,
    pub issue_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphMigrationCollision {
    pub id: String,
    pub source_paths: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphMigrationReference {
    pub node_id: String,
    pub field: String,
    pub raw_value: String,
    pub expected_kind: String,
    pub resolution: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_id: Option<String>,
    pub source_path: String,
}

#[derive(Debug)]
struct PendingReference {
    node_id: String,
    field: String,
    raw_value: String,
    expected_kind: String,
    source_path: String,
}

pub fn build_migration_report(roots: &[GraphSourceRoot]) -> GraphMigrationReport {
    let mut nodes = Vec::new();
    let mut diagnostics = Vec::new();
    let mut scopes = Vec::new();
    let mut kind_counts = BTreeMap::new();
    let mut alias_counts = BTreeMap::new();
    let mut pending_references = Vec::new();
    let mut source_count = 0;
    let mut knowledge_count = 0;
    let mut issue_count = 0;

    for root in roots {
        let mut scope = GraphMigrationScope {
            id: root.scope_id.clone(),
            kind: root.scope_kind,
            root: root.root.to_string_lossy().into_owned(),
            source_count: 0,
            parsed_count: 0,
            knowledge_count: 0,
            issue_count: 0,
        };
        let directory = root.root.join("graph");
        for path in markdown_paths(&directory, &mut diagnostics) {
            source_count += 1;
            scope.source_count += 1;
            let raw = match fs::read_to_string(&path) {
                Ok(raw) => raw,
                Err(error) => {
                    diagnostics.push(GraphDiagnostic::error(
                        "source-file-unreadable",
                        format!("Could not read graph source '{}': {error}", path.display()),
                        Some(path.to_string_lossy().into_owned()),
                    ));
                    continue;
                }
            };
            if let Some(alias) = raw_kind_alias(&raw) {
                if matches!(alias.as_str(), "org" | "organization") {
                    *alias_counts.entry(alias).or_insert(0) += 1;
                }
            }
            match parse_graph_markdown(
                &path,
                &root.scope_id,
                root.scope_kind,
                GraphSourceFormat::Graph,
                &raw,
            ) {
                Ok(mut parsed) => {
                    scope.parsed_count += 1;
                    if parsed.node.kind == "issue" {
                        issue_count += 1;
                        scope.issue_count += 1;
                    } else {
                        knowledge_count += 1;
                        scope.knowledge_count += 1;
                    }
                    *kind_counts.entry(parsed.node.kind.clone()).or_insert(0) += 1;
                    collect_legacy_references(&parsed.node, &mut pending_references);
                    diagnostics.append(&mut parsed.diagnostics);
                    nodes.push(parsed.node);
                }
                Err(error) => diagnostics.push(GraphDiagnostic::error(
                    "source-file-invalid",
                    format!("Could not load graph source '{}': {error}", path.display()),
                    Some(path.to_string_lossy().into_owned()),
                )),
            }
        }
        scopes.push(scope);
    }

    let mut id_sources: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for node in &nodes {
        id_sources
            .entry(node.id.clone())
            .or_default()
            .push(node.provenance.source_path.clone());
    }
    let collisions = id_sources
        .iter()
        .filter(|(_, paths)| paths.len() > 1)
        .map(|(id, paths)| GraphMigrationCollision {
            id: id.clone(),
            source_paths: paths.clone(),
        })
        .collect::<Vec<_>>();
    for collision in &collisions {
        diagnostics.push(GraphDiagnostic::warning(
            "duplicate-id",
            format!(
                "Graph id '{}' appears in {} sources.",
                collision.id,
                collision.source_paths.len()
            ),
            Some(collision.id.clone()),
            collision.source_paths.last().cloned(),
        ));
    }

    let all_ids = id_sources.keys().cloned().collect::<BTreeSet<_>>();
    for node in &nodes {
        for relation in &node.relations {
            if !all_ids.contains(&relation.target) {
                diagnostics.push(GraphDiagnostic::warning(
                    "dangling-relation",
                    format!(
                        "Graph node '{}' points to missing node '{}' through '{}'.",
                        node.id, relation.target, relation.relation
                    ),
                    Some(node.id.clone()),
                    Some(node.provenance.source_path.clone()),
                ));
            }
        }
    }

    let legacy_references = resolve_legacy_references(pending_references, &nodes);
    diagnostics.sort_by(|left, right| {
        left.source_path
            .cmp(&right.source_path)
            .then_with(|| left.code.cmp(&right.code))
            .then_with(|| left.node_id.cmp(&right.node_id))
    });
    let blocks_cutover = diagnostics.iter().any(|diagnostic| {
        diagnostic.level == GraphDiagnosticLevel::Error
            || matches!(
                diagnostic.code.as_str(),
                "duplicate-id"
                    | "dangling-relation"
                    | "unknown-kind"
                    | "missing-title"
                    | "invalid-issue-status"
                    | "invalid-issue-priority"
            )
    }) || legacy_references
        .iter()
        .any(|reference| matches!(reference.resolution.as_str(), "unresolved" | "ambiguous"));

    GraphMigrationReport {
        dry_run: true,
        source_count,
        parsed_count: nodes.len(),
        knowledge_count,
        issue_count,
        kind_counts,
        alias_counts,
        scopes,
        collisions,
        legacy_references,
        diagnostics,
        ready_for_cutover: !blocks_cutover,
    }
}

fn markdown_paths(directory: &Path, diagnostics: &mut Vec<GraphDiagnostic>) -> Vec<PathBuf> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(error) => {
            diagnostics.push(GraphDiagnostic::error(
                "source-unreadable",
                format!(
                    "Could not read graph source directory '{}': {error}",
                    directory.display()
                ),
                Some(directory.to_string_lossy().into_owned()),
            ));
            return Vec::new();
        }
    };
    let mut paths = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            let file_type = entry.file_type().ok()?;
            (file_type.is_file() && path.extension().and_then(|value| value.to_str()) == Some("md"))
                .then_some(path)
        })
        .collect::<Vec<_>>();
    paths.sort();
    paths
}

fn collect_legacy_references(node: &GraphNode, pending: &mut Vec<PendingReference>) {
    for (property, field, expected_kind) in [
        ("legacyProject", "project", "project"),
        ("legacyAssignee", "assignee", "person"),
    ] {
        let Some(raw_value) = node
            .properties
            .get(property)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        pending.push(PendingReference {
            node_id: node.id.clone(),
            field: field.into(),
            raw_value: raw_value.into(),
            expected_kind: expected_kind.into(),
            source_path: node.provenance.source_path.clone(),
        });
    }
}

fn resolve_legacy_references(
    pending: Vec<PendingReference>,
    nodes: &[GraphNode],
) -> Vec<GraphMigrationReference> {
    pending
        .into_iter()
        .map(|reference| {
            let exact = nodes
                .iter()
                .filter(|node| {
                    node.id == reference.raw_value && node.kind == reference.expected_kind
                })
                .map(|node| node.id.clone())
                .collect::<BTreeSet<_>>();
            let title = nodes
                .iter()
                .filter(|node| {
                    node.kind == reference.expected_kind
                        && node.title.trim().eq_ignore_ascii_case(&reference.raw_value)
                })
                .map(|node| node.id.clone())
                .collect::<BTreeSet<_>>();
            let (resolution, resolved_id) = if exact.len() == 1 {
                ("exact-id", exact.into_iter().next())
            } else if title.len() == 1 {
                ("unique-title", title.into_iter().next())
            } else if exact.len() > 1 || title.len() > 1 {
                ("ambiguous", None)
            } else {
                ("unresolved", None)
            };
            GraphMigrationReference {
                node_id: reference.node_id,
                field: reference.field,
                raw_value: reference.raw_value,
                expected_kind: reference.expected_kind,
                resolution: resolution.into(),
                resolved_id,
                source_path: reference.source_path,
            }
        })
        .collect()
}

fn raw_kind_alias(raw: &str) -> Option<String> {
    let mut lines = raw.lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    let frontmatter = lines
        .take_while(|line| line.trim() != "---")
        .collect::<Vec<_>>()
        .join("\n");
    let value = serde_yaml::from_str::<Value>(&frontmatter).ok()?;
    value
        .get("type")
        .or_else(|| value.get("kind"))
        .and_then(Value::as_str)
        .map(str::trim)
        .map(str::to_ascii_lowercase)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::business_graph::{serialize_graph_markdown, ENTITY_KINDS};
    use tempfile::TempDir;

    #[test]
    fn inventories_unified_sources_without_writing_and_resolves_old_identity_fields() {
        let root = TempDir::new().unwrap();
        fs::create_dir_all(root.path().join("graph")).unwrap();
        fs::write(
            root.path().join("graph/project-alpha.md"),
            "---\ntitle: Project Alpha\ntype: project\n---\n",
        )
        .unwrap();
        fs::write(
            root.path().join("graph/alex.md"),
            "---\ntitle: Alex Smith\ntype: person\n---\n",
        )
        .unwrap();
        fs::write(
            root.path().join("graph/client.md"),
            "---\ntitle: Client\ntype: org\n---\n",
        )
        .unwrap();
        let issue_path = root.path().join("graph/issue-1.md");
        let original = "---\ntitle: Evidence review\nstatus: review\npriority: high\nproject: Project Alpha\nassignee: alex\nlinks: [\"blocked_by missing-issue\"]\n---\nBody";
        fs::write(&issue_path, original).unwrap();

        let report = build_migration_report(&[GraphSourceRoot::new(
            "project:test",
            GraphScopeKind::Project,
            root.path(),
        )]);

        assert!(report.dry_run);
        assert_eq!(report.source_count, 4);
        assert_eq!(report.parsed_count, 4);
        assert_eq!(report.alias_counts["org"], 1);
        assert_eq!(report.kind_counts["company"], 1);
        assert_eq!(
            report
                .legacy_references
                .iter()
                .find(|reference| reference.field == "project")
                .unwrap()
                .resolution,
            "unique-title"
        );
        assert_eq!(
            report
                .legacy_references
                .iter()
                .find(|reference| reference.field == "assignee")
                .unwrap()
                .resolved_id
                .as_deref(),
            Some("alex")
        );
        assert!(report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "dangling-relation"));
        assert!(!report.ready_for_cutover);
        assert_eq!(fs::read_to_string(issue_path).unwrap(), original);
    }

    #[test]
    fn reports_duplicate_ids_across_physical_scopes() {
        let first = TempDir::new().unwrap();
        let second = TempDir::new().unwrap();
        for root in [&first, &second] {
            fs::create_dir_all(root.path().join("graph")).unwrap();
            fs::write(
                root.path().join("graph/shared.md"),
                "---\ntitle: Shared\ntype: note\n---\n",
            )
            .unwrap();
        }
        let report = build_migration_report(&[
            GraphSourceRoot::new("project:a", GraphScopeKind::Project, first.path()),
            GraphSourceRoot::new("team:main", GraphScopeKind::Team, second.path()),
        ]);
        assert_eq!(report.collisions.len(), 1);
        assert_eq!(report.collisions[0].id, "shared");
        assert!(!report.ready_for_cutover);
    }

    #[test]
    fn clean_unified_sources_are_ready_for_reference_repairs() {
        let root = TempDir::new().unwrap();
        fs::create_dir_all(root.path().join("graph")).unwrap();
        fs::write(
            root.path().join("graph/decision.md"),
            "---\ntitle: Decision\ntype: decision\n---\n",
        )
        .unwrap();
        let report = build_migration_report(&[GraphSourceRoot::new(
            "project:test",
            GraphScopeKind::Project,
            root.path(),
        )]);
        assert!(report.ready_for_cutover);
        assert!(report.diagnostics.is_empty());
    }

    #[test]
    fn golden_heor_corpus_covers_the_ontology_and_round_trips_losslessly() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("business-graph");
        let graph_root =
            GraphSourceRoot::new("project:golden", GraphScopeKind::Project, root.clone());
        let report = build_migration_report(std::slice::from_ref(&graph_root));

        assert_eq!(report.source_count, 20);
        assert_eq!(report.parsed_count, 20);
        for kind in ENTITY_KINDS {
            assert!(
                report.kind_counts.get(*kind).copied().unwrap_or_default() > 0,
                "golden corpus is missing ontology kind {kind}"
            );
        }
        assert!(
            report.ready_for_cutover,
            "golden corpus diagnostics: {:?}",
            report.diagnostics
        );

        let directory = root.join("graph");
        for path in markdown_paths(&directory, &mut Vec::new()) {
            let raw = fs::read_to_string(&path).unwrap();
            let first = parse_graph_markdown(
                &path,
                &graph_root.scope_id,
                graph_root.scope_kind,
                GraphSourceFormat::Graph,
                &raw,
            )
            .unwrap()
            .node;
            let serialized = serialize_graph_markdown(&first).unwrap();
            let second = parse_graph_markdown(
                &path,
                &graph_root.scope_id,
                graph_root.scope_kind,
                GraphSourceFormat::Graph,
                &serialized,
            )
            .unwrap()
            .node;
            assert_eq!(second.id, first.id);
            assert_eq!(second.kind, first.kind);
            assert_eq!(second.title, first.title);
            assert_eq!(second.body, first.body);
            assert_eq!(second.tags, first.tags);
            assert_eq!(
                second
                    .relations
                    .iter()
                    .map(|relation| (&relation.relation, &relation.target))
                    .collect::<Vec<_>>(),
                first
                    .relations
                    .iter()
                    .map(|relation| (&relation.relation, &relation.target))
                    .collect::<Vec<_>>()
            );
            assert_eq!(second.properties, first.properties);
        }
    }
}
