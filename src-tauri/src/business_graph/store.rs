use super::markdown::{parse_graph_markdown, serialize_graph_markdown, source_revision};
use super::model::{
    canonical_kind, is_known_kind, is_valid_id, GraphDeleteResult, GraphDiagnostic, GraphNeighbor,
    GraphNode, GraphNodeCreate, GraphNodeDelete, GraphNodeMove, GraphNodePatch, GraphProvenance,
    GraphQuery, GraphQueryResult, GraphRelation, GraphRelationDirection, GraphSearchResult,
    GraphSourceFormat, GraphSourceRoot, ISSUE_PRIORITIES, ISSUE_STATUSES,
};
use super::references::{
    extract_graph_references, normalize_title, title_match_rank, GraphBacklink, GraphBodyReference,
    GraphLinkResolution, GraphLinkStatus, GraphLinkTarget, GraphOutgoingReference, GraphReferences,
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
const MAX_LOOKUP_LIMIT: usize = 50;
const MAX_LINK_TARGETS: usize = 200;

#[derive(Debug, Clone, Default)]
pub struct GraphStore {
    nodes: BTreeMap<String, GraphNode>,
    by_kind: HashMap<String, BTreeSet<String>>,
    by_scope: HashMap<String, BTreeSet<String>>,
    by_tag: HashMap<String, BTreeSet<String>>,
    outgoing: HashMap<String, Vec<(String, String)>>,
    incoming: HashMap<String, BTreeSet<(String, String)>>,
    title_order: BTreeSet<(String, String)>,
    normalized_titles: HashMap<String, String>,
    body_references: HashMap<String, Vec<GraphBodyReference>>,
    reference_sources: HashMap<String, BTreeSet<String>>,
    source_diagnostics: Vec<GraphDiagnostic>,
    node_diagnostics: BTreeMap<String, Vec<GraphDiagnostic>>,
    diagnostics: Vec<GraphDiagnostic>,
    revision: u64,
    #[cfg(test)]
    reference_parse_count: usize,
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
        sort_diagnostics(&mut diagnostics);

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

    pub(crate) fn source_diagnostics(&self) -> &[GraphDiagnostic] {
        &self.source_diagnostics
    }

    pub fn get(&self, id: &str) -> Option<&GraphNode> {
        self.nodes.get(id)
    }

    pub(crate) fn snapshot_nodes(&self) -> Vec<GraphNode> {
        self.nodes.values().cloned().collect()
    }

    pub fn visible_ids(&self, scope_ids: &BTreeSet<String>) -> BTreeSet<String> {
        if scope_ids.is_empty() {
            return self.nodes.keys().cloned().collect();
        }
        scope_ids
            .iter()
            .filter_map(|scope| self.by_scope.get(scope))
            .flat_map(|ids| ids.iter().cloned())
            .collect()
    }

    /// Publish a parsed source batch without rebuilding untouched node indexes.
    /// The runtime resolves source precedence and serializes publication.
    pub(crate) fn apply_reconciled_nodes(
        &mut self,
        changes: Vec<(String, Option<GraphNode>)>,
        mut source_diagnostics: Vec<GraphDiagnostic>,
    ) -> bool {
        sort_diagnostics(&mut source_diagnostics);
        let mut changed = self.source_diagnostics != source_diagnostics;
        let mut affected = BTreeSet::new();
        for (id, replacement) in changes {
            if self.nodes.get(&id) == replacement.as_ref() {
                continue;
            }
            changed = true;
            let availability_changed = self.nodes.contains_key(&id) != replacement.is_some();
            if availability_changed {
                self.collect_dependents(&id, &mut affected);
            }
            match replacement {
                Some(node) => self.upsert_indexed(node),
                None => {
                    if let Some(node) = self.nodes.remove(&id) {
                        self.remove_indexes(&node);
                    }
                }
            }
            if availability_changed {
                self.collect_dependents(&id, &mut affected);
            }
            affected.insert(id);
        }
        if changed {
            self.source_diagnostics = source_diagnostics;
            self.refresh_node_diagnostics(affected);
            self.refresh_diagnostics();
            self.revision = self.revision.saturating_add(1);
        }
        changed
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
        self.apply_reconciled_nodes(
            vec![(node.id.clone(), Some(node.clone()))],
            self.source_diagnostics.clone(),
        );
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
            expected_source_path,
        } = request;
        let node = self
            .nodes
            .get(&id)
            .cloned()
            .ok_or_else(|| GraphMutationError::NotFound(id.clone()))?;
        validate_source_identity(&node, expected_source_path.as_deref())?;
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
        self.apply_reconciled_nodes(vec![(id.clone(), None)], self.source_diagnostics.clone());
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
        validate_source_identity(&node, patch.expected_source_path.as_deref())?;
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
        refresh_mutation_base(&mut node, &current_raw, &actual_revision)?;

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
        self.apply_reconciled_nodes(
            vec![(node.id.clone(), Some(node.clone()))],
            self.source_diagnostics.clone(),
        );
        Ok(node)
    }

    pub fn move_node(
        &mut self,
        root: &GraphSourceRoot,
        request: GraphNodeMove,
    ) -> Result<GraphNode, GraphMutationError> {
        let mut node = self
            .nodes
            .get(&request.id)
            .cloned()
            .ok_or_else(|| GraphMutationError::NotFound(request.id.clone()))?;
        validate_source_identity(&node, request.expected_source_path.as_deref())?;
        if node.provenance.scope_id == root.scope_id {
            return Ok(node);
        }
        let source_path = PathBuf::from(&node.provenance.source_path);
        let current_raw =
            fs::read_to_string(&source_path).map_err(|error| GraphMutationError::Read {
                path: source_path.to_string_lossy().into_owned(),
                message: error.to_string(),
            })?;
        let actual_revision = source_revision(&current_raw);
        let expected = request
            .expected_revision
            .unwrap_or_else(|| node.provenance.source_revision.clone());
        if expected != actual_revision {
            return Err(GraphMutationError::Conflict {
                id: node.id,
                expected,
                actual: actual_revision,
            });
        }
        refresh_mutation_base(&mut node, &current_raw, &actual_revision)?;

        let target_path = root.root.join("graph").join(format!("{}.md", node.id));
        node.provenance.scope_id = root.scope_id.clone();
        node.provenance.scope_kind = root.scope_kind;
        node.provenance.source_path = target_path.to_string_lossy().into_owned();
        node.updated_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let serialized =
            serialize_graph_markdown(&node).map_err(|error| GraphMutationError::Serialize {
                id: node.id.clone(),
                message: error.to_string(),
            })?;
        create_new_source(&target_path, serialized.as_bytes())?;
        if let Err(error) = fs::remove_file(&source_path) {
            let _ = fs::remove_file(&target_path);
            return Err(GraphMutationError::Delete {
                path: source_path.to_string_lossy().into_owned(),
                message: error.to_string(),
            });
        }
        node.provenance.source_revision = source_revision(&serialized);
        self.apply_reconciled_nodes(
            vec![(node.id.clone(), Some(node.clone()))],
            self.source_diagnostics.clone(),
        );
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
        self.search_query(
            query,
            &GraphQuery {
                scope_ids: scope_ids.clone(),
                limit,
                ..GraphQuery::default()
            },
        )
    }

    pub fn search_query(&self, text: &str, query: &GraphQuery) -> Vec<GraphSearchResult> {
        let terms = search_terms(text);
        if terms.is_empty() {
            return Vec::new();
        }

        let mut results = self
            .candidate_ids(query)
            .iter()
            .filter_map(|id| self.nodes.get(id))
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
        results.truncate(query.limit.clamp(1, MAX_SEARCH_LIMIT));
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

    /// A title-only query over the native catalog. Retain only a bounded result
    /// set while matching, so broad queries do not allocate one row per node.
    pub fn lookup(
        &self,
        query: &str,
        scope_ids: &BTreeSet<String>,
        limit: usize,
    ) -> Vec<GraphLinkTarget> {
        let limit = limit.clamp(1, MAX_LOOKUP_LIMIT);
        let query = normalize_title(query);
        if query.is_empty() {
            return self
                .title_order
                .iter()
                .filter_map(|(_, id)| self.visible_node(id, scope_ids))
                .take(limit)
                .map(GraphLinkTarget::from)
                .collect();
        }
        let terms = query.split_whitespace().collect::<Vec<_>>();
        let mut matches = BTreeSet::new();
        for (title, id) in &self.title_order {
            if self.visible_node(id, scope_ids).is_none() {
                continue;
            }
            if let Some(rank) = title_match_rank(title, &query, &terms) {
                matches.insert((rank, title, id));
                if matches.len() > limit {
                    matches.pop_last();
                }
            }
        }
        matches
            .into_iter()
            .filter_map(|(_, _, id)| self.nodes.get(id))
            .map(GraphLinkTarget::from)
            .collect()
    }

    /// Batch lookup does not reveal whether an unavailable target is hidden,
    /// deleted, or temporarily unmounted. It never performs filesystem reads.
    pub fn link_targets(
        &self,
        ids: &[String],
        scope_ids: &BTreeSet<String>,
    ) -> Vec<GraphLinkResolution> {
        let mut seen = BTreeSet::new();
        ids.iter()
            .filter(|id| seen.insert(id.as_str()))
            .take(MAX_LINK_TARGETS)
            .map(|id| {
                let node = self.visible_node(id, scope_ids);
                GraphLinkResolution {
                    id: id.clone(),
                    status: if node.is_some() {
                        GraphLinkStatus::Resolved
                    } else {
                        GraphLinkStatus::Unavailable
                    },
                    title: node.map(|node| node.title.clone()),
                    kind: node.map(|node| node.kind.clone()),
                    scope_id: node.map(|node| node.provenance.scope_id.clone()),
                }
            })
            .collect()
    }

    pub fn references(&self, id: &str, scope_ids: &BTreeSet<String>) -> GraphReferences {
        let Some(source) = self.visible_node(id, scope_ids) else {
            return GraphReferences::default();
        };
        let outgoing = self
            .body_references
            .get(id)
            .into_iter()
            .flatten()
            .map(|reference| {
                let node = self
                    .visible_node(&reference.target_id, scope_ids)
                    .map(GraphLinkTarget::from);
                GraphOutgoingReference {
                    reference: reference.clone(),
                    status: if node.is_some() {
                        GraphLinkStatus::Resolved
                    } else {
                        GraphLinkStatus::Unavailable
                    },
                    node,
                }
            })
            .collect();
        let mut backlinks = self
            .reference_sources
            .get(id)
            .into_iter()
            .flatten()
            .filter_map(|source_id| {
                let node = self.visible_node(source_id, scope_ids)?;
                Some(GraphBacklink {
                    source: GraphLinkTarget::from(node),
                    source_revision: node.provenance.source_revision.clone(),
                    occurrences: self
                        .body_references
                        .get(source_id)
                        .into_iter()
                        .flatten()
                        .filter(|reference| reference.target_id == id)
                        .cloned()
                        .collect(),
                })
            })
            .collect::<Vec<_>>();
        backlinks.sort_by(|left, right| {
            left.source
                .title
                .cmp(&right.source.title)
                .then_with(|| left.source.id.cmp(&right.source.id))
        });
        GraphReferences {
            source_revision: source.provenance.source_revision.clone(),
            outgoing,
            backlinks,
        }
    }

    /// Use for reads and traversal only. Persisted GraphNode.relations stay
    /// authored, even when an explicit `references` edge has the same target.
    pub fn effective_relations(&self, id: &str) -> Vec<GraphRelation> {
        let Some(node) = self.nodes.get(id) else {
            return Vec::new();
        };
        let mut relations = node.relations.clone();
        let mut targets: BTreeSet<_> = relations
            .iter()
            .filter(|relation| relation.relation == "references")
            .map(|relation| relation.target.clone())
            .collect();
        for reference in self.body_references.get(id).into_iter().flatten() {
            if targets.insert(reference.target_id.clone()) {
                relations.push(GraphRelation {
                    relation: "references".into(),
                    target: reference.target_id.clone(),
                    legacy: false,
                });
            }
        }
        relations
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
        if let Some(id) = query.related_to.as_deref() {
            let mut related = BTreeSet::new();
            if self.visible_node(id, &query.scope_ids).is_some() {
                related.insert(id.to_owned());
                related.extend(
                    self.outgoing
                        .get(id)
                        .into_iter()
                        .flatten()
                        .map(|(_, target)| target.clone()),
                );
                related.extend(
                    self.incoming
                        .get(id)
                        .into_iter()
                        .flatten()
                        .map(|(_, source)| source.clone()),
                );
            }
            candidate = Some(match candidate {
                Some(current) => current.intersection(&related).cloned().collect(),
                None => related,
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
        self.by_kind.clear();
        self.by_scope.clear();
        self.by_tag.clear();
        self.outgoing.clear();
        self.incoming.clear();
        self.title_order.clear();
        self.normalized_titles.clear();
        self.body_references.clear();
        self.reference_sources.clear();
        self.node_diagnostics.clear();
        let nodes = std::mem::take(&mut self.nodes);
        for (_, node) in nodes {
            self.upsert_indexed(node);
        }
        self.refresh_node_diagnostics(self.nodes.keys().cloned().collect());
        self.refresh_diagnostics();
    }

    fn collect_dependents(&self, id: &str, affected: &mut BTreeSet<String>) {
        affected.extend(
            self.incoming
                .get(id)
                .into_iter()
                .flatten()
                .map(|(_, source)| source.clone()),
        );
    }

    fn upsert_indexed(&mut self, node: GraphNode) {
        let old = self.nodes.remove(&node.id);
        let mut cached_title = None;
        let mut cached_references = None;
        if let Some(old) = &old {
            let (title, references) = self.remove_indexes(old);
            if old.title == node.title {
                cached_title = title;
            }
            if old.body == node.body {
                cached_references = references;
            }
        }
        let title = cached_title.unwrap_or_else(|| normalize_title(&node.title));
        let references = cached_references.unwrap_or_else(|| {
            #[cfg(test)]
            {
                self.reference_parse_count += 1;
            }
            extract_graph_references(&node.body)
        });
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
        // Malformed source identities remain visible for repair, but cannot
        // produce a valid graph URL and must not be offered for insertion.
        if is_valid_id(&node.id) && !title.is_empty() {
            self.title_order.insert((title.clone(), node.id.clone()));
        }
        self.normalized_titles.insert(node.id.clone(), title);
        let mut edges: BTreeSet<(String, String)> = node
            .relations
            .iter()
            .map(|relation| (relation.relation.clone(), relation.target.clone()))
            .collect();
        for reference in &references {
            self.reference_sources
                .entry(reference.target_id.clone())
                .or_default()
                .insert(node.id.clone());
            edges.insert(("references".into(), reference.target_id.clone()));
        }
        for (relation, target) in &edges {
            self.incoming
                .entry(target.clone())
                .or_default()
                .insert((relation.clone(), node.id.clone()));
        }
        self.outgoing
            .insert(node.id.clone(), edges.into_iter().collect());
        self.body_references.insert(node.id.clone(), references);
        self.nodes.insert(node.id.clone(), node);
    }

    fn remove_indexes(
        &mut self,
        node: &GraphNode,
    ) -> (Option<String>, Option<Vec<GraphBodyReference>>) {
        remove_id(&mut self.by_kind, &node.kind, &node.id);
        remove_id(&mut self.by_scope, &node.provenance.scope_id, &node.id);
        for tag in &node.tags {
            remove_id(&mut self.by_tag, tag, &node.id);
        }
        let title = self.normalized_titles.remove(&node.id);
        if let Some(title) = &title {
            self.title_order.remove(&(title.clone(), node.id.clone()));
        }
        let references = self.body_references.remove(&node.id);
        for reference in references.iter().flatten() {
            remove_id(&mut self.reference_sources, &reference.target_id, &node.id);
        }
        for (relation, target) in self.outgoing.remove(&node.id).into_iter().flatten() {
            if let Some(incoming) = self.incoming.get_mut(&target) {
                incoming.remove(&(relation, node.id.clone()));
                if incoming.is_empty() {
                    self.incoming.remove(&target);
                }
            }
        }
        self.node_diagnostics.remove(&node.id);
        (title, references)
    }

    fn refresh_node_diagnostics(&mut self, ids: BTreeSet<String>) {
        for id in ids {
            self.node_diagnostics.remove(&id);
            let Some(node) = self.nodes.get(&id) else {
                continue;
            };
            let mut diagnostics = Vec::new();
            for relation in &node.relations {
                if !self.nodes.contains_key(&relation.target) {
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
            let mut seen = BTreeSet::new();
            for reference in self.body_references.get(&id).into_iter().flatten() {
                if !self.nodes.contains_key(&reference.target_id)
                    && seen.insert(&reference.target_id)
                {
                    diagnostics.push(GraphDiagnostic::warning(
                        "unresolved-body-reference",
                        format!(
                            "Graph node '{}' contains a link to unavailable node '{}'.",
                            node.id, reference.target_id
                        ),
                        Some(node.id.clone()),
                        Some(node.provenance.source_path.clone()),
                    ));
                }
            }
            if !diagnostics.is_empty() {
                self.node_diagnostics.insert(id, diagnostics);
            }
        }
    }

    fn refresh_diagnostics(&mut self) {
        self.diagnostics.clear();
        self.diagnostics
            .extend(self.source_diagnostics.iter().cloned());
        self.diagnostics
            .extend(self.node_diagnostics.values().flatten().cloned());
    }
}

fn validate_source_identity(
    node: &GraphNode,
    expected: Option<&str>,
) -> Result<(), GraphMutationError> {
    if expected.is_some_and(|path| path != node.provenance.source_path) {
        return Err(GraphMutationError::Invalid(
            "The Graph source location changed. Reload the entry before saving.".into(),
        ));
    }
    Ok(())
}

fn refresh_mutation_base(
    node: &mut GraphNode,
    raw: &str,
    actual_revision: &str,
) -> Result<(), GraphMutationError> {
    if node.provenance.source_revision != actual_revision {
        // A source editor can observe disk before the watcher updates the
        // index. A caller with that current revision must retain current
        // metadata, rather than serialize the older indexed node.
        *node = parse_graph_markdown(
            Path::new(&node.provenance.source_path),
            &node.provenance.scope_id,
            node.provenance.scope_kind,
            node.provenance.source_format,
            raw,
        ).map_err(|error| GraphMutationError::Invalid(format!(
            "The current Graph source cannot be read as an entry: {error}. Edit its source to repair it."
        )))?.node;
    }
    Ok(())
}

fn sort_diagnostics(diagnostics: &mut [GraphDiagnostic]) {
    diagnostics.sort_by(|left, right| {
        left.source_path
            .cmp(&right.source_path)
            .then_with(|| left.node_id.cmp(&right.node_id))
            .then_with(|| left.code.cmp(&right.code))
            .then_with(|| left.message.cmp(&right.message))
            .then_with(|| (left.level as u8).cmp(&(right.level as u8)))
    });
}

fn remove_id(index: &mut HashMap<String, BTreeSet<String>>, key: &str, id: &str) {
    if let Some(ids) = index.get_mut(key) {
        ids.remove(id);
        if ids.is_empty() {
            index.remove(key);
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
    let slug = if kind == "issue" {
        format!("issue-{}", chrono::Utc::now().timestamp())
    } else {
        slug_id(title)
    };
    let base = if slug.is_empty() { kind } else { &slug };
    // IDs are stable filenames. A complete random suffix prevents a new entry
    // from taking a deleted entry's identity, without durable tombstones.
    for _ in 0..16 {
        let candidate = format!("{base}-{}", Uuid::new_v4().simple());
        if !store.nodes.contains_key(&candidate) {
            return Ok(candidate);
        }
    }
    Err(GraphMutationError::Invalid(
        "could not allocate a unique graph id".into(),
    ))
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
        if slug.len() >= 87 {
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
    if let Some(problem) = super::timesheet::problems(node).first() {
        return Err(GraphMutationError::Invalid(problem.clone()));
    }
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
        assert!(project.id.starts_with("value-evidence-strategy-"));
        assert!(is_valid_id(&project.id));
        assert_eq!(project.provenance.scope_id, "project:test");
        assert!(root
            .path()
            .join("graph")
            .join(format!("{}.md", project.id))
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
    fn meeting_scope_move_keeps_identity_and_removes_the_old_source() {
        let project = TempDir::new().unwrap();
        let team = TempDir::new().unwrap();
        let project_root =
            GraphSourceRoot::new("project:test", GraphScopeKind::Project, project.path());
        let team_root = GraphSourceRoot::new("team:main", GraphScopeKind::Team, team.path());
        let mut store = GraphStore::load(&[project_root.clone(), team_root.clone()]);
        let meeting = store
            .create_node(
                &team_root,
                GraphNodeCreate {
                    id: Some("meeting-1".into()),
                    kind: "meeting".into(),
                    title: "Launch review".into(),
                    body: "- Ship Friday.".into(),
                    ..GraphNodeCreate::default()
                },
            )
            .unwrap();
        let old_path = PathBuf::from(&meeting.provenance.source_path);

        let moved = store
            .move_node(
                &project_root,
                GraphNodeMove {
                    expected_source_path: None,
                    id: meeting.id.clone(),
                    target_scope_id: project_root.scope_id.clone(),
                    expected_revision: Some(meeting.provenance.source_revision),
                },
            )
            .unwrap();

        assert_eq!(moved.id, "meeting-1");
        assert_eq!(moved.provenance.scope_id, "project:test");
        assert!(!old_path.exists());
        assert!(Path::new(&moved.provenance.source_path).is_file());
        assert_eq!(store.get("meeting-1").unwrap().body, "- Ship Friday.");
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
                    expected_source_path: None,
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
                    expected_source_path: None,
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
                    expected_source_path: None,
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
                    expected_source_path: None,
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

    fn linked_node(id: &str, title: &str, body: &str, scope: &str) -> GraphNode {
        GraphNode {
            id: id.into(),
            kind: "note".into(),
            title: title.into(),
            summary: String::new(),
            body: body.into(),
            tags: vec![],
            relations: vec![],
            properties: serde_json::Map::new(),
            created_at: String::new(),
            updated_at: String::new(),
            provenance: GraphProvenance {
                scope_id: scope.into(),
                scope_kind: GraphScopeKind::Team,
                source_path: format!("/{scope}/graph/{id}.md"),
                source_revision: source_revision(body),
                source_format: GraphSourceFormat::Graph,
            },
        }
    }

    #[test]
    fn project_filter_uses_direct_links_before_query_and_search_limits() {
        let mut project = linked_node(
            "project",
            "ZZ Project",
            "[Resource](mimir://graph/resource)",
            "team",
        );
        project.kind = "project".into();
        project.relations.push(GraphRelation {
            relation: "for_company".into(),
            target: "company".into(),
            legacy: false,
        });
        let mut issue = linked_node("issue", "ZZ Issue", "needle", "workspace");
        issue.kind = "issue".into();
        issue.relations.push(GraphRelation {
            relation: "part_of".into(),
            target: "project".into(),
            legacy: false,
        });
        let note = linked_node(
            "note",
            "ZZ Note",
            "needle [Project](mimir://graph/project)",
            "private",
        );
        let mut nodes = vec![
            project,
            issue,
            note,
            linked_node("resource", "ZZ Resource", "needle", "team"),
            linked_node("company", "ZZ Company", "needle", "team"),
            linked_node(
                "indirect",
                "Indirect",
                "needle [Task](mimir://graph/issue)",
                "team",
            ),
        ];
        for index in 0..600 {
            nodes.push(linked_node(
                &format!("other-{index}"),
                "A needle",
                "",
                "team",
            ));
        }
        let mut store = GraphStore::from_nodes(nodes, vec![]);
        assert!(!store
            .query(&GraphQuery {
                limit: 500,
                ..GraphQuery::default()
            })
            .items
            .iter()
            .any(|node| node.id == "project"));
        assert!(!store
            .search("needle", &BTreeSet::new(), 100)
            .iter()
            .any(|result| result.node.id == "note"));
        let mut query = GraphQuery {
            related_to: Some("project".into()),
            limit: 500,
            ..GraphQuery::default()
        };
        let ids: BTreeSet<_> = store
            .query(&query)
            .items
            .into_iter()
            .map(|node| node.id)
            .collect();
        assert_eq!(
            ids,
            BTreeSet::from([
                "project".into(),
                "issue".into(),
                "note".into(),
                "resource".into(),
                "company".into()
            ])
        );
        assert_eq!(store.search_query("needle", &query).len(), 4);
        query.kinds = BTreeSet::from(["note".into()]);
        assert_eq!(store.query(&query).total, 3);
        query.scope_ids = BTreeSet::from(["team".into()]);
        assert_eq!(store.query(&query).total, 2);
        assert_eq!(store.search_query("needle", &query).len(), 2);
        query.scope_ids = BTreeSet::from(["private".into()]);
        assert_eq!(store.query(&query).total, 0); // The anchor is outside the selected scopes.
        assert!(store.search_query("needle", &query).is_empty());
        query.scope_ids.clear();
        let mut note = store.get("note").unwrap().clone();
        note.body = "needle".into();
        store.apply_reconciled_nodes(vec![("note".into(), Some(note))], vec![]);
        assert_eq!(store.query(&query).total, 2);
        store.apply_reconciled_nodes(vec![("project".into(), None)], vec![]);
        assert_eq!(store.query(&query).total, 0);
        assert!(store.search_query("needle", &query).is_empty());
    }

    #[test]
    fn body_occurrences_share_one_edge_and_keep_authored_relations_separate() {
        let mut source = linked_node(
            "source",
            "Source",
            "[Jon](mimir://graph/jon) and [J](mimir://graph/jon)",
            "team",
        );
        source.relations = vec![
            GraphRelation {
                relation: "assigned_to".into(),
                target: "jon".into(),
                legacy: false,
            },
            GraphRelation {
                relation: "references".into(),
                target: "jon".into(),
                legacy: true,
            },
        ];
        let target = linked_node("jon", "Jon", "", "team");
        let mut store = GraphStore::from_nodes(vec![source.clone(), target], vec![]);
        let scopes = BTreeSet::new();
        assert_eq!(store.references("source", &scopes).outgoing.len(), 2);
        let backlinks = store.references("jon", &scopes).backlinks;
        assert_eq!(backlinks.len(), 1);
        assert_eq!(backlinks[0].occurrences.len(), 2);
        assert_eq!(
            backlinks[0].source_revision,
            source.provenance.source_revision
        );
        assert_eq!(store.neighbors("source", &scopes).len(), 2);
        assert_eq!(store.effective_relations("source"), source.relations);
        assert_eq!(store.get("source").unwrap().relations, source.relations);

        source.body = "[Jon](mimir://graph/jon)".into();
        store.apply_reconciled_nodes(vec![(source.id.clone(), Some(source.clone()))], vec![]);
        assert_eq!(
            store.references("jon", &scopes).backlinks[0]
                .occurrences
                .len(),
            1
        );
        source.body.clear();
        store.apply_reconciled_nodes(vec![(source.id.clone(), Some(source.clone()))], vec![]);
        assert!(store.references("jon", &scopes).backlinks.is_empty());
        assert_eq!(store.effective_relations("source"), source.relations);
        assert_eq!(store.neighbors("source", &scopes).len(), 2);
        let serialized = serialize_graph_markdown(store.get("source").unwrap()).unwrap();
        assert!(serialized.contains("assigned_to"));
    }

    #[test]
    fn derived_edge_removal_and_restore_follow_only_the_source_body() {
        let source = linked_node("source", "Source", "[Jon](mimir://graph/jon)", "team");
        let target = linked_node("jon", "Jon", "", "team");
        let mut store = GraphStore::from_nodes(vec![source.clone(), target], vec![]);
        let mut changed = source.clone();
        changed.body.clear();
        store.apply_reconciled_nodes(vec![(changed.id.clone(), Some(changed))], vec![]);
        assert!(store.effective_relations("source").is_empty());
        assert!(store.neighbors("source", &BTreeSet::new()).is_empty());
        store.apply_reconciled_nodes(vec![(source.id.clone(), Some(source))], vec![]);
        assert_eq!(store.effective_relations("source").len(), 1);
        assert_eq!(store.references("jon", &BTreeSet::new()).backlinks.len(), 1);
        assert!(store.get("source").unwrap().relations.is_empty());
        assert!(!serialize_graph_markdown(store.get("source").unwrap())
            .unwrap()
            .contains("references jon"));
    }

    #[test]
    fn deletion_rename_scope_move_and_restore_resolve_without_reparsing_sources() {
        let source = linked_node("source", "Source", "[Old name](mimir://graph/jon)", "team");
        let mut target = linked_node("jon", "Jon", "", "team");
        let mut store = GraphStore::from_nodes(vec![source.clone(), target.clone()], vec![]);
        let parse_count = store.reference_parse_count;
        target.title = "Jonathan".into();
        store.apply_reconciled_nodes(vec![(target.id.clone(), Some(target.clone()))], vec![]);
        let refs = store.references("source", &BTreeSet::new());
        assert_eq!(refs.outgoing[0].reference.label, "Old name");
        assert_eq!(refs.outgoing[0].node.as_ref().unwrap().title, "Jonathan");
        assert_eq!(store.reference_parse_count, parse_count);
        target.provenance.scope_id = "private".into();
        store.apply_reconciled_nodes(vec![(target.id.clone(), Some(target.clone()))], vec![]);
        let refs = store.references("source", &BTreeSet::from(["team".into()]));
        assert_eq!(refs.outgoing[0].status, GraphLinkStatus::Unavailable);
        assert!(refs.outgoing[0].node.is_none());
        assert!(store
            .references("jon", &BTreeSet::from(["team".into()]))
            .backlinks
            .is_empty());
        store.apply_reconciled_nodes(vec![("jon".into(), None)], vec![]);
        assert_eq!(
            store.references("source", &BTreeSet::new()).outgoing[0].status,
            GraphLinkStatus::Unavailable
        );
        assert_eq!(
            store
                .diagnostics()
                .iter()
                .filter(|row| row.code == "unresolved-body-reference")
                .count(),
            1
        );
        assert_eq!(store.get("source").unwrap(), &source);
        store.apply_reconciled_nodes(vec![(target.id.clone(), Some(target))], vec![]);
        assert_eq!(
            store.references("source", &BTreeSet::new()).outgoing[0].status,
            GraphLinkStatus::Resolved
        );
        assert_eq!(store.references("jon", &BTreeSet::new()).backlinks.len(), 1);
        assert!(store.diagnostics().is_empty());
        assert_eq!(store.reference_parse_count, parse_count + 1);
    }

    #[test]
    fn lookup_covers_all_nodes_normalizes_titles_and_obeys_scopes_and_bounds() {
        let mut nodes = (0..750)
            .map(|index| {
                linked_node(
                    &format!("node-{index}"),
                    &format!("Unrelated {index}"),
                    "Jon body only",
                    "team",
                )
            })
            .collect::<Vec<_>>();
        nodes.extend([
            linked_node("jon", "Jón", "", "team"),
            linked_node("jon-minton", "Jon Minton", "", "team"),
            linked_node("jolo", "Jolo", "", "team"),
            linked_node("meet-jon", "Meet Jon", "", "team"),
            linked_node("banjo", "Banjo", "", "team"),
            linked_node("private-jon", "Jon Secret", "", "private"),
            linked_node("Invalid ID", "Jon Invalid", "", "team"),
            linked_node("untitled", "", "", "team"),
        ]);
        let store = GraphStore::from_nodes(nodes, vec![]);
        let team = BTreeSet::from(["team".into()]);
        let results = store.lookup("JO", &team, 12);
        assert_eq!(
            results
                .iter()
                .map(|node| node.id.as_str())
                .collect::<Vec<_>>(),
            ["jolo", "jon", "jon-minton", "meet-jon", "banjo"]
        );
        assert_eq!(store.lookup("jon", &team, 12)[0].id, "jon");
        assert_eq!(store.lookup("mi jo", &team, 12)[0].id, "jon-minton");
        assert_eq!(store.lookup("", &team, 999).len(), MAX_LOOKUP_LIMIT);
        assert_eq!(store.lookup("", &team, 1)[0].id, "banjo");
        assert_eq!(store.visible_ids(&team).len(), 757);
        let resolved = store.link_targets(
            &[
                "private-jon".into(),
                "missing".into(),
                "jon".into(),
                "jon".into(),
            ],
            &team,
        );
        assert_eq!(resolved.len(), 3);
        for row in &resolved[..2] {
            assert_eq!(row.status, GraphLinkStatus::Unavailable);
            assert!(row.title.is_none() && row.kind.is_none() && row.scope_id.is_none());
        }
        assert_eq!(resolved[2].title.as_deref(), Some("Jón"));
    }

    #[test]
    fn title_only_update_uses_cached_body_rows_and_body_edit_reparses_one_source() {
        let nodes = (0..750)
            .map(|index| {
                linked_node(
                    &format!("node-{index}"),
                    &format!("Note {index}"),
                    "[Target](mimir://graph/node-0)",
                    "team",
                )
            })
            .collect();
        let mut store = GraphStore::from_nodes(nodes, vec![]);
        assert_eq!(store.reference_parse_count, 750);
        let mut node = store.get("node-749").unwrap().clone();
        node.title = "Changed title".into();
        node.tags = vec!["changed".into()];
        store.apply_reconciled_nodes(vec![(node.id.clone(), Some(node.clone()))], vec![]);
        assert_eq!(store.reference_parse_count, 750);
        assert_eq!(
            store.lookup("changed", &BTreeSet::new(), 12)[0].id,
            "node-749"
        );
        assert_eq!(
            store
                .query(&GraphQuery {
                    tags: BTreeSet::from(["changed".into()]),
                    ..GraphQuery::default()
                })
                .total,
            1
        );
        node.body.clear();
        store.apply_reconciled_nodes(vec![(node.id.clone(), Some(node.clone()))], vec![]);
        assert_eq!(store.reference_parse_count, 751);
        assert_eq!(
            store.references("node-0", &BTreeSet::new()).backlinks.len(),
            749
        );
        let revision = store.revision();
        assert!(!store.apply_reconciled_nodes(vec![(node.id.clone(), Some(node))], vec![]));
        assert_eq!(store.revision(), revision);
        assert_eq!(store.reference_parse_count, 751);
    }

    #[test]
    fn reordered_source_diagnostics_do_not_publish_a_change() {
        let a = GraphDiagnostic::warning(
            "duplicate-id",
            "Duplicate A",
            Some("a".into()),
            Some("/team/graph/a.md".into()),
        );
        let b = GraphDiagnostic::warning(
            "source-file-invalid",
            "Malformed B",
            None,
            Some("/team/graph/b.md".into()),
        );
        let mut store = GraphStore::from_nodes(vec![], vec![b.clone(), a.clone()]);
        let revision = store.revision();
        assert!(!store.apply_reconciled_nodes(vec![], vec![a, b]));
        assert_eq!(store.revision(), revision);
    }

    #[test]
    fn generated_ids_cannot_reuse_a_deleted_title_and_accept_long_or_unicode_titles() {
        let store = GraphStore::default();
        let first = allocate_id(&store, None, "person", "Jon Minton").unwrap();
        let second = allocate_id(&store, None, "person", "Jon Minton").unwrap();
        assert_ne!(first, second);
        assert!(first.starts_with("jon-minton-"));
        for title in ["東京", &"a".repeat(300)] {
            let id = allocate_id(&store, None, "note", title).unwrap();
            assert!(is_valid_id(&id));
            assert!(id.len() <= 120);
            let suffix = id.rsplit('-').next().unwrap();
            assert_eq!(suffix.len(), 32);
            assert!(Uuid::parse_str(suffix).is_ok());
        }
        assert_eq!(
            allocate_id(&store, Some("jon"), "person", "Jon").unwrap(),
            "jon"
        );
    }
}
