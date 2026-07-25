//! Fast, bounded workspace file discovery and content search.
//!
//! The index is an in-memory projection of the filesystem, not a database. A
//! watcher should debounce its events and pass the coalesced paths to
//! [`WorkspaceFileIndex::refresh_paths`]. Rebuilding from disk keeps `.gitignore`
//! changes, renames, directory removals, and editor atomic-save patterns correct
//! without maintaining a second, subtly different filesystem tree.

use ignore::{DirEntry, WalkBuilder};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, RwLock};
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
    public: FileIndexEntry,
    disk_path: PathBuf,
}

#[derive(Debug)]
struct IndexState {
    root: PathBuf,
    files: Vec<IndexedFile>,
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
        Ok(Self {
            state: RwLock::new(IndexState { root, files }),
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
    pub fn files(&self) -> Vec<FileIndexEntry> {
        self.state
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .files
            .iter()
            .map(|file| file.public.clone())
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
    /// `changed_paths` is presently a correctness hint: the index rebuilds from
    /// disk so nested `.gitignore` edits, directory renames, removals, and
    /// atomic-save replacement are all reflected together. The signature can
    /// adopt a selective scanner later without changing watcher call sites.
    pub fn refresh_paths(
        &self,
        _changed_paths: &[PathBuf],
    ) -> Result<IndexRefresh, FileIndexError> {
        self.refresh()
    }

    /// Fuzzy filename/relative-path filtering over the metadata snapshot.
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
        let mut hits: Vec<_> = state
            .files
            .iter()
            .filter_map(|file| {
                fuzzy_path_score(&query, &file.public.name, &file.public.relative_path).map(
                    |score| FileFilterHit {
                        file: file.public.clone(),
                        score,
                    },
                )
            })
            .collect();

        hits.sort_by(|left, right| {
            right
                .score
                .cmp(&left.score)
                .then_with(|| right.file.mtime.cmp(&left.file.mtime))
                .then_with(|| left.file.relative_path.cmp(&right.file.relative_path))
        });
        hits.truncate(limit);
        hits
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

            for (line_index, line) in content.lines().enumerate() {
                if line_index % 64 == 0 && self.is_cancelled(token) {
                    report.cancelled = true;
                    return report;
                }
                let lower = line.to_lowercase();
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
        self.state
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .files = files;
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

    let mut files = Vec::new();
    for result in builder.build() {
        let entry = match result {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        if entry.depth() == 0 {
            continue;
        }
        let file_type = match entry.file_type() {
            Some(file_type) => file_type,
            None => continue,
        };
        // Never index or traverse symlinks. `follow_links(false)` prevents
        // recursion; this also keeps symlinked files out of the result set.
        if !file_type.is_file() {
            continue;
        }

        let disk_path = entry.into_path();
        let metadata = match fs::metadata(&disk_path) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        let relative = match disk_path.strip_prefix(root) {
            Ok(relative) => relative,
            Err(_) => continue,
        };
        let name = disk_path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        files.push(IndexedFile {
            public: FileIndexEntry {
                path: disk_path.to_string_lossy().into_owned(),
                name,
                relative_path: path_for_display(relative),
                mtime: modified_millis(metadata.modified().ok()),
                size: metadata.len(),
                text_readable: is_text_readable(&disk_path),
            },
            disk_path,
        });
    }

    files.sort_by(|left, right| {
        right
            .public
            .mtime
            .cmp(&left.public.mtime)
            .then_with(|| left.public.relative_path.cmp(&right.public.relative_path))
    });
    files
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
    if path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| BINARY_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
    {
        return false;
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
            .into_iter()
            .map(|file| file.relative_path)
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
