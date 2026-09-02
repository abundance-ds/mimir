use super::markdown::source_revision;
use super::model::{
    canonical_kind, GraphActor, GraphActorKind, GraphChanged, GraphDeleteResult, GraphDiagnostic,
    GraphEvent, GraphEventPage, GraphEventQuery, GraphFieldChange, GraphNeighbor, GraphNode,
    GraphNodeCreate, GraphNodeDelete, GraphNodeMove, GraphNodePatch, GraphOpenResult, GraphQuery,
    GraphQueryResult, GraphRestoreRequest, GraphScopeDescriptor, GraphScopeKind, GraphSearchResult,
    GraphSourceRoot,
};
use super::store::{GraphMutationError, GraphStore};
use super::{build_migration_report, GraphContextPack, GraphContextRequest, GraphMigrationReport};
use crate::persistence;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, HashSet, VecDeque},
    fs,
    path::{Path, PathBuf},
    sync::{mpsc, Mutex, RwLock},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

const GRAPH_CHANGED_EVENT: &str = "mimir://graph-changed";
const MAX_GRAPH_EVENTS: usize = 2_000;

#[derive(Default)]
pub struct GraphRuntime {
    store: RwLock<GraphStore>,
    roots: RwLock<Vec<GraphSourceRoot>>,
    watchers: Mutex<Vec<RecommendedWatcher>>,
    deleted: Mutex<VecDeque<DeletedGraphSource>>,
    events: Mutex<VecDeque<GraphEvent>>,
    event_path: RwLock<Option<PathBuf>>,
    pending_source_revisions: Mutex<BTreeMap<String, Option<String>>>,
}

#[derive(Debug, Clone)]
struct DeletedGraphSource {
    undo_token: String,
    id: String,
    path: PathBuf,
    raw: String,
}

impl GraphRuntime {
    #[cfg(test)]
    pub(crate) fn from_roots(roots: Vec<GraphSourceRoot>) -> Self {
        Self {
            store: RwLock::new(GraphStore::load(&roots)),
            roots: RwLock::new(roots),
            watchers: Mutex::new(Vec::new()),
            deleted: Mutex::new(VecDeque::new()),
            events: Mutex::new(VecDeque::new()),
            event_path: RwLock::new(None),
            pending_source_revisions: Mutex::new(BTreeMap::new()),
        }
    }

    pub fn open(
        &self,
        app: &AppHandle,
        project_root: impl Into<PathBuf>,
    ) -> Result<GraphOpenResult, String> {
        let project_root = canonical_directory(project_root.into(), "project graph root")?;
        let private_root = private_root()?;
        fs::create_dir_all(&private_root)
            .map_err(|error| format!("Could not create private graph root: {error}"))?;
        let private_root = canonical_directory(private_root, "private graph root")?;

        let mut roots = vec![
            GraphSourceRoot::new("private:local", GraphScopeKind::Private, private_root),
            GraphSourceRoot::new(
                project_scope_id(&project_root),
                GraphScopeKind::Project,
                project_root.clone(),
            ),
        ];
        if let Some(team_root) = crate::managed_git::team_scope_root()? {
            if let Some(team_root) = optional_directory(team_root, "team graph root")? {
                roots.push(GraphSourceRoot::new(
                    "team:main",
                    GraphScopeKind::Team,
                    team_root,
                ));
            }
        }
        deduplicate_roots(&mut roots);

        let event_path = graph_event_path(&project_root)?;
        let events = load_graph_events(&event_path)?;
        let store = GraphStore::load(&roots);
        let result = open_result(&roots, &store);
        let watchers = watch_roots(app.clone(), &roots)?;
        *self.store.write().map_err(|error| error.to_string())? = store;
        *self.roots.write().map_err(|error| error.to_string())? = roots;
        *self.watchers.lock().map_err(|error| error.to_string())? = watchers;
        *self.events.lock().map_err(|error| error.to_string())? = events;
        *self.event_path.write().map_err(|error| error.to_string())? = Some(event_path);
        self.pending_source_revisions
            .lock()
            .map_err(|error| error.to_string())?
            .clear();
        Ok(result)
    }

    pub fn refresh(&self, paths: Vec<String>) -> Result<GraphChanged, String> {
        let roots = self
            .roots
            .read()
            .map_err(|error| error.to_string())?
            .clone();
        let (next_revision, before_nodes) = {
            let store = self.store.read().map_err(|error| error.to_string())?;
            (store.revision().saturating_add(1), store.snapshot_nodes())
        };
        let mut store = GraphStore::load(&roots);
        store.set_revision(next_revision);
        let after_nodes = store.snapshot_nodes();
        let changed = changed_result(&store, paths);
        *self.store.write().map_err(|error| error.to_string())? = store;
        self.record_external_changes(before_nodes, after_nodes, &changed.paths)?;
        Ok(changed)
    }

    pub fn open_result(&self) -> Result<GraphOpenResult, String> {
        let roots = self.roots.read().map_err(|error| error.to_string())?;
        let store = self.store.read().map_err(|error| error.to_string())?;
        Ok(open_result(&roots, &store))
    }

    pub fn get(&self, id: &str) -> Result<Option<GraphNode>, String> {
        Ok(self
            .store
            .read()
            .map_err(|error| error.to_string())?
            .get(id)
            .cloned())
    }

    pub fn query(&self, query: &GraphQuery) -> Result<GraphQueryResult, String> {
        Ok(self
            .store
            .read()
            .map_err(|error| error.to_string())?
            .query(query))
    }

    pub fn search(
        &self,
        query: &str,
        scope_ids: &BTreeSet<String>,
        limit: usize,
    ) -> Result<Vec<GraphSearchResult>, String> {
        Ok(self
            .store
            .read()
            .map_err(|error| error.to_string())?
            .search(query, scope_ids, limit))
    }

    pub fn neighbors(
        &self,
        id: &str,
        scope_ids: &BTreeSet<String>,
    ) -> Result<Vec<GraphNeighbor>, String> {
        Ok(self
            .store
            .read()
            .map_err(|error| error.to_string())?
            .neighbors(id, scope_ids))
    }

    pub fn diagnostics(&self) -> Result<Vec<GraphDiagnostic>, String> {
        Ok(self
            .store
            .read()
            .map_err(|error| error.to_string())?
            .diagnostics()
            .to_vec())
    }

    pub fn events(&self, query: &GraphEventQuery) -> Result<GraphEventPage, String> {
        self.record_temporal_events()?;
        let since = query
            .since
            .as_deref()
            .map(chrono::DateTime::parse_from_rfc3339)
            .transpose()
            .map_err(|error| format!("Invalid graph event 'since' timestamp: {error}"))?;
        let events = self.events.lock().map_err(|error| error.to_string())?;
        let visible = events
            .iter()
            .filter(|event| query.scope_ids.is_empty() || query.scope_ids.contains(&event.scope_id))
            .filter(|event| {
                since.as_ref().is_none_or(|since| {
                    chrono::DateTime::parse_from_rfc3339(&event.timestamp)
                        .is_ok_and(|timestamp| timestamp >= *since)
                })
            })
            .cloned()
            .collect::<Vec<_>>();
        let total = visible.len();
        let offset = query.offset.min(total);
        let limit = query.limit.clamp(1, 500);
        Ok(GraphEventPage {
            items: visible.into_iter().skip(offset).take(limit).collect(),
            total,
            offset,
            limit,
        })
    }

    pub fn record_mutation(
        &self,
        action: impl Into<String>,
        actor: GraphActor,
        before: Option<GraphNode>,
        after: Option<GraphNode>,
        source_path: impl Into<String>,
    ) -> Result<GraphEvent, String> {
        let action = action.into();
        let source_path = source_path.into();
        let graph_revision = self
            .store
            .read()
            .map_err(|error| error.to_string())?
            .revision();
        let node = after.as_ref().or(before.as_ref()).ok_or_else(|| {
            "A graph event needs the node state before or after the mutation.".to_string()
        })?;
        let changes = graph_field_changes(before.as_ref(), after.as_ref());
        let event_type = graph_event_type(&action, before.as_ref(), after.as_ref(), &changes);
        let summary =
            graph_event_summary(&event_type, &action, before.as_ref(), after.as_ref(), node);
        let mut data = Map::new();
        if let Some(due_date) = node.properties.get("dueDate").and_then(Value::as_str) {
            data.insert("dueDate".into(), Value::String(due_date.into()));
        }
        if let Some(deliverable) = newest_deliverable(before.as_ref(), after.as_ref()) {
            data.insert("deliverable".into(), deliverable);
        }
        let event = GraphEvent {
            id: Uuid::new_v4().to_string(),
            event_type,
            action,
            timestamp: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            graph_revision,
            node_id: node.id.clone(),
            node_kind: node.kind.clone(),
            title: node.title.clone(),
            scope_id: node.provenance.scope_id.clone(),
            source_path,
            summary,
            actor,
            changes,
            data,
        };
        self.append_event(event.clone())?;
        Ok(event)
    }

    pub fn migration_report(&self) -> Result<GraphMigrationReport, String> {
        let roots = self
            .roots
            .read()
            .map_err(|error| error.to_string())?
            .clone();
        Ok(build_migration_report(&roots))
    }

    pub fn update(&self, patch: GraphNodePatch) -> Result<GraphNode, GraphMutationError> {
        let updated = self
            .store
            .write()
            .map_err(|error| GraphMutationError::Invalid(error.to_string()))?
            .update_node(patch)?;
        self.remember_source_revision(
            updated.provenance.source_path.clone(),
            Some(updated.provenance.source_revision.clone()),
        )?;
        Ok(updated)
    }

    pub fn create(&self, create: GraphNodeCreate) -> Result<GraphNode, GraphMutationError> {
        let scope_order = default_scope_order(&create.kind);
        let root = {
            let roots = self
                .roots
                .read()
                .map_err(|error| GraphMutationError::Invalid(error.to_string()))?;
            match create.scope_id.as_deref() {
                Some(scope_id) => roots
                    .iter()
                    .find(|root| root.scope_id == scope_id)
                    .cloned()
                    .ok_or_else(|| GraphMutationError::ScopeNotFound(scope_id.into()))?,
                None => scope_order
                    .into_iter()
                    .find_map(|kind| roots.iter().find(|root| root.scope_kind == kind))
                    .cloned()
                    .ok_or_else(|| {
                        GraphMutationError::ScopeNotFound("no graph scope is open".into())
                    })?,
            }
        };
        let created = self
            .store
            .write()
            .map_err(|error| GraphMutationError::Invalid(error.to_string()))?
            .create_node(&root, create)?;
        self.remember_source_revision(
            created.provenance.source_path.clone(),
            Some(created.provenance.source_revision.clone()),
        )?;
        Ok(created)
    }

    pub fn move_scope(&self, request: GraphNodeMove) -> Result<GraphNode, GraphMutationError> {
        let previous_path = self
            .store
            .read()
            .map_err(|error| GraphMutationError::Invalid(error.to_string()))?
            .get(&request.id)
            .map(|node| node.provenance.source_path.clone())
            .ok_or_else(|| GraphMutationError::NotFound(request.id.clone()))?;
        let root = self
            .roots
            .read()
            .map_err(|error| GraphMutationError::Invalid(error.to_string()))?
            .iter()
            .find(|root| root.scope_id == request.target_scope_id)
            .cloned()
            .ok_or_else(|| GraphMutationError::ScopeNotFound(request.target_scope_id.clone()))?;
        let moved = self
            .store
            .write()
            .map_err(|error| GraphMutationError::Invalid(error.to_string()))?
            .move_node(&root, request)?;
        self.remember_source_revision(previous_path, None)?;
        self.remember_source_revision(
            moved.provenance.source_path.clone(),
            Some(moved.provenance.source_revision.clone()),
        )?;
        Ok(moved)
    }

    pub fn delete(
        &self,
        request: GraphNodeDelete,
    ) -> Result<GraphDeleteResult, GraphMutationError> {
        let node = self
            .store
            .read()
            .map_err(|error| GraphMutationError::Invalid(error.to_string()))?
            .get(&request.id)
            .cloned()
            .ok_or_else(|| GraphMutationError::NotFound(request.id.clone()))?;
        let path = PathBuf::from(&node.provenance.source_path);
        let raw = fs::read_to_string(&path).map_err(|error| GraphMutationError::Read {
            path: path.to_string_lossy().into_owned(),
            message: error.to_string(),
        })?;
        let mut deleted = self
            .store
            .write()
            .map_err(|error| GraphMutationError::Invalid(error.to_string()))?
            .delete_node(request)?;
        let undo_token = Uuid::new_v4().to_string();
        let mut queue = self
            .deleted
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        queue.push_back(DeletedGraphSource {
            undo_token: undo_token.clone(),
            id: node.id,
            path,
            raw,
        });
        while queue.len() > 20 {
            queue.pop_front();
        }
        deleted.undo_token = Some(undo_token);
        self.remember_source_revision(deleted.source_path.clone(), None)?;
        Ok(deleted)
    }

    pub fn restore(&self, request: GraphRestoreRequest) -> Result<GraphNode, GraphMutationError> {
        let backup = {
            let queue = self
                .deleted
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            queue
                .iter()
                .find(|backup| backup.undo_token == request.undo_token)
                .cloned()
                .ok_or_else(|| {
                    GraphMutationError::NotFound(format!("undo token {}", request.undo_token))
                })?
        };
        if backup.path.exists() {
            return Err(GraphMutationError::Exists(backup.id));
        }
        persistence::write_bytes_atomic(&backup.path, backup.raw.as_bytes()).map_err(|error| {
            GraphMutationError::Write {
                path: backup.path.to_string_lossy().into_owned(),
                message: error.to_string(),
            }
        })?;
        let source_path = backup.path.to_string_lossy().into_owned();
        self.remember_source_revision(source_path.clone(), Some(source_revision(&backup.raw)))?;
        self.refresh(vec![source_path])
            .map_err(GraphMutationError::Invalid)?;
        let restored = self
            .get(&backup.id)
            .map_err(GraphMutationError::Invalid)?
            .ok_or_else(|| GraphMutationError::NotFound(backup.id.clone()))?;
        let mut queue = self
            .deleted
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        queue.retain(|item| item.undo_token != request.undo_token);
        Ok(restored)
    }

    fn remember_source_revision(
        &self,
        source_path: String,
        revision: Option<String>,
    ) -> Result<(), GraphMutationError> {
        self.pending_source_revisions
            .lock()
            .map_err(|error| GraphMutationError::Invalid(error.to_string()))?
            .insert(source_path, revision);
        Ok(())
    }

    fn consume_matching_source_revision(
        &self,
        source_path: &str,
        next: Option<&GraphNode>,
    ) -> Result<bool, String> {
        let actual = next.map(|node| node.provenance.source_revision.clone());
        let mut pending = self
            .pending_source_revisions
            .lock()
            .map_err(|error| error.to_string())?;
        let Some(expected) = pending.remove(source_path) else {
            return Ok(false);
        };
        Ok(expected == actual)
    }

    fn record_external_changes(
        &self,
        before: Vec<GraphNode>,
        after: Vec<GraphNode>,
        paths: &[String],
    ) -> Result<(), String> {
        let before = before
            .into_iter()
            .map(|node| (node.provenance.source_path.clone(), node))
            .collect::<BTreeMap<_, _>>();
        let after = after
            .into_iter()
            .map(|node| (node.provenance.source_path.clone(), node))
            .collect::<BTreeMap<_, _>>();
        let changed_paths = if paths.is_empty() {
            before
                .keys()
                .chain(after.keys())
                .cloned()
                .collect::<BTreeSet<_>>()
        } else {
            paths.iter().cloned().collect()
        };
        for path in changed_paths {
            let previous = before.get(&path).cloned();
            let next = after.get(&path).cloned();
            let authored_revision = self.consume_matching_source_revision(&path, next.as_ref())?;
            if previous == next || authored_revision {
                continue;
            }
            self.record_mutation(
                "external.file-change",
                GraphActor::external(),
                previous,
                next,
                path,
            )?;
        }
        Ok(())
    }

    fn record_temporal_events(&self) -> Result<(), String> {
        let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
        let revision = self
            .store
            .read()
            .map_err(|error| error.to_string())?
            .revision();
        let overdue = self
            .store
            .read()
            .map_err(|error| error.to_string())?
            .snapshot_nodes()
            .into_iter()
            .filter(|node| {
                node.kind == "issue"
                    && !matches!(node.status(), Some("done" | "cancelled"))
                    && node
                        .properties
                        .get("dueDate")
                        .and_then(Value::as_str)
                        .is_some_and(|due| due < today.as_str())
            })
            .collect::<Vec<_>>();
        for node in overdue {
            let due_date = node
                .properties
                .get("dueDate")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let exists = self
                .events
                .lock()
                .map_err(|error| error.to_string())?
                .iter()
                .any(|event| {
                    event.event_type == "became-overdue"
                        && event.node_id == node.id
                        && event.data.get("dueDate").and_then(Value::as_str)
                            == Some(due_date.as_str())
                });
            if exists {
                continue;
            }
            let event = GraphEvent {
                id: Uuid::new_v4().to_string(),
                event_type: "became-overdue".into(),
                action: "system.due-clock".into(),
                timestamp: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                graph_revision: revision,
                node_id: node.id.clone(),
                node_kind: node.kind.clone(),
                title: node.title.clone(),
                scope_id: node.provenance.scope_id.clone(),
                source_path: node.provenance.source_path.clone(),
                summary: format!("Became overdue · {}", node.title),
                actor: GraphActor {
                    kind: GraphActorKind::System,
                    id: "due-clock".into(),
                    label: "Due clock".into(),
                    initials: "SYS".into(),
                    activity_id: None,
                },
                changes: Vec::new(),
                data: Map::from_iter([("dueDate".into(), Value::String(due_date))]),
            };
            self.append_event(event)?;
        }
        Ok(())
    }

    fn append_event(&self, event: GraphEvent) -> Result<(), String> {
        {
            let mut events = self.events.lock().map_err(|error| error.to_string())?;
            events.push_front(event);
            while events.len() > MAX_GRAPH_EVENTS {
                events.pop_back();
            }
        }
        self.persist_events()
    }

    fn persist_events(&self) -> Result<(), String> {
        let Some(path) = self
            .event_path
            .read()
            .map_err(|error| error.to_string())?
            .clone()
        else {
            return Ok(());
        };
        let events = self
            .events
            .lock()
            .map_err(|error| error.to_string())?
            .iter()
            .cloned()
            .collect::<Vec<_>>();
        persistence::write_json_atomic(&path, &events).map_err(|error| error.to_string())
    }
}

fn graph_event_path(project_root: &Path) -> Result<PathBuf, String> {
    let digest = format!(
        "{:x}",
        Sha256::digest(project_root.to_string_lossy().as_bytes())
    );
    dirs::home_dir()
        .map(|home| {
            home.join(".mimir")
                .join("graph")
                .join("events")
                .join(format!("{}.json", &digest[..24]))
        })
        .ok_or_else(|| "Could not resolve the Business graph event directory.".into())
}

fn load_graph_events(path: &Path) -> Result<VecDeque<GraphEvent>, String> {
    match persistence::load_json_optional_quarantining::<Vec<GraphEvent>>(path)
        .map_err(|error| error.to_string())?
    {
        persistence::QuarantinedLoad::Loaded(events) => {
            Ok(events.into_iter().take(MAX_GRAPH_EVENTS).collect())
        }
        persistence::QuarantinedLoad::Missing => Ok(VecDeque::new()),
        persistence::QuarantinedLoad::Quarantined { path, reason } => {
            log::warn!(
                "Invalid Business graph event journal moved to '{}': {reason}",
                path.display()
            );
            Ok(VecDeque::new())
        }
    }
}

fn graph_field_changes(
    before: Option<&GraphNode>,
    after: Option<&GraphNode>,
) -> Vec<GraphFieldChange> {
    let (Some(before), Some(after)) = (before, after) else {
        return Vec::new();
    };
    let mut changes = Vec::new();
    push_change(
        &mut changes,
        "title",
        json!(before.title),
        json!(after.title),
    );
    push_change(
        &mut changes,
        "summary",
        json!(before.summary),
        json!(after.summary),
    );
    if before.body != after.body {
        push_change(
            &mut changes,
            "body",
            json!({ "characters": before.body.chars().count() }),
            json!({ "characters": after.body.chars().count() }),
        );
    }
    push_change(&mut changes, "tags", json!(before.tags), json!(after.tags));
    push_change(
        &mut changes,
        "relations",
        json!(before.relations),
        json!(after.relations),
    );
    let keys = before
        .properties
        .keys()
        .chain(after.properties.keys())
        .cloned()
        .collect::<BTreeSet<_>>();
    for key in keys {
        let previous = before.properties.get(&key).cloned();
        let next = after.properties.get(&key).cloned();
        if previous != next {
            changes.push(GraphFieldChange {
                field: key,
                before: previous,
                after: next,
            });
        }
    }
    changes
}

fn push_change(changes: &mut Vec<GraphFieldChange>, field: &str, before: Value, after: Value) {
    if before == after {
        return;
    }
    changes.push(GraphFieldChange {
        field: field.into(),
        before: Some(before),
        after: Some(after),
    });
}

fn graph_event_type(
    action: &str,
    before: Option<&GraphNode>,
    after: Option<&GraphNode>,
    changes: &[GraphFieldChange],
) -> String {
    if before.is_none() && after.is_some() {
        if action.contains("restore") {
            return "restored".into();
        }
        if action.contains("record_decision") {
            return "decision-recorded".into();
        }
        if action.contains("capture_evidence") {
            return "evidence-captured".into();
        }
        if action.contains("create_next_action") {
            return "next-action-created".into();
        }
        return "created".into();
    }
    if before.is_some() && after.is_none() {
        return "deleted".into();
    }
    let changed = |field: &str| changes.iter().any(|change| change.field == field);
    let cleared = |field: &str| {
        changes.iter().any(|change| {
            change.field == field
                && change.before.as_ref().is_some_and(non_empty_value)
                && !change.after.as_ref().is_some_and(non_empty_value)
        })
    };
    if cleared("waitingFor") {
        return "waiting-cleared".into();
    }
    if changed("status") {
        return "status-changed".into();
    }
    if deliverable_count(after) > deliverable_count(before) {
        return "deliverable-added".into();
    }
    if action.contains("record_decision") {
        return "decision-recorded".into();
    }
    if action.contains("capture_evidence") {
        return "evidence-captured".into();
    }
    "updated".into()
}

fn non_empty_value(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::String(value) => !value.trim().is_empty(),
        Value::Array(value) => !value.is_empty(),
        Value::Object(value) => !value.is_empty(),
        Value::Bool(value) => *value,
        Value::Number(_) => true,
    }
}

fn deliverable_count(node: Option<&GraphNode>) -> usize {
    node.and_then(|node| node.properties.get("deliverables"))
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0)
}

fn newest_deliverable(before: Option<&GraphNode>, after: Option<&GraphNode>) -> Option<Value> {
    if deliverable_count(after) <= deliverable_count(before) {
        return None;
    }
    after
        .and_then(|node| node.properties.get("deliverables"))
        .and_then(Value::as_array)
        .and_then(|items| items.last())
        .cloned()
}

fn graph_event_summary(
    event_type: &str,
    action: &str,
    before: Option<&GraphNode>,
    after: Option<&GraphNode>,
    node: &GraphNode,
) -> String {
    match event_type {
        "created" => format!("Filed {} · {}", human_kind(&node.kind), node.title),
        "restored" => format!("Restored {}", node.title),
        "deleted" => format!("Moved {} to Trash", node.title),
        "decision-recorded" => format!("Recorded decision · {}", node.title),
        "evidence-captured" => format!("Captured evidence · {}", node.title),
        "next-action-created" => format!("Filed next action · {}", node.title),
        "status-changed" => format!(
            "{} → {} · {}",
            human_kind(before.and_then(GraphNode::status).unwrap_or("backlog")),
            human_kind(after.and_then(GraphNode::status).unwrap_or("backlog")),
            node.title
        ),
        "waiting-cleared" => format!("Waiting cleared · {}", node.title),
        "deliverable-added" => format!("Added deliverable · {}", node.title),
        _ if action == "external.file-change" => format!("Source changed · {}", node.title),
        _ => format!("Updated {}", node.title),
    }
}

fn human_kind(value: &str) -> String {
    value
        .split('-')
        .map(|part| {
            let mut characters = part.chars();
            characters
                .next()
                .map(|first| first.to_uppercase().collect::<String>() + characters.as_str())
                .unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[tauri::command]
pub async fn graph_open(app: AppHandle, project_root: String) -> Result<GraphOpenResult, String> {
    let worker_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let runtime = worker_app.state::<GraphRuntime>();
        runtime.open(&worker_app, project_root)
    })
    .await
    .map_err(|error| format!("Business graph open task failed: {error}"))?
}

#[tauri::command]
pub fn graph_status(runtime: tauri::State<'_, GraphRuntime>) -> Result<GraphOpenResult, String> {
    runtime.open_result()
}

#[tauri::command]
pub fn graph_get(
    runtime: tauri::State<'_, GraphRuntime>,
    id: String,
) -> Result<Option<GraphNode>, String> {
    runtime.get(&id)
}

#[tauri::command]
pub fn graph_query(
    runtime: tauri::State<'_, GraphRuntime>,
    query: GraphQuery,
) -> Result<GraphQueryResult, String> {
    runtime.query(&query)
}

#[tauri::command]
pub fn graph_search(
    runtime: tauri::State<'_, GraphRuntime>,
    query: String,
    scope_ids: BTreeSet<String>,
    limit: Option<usize>,
) -> Result<Vec<GraphSearchResult>, String> {
    runtime.search(&query, &scope_ids, limit.unwrap_or(25))
}

#[tauri::command]
pub fn graph_neighbors(
    runtime: tauri::State<'_, GraphRuntime>,
    id: String,
    scope_ids: BTreeSet<String>,
) -> Result<Vec<GraphNeighbor>, String> {
    runtime.neighbors(&id, &scope_ids)
}

#[tauri::command]
pub fn graph_diagnostics(
    runtime: tauri::State<'_, GraphRuntime>,
) -> Result<Vec<GraphDiagnostic>, String> {
    runtime.diagnostics()
}

#[tauri::command]
pub fn graph_events(
    runtime: tauri::State<'_, GraphRuntime>,
    query: GraphEventQuery,
) -> Result<GraphEventPage, String> {
    runtime.events(&query)
}

#[tauri::command]
pub fn graph_migration_report(
    runtime: tauri::State<'_, GraphRuntime>,
) -> Result<GraphMigrationReport, String> {
    runtime.migration_report()
}

#[tauri::command]
pub fn graph_context(
    runtime: tauri::State<'_, GraphRuntime>,
    request: GraphContextRequest,
) -> Result<GraphContextPack, String> {
    runtime.context(request)
}

#[tauri::command]
pub async fn graph_refresh(app: AppHandle) -> Result<GraphChanged, String> {
    let worker_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let runtime = worker_app.state::<GraphRuntime>();
        let changed = runtime.refresh(Vec::new())?;
        worker_app
            .emit(GRAPH_CHANGED_EVENT, &changed)
            .map_err(|error| error.to_string())?;
        Ok(changed)
    })
    .await
    .map_err(|error| format!("Business graph refresh task failed: {error}"))?
}

#[tauri::command]
pub fn graph_update(
    app: AppHandle,
    runtime: tauri::State<'_, GraphRuntime>,
    patch: GraphNodePatch,
    actor: Option<GraphActor>,
) -> Result<GraphNode, String> {
    let before = runtime.get(&patch.id)?;
    let updated = runtime.update(patch).map_err(|error| error.to_string())?;
    runtime.record_mutation(
        "graph.update",
        actor.unwrap_or_else(GraphActor::human),
        before,
        Some(updated.clone()),
        updated.provenance.source_path.clone(),
    )?;
    let status = runtime.open_result()?;
    let changed = GraphChanged {
        graph_revision: status.graph_revision,
        node_count: status.node_count,
        diagnostic_count: status.diagnostic_count,
        paths: vec![updated.provenance.source_path.clone()],
    };
    app.emit(GRAPH_CHANGED_EVENT, changed)
        .map_err(|error| error.to_string())?;
    Ok(updated)
}

#[tauri::command]
pub fn graph_create(
    app: AppHandle,
    runtime: tauri::State<'_, GraphRuntime>,
    create: GraphNodeCreate,
    actor: Option<GraphActor>,
) -> Result<GraphNode, String> {
    let created = runtime.create(create).map_err(|error| error.to_string())?;
    runtime.record_mutation(
        "graph.create",
        actor.unwrap_or_else(GraphActor::human),
        None,
        Some(created.clone()),
        created.provenance.source_path.clone(),
    )?;
    emit_mutation_changed(&app, &runtime, created.provenance.source_path.clone())?;
    Ok(created)
}

#[tauri::command]
pub fn graph_move_scope(
    app: AppHandle,
    runtime: tauri::State<'_, GraphRuntime>,
    request: GraphNodeMove,
    actor: Option<GraphActor>,
) -> Result<GraphNode, String> {
    let before = runtime
        .get(&request.id)?
        .ok_or_else(|| format!("Graph node not found: {}", request.id))?;
    let previous_path = before.provenance.source_path.clone();
    let moved = runtime
        .move_scope(request)
        .map_err(|error| error.to_string())?;
    runtime.record_mutation(
        "graph.move-scope",
        actor.unwrap_or_else(GraphActor::human),
        Some(before),
        Some(moved.clone()),
        moved.provenance.source_path.clone(),
    )?;
    let status = runtime.open_result()?;
    app.emit(
        GRAPH_CHANGED_EVENT,
        GraphChanged {
            graph_revision: status.graph_revision,
            node_count: status.node_count,
            diagnostic_count: status.diagnostic_count,
            paths: vec![previous_path, moved.provenance.source_path.clone()],
        },
    )
    .map_err(|error| error.to_string())?;
    Ok(moved)
}

#[tauri::command]
pub fn graph_delete(
    app: AppHandle,
    runtime: tauri::State<'_, GraphRuntime>,
    request: GraphNodeDelete,
    actor: Option<GraphActor>,
) -> Result<GraphDeleteResult, String> {
    let before = runtime.get(&request.id)?;
    let deleted = runtime.delete(request).map_err(|error| error.to_string())?;
    runtime.record_mutation(
        "graph.delete",
        actor.unwrap_or_else(GraphActor::human),
        before,
        None,
        deleted.source_path.clone(),
    )?;
    emit_mutation_changed(&app, &runtime, deleted.source_path.clone())?;
    Ok(deleted)
}

#[tauri::command]
pub fn graph_restore(
    app: AppHandle,
    runtime: tauri::State<'_, GraphRuntime>,
    request: GraphRestoreRequest,
    actor: Option<GraphActor>,
) -> Result<GraphNode, String> {
    let restored = runtime
        .restore(request)
        .map_err(|error| error.to_string())?;
    runtime.record_mutation(
        "graph.restore",
        actor.unwrap_or_else(GraphActor::human),
        None,
        Some(restored.clone()),
        restored.provenance.source_path.clone(),
    )?;
    emit_mutation_changed(&app, &runtime, restored.provenance.source_path.clone())?;
    Ok(restored)
}

pub(crate) fn emit_mutation_changed(
    app: &AppHandle,
    runtime: &GraphRuntime,
    source_path: String,
) -> Result<(), String> {
    let status = runtime.open_result()?;
    app.emit(
        GRAPH_CHANGED_EVENT,
        GraphChanged {
            graph_revision: status.graph_revision,
            node_count: status.node_count,
            diagnostic_count: status.diagnostic_count,
            paths: vec![source_path],
        },
    )
    .map_err(|error| error.to_string())
}

fn watch_roots(
    app: AppHandle,
    roots: &[GraphSourceRoot],
) -> Result<Vec<RecommendedWatcher>, String> {
    let (sender, receiver) = mpsc::channel::<Vec<PathBuf>>();
    let mut watchers = Vec::new();
    for root in roots {
        let sender = sender.clone();
        let watched_root = root.root.clone();
        let mut watcher =
            notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
                let Ok(event) = result else {
                    return;
                };
                let paths = event
                    .paths
                    .into_iter()
                    .filter(|path| graph_markdown_path(&watched_root, path))
                    .collect::<Vec<_>>();
                if !paths.is_empty() {
                    let _ = sender.send(paths);
                }
            })
            .map_err(|error| error.to_string())?;
        watcher
            .watch(&root.root, RecursiveMode::Recursive)
            .map_err(|error| {
                format!(
                    "Could not watch graph root '{}': {error}",
                    root.root.display()
                )
            })?;
        watchers.push(watcher);
    }
    drop(sender);

    std::thread::Builder::new()
        .name("mimir-business-graph-watch".into())
        .spawn(move || {
            while let Ok(first) = receiver.recv() {
                let mut changed_paths = first;
                loop {
                    match receiver.recv_timeout(Duration::from_millis(120)) {
                        Ok(paths) => changed_paths.extend(paths),
                        Err(mpsc::RecvTimeoutError::Timeout) => break,
                        Err(mpsc::RecvTimeoutError::Disconnected) => return,
                    }
                }
                let mut seen = HashSet::new();
                changed_paths.retain(|path| seen.insert(path.clone()));
                let paths = changed_paths
                    .into_iter()
                    .map(|path| path.to_string_lossy().into_owned())
                    .collect::<Vec<_>>();
                let runtime = app.state::<GraphRuntime>();
                match runtime.refresh(paths) {
                    Ok(changed) => {
                        let _ = app.emit(GRAPH_CHANGED_EVENT, changed);
                    }
                    Err(error) => log::warn!("Business graph refresh failed: {error}"),
                }
            }
        })
        .map_err(|error| error.to_string())?;
    Ok(watchers)
}

fn graph_markdown_path(root: &Path, path: &Path) -> bool {
    if path.extension().and_then(|value| value.to_str()) != Some("md") {
        return false;
    }
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    matches!(
        relative
            .components()
            .next()
            .and_then(|component| component.as_os_str().to_str()),
        Some("graph")
    )
}

fn private_root() -> Result<PathBuf, String> {
    let home =
        dirs::home_dir().ok_or_else(|| "Could not resolve the private graph root.".to_string())?;
    Ok(home.join(".mimir").join("private"))
}

fn canonical_directory(path: PathBuf, label: &str) -> Result<PathBuf, String> {
    let canonical = fs::canonicalize(&path)
        .map_err(|error| format!("Could not resolve {label} '{}': {error}", path.display()))?;
    if !canonical.is_dir() {
        return Err(format!(
            "{label} is not a directory: {}",
            canonical.display()
        ));
    }
    Ok(canonical)
}

fn optional_directory(path: PathBuf, label: &str) -> Result<Option<PathBuf>, String> {
    if !path.is_absolute() {
        return Err(format!(
            "{label} must be an absolute path: {}",
            path.display()
        ));
    }
    match fs::metadata(&path) {
        Ok(metadata) if metadata.is_dir() => canonical_directory(path, label).map(Some),
        Ok(_) => Err(format!("{label} is not a directory: {}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!(
            "Could not inspect {label} '{}': {error}",
            path.display()
        )),
    }
}

fn project_scope_id(path: &Path) -> String {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("project")
        .to_ascii_lowercase()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    let digest = format!("{:x}", Sha256::digest(path.to_string_lossy().as_bytes()));
    format!("project:{}-{}", name, &digest[..12])
}

fn deduplicate_roots(roots: &mut Vec<GraphSourceRoot>) {
    let mut unique = Vec::<GraphSourceRoot>::new();
    for root in roots.drain(..) {
        if let Some(index) = unique
            .iter()
            .position(|candidate| candidate.root == root.root)
        {
            if scope_identity_priority(root.scope_kind)
                > scope_identity_priority(unique[index].scope_kind)
            {
                unique[index] = root;
            }
        } else {
            unique.push(root);
        }
    }
    *roots = unique;
}

fn scope_identity_priority(kind: GraphScopeKind) -> u8 {
    match kind {
        GraphScopeKind::Private => 3,
        GraphScopeKind::Team => 2,
        GraphScopeKind::Project => 1,
    }
}

fn default_scope_order(kind: &str) -> [GraphScopeKind; 3] {
    if canonical_kind(kind) == "journal" {
        [
            GraphScopeKind::Private,
            GraphScopeKind::Team,
            GraphScopeKind::Project,
        ]
    } else {
        [
            GraphScopeKind::Team,
            GraphScopeKind::Project,
            GraphScopeKind::Private,
        ]
    }
}

fn open_result(roots: &[GraphSourceRoot], store: &GraphStore) -> GraphOpenResult {
    let mut seen_scope_ids = HashSet::new();
    GraphOpenResult {
        scopes: roots
            .iter()
            .filter(|root| seen_scope_ids.insert(root.scope_id.clone()))
            .map(|root| GraphScopeDescriptor {
                id: root.scope_id.clone(),
                kind: root.scope_kind,
                root: root.root.to_string_lossy().into_owned(),
            })
            .collect(),
        node_count: store.len(),
        diagnostic_count: store.diagnostics().len(),
        graph_revision: store.revision(),
    }
}

fn changed_result(store: &GraphStore, paths: Vec<String>) -> GraphChanged {
    GraphChanged {
        graph_revision: store.revision(),
        node_count: store.len(),
        diagnostic_count: store.diagnostics().len(),
        paths,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::business_graph::markdown::parse_graph_markdown;
    use crate::business_graph::model::GraphSourceFormat;
    use crate::business_graph::GraphRelation;
    use tempfile::TempDir;

    fn graph_root(files: &[(&str, &str)]) -> TempDir {
        let root = TempDir::new().unwrap();
        fs::create_dir_all(root.path().join("graph")).unwrap();
        for (name, raw) in files {
            fs::write(root.path().join("graph").join(name), raw).unwrap();
        }
        root
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
    fn recognizes_only_graph_markdown_below_supported_directories() {
        let root = Path::new("/workspace");
        assert!(graph_markdown_path(
            root,
            Path::new("/workspace/graph/note.md")
        ));
        assert!(!graph_markdown_path(
            root,
            Path::new("/workspace/knowledge/note.md")
        ));
        assert!(!graph_markdown_path(
            root,
            Path::new("/workspace/issues/issue.md")
        ));
        assert!(!graph_markdown_path(
            root,
            Path::new("/workspace/docs/note.md")
        ));
        assert!(!graph_markdown_path(
            root,
            Path::new("/workspace/graph/image.png")
        ));
    }

    #[test]
    fn project_scope_ids_are_stable_and_human_readable() {
        let id = project_scope_id(Path::new("/work/HEOR Research"));
        assert!(id.starts_with("project:heor-research-"));
        assert_eq!(id, project_scope_id(Path::new("/work/HEOR Research")));
        assert_ne!(id, project_scope_id(Path::new("/other/HEOR Research")));
    }

    #[test]
    fn team_identity_wins_when_project_and_team_use_one_root() {
        let shared = PathBuf::from("/shared/team");
        let mut roots = vec![
            GraphSourceRoot::new("private:local", GraphScopeKind::Private, "/private"),
            GraphSourceRoot::new("project:test", GraphScopeKind::Project, &shared),
            GraphSourceRoot::new("team:main", GraphScopeKind::Team, &shared),
        ];

        deduplicate_roots(&mut roots);

        assert_eq!(roots.len(), 2);
        assert_eq!(roots[1].scope_id, "team:main");
        assert_eq!(roots[1].scope_kind, GraphScopeKind::Team);
    }

    #[test]
    fn omitted_create_scope_uses_team_except_for_private_journal() {
        let private = TempDir::new().unwrap();
        let project = TempDir::new().unwrap();
        let team = TempDir::new().unwrap();
        let runtime = GraphRuntime::from_roots(vec![
            GraphSourceRoot::new("private:local", GraphScopeKind::Private, private.path()),
            GraphSourceRoot::new("project:test", GraphScopeKind::Project, project.path()),
            GraphSourceRoot::new("team:main", GraphScopeKind::Team, team.path()),
        ]);

        let company = runtime
            .create(GraphNodeCreate {
                kind: "company".into(),
                title: "Shared client".into(),
                ..GraphNodeCreate::default()
            })
            .unwrap();
        let issue = runtime
            .create(GraphNodeCreate {
                kind: "issue".into(),
                title: "Team action".into(),
                ..GraphNodeCreate::default()
            })
            .unwrap();
        let journal = runtime
            .create(GraphNodeCreate {
                kind: "journal".into(),
                title: "2026-08".into(),
                ..GraphNodeCreate::default()
            })
            .unwrap();

        assert_eq!(company.provenance.scope_id, "team:main");
        assert_eq!(issue.provenance.scope_id, "team:main");
        assert_eq!(journal.provenance.scope_id, "private:local");

        let team_only = GraphRuntime::from_roots(vec![
            GraphSourceRoot::new("private:local", GraphScopeKind::Private, private.path()),
            GraphSourceRoot::new("team:main", GraphScopeKind::Team, team.path()),
        ]);
        let shared_issue = team_only
            .create(GraphNodeCreate {
                kind: "issue".into(),
                title: "Shared action".into(),
                ..GraphNodeCreate::default()
            })
            .unwrap();
        assert_eq!(shared_issue.provenance.scope_id, "team:main");
    }

    #[test]
    fn missing_optional_team_directory_does_not_block_local_graphs() {
        let root = TempDir::new().unwrap();
        let missing = root.path().join("offline-team");
        assert_eq!(
            optional_directory(missing, "team graph root").unwrap(),
            None
        );

        let mounted = optional_directory(root.path().to_path_buf(), "team graph root")
            .unwrap()
            .unwrap();
        assert_eq!(mounted, fs::canonicalize(root.path()).unwrap());
        assert!(
            optional_directory(PathBuf::from("relative"), "team graph root")
                .unwrap_err()
                .contains("absolute path")
        );
    }

    #[test]
    fn runtime_composes_project_and_team_queries_without_private_leakage() {
        let project = TempDir::new().unwrap();
        let team = TempDir::new().unwrap();
        fs::create_dir_all(project.path().join("graph")).unwrap();
        fs::create_dir_all(team.path().join("graph")).unwrap();
        fs::write(
            project.path().join("graph/issue-1.md"),
            "---\ntitle: Project issue\nstatus: plan\n---\n",
        )
        .unwrap();
        fs::write(
            team.path().join("graph/company.md"),
            "---\ntitle: Team company\ntype: company\n---\n",
        )
        .unwrap();

        let roots = vec![
            GraphSourceRoot::new("project:test", GraphScopeKind::Project, project.path()),
            GraphSourceRoot::new("team:main", GraphScopeKind::Team, team.path()),
        ];
        let runtime = GraphRuntime {
            store: RwLock::new(GraphStore::load(&roots)),
            roots: RwLock::new(roots),
            watchers: Mutex::new(Vec::new()),
            deleted: Mutex::new(VecDeque::new()),
            events: Mutex::new(VecDeque::new()),
            event_path: RwLock::new(None),
            pending_source_revisions: Mutex::new(BTreeMap::new()),
        };
        let project_result = runtime
            .query(&GraphQuery {
                scope_ids: BTreeSet::from(["project:test".into()]),
                ..GraphQuery::default()
            })
            .unwrap();
        assert_eq!(project_result.total, 1);
        assert_eq!(project_result.items[0].kind, "issue");
        let team_result = runtime
            .search("Project", &BTreeSet::from(["team:main".into()]), 10)
            .unwrap();
        assert!(team_result.is_empty());
    }

    #[test]
    fn private_project_and_team_filters_apply_before_query_search_and_counts() {
        let private = TempDir::new().unwrap();
        let project = TempDir::new().unwrap();
        let team = TempDir::new().unwrap();
        for root in [&private, &project, &team] {
            fs::create_dir_all(root.path().join("graph")).unwrap();
        }
        fs::write(
            private.path().join("graph/private-plan.md"),
            "---\ntitle: Private acquisition plan\ntype: note\n---\n",
        )
        .unwrap();
        fs::write(
            project.path().join("graph/project-plan.md"),
            "---\ntitle: Project evidence plan\ntype: note\n---\n",
        )
        .unwrap();
        fs::write(
            team.path().join("graph/team-method.md"),
            "---\ntitle: Team evidence method\ntype: note\n---\n",
        )
        .unwrap();
        let runtime = GraphRuntime::from_roots(vec![
            GraphSourceRoot::new("private:local", GraphScopeKind::Private, private.path()),
            GraphSourceRoot::new("project:test", GraphScopeKind::Project, project.path()),
            GraphSourceRoot::new("team:main", GraphScopeKind::Team, team.path()),
        ]);

        let team_only = BTreeSet::from(["team:main".into()]);
        let result = runtime
            .query(&GraphQuery {
                scope_ids: team_only.clone(),
                ..GraphQuery::default()
            })
            .unwrap();
        assert_eq!(result.total, 1);
        assert_eq!(result.items[0].id, "team-method");
        assert!(runtime
            .search("Private", &team_only, 10)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn cross_scope_edges_are_written_only_with_their_source_node() {
        let private = TempDir::new().unwrap();
        let team = TempDir::new().unwrap();
        fs::create_dir_all(team.path().join("graph")).unwrap();
        fs::write(
            team.path().join("graph/shared-method.md"),
            "---\ntitle: Shared method\ntype: note\n---\n",
        )
        .unwrap();
        let runtime = GraphRuntime::from_roots(vec![
            GraphSourceRoot::new("private:local", GraphScopeKind::Private, private.path()),
            GraphSourceRoot::new("team:main", GraphScopeKind::Team, team.path()),
        ]);
        let created = runtime
            .create(GraphNodeCreate {
                scope_id: Some("private:local".into()),
                kind: "note".into(),
                title: "My method annotation".into(),
                relations: vec![GraphRelation {
                    relation: "references".into(),
                    target: "shared-method".into(),
                    legacy: false,
                }],
                ..GraphNodeCreate::default()
            })
            .unwrap();

        assert_eq!(created.provenance.scope_id, "private:local");
        assert!(private
            .path()
            .join("graph/my-method-annotation.md")
            .is_file());
        let shared = fs::read_to_string(team.path().join("graph/shared-method.md")).unwrap();
        assert!(!shared.contains("my-method-annotation"));
    }

    #[test]
    fn racing_writers_on_one_node_serialize_to_a_single_winner() {
        let project = graph_root(&[(
            "shared-note.md",
            "---\ntitle: Shared note\ntype: note\n---\nBody.",
        )]);
        let runtime = GraphRuntime::from_roots(vec![GraphSourceRoot::new(
            "project:test",
            GraphScopeKind::Project,
            project.path(),
        )]);
        let token = runtime
            .get("shared-note")
            .unwrap()
            .unwrap()
            .provenance
            .source_revision;

        let results = std::thread::scope(|scope| {
            ["First writer", "Second writer"]
                .map(|title| {
                    let token = token.clone();
                    let runtime = &runtime;
                    scope.spawn(move || {
                        runtime.update(GraphNodePatch {
                            id: "shared-note".into(),
                            expected_revision: Some(token),
                            title: Some(title.into()),
                            ..GraphNodePatch::default()
                        })
                    })
                })
                .map(|handle| handle.join().unwrap())
        });

        let winners = results
            .iter()
            .filter_map(|result| result.as_ref().ok())
            .collect::<Vec<_>>();
        assert_eq!(winners.len(), 1, "exactly one racing writer must win");
        assert!(
            results
                .iter()
                .any(|result| matches!(result, Err(GraphMutationError::Conflict { .. }))),
            "the losing writer must see a clean conflict: {results:?}"
        );

        let path = project.path().join("graph/shared-note.md");
        let on_disk = parsed_clean_graph(&path);
        assert_eq!(on_disk.title, winners[0].title);
        assert_eq!(
            runtime.get("shared-note").unwrap().unwrap().title,
            winners[0].title
        );
    }

    #[test]
    fn racing_writers_on_distinct_nodes_both_commit_valid_sources() {
        let project = graph_root(&[
            ("alpha.md", "---\ntitle: Alpha\ntype: note\n---\n"),
            ("beta.md", "---\ntitle: Beta\ntype: note\n---\n"),
        ]);
        let runtime = GraphRuntime::from_roots(vec![GraphSourceRoot::new(
            "project:test",
            GraphScopeKind::Project,
            project.path(),
        )]);

        let results = std::thread::scope(|scope| {
            ["alpha", "beta"]
                .map(|id| {
                    let token = runtime.get(id).unwrap().unwrap().provenance.source_revision;
                    let runtime = &runtime;
                    scope.spawn(move || {
                        runtime.update(GraphNodePatch {
                            id: id.into(),
                            expected_revision: Some(token),
                            title: Some(format!("{id} rewritten")),
                            ..GraphNodePatch::default()
                        })
                    })
                })
                .map(|handle| handle.join().unwrap())
        });
        for result in results {
            result.unwrap();
        }

        for id in ["alpha", "beta"] {
            let path = project.path().join(format!("graph/{id}.md"));
            assert_eq!(parsed_clean_graph(&path).title, format!("{id} rewritten"));
            assert_eq!(
                runtime.get(id).unwrap().unwrap().title,
                format!("{id} rewritten")
            );
        }
    }

    #[test]
    fn refresh_racing_a_writer_never_harms_the_source_and_reconverges() {
        let project = graph_root(&[("race-note.md", "---\ntitle: Race note\ntype: note\n---\n")]);
        let runtime = GraphRuntime::from_roots(vec![GraphSourceRoot::new(
            "project:test",
            GraphScopeKind::Project,
            project.path(),
        )]);
        let token = runtime
            .get("race-note")
            .unwrap()
            .unwrap()
            .provenance
            .source_revision;

        std::thread::scope(|scope| {
            let refresher = scope.spawn(|| runtime.refresh(Vec::new()));
            let writer = scope.spawn(|| {
                runtime.update(GraphNodePatch {
                    id: "race-note".into(),
                    expected_revision: Some(token.clone()),
                    title: Some("Rewritten during refresh".into()),
                    ..GraphNodePatch::default()
                })
            });
            refresher.join().unwrap().unwrap();
            writer.join().unwrap().unwrap();
        });

        // Whatever the interleaving, the Markdown source holds the writer's
        // committed content and stays parseable.
        let path = project.path().join("graph/race-note.md");
        assert_eq!(parsed_clean_graph(&path).title, "Rewritten during refresh");

        // NOTE: captures current behavior. refresh() loads the graph from disk
        // without holding the store lock, so a write that commits between that
        // load and the store swap can be missing from the in-memory index until
        // the next refresh; the source file itself is never harmed. A follow-up
        // refresh must converge the index to the on-disk state.
        runtime.refresh(Vec::new()).unwrap();
        assert_eq!(
            runtime.get("race-note").unwrap().unwrap().title,
            "Rewritten during refresh"
        );
        assert_eq!(runtime.open_result().unwrap().node_count, 1);
    }

    #[test]
    fn authored_source_revisions_do_not_hide_a_later_external_edit() {
        let project = TempDir::new().unwrap();
        fs::create_dir_all(project.path().join("graph")).unwrap();
        let runtime = GraphRuntime::from_roots(vec![GraphSourceRoot::new(
            "project:test",
            GraphScopeKind::Project,
            project.path(),
        )]);

        let created = runtime
            .create(GraphNodeCreate {
                kind: "issue".into(),
                title: "Check grant".into(),
                tags: vec!["funding".into()],
                ..GraphNodeCreate::default()
            })
            .unwrap();
        runtime
            .record_mutation(
                "graph.create",
                GraphActor::human(),
                None,
                Some(created.clone()),
                created.provenance.source_path.clone(),
            )
            .unwrap();
        runtime
            .refresh(vec![created.provenance.source_path.clone()])
            .unwrap();

        assert_eq!(runtime.get(&created.id).unwrap().unwrap().tags, ["funding"]);
        assert!(runtime.pending_source_revisions.lock().unwrap().is_empty());
        let events = runtime.events(&GraphEventQuery::default()).unwrap();
        assert_eq!(events.items.len(), 1);
        assert_eq!(events.items[0].action, "graph.create");

        let external = fs::read_to_string(&created.provenance.source_path)
            .unwrap()
            .replace("funding", "research");
        fs::write(&created.provenance.source_path, external).unwrap();
        runtime
            .refresh(vec![created.provenance.source_path.clone()])
            .unwrap();

        assert_eq!(
            runtime.get(&created.id).unwrap().unwrap().tags,
            ["research"]
        );
        let events = runtime.events(&GraphEventQuery::default()).unwrap();
        assert_eq!(events.total, 2);
        assert_eq!(events.items[0].action, "external.file-change");
        let earlier = runtime
            .events(&GraphEventQuery {
                offset: 1,
                ..GraphEventQuery::default()
            })
            .unwrap();
        assert_eq!(earlier.items[0].action, "graph.create");
    }

    #[test]
    fn event_history_filters_from_an_inclusive_timestamp() {
        let runtime = GraphRuntime::default();
        let event = |id: &str, timestamp: &str| GraphEvent {
            id: id.into(),
            event_type: "updated".into(),
            action: "graph.update".into(),
            timestamp: timestamp.into(),
            graph_revision: 1,
            node_id: "issue-1".into(),
            node_kind: "issue".into(),
            title: "Review evidence".into(),
            scope_id: "project:test".into(),
            source_path: "/project/graph/issue-1.md".into(),
            summary: "Updated Review evidence".into(),
            actor: GraphActor::human(),
            changes: Vec::new(),
            data: Map::new(),
        };
        {
            let mut events = runtime.events.lock().unwrap();
            events.push_back(event("newer", "2026-07-29T10:00:00Z"));
            events.push_back(event("boundary", "2026-07-20T00:00:00Z"));
            events.push_back(event("older", "2026-07-19T23:59:59Z"));
        }

        let page = runtime
            .events(&GraphEventQuery {
                since: Some("2026-07-20T00:00:00Z".into()),
                limit: 500,
                ..GraphEventQuery::default()
            })
            .unwrap();

        assert_eq!(
            page.items
                .iter()
                .map(|event| event.id.as_str())
                .collect::<Vec<_>>(),
            ["newer", "boundary"]
        );
        assert!(runtime
            .events(&GraphEventQuery {
                since: Some("not-a-date".into()),
                ..GraphEventQuery::default()
            })
            .unwrap_err()
            .contains("Invalid graph event 'since' timestamp"));
    }

    #[test]
    fn recently_deleted_sources_can_be_restored_from_an_opaque_undo_token() {
        let project = TempDir::new().unwrap();
        fs::create_dir_all(project.path().join("graph")).unwrap();
        let path = project.path().join("graph/decision.md");
        let raw = "---\ntitle: Reversible decision\ntype: decision\n---\nKeep the rationale.";
        fs::write(&path, raw).unwrap();
        let runtime = GraphRuntime::from_roots(vec![GraphSourceRoot::new(
            "project:test",
            GraphScopeKind::Project,
            project.path(),
        )]);
        fs::remove_file(&path).unwrap();
        runtime
            .refresh(vec![path.to_string_lossy().into_owned()])
            .unwrap();
        runtime
            .deleted
            .lock()
            .unwrap()
            .push_back(DeletedGraphSource {
                undo_token: "undo-test".into(),
                id: "decision".into(),
                path: path.clone(),
                raw: raw.into(),
            });

        let restored = runtime
            .restore(GraphRestoreRequest {
                undo_token: "undo-test".into(),
            })
            .unwrap();
        assert_eq!(restored.id, "decision");
        assert_eq!(fs::read_to_string(path).unwrap(), raw);
        assert!(runtime.deleted.lock().unwrap().is_empty());
    }
}
