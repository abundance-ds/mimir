//! Stable workspace identity and its optional semantic Project association.
//!
//! The descriptor travels with the folder. The registry is a rebuildable local
//! index that resolves semantic Project ids to paths available on this machine.

use crate::{
    ai_models::app_config_dir,
    persistence::{
        load_json_optional_quarantining, write_bytes_atomic, write_json_atomic, QuarantinedLoad,
    },
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
};
use uuid::Uuid;

const DESCRIPTOR_VERSION: u32 = 1;
const DESCRIPTOR_RELATIVE_PATH: &str = ".mimir/workspace.toml";
const REGISTRY_FILE: &str = "workspaces.json";

static WORKSPACE_IO: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkspaceGraphScope {
    #[default]
    Team,
    Workspace,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceConfig {
    #[serde(default = "descriptor_version")]
    pub version: u32,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "project")]
    pub project_id: Option<String>,
    #[serde(default, rename = "graphScope")]
    pub graph_scope: WorkspaceGraphScope,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceConfigDraft {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default, rename = "project")]
    pub project_id: Option<String>,
    #[serde(default, rename = "graphScope")]
    pub graph_scope: WorkspaceGraphScope,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalWorkspaceRef {
    pub id: String,
    pub name: String,
    pub path: String,
    pub graph_scope: WorkspaceGraphScope,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistryEntry {
    id: String,
    name: String,
    path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    project_id: Option<String>,
    graph_scope: WorkspaceGraphScope,
    last_seen: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
struct WorkspaceRegistry {
    #[serde(default)]
    workspaces: Vec<RegistryEntry>,
}

fn descriptor_version() -> u32 {
    DESCRIPTOR_VERSION
}

fn lock_workspace_io() -> MutexGuard<'static, ()> {
    WORKSPACE_IO
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn canonical_workspace(path: impl AsRef<Path>) -> Result<PathBuf, String> {
    let raw = path.as_ref();
    let canonical = fs::canonicalize(raw)
        .map_err(|error| format!("Could not resolve workspace '{}': {error}", raw.display()))?;
    if !canonical.is_dir() {
        return Err(format!(
            "Workspace is not a directory: {}",
            canonical.display()
        ));
    }
    Ok(canonical)
}

fn descriptor_path(workspace: &Path) -> PathBuf {
    workspace.join(DESCRIPTOR_RELATIVE_PATH)
}

fn registry_path() -> Result<PathBuf, String> {
    Ok(app_config_dir()?.join(REGISTRY_FILE))
}

fn load_descriptor_at(workspace: &Path) -> Result<Option<WorkspaceConfig>, String> {
    let path = descriptor_path(workspace);
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Could not read {}: {error}", path.display())),
    };
    let config: WorkspaceConfig = toml::from_str(&raw).map_err(|error| {
        format!(
            "Invalid workspace configuration '{}': {error}",
            path.display()
        )
    })?;
    validate_config(&config)?;
    Ok(Some(config))
}

fn validate_config(config: &WorkspaceConfig) -> Result<(), String> {
    if config.version != DESCRIPTOR_VERSION {
        return Err(format!(
            "Unsupported workspace configuration version: {}",
            config.version
        ));
    }
    if config.id.trim().is_empty() {
        return Err("Workspace id must not be empty.".into());
    }
    if config
        .project_id
        .as_deref()
        .is_some_and(|value| value.trim().is_empty())
    {
        return Err("Workspace Project id must not be empty.".into());
    }
    Ok(())
}

fn write_descriptor_at(workspace: &Path, config: &WorkspaceConfig) -> Result<(), String> {
    let path = descriptor_path(workspace);
    let raw = toml::to_string_pretty(config)
        .map_err(|error| format!("Could not serialize workspace configuration: {error}"))?;
    write_bytes_atomic(&path, raw.as_bytes())
        .map_err(|error| format!("Could not write {}: {error}", path.display()))
}

fn load_registry_at(path: &Path) -> Result<WorkspaceRegistry, String> {
    match load_json_optional_quarantining::<WorkspaceRegistry>(path)
        .map_err(|error| error.to_string())?
    {
        QuarantinedLoad::Loaded(registry) => Ok(registry),
        QuarantinedLoad::Missing => Ok(WorkspaceRegistry::default()),
        QuarantinedLoad::Quarantined { path, reason } => {
            eprintln!(
                "[workspace_config] Invalid registry moved to {}: {reason}",
                path.display()
            );
            Ok(WorkspaceRegistry::default())
        }
    }
}

fn register_at(
    registry_path: &Path,
    workspace: &Path,
    config: &WorkspaceConfig,
) -> Result<(), String> {
    let mut registry = load_registry_at(registry_path)?;
    let path = workspace.to_string_lossy().into_owned();
    let name = workspace
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Workspace")
        .to_string();
    let entry = RegistryEntry {
        id: config.id.clone(),
        name,
        path: path.clone(),
        project_id: config.project_id.clone(),
        graph_scope: config.graph_scope,
        last_seen: Utc::now().to_rfc3339(),
    };
    if let Some(existing) = registry
        .workspaces
        .iter_mut()
        .find(|candidate| candidate.path == path || candidate.id == config.id)
    {
        *existing = entry;
    } else {
        registry.workspaces.push(entry);
    }
    registry
        .workspaces
        .sort_by(|left, right| right.last_seen.cmp(&left.last_seen));
    write_json_atomic(registry_path, &registry).map_err(|error| error.to_string())
}

fn load_and_register_at(
    workspace: &Path,
    registry_path: &Path,
) -> Result<Option<WorkspaceConfig>, String> {
    let config = load_descriptor_at(workspace)?;
    if let Some(config) = &config {
        register_at(registry_path, workspace, config)?;
    }
    Ok(config)
}

fn save_at(
    workspace: &Path,
    registry_path: &Path,
    draft: WorkspaceConfigDraft,
) -> Result<WorkspaceConfig, String> {
    let existing = load_descriptor_at(workspace)?;
    let project_id = draft
        .project_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let id = draft
        .id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| existing.map(|config| config.id))
        .unwrap_or_else(|| format!("ws-{}", Uuid::new_v4().simple()));
    let config = WorkspaceConfig {
        version: DESCRIPTOR_VERSION,
        id,
        project_id,
        graph_scope: draft.graph_scope,
    };
    validate_config(&config)?;
    write_descriptor_at(workspace, &config)?;
    register_at(registry_path, workspace, &config)?;
    Ok(config)
}

pub fn load_workspace_config(path: impl AsRef<Path>) -> Result<Option<WorkspaceConfig>, String> {
    let _guard = lock_workspace_io();
    let workspace = canonical_workspace(path)?;
    load_and_register_at(&workspace, &registry_path()?)
}

pub fn read_workspace_config(path: impl AsRef<Path>) -> Result<Option<WorkspaceConfig>, String> {
    let _guard = lock_workspace_io();
    let workspace = canonical_workspace(path)?;
    load_descriptor_at(&workspace)
}

pub fn local_workspace_refs(project_id: &str) -> Result<Vec<LocalWorkspaceRef>, String> {
    let _guard = lock_workspace_io();
    local_workspace_refs_at(Path::new(&registry_path()?), project_id)
}

fn local_workspace_refs_at(
    registry_path: &Path,
    project_id: &str,
) -> Result<Vec<LocalWorkspaceRef>, String> {
    let registry = load_registry_at(registry_path)?;
    let mut refs = Vec::new();
    for entry in registry
        .workspaces
        .into_iter()
        .filter(|entry| entry.project_id.as_deref() == Some(project_id))
    {
        let workspace = PathBuf::from(&entry.path);
        if !workspace.is_dir() {
            continue;
        }
        let Ok(Some(config)) = load_descriptor_at(&workspace) else {
            continue;
        };
        if config.id != entry.id || config.project_id.as_deref() != Some(project_id) {
            continue;
        }
        refs.push(LocalWorkspaceRef {
            id: config.id,
            name: entry.name,
            path: entry.path,
            graph_scope: config.graph_scope,
        });
    }
    refs.sort_by(|left, right| left.name.cmp(&right.name).then(left.path.cmp(&right.path)));
    refs.dedup_by(|left, right| left.path == right.path);
    Ok(refs)
}

pub fn enrich_graph_result(tool: &str, value: &mut Value) {
    match tool {
        "graph.get" => enrich_project_value(value),
        "graph.find" => {
            if let Some(items) = value.get_mut("items").and_then(Value::as_array_mut) {
                for item in items {
                    enrich_project_value(item);
                }
            }
        }
        "graph.context" => {
            if let Some(nodes) = value.get_mut("nodes").and_then(Value::as_array_mut) {
                for node in nodes {
                    enrich_project_value(node);
                }
            }
        }
        _ => {}
    }
}

fn enrich_project_value(value: &mut Value) {
    if value.get("kind").and_then(Value::as_str) != Some("project") {
        return;
    }
    let Some(id) = value.get("id").and_then(Value::as_str) else {
        return;
    };
    let Ok(refs) = local_workspace_refs(id) else {
        return;
    };
    if refs.is_empty() {
        return;
    }
    if let Some(object) = value.as_object_mut() {
        if let Ok(serialized) = serde_json::to_value(refs) {
            object.insert("localWorkspaces".into(), serialized);
        }
    }
}

#[tauri::command]
pub fn workspace_config_load(workspace: String) -> Result<Option<WorkspaceConfig>, String> {
    load_workspace_config(workspace)
}

#[tauri::command]
pub fn workspace_config_save(
    workspace: String,
    config: WorkspaceConfigDraft,
) -> Result<WorkspaceConfig, String> {
    let _guard = lock_workspace_io();
    let workspace = canonical_workspace(workspace)?;
    save_at(&workspace, &registry_path()?, config)
}

#[tauri::command]
pub fn workspace_project_paths(project_id: String) -> Result<Vec<LocalWorkspaceRef>, String> {
    local_workspace_refs(project_id.trim())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn descriptor_round_trips_and_registry_resolves_the_project() {
        let root = tempdir().unwrap();
        let workspace = root.path().join("Vandage model");
        fs::create_dir(&workspace).unwrap();
        let registry = root.path().join("workspaces.json");
        let saved = save_at(
            &workspace,
            &registry,
            WorkspaceConfigDraft {
                id: None,
                project_id: Some("vandage-engagement".into()),
                graph_scope: WorkspaceGraphScope::Team,
            },
        )
        .unwrap();

        assert!(saved.id.starts_with("ws-"));
        assert_eq!(load_descriptor_at(&workspace).unwrap(), Some(saved.clone()));
        assert_eq!(
            local_workspace_refs_at(&registry, "vandage-engagement").unwrap(),
            vec![LocalWorkspaceRef {
                id: saved.id,
                name: "Vandage model".into(),
                path: workspace.to_string_lossy().into_owned(),
                graph_scope: WorkspaceGraphScope::Team,
            }]
        );
    }

    #[test]
    fn saving_again_preserves_identity_and_updates_the_link() {
        let root = tempdir().unwrap();
        let workspace = root.path().join("work");
        fs::create_dir(&workspace).unwrap();
        let registry = root.path().join("workspaces.json");
        let first = save_at(
            &workspace,
            &registry,
            WorkspaceConfigDraft {
                id: None,
                project_id: None,
                graph_scope: WorkspaceGraphScope::Team,
            },
        )
        .unwrap();
        let second = save_at(
            &workspace,
            &registry,
            WorkspaceConfigDraft {
                id: None,
                project_id: Some("project-alpha".into()),
                graph_scope: WorkspaceGraphScope::Workspace,
            },
        )
        .unwrap();

        assert_eq!(second.id, first.id);
        assert_eq!(second.project_id.as_deref(), Some("project-alpha"));
        assert_eq!(second.graph_scope, WorkspaceGraphScope::Workspace);
        assert!(local_workspace_refs_at(&registry, "missing")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn stale_registry_entries_are_not_returned() {
        let root = tempdir().unwrap();
        let workspace = root.path().join("gone");
        fs::create_dir(&workspace).unwrap();
        let registry = root.path().join("workspaces.json");
        save_at(
            &workspace,
            &registry,
            WorkspaceConfigDraft {
                id: None,
                project_id: Some("project-alpha".into()),
                graph_scope: WorkspaceGraphScope::Team,
            },
        )
        .unwrap();
        fs::remove_dir_all(&workspace).unwrap();

        assert!(local_workspace_refs_at(&registry, "project-alpha")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn moved_workspace_replaces_its_old_registry_path() {
        let root = tempdir().unwrap();
        let original = root.path().join("original");
        let moved = root.path().join("moved");
        fs::create_dir(&original).unwrap();
        let registry = root.path().join("workspaces.json");
        let saved = save_at(
            &original,
            &registry,
            WorkspaceConfigDraft {
                id: None,
                project_id: Some("project-alpha".into()),
                graph_scope: WorkspaceGraphScope::Team,
            },
        )
        .unwrap();
        fs::rename(&original, &moved).unwrap();

        load_and_register_at(&moved, &registry).unwrap();

        let refs = local_workspace_refs_at(&registry, "project-alpha").unwrap();
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].id, saved.id);
        assert_eq!(refs[0].path, moved.to_string_lossy());
    }

    #[test]
    fn one_invalid_descriptor_does_not_hide_other_project_workspaces() {
        let root = tempdir().unwrap();
        let valid = root.path().join("valid");
        let invalid = root.path().join("invalid");
        fs::create_dir(&valid).unwrap();
        fs::create_dir(&invalid).unwrap();
        let registry = root.path().join("workspaces.json");
        save_at(
            &valid,
            &registry,
            WorkspaceConfigDraft {
                id: None,
                project_id: Some("project-alpha".into()),
                graph_scope: WorkspaceGraphScope::Team,
            },
        )
        .unwrap();
        let invalid_config = save_at(
            &invalid,
            &registry,
            WorkspaceConfigDraft {
                id: None,
                project_id: Some("project-alpha".into()),
                graph_scope: WorkspaceGraphScope::Team,
            },
        )
        .unwrap();
        fs::write(descriptor_path(&invalid), "not valid toml = [").unwrap();

        let refs = local_workspace_refs_at(&registry, "project-alpha").unwrap();
        assert_eq!(refs.len(), 1);
        assert_ne!(refs[0].id, invalid_config.id);
        assert_eq!(refs[0].path, valid.to_string_lossy());
    }
}
