use super::markdown::{parse_graph_markdown, serialize_graph_markdown, source_revision};
use super::model::{
    canonical_kind, is_known_kind, is_valid_id, GraphDeleteResult, GraphDiagnostic, GraphNeighbor,
    GraphNode, GraphNodeCreate, GraphNodeDelete, GraphNodePatch, GraphProvenance, GraphQuery,
    GraphQueryResult, GraphRelationDirection, GraphSearchResult, GraphSourceFormat,
    GraphSourceRoot, ISSUE_PRIORITIES, ISSUE_STATUSES,
};
use crate::persistence;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use thiserror::Error;
use uuid::Uuid;

const MAX_QUERY_LIMIT: usize = 500;
const MAX_SEARCH_LIMIT: usize = 100;

#[derive(Debug, Clone, Default)]
pub struct GraphStore {
    nodes: BTreeMap<String, GraphNode>,
    by_kind: HashMap<String, BTreeSet<String>>,
    by_scope: HashMap<String, BTreeSet<String>>,
    by_tag: HashMap<String, BTreeSet<String>>,
    outgoing: HashMap<String, Vec<(String, String)>>,
    incoming: HashMap<String, Vec<(String, String)>>,
    source_diagnostics: Vec<GraphDiagnostic>,
    diagnostics: Vec<GraphDiagnostic>,
    revision: u64,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum GraphMutationError {
    #[error("graph node not found: {0}")]
    NotFound(String),
    #[error("graph node already exists: {0}")]
    Exists(String),
    #[error("graph scope is not mounted: {0}")]
    ScopeNotFound(String),
    #[error("graph source changed for {id}; expected {expected}, found {actual}; reload the node and retry with its current source revision")]
    Conflict {
        id: String,
        expected: String,
        actual: String,
    },
    #[error("graph mutation is invalid: {0}")]
    Invalid(String),
    #[error("could not read graph source {path}: {message}")]
    Read { path: String, message: String },
    #[error("could not serialize graph node {id}: {message}")]
    Serialize { id: String, message: String },
    #[error("could not write graph source {path}: {message}")]
    Write { path: String, message: String },
    #[error("could not move graph source {path} to Trash: {message}")]
    Delete { path: String, message: String },
}

impl GraphStore {
    pub fn load(roots: &[GraphSourceRoot]) -> Self {
        let mut parsed_nodes = Vec::new();
        let mut diagnostics = Vec::new();

        for root in roots {
            load_directory(
                root,
                &root.root.join("graph"),
                GraphSourceFormat::Graph,
                &mut parsed_nodes,
                &mut diagnostics,
            );
        }

        Self::from_nodes(parsed_nodes, diagnostics)
    }

    pub fn from_nodes(nodes: Vec<GraphNode>, mut diagnostics: Vec<GraphDiagnostic>) -> Self {
        let mut by_id: BTreeMap<String, GraphNode> = BTreeMap::new();
        for node in nodes {
            if let Some(existing) = by_id.get(&node.id) {
                diagnostics.push(GraphDiagnostic::warning(
                    "duplicate-id",
                    format!(
                        "Graph id '{}' appears in both '{}' and '{}'. The first source remains authoritative.",
                        node.id, existing.provenance.source_path, node.provenance.source_path
                    ),
                    Some(node.id.clone()),
                    Some(node.provenance.source_path.clone()),
                ));
                continue;
            }
            by_id.insert(node.id.clone(), node);
        }

        let mut store = Self {
            nodes: by_id,
            source_diagnostics: diagnostics,
            revision: 1,
            ..Self::default()
        };
        store.rebuild_indexes();
        store
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub(crate) fn set_revision(&mut self, revision: u64) {
        self.revision = revision.max(1);
    }

    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    pub fn diagnostics(&self) -> &[GraphDiagnostic] {
        &self.diagnostics
    }

    pub fn get(&self, id: &str) -> Option<&GraphNode> {
        self.nodes.get(id)
    }

    pub(crate) fn snapshot_nodes(&self) -> Vec<GraphNode> {
        self.nodes.values().cloned().collect()
    }

    pub fn create_node(
        &mut self,
        root: &GraphSourceRoot,
        mut create: GraphNodeCreate,
    ) -> Result<GraphNode, GraphMutationError> {
        let kind = canonical_kind(&create.kind);
        let explicit_id = create.id.take();
        let id = allocate_id(self, explicit_id.as_deref(), &kind, &create.title)?;
        let source_format = GraphSourceFormat::Graph;
        let directory = root.root.join("graph");
        let source_path = directory.join(format!("{id}.md"));
        let timestamp = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let mut properties = create.properties;
        if kind == "issue" {
            properties
                .entry("status")
                .or_insert_with(|| Value::String("backlog".into()));
            properties
                .entry("priority")
                .or_insert_with(|| Value::String("normal".into()));
        }
        let mut node = GraphNode {
            id,
            kind,
            title: create.title.trim().to_string(),
            summary: create.summary,
            body: create.body,
            tags: create
                .tags
                .into_iter()
                .map(|tag| tag.trim().to_string())
                .filter(|tag| !tag.is_empty())
                .collect(),
            relations: create.relations,
            properties,
            created_at: timestamp.clone(),
            updated_at: timestamp,
            provenance: GraphProvenance {
                scope_id: root.scope_id.clone(),
                scope_kind: root.scope_kind,
                source_path: source_path.to_string_lossy().into_owned(),
                source_revision: String::new(),
                source_format,
            },
        };
        if node.kind == "issue" {
            let preferred_tags = (!node.tags.is_empty()).then(|| node.tags.clone());
            canonicalize_issue_labels(&mut node, preferred_tags);
        }
        validate_mutation(&node)?;
        let serialized =
            serialize_graph_markdown(&node).map_err(|error| GraphMutationError::Serialize {
                id: node.id.clone(),
                message: error.to_string(),
            })?;
        create_new_source(&source_path, serialized.as_bytes())?;
        node.provenance.source_revision = source_revision(&serialized);
        self.nodes.insert(node.id.clone(), node.clone());
        self.revision = self.revision.saturating_add(1);
        self.rebuild_indexes();
        Ok(node)
    }

    pub fn delete_node(
        &mut self,
        request: GraphNodeDelete,
    ) -> Result<GraphDeleteResult, GraphMutationError> {
        self.delete_node_with(request, |path| {
            trash::delete(path).map_err(|error| error.to_string())
        })
    }

    fn delete_node_with<F>(
        &mut self,
        request: GraphNodeDelete,
        delete_source: F,
    ) -> Result<GraphDeleteResult, GraphMutationError>
    where
        F: FnOnce(&Path) -> Result<(), String>,
    {
        let GraphNodeDelete {
            id,
            expected_revision,
        } = request;
        let node = self
            .nodes
            .get(&id)
            .cloned()
            .ok_or_else(|| GraphMutationError::NotFound(id.clone()))?;
        let source_path = PathBuf::from(&node.provenance.source_path);
        // A caller that omits expected_revision still acted on some observed
        // state: the store's in-memory copy, whose source_revision hashes the
        // exact bytes last loaded from disk. Defaulting to that baseline
        // turns an untokened delete from a blind removal into the same
        // conflict check tokened callers get, so an external edit that landed
        // after the last load is never silently destroyed. Every node held in
        // memory carries a revision (load, create, and update all hash the
        // source bytes), and a node this store never loaded is already
        // rejected as NotFound above, so no fallback read is needed.
        let expected = expected_revision.unwrap_or_else(|| node.provenance.source_revision.clone());
        let current =
            fs::read_to_string(&source_path).map_err(|error| GraphMutationError::Read {
                path: source_path.to_string_lossy().into_owned(),
                message: error.to_string(),
            })?;
        let actual = source_revision(&current);
        if actual != expected {
            return Err(GraphMutationError::Conflict {
                id: node.id,
                expected,
                actual,
            });
        }
        delete_source(&source_path).map_err(|message| GraphMutationError::Delete {
            path: source_path.to_string_lossy().into_owned(),
            message,
        })?;
        self.nodes.remove(&id);
        self.revision = self.revision.saturating_add(1);
        self.rebuild_indexes();
        Ok(GraphDeleteResult {
            id,
            source_path: source_path.to_string_lossy().into_owned(),
            graph_revision: self.revision,
            undo_token: None,
        })
    }

    pub fn update_node(&mut self, patch: GraphNodePatch) -> Result<GraphNode, GraphMutationError> {
        let tags_changed = patch.tags.is_some();
        let labels_changed = patch.set_properties.contains_key("labels")
            || patch
                .remove_properties
                .iter()
                .any(|property| property == "labels");
        let mut node = self
            .nodes
            .get(&patch.id)
            .cloned()
            .ok_or_else(|| GraphMutationError::NotFound(patch.id.clone()))?;
        let source_path = PathBuf::from(&node.provenance.source_path);
        let current_raw =
            fs::read_to_string(&source_path).map_err(|error| GraphMutationError::Read {
                path: source_path.to_string_lossy().into_owned(),
                message: error.to_string(),
            })?;
        let actual_revision = source_revision(&current_raw);
        // A caller that omits expected_revision still acted on some observed
        // state: the store's in-memory copy, whose source_revision hashes the
        // exact bytes last loaded from disk. Defaulting to that baseline
        // turns an untokened update from silent last-write-wins into the same
        // conflict check tokened callers get, so an external edit that landed
        // after the last load is rejected instead of overwritten. Every node
        // held in memory carries a revision (load, create, and update all
        // hash the source bytes), and a node this store never loaded is
        // already rejected as NotFound above, so no fallback read is needed.
        let expected = patch
            .expected_revision
            .unwrap_or_else(|| node.provenance.source_revision.clone());
        if expected != actual_revision {
            return Err(GraphMutationError::Conflict {
                id: node.id,
                expected,
                actual: actual_revision,
            });
        }

        if let Some(kind) = patch.kind {
            let kind = canonical_kind(&kind);
            let becomes_issue = node.kind != "issue" && kind == "issue";
            if node.provenance.source_format != GraphSourceFormat::Graph
                && (node.kind == "issue") != (kind == "issue")
            {
                return Err(GraphMutationError::Invalid(
                    "changing issue state on a non-unified graph source is not supported".into(),
                ));
            }
            node.kind = kind;
            if becomes_issue {
                node.properties
                    .entry("status")
                    .or_insert_with(|| Value::String("backlog".into()));
                node.properties
                    .entry("priority")
                    .or_insert_with(|| Value::String("normal".into()));
            }
        }
        if let Some(title) = patch.title {
            node.title = title.trim().to_string();
        }
        if let Some(summary) = patch.summary {
            node.summary = summary;
        }
        if let Some(body) = patch.body {
            node.body = body;
        }
        if let Some(tags) = patch.tags {
            node.tags = tags
                .into_iter()
                .map(|tag| tag.trim().to_string())
                .filter(|tag| !tag.is_empty())
                .collect();
        }
        if let Some(relations) = patch.relations {
            node.relations = relations;
        }
        for key in patch.remove_properties {
            node.properties.remove(&key);
        }
        node.properties.extend(patch.set_properties);
        if node.kind == "issue" && (tags_changed || labels_changed) {
            let preferred_tags = tags_changed.then(|| node.tags.clone());
            canonicalize_issue_labels(&mut node, preferred_tags);
        }
        validate_mutation(&node)?;
        node.updated_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

        let serialized =
            serialize_graph_markdown(&node).map_err(|error| GraphMutationError::Serialize {
                id: node.id.clone(),
                message: error.to_string(),
            })?;
        persistence::write_bytes_atomic(&source_path, serialized.as_bytes()).map_err(|error| {
            GraphMutationError::Write {
                path: source_path.to_string_lossy().into_owned(),
                message: error.to_string(),
            }
        })?;
        node.provenance.source_revision = source_revision(&serialized);
        self.nodes.insert(node.id.clone(), node.clone());
        self.revision = self.revision.saturating_add(1);
        self.rebuild_indexes();
        Ok(node)
    }

    pub fn query(&self, query: &GraphQuery) -> GraphQueryResult {
        let mut ids = self.candidate_ids(query);
        ids.retain(|id| {
            let Some(node) = self.nodes.get(id) else {
                return false;
            };
            if let Some(status) = query.status.as_deref() {
                if node.status() != Some(status) {
                    return false;
                }
            }
            query
                .tags
                .iter()
                .all(|tag| node.tags.iter().any(|node_tag| node_tag == tag))
        });

        ids.sort_by(|left, right| {
            let left = &self.nodes[left];
            let right = &self.nodes[right];
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| left.title.cmp(&right.title))
                .then_with(|| left.id.cmp(&right.id))
        });

        let total = ids.len();
        let offset = query.offset.min(total);
        let limit = query.limit.clamp(1, MAX_QUERY_LIMIT);
        let items = ids
            .into_iter()
            .skip(offset)
            .take(limit)
            .filter_map(|id| self.nodes.get(&id).map(GraphNode::compact))
            .collect();

        GraphQueryResult {
            items,
            total,
            offset,
            limit,
            graph_revision: self.revision,
        }
    }

    pub fn search(
        &self,
        query: &str,
        scope_ids: &BTreeSet<String>,
        limit: usize,
    ) -> Vec<GraphSearchResult> {
        let terms = search_terms(query);
        if terms.is_empty() {
            return Vec::new();
        }

        let mut results = self
            .nodes
            .values()
            .filter(|node| scope_ids.is_empty() || scope_ids.contains(&node.provenance.scope_id))
            .filter_map(|node| {
                let score = search_score(node, &terms);
                (score > 0).then(|| GraphSearchResult {
                    node: node.compact(),
                    score,
                })
            })
            .collect::<Vec<_>>();
        results.sort_by(|left, right| {
            right
                .score
                .cmp(&left.score)
                .then_with(|| left.node.title.cmp(&right.node.title))
                .then_with(|| left.node.id.cmp(&right.node.id))
        });
        results.truncate(limit.clamp(1, MAX_SEARCH_LIMIT));
        results
    }

    pub fn neighbors(&self, id: &str, scope_ids: &BTreeSet<String>) -> Vec<GraphNeighbor> {
        if self.visible_node(id, scope_ids).is_none() {
            return Vec::new();
        }
        let mut neighbors = Vec::new();
        for (relation, target) in self.outgoing.get(id).into_iter().flatten() {
            if let Some(node) = self.visible_node(target, scope_ids) {
                neighbors.push(GraphNeighbor {
                    relation: relation.clone(),
                    node: node.compact(),
                    direction: GraphRelationDirection::Outgoing,
                });
            }
        }
        for (relation, source) in self.incoming.get(id).into_iter().flatten() {
            if let Some(node) = self.visible_node(source, scope_ids) {
                neighbors.push(GraphNeighbor {
                    relation: relation.clone(),
                    node: node.compact(),
                    direction: GraphRelationDirection::Incoming,
                });
            }
        }
        neighbors.sort_by(|left, right| {
            left.relation
                .cmp(&right.relation)
                .then_with(|| left.node.title.cmp(&right.node.title))
                .then_with(|| left.node.id.cmp(&right.node.id))
        });
        neighbors
    }

    fn candidate_ids(&self, query: &GraphQuery) -> Vec<String> {
        let mut candidate: Option<BTreeSet<String>> = None;
        for scope in &query.scope_ids {
            let ids = self.by_scope.get(scope).cloned().unwrap_or_default();
            candidate = Some(match candidate {
                Some(mut current) => {
                    current.extend(ids);
                    current
                }
                None => ids,
            });
        }
        if !query.kinds.is_empty() {
            let mut kinds = BTreeSet::new();
            for kind in &query.kinds {
                if let Some(ids) = self.by_kind.get(kind) {
                    kinds.extend(ids.iter().cloned());
                }
            }
            candidate = Some(match candidate {
                Some(current) => current.intersection(&kinds).cloned().collect(),
                None => kinds,
            });
        }
        for tag in &query.tags {
            let ids = self.by_tag.get(tag).cloned().unwrap_or_default();
            candidate = Some(match candidate {
                Some(current) => current.intersection(&ids).cloned().collect(),
                None => ids,
            });
        }
        candidate
            .unwrap_or_else(|| self.nodes.keys().cloned().collect())
            .into_iter()
            .collect()
    }

    fn visible_node<'a>(&'a self, id: &str, scope_ids: &BTreeSet<String>) -> Option<&'a GraphNode> {
        let node = self.nodes.get(id)?;
        if scope_ids.is_empty() || scope_ids.contains(&node.provenance.scope_id) {
            Some(node)
        } else {
            None
        }
    }

    fn rebuild_indexes(&mut self) {
        self.diagnostics = self.source_diagnostics.clone();
        self.by_kind.clear();
        self.by_scope.clear();
        self.by_tag.clear();
        self.outgoing.clear();
        self.incoming.clear();

        for node in self.nodes.values() {
            self.by_kind
                .entry(node.kind.clone())
                .or_default()
                .insert(node.id.clone());
            self.by_scope
                .entry(node.provenance.scope_id.clone())
                .or_default()
                .insert(node.id.clone());
            for tag in &node.tags {
                self.by_tag
                    .entry(tag.clone())
                    .or_default()
                    .insert(node.id.clone());
            }
            for relation in &node.relations {
                self.outgoing
                    .entry(node.id.clone())
                    .or_default()
                    .push((relation.relation.clone(), relation.target.clone()));
                self.incoming
                    .entry(relation.target.clone())
                    .or_default()
                    .push((relation.relation.clone(), node.id.clone()));
                if !self.nodes.contains_key(&relation.target) {
                    self.diagnostics.push(GraphDiagnostic::warning(
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
    }
}

fn canonicalize_issue_labels(node: &mut GraphNode, preferred_tags: Option<Vec<String>>) {
    let existing = node
        .properties
        .get("labels")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut labels_by_name = HashMap::new();
    let mut label_names = Vec::new();
    for label in existing {
        let (name, normalized) = match label {
            Value::Object(mut value) => {
                let Some(name) = value
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|name| !name.is_empty())
                    .map(str::to_string)
                else {
                    continue;
                };
                value.insert("name".into(), Value::String(name.clone()));
                value
                    .entry("color")
                    .or_insert_with(|| Value::String("gray".into()));
                (name, Value::Object(value))
            }
            Value::String(name) if !name.trim().is_empty() => {
                let name = name.trim().to_string();
                (
                    name.clone(),
                    serde_json::json!({ "name": name, "color": "gray" }),
                )
            }
            _ => continue,
        };
        label_names.push(name.clone());
        labels_by_name.insert(name.to_lowercase(), normalized);
    }

    let tags = preferred_tags
        .unwrap_or(label_names)
        .into_iter()
        .map(|tag| tag.trim().to_string())
        .filter(|tag| !tag.is_empty())
        .collect::<Vec<_>>();
    let labels = tags
        .iter()
        .map(|tag| {
            let mut label = labels_by_name
                .remove(&tag.to_lowercase())
                .unwrap_or_else(|| serde_json::json!({ "name": tag, "color": "gray" }));
            if let Value::Object(value) = &mut label {
                value.insert("name".into(), Value::String(tag.clone()));
            }
            label
        })
        .collect::<Vec<_>>();

    node.tags = tags;
    if labels.is_empty() {
        node.properties.remove("labels");
    } else {
        node.properties
            .insert("labels".into(), Value::Array(labels));
    }
}

fn allocate_id(
    store: &GraphStore,
    requested: Option<&str>,
    kind: &str,
    title: &str,
) -> Result<String, GraphMutationError> {
    if let Some(requested) = requested {
        if !is_valid_id(requested) {
            return Err(GraphMutationError::Invalid(format!(
                "invalid graph id: {requested}"
            )));
        }
        if store.nodes.contains_key(requested) {
            return Err(GraphMutationError::Exists(requested.into()));
        }
        return Ok(requested.into());
    }
    if kind == "issue" {
        let timestamp = chrono::Utc::now().timestamp();
        for _ in 0..16 {
            let suffix = &Uuid::new_v4().simple().to_string()[..4];
            let candidate = format!("issue-{timestamp}-{suffix}");
            if !store.nodes.contains_key(&candidate) {
                return Ok(candidate);
            }
        }
        return Err(GraphMutationError::Invalid(
            "could not allocate a unique issue id".into(),
        ));
    }

    let base = slug_id(title);
    if base.is_empty() {
        return Err(GraphMutationError::Invalid(
            "title must contain characters usable in an id".into(),
        ));
    }
    for suffix in 1..=100 {
        let candidate = if suffix == 1 {
            base.clone()
        } else {
            format!("{base}-{suffix}")
        };
        if !store.nodes.contains_key(&candidate) {
            return Ok(candidate);
        }
    }
    Err(GraphMutationError::Invalid(format!(
        "could not allocate a unique id based on '{base}'"
    )))
}

fn slug_id(value: &str) -> String {
    let mut slug = String::new();
    let mut last_dash = false;
    for character in value.to_ascii_lowercase().chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character);
            last_dash = false;
        } else if !slug.is_empty() && !last_dash {
            slug.push('-');
            last_dash = true;
        }
        if slug.len() >= 80 {
            break;
        }
    }
    slug.trim_matches('-').to_string()
}

fn create_new_source(path: &Path, contents: &[u8]) -> Result<(), GraphMutationError> {
    let parent = path.parent().ok_or_else(|| GraphMutationError::Write {
        path: path.to_string_lossy().into_owned(),
        message: "source has no parent directory".into(),
    })?;
    fs::create_dir_all(parent).map_err(|error| GraphMutationError::Write {
        path: parent.to_string_lossy().into_owned(),
        message: error.to_string(),
    })?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                GraphMutationError::Exists(
                    path.file_stem()
                        .and_then(|value| value.to_str())
                        .unwrap_or_default()
                        .to_string(),
                )
            } else {
                GraphMutationError::Write {
                    path: path.to_string_lossy().into_owned(),
                    message: error.to_string(),
                }
            }
        })?;
    file.write_all(contents)
        .and_then(|_| file.sync_all())
        .map_err(|error| GraphMutationError::Write {
            path: path.to_string_lossy().into_owned(),
            message: error.to_string(),
        })
}

fn validate_mutation(node: &GraphNode) -> Result<(), GraphMutationError> {
    if node.title.trim().is_empty() {
        return Err(GraphMutationError::Invalid("title is required".into()));
    }
    if !is_known_kind(&node.kind) {
        return Err(GraphMutationError::Invalid(format!(
            "unsupported entity kind: {}",
            node.kind
        )));
    }
    if node.kind == "issue" {
        let status = node.status().unwrap_or("backlog");
        if !ISSUE_STATUSES.contains(&status) {
            return Err(GraphMutationError::Invalid(format!(
                "unsupported issue status: {status}"
            )));
        }
        let priority = node.priority().unwrap_or("normal");
        if !ISSUE_PRIORITIES.contains(&priority) {
            return Err(GraphMutationError::Invalid(format!(
                "unsupported issue priority: {priority}"
            )));
        }
    }
    Ok(())
}

fn load_directory(
    root: &GraphSourceRoot,
    directory: &Path,
    source_format: GraphSourceFormat,
    nodes: &mut Vec<GraphNode>,
    diagnostics: &mut Vec<GraphDiagnostic>,
) {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => {
            diagnostics.push(GraphDiagnostic::error(
                "source-unreadable",
                format!(
                    "Could not read graph source directory '{}': {}",
                    directory.display(),
                    error
                ),
                Some(directory.to_string_lossy().into_owned()),
            ));
            return;
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
        .collect::<Vec<PathBuf>>();
    paths.sort();

    for path in paths {
        let raw = match fs::read_to_string(&path) {
            Ok(raw) => raw,
            Err(error) => {
                diagnostics.push(GraphDiagnostic::error(
                    "source-file-unreadable",
                    format!(
                        "Could not read graph source '{}': {}",
                        path.display(),
                        error
                    ),
                    Some(path.to_string_lossy().into_owned()),
                ));
                continue;
            }
        };
        match parse_graph_markdown(&path, &root.scope_id, root.scope_kind, source_format, &raw) {
            Ok(mut parsed) => {
                diagnostics.append(&mut parsed.diagnostics);
                nodes.push(parsed.node);
            }
            Err(error) => diagnostics.push(GraphDiagnostic::error(
                "source-file-invalid",
                format!(
                    "Could not load graph source '{}': {}",
                    path.display(),
                    error
                ),
                Some(path.to_string_lossy().into_owned()),
            )),
        }
    }
}

fn search_terms(query: &str) -> Vec<String> {
    query
        .split(|character: char| !character.is_alphanumeric())
        .filter(|term| !term.is_empty())
        .map(str::to_lowercase)
        .collect()
}

fn search_score(node: &GraphNode, terms: &[String]) -> u32 {
    let id = node.id.to_lowercase();
    let title = node.title.to_lowercase();
    let summary = node.summary.to_lowercase();
    let body = node.body.to_lowercase();
    let tags = node
        .tags
        .iter()
        .map(|tag| tag.to_lowercase())
        .collect::<Vec<_>>();

    let mut score = 0;
    for term in terms {
        let mut term_score = 0;
        if title == *term {
            term_score = term_score.max(40);
        } else if title.starts_with(term) {
            term_score = term_score.max(24);
        } else if title.contains(term) {
            term_score = term_score.max(16);
        }
        if id == *term {
            term_score = term_score.max(32);
        } else if id.contains(term) {
            term_score = term_score.max(12);
        }
        if tags.iter().any(|tag| tag == term) {
            term_score = term_score.max(20);
        } else if tags.iter().any(|tag| tag.contains(term)) {
            term_score = term_score.max(10);
        }
        if summary.contains(term) {
            term_score = term_score.max(8);
        }
        if body.contains(term) {
            term_score = term_score.max(2);
        }
        if term_score == 0 {
            return 0;
        }
        score += term_score;
    }
    score
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::business_graph::model::{GraphScopeKind, GraphSourceRoot};
    use std::collections::BTreeSet;
    use tempfile::TempDir;

    fn fixture() -> (TempDir, GraphStore) {
        let root = TempDir::new().unwrap();
        fs::create_dir_all(root.path().join("graph")).unwrap();
        fs::write(
            root.path().join("graph/eversana.md"),
            "---\ntitle: EVERSANA\ntype: org\ntags: [heor, client]\n---\nServices company.",
        )
        .unwrap();
        fs::write(
            root.path().join("graph/project-eversana.md"),
            "---\ntitle: EVERSANA engagement\ntype: project\nlinks:\n  - \"for_company eversana\"\nupdated: \"2026-07-02\"\n---\nAI advisory.",
        )
        .unwrap();
        fs::write(
            root.path().join("graph/issue-1784943918-d4c5.md"),
            "---\ntitle: HEOR evidence map\nstatus: in-progress\npriority: urgent\nproject: project-eversana\nlabels:\n  - name: heor\n    color: blue\nupdated: \"2026-07-03\"\n---\nBuild an evidence map.",
        )
        .unwrap();
        let roots = [GraphSourceRoot::new(
            "project:test",
            GraphScopeKind::Project,
            root.path(),
        )];
        let store = GraphStore::load(&roots);
        (root, store)
    }

    #[test]
    fn loads_older_frontmatter_shapes_from_the_unified_graph() {
        let (_root, store) = fixture();
        assert_eq!(store.len(), 3);
        assert_eq!(store.get("eversana").unwrap().kind, "company");
        assert_eq!(
            store.get("issue-1784943918-d4c5").unwrap().status(),
            Some("in-progress")
        );
        assert!(store.diagnostics().is_empty());
    }

    #[test]
    fn composes_bounded_projection_queries() {
        let (_root, store) = fixture();
        let query = GraphQuery {
            kinds: BTreeSet::from(["issue".into()]),
            tags: BTreeSet::from(["heor".into()]),
            status: Some("in-progress".into()),
            ..GraphQuery::default()
        };
        let result = store.query(&query);
        assert_eq!(result.total, 1);
        assert_eq!(result.items[0].title, "HEOR evidence map");
    }

    #[test]
    fn searches_with_title_and_tag_matches_ahead_of_body_matches() {
        let (_root, store) = fixture();
        let results = store.search("HEOR", &BTreeSet::new(), 10);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].node.id, "issue-1784943918-d4c5");
        assert!(results[0].score > results[1].score);
    }

    #[test]
    fn traverses_visible_outgoing_and_incoming_relations() {
        let (_root, store) = fixture();
        let project_neighbors =
            store.neighbors("project-eversana", &BTreeSet::from(["project:test".into()]));
        assert_eq!(project_neighbors.len(), 2);
        assert!(project_neighbors.iter().any(|neighbor| {
            neighbor.node.id == "eversana" && neighbor.direction == GraphRelationDirection::Outgoing
        }));
        assert!(project_neighbors.iter().any(|neighbor| {
            neighbor.node.id == "issue-1784943918-d4c5"
                && neighbor.direction == GraphRelationDirection::Incoming
        }));
    }

    #[test]
    fn diagnoses_duplicate_ids_and_dangling_relations() {
        let project = TempDir::new().unwrap();
        let team = TempDir::new().unwrap();
        fs::create_dir_all(project.path().join("graph")).unwrap();
        fs::create_dir_all(team.path().join("graph")).unwrap();
        fs::write(
            project.path().join("graph/shared.md"),
            "---\ntitle: Shared\ntype: note\n---\n",
        )
        .unwrap();
        fs::write(
            project.path().join("graph/linked.md"),
            "---\ntitle: Linked\ntype: note\nlinks: [\"references missing\"]\n---\n",
        )
        .unwrap();
        fs::write(
            team.path().join("graph/shared.md"),
            "---\ntitle: Duplicate\n---\n",
        )
        .unwrap();
        let store = GraphStore::load(&[
            GraphSourceRoot::new("project:test", GraphScopeKind::Project, project.path()),
            GraphSourceRoot::new("team:test", GraphScopeKind::Team, team.path()),
        ]);
        assert_eq!(store.len(), 2);
        assert!(store
            .diagnostics()
            .iter()
            .any(|diagnostic| diagnostic.code == "duplicate-id"));
        assert!(store
            .diagnostics()
            .iter()
            .any(|diagnostic| diagnostic.code == "dangling-relation"));
    }

    #[test]
    fn filters_private_project_and_team_sources_before_traversal() {
        let root = TempDir::new().unwrap();
        let private = root.path().join("private");
        let team = root.path().join("team");
        fs::create_dir_all(private.join("graph")).unwrap();
        fs::create_dir_all(team.join("graph")).unwrap();
        fs::write(
            private.join("graph/private-note.md"),
            "---\ntitle: Private note\ntype: note\nlinks: [\"references team-note\"]\n---\n",
        )
        .unwrap();
        fs::write(
            team.join("graph/team-note.md"),
            "---\ntitle: Team note\ntype: note\n---\n",
        )
        .unwrap();
        let store = GraphStore::load(&[
            GraphSourceRoot::new("private:me", GraphScopeKind::Private, private),
            GraphSourceRoot::new("team:main", GraphScopeKind::Team, team),
        ]);

        let private_only = store.neighbors("team-note", &BTreeSet::from(["private:me".into()]));
        assert!(private_only.is_empty());

        let team_only = store.neighbors("team-note", &BTreeSet::from(["team:main".into()]));
        assert!(team_only.is_empty());

        let composed = store.neighbors(
            "team-note",
            &BTreeSet::from(["private:me".into(), "team:main".into()]),
        );
        assert_eq!(composed.len(), 1);
        assert_eq!(composed[0].node.id, "private-note");
    }

    #[test]
    fn updates_one_source_atomically_and_preserves_unknown_properties() {
        let (_root, mut store) = fixture();
        let before = store.get("project-eversana").unwrap().clone();
        let updated = store
            .update_node(GraphNodePatch {
                id: before.id.clone(),
                expected_revision: Some(before.provenance.source_revision.clone()),
                title: Some("EVERSANA AI engagement".into()),
                body: Some("Updated body.".into()),
                set_properties: serde_json::Map::from_iter([(
                    "status".into(),
                    serde_json::Value::String("active".into()),
                )]),
                ..GraphNodePatch::default()
            })
            .unwrap();

        assert_eq!(updated.title, "EVERSANA AI engagement");
        assert_eq!(updated.body, "Updated body.");
        assert_ne!(
            updated.provenance.source_revision,
            before.provenance.source_revision
        );
        assert_eq!(store.revision(), 2);
        let disk = fs::read_to_string(&updated.provenance.source_path).unwrap();
        assert!(disk.contains("status: active"));
        assert!(disk.contains("Updated body."));
    }

    #[test]
    fn issue_tag_updates_keep_labels_and_markdown_in_sync() {
        let (root, mut store) = fixture();
        let before = store.get("issue-1784943918-d4c5").unwrap().clone();
        let updated = store
            .update_node(GraphNodePatch {
                id: before.id.clone(),
                expected_revision: Some(before.provenance.source_revision),
                tags: Some(vec!["funding".into(), "research".into()]),
                ..GraphNodePatch::default()
            })
            .unwrap();

        assert_eq!(updated.tags, ["funding", "research"]);
        assert_eq!(
            updated
                .properties
                .get("labels")
                .and_then(Value::as_array)
                .unwrap()
                .iter()
                .filter_map(|label| label.get("name").and_then(Value::as_str))
                .collect::<Vec<_>>(),
            ["funding", "research"]
        );
        let reloaded = GraphStore::load(&[GraphSourceRoot::new(
            "project:test",
            GraphScopeKind::Project,
            root.path(),
        )]);
        let reparsed = reloaded.get(&before.id).unwrap();
        assert_eq!(reparsed.tags, updated.tags);
        assert_eq!(
            reparsed.properties.get("labels"),
            updated.properties.get("labels")
        );
    }

    #[test]
    fn rejects_stale_mutations_without_overwriting_external_edits() {
        let (_root, mut store) = fixture();
        let before = store.get("eversana").unwrap().clone();
        fs::write(&before.provenance.source_path, "external edit").unwrap();
        let error = store
            .update_node(GraphNodePatch {
                id: before.id.clone(),
                expected_revision: Some(before.provenance.source_revision),
                title: Some("Should not win".into()),
                ..GraphNodePatch::default()
            })
            .unwrap_err();

        assert!(matches!(error, GraphMutationError::Conflict { .. }));
        assert_eq!(
            fs::read_to_string(&before.provenance.source_path).unwrap(),
            "external edit"
        );
        assert_eq!(store.get("eversana").unwrap().title, "EVERSANA");
    }

    #[test]
    fn validates_typed_issue_mutations_before_writing() {
        let (_root, mut store) = fixture();
        let issue = store.get("issue-1784943918-d4c5").unwrap().clone();
        let error = store
            .update_node(GraphNodePatch {
                id: issue.id,
                expected_revision: Some(issue.provenance.source_revision),
                set_properties: serde_json::Map::from_iter([(
                    "status".into(),
                    serde_json::Value::String("whenever".into()),
                )]),
                ..GraphNodePatch::default()
            })
            .unwrap_err();
        assert_eq!(
            error,
            GraphMutationError::Invalid("unsupported issue status: whenever".into())
        );
    }

    #[test]
    fn creates_typed_nodes_in_the_selected_physical_scope() {
        let (root, mut store) = fixture();
        let source = GraphSourceRoot::new(
            "project:test",
            GraphScopeKind::Project,
            root.path().to_path_buf(),
        );
        let project = store
            .create_node(
                &source,
                GraphNodeCreate {
                    kind: "project".into(),
                    title: "Value evidence strategy".into(),
                    summary: "Shared engagement context".into(),
                    ..GraphNodeCreate::default()
                },
            )
            .unwrap();
        assert_eq!(project.id, "value-evidence-strategy");
        assert_eq!(project.provenance.scope_id, "project:test");
        assert!(root
            .path()
            .join("graph/value-evidence-strategy.md")
            .is_file());

        let issue = store
            .create_node(
                &source,
                GraphNodeCreate {
                    kind: "issue".into(),
                    title: "Review extraction grid".into(),
                    ..GraphNodeCreate::default()
                },
            )
            .unwrap();
        assert!(issue.id.starts_with("issue-"));
        assert_eq!(issue.status(), Some("backlog"));
        assert_eq!(issue.priority(), Some("normal"));
        assert!(root
            .path()
            .join("graph")
            .join(format!("{}.md", issue.id))
            .is_file());
    }

    #[test]
    fn unified_graph_nodes_can_change_kind_without_moving_files() {
        let (root, mut store) = fixture();
        let source = GraphSourceRoot::new("project:test", GraphScopeKind::Project, root.path());
        let note = store
            .create_node(
                &source,
                GraphNodeCreate {
                    kind: "note".into(),
                    title: "Evidence follow-up".into(),
                    ..GraphNodeCreate::default()
                },
            )
            .unwrap();
        let source_path = note.provenance.source_path.clone();

        let issue = store
            .update_node(GraphNodePatch {
                id: note.id.clone(),
                expected_revision: Some(note.provenance.source_revision),
                kind: Some("issue".into()),
                ..GraphNodePatch::default()
            })
            .unwrap();

        assert_eq!(issue.kind, "issue");
        assert_eq!(issue.status(), Some("backlog"));
        assert_eq!(issue.priority(), Some("normal"));
        assert_eq!(issue.provenance.source_path, source_path);
        let reloaded = GraphStore::load(&[source]);
        assert_eq!(reloaded.get(&note.id).unwrap().kind, "issue");
        assert_eq!(reloaded.get(&note.id).unwrap().status(), Some("backlog"));
    }

    #[test]
    fn creation_never_overwrites_an_explicit_existing_id() {
        let (root, mut store) = fixture();
        let source = GraphSourceRoot::new("project:test", GraphScopeKind::Project, root.path());
        let error = store
            .create_node(
                &source,
                GraphNodeCreate {
                    id: Some("eversana".into()),
                    kind: "company".into(),
                    title: "Replacement".into(),
                    ..GraphNodeCreate::default()
                },
            )
            .unwrap_err();
        assert_eq!(error, GraphMutationError::Exists("eversana".into()));
        assert_eq!(store.get("eversana").unwrap().title, "EVERSANA");
    }

    fn parsed_clean_graph(path: &Path) -> GraphNode {
        let raw = fs::read_to_string(path).unwrap();
        let parsed = parse_graph_markdown(
            path,
            "project:test",
            GraphScopeKind::Project,
            GraphSourceFormat::Graph,
            &raw,
        )
        .unwrap();
        assert!(
            parsed.diagnostics.is_empty(),
            "source must reparse without diagnostics: {:?}",
            parsed.diagnostics
        );
        parsed.node
    }

    #[test]
    fn racing_stores_on_one_node_keep_the_first_write_and_reject_the_stale_one() {
        let (root, mut first) = fixture();
        let roots = [GraphSourceRoot::new(
            "project:test",
            GraphScopeKind::Project,
            root.path(),
        )];
        let mut second = GraphStore::load(&roots);
        let token = first
            .get("eversana")
            .unwrap()
            .provenance
            .source_revision
            .clone();

        let winner = first
            .update_node(GraphNodePatch {
                id: "eversana".into(),
                expected_revision: Some(token.clone()),
                title: Some("Winner".into()),
                ..GraphNodePatch::default()
            })
            .unwrap();
        let error = second
            .update_node(GraphNodePatch {
                id: "eversana".into(),
                expected_revision: Some(token),
                title: Some("Loser".into()),
                ..GraphNodePatch::default()
            })
            .unwrap_err();

        assert!(matches!(error, GraphMutationError::Conflict { .. }));
        let source_path = PathBuf::from(&winner.provenance.source_path);
        let on_disk = parsed_clean_graph(&source_path);
        assert_eq!(on_disk.title, "Winner");
        assert!(!fs::read_to_string(&source_path).unwrap().contains("Loser"));
        assert_eq!(second.get("eversana").unwrap().title, "EVERSANA");
    }

    #[test]
    fn racing_stores_on_different_nodes_both_commit_valid_sources() {
        let (root, mut first) = fixture();
        let roots = [GraphSourceRoot::new(
            "project:test",
            GraphScopeKind::Project,
            root.path(),
        )];
        let mut second = GraphStore::load(&roots);

        for (store, id, title) in [
            (&mut first, "eversana", "EVERSANA rewritten"),
            (&mut second, "project-eversana", "Engagement rewritten"),
        ] {
            let token = store.get(id).unwrap().provenance.source_revision.clone();
            store
                .update_node(GraphNodePatch {
                    id: id.into(),
                    expected_revision: Some(token),
                    title: Some(title.into()),
                    ..GraphNodePatch::default()
                })
                .unwrap();
        }

        let reloaded = GraphStore::load(&roots);
        assert_eq!(reloaded.len(), 3);
        assert!(reloaded.diagnostics().is_empty());
        assert_eq!(
            reloaded.get("eversana").unwrap().title,
            "EVERSANA rewritten"
        );
        assert_eq!(
            reloaded.get("project-eversana").unwrap().title,
            "Engagement rewritten"
        );
        for id in ["eversana", "project-eversana"] {
            let path = PathBuf::from(&reloaded.get(id).unwrap().provenance.source_path);
            parsed_clean_graph(&path);
        }
    }

    #[test]
    fn racing_creates_with_one_explicit_id_keep_the_first_source() {
        let (root, mut first) = fixture();
        let roots = [GraphSourceRoot::new(
            "project:test",
            GraphScopeKind::Project,
            root.path(),
        )];
        let mut second = GraphStore::load(&roots);
        let source = roots[0].clone();

        first
            .create_node(
                &source,
                GraphNodeCreate {
                    id: Some("race-note".into()),
                    kind: "note".into(),
                    title: "First to file".into(),
                    ..GraphNodeCreate::default()
                },
            )
            .unwrap();
        // The second store has not seen the new node, so only the exclusive
        // create on the filesystem stands between it and clobbering the file.
        let error = second
            .create_node(
                &source,
                GraphNodeCreate {
                    id: Some("race-note".into()),
                    kind: "note".into(),
                    title: "Second to file".into(),
                    ..GraphNodeCreate::default()
                },
            )
            .unwrap_err();

        assert_eq!(error, GraphMutationError::Exists("race-note".into()));
        let path = root.path().join("graph/race-note.md");
        assert_eq!(parsed_clean_graph(&path).title, "First to file");
        assert!(second.get("race-note").is_none());
    }

    #[test]
    fn delete_rejects_stale_revisions_and_preserves_the_external_edit() {
        let (_root, mut store) = fixture();
        let node = store.get("eversana").unwrap().clone();
        let external = "---\ntitle: Edited outside\ntype: org\n---\nKeep me.";
        fs::write(&node.provenance.source_path, external).unwrap();

        let error = store
            .delete_node_with(
                GraphNodeDelete {
                    id: node.id.clone(),
                    expected_revision: Some(node.provenance.source_revision),
                },
                |_| panic!("the source deleter must not run on a stale revision"),
            )
            .unwrap_err();

        assert!(matches!(error, GraphMutationError::Conflict { .. }));
        assert_eq!(
            fs::read_to_string(&node.provenance.source_path).unwrap(),
            external
        );
        assert!(store.get("eversana").is_some());
    }

    #[test]
    fn untokened_updates_reject_external_edits_instead_of_overwriting_them() {
        // A patch without expected_revision defaults to the revision the
        // store last loaded for the node, so an external edit that landed
        // after that load is detected as a conflict and survives untouched
        // instead of being silently replaced last-write-wins.
        let (_root, mut store) = fixture();
        let node = store.get("eversana").unwrap().clone();
        let external = "---\ntitle: External truth\ntype: org\n---\nExternal body.";
        fs::write(&node.provenance.source_path, external).unwrap();

        let error = store
            .update_node(GraphNodePatch {
                id: "eversana".into(),
                expected_revision: None,
                title: Some("Untokened writer".into()),
                ..GraphNodePatch::default()
            })
            .unwrap_err();

        assert!(matches!(error, GraphMutationError::Conflict { .. }));
        assert_eq!(
            fs::read_to_string(&node.provenance.source_path).unwrap(),
            external
        );
        assert_eq!(store.get("eversana").unwrap().title, "EVERSANA");
    }

    #[test]
    fn untokened_updates_succeed_while_the_source_is_unchanged() {
        let (_root, mut store) = fixture();
        let updated = store
            .update_node(GraphNodePatch {
                id: "eversana".into(),
                expected_revision: None,
                title: Some("Untokened writer".into()),
                ..GraphNodePatch::default()
            })
            .unwrap();
        assert_eq!(updated.title, "Untokened writer");
        let on_disk = parsed_clean_graph(Path::new(&updated.provenance.source_path));
        assert_eq!(on_disk.title, "Untokened writer");

        // The defaulted baseline tracks the store's own committed writes, so
        // consecutive untokened updates keep succeeding.
        let again = store
            .update_node(GraphNodePatch {
                id: "eversana".into(),
                expected_revision: None,
                body: Some("Second pass.".into()),
                ..GraphNodePatch::default()
            })
            .unwrap();
        assert_eq!(again.body, "Second pass.");
        assert_eq!(
            parsed_clean_graph(Path::new(&again.provenance.source_path)).body,
            "Second pass."
        );
    }

    #[test]
    fn untokened_deletes_reject_external_edits_and_keep_the_source() {
        let (_root, mut store) = fixture();
        let node = store.get("eversana").unwrap().clone();
        let external = "---\ntitle: Edited outside\ntype: org\n---\nKeep me.";
        fs::write(&node.provenance.source_path, external).unwrap();

        let error = store
            .delete_node_with(
                GraphNodeDelete {
                    id: node.id.clone(),
                    expected_revision: None,
                },
                |_| panic!("the source deleter must not run on an externally edited source"),
            )
            .unwrap_err();

        assert!(matches!(error, GraphMutationError::Conflict { .. }));
        assert_eq!(
            fs::read_to_string(&node.provenance.source_path).unwrap(),
            external
        );
        assert!(store.get("eversana").is_some());
    }

    #[test]
    fn untokened_deletes_succeed_while_the_source_is_unchanged() {
        let (_root, mut store) = fixture();
        let deleted = store
            .delete_node_with(
                GraphNodeDelete {
                    id: "project-eversana".into(),
                    expected_revision: None,
                },
                |path| fs::remove_file(path).map_err(|error| error.to_string()),
            )
            .unwrap();
        assert_eq!(deleted.id, "project-eversana");
        assert!(!Path::new(&deleted.source_path).exists());
        assert!(store.get("project-eversana").is_none());
    }

    #[test]
    fn load_flags_corrupt_sources_without_panicking_deleting_or_rewriting_them() {
        let root = TempDir::new().unwrap();
        let graph = root.path().join("graph");
        fs::create_dir_all(&graph).unwrap();
        let sources: [(&str, &[u8]); 6] = [
            (
                "healthy.md",
                b"---\ntitle: Healthy\ntype: note\n---\nStill fine.",
            ),
            ("empty.md", b""),
            (
                "truncated.md",
                b"---\ntitle: Truncated frontmatter never closes",
            ),
            ("bad-yaml.md", b"---\ntitle: [unclosed\n---\nBody.\n"),
            ("not-an-object.md", b"---\n- just\n- a list\n---\nBody.\n"),
            ("binary.md", b"\xff\xfe\x00not utf-8"),
        ];
        for (name, bytes) in &sources {
            fs::write(graph.join(name), bytes).unwrap();
        }

        let store = GraphStore::load(&[GraphSourceRoot::new(
            "project:test",
            GraphScopeKind::Project,
            root.path(),
        )]);

        assert_eq!(store.get("healthy").unwrap().title, "Healthy");
        assert!(store.get("bad-yaml").is_none());
        assert!(store.get("not-an-object").is_none());
        assert!(store.get("binary").is_none());
        let codes = store
            .diagnostics()
            .iter()
            .map(|diagnostic| diagnostic.code.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            codes
                .iter()
                .filter(|code| **code == "source-file-invalid")
                .count(),
            2
        );
        assert!(codes.contains(&"source-file-unreadable"));

        // NOTE: captures current behavior. An empty file and an unterminated
        // frontmatter fence are not skipped: they load as untitled 'note'
        // nodes (the whole file becomes the body) with a 'missing-title'
        // warning, and a later tokened update would rewrite the file in the
        // canonical shape.
        assert_eq!(store.len(), 3);
        assert_eq!(store.get("empty").unwrap().title, "");
        assert_eq!(store.get("truncated").unwrap().kind, "note");
        assert!(store
            .get("truncated")
            .unwrap()
            .body
            .contains("never closes"));
        assert_eq!(
            codes
                .iter()
                .filter(|code| **code == "missing-title")
                .count(),
            2
        );

        // Loading must never delete, rewrite, or quarantine a source file.
        for (name, bytes) in &sources {
            assert_eq!(
                fs::read(graph.join(name)).unwrap().as_slice(),
                *bytes,
                "{name} must stay byte-identical after load"
            );
        }
    }

    #[test]
    fn delete_checks_revision_and_removes_the_source_and_indexes() {
        let (_root, mut store) = fixture();
        let node = store.get("project-eversana").unwrap().clone();
        let deleted = store
            .delete_node_with(
                GraphNodeDelete {
                    id: node.id.clone(),
                    expected_revision: Some(node.provenance.source_revision),
                },
                |path| fs::remove_file(path).map_err(|error| error.to_string()),
            )
            .unwrap();
        assert_eq!(deleted.id, "project-eversana");
        assert!(!Path::new(&deleted.source_path).exists());
        assert!(store.get("project-eversana").is_none());
        assert_eq!(store.len(), 2);
    }
}
