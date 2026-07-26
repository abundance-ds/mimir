//! Fast, bounded workspace file discovery and content search.
//!
//! The index is an in-memory projection of the filesystem, not a database. A
//! watcher should debounce its events and pass the coalesced paths to
//! [`WorkspaceFileIndex::refresh_paths`]. Ordinary file edits and deletes update
//! in place; structural or ignore-rule changes fall back to a full scan.

use ignore::{DirEntry, WalkBuilder, WalkState};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering as CmpOrdering;
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;

pub const HARD_MAX_FILTER_RESULTS: usize = 1_000;
pub const HARD_MAX_CONTENT_RESULTS: usize = 200;
pub const HARD_MAX_SEARCH_FILES: usize = 5_000;
pub const HARD_MAX_SEARCH_BYTES: usize = 64 * 1024 * 1024;
pub const HARD_MAX_FILE_BYTES: usize = 4 * 1024 * 1024;

const DEFAULT_FILTER_RESULTS: usize = 100;
const DEFAULT_CONTENT_RESULTS: usize = 100;
const DEFAULT_SEARCH_FILES: usize = 2_000;
const DEFAULT_SEARCH_BYTES: usize = 32 * 1024 * 1024;
const DEFAULT_FILE_BYTES: usize = 2 * 1024 * 1024;
const MAX_EXCERPT_CHARS: usize = 300;
const TEXT_PROBE_BYTES: u64 = 8 * 1024;
const READ_CHUNK_BYTES: usize = 64 * 1024;

const NOISE_DIRECTORIES: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    ".cache",
    ".next",
    ".nuxt",
    ".parcel-cache",
    ".turbo",
    ".venv",
    "__pycache__",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "out",
    "target",
];

const NOISE_FILES: &[&str] = &[".DS_Store", "Thumbs.db"];

const BINARY_EXTENSIONS: &[&str] = &[
    "7z", "a", "avi", "bmp", "class", "db", "dll", "dylib", "eot", "exe", "gif", "gz", "ico",
    "jar", "jpeg", "jpg", "mkv", "mov", "mp3", "mp4", "o", "otf", "pdf", "png", "rar", "so",
    "sqlite", "sqlite3", "tar", "tiff", "ttf", "wav", "wasm", "webp", "woff", "woff2", "zip",
];

const TEXT_EXTENSIONS: &[&str] = &[
    "bash",
    "bib",
    "c",
    "cc",
    "cfg",
    "conf",
    "cpp",
    "css",
    "csv",
    "fish",
    "go",
    "h",
    "hpp",
    "htm",
    "html",
    "ini",
    "java",
    "js",
    "json",
    "jsonc",
    "jsx",
    "kt",
    "kts",
    "less",
    "lua",
    "m",
    "markdown",
    "md",
    "mdown",
    "mkd",
    "mm",
    "mjs",
    "mts",
    "php",
    "pl",
    "properties",
    "py",
    "r",
    "rb",
    "rs",
    "scss",
    "sh",
    "sql",
    "svg",
    "swift",
    "toml",
    "ts",
    "tsx",
    "txt",
    "vue",
    "xml",
    "yaml",
    "yml",
    "zsh",
];

#[derive(Debug, Error)]
pub enum FileIndexError {
    #[error("workspace is not a directory: {0}")]
    NotDirectory(PathBuf),
    #[error("cannot access workspace {path}: {source}")]
    WorkspaceIo {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileIndexEntry {
    /// Absolute display path. Filesystem operations retain the original
    /// `PathBuf` internally, so lossy display conversion never breaks access.
    pub path: String,
    pub name: String,
    pub relative_path: String,
    /// Milliseconds since the Unix epoch. Unknown/pre-epoch times become zero.
    pub mtime: i64,
    pub size: u64,
    pub text_readable: bool,
}

/// Cheap, shared snapshot of every indexed file in recent-first order.
///
/// Cloning is one atomic increment; the entry list itself is rebuilt only when
/// the index mutates. Serializes exactly like `Vec<FileIndexEntry>`, so
/// renderer payload shapes are unchanged.
#[derive(Clone, Debug)]
pub struct FileIndexSnapshot(Arc<Vec<Arc<FileIndexEntry>>>);

impl FileIndexSnapshot {
    fn empty() -> Self {
        Self(Arc::new(Vec::new()))
    }

    fn of(files: &[IndexedFile]) -> Self {
        Self(Arc::new(
            files.iter().map(|file| Arc::clone(&file.public)).collect(),
        ))
    }

    pub fn to_entries(&self) -> Vec<FileIndexEntry> {
        self.0.iter().map(|entry| entry.as_ref().clone()).collect()
    }
}

impl std::ops::Deref for FileIndexSnapshot {
    type Target = [Arc<FileIndexEntry>];

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl Serialize for FileIndexSnapshot {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.collect_seq(self.0.iter().map(Arc::as_ref))
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileFilterHit {
    pub file: FileIndexEntry,
    pub score: i64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentSearchToken {
    request_generation: u64,
    workspace_generation: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ContentSearchRequest {
    pub query: String,
    /// Optional fuzzy filename/relative-path restriction.
    pub path_query: Option<String>,
    pub max_results: Option<usize>,
    pub max_files: Option<usize>,
    pub max_total_bytes: Option<usize>,
    pub max_file_bytes: Option<usize>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentSearchMatch {
    pub path: String,
    pub name: String,
    pub relative_path: String,
    pub line: usize,
    pub column: usize,
    pub excerpt: String,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentSearchReport {
    pub matches: Vec<ContentSearchMatch>,
    pub scanned_files: usize,
    pub skipped_files: usize,
    pub bytes_scanned: usize,
    pub cancelled: bool,
    /// True when any requested or hard file/byte/result bound stopped work.
    pub truncated: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexRefresh {
    pub generation: u64,
    pub added: usize,
    pub removed: usize,
    pub changed: usize,
    pub total: usize,
}

#[derive(Clone, Debug)]
struct IndexedFile {
    /// Shared so clones of the working set and public snapshots copy a
    /// pointer, not three heap strings.
    public: Arc<FileIndexEntry>,
    disk_path: PathBuf,
}

#[derive(Debug)]
struct IndexState {
    root: PathBuf,
    files: Vec<IndexedFile>,
    /// Prebuilt public projection of `files`, refreshed on every mutation so
    /// [`WorkspaceFileIndex::files`] is O(1).
    snapshot: FileIndexSnapshot,
}

/// Thread-safe workspace index. Searches clone the small metadata snapshot and
/// do not hold an index lock while touching the filesystem.
#[derive(Debug)]
pub struct WorkspaceFileIndex {
    state: RwLock<IndexState>,
    refresh_lock: Mutex<()>,
    workspace_generation: AtomicU64,
    search_generation: AtomicU64,
}

impl WorkspaceFileIndex {
    pub fn open(root: impl AsRef<Path>) -> Result<Self, FileIndexError> {
        let root = resolve_workspace(root.as_ref())?;
        let files = scan_workspace(&root);
        let snapshot = FileIndexSnapshot::of(&files);
        Ok(Self {
            state: RwLock::new(IndexState {
                root,
                files,
                snapshot,
            }),
            refresh_lock: Mutex::new(()),
            workspace_generation: AtomicU64::new(1),
            search_generation: AtomicU64::new(0),
        })
    }

    pub fn workspace(&self) -> PathBuf {
        self.state
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .root
            .clone()
    }

    pub fn generation(&self) -> u64 {
        self.workspace_generation.load(Ordering::Acquire)
    }

    /// Returns all indexed files in deterministic recent-first order.
    ///
    /// The snapshot is shared, so this costs one lock acquisition and one
    /// atomic increment regardless of workspace size.
    pub fn files(&self) -> FileIndexSnapshot {
        self.state
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .snapshot
            .clone()
    }

    /// Returns only indexed files covered by the changed paths.
    ///
    /// Watcher events use this to send an O(changed paths) renderer delta for
    /// ordinary edits instead of serializing the complete workspace index.
    pub fn files_for_paths(&self, changed_paths: &[PathBuf]) -> Vec<FileIndexEntry> {
        if changed_paths.is_empty() {
            return Vec::new();
        }
        let state = self
            .state
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let paths = changed_paths
            .iter()
            .map(|path| {
                let candidate = if path.is_absolute() {
                    path.clone()
                } else {
                    state.root.join(path)
                };
                normalize_changed_path(&candidate)
            })
            .collect::<Vec<_>>();
        state
            .files
            .iter()
            .filter(|file| {
                paths
                    .iter()
                    .any(|path| file.disk_path == *path || file.disk_path.starts_with(path))
            })
            .map(|file| file.public.as_ref().clone())
            .collect()
    }

    /// Replaces the workspace and invalidates every outstanding search.
    ///
    /// The old entries are cleared before scanning, so a concurrent consumer
    /// can never receive old-workspace paths under the new generation.
    pub fn replace_workspace(
        &self,
        root: impl AsRef<Path>,
    ) -> Result<IndexRefresh, FileIndexError> {
        let root = resolve_workspace(root.as_ref())?;
        let _refresh = self
            .refresh_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        let previous = {
            let mut state = self
                .state
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let previous = std::mem::take(&mut state.files);
            state.snapshot = FileIndexSnapshot::empty();
            state.root = root.clone();
            previous
        };
        self.invalidate_searches();

        let files = scan_workspace(&root);
        let refresh = self.install_files(previous, files);
        Ok(refresh)
    }

    pub fn refresh(&self) -> Result<IndexRefresh, FileIndexError> {
        let _refresh = self
            .refresh_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let (root, previous) = {
            let state = self
                .state
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            (state.root.clone(), state.files.clone())
        };

        // Root deletion is distinct from unreadable descendants, which are
        // intentionally skipped during scanning.
        if !root.is_dir() {
            return Err(FileIndexError::NotDirectory(root));
        }

        let files = scan_workspace(&root);
        Ok(self.install_files(previous, files))
    }

    /// Watcher integration point.
    ///
    /// Call this after debouncing a batch (roughly 50–150 ms is usually right).
    /// Existing-file edits and deletes are updated without walking the
    /// workspace. Creates, renames, directory changes, and ignore-rule changes
    /// rebuild from disk so `.gitignore` semantics and atomic saves remain
    /// correct.
    pub fn refresh_paths(&self, changed_paths: &[PathBuf]) -> Result<IndexRefresh, FileIndexError> {
        if changed_paths.is_empty() {
            return self.refresh();
        }

        let _refresh = self
            .refresh_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let (root, previous) = {
            let state = self
                .state
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            (state.root.clone(), state.files.clone())
        };
        if !root.is_dir() {
            return Err(FileIndexError::NotDirectory(root));
        }

        let previous_paths: HashSet<_> =
            previous.iter().map(|file| file.disk_path.clone()).collect();
        let mut affected = HashSet::new();
        let mut full_scan = false;

        for changed_path in changed_paths {
            let candidate = if changed_path.is_absolute() {
                changed_path.clone()
            } else {
                root.join(changed_path)
            };
            // macOS commonly reports `/var/...` while the canonical workspace
            // root is `/private/var/...`. Resolve the nearest existing ancestor
            // too, so deleted paths retain the same identity as indexed paths.
            let path = normalize_changed_path(&candidate);
            if path.strip_prefix(&root).is_err() {
                continue;
            }
            if path == root || changes_ignore_rules(&root, &path) {
                full_scan = true;
                break;
            }

            match fs::symlink_metadata(&path) {
                Ok(metadata) if metadata.is_dir() => {
                    full_scan = true;
                    break;
                }
                Ok(metadata) if metadata.file_type().is_file() => {
                    if previous_paths.contains(&path) {
                        affected.insert(path);
                    } else {
                        // A newly created or renamed file must pass through the
                        // ignore-aware walker before it enters the public index.
                        full_scan = true;
                        break;
                    }
                }
                Ok(_) => {
                    if previous_paths.contains(&path) {
                        affected.insert(path);
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    if previous_paths.contains(&path) {
                        affected.insert(path);
                    } else if previous
                        .iter()
                        .any(|file| file.disk_path.starts_with(&path))
                    {
                        // A missing path with indexed descendants was a
                        // directory deletion or rename.
                        full_scan = true;
                        break;
                    }
                }
                Err(_) => {
                    full_scan = true;
                    break;
                }
            }
        }

        if full_scan {
            return Ok(self.install_files(previous, scan_workspace(&root)));
        }

        let mut files: Vec<_> = previous
            .iter()
            .filter(|file| !affected.contains(&file.disk_path))
            .cloned()
            .collect();
        for path in affected {
            if let Some(file) = index_file(&root, &path) {
                files.push(file);
            }
        }
        sort_indexed_files(&mut files);
        Ok(self.install_files(previous, files))
    }

    /// Fuzzy filename/relative-path filtering over the metadata snapshot.
    ///
    /// Candidates flow through a heap bounded at the result limit, so entries
    /// beyond the limit are ranked by reference and never cloned.
    pub fn filter_files(&self, query: &str, max_results: Option<usize>) -> Vec<FileFilterHit> {
        let limit = max_results
            .unwrap_or(DEFAULT_FILTER_RESULTS)
            .min(HARD_MAX_FILTER_RESULTS);
        if limit == 0 {
            return Vec::new();
        }

        let query = query.trim().to_lowercase();
        let state = self
            .state
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut best = BinaryHeap::with_capacity(limit + 1);
        for file in &state.files {
            let Some(score) =
                fuzzy_path_score(&query, &file.public.name, &file.public.relative_path)
            else {
                continue;
            };
            let candidate = FilterCandidate {
                score,
                file: file.public.as_ref(),
            };
            if best.len() < limit {
                best.push(candidate);
            } else if let Some(mut worst) = best.peek_mut() {
                if candidate.cmp(&worst) == CmpOrdering::Less {
                    *worst = candidate;
                }
            }
        }

        best.into_sorted_vec()
            .into_iter()
            .map(|candidate| FileFilterHit {
                file: candidate.file.clone(),
                score: candidate.score,
            })
            .collect()
    }

    /// Starts a latest-request-wins content search. Starting another search
    /// automatically cancels tokens issued earlier.
    pub fn begin_content_search(&self) -> ContentSearchToken {
        ContentSearchToken {
            request_generation: self.search_generation.fetch_add(1, Ordering::AcqRel) + 1,
            workspace_generation: self.workspace_generation.load(Ordering::Acquire),
        }
    }

    pub fn cancel_content_search(&self, token: ContentSearchToken) -> bool {
        self.search_generation
            .compare_exchange(
                token.request_generation,
                token.request_generation.saturating_add(1),
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
    }

    /// Searches indexed text files under strict result, file, and byte bounds.
    /// Missing, changed, unreadable, or non-UTF-8 files are skipped safely.
    pub fn search_content(
        &self,
        token: ContentSearchToken,
        request: &ContentSearchRequest,
    ) -> ContentSearchReport {
        let mut report = ContentSearchReport::default();
        if self.is_cancelled(token) {
            report.cancelled = true;
            return report;
        }

        let query = request.query.trim();
        if query.is_empty() {
            return report;
        }
        let query_lower = query.to_lowercase();
        let path_query = request
            .path_query
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_lowercase);
        let max_results = request
            .max_results
            .unwrap_or(DEFAULT_CONTENT_RESULTS)
            .min(HARD_MAX_CONTENT_RESULTS);
        let max_files = request
            .max_files
            .unwrap_or(DEFAULT_SEARCH_FILES)
            .min(HARD_MAX_SEARCH_FILES);
        let max_total_bytes = request
            .max_total_bytes
            .unwrap_or(DEFAULT_SEARCH_BYTES)
            .min(HARD_MAX_SEARCH_BYTES);
        let max_file_bytes = request
            .max_file_bytes
            .unwrap_or(DEFAULT_FILE_BYTES)
            .min(HARD_MAX_FILE_BYTES);

        if max_results == 0 || max_files == 0 || max_total_bytes == 0 || max_file_bytes == 0 {
            report.truncated = true;
            return report;
        }

        let files = self
            .state
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .files
            .clone();

        for file in files {
            if self.is_cancelled(token) {
                report.cancelled = true;
                return report;
            }
            if report.scanned_files >= max_files || report.bytes_scanned >= max_total_bytes {
                report.truncated = true;
                break;
            }
            if !file.public.text_readable {
                report.skipped_files += 1;
                continue;
            }
            if let Some(path_query) = path_query.as_deref() {
                if fuzzy_path_score(path_query, &file.public.name, &file.public.relative_path)
                    .is_none()
                {
                    continue;
                }
            }

            report.scanned_files += 1;
            let remaining_total = max_total_bytes - report.bytes_scanned;
            let read_limit = max_file_bytes.min(remaining_total);
            let (bytes, file_was_truncated) =
                match read_bounded(&file.disk_path, read_limit, || self.is_cancelled(token)) {
                    Ok(ReadOutcome::Cancelled) => {
                        report.cancelled = true;
                        return report;
                    }
                    Ok(ReadOutcome::Complete { bytes, truncated }) => (bytes, truncated),
                    Err(_) => {
                        report.skipped_files += 1;
                        continue;
                    }
                };
            report.bytes_scanned += bytes.len();
            report.truncated |= file_was_truncated;

            let content = match std::str::from_utf8(&bytes) {
                Ok(content) => content,
                Err(_) => {
                    report.skipped_files += 1;
                    continue;
                }
            };

            // One case-fold per file instead of one per line. Lowercasing
            // never adds or removes newlines, so both iterators stay aligned.
            let content_lower = content.to_lowercase();
            for (line_index, (line, lower)) in
                content.lines().zip(content_lower.lines()).enumerate()
            {
                if line_index % 64 == 0 && self.is_cancelled(token) {
                    report.cancelled = true;
                    return report;
                }
                let Some(match_byte) = lower.find(&query_lower) else {
                    continue;
                };
                let column = lower[..match_byte].chars().count() + 1;
                report.matches.push(ContentSearchMatch {
                    path: file.public.path.clone(),
                    name: file.public.name.clone(),
                    relative_path: file.public.relative_path.clone(),
                    line: line_index + 1,
                    column,
                    excerpt: make_excerpt(line, column - 1, query.chars().count()),
                });
                if report.matches.len() >= max_results {
                    report.truncated = true;
                    return report;
                }
            }
        }

        report
    }

    fn install_files(&self, previous: Vec<IndexedFile>, files: Vec<IndexedFile>) -> IndexRefresh {
        let (added, removed, changed) = diff_files(&previous, &files);
        let total = files.len();
        let snapshot = FileIndexSnapshot::of(&files);
        {
            let mut state = self
                .state
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.files = files;
            state.snapshot = snapshot;
        }
        let generation = self.invalidate_searches();
        IndexRefresh {
            generation,
            added,
            removed,
            changed,
            total,
        }
    }

    fn invalidate_searches(&self) -> u64 {
        self.search_generation.fetch_add(1, Ordering::AcqRel);
        self.workspace_generation.fetch_add(1, Ordering::AcqRel) + 1
    }

    fn is_cancelled(&self, token: ContentSearchToken) -> bool {
        token.request_generation != self.search_generation.load(Ordering::Acquire)
            || token.workspace_generation != self.workspace_generation.load(Ordering::Acquire)
    }
}

/// Bounded-heap entry for [`WorkspaceFileIndex::filter_files`].
///
/// The ordering ranks better hits as `Less`, so the heap root is always the
/// weakest retained candidate and `into_sorted_vec` yields best-first order —
/// identical to the previous full sort.
struct FilterCandidate<'a> {
    score: i64,
    file: &'a FileIndexEntry,
}

impl Ord for FilterCandidate<'_> {
    fn cmp(&self, other: &Self) -> CmpOrdering {
        other
            .score
            .cmp(&self.score)
            .then_with(|| other.file.mtime.cmp(&self.file.mtime))
            .then_with(|| self.file.relative_path.cmp(&other.file.relative_path))
    }
}

impl PartialOrd for FilterCandidate<'_> {
    fn partial_cmp(&self, other: &Self) -> Option<CmpOrdering> {
        Some(self.cmp(other))
    }
}

impl PartialEq for FilterCandidate<'_> {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == CmpOrdering::Equal
    }
}

impl Eq for FilterCandidate<'_> {}

fn resolve_workspace(path: &Path) -> Result<PathBuf, FileIndexError> {
    if !path.is_dir() {
        return Err(FileIndexError::NotDirectory(path.to_path_buf()));
    }
    fs::canonicalize(path).map_err(|source| FileIndexError::WorkspaceIo {
        path: path.to_path_buf(),
        source,
    })
}

fn scan_workspace(root: &Path) -> Vec<IndexedFile> {
    let mut builder = WalkBuilder::new(root);
    builder
        .hidden(false)
        .follow_links(false)
        .parents(true)
        .ignore(true)
        .git_ignore(true)
        .git_exclude(true)
        // Workspaces need not be initialized Git repositories yet; their
        // `.gitignore` files still express the user's intended file surface.
        .require_git(false)
        .filter_entry(include_entry);

    // The parallel walk spreads directory traversal and the per-file metadata
    // and text probes across threads. Arrival order is nondeterministic, so
    // the sort below alone establishes the deterministic recent-first order.
    let collected = Mutex::new(Vec::new());
    builder.build_parallel().run(|| {
        Box::new(|result| {
            let entry = match result {
                Ok(entry) => entry,
                Err(_) => return WalkState::Continue,
            };
            if entry.depth() == 0 {
                return WalkState::Continue;
            }
            let file_type = match entry.file_type() {
                Some(file_type) => file_type,
                None => return WalkState::Continue,
            };
            // Never index or traverse symlinks. `follow_links(false)` prevents
            // recursion; this also keeps symlinked files out of the result set.
            if !file_type.is_file() {
                return WalkState::Continue;
            }

            let disk_path = entry.into_path();
            if let Some(file) = index_file(root, &disk_path) {
                collected
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .push(file);
            }
            WalkState::Continue
        })
    });

    let mut files = collected
        .into_inner()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    sort_indexed_files(&mut files);
    files
}

fn index_file(root: &Path, disk_path: &Path) -> Option<IndexedFile> {
    let metadata = fs::symlink_metadata(disk_path).ok()?;
    if !metadata.file_type().is_file() {
        return None;
    }
    let relative = disk_path.strip_prefix(root).ok()?;
    let name = disk_path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    Some(IndexedFile {
        public: Arc::new(FileIndexEntry {
            path: disk_path.to_string_lossy().into_owned(),
            name,
            relative_path: path_for_display(relative),
            mtime: modified_millis(metadata.modified().ok()),
            size: metadata.len(),
            text_readable: is_text_readable(disk_path),
        }),
        disk_path: disk_path.to_path_buf(),
    })
}

fn sort_indexed_files(files: &mut [IndexedFile]) {
    files.sort_by(|left, right| {
        right
            .public
            .mtime
            .cmp(&left.public.mtime)
            .then_with(|| left.public.relative_path.cmp(&right.public.relative_path))
    });
}

fn changes_ignore_rules(root: &Path, path: &Path) -> bool {
    let relative = path.strip_prefix(root).unwrap_or(path);
    let file_name = relative.file_name().and_then(|name| name.to_str());
    matches!(file_name, Some(".gitignore" | ".ignore" | "exclude"))
        || relative == Path::new(".git/info/exclude")
}

fn normalize_changed_path(path: &Path) -> PathBuf {
    if let Ok(canonical) = fs::canonicalize(path) {
        return canonical;
    }
    let mut ancestor = path;
    let mut suffix = Vec::new();
    while let Some(name) = ancestor.file_name() {
        suffix.push(name.to_os_string());
        let Some(parent) = ancestor.parent() else {
            break;
        };
        if let Ok(mut canonical) = fs::canonicalize(parent) {
            for component in suffix.iter().rev() {
                canonical.push(component);
            }
            return canonical;
        }
        ancestor = parent;
    }
    path.to_path_buf()
}

fn include_entry(entry: &DirEntry) -> bool {
    if entry.depth() == 0 {
        return true;
    }
    let name = entry.file_name().to_string_lossy();
    match entry.file_type() {
        Some(kind) if kind.is_dir() => !NOISE_DIRECTORIES.contains(&name.as_ref()),
        Some(kind) if kind.is_symlink() => false,
        _ => !NOISE_FILES.contains(&name.as_ref()),
    }
}

fn path_for_display(path: &Path) -> String {
    path.components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn modified_millis(modified: Option<SystemTime>) -> i64 {
    modified
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

fn is_text_readable(path: &Path) -> bool {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase);

    if extension
        .as_deref()
        .map(|extension| BINARY_EXTENSIONS.contains(&extension))
        .unwrap_or(false)
    {
        return false;
    }
    if extension
        .as_deref()
        .map(|extension| TEXT_EXTENSIONS.contains(&extension))
        .unwrap_or(false)
    {
        return true;
    }

    let mut bytes = Vec::new();
    let mut file = match File::open(path) {
        Ok(file) => file.take(TEXT_PROBE_BYTES),
        Err(_) => return false,
    };
    if file.read_to_end(&mut bytes).is_err() || bytes.contains(&0) {
        return false;
    }
    std::str::from_utf8(&bytes).is_ok()
}

fn fuzzy_path_score(query: &str, name: &str, relative_path: &str) -> Option<i64> {
    if query.is_empty() {
        return Some(0);
    }
    let name_lower = name.to_lowercase();
    let path_lower = relative_path.to_lowercase();
    let mut score = subsequence_score(query, &path_lower)?;

    if name_lower == query {
        score += 500;
    } else if name_lower.starts_with(query) {
        score += 300;
    } else if name_lower.contains(query) {
        score += 180;
    } else if subsequence_score(query, &name_lower).is_some() {
        score += 80;
    }
    Some(score)
}

fn subsequence_score(query: &str, candidate: &str) -> Option<i64> {
    let query: Vec<char> = query.chars().collect();
    let candidate: Vec<char> = candidate.chars().collect();
    let mut candidate_index = 0;
    let mut previous_match = None;
    let mut score = 0_i64;

    for &query_char in &query {
        let mut found = None;
        while candidate_index < candidate.len() {
            if candidate[candidate_index] == query_char {
                found = Some(candidate_index);
                candidate_index += 1;
                break;
            }
            candidate_index += 1;
        }
        let position = found?;
        score += 20;
        if previous_match == position.checked_sub(1) {
            score += 24;
        }
        if position == 0
            || matches!(
                candidate.get(position.wrapping_sub(1)),
                Some('/' | '\\' | '-' | '_' | ' ' | '.')
            )
        {
            score += 16;
        }
        if let Some(previous) = previous_match {
            score -= position.saturating_sub(previous + 1) as i64;
        }
        previous_match = Some(position);
    }
    score -= candidate.len().saturating_sub(query.len()) as i64 / 4;
    Some(score)
}

enum ReadOutcome {
    Cancelled,
    Complete { bytes: Vec<u8>, truncated: bool },
}

fn read_bounded(
    path: &Path,
    max_bytes: usize,
    cancelled: impl Fn() -> bool,
) -> io::Result<ReadOutcome> {
    let mut file = File::open(path)?;
    let known_size = file.metadata().ok().map(|metadata| metadata.len());
    let mut bytes = Vec::with_capacity(max_bytes.min(READ_CHUNK_BYTES));
    let mut chunk = [0_u8; READ_CHUNK_BYTES];

    while bytes.len() < max_bytes {
        if cancelled() {
            return Ok(ReadOutcome::Cancelled);
        }
        let remaining = max_bytes - bytes.len();
        let read = file.read(&mut chunk[..remaining.min(READ_CHUNK_BYTES)])?;
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..read]);
    }

    let truncated = known_size
        .map(|size| size > bytes.len() as u64)
        .unwrap_or(bytes.len() == max_bytes);
    Ok(ReadOutcome::Complete { bytes, truncated })
}

fn make_excerpt(line: &str, match_column: usize, match_chars: usize) -> String {
    let chars: Vec<char> = line.trim_end_matches('\r').chars().collect();
    if chars.len() <= MAX_EXCERPT_CHARS {
        return chars.into_iter().collect();
    }

    let context = MAX_EXCERPT_CHARS.saturating_sub(match_chars.min(MAX_EXCERPT_CHARS)) / 2;
    let mut start = match_column.saturating_sub(context);
    let mut end = (start + MAX_EXCERPT_CHARS).min(chars.len());
    if end - start < MAX_EXCERPT_CHARS {
        start = end.saturating_sub(MAX_EXCERPT_CHARS);
    }
    // Avoid a trailing empty range if Unicode case folding made the approximate
    // column longer than the source line.
    start = start.min(chars.len());
    end = end.max(start).min(chars.len());

    let mut excerpt = String::new();
    if start > 0 {
        excerpt.push('…');
    }
    excerpt.extend(chars[start..end].iter());
    if end < chars.len() {
        excerpt.push('…');
    }
    excerpt
}

fn diff_files(previous: &[IndexedFile], next: &[IndexedFile]) -> (usize, usize, usize) {
    let previous: HashMap<_, _> = previous
        .iter()
        .map(|file| (file.public.relative_path.as_str(), &file.public))
        .collect();
    let next: HashMap<_, _> = next
        .iter()
        .map(|file| (file.public.relative_path.as_str(), &file.public))
        .collect();
    let added = next
        .keys()
        .filter(|relative_path| !previous.contains_key(**relative_path))
        .count();
    let removed = previous
        .keys()
        .filter(|relative_path| !next.contains_key(**relative_path))
        .count();
    let changed = next
        .iter()
        .filter(|(relative_path, file)| {
            previous
                .get(**relative_path)
                .map(|previous| *previous != **file)
                .unwrap_or(false)
        })
        .count();
    (added, removed, changed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fmt::Write;
    use std::thread;
    use std::time::Duration;
    use tempfile::TempDir;

    fn write(root: &Path, relative: &str, contents: &str) {
        let path = root.join(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, contents).unwrap();
    }

    fn relative_paths(index: &WorkspaceFileIndex) -> Vec<String> {
        index
            .files()
            .iter()
            .map(|file| file.relative_path.clone())
            .collect()
    }

    #[test]
    fn indexes_recent_first_and_honors_ignore_and_noise_rules() {
        let temp = TempDir::new().unwrap();
        write(temp.path(), ".gitignore", "ignored.txt\nprivate/\n");
        write(temp.path(), "old.md", "old");
        thread::sleep(Duration::from_millis(20));
        write(temp.path(), "src/new.rs", "fn main() {}");
        write(temp.path(), "ignored.txt", "no");
        write(temp.path(), "private/secret.txt", "no");
        write(temp.path(), "node_modules/pkg/index.js", "no");
        write(temp.path(), "target/debug/artifact", "no");
        write(temp.path(), ".env", "VISIBLE=yes");

        let index = WorkspaceFileIndex::open(temp.path()).unwrap();
        let paths = relative_paths(&index);
        assert!(paths.contains(&"src/new.rs".to_owned()));
        assert!(paths.contains(&"old.md".to_owned()));
        assert!(paths.contains(&".env".to_owned()));
        assert!(!paths.contains(&"ignored.txt".to_owned()));
        assert!(!paths.iter().any(|path| path.starts_with("private/")));
        assert!(!paths.iter().any(|path| path.starts_with("node_modules/")));
        assert!(!paths.iter().any(|path| path.starts_with("target/")));

        let new_position = paths.iter().position(|path| path == "src/new.rs").unwrap();
        let old_position = paths.iter().position(|path| path == "old.md").unwrap();
        assert!(new_position < old_position);
    }

    #[test]
    fn deterministic_ties_and_fuzzy_filename_priority() {
        let temp = TempDir::new().unwrap();
        write(temp.path(), "z/docs/synthesis.md", "one");
        write(temp.path(), "a/synth-notes.md", "two");
        write(temp.path(), "synthesis.txt", "three");
        let index = WorkspaceFileIndex::open(temp.path()).unwrap();

        let hits = index.filter_files("synthesis", None);
        assert_eq!(hits[0].file.name, "synthesis.txt");
        assert!(hits.iter().any(|hit| hit.file.name == "synthesis.md"));

        let files = index.files();
        for pair in files.windows(2) {
            if pair[0].mtime == pair[1].mtime {
                assert!(pair[0].relative_path <= pair[1].relative_path);
            }
        }
    }

    #[test]
    fn filter_limit_returns_the_best_hits_in_full_ranking_order() {
        let temp = TempDir::new().unwrap();
        write(temp.path(), "notes.md", "x");
        write(temp.path(), "another-notes.md", "x");
        for directory in 0..8 {
            write(temp.path(), &format!("dir-{directory}/notes.md"), "x");
        }
        let index = WorkspaceFileIndex::open(temp.path()).unwrap();

        let all = index.filter_files("notes", None);
        assert_eq!(all.len(), 10);
        for pair in all.windows(2) {
            assert!(pair[0].score >= pair[1].score);
        }

        let limited = index.filter_files("notes", Some(3));
        assert_eq!(limited, all[..3].to_vec());
        assert_eq!(index.filter_files("notes", Some(500)), all);
        assert!(index.filter_files("notes", Some(0)).is_empty());
    }

    #[test]
    fn snapshot_serializes_like_a_plain_entry_list() {
        let temp = TempDir::new().unwrap();
        write(temp.path(), "src/one.rs", "one");
        write(temp.path(), "two.md", "two");
        let index = WorkspaceFileIndex::open(temp.path()).unwrap();

        let snapshot = index.files();
        let serialized = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(
            serialized,
            serde_json::to_value(snapshot.to_entries()).unwrap()
        );
        assert!(serialized[0].get("relativePath").is_some());
        assert!(serialized[0].get("textReadable").is_some());
    }

    #[test]
    fn metadata_marks_text_binary_and_non_utf8_safely() {
        let temp = TempDir::new().unwrap();
        write(temp.path(), "readme.md", "hello");
        fs::write(temp.path().join("image.png"), [0, 159, 146, 150]).unwrap();
        fs::write(temp.path().join("unknown.data"), [0xff, 0xfe, 0xfd]).unwrap();
        let index = WorkspaceFileIndex::open(temp.path()).unwrap();
        let files = index.files();
        let text = files.iter().find(|file| file.name == "readme.md").unwrap();
        let image = files.iter().find(|file| file.name == "image.png").unwrap();
        let invalid = files
            .iter()
            .find(|file| file.name == "unknown.data")
            .unwrap();
        assert!(text.text_readable);
        assert!(!image.text_readable);
        assert!(!invalid.text_readable);
        assert_eq!(text.size, 5);
        assert!(Path::new(&text.path).is_absolute());
    }

    #[test]
    fn known_source_types_do_not_require_content_probes() {
        let temp = TempDir::new().unwrap();

        assert!(is_text_readable(&temp.path().join("not-on-disk.rs")));
        assert!(!is_text_readable(&temp.path().join("not-on-disk.png")));
        assert!(!is_text_readable(&temp.path().join("not-on-disk.unknown")));
    }

    #[test]
    fn content_search_has_useful_locations_and_excerpts() {
        let temp = TempDir::new().unwrap();
        let long_line = format!("{}NEEDLE{}", "a".repeat(240), "z".repeat(240));
        write(
            temp.path(),
            "src/search.rs",
            &format!("first\n{long_line}\nlast"),
        );
        let index = WorkspaceFileIndex::open(temp.path()).unwrap();
        let token = index.begin_content_search();
        let report = index.search_content(
            token,
            &ContentSearchRequest {
                query: "needle".into(),
                path_query: Some("srcrs".into()),
                ..Default::default()
            },
        );

        assert!(!report.cancelled);
        assert_eq!(report.matches.len(), 1);
        assert_eq!(report.matches[0].relative_path, "src/search.rs");
        assert_eq!(report.matches[0].line, 2);
        assert_eq!(report.matches[0].column, 241);
        assert!(report.matches[0].excerpt.contains("NEEDLE"));
        assert!(report.matches[0].excerpt.chars().count() <= MAX_EXCERPT_CHARS + 2);
    }

    #[test]
    fn latest_search_and_workspace_refresh_cancel_old_tokens() {
        let temp = TempDir::new().unwrap();
        write(temp.path(), "one.txt", "needle");
        let index = WorkspaceFileIndex::open(temp.path()).unwrap();

        let stale = index.begin_content_search();
        let current = index.begin_content_search();
        let stale_report = index.search_content(
            stale,
            &ContentSearchRequest {
                query: "needle".into(),
                ..Default::default()
            },
        );
        assert!(stale_report.cancelled);

        index.refresh().unwrap();
        let refreshed_report = index.search_content(
            current,
            &ContentSearchRequest {
                query: "needle".into(),
                ..Default::default()
            },
        );
        assert!(refreshed_report.cancelled);
    }

    #[test]
    fn explicit_cancel_is_token_scoped() {
        let temp = TempDir::new().unwrap();
        write(temp.path(), "one.txt", "needle");
        let index = WorkspaceFileIndex::open(temp.path()).unwrap();
        let token = index.begin_content_search();
        assert!(index.cancel_content_search(token));
        assert!(!index.cancel_content_search(token));
        assert!(
            index
                .search_content(
                    token,
                    &ContentSearchRequest {
                        query: "needle".into(),
                        ..Default::default()
                    }
                )
                .cancelled
        );
    }

    #[test]
    fn content_search_enforces_requested_and_hard_bounds() {
        let temp = TempDir::new().unwrap();
        let mut content = String::new();
        for line in 0..260 {
            writeln!(&mut content, "needle line {line:03} {}", "x".repeat(32)).unwrap();
        }
        for file in 0..12 {
            write(temp.path(), &format!("file-{file:02}.txt"), &content);
        }
        let index = WorkspaceFileIndex::open(temp.path()).unwrap();

        let token = index.begin_content_search();
        let bounded = index.search_content(
            token,
            &ContentSearchRequest {
                query: "needle".into(),
                max_results: Some(3),
                max_files: Some(2),
                max_total_bytes: Some(1_000),
                max_file_bytes: Some(600),
                ..Default::default()
            },
        );
        assert!(bounded.matches.len() <= 3);
        assert!(bounded.scanned_files <= 2);
        assert!(bounded.bytes_scanned <= 1_000);
        assert!(bounded.truncated);

        let token = index.begin_content_search();
        let hard_bounded = index.search_content(
            token,
            &ContentSearchRequest {
                query: "needle".into(),
                max_results: Some(usize::MAX),
                max_files: Some(usize::MAX),
                max_total_bytes: Some(usize::MAX),
                max_file_bytes: Some(usize::MAX),
                ..Default::default()
            },
        );
        assert!(hard_bounded.matches.len() <= HARD_MAX_CONTENT_RESULTS);
        assert!(hard_bounded.scanned_files <= HARD_MAX_SEARCH_FILES);
        assert!(hard_bounded.bytes_scanned <= HARD_MAX_SEARCH_BYTES);
    }

    #[test]
    fn coalesced_refresh_reflects_create_delete_and_rename() {
        let temp = TempDir::new().unwrap();
        write(temp.path(), "before.txt", "one");
        let index = WorkspaceFileIndex::open(temp.path()).unwrap();

        fs::rename(
            temp.path().join("before.txt"),
            temp.path().join("after.txt"),
        )
        .unwrap();
        write(temp.path(), "new.txt", "two");
        let refresh = index
            .refresh_paths(&[
                temp.path().join("before.txt"),
                temp.path().join("after.txt"),
                temp.path().join("new.txt"),
            ])
            .unwrap();
        let paths = relative_paths(&index);
        assert!(!paths.contains(&"before.txt".to_owned()));
        assert!(paths.contains(&"after.txt".to_owned()));
        assert!(paths.contains(&"new.txt".to_owned()));
        assert_eq!(refresh.added, 2);
        assert_eq!(refresh.removed, 1);

        fs::remove_file(temp.path().join("after.txt")).unwrap();
        index
            .refresh_paths(&[temp.path().join("after.txt")])
            .unwrap();
        assert!(!relative_paths(&index).contains(&"after.txt".to_owned()));
    }

    #[test]
    fn existing_file_events_update_without_discovering_unreported_paths() {
        let temp = TempDir::new().unwrap();
        write(temp.path(), "tracked.txt", "one");
        let index = WorkspaceFileIndex::open(temp.path()).unwrap();

        write(
            temp.path(),
            "unreported.txt",
            "created in another event batch",
        );
        write(temp.path(), "tracked.txt", "a much longer edit");
        let refresh = index
            .refresh_paths(&[temp.path().join("tracked.txt")])
            .unwrap();

        let entries = index.files();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].relative_path, "tracked.txt");
        assert_eq!(entries[0].size, "a much longer edit".len() as u64);
        assert_eq!(refresh.changed, 1);
    }

    #[test]
    fn missing_files_during_search_are_skipped_and_new_external_files_refresh() {
        let temp = TempDir::new().unwrap();
        write(temp.path(), "vanishes.txt", "needle");
        let index = WorkspaceFileIndex::open(temp.path()).unwrap();
        fs::remove_file(temp.path().join("vanishes.txt")).unwrap();

        let token = index.begin_content_search();
        let missing = index.search_content(
            token,
            &ContentSearchRequest {
                query: "needle".into(),
                ..Default::default()
            },
        );
        assert!(missing.matches.is_empty());
        assert_eq!(missing.skipped_files, 1);

        write(temp.path(), "external/new.txt", "fresh needle");
        index
            .refresh_paths(&[temp.path().join("external/new.txt")])
            .unwrap();
        let token = index.begin_content_search();
        let fresh = index.search_content(
            token,
            &ContentSearchRequest {
                query: "needle".into(),
                ..Default::default()
            },
        );
        assert_eq!(fresh.matches.len(), 1);
        assert_eq!(fresh.matches[0].relative_path, "external/new.txt");
    }

    #[test]
    fn workspace_change_replaces_entries_and_cancels_search() {
        let first = TempDir::new().unwrap();
        let second = TempDir::new().unwrap();
        write(first.path(), "first.txt", "needle");
        write(second.path(), "second.txt", "needle");
        let index = WorkspaceFileIndex::open(first.path()).unwrap();
        let token = index.begin_content_search();

        index.replace_workspace(second.path()).unwrap();
        assert_eq!(relative_paths(&index), vec!["second.txt"]);
        assert!(
            index
                .search_content(
                    token,
                    &ContentSearchRequest {
                        query: "needle".into(),
                        ..Default::default()
                    }
                )
                .cancelled
        );
    }

    #[test]
    fn large_fixture_remains_complete_and_deterministic() {
        let temp = TempDir::new().unwrap();
        for directory in 0..10 {
            for file in 0..30 {
                write(
                    temp.path(),
                    &format!("src-{directory:02}/file-{file:02}.rs"),
                    "pub fn indexed() {}\n",
                );
            }
        }
        let index = WorkspaceFileIndex::open(temp.path()).unwrap();
        let first = relative_paths(&index);
        assert_eq!(first.len(), 300);
        index.refresh().unwrap();
        assert_eq!(relative_paths(&index), first);
    }

    #[test]
    fn changed_path_projection_returns_only_covered_index_entries() {
        let temp = TempDir::new().unwrap();
        write(temp.path(), "src/one.rs", "one");
        write(temp.path(), "src/nested/two.rs", "two");
        write(temp.path(), "docs/three.md", "three");
        let index = WorkspaceFileIndex::open(temp.path()).unwrap();

        let src = index.files_for_paths(&[temp.path().join("src")]);
        assert_eq!(
            src.iter()
                .map(|entry| entry.relative_path.as_str())
                .collect::<HashSet<_>>(),
            HashSet::from(["src/one.rs", "src/nested/two.rs"])
        );
        let one = index.files_for_paths(&[PathBuf::from("src/one.rs")]);
        assert_eq!(one.len(), 1);
        assert_eq!(one[0].relative_path, "src/one.rs");
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_files_and_directory_loops_are_not_followed() {
        use std::os::unix::fs::symlink;

        let temp = TempDir::new().unwrap();
        write(temp.path(), "real/file.txt", "visible");
        symlink(temp.path(), temp.path().join("real/loop")).unwrap();
        symlink(
            temp.path().join("real/file.txt"),
            temp.path().join("linked.txt"),
        )
        .unwrap();

        let index = WorkspaceFileIndex::open(temp.path()).unwrap();
        assert_eq!(relative_paths(&index), vec!["real/file.txt"]);
    }
}
