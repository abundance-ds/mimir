//! Quiet Git transport for the managed Team checkout and GitHub Projects.
//!
//! Git is an implementation detail here. The user edits normal files. Mimir
//! batches those edits, keeps one unpublished commit while offline, pulls
//! before it pushes, and retains recovery refs before it rewrites local work.

use crate::{ai_models::app_config_dir, persistence};
use git2::{
    build::CheckoutBuilder, DiffOptions, Index, IndexEntry, IndexTime, Oid, Repository,
    RepositoryState, Signature, Sort, StatusOptions,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeSet, HashMap},
    ffi::OsStr,
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};

const TEAM_DIRECTORY: &str = "team-graph";
const TEAM_MANIFEST: &str = "mimir-team.toml";
const SYNC_MESSAGE: &str = "Mimir sync";
const UNPUBLISHED_CONFIG: &str = "mimir.unpublished";
const UNPUBLISHED_BRANCH_CONFIG: &str = "mimir.unpublishedBranch";
const IDLE_BATCH_SECONDS: u64 = 5 * 60;
const MAX_BATCH_SECONDS: u64 = 30 * 60;
const FETCH_SECONDS: u64 = 5 * 60;
const PROJECT_MAX_BYTES: u64 = 10 * 1024 * 1024;
const TEAM_RESOURCE_MAX_BYTES: u64 = 100 * 1024 * 1024;
const POLL_SECONDS: u64 = 30;
const RECOVERY_REF_LIMIT: usize = 20;
const SYNC_ERROR_EVENT: &str = "mimir://managed-git-error";
const GITHUB_AUTH_UNKNOWN: u8 = 0;
const GITHUB_AUTH_UNAVAILABLE: u8 = 1;
const GITHUB_AUTH_READY: u8 = 2;
static GITHUB_CLI_AUTH: AtomicU8 = AtomicU8::new(GITHUB_AUTH_UNKNOWN);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RepositoryKind {
    Team,
    Project,
}

#[derive(Debug, Clone)]
struct Track {
    kind: RepositoryKind,
    first_change: Option<SystemTime>,
    last_change: Option<SystemTime>,
    signature: String,
    last_fetch: Option<SystemTime>,
    last_synced_at: Option<String>,
    error: Option<String>,
}

impl Track {
    fn new(kind: RepositoryKind) -> Self {
        Self {
            kind,
            first_change: None,
            last_change: None,
            signature: String::new(),
            last_fetch: None,
            last_synced_at: None,
            error: None,
        }
    }
}

#[derive(Default)]
pub struct ManagedGitRuntime {
    tracks: Mutex<HashMap<PathBuf, Track>>,
    repository_locks: Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>,
    installed: AtomicBool,
    tick_running: AtomicBool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedRepositoryStatus {
    managed: bool,
    root: String,
    remote_url: Option<String>,
    state: &'static str,
    pending_changes: usize,
    unpublished: bool,
    excluded: Vec<ManagedExcludedFile>,
    last_synced_at: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedExcludedFile {
    path: String,
    reason: &'static str,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TeamResourceFile {
    path: String,
    size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubConnectionStatus {
    connected: bool,
    git_available: bool,
    cli_available: bool,
    login: Option<String>,
}

impl ManagedGitRuntime {
    fn repository_lock(&self, root: &Path) -> Arc<Mutex<()>> {
        let root = canonical_or_original(root.to_path_buf());
        self.repository_locks
            .lock()
            .unwrap_or_else(|value| value.into_inner())
            .entry(root)
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    fn with_repository_lock<T>(&self, root: &Path, operation: impl FnOnce() -> T) -> T {
        let lock = self.repository_lock(root);
        let _guard = lock.lock().unwrap_or_else(|value| value.into_inner());
        operation()
    }

    pub fn install(&self, app: &AppHandle) {
        if self.installed.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Ok(root) = team_root() {
            if is_valid_team_repository(&root) {
                self.register(root, RepositoryKind::Team);
            }
        }
        let worker_app = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(POLL_SECONDS));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                let app = worker_app.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let runtime = app.state::<ManagedGitRuntime>();
                    runtime.tick(&app);
                });
            }
        });
    }

    fn register(&self, root: PathBuf, kind: RepositoryKind) {
        let normalized = canonical_or_original(root);
        let mut tracks = self
            .tracks
            .lock()
            .unwrap_or_else(|value| value.into_inner());
        tracks
            .entry(normalized)
            .and_modify(|track| track.kind = kind)
            .or_insert_with(|| Track::new(kind));
    }

    fn unregister(&self, root: &Path) {
        let normalized = canonical_or_original(root.to_path_buf());
        self.tracks
            .lock()
            .unwrap_or_else(|value| value.into_inner())
            .remove(&normalized);
    }

    fn status(&self, root: &Path, kind: RepositoryKind) -> Result<ManagedRepositoryStatus, String> {
        self.register(root.to_path_buf(), kind);
        let root = canonical_or_original(root.to_path_buf());
        let repo = match Repository::open(&root) {
            Ok(repo) => repo,
            Err(_) => {
                return Ok(ManagedRepositoryStatus {
                    managed: false,
                    root: root.to_string_lossy().into_owned(),
                    remote_url: None,
                    state: "notConfigured",
                    pending_changes: 0,
                    unpublished: false,
                    excluded: Vec::new(),
                    last_synced_at: None,
                    error: None,
                });
            }
        };
        let scan = scan_changes(&repo, kind)?;
        let track = self
            .tracks
            .lock()
            .unwrap_or_else(|value| value.into_inner())
            .get(&root)
            .cloned()
            .unwrap_or_else(|| Track::new(kind));
        let unpublished = unpublished_oid(&repo).is_some();
        let state = if track.error.is_some() {
            "error"
        } else if !scan.eligible.is_empty() || unpublished {
            "pending"
        } else {
            "synced"
        };
        Ok(ManagedRepositoryStatus {
            managed: true,
            root: root.to_string_lossy().into_owned(),
            remote_url: remote_url(&repo),
            state,
            pending_changes: scan.eligible.len(),
            unpublished,
            excluded: scan.excluded,
            last_synced_at: track.last_synced_at,
            error: track.error,
        })
    }

    fn tick(&self, app: &AppHandle) {
        if self.tick_running.swap(true, Ordering::SeqCst) {
            return;
        }
        let roots = self
            .tracks
            .lock()
            .unwrap_or_else(|value| value.into_inner())
            .iter()
            .map(|(path, track)| (path.clone(), track.kind))
            .collect::<Vec<_>>();
        for (root, kind) in roots {
            self.tick_repository(app, &root, kind);
        }
        self.tick_running.store(false, Ordering::SeqCst);
    }

    fn tick_repository(&self, app: &AppHandle, root: &Path, kind: RepositoryKind) {
        self.with_repository_lock(root, || self.tick_repository_locked(app, root, kind));
    }

    fn tick_repository_locked(&self, app: &AppHandle, root: &Path, kind: RepositoryKind) {
        let now = SystemTime::now();
        let Ok(repo) = Repository::open(root) else {
            return;
        };
        let Ok(scan) = scan_changes(&repo, kind) else {
            return;
        };
        let signature = scan.signature;
        let (sync_due, fetch_due) = {
            let mut tracks = self
                .tracks
                .lock()
                .unwrap_or_else(|value| value.into_inner());
            let track = tracks
                .entry(root.to_path_buf())
                .or_insert_with(|| Track::new(kind));
            if !scan.eligible.is_empty() {
                if track.first_change.is_none() {
                    track.first_change = Some(now);
                    track.last_change = Some(now);
                }
                if track.signature != signature {
                    track.signature = signature;
                    track.last_change = Some(now);
                }
            } else {
                track.first_change = None;
                track.last_change = None;
                track.signature.clear();
            }
            let unpublished = unpublished_oid(&repo).is_some();
            due_actions(track, !scan.eligible.is_empty(), unpublished, now)
        };
        if !sync_due && !fetch_due {
            return;
        }
        let result = if sync_due {
            sync_repository(root, kind)
        } else {
            fetch_and_integrate(root, kind)
        };
        self.record_result(app, root, kind, now, result, sync_due);
    }

    fn sync_on_activation(&self, app: &AppHandle, root: &Path, kind: RepositoryKind) {
        self.with_repository_lock(root, || self.sync_on_activation_locked(app, root, kind));
    }

    fn sync_on_activation_locked(&self, app: &AppHandle, root: &Path, kind: RepositoryKind) {
        let now = SystemTime::now();
        let result = Repository::open(root)
            .map_err(|error| format!("Could not open managed repository: {error}"))
            .and_then(|repo| {
                let scan = scan_changes(&repo, kind)?;
                if activation_requires_publish(
                    !scan.eligible.is_empty(),
                    unpublished_oid(&repo).is_some(),
                ) {
                    sync_repository(root, kind).map(|_| true)
                } else {
                    fetch_and_integrate(root, kind).map(|_| scan.eligible.is_empty())
                }
            });
        match result {
            Ok(completed_batch) => {
                self.record_result(app, root, kind, now, Ok(()), completed_batch)
            }
            Err(error) => self.record_result(app, root, kind, now, Err(error), false),
        }
    }

    fn record_result(
        &self,
        app: &AppHandle,
        root: &Path,
        kind: RepositoryKind,
        now: SystemTime,
        result: Result<(), String>,
        completed_batch: bool,
    ) {
        let mut tracks = self
            .tracks
            .lock()
            .unwrap_or_else(|value| value.into_inner());
        let track = tracks
            .entry(root.to_path_buf())
            .or_insert_with(|| Track::new(kind));
        track.last_fetch = Some(now);
        match result {
            Ok(()) => {
                track.error = None;
                if completed_batch {
                    track.last_synced_at = Some(chrono::Utc::now().to_rfc3339());
                    track.first_change = None;
                    track.last_change = None;
                    track.signature.clear();
                }
            }
            Err(error) if is_transient_network_error(&error) => {
                // Offline work is expected. The unpublished commit is the queue.
                track.error = None;
            }
            Err(error) => {
                let _ = app.emit(
                    SYNC_ERROR_EVENT,
                    serde_json::json!({
                        "root": root.to_string_lossy(),
                        "message": error,
                    }),
                );
                track.error = Some(error);
            }
        }
    }

    pub fn flush(&self) {
        let roots = self
            .tracks
            .lock()
            .unwrap_or_else(|value| value.into_inner())
            .iter()
            .map(|(path, track)| (path.clone(), track.kind))
            .collect::<Vec<_>>();
        for (root, kind) in roots {
            let result = self.with_repository_lock(&root, || commit_pending(&root, kind));
            if let Err(error) = result {
                log::warn!(
                    "Could not close managed Git batch for {}: {error}",
                    root.display()
                );
            }
        }
    }

    fn emit_recorded_errors(&self, app: &AppHandle) {
        let errors = self
            .tracks
            .lock()
            .unwrap_or_else(|value| value.into_inner())
            .iter()
            .filter_map(|(root, track)| {
                track
                    .error
                    .as_ref()
                    .map(|message| (root.clone(), message.clone()))
            })
            .collect::<Vec<_>>();
        for (root, message) in errors {
            let _ = app.emit(
                SYNC_ERROR_EVENT,
                serde_json::json!({
                    "root": root.to_string_lossy(),
                    "message": message,
                }),
            );
        }
    }
}

fn elapsed(value: Option<SystemTime>, now: SystemTime) -> u64 {
    value
        .and_then(|value| now.duration_since(value).ok())
        .map(|value| value.as_secs())
        .unwrap_or(u64::MAX)
}

fn due_actions(
    track: &Track,
    has_changes: bool,
    unpublished: bool,
    now: SystemTime,
) -> (bool, bool) {
    let idle = elapsed(track.last_change, now) >= IDLE_BATCH_SECONDS;
    let old = elapsed(track.first_change, now) >= MAX_BATCH_SECONDS;
    let sync_due = if has_changes {
        idle || old
    } else {
        unpublished
    };
    let fetch_due = elapsed(track.last_fetch, now) >= FETCH_SECONDS;
    (sync_due, fetch_due)
}

fn activation_requires_publish(has_changes: bool, unpublished: bool) -> bool {
    !has_changes && unpublished
}

fn canonical_or_original(path: PathBuf) -> PathBuf {
    fs::canonicalize(&path).unwrap_or(path)
}

fn unmanaged_status(root: PathBuf, state: &'static str) -> ManagedRepositoryStatus {
    ManagedRepositoryStatus {
        managed: false,
        root: root.to_string_lossy().into_owned(),
        remote_url: None,
        state,
        pending_changes: 0,
        unpublished: false,
        excluded: Vec::new(),
        last_synced_at: None,
        error: None,
    }
}

pub fn team_root() -> Result<PathBuf, String> {
    Ok(app_config_dir()?.join(TEAM_DIRECTORY))
}

#[derive(Debug, Deserialize)]
struct TeamManifest {
    version: u64,
    name: String,
}

fn validate_team_repository(root: &Path, require_github: bool) -> Result<(), String> {
    if !root.join(".git").is_dir() {
        return Err("The Team location has no .git folder.".into());
    }
    let repo = Repository::open(root)
        .map_err(|_| "The Team location is not a Git repository.".to_string())?;
    let raw = fs::read_to_string(root.join(TEAM_MANIFEST))
        .map_err(|_| "The Team repository has no valid mimir-team.toml file.".to_string())?;
    let manifest = toml::from_str::<TeamManifest>(&raw)
        .map_err(|_| "The Team repository has an invalid mimir-team.toml file.".to_string())?;
    if manifest.version != 1 || manifest.name.trim().is_empty() {
        return Err("mimir-team.toml must contain version = 1 and a Team name.".into());
    }
    if !root.join("graph").is_dir() || !root.join("resources").is_dir() {
        return Err("The Team repository must contain graph and resources folders.".into());
    }
    let origin =
        remote_url(&repo).ok_or_else(|| "The Team repository has no origin remote.".to_string())?;
    if require_github {
        validate_github_remote_url(&origin)?;
    }
    Ok(())
}

pub(crate) fn is_valid_team_repository(root: &Path) -> bool {
    validate_team_repository(root, true).is_ok()
}

pub fn team_scope_root() -> Result<Option<PathBuf>, String> {
    Ok(team_scope_root_at(&team_root()?))
}

fn team_scope_root_at(root: &Path) -> Option<PathBuf> {
    is_valid_team_repository(root).then(|| root.to_path_buf())
}

#[tauri::command]
pub fn team_resource_import(
    runtime: tauri::State<'_, ManagedGitRuntime>,
    source: String,
) -> Result<String, String> {
    let root = team_root()?;
    runtime.with_repository_lock(&root, || import_team_resource_at(&root, &source))
}

#[tauri::command]
pub fn team_resource_list() -> Result<Vec<TeamResourceFile>, String> {
    list_team_resources_at(&team_root()?)
}

pub(crate) fn import_team_resource(source: &str) -> Result<String, String> {
    import_team_resource_at(&team_root()?, source)
}

fn import_team_resource_at(root: &Path, source: &str) -> Result<String, String> {
    let source = fs::canonicalize(source)
        .map_err(|error| format!("Could not open the selected resource: {error}"))?;
    if !source.is_file() {
        return Err("Select one file to add as a Team resource.".into());
    }
    let size = source.metadata().map_err(|error| error.to_string())?.len();
    if size > TEAM_RESOURCE_MAX_BYTES {
        return Err("Team resources must be 100 MB or smaller for GitHub sync.".into());
    }
    if !is_valid_team_repository(root) {
        return Err("Set up Team before adding a shared resource.".into());
    }
    let file_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "The selected file name is invalid.".to_string())?;
    let resources = root.join("resources");
    fs::create_dir_all(&resources).map_err(|error| error.to_string())?;
    let destination = available_resource_path(&resources, file_name);
    let bytes = fs::read(&source)
        .map_err(|error| format!("Could not read {}: {error}", source.display()))?;
    persistence::write_bytes_atomic(&destination, &bytes)
        .map_err(|error| format!("Could not add the Team resource: {error}"))?;
    Ok(format!(
        "resources/{}",
        destination.file_name().unwrap().to_string_lossy()
    ))
}

fn list_team_resources_at(root: &Path) -> Result<Vec<TeamResourceFile>, String> {
    if !is_valid_team_repository(root) {
        return Err("Set up Team before viewing shared resources.".into());
    }
    let resources = root.join("resources");
    let mut directories = vec![resources.clone()];
    let mut files = Vec::new();
    while let Some(directory) = directories.pop() {
        let entries = fs::read_dir(&directory)
            .map_err(|error| format!("Could not read Team resources: {error}"))?;
        for entry in entries {
            let entry = entry.map_err(|error| format!("Could not read Team resources: {error}"))?;
            let file_type = entry
                .file_type()
                .map_err(|error| format!("Could not inspect a Team resource: {error}"))?;
            if file_type.is_symlink() {
                continue;
            }
            let path = entry.path();
            if file_type.is_dir() {
                directories.push(path);
                continue;
            }
            if !file_type.is_file() || entry.file_name() == ".gitkeep" {
                continue;
            }
            let relative = path
                .strip_prefix(root)
                .map_err(|_| "A Team resource is outside the Team repository.".to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            files.push(TeamResourceFile {
                path: relative,
                size: entry
                    .metadata()
                    .map_err(|error| format!("Could not inspect a Team resource: {error}"))?
                    .len(),
            });
        }
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

fn available_resource_path(resources: &Path, file_name: &str) -> PathBuf {
    let initial = resources.join(file_name);
    if !initial.exists() {
        return initial;
    }
    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("resource");
    let extension = path.extension().and_then(|value| value.to_str());
    for number in 2..10_000 {
        let name = match extension {
            Some(extension) => format!("{stem}-{number}.{extension}"),
            None => format!("{stem}-{number}"),
        };
        let candidate = resources.join(name);
        if !candidate.exists() {
            return candidate;
        }
    }
    resources.join(format!("resource-{}", uuid::Uuid::new_v4().simple()))
}

#[tauri::command]
pub fn team_repository_status(
    runtime: tauri::State<'_, ManagedGitRuntime>,
) -> Result<ManagedRepositoryStatus, String> {
    let root = team_root()?;
    if is_valid_team_repository(&root) {
        runtime.status(&root, RepositoryKind::Team)
    } else {
        Ok(unmanaged_status(root, "notConfigured"))
    }
}

#[tauri::command]
pub async fn team_repository_setup(
    runtime: tauri::State<'_, ManagedGitRuntime>,
    remote_url: String,
    team_name: Option<String>,
) -> Result<ManagedRepositoryStatus, String> {
    validate_github_remote_url(remote_url.trim())?;
    let root = team_root()?;
    let lock = runtime.repository_lock(&root);
    let worker_root = root.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.lock().unwrap_or_else(|value| value.into_inner());
        setup_team_repository(&worker_root, remote_url.trim(), team_name.as_deref(), true)
    })
    .await
    .map_err(|error| format!("Team setup task failed: {error}"))??;
    runtime.status(&root, RepositoryKind::Team)
}

#[tauri::command]
pub async fn team_repository_move(
    runtime: tauri::State<'_, ManagedGitRuntime>,
    remote_url: String,
) -> Result<ManagedRepositoryStatus, String> {
    validate_github_remote_url(remote_url.trim())?;
    let root = team_root()?;
    let lock = runtime.repository_lock(&root);
    let worker_root = root.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.lock().unwrap_or_else(|value| value.into_inner());
        move_team_repository(&worker_root, remote_url.trim(), true)
    })
    .await
    .map_err(|error| format!("Team move task failed: {error}"))??;
    runtime.status(&root, RepositoryKind::Team)
}

#[tauri::command]
pub async fn team_repository_sync(
    runtime: tauri::State<'_, ManagedGitRuntime>,
) -> Result<ManagedRepositoryStatus, String> {
    let root = team_root()?;
    validate_team_repository(&root, true)?;
    let lock = runtime.repository_lock(&root);
    let worker_root = root.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.lock().unwrap_or_else(|value| value.into_inner());
        sync_repository(&worker_root, RepositoryKind::Team)
    })
    .await
    .map_err(|error| format!("Team sync task failed: {error}"))??;
    runtime.status(&root, RepositoryKind::Team)
}

#[tauri::command]
pub fn managed_project_status(
    runtime: tauri::State<'_, ManagedGitRuntime>,
    workspace: String,
) -> Result<ManagedRepositoryStatus, String> {
    let root = canonical_or_original(PathBuf::from(&workspace));
    let Ok(repo) = Repository::open(&root) else {
        return Ok(unmanaged_status(root, "notRepository"));
    };
    let remote = remote_url(&repo);
    if automatic_project_remote(&repo).is_none() {
        return Ok(ManagedRepositoryStatus {
            remote_url: remote,
            ..unmanaged_status(root, "manual")
        });
    }
    runtime.status(&root, RepositoryKind::Project)
}

fn automatic_project_remote(repo: &Repository) -> Option<String> {
    remote_url(repo).filter(|remote| validate_github_remote_url(remote).is_ok())
}

#[tauri::command]
pub fn managed_project_set_enabled(
    runtime: tauri::State<'_, ManagedGitRuntime>,
    workspace: String,
    enabled: bool,
    initialize: Option<bool>,
) -> Result<ManagedRepositoryStatus, String> {
    let root = canonical_or_original(PathBuf::from(&workspace));
    runtime.with_repository_lock(&root, || {
        if enabled && Repository::open(&root).is_err() {
            if initialize.unwrap_or(false) {
                Repository::init(&root)
                    .map_err(|error| format!("Could not initialize Project history: {error}"))?;
                ensure_project_ignore(&root)?;
            } else {
                return Err("This Project folder is not a Git repository.".into());
            }
        }
        if enabled && !initialize.unwrap_or(false) {
            let repo = Repository::open(&root)
                .map_err(|_| "This Project folder is not a Git repository.".to_string())?;
            let remote = repo
                .find_remote("origin")
                .ok()
                .and_then(|remote| remote.url().ok().map(str::to_string))
                .ok_or_else(|| "Connect this Project to a GitHub repository first.".to_string())?;
            validate_github_remote_url(&remote)?;
        }
        if enabled {
            runtime.status(&root, RepositoryKind::Project)
        } else {
            runtime.unregister(&root);
            Ok(ManagedRepositoryStatus {
                remote_url: Repository::open(&root)
                    .ok()
                    .and_then(|repo| remote_url(&repo)),
                ..unmanaged_status(
                    root.clone(),
                    if Repository::open(&root).is_ok() {
                        "manual"
                    } else {
                        "notRepository"
                    },
                )
            })
        }
    })
}

fn ensure_project_ignore(root: &Path) -> Result<(), String> {
    let path = root.join(".gitignore");
    if path.exists() {
        return Ok(());
    }
    persistence::write_bytes_atomic(
        path,
        b".DS_Store\nThumbs.db\n.env\n.env.*\n!.env.example\nnode_modules/\n",
    )
    .map_err(|error| format!("Could not create the Project ignore file: {error}"))
}

#[tauri::command]
pub async fn managed_project_set_remote(
    runtime: tauri::State<'_, ManagedGitRuntime>,
    workspace: String,
    remote_url: String,
) -> Result<ManagedRepositoryStatus, String> {
    let root = canonical_or_original(PathBuf::from(&workspace));
    validate_github_remote_url(remote_url.trim())?;
    let lock = runtime.repository_lock(&root);
    let worker_root = root.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.lock().unwrap_or_else(|value| value.into_inner());
        set_project_remote(&worker_root, remote_url.trim(), true)
    })
    .await
    .map_err(|error| format!("Project repository task failed: {error}"))??;
    managed_project_status(runtime, root.to_string_lossy().into_owned())
}

fn set_project_remote(root: &Path, remote_url: &str, require_github: bool) -> Result<(), String> {
    if require_github {
        validate_github_remote_url(remote_url)?;
    }
    let repo = Repository::open(root)
        .map_err(|_| "This Project folder is not a Git repository.".to_string())?;
    match repo.find_remote("origin") {
        Ok(remote) if remote.url().ok() == Some(remote_url) => return Ok(()),
        Ok(_) => return Err("This Project already has a different origin remote.".into()),
        Err(_) => {}
    }
    require_empty_remote(root, remote_url, require_github)?;
    repo.remote("origin", remote_url)
        .map(|_| ())
        .map_err(|error| format!("Could not connect the Project repository: {error}"))
}

fn validate_github_remote_url(remote_url: &str) -> Result<(), String> {
    if let Some(path) = remote_url.strip_prefix("git@github.com:") {
        return validate_github_remote_path(path);
    }
    let parsed = url::Url::parse(remote_url)
        .map_err(|_| "The GitHub repository URL is invalid.".to_string())?;
    let segments = parsed
        .path_segments()
        .map(|segments| {
            segments
                .filter(|segment| !segment.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let valid_path = segments.len() == 2 && !segments[1].trim_end_matches(".git").is_empty();
    let valid_scheme =
        parsed.scheme() == "https" || (parsed.scheme() == "ssh" && parsed.username() == "git");
    if !valid_scheme
        || parsed.host_str() != Some("github.com")
        || (parsed.scheme() == "https" && !parsed.username().is_empty())
        || parsed.password().is_some()
        || parsed.port().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || !valid_path
    {
        return Err("Automatic sync supports GitHub repositories only.".into());
    }
    Ok(())
}

fn validate_github_remote_path(path: &str) -> Result<(), String> {
    let path = path.trim_end_matches('/');
    let segments = path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    if segments.len() == 2
        && !segments[0].is_empty()
        && !segments[1].trim_end_matches(".git").is_empty()
        && !path.contains(['?', '#'])
    {
        Ok(())
    } else {
        Err("The GitHub repository URL is invalid.".into())
    }
}

#[tauri::command]
pub async fn managed_project_sync(
    runtime: tauri::State<'_, ManagedGitRuntime>,
    workspace: String,
) -> Result<ManagedRepositoryStatus, String> {
    let root = canonical_or_original(PathBuf::from(workspace));
    runtime.register(root.clone(), RepositoryKind::Project);
    let lock = runtime.repository_lock(&root);
    let worker_root = root.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.lock().unwrap_or_else(|value| value.into_inner());
        sync_repository(&worker_root, RepositoryKind::Project)
    })
    .await
    .map_err(|error| format!("Project sync task failed: {error}"))??;
    runtime.status(&root, RepositoryKind::Project)
}

#[tauri::command]
pub async fn managed_repositories_sync(
    app: AppHandle,
    runtime: tauri::State<'_, ManagedGitRuntime>,
) -> Result<(), String> {
    // Focus/reconnect requests do not block the renderer. The ordinary error
    // event remains the only UI surface when user action is necessary.
    let roots = runtime
        .tracks
        .lock()
        .unwrap_or_else(|value| value.into_inner())
        .iter()
        .map(|(path, track)| (path.clone(), track.kind))
        .collect::<Vec<_>>();
    if runtime.tick_running.swap(true, Ordering::SeqCst) {
        // A startup tick can report an error just before the renderer installs
        // its listener. Repeat only that in-flight result; an idle runtime
        // retries first so a recovered connection never shows a stale error.
        runtime.emit_recorded_errors(&app);
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let runtime = app.state::<ManagedGitRuntime>();
        for (root, kind) in roots {
            runtime.sync_on_activation(&app, &root, kind);
        }
        runtime.tick_running.store(false, Ordering::SeqCst);
    });
    Ok(())
}

#[tauri::command]
pub async fn github_connection_status() -> Result<GithubConnectionStatus, String> {
    tauri::async_runtime::spawn_blocking(github_cli_status)
        .await
        .map_err(|error| format!("GitHub status task failed: {error}"))
}

#[tauri::command]
pub async fn github_connect() -> Result<GithubConnectionStatus, String> {
    tauri::async_runtime::spawn_blocking(connect_github_cli)
        .await
        .map_err(|error| format!("GitHub sign-in task failed: {error}"))?
}

#[tauri::command]
pub async fn github_disconnect() -> Result<GithubConnectionStatus, String> {
    tauri::async_runtime::spawn_blocking(disconnect_github_cli)
        .await
        .map_err(|error| format!("GitHub sign-out task failed: {error}"))?
}

fn github_cli_status() -> GithubConnectionStatus {
    let git_available = crate::launchers::detect_binary("git").is_ok();
    let Ok(gh) = crate::launchers::detect_binary("gh") else {
        GITHUB_CLI_AUTH.store(GITHUB_AUTH_UNAVAILABLE, Ordering::Relaxed);
        return GithubConnectionStatus {
            connected: false,
            git_available,
            cli_available: false,
            login: None,
        };
    };
    let output = Command::new(gh)
        .args([
            "auth",
            "status",
            "--active",
            "--hostname",
            "github.com",
            "--json",
            "hosts",
        ])
        .env("GH_PROMPT_DISABLED", "1")
        .output();
    let login = output
        .ok()
        .and_then(|output| github_login_from_status(&output.stdout));
    GITHUB_CLI_AUTH.store(
        if login.is_some() {
            GITHUB_AUTH_READY
        } else {
            GITHUB_AUTH_UNAVAILABLE
        },
        Ordering::Relaxed,
    );
    GithubConnectionStatus {
        connected: git_available && login.is_some(),
        git_available,
        cli_available: true,
        login,
    }
}

fn github_login_from_status(bytes: &[u8]) -> Option<String> {
    let value = serde_json::from_slice::<Value>(bytes).ok()?;
    value
        .get("hosts")?
        .get("github.com")?
        .as_array()?
        .iter()
        .find(|account| {
            account.get("active").and_then(Value::as_bool) == Some(true)
                && account.get("state").and_then(Value::as_str) == Some("success")
        })?
        .get("login")?
        .as_str()
        .map(str::to_string)
}

fn connect_github_cli() -> Result<GithubConnectionStatus, String> {
    crate::launchers::detect_binary("git").map_err(|_| {
        "Git is not installed. Install Git, then try GitHub sign-in again.".to_string()
    })?;
    let gh = crate::launchers::detect_binary("gh").map_err(|_| {
        "GitHub CLI is not installed. Install it from cli.github.com, then try again.".to_string()
    })?;
    if !github_cli_status().connected {
        let output = Command::new(&gh)
            .args([
                "auth",
                "login",
                "--hostname",
                "github.com",
                "--git-protocol",
                "https",
                "--web",
                "--clipboard",
                "--scopes",
                "repo",
            ])
            .output()
            .map_err(|error| format!("Could not start GitHub sign-in: {error}"))?;
        require_command_success("GitHub sign-in failed", &output)?;
    }
    let status = github_cli_status();
    if status.connected {
        Ok(status)
    } else {
        Err("GitHub sign-in did not complete. Try again.".into())
    }
}

fn disconnect_github_cli() -> Result<GithubConnectionStatus, String> {
    let gh = crate::launchers::detect_binary("gh")
        .map_err(|_| "GitHub CLI is not installed.".to_string())?;
    let status = github_cli_status();
    let Some(login) = status.login else {
        return Ok(status);
    };
    let output = Command::new(gh)
        .args([
            "auth",
            "logout",
            "--hostname",
            "github.com",
            "--user",
            &login,
        ])
        .env("GH_PROMPT_DISABLED", "1")
        .output()
        .map_err(|error| format!("Could not sign out of GitHub CLI: {error}"))?;
    require_command_success("GitHub CLI sign-out failed", &output)?;
    Ok(github_cli_status())
}

fn require_command_success(prefix: &str, output: &Output) -> Result<(), String> {
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let detail = stderr
        .lines()
        .chain(stdout.lines())
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("Unknown command error");
    Err(format!("{prefix}: {detail}"))
}

fn setup_team_repository(
    root: &Path,
    remote_url: &str,
    team_name: Option<&str>,
    require_github: bool,
) -> Result<(), String> {
    let remote_url = remote_url.trim();
    if require_github {
        validate_github_remote_url(remote_url)?;
    }
    if root.exists() {
        validate_team_repository(root, require_github).map_err(|error| {
            format!(
                "The Team location already exists but is not a valid Team repository. Move it away, then try again. {error}"
            )
        })?;
        let repo = Repository::open(root).map_err(|error| error.to_string())?;
        ensure_origin(&repo, remote_url)?;
        sync_repository(root, RepositoryKind::Team)?;
        return Ok(());
    }

    let parent = root
        .parent()
        .ok_or_else(|| "The managed Team location has no parent folder.".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = parent.join(format!(
        ".{TEAM_DIRECTORY}.setup-{}",
        uuid::Uuid::new_v4().simple()
    ));
    let setup = (|| {
        clone_with_system_git(remote_url, &temporary)?;
        let repo = Repository::open(&temporary)
            .map_err(|error| format!("Could not open the Team repository: {error}"))?;
        let empty = repo.head().is_err();
        drop(repo);
        if empty {
            ensure_team_layout(&temporary, team_name)?;
        } else {
            validate_team_repository(&temporary, require_github)?;
        }
        sync_repository(&temporary, RepositoryKind::Team)?;
        validate_team_repository(&temporary, require_github)?;
        fs::rename(&temporary, root)
            .map_err(|error| format!("Could not install managed Team storage: {error}"))?;
        Ok(())
    })();
    if setup.is_err() {
        let _ = fs::remove_dir_all(&temporary);
    }
    setup
}

fn move_team_repository(
    root: &Path,
    new_remote_url: &str,
    require_github: bool,
) -> Result<(), String> {
    validate_team_repository(root, require_github)?;
    if require_github {
        validate_github_remote_url(new_remote_url)?;
    }
    let repo = Repository::open(root)
        .map_err(|error| format!("Could not open the Team repository: {error}"))?;
    let previous_remote =
        remote_url(&repo).ok_or_else(|| "The Team repository has no origin remote.".to_string())?;
    if previous_remote == new_remote_url {
        return Ok(());
    }

    require_empty_remote(root, new_remote_url, require_github)
        .map_err(|error| format!("Could not use the new Team repository: {error}"))?;

    // Publish the final local state to the old repository before changing the
    // destination. The old repository remains a complete, remote backup.
    sync_repository(root, RepositoryKind::Team)?;
    let branch = current_branch(&repo)?;
    repo.remote_set_url("origin", new_remote_url)
        .map_err(|error| format!("Could not change the Team repository: {error}"))?;
    let output = run_system_git(root, ["push", "--set-upstream", "origin", branch.as_str()])?;
    if let Err(error) = require_command_success("Could not move Team", &output) {
        let _ = repo.remote_set_url("origin", &previous_remote);
        return Err(error);
    }
    Ok(())
}

fn require_empty_remote(root: &Path, remote_url: &str, github_auth: bool) -> Result<(), String> {
    let output = run_system_git_configured(root, ["ls-remote", "--", remote_url], github_auth)?;
    require_command_success("Could not inspect the repository", &output)?;
    if output.stdout.is_empty() {
        Ok(())
    } else {
        Err("The repository is not empty.".into())
    }
}

fn ensure_origin(repo: &Repository, remote_url: &str) -> Result<(), String> {
    match repo.find_remote("origin") {
        Ok(remote) if remote.url().ok() == Some(remote_url) => Ok(()),
        Ok(_) => Err("The managed Team repository already has a different origin.".into()),
        Err(_) => repo
            .remote("origin", remote_url)
            .map(|_| ())
            .map_err(|error| format!("Could not connect the Team repository: {error}")),
    }
}

fn ensure_team_layout(root: &Path, team_name: Option<&str>) -> Result<(), String> {
    fs::create_dir_all(root.join("graph"))
        .and_then(|_| fs::create_dir_all(root.join("resources")))
        .map_err(|error| format!("Could not create Team folders: {error}"))?;
    let manifest = root.join(TEAM_MANIFEST);
    if !manifest.exists() {
        let name = team_name
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("Team");
        let encoded_name = toml::Value::String(name.to_string()).to_string();
        let raw = format!("version = 1\nname = {encoded_name}\n");
        persistence::write_bytes_atomic(&manifest, raw.as_bytes())
            .map_err(|error| error.to_string())?;
    }
    for marker in [root.join("graph/.gitkeep"), root.join("resources/.gitkeep")] {
        if !marker.exists() {
            persistence::write_bytes_atomic(&marker, b"").map_err(|error| error.to_string())?;
        }
    }
    let ignore = root.join(".gitignore");
    if !ignore.exists() {
        persistence::write_bytes_atomic(&ignore, b".DS_Store\nThumbs.db\n")
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[derive(Debug)]
struct ChangeScan {
    eligible: Vec<PathBuf>,
    excluded: Vec<ManagedExcludedFile>,
    signature: String,
}

fn scan_changes(repo: &Repository, kind: RepositoryKind) -> Result<ChangeScan, String> {
    let workdir = repo
        .workdir()
        .ok_or_else(|| "Bare repositories cannot use automatic sync.".to_string())?;
    let statuses = repo
        .statuses(Some(
            StatusOptions::new()
                .include_untracked(true)
                .recurse_untracked_dirs(true)
                .renames_head_to_index(true)
                .renames_index_to_workdir(true),
        ))
        .map_err(|error| format!("Could not inspect managed files: {error}"))?;
    let mut eligible = Vec::new();
    let mut excluded = Vec::new();
    let mut signature_parts = Vec::new();
    for entry in statuses.iter() {
        let Ok(raw_path) = entry.path() else { continue };
        let path = PathBuf::from(raw_path);
        let absolute = workdir.join(&path);
        if kind == RepositoryKind::Project {
            let reason = project_exclusion_reason(repo, &path, &absolute)?;
            if let Some(reason) = reason {
                excluded.push(ManagedExcludedFile {
                    path: raw_path.to_string(),
                    reason,
                });
                continue;
            }
        }
        eligible.push(path.clone());
        let metadata = fs::symlink_metadata(&absolute).ok();
        let modified = metadata
            .as_ref()
            .and_then(|value| value.modified().ok())
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        let size = metadata.as_ref().map(|value| value.len()).unwrap_or(0);
        signature_parts.push(format!(
            "{raw_path}:{}:{size}:{modified}",
            entry.status().bits()
        ));
    }
    eligible.sort();
    excluded.sort_by(|left, right| left.path.cmp(&right.path));
    signature_parts.sort();
    Ok(ChangeScan {
        eligible,
        excluded,
        signature: signature_parts.join("|"),
    })
}

fn project_exclusion_reason(
    repo: &Repository,
    path: &Path,
    absolute: &Path,
) -> Result<Option<&'static str>, String> {
    if absolute.is_file() {
        let metadata = fs::metadata(absolute)
            .map_err(|error| format!("Could not inspect {}: {error}", absolute.display()))?;
        if metadata.len() > PROJECT_MAX_BYTES {
            return Ok(Some("large"));
        }
        return is_binary_file(absolute).map(|binary| binary.then_some("binary"));
    }
    let blob = repo
        .head()
        .ok()
        .and_then(|head| head.peel_to_tree().ok())
        .and_then(|tree| tree.get_path(path).ok().map(|entry| entry.id()))
        .and_then(|oid| repo.find_blob(oid).ok());
    let Some(blob) = blob else { return Ok(None) };
    if blob.size() as u64 > PROJECT_MAX_BYTES {
        Ok(Some("large"))
    } else if is_binary_bytes(blob.content()) {
        Ok(Some("binary"))
    } else {
        Ok(None)
    }
}

fn is_binary_file(path: &Path) -> Result<bool, String> {
    use std::io::Read;
    let mut file = fs::File::open(path)
        .map_err(|error| format!("Could not inspect {}: {error}", path.display()))?;
    let mut sample = vec![0; 8192];
    let length = file.read(&mut sample).map_err(|error| error.to_string())?;
    sample.truncate(length);
    Ok(is_binary_bytes(&sample))
}

fn is_binary_bytes(bytes: &[u8]) -> bool {
    bytes.contains(&0) || std::str::from_utf8(bytes).is_err()
}

fn commit_pending(root: &Path, kind: RepositoryKind) -> Result<Option<Oid>, String> {
    let repo = Repository::open(root)
        .map_err(|error| format!("Could not open managed repository: {error}"))?;
    let current_unpublished = current_unpublished_oid(&repo)?;
    let scan = scan_changes(&repo, kind)?;
    if scan.eligible.is_empty() {
        return Ok(current_unpublished);
    }
    let mut index = repo.index().map_err(|error| error.to_string())?;
    if let Ok(head_tree) = repo.head().and_then(|head| head.peel_to_tree()) {
        index
            .read_tree(&head_tree)
            .map_err(|error| format!("Could not prepare the managed batch: {error}"))?;
    } else {
        index
            .clear()
            .map_err(|error| format!("Could not prepare the first managed batch: {error}"))?;
    }
    stage_paths(&mut index, repo.workdir().unwrap(), &scan.eligible)?;
    index.write().map_err(|error| error.to_string())?;
    let tree_id = index.write_tree().map_err(|error| error.to_string())?;
    let tree = repo.find_tree(tree_id).map_err(|error| error.to_string())?;
    let signature = repository_signature(&repo)?;
    let existing_unpublished = current_unpublished
        .and_then(|oid| repo.find_commit(oid).ok())
        .filter(|commit| repo.head().ok().and_then(|head| head.target()) == Some(commit.id()));
    let oid = if let Some(previous) = existing_unpublished {
        create_recovery_ref(&repo, previous.id())?;
        let parents = previous.parents().collect::<Vec<_>>();
        let parent_refs = parents.iter().collect::<Vec<_>>();
        rewrite_head_commit(&repo, &signature, SYNC_MESSAGE, &tree, &parent_refs)
    } else {
        let parents = repo
            .head()
            .ok()
            .and_then(|head| head.peel_to_commit().ok())
            .into_iter()
            .collect::<Vec<_>>();
        let parent_refs = parents.iter().collect::<Vec<_>>();
        repo.commit(
            Some("HEAD"),
            &signature,
            &signature,
            SYNC_MESSAGE,
            &tree,
            &parent_refs,
        )
    }
    .map_err(|error| format!("Could not save the managed change batch: {error}"))?;
    mark_unpublished(&repo, oid)?;
    prune_recovery_refs(&repo);
    Ok(Some(oid))
}

fn rewrite_head_commit(
    repo: &Repository,
    signature: &Signature<'_>,
    message: &str,
    tree: &git2::Tree<'_>,
    parents: &[&git2::Commit<'_>],
) -> Result<Oid, git2::Error> {
    let buffer = repo.commit_create_buffer(signature, signature, message, tree, parents)?;
    let oid = repo
        .odb()?
        .write(git2::ObjectType::Commit, buffer.as_ref())?;
    repo.head()?
        .set_target(oid, "Mimir amended unpublished batch")?;
    Ok(oid)
}

fn stage_paths(index: &mut Index, workdir: &Path, paths: &[PathBuf]) -> Result<(), String> {
    for path in paths {
        let absolute = workdir.join(path);
        match fs::symlink_metadata(&absolute) {
            Ok(metadata) if metadata.is_file() || metadata.file_type().is_symlink() => index
                .add_path(path)
                .map_err(|error| format!("Could not include {}: {error}", path.display()))?,
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if index.get_path(path, 0).is_some() {
                    index.remove_path(path).map_err(|error| {
                        format!("Could not include deletion of {}: {error}", path.display())
                    })?;
                }
            }
            Err(error) => return Err(format!("Could not inspect {}: {error}", absolute.display())),
        }
    }
    Ok(())
}

fn repository_signature(repo: &Repository) -> Result<Signature<'static>, String> {
    let config = repo.config().ok();
    let name = config
        .as_ref()
        .and_then(|value| value.get_string("user.name").ok())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "Mimir".into());
    let email = config
        .as_ref()
        .and_then(|value| value.get_string("user.email").ok())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "mimir@localhost".into());
    Signature::now(&name, &email).map_err(|error| error.to_string())
}

fn unpublished_oid(repo: &Repository) -> Option<Oid> {
    repo.config()
        .ok()?
        .get_string(UNPUBLISHED_CONFIG)
        .ok()?
        .parse()
        .ok()
}

fn current_unpublished_oid(repo: &Repository) -> Result<Option<Oid>, String> {
    let Some(oid) = unpublished_oid(repo) else {
        return Ok(None);
    };
    let current = current_branch(repo)?;
    let configured = repo
        .config()
        .ok()
        .and_then(|config| config.get_string(UNPUBLISHED_BRANCH_CONFIG).ok());
    if let Some(branch) = configured {
        if branch != current {
            return Err(format!(
                "The unpublished Mimir batch belongs to branch {branch}. Switch back to {branch} before automatic sync."
            ));
        }
    } else if repo.head().ok().and_then(|head| head.target()) != Some(oid) {
        return Err(
            "The unpublished Mimir batch belongs to another branch. Return to that branch before automatic sync."
                .into(),
        );
    }
    Ok(Some(oid))
}

fn mark_unpublished(repo: &Repository, oid: Oid) -> Result<(), String> {
    let branch = current_branch(repo)?;
    let mut config = repo
        .config()
        .map_err(|error| format!("Could not open the managed Git configuration: {error}"))?;
    config
        .set_str(UNPUBLISHED_BRANCH_CONFIG, &branch)
        .and_then(|_| config.set_str(UNPUBLISHED_CONFIG, &oid.to_string()))
        .map_err(|error| format!("Could not mark the unpublished batch: {error}"))
}

fn clear_unpublished(repo: &Repository) {
    if let Ok(mut config) = repo.config() {
        let _ = config.remove(UNPUBLISHED_CONFIG);
        let _ = config.remove(UNPUBLISHED_BRANCH_CONFIG);
    }
}

fn sync_repository(root: &Path, kind: RepositoryKind) -> Result<(), String> {
    commit_pending(root, kind)?;
    for attempt in 0..3 {
        fetch_and_integrate(root, kind)?;
        let repo = Repository::open(root).map_err(|error| error.to_string())?;
        match push_unpublished(&repo) {
            Ok(()) => return Ok(()),
            Err(error) if push_race(&error) && attempt < 2 => continue,
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn push_race(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    error.contains("branch changed during sync") || error.contains("non-fast-forward")
}

fn fetch_and_integrate(root: &Path, kind: RepositoryKind) -> Result<(), String> {
    let repo = Repository::open(root).map_err(|error| error.to_string())?;
    if repo.find_remote("origin").is_err() {
        return Ok(());
    }
    fetch_origin(&repo)?;
    integrate_origin(&repo, kind)
}

fn fetch_origin(repo: &Repository) -> Result<(), String> {
    let root = repo
        .workdir()
        .ok_or_else(|| "Bare repositories cannot use automatic sync.".to_string())?;
    let output = run_system_git(root, ["fetch", "--prune", "origin"])?;
    require_command_success("Could not pull managed changes", &output)
}

fn integrate_origin(repo: &Repository, kind: RepositoryKind) -> Result<(), String> {
    if repo.state() != RepositoryState::Clean {
        return Err("The managed repository has an unfinished Git operation.".into());
    }
    let current_unpublished = current_unpublished_oid(repo)?;
    let scan = scan_changes(repo, kind)?;
    // A normal text edit is still inside its active batch. Fetching is safe,
    // but integration waits until commit_pending has captured that batch.
    if !scan.eligible.is_empty() {
        return Ok(());
    }
    let excluded_paths = scan
        .excluded
        .iter()
        .map(|entry| PathBuf::from(&entry.path))
        .collect::<BTreeSet<_>>();
    let branch = current_branch(repo)?;
    let remote_ref = format!("refs/remotes/origin/{branch}");
    let local_oid = match repo.head().ok().and_then(|head| head.target()) {
        Some(oid) => oid,
        None => return Ok(()),
    };
    let Ok(remote_reference) = repo.find_reference(&remote_ref) else {
        if current_unpublished.is_none() {
            mark_unpublished(repo, local_oid)?;
        }
        return Ok(());
    };
    let Some(remote_oid) = remote_reference.target() else {
        return Ok(());
    };
    if local_oid == remote_oid {
        return Ok(());
    }
    if repo
        .graph_descendant_of(local_oid, remote_oid)
        .map_err(|error| error.to_string())?
    {
        if current_unpublished.is_none() {
            mark_unpublished(repo, local_oid)?;
        }
        return Ok(());
    }
    if repo
        .graph_descendant_of(remote_oid, local_oid)
        .map_err(|error| error.to_string())?
    {
        let remote_paths = changed_paths(repo, local_oid, remote_oid)?;
        ensure_remote_avoids_excluded(&remote_paths, &excluded_paths)?;
        fast_forward(repo, &branch, remote_oid)?;
        clear_unpublished(repo);
        return Ok(());
    }
    if current_unpublished.is_none() {
        return Err(
            "The managed branch diverged outside Mimir. Open its folder to recover it.".into(),
        );
    }
    let base_oid = repo
        .merge_base(local_oid, remote_oid)
        .map_err(|error| format!("Could not find the managed merge base: {error}"))?;
    let remote_paths = changed_paths(repo, base_oid, remote_oid)?;
    ensure_remote_avoids_excluded(&remote_paths, &excluded_paths)?;
    merge_last_edit_wins(repo, local_oid, remote_oid, base_oid)?;
    Ok(())
}

fn ensure_remote_avoids_excluded(
    remote_paths: &BTreeSet<PathBuf>,
    excluded_paths: &BTreeSet<PathBuf>,
) -> Result<(), String> {
    let Some(path) = remote_paths.intersection(excluded_paths).next() else {
        return Ok(());
    };
    Err(format!(
        "Automatic sync stopped because {} is excluded locally and also changed on GitHub. Move or discard the local file, then try again.",
        path.display()
    ))
}

fn fast_forward(repo: &Repository, branch: &str, target: Oid) -> Result<(), String> {
    let target_commit = repo
        .find_commit(target)
        .map_err(|error| error.to_string())?;
    let target_tree = target_commit.tree().map_err(|error| error.to_string())?;
    repo.checkout_tree(target_tree.as_object(), Some(CheckoutBuilder::new().safe()))
        .map_err(|error| format!("Could not update managed files: {error}"))?;
    let reference_name = format!("refs/heads/{branch}");
    let mut reference = repo
        .find_reference(&reference_name)
        .map_err(|error| error.to_string())?;
    reference
        .set_target(target, "Mimir automatic pull")
        .map_err(|error| format!("Could not apply managed changes: {error}"))?;
    repo.set_head(&reference_name)
        .map_err(|error| error.to_string())
}

fn merge_last_edit_wins(
    repo: &Repository,
    local_oid: Oid,
    remote_oid: Oid,
    base_oid: Oid,
) -> Result<(), String> {
    let local = repo
        .find_commit(local_oid)
        .map_err(|error| error.to_string())?;
    let remote = repo
        .find_commit(remote_oid)
        .map_err(|error| error.to_string())?;
    let mut index = repo
        .merge_commits(&local, &remote, None)
        .map_err(|error| format!("Could not merge managed changes: {error}"))?;
    let local_paths = changed_paths(repo, base_oid, local_oid)?;
    let remote_paths = changed_paths(repo, base_oid, remote_oid)?;
    for path in local_paths.intersection(&remote_paths) {
        let local_time = latest_path_change_time(repo, local_oid, base_oid, path)?;
        let remote_time = latest_path_change_time(repo, remote_oid, base_oid, path)?;
        let winner = if remote_time > local_time {
            remote_oid
        } else {
            local_oid
        };
        replace_index_path_from_commit(repo, &mut index, path, winner)?;
        if path.extension().and_then(|value| value.to_str()) == Some("md")
            && path
                .parent()
                .and_then(Path::file_name)
                .and_then(|name| name.to_str())
                == Some("graph")
        {
            let read = |oid| -> Option<String> {
                let tree = repo.find_commit(oid).ok()?.tree().ok()?;
                let blob = repo.find_blob(tree.get_path(path).ok()?.id()).ok()?;
                std::str::from_utf8(blob.content()).ok().map(str::to_owned)
            };
            if let (Some(base), Some(local), Some(remote)) =
                (read(base_oid), read(local_oid), read(remote_oid))
            {
                if let Some(merged) = crate::business_graph::project_home::merge_sources(
                    path,
                    &base,
                    &local,
                    &remote,
                    remote_time > local_time,
                ) {
                    if let Some(mut entry) = index.get_path(path, 0) {
                        entry.id = repo
                            .blob(merged.as_bytes())
                            .map_err(|error| error.to_string())?;
                        entry.file_size = merged.len() as u32;
                        index.add(&entry).map_err(|error| error.to_string())?;
                    }
                }
            }
        }
    }
    if index.has_conflicts() {
        return Err("Mimir could not resolve a managed file conflict automatically.".into());
    }
    let tree_oid = index
        .write_tree_to(repo)
        .map_err(|error| format!("Could not save the merged managed files: {error}"))?;
    let tree = repo
        .find_tree(tree_oid)
        .map_err(|error| error.to_string())?;
    let signature = repository_signature(repo)?;
    let oid = repo
        .commit(
            None,
            &signature,
            &signature,
            SYNC_MESSAGE,
            &tree,
            &[&local, &remote],
        )
        .map_err(|error| format!("Could not save the managed merge: {error}"))?;
    repo.checkout_tree(tree.as_object(), Some(CheckoutBuilder::new().safe()))
        .map_err(|error| format!("Could not apply merged managed files: {error}"))?;
    let branch = current_branch(repo)?;
    let reference_name = format!("refs/heads/{branch}");
    repo.find_reference(&reference_name)
        .and_then(|mut reference| reference.set_target(oid, "Mimir automatic merge"))
        .map_err(|error| format!("Could not apply the managed merge: {error}"))?;
    repo.set_head(&reference_name)
        .map_err(|error| format!("Could not apply the managed merge: {error}"))?;
    mark_unpublished(repo, oid)?;
    Ok(())
}

fn changed_paths(repo: &Repository, base: Oid, tip: Oid) -> Result<BTreeSet<PathBuf>, String> {
    let base_tree = repo
        .find_commit(base)
        .and_then(|commit| commit.tree())
        .map_err(|error| error.to_string())?;
    let tip_tree = repo
        .find_commit(tip)
        .and_then(|commit| commit.tree())
        .map_err(|error| error.to_string())?;
    let mut options = DiffOptions::new();
    options.include_typechange(true);
    let diff = repo
        .diff_tree_to_tree(Some(&base_tree), Some(&tip_tree), Some(&mut options))
        .map_err(|error| error.to_string())?;
    let mut paths = BTreeSet::new();
    for delta in diff.deltas() {
        if let Some(path) = delta.new_file().path().or_else(|| delta.old_file().path()) {
            paths.insert(path.to_path_buf());
        }
    }
    Ok(paths)
}

fn latest_path_change_time(
    repo: &Repository,
    tip: Oid,
    base: Oid,
    path: &Path,
) -> Result<i64, String> {
    let mut walk = repo.revwalk().map_err(|error| error.to_string())?;
    walk.push(tip).map_err(|error| error.to_string())?;
    walk.hide(base).map_err(|error| error.to_string())?;
    walk.set_sorting(Sort::TIME)
        .map_err(|error| error.to_string())?;
    for oid in walk {
        let commit = repo
            .find_commit(oid.map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
        let current = tree_entry_oid(
            repo,
            &commit.tree().map_err(|error| error.to_string())?,
            path,
        );
        let previous = commit
            .parent(0)
            .ok()
            .and_then(|parent| parent.tree().ok())
            .and_then(|tree| tree_entry_oid(repo, &tree, path));
        if current != previous {
            return Ok(commit.time().seconds());
        }
    }
    Ok(0)
}

fn tree_entry_oid(_repo: &Repository, tree: &git2::Tree<'_>, path: &Path) -> Option<Oid> {
    tree.get_path(path).ok().map(|entry| entry.id())
}

fn replace_index_path_from_commit(
    repo: &Repository,
    index: &mut Index,
    path: &Path,
    commit_oid: Oid,
) -> Result<(), String> {
    let commit = repo
        .find_commit(commit_oid)
        .map_err(|error| error.to_string())?;
    let tree = commit.tree().map_err(|error| error.to_string())?;
    let _ = index.conflict_remove(path);
    let Ok(entry) = tree.get_path(path) else {
        if index.get_path(path, 0).is_some() {
            index.remove_path(path).map_err(|error| error.to_string())?;
        }
        return Ok(());
    };
    let blob = repo
        .find_blob(entry.id())
        .map_err(|error| error.to_string())?;
    let index_entry = IndexEntry {
        ctime: IndexTime::new(0, 0),
        mtime: IndexTime::new(0, 0),
        dev: 0,
        ino: 0,
        mode: entry.filemode() as u32,
        uid: 0,
        gid: 0,
        file_size: blob.size() as u32,
        id: entry.id(),
        flags: 0,
        flags_extended: 0,
        path: path.to_string_lossy().as_bytes().to_vec(),
    };
    index
        .add(&index_entry)
        .map_err(|error| format!("Could not select the newest {}: {error}", path.display()))
}

fn push_unpublished(repo: &Repository) -> Result<(), String> {
    let Some(oid) = current_unpublished_oid(repo)? else {
        return Ok(());
    };
    let branch = current_branch(repo)?;
    let head = repo
        .head()
        .ok()
        .and_then(|head| head.target())
        .ok_or_else(|| "The managed branch has no commit to publish.".to_string())?;
    if head != oid
        && !repo
            .graph_descendant_of(head, oid)
            .map_err(|error| error.to_string())?
    {
        return Err(
            "The managed branch changed after Mimir saved its unpublished batch. Return to that batch before automatic sync."
                .into(),
        );
    }
    let refspec = format!("refs/heads/{branch}:refs/heads/{branch}");
    let root = repo
        .workdir()
        .ok_or_else(|| "Bare repositories cannot use automatic sync.".to_string())?;
    let output = run_system_git(root, ["push", "origin", refspec.as_str()])?;
    match require_command_success("Could not push managed changes", &output) {
        Ok(()) => {
            clear_unpublished(repo);
            Ok(())
        }
        Err(error) if error.to_ascii_lowercase().contains("non-fast-forward") => {
            Err("The GitHub branch changed during sync. Mimir will pull and retry.".into())
        }
        Err(error) => Err(error),
    }
}

fn current_branch(repo: &Repository) -> Result<String, String> {
    let head = repo
        .head()
        .map_err(|error| format!("Could not read the managed branch: {error}"))?;
    if !head.is_branch() {
        return Err("The managed repository is not on a branch.".into());
    }
    head.shorthand()
        .map(str::to_string)
        .map_err(|_| "The managed branch name is invalid.".to_string())
}

fn clone_with_system_git(remote_url: &str, destination: &Path) -> Result<(), String> {
    let git = crate::launchers::detect_binary("git")
        .map_err(|_| "Git is not installed. Install Git, then try again.".to_string())?;
    let mut command = Command::new(git);
    if validate_github_remote_url(remote_url).is_ok() {
        configure_github_cli_helper(&mut command);
    }
    let output = command
        .args(["clone", "--origin", "origin", "--"])
        .arg(remote_url)
        .arg(destination)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|error| format!("Could not start Git: {error}"))?;
    require_command_success("Could not download the Team repository", &output)
}

fn run_system_git<I, S>(root: &Path, arguments: I) -> Result<Output, String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let github_auth = Repository::open(root)
        .ok()
        .and_then(|repo| remote_url(&repo))
        .is_some_and(|remote| validate_github_remote_url(&remote).is_ok());
    run_system_git_configured(root, arguments, github_auth)
}

fn run_system_git_configured<I, S>(
    root: &Path,
    arguments: I,
    github_auth: bool,
) -> Result<Output, String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let git = crate::launchers::detect_binary("git")
        .map_err(|_| "Git is not installed. Install Git, then try again.".to_string())?;
    let mut command = Command::new(git);
    if github_auth {
        configure_github_cli_helper(&mut command);
    }
    command
        .arg("-C")
        .arg(root)
        .args(arguments)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|error| format!("Could not start Git: {error}"))
}

fn configure_github_cli_helper(command: &mut Command) {
    let state = match GITHUB_CLI_AUTH.load(Ordering::Relaxed) {
        GITHUB_AUTH_UNKNOWN => {
            let _ = github_cli_status();
            GITHUB_CLI_AUTH.load(Ordering::Relaxed)
        }
        state => state,
    };
    if state != GITHUB_AUTH_READY {
        return;
    }
    let Ok(gh) = crate::launchers::detect_binary("gh") else {
        return;
    };
    let quoted = format!("'{}'", gh.replace(char::from(39), "'\"'\"'"));
    command
        .env("GIT_CONFIG_COUNT", "2")
        .env("GIT_CONFIG_KEY_0", "credential.https://github.com.helper")
        .env("GIT_CONFIG_VALUE_0", "")
        .env("GIT_CONFIG_KEY_1", "credential.https://github.com.helper")
        .env(
            "GIT_CONFIG_VALUE_1",
            format!("!{quoted} auth git-credential"),
        );
}

fn remote_url(repo: &Repository) -> Option<String> {
    let raw = repo.find_remote("origin").ok()?.url().ok()?.to_string();
    let Ok(mut parsed) = url::Url::parse(&raw) else {
        return Some(raw);
    };
    if matches!(parsed.scheme(), "http" | "https") {
        let _ = parsed.set_username("");
        let _ = parsed.set_password(None);
    }
    Some(parsed.to_string())
}

fn create_recovery_ref(repo: &Repository, oid: Oid) -> Result<(), String> {
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%S%.3fZ");
    repo.reference(
        &format!("refs/mimir/recovery/{stamp}"),
        oid,
        false,
        "Mimir recovery point",
    )
    .map(|_| ())
    .map_err(|error| format!("Could not create a recovery point: {error}"))
}

fn prune_recovery_refs(repo: &Repository) {
    let Ok(references) = repo.references_glob("refs/mimir/recovery/*") else {
        return;
    };
    let mut names = references
        .filter_map(Result::ok)
        .filter_map(|reference| reference.name().ok().map(str::to_string))
        .collect::<Vec<_>>();
    names.sort();
    let remove_count = names.len().saturating_sub(RECOVERY_REF_LIMIT);
    for name in names.into_iter().take(remove_count) {
        if let Ok(mut reference) = repo.find_reference(&name) {
            let _ = reference.delete();
        }
    }
}

fn is_transient_network_error(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    [
        "network",
        "timed out",
        "timeout",
        "could not resolve",
        "failed to connect",
        "connection reset",
        "connection refused",
        "offline",
        "early eof",
        "ssl error",
    ]
    .iter()
    .any(|needle| error.contains(needle))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clone_repository(remote: &Path, destination: &Path) -> Repository {
        Repository::clone(remote.to_str().unwrap(), destination).unwrap()
    }

    fn remote_fixture(root: &Path) -> PathBuf {
        let remote_path = root.join("remote.git");
        let remote = Repository::init_bare(&remote_path).unwrap();
        let seed_path = root.join("seed");
        let seed = Repository::init(&seed_path).unwrap();
        commit(&seed, "graph/shared.md", b"base", "initial");
        let branch = current_branch(&seed).unwrap();
        seed.remote("origin", remote_path.to_str().unwrap())
            .unwrap();
        seed.find_remote("origin")
            .unwrap()
            .push(&[&format!("refs/heads/{branch}:refs/heads/{branch}")], None)
            .unwrap();
        remote.set_head(&format!("refs/heads/{branch}")).unwrap();
        remote_path
    }

    fn project_remote_fixture(root: &Path) -> PathBuf {
        let remote_path = remote_fixture(root);
        let seed_path = root.join("project-seed");
        let seed = clone_repository(&remote_path, &seed_path);
        commit(&seed, "model.bin", b"remote\0base", "add model");
        push_current(&seed);
        remote_path
    }

    fn push_current(repo: &Repository) {
        let branch = current_branch(repo).unwrap();
        repo.find_remote("origin")
            .unwrap()
            .push(&[&format!("refs/heads/{branch}:refs/heads/{branch}")], None)
            .unwrap();
    }

    fn managed_commit_at(repo: &Repository, path: &str, contents: &[u8], seconds: i64) -> Oid {
        let workdir = repo.workdir().unwrap();
        let absolute = workdir.join(path);
        if let Some(parent) = absolute.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(absolute, contents).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new(path)).unwrap();
        index.write().unwrap();
        let tree_oid = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        let time = git2::Time::new(seconds, 0);
        let signature = Signature::new("Test", "test@example.com", &time).unwrap();
        let parent = repo.head().unwrap().peel_to_commit().unwrap();
        let oid = repo
            .commit(
                Some("HEAD"),
                &signature,
                &signature,
                SYNC_MESSAGE,
                &tree,
                &[&parent],
            )
            .unwrap();
        mark_unpublished(repo, oid).unwrap();
        oid
    }

    fn head_file(repo: &Repository, path: &str) -> Vec<u8> {
        let tree = repo.head().unwrap().peel_to_tree().unwrap();
        let entry = tree.get_path(Path::new(path)).unwrap();
        repo.find_blob(entry.id()).unwrap().content().to_vec()
    }

    fn commit(repo: &Repository, path: &str, contents: &[u8], message: &str) -> Oid {
        let workdir = repo.workdir().unwrap();
        let absolute = workdir.join(path);
        if let Some(parent) = absolute.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(absolute, contents).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new(path)).unwrap();
        index.write().unwrap();
        let tree_oid = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        let signature = Signature::now("Test", "test@example.com").unwrap();
        let parents = repo
            .head()
            .ok()
            .and_then(|head| head.peel_to_commit().ok())
            .into_iter()
            .collect::<Vec<_>>();
        let parent_refs = parents.iter().collect::<Vec<_>>();
        repo.commit(
            Some("HEAD"),
            &signature,
            &signature,
            message,
            &tree,
            &parent_refs,
        )
        .unwrap()
    }

    #[test]
    fn team_setup_refuses_an_occupied_invalid_location() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("team-graph");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("keep.txt"), "keep").unwrap();

        let error = setup_team_repository(
            &root,
            "https://github.com/test/team-graph.git",
            Some("Outcome Lab"),
            true,
        )
        .unwrap_err();

        assert!(error.contains("already exists"));
        assert_eq!(fs::read_to_string(root.join("keep.txt")).unwrap(), "keep");
    }

    #[test]
    fn team_setup_initializes_and_pushes_an_empty_remote() {
        let directory = tempfile::tempdir().unwrap();
        let remote_path = directory.path().join("empty.git");
        let remote = Repository::init_bare(&remote_path).unwrap();
        let root = directory.path().join("team-graph");

        setup_team_repository(
            &root,
            remote_path.to_str().unwrap(),
            Some("Outcome Lab"),
            false,
        )
        .unwrap();

        assert!(root.join(TEAM_MANIFEST).is_file());
        let branch = current_branch(&Repository::open(&root).unwrap()).unwrap();
        remote.set_head(&format!("refs/heads/{branch}")).unwrap();
        assert!(remote
            .head()
            .unwrap()
            .peel_to_tree()
            .unwrap()
            .get_path(Path::new(TEAM_MANIFEST))
            .is_ok());
    }

    #[test]
    fn team_move_copies_history_and_keeps_the_previous_remote() {
        let directory = tempfile::tempdir().unwrap();
        let previous_path = directory.path().join("previous.git");
        let next_path = directory.path().join("next.git");
        let previous = Repository::init_bare(&previous_path).unwrap();
        let next = Repository::init_bare(&next_path).unwrap();
        let root = directory.path().join("team-graph");
        setup_team_repository(
            &root,
            previous_path.to_str().unwrap(),
            Some("Outcome Lab"),
            false,
        )
        .unwrap();
        fs::write(root.join("graph/project.md"), "project").unwrap();

        move_team_repository(&root, next_path.to_str().unwrap(), false).unwrap();

        let repo = Repository::open(&root).unwrap();
        let branch = current_branch(&repo).unwrap();
        assert_eq!(remote_url(&repo).as_deref(), next_path.to_str());
        for remote in [&previous, &next] {
            remote.set_head(&format!("refs/heads/{branch}")).unwrap();
            assert_eq!(head_file(remote, "graph/project.md"), b"project");
        }
    }

    #[test]
    fn team_move_rejects_a_nonempty_destination_without_changing_origin() {
        let directory = tempfile::tempdir().unwrap();
        let previous_path = directory.path().join("previous.git");
        Repository::init_bare(&previous_path).unwrap();
        let root = directory.path().join("team-graph");
        setup_team_repository(
            &root,
            previous_path.to_str().unwrap(),
            Some("Outcome Lab"),
            false,
        )
        .unwrap();
        let occupied_root = directory.path().join("occupied");
        fs::create_dir(&occupied_root).unwrap();
        let occupied_path = remote_fixture(&occupied_root);

        let error =
            move_team_repository(&root, occupied_path.to_str().unwrap(), false).unwrap_err();

        assert!(error.contains("not empty"));
        assert_eq!(
            remote_url(&Repository::open(&root).unwrap()).as_deref(),
            previous_path.to_str()
        );
    }

    #[test]
    fn project_scan_excludes_binary_and_large_files() {
        let directory = tempfile::tempdir().unwrap();
        let repo = Repository::init(directory.path()).unwrap();
        fs::write(directory.path().join("notes.md"), "plain text").unwrap();
        fs::write(directory.path().join("model.bin"), b"a\0b").unwrap();
        let large = fs::File::create(directory.path().join("large.csv")).unwrap();
        large.set_len(PROJECT_MAX_BYTES + 1).unwrap();

        let scan = scan_changes(&repo, RepositoryKind::Project).unwrap();

        assert_eq!(scan.eligible, vec![PathBuf::from("notes.md")]);
        assert_eq!(scan.excluded.len(), 2);
        assert_eq!(scan.excluded[0].path, "large.csv");
        assert_eq!(scan.excluded[0].reason, "large");
        assert_eq!(scan.excluded[1].reason, "binary");
    }

    #[test]
    fn project_management_is_automatic_for_github_https_and_ssh_origins() {
        let directory = tempfile::tempdir().unwrap();
        let repo = Repository::init(directory.path()).unwrap();
        assert_eq!(automatic_project_remote(&repo), None);

        repo.remote("origin", "https://github.com/example/project.git")
            .unwrap();
        assert_eq!(
            automatic_project_remote(&repo).as_deref(),
            Some("https://github.com/example/project.git")
        );

        repo.remote_set_url("origin", "git@github.com:example/project.git")
            .unwrap();
        assert_eq!(
            automatic_project_remote(&repo).as_deref(),
            Some("git@github.com:example/project.git")
        );

        repo.remote_set_url("origin", "ssh://git@github.com/example/project.git")
            .unwrap();
        assert_eq!(
            automatic_project_remote(&repo).as_deref(),
            Some("ssh://git@github.com/example/project.git")
        );

        repo.remote_set_url("origin", "https://example.com/example/project.git")
            .unwrap();
        assert_eq!(automatic_project_remote(&repo), None);
    }

    #[test]
    fn project_remote_setup_accepts_only_an_empty_repository() {
        let directory = tempfile::tempdir().unwrap();
        let project_path = directory.path().join("project");
        fs::create_dir(&project_path).unwrap();
        let project = Repository::init(&project_path).unwrap();
        let empty_path = directory.path().join("empty.git");
        Repository::init_bare(&empty_path).unwrap();

        set_project_remote(&project_path, empty_path.to_str().unwrap(), false).unwrap();
        assert_eq!(remote_url(&project).as_deref(), empty_path.to_str());

        let second_path = directory.path().join("second");
        fs::create_dir(&second_path).unwrap();
        Repository::init(&second_path).unwrap();
        let occupied_root = directory.path().join("occupied");
        fs::create_dir(&occupied_root).unwrap();
        let occupied_path = remote_fixture(&occupied_root);
        let error =
            set_project_remote(&second_path, occupied_path.to_str().unwrap(), false).unwrap_err();
        assert!(error.contains("not empty"));
        assert!(Repository::open(&second_path)
            .unwrap()
            .find_remote("origin")
            .is_err());
    }

    #[test]
    fn github_cli_status_selects_only_the_active_successful_account() {
        let status = br#"{
          "hosts": {
            "github.com": [
              { "active": false, "state": "success", "login": "old" },
              { "active": true, "state": "failure", "login": "broken" },
              { "active": true, "state": "success", "login": "waqr" }
            ]
          }
        }"#;

        assert_eq!(github_login_from_status(status).as_deref(), Some("waqr"));
        assert_eq!(github_login_from_status(b"{}"), None);
    }

    #[test]
    fn github_remote_validation_accepts_normal_git_urls_only() {
        for remote in [
            "https://github.com/example/project.git",
            "git@github.com:example/project.git",
            "ssh://git@github.com/example/project.git",
        ] {
            assert!(validate_github_remote_url(remote).is_ok(), "{remote}");
        }
        for remote in [
            "https://example.com/example/project.git",
            "https://token@github.com/example/project.git",
            "git@example.com:example/project.git",
            "git@github.com:example/project.git?x=1",
            "ssh://other@github.com/example/project.git",
        ] {
            assert!(validate_github_remote_url(remote).is_err(), "{remote}");
        }
    }

    #[test]
    fn team_resource_import_rejects_files_github_cannot_sync() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("too-large.bin");
        fs::File::create(&source)
            .unwrap()
            .set_len(TEAM_RESOURCE_MAX_BYTES + 1)
            .unwrap();

        let error = import_team_resource(source.to_str().unwrap()).unwrap_err();

        assert_eq!(
            error,
            "Team resources must be 100 MB or smaller for GitHub sync."
        );
    }

    #[test]
    fn team_resource_import_copies_without_overwriting_a_matching_name() {
        let directory = tempfile::tempdir().unwrap();
        let team = directory.path().join("team-graph");
        fs::create_dir_all(team.join("graph")).unwrap();
        fs::create_dir_all(team.join("resources")).unwrap();
        fs::write(
            team.join(TEAM_MANIFEST),
            "version = 1\nname = \"Test Team\"\n",
        )
        .unwrap();
        let repo = Repository::init(&team).unwrap();
        repo.remote("origin", "https://github.com/example/team-graph.git")
            .unwrap();
        let source = directory.path().join("proposal.html");
        fs::write(&source, "proposal").unwrap();

        let first = import_team_resource_at(&team, source.to_str().unwrap()).unwrap();
        let second = import_team_resource_at(&team, source.to_str().unwrap()).unwrap();

        assert_eq!(first, "resources/proposal.html");
        assert_eq!(second, "resources/proposal-2.html");
        assert_eq!(
            fs::read_to_string(team.join("resources/proposal-2.html")).unwrap(),
            "proposal"
        );
    }

    #[test]
    fn team_resource_list_returns_nested_files_and_skips_markers() {
        let directory = tempfile::tempdir().unwrap();
        let team = directory.path().join("team-graph");
        fs::create_dir_all(team.join("graph")).unwrap();
        fs::create_dir_all(team.join("resources/branding")).unwrap();
        fs::write(
            team.join(TEAM_MANIFEST),
            "version = 1\nname = \"Test Team\"\n",
        )
        .unwrap();
        fs::write(team.join("resources/.gitkeep"), "").unwrap();
        fs::write(team.join("resources/data.csv"), "a,b").unwrap();
        fs::write(team.join("resources/branding/logo.svg"), "logo").unwrap();
        let repo = Repository::init(&team).unwrap();
        repo.remote("origin", "https://github.com/example/team-graph.git")
            .unwrap();

        assert_eq!(
            list_team_resources_at(&team).unwrap(),
            vec![
                TeamResourceFile {
                    path: "resources/branding/logo.svg".into(),
                    size: 4,
                },
                TeamResourceFile {
                    path: "resources/data.csv".into(),
                    size: 3,
                },
            ]
        );
    }

    #[test]
    fn team_scope_root_is_the_repository_not_its_graph_directory() {
        let directory = tempfile::tempdir().unwrap();
        let team = directory.path().join("team-graph");
        fs::create_dir_all(team.join("graph")).unwrap();
        fs::create_dir_all(team.join("resources")).unwrap();
        fs::write(
            team.join(TEAM_MANIFEST),
            "version = 1\nname = \"Test Team\"\n",
        )
        .unwrap();
        let repo = Repository::init(&team).unwrap();
        repo.remote("origin", "https://github.com/example/team-graph.git")
            .unwrap();

        let scope_root = team_scope_root_at(&team).unwrap();

        assert_eq!(scope_root, team);
        assert!(scope_root.join("graph").is_dir());
        assert!(!scope_root.join("graph/graph").exists());
    }

    #[test]
    fn project_commit_does_not_include_a_previously_staged_binary() {
        let directory = tempfile::tempdir().unwrap();
        let repo = Repository::init(directory.path()).unwrap();
        commit(&repo, "model.bin", b"old\0binary", "initial");
        fs::write(directory.path().join("model.bin"), b"new\0binary").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("model.bin")).unwrap();
        index.write().unwrap();
        fs::write(directory.path().join("notes.md"), "managed text").unwrap();

        commit_pending(directory.path(), RepositoryKind::Project).unwrap();

        let tree = repo.head().unwrap().peel_to_tree().unwrap();
        let binary = repo
            .find_blob(tree.get_path(Path::new("model.bin")).unwrap().id())
            .unwrap();
        let notes = repo
            .find_blob(tree.get_path(Path::new("notes.md")).unwrap().id())
            .unwrap();
        assert_eq!(binary.content(), b"old\0binary");
        assert_eq!(notes.content(), b"managed text");
    }

    #[test]
    fn project_commit_does_not_publish_deletion_of_an_excluded_binary() {
        let directory = tempfile::tempdir().unwrap();
        let repo = Repository::init(directory.path()).unwrap();
        let initial = commit(&repo, "model.bin", b"old\0binary", "initial");
        fs::remove_file(directory.path().join("model.bin")).unwrap();

        let scan = scan_changes(&repo, RepositoryKind::Project).unwrap();
        assert!(scan.eligible.is_empty());
        assert_eq!(scan.excluded[0].reason, "binary");
        assert_eq!(
            commit_pending(directory.path(), RepositoryKind::Project).unwrap(),
            None
        );
        assert_eq!(repo.head().unwrap().target(), Some(initial));
        assert_eq!(head_file(&repo, "model.bin"), b"old\0binary");
    }

    #[test]
    fn project_commit_does_not_publish_deletion_of_an_excluded_large_file() {
        let directory = tempfile::tempdir().unwrap();
        let repo = Repository::init(directory.path()).unwrap();
        let path = directory.path().join("large.csv");
        fs::File::create(&path)
            .unwrap()
            .set_len(PROJECT_MAX_BYTES + 1)
            .unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("large.csv")).unwrap();
        index.write().unwrap();
        let tree_oid = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        let signature = Signature::now("Test", "test@example.com").unwrap();
        let initial = repo
            .commit(Some("HEAD"), &signature, &signature, "initial", &tree, &[])
            .unwrap();
        fs::remove_file(&path).unwrap();

        let scan = scan_changes(&repo, RepositoryKind::Project).unwrap();
        assert!(scan.eligible.is_empty());
        assert_eq!(scan.excluded[0].reason, "large");
        commit_pending(directory.path(), RepositoryKind::Project).unwrap();
        assert_eq!(repo.head().unwrap().target(), Some(initial));
    }

    #[test]
    fn project_pull_preserves_an_excluded_binary_changed_only_locally() {
        let directory = tempfile::tempdir().unwrap();
        let remote_path = project_remote_fixture(directory.path());
        let left_path = directory.path().join("left");
        let right_path = directory.path().join("right");
        let left = clone_repository(&remote_path, &left_path);
        let right = clone_repository(&remote_path, &right_path);
        fs::write(left_path.join("model.bin"), b"local\0work").unwrap();
        let mut index = left.index().unwrap();
        index.add_path(Path::new("model.bin")).unwrap();
        index.write().unwrap();
        managed_commit_at(&right, "notes.md", b"incoming", 2_000_000_100);
        sync_repository(&right_path, RepositoryKind::Project).unwrap();

        fetch_and_integrate(&left_path, RepositoryKind::Project).unwrap();

        assert_eq!(head_file(&left, "notes.md"), b"incoming");
        assert_eq!(head_file(&left, "model.bin"), b"remote\0base");
        assert_eq!(
            fs::read(left_path.join("model.bin")).unwrap(),
            b"local\0work"
        );
        assert_eq!(
            scan_changes(&left, RepositoryKind::Project)
                .unwrap()
                .excluded
                .len(),
            1
        );
    }

    #[test]
    fn project_merge_preserves_an_excluded_binary_changed_only_locally() {
        let directory = tempfile::tempdir().unwrap();
        let remote_path = project_remote_fixture(directory.path());
        let left_path = directory.path().join("left");
        let right_path = directory.path().join("right");
        let left = clone_repository(&remote_path, &left_path);
        let right = clone_repository(&remote_path, &right_path);
        managed_commit_at(&left, "left.md", b"left", 2_000_000_100);
        fs::write(left_path.join("model.bin"), b"local\0work").unwrap();
        managed_commit_at(&right, "right.md", b"right", 2_000_000_200);
        sync_repository(&right_path, RepositoryKind::Project).unwrap();

        sync_repository(&left_path, RepositoryKind::Project).unwrap();

        assert_eq!(head_file(&left, "left.md"), b"left");
        assert_eq!(head_file(&left, "right.md"), b"right");
        assert_eq!(head_file(&left, "model.bin"), b"remote\0base");
        assert_eq!(
            fs::read(left_path.join("model.bin")).unwrap(),
            b"local\0work"
        );
        assert!(unpublished_oid(&left).is_none());
    }

    #[test]
    fn project_pull_stops_before_overwriting_an_excluded_binary_changed_remotely() {
        let directory = tempfile::tempdir().unwrap();
        let remote_path = project_remote_fixture(directory.path());
        let left_path = directory.path().join("left");
        let right_path = directory.path().join("right");
        let left = clone_repository(&remote_path, &left_path);
        let right = clone_repository(&remote_path, &right_path);
        let left_head = left.head().unwrap().target().unwrap();
        fs::write(left_path.join("model.bin"), b"local\0work").unwrap();
        commit(&right, "model.bin", b"remote\0update", "update model");
        push_current(&right);

        let error = fetch_and_integrate(&left_path, RepositoryKind::Project).unwrap_err();

        assert!(error.contains("model.bin is excluded locally and also changed on GitHub"));
        assert_eq!(left.head().unwrap().target(), Some(left_head));
        assert_eq!(
            fs::read(left_path.join("model.bin")).unwrap(),
            b"local\0work"
        );
    }

    #[test]
    fn invalid_existing_remote_never_installs_the_team_root() {
        let directory = tempfile::tempdir().unwrap();
        let remote = remote_fixture(directory.path());
        let root = directory.path().join("team-graph");

        let error =
            setup_team_repository(&root, remote.to_str().unwrap(), Some("Outcome Lab"), false)
                .unwrap_err();

        assert!(error.contains("mimir-team.toml"));
        assert!(!root.exists());
        assert!(!fs::read_dir(directory.path())
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| entry
                .file_name()
                .to_string_lossy()
                .starts_with(".team-graph.setup-")));
    }

    #[test]
    fn later_offline_edits_amend_one_unpublished_commit() {
        let directory = tempfile::tempdir().unwrap();
        let repo = Repository::init(directory.path()).unwrap();
        commit(&repo, "notes.md", b"initial", "initial");
        fs::write(directory.path().join("notes.md"), "first").unwrap();
        let first = commit_pending(directory.path(), RepositoryKind::Project)
            .unwrap()
            .unwrap();
        fs::write(directory.path().join("notes.md"), "second").unwrap();
        let second = commit_pending(directory.path(), RepositoryKind::Project)
            .unwrap()
            .unwrap();

        assert_ne!(first, second);
        assert_eq!(repo.find_commit(second).unwrap().parent_count(), 1);
        assert_eq!(unpublished_oid(&repo), Some(second));
        assert!(
            repo.references_glob("refs/mimir/recovery/*")
                .unwrap()
                .count()
                >= 1
        );
    }

    #[test]
    fn unpublished_batch_is_bound_to_its_branch() {
        let directory = tempfile::tempdir().unwrap();
        let repo = Repository::init(directory.path()).unwrap();
        let initial = commit(&repo, "notes.md", b"initial", "initial");
        let branch = current_branch(&repo).unwrap();
        fs::write(directory.path().join("notes.md"), "draft").unwrap();
        commit_pending(directory.path(), RepositoryKind::Project).unwrap();
        let initial_commit = repo.find_commit(initial).unwrap();
        repo.branch("other", &initial_commit, false).unwrap();
        repo.set_head("refs/heads/other").unwrap();
        repo.checkout_head(Some(CheckoutBuilder::new().force()))
            .unwrap();

        let error = current_unpublished_oid(&repo).unwrap_err();
        assert!(error.contains(&format!("belongs to branch {branch}")));
        assert!(unpublished_oid(&repo).is_some());
    }

    #[test]
    fn sync_publishes_a_manual_local_commit_without_a_marker() {
        let directory = tempfile::tempdir().unwrap();
        let remote_path = remote_fixture(directory.path());
        let local_path = directory.path().join("local");
        let local = clone_repository(&remote_path, &local_path);
        commit(&local, "manual.md", b"manual", "manual change");
        assert!(unpublished_oid(&local).is_none());

        sync_repository(&local_path, RepositoryKind::Team).unwrap();

        let remote = Repository::open_bare(&remote_path).unwrap();
        assert_eq!(head_file(&remote, "manual.md"), b"manual");
        assert!(unpublished_oid(&local).is_none());
    }

    #[test]
    fn repository_operations_share_one_lock_per_root() {
        let directory = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let runtime = ManagedGitRuntime::default();
        let first = runtime.repository_lock(directory.path());
        let same = runtime.repository_lock(&directory.path().join("."));
        let independent = runtime.repository_lock(other.path());

        assert!(Arc::ptr_eq(&first, &same));
        assert!(!Arc::ptr_eq(&first, &independent));
        let guard = first.lock().unwrap();
        assert!(same.try_lock().is_err());
        assert!(independent.try_lock().is_ok());
        drop(guard);
        assert!(same.try_lock().is_ok());
    }

    #[test]
    fn two_clones_merge_different_files_and_retain_both_commits() {
        let directory = tempfile::tempdir().unwrap();
        let remote_path = remote_fixture(directory.path());
        let left_path = directory.path().join("left");
        let right_path = directory.path().join("right");
        let left = clone_repository(&remote_path, &left_path);
        let right = clone_repository(&remote_path, &right_path);

        fs::write(left_path.join("graph/left.md"), "left").unwrap();
        fs::write(right_path.join("graph/right.md"), "right").unwrap();
        let left_oid = commit_pending(&left_path, RepositoryKind::Team)
            .unwrap()
            .unwrap();
        let right_oid = commit_pending(&right_path, RepositoryKind::Team)
            .unwrap()
            .unwrap();

        sync_repository(&left_path, RepositoryKind::Team).unwrap();
        sync_repository(&right_path, RepositoryKind::Team).unwrap();

        let final_oid = right.head().unwrap().target().unwrap();
        assert_eq!(head_file(&right, "graph/left.md"), b"left");
        assert_eq!(head_file(&right, "graph/right.md"), b"right");
        assert!(right.graph_descendant_of(final_oid, left_oid).unwrap());
        assert!(right.graph_descendant_of(final_oid, right_oid).unwrap());
        assert!(unpublished_oid(&left).is_none());
        assert!(unpublished_oid(&right).is_none());
    }

    #[test]
    fn two_clones_resolve_same_file_by_recorded_edit_time() {
        let directory = tempfile::tempdir().unwrap();
        let remote_path = remote_fixture(directory.path());
        let early_path = directory.path().join("early");
        let late_path = directory.path().join("late");
        let early = clone_repository(&remote_path, &early_path);
        let late = clone_repository(&remote_path, &late_path);

        let early_oid = managed_commit_at(&early, "graph/shared.md", b"early", 2_000_000_100);
        let late_oid = managed_commit_at(&late, "graph/shared.md", b"late", 2_000_000_200);
        sync_repository(&late_path, RepositoryKind::Team).unwrap();
        sync_repository(&early_path, RepositoryKind::Team).unwrap();
        let merged_oid = early.head().unwrap().target().unwrap();
        assert_eq!(head_file(&early, "graph/shared.md"), b"late");
        assert!(early.graph_descendant_of(merged_oid, early_oid).unwrap());
        assert!(early.graph_descendant_of(merged_oid, late_oid).unwrap());

        let older_path = directory.path().join("older");
        let newer_path = directory.path().join("newer");
        let older = clone_repository(&remote_path, &older_path);
        let newer = clone_repository(&remote_path, &newer_path);
        managed_commit_at(&older, "graph/shared.md", b"older", 2_000_000_300);
        managed_commit_at(&newer, "graph/shared.md", b"newer", 2_000_000_400);
        sync_repository(&older_path, RepositoryKind::Team).unwrap();
        sync_repository(&newer_path, RepositoryKind::Team).unwrap();
        assert_eq!(head_file(&newer, "graph/shared.md"), b"newer");
    }

    #[test]
    fn project_home_sync_preserves_context_and_both_canvas_versions() {
        let directory = tempfile::TempDir::new().unwrap();
        let remote_path = remote_fixture(directory.path());
        let seed_path = directory.path().join("seed-home");
        let seed = clone_repository(&remote_path, &seed_path);
        let source = |body: &str, canvas: &str| {
            format!("---\nkind: project\ntitle: Atlas\nhome:\n  canvas: {canvas}\n---\n{body}")
        };
        managed_commit_at(
            &seed,
            "graph/atlas.md",
            source("Context", "Old").as_bytes(),
            2_000_000_000,
        );
        sync_repository(&seed_path, RepositoryKind::Team).unwrap();
        let a_path = directory.path().join("home-a");
        let b_path = directory.path().join("home-b");
        let a = clone_repository(&remote_path, &a_path);
        let b = clone_repository(&remote_path, &b_path);
        let a_oid = managed_commit_at(
            &a,
            "graph/atlas.md",
            source("New context", "Local canvas").as_bytes(),
            2_000_000_100,
        );
        let b_oid = managed_commit_at(
            &b,
            "graph/atlas.md",
            source("Context", "Remote canvas").as_bytes(),
            2_000_000_200,
        );
        sync_repository(&b_path, RepositoryKind::Team).unwrap();
        sync_repository(&a_path, RepositoryKind::Team).unwrap();
        let merged = String::from_utf8(head_file(&a, "graph/atlas.md")).unwrap();
        assert!(merged.contains("New context"));
        assert!(merged.contains("Remote canvas"));
        let head = a.head().unwrap().target().unwrap();
        assert!(a.graph_descendant_of(head, a_oid).unwrap());
        assert!(a.graph_descendant_of(head, b_oid).unwrap());
    }

    #[test]
    fn batching_deadlines_and_activation_keep_young_changes_uncommitted() {
        let now = UNIX_EPOCH + Duration::from_secs(10_000);
        let mut track = Track::new(RepositoryKind::Team);
        track.first_change = Some(now - Duration::from_secs(60));
        track.last_change = Some(now - Duration::from_secs(60));
        track.last_fetch = Some(now);

        assert_eq!(due_actions(&track, true, false, now), (false, false));
        assert!(!activation_requires_publish(true, true));

        track.last_change = Some(now - Duration::from_secs(IDLE_BATCH_SECONDS));
        assert_eq!(due_actions(&track, true, false, now), (true, false));

        track.first_change = Some(now - Duration::from_secs(MAX_BATCH_SECONDS));
        track.last_change = Some(now - Duration::from_secs(1));
        assert_eq!(due_actions(&track, true, false, now), (true, false));
        assert!(activation_requires_publish(false, true));
    }
}
