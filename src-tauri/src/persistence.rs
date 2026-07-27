//! Small, shared persistence primitives for durable local application state.
//!
//! State is serialized before the destination is touched, written to a unique
//! temporary file in the destination directory, flushed to disk, and then
//! atomically renamed into place. Keeping the temporary file beside the target
//! is important: a rename is only guaranteed to be atomic within one
//! filesystem.

use serde::{de::DeserializeOwned, Serialize};
use std::{
    collections::HashMap,
    ffi::{OsStr, OsString},
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    process,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, OnceLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use thiserror::Error;

static UNIQUE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// How long a parent-directory fsync stays "fresh". Writers that replace files
/// in the same directory within this window (e.g. PTY scrollback persistence
/// every 250ms) skip the redundant directory fsync.
const DIRECTORY_SYNC_WINDOW: Duration = Duration::from_secs(2);

/// Temporary files at least this old are litter from a writer that died
/// between its temporary write and the rename. Live writers hold a temporary
/// for milliseconds, so an hour is far beyond any writer still in flight.
const STALE_TEMPORARY_AGE: Duration = Duration::from_secs(60 * 60);

fn recent_directory_syncs() -> &'static Mutex<HashMap<PathBuf, Instant>> {
    static RECENT: OnceLock<Mutex<HashMap<PathBuf, Instant>>> = OnceLock::new();
    RECENT.get_or_init(|| Mutex::new(HashMap::new()))
}

/// An error raised while reading or durably replacing persisted JSON.
#[derive(Debug, Error)]
pub enum PersistenceError {
    #[error("could not serialize JSON for {path}: {source}")]
    Serialize {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },

    #[error("could not deserialize JSON from {path}: {source}")]
    Deserialize {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },

    #[error("could not {operation} {path}: {source}")]
    Io {
        operation: &'static str,
        path: PathBuf,
        #[source]
        source: io::Error,
    },
}

/// The result of loading state with automatic corrupt-file quarantine.
#[derive(Debug)]
pub enum QuarantinedLoad<T> {
    Missing,
    Loaded(T),
    Quarantined {
        /// The new path of the corrupt file.
        path: PathBuf,
        /// The parse error that caused quarantine.
        reason: String,
    },
}

/// Serialize `value` as pretty JSON and atomically replace `path`.
///
/// Parent directories are created when needed. The completed JSON ends in a
/// newline so files remain pleasant to inspect and edit by hand.
pub fn write_json_atomic<T>(path: impl AsRef<Path>, value: &T) -> Result<(), PersistenceError>
where
    T: Serialize + ?Sized,
{
    let path = path.as_ref();
    validate_file_name(path)?;

    let mut contents =
        serde_json::to_vec_pretty(value).map_err(|source| PersistenceError::Serialize {
            path: path.to_path_buf(),
            source,
        })?;
    contents.push(b'\n');
    write_bytes_atomic(path, &contents)
}

/// Atomically replace `path` with already-serialized bytes.
pub fn write_bytes_atomic(path: impl AsRef<Path>, contents: &[u8]) -> Result<(), PersistenceError> {
    write_bytes_atomic_inner(path.as_ref(), contents, false)
}

/// Atomically replace a secret file and enforce owner-only permissions on
/// Unix before any secret bytes are written to its temporary file.
#[cfg(debug_assertions)]
pub fn write_secret_bytes_atomic(
    path: impl AsRef<Path>,
    contents: &[u8],
) -> Result<(), PersistenceError> {
    write_bytes_atomic_inner(path.as_ref(), contents, true)
}

fn write_bytes_atomic_inner(
    path: &Path,
    contents: &[u8],
    owner_only: bool,
) -> Result<(), PersistenceError> {
    validate_file_name(path)?;

    let parent = parent_directory(path);
    fs::create_dir_all(parent)
        .map_err(|source| io_error("create parent directory for", parent, source))?;

    let existing_permissions = match fs::metadata(path) {
        Ok(metadata) => {
            let permissions = metadata.permissions();
            if !owner_only && permissions.readonly() {
                return Err(io_error(
                    "replace read-only file at",
                    path,
                    io::Error::new(io::ErrorKind::PermissionDenied, "file is read-only"),
                ));
            }
            Some(permissions)
        }
        Err(source) if source.kind() == io::ErrorKind::NotFound => None,
        Err(source) => return Err(io_error("inspect file before replacing", path, source)),
    };

    let mut pending = create_pending_file(path)?;
    #[cfg(unix)]
    if owner_only {
        use std::os::unix::fs::PermissionsExt;
        pending
            .file_mut()
            .set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|source| {
                io_error(
                    "set owner-only permissions on temporary secret file",
                    pending.path(),
                    source,
                )
            })?;
    }
    pending
        .file_mut()
        .write_all(contents)
        .map_err(|source| io_error("write temporary persistence file", pending.path(), source))?;
    pending
        .file_mut()
        .flush()
        .map_err(|source| io_error("flush temporary persistence file", pending.path(), source))?;
    if !owner_only {
        if let Some(permissions) = existing_permissions {
            pending
                .file_mut()
                .set_permissions(permissions)
                .map_err(|source| {
                    io_error(
                        "preserve replaced file permissions for",
                        pending.path(),
                        source,
                    )
                })?;
        }
    }
    pending
        .file_mut()
        .sync_all()
        .map_err(|source| io_error("sync temporary persistence file", pending.path(), source))?;

    // Closing before rename is required on platforms that do not permit a
    // rename while the source file still has an open handle.
    pending.close();
    fs::rename(pending.path(), path)
        .map_err(|source| io_error("atomically replace persistence file at", path, source))?;
    pending.disarm();

    // The rename succeeded, so any same-target temporary old enough to predate
    // every live writer is litter from a crashed one; collect it before the
    // directory sync so an fsync issued below also covers the unlinks.
    collect_stale_temporaries(path);

    sync_directory_debounced(parent)?;
    Ok(())
}

/// Sync `parent` unless it was already synced within [`DIRECTORY_SYNC_WINDOW`].
///
/// Returns whether an fsync was actually issued. Durability tradeoff: the file
/// itself is always fully synced before the rename, but skipping the directory
/// fsync means that after a crash or power loss within the window the *rename*
/// may not yet be durable — the directory may still reference the previous
/// version of the file (or, for a brand-new file, none at all). For
/// high-frequency writers this bounds the loss to roughly the last window of
/// replacements while eliminating a per-write directory fsync.
fn sync_directory_debounced(parent: &Path) -> Result<bool, PersistenceError> {
    let now = Instant::now();
    {
        let recent = lock_recent_directory_syncs();
        if let Some(last) = recent.get(parent) {
            if now.saturating_duration_since(*last) < DIRECTORY_SYNC_WINDOW {
                return Ok(false);
            }
        }
    }

    // The sync happens outside the lock; only a successful sync is recorded so
    // a transient failure never suppresses the next attempt.
    sync_directory(parent)?;

    let mut recent = lock_recent_directory_syncs();
    if recent.len() >= 64 {
        recent.retain(|_, synced| now.saturating_duration_since(*synced) < DIRECTORY_SYNC_WINDOW);
    }
    recent.insert(parent.to_path_buf(), now);
    Ok(true)
}

fn lock_recent_directory_syncs() -> std::sync::MutexGuard<'static, HashMap<PathBuf, Instant>> {
    recent_directory_syncs()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Load JSON from `path`, returning `None` when the file does not exist.
///
/// Read and parse failures remain distinct: callers may handle malformed
/// user-editable state differently from filesystem failures.
pub fn load_json_optional<T>(path: impl AsRef<Path>) -> Result<Option<T>, PersistenceError>
where
    T: DeserializeOwned,
{
    let path = path.as_ref();
    let contents = match fs::read(path) {
        Ok(contents) => contents,
        Err(source) if source.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(source) => return Err(io_error("read persistence file", path, source)),
    };

    serde_json::from_slice(&contents)
        .map(Some)
        .map_err(|source| PersistenceError::Deserialize {
            path: path.to_path_buf(),
            source,
        })
}

/// Load optional JSON state and move malformed state aside instead of failing
/// every subsequent application start.
///
/// Filesystem failures are still returned. A parse failure becomes
/// [`QuarantinedLoad::Quarantined`] after the original bytes are atomically
/// renamed to a timestamped sibling. If another process removes the malformed
/// file between reading and quarantine, the outcome is `Missing`.
pub fn load_json_optional_quarantining<T>(
    path: impl AsRef<Path>,
) -> Result<QuarantinedLoad<T>, PersistenceError>
where
    T: DeserializeOwned,
{
    let path = path.as_ref();
    match load_json_optional(path) {
        Ok(Some(value)) => Ok(QuarantinedLoad::Loaded(value)),
        Ok(None) => Ok(QuarantinedLoad::Missing),
        Err(PersistenceError::Deserialize { source, .. }) => {
            let reason = source.to_string();
            match quarantine_corrupt_file(path)? {
                Some(path) => Ok(QuarantinedLoad::Quarantined { path, reason }),
                None => Ok(QuarantinedLoad::Missing),
            }
        }
        Err(error) => Err(error),
    }
}

/// Move `path` to a uniquely named `.corrupt-*` sibling.
///
/// Returns `None` when the source is already absent. The quarantined bytes are
/// never rewritten, which preserves them for diagnosis or manual recovery.
pub fn quarantine_corrupt_file(
    path: impl AsRef<Path>,
) -> Result<Option<PathBuf>, PersistenceError> {
    let path = path.as_ref();
    let file_name = validate_file_name(path)?;
    let parent = parent_directory(path);

    match fs::symlink_metadata(path) {
        Ok(_) => {}
        Err(source) if source.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(source) => return Err(io_error("inspect persistence file", path, source)),
    }

    for attempt in 0..128_u16 {
        let quarantined_path = parent.join(quarantine_name(file_name, attempt));
        match fs::symlink_metadata(&quarantined_path) {
            Ok(_) => continue,
            Err(source) if source.kind() == io::ErrorKind::NotFound => {}
            Err(source) => {
                return Err(io_error(
                    "inspect corrupt-file quarantine path",
                    &quarantined_path,
                    source,
                ))
            }
        }

        match fs::rename(path, &quarantined_path) {
            Ok(()) => {
                sync_directory(parent)?;
                return Ok(Some(quarantined_path));
            }
            // A concurrent loader may have quarantined or removed it first.
            Err(source) if source.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(source) => {
                return Err(io_error(
                    "quarantine corrupt persistence file at",
                    &quarantined_path,
                    source,
                ))
            }
        }
    }

    Err(io_error(
        "choose an unused corrupt-file quarantine path for",
        path,
        io::Error::new(
            io::ErrorKind::AlreadyExists,
            "exhausted corrupt-file quarantine names",
        ),
    ))
}

fn validate_file_name(path: &Path) -> Result<&OsStr, PersistenceError> {
    path.file_name().ok_or_else(|| {
        io_error(
            "use persistence path",
            path,
            io::Error::new(io::ErrorKind::InvalidInput, "path has no file name"),
        )
    })
}

fn parent_directory(path: &Path) -> &Path {
    match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => Path::new("."),
    }
}

fn unique_stamp() -> (u128, u64) {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let sequence = UNIQUE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    (nanos, sequence)
}

fn temporary_name(file_name: &OsStr, attempt: u16) -> OsString {
    let (nanos, sequence) = unique_stamp();
    let mut name = OsString::from(".");
    name.push(file_name);
    name.push(format!(
        ".{}.{}.{}.{}.tmp",
        process::id(),
        nanos,
        sequence,
        attempt
    ));
    name
}

/// Whether `candidate` matches the exact shape [`temporary_name`] emits for
/// `file_name`: `.<file_name>.<pid>.<nanos>.<sequence>.<attempt>.tmp`, where
/// every stamp field is a non-empty run of ASCII digits.
///
/// The four-numeric-field requirement keeps the match precise even between
/// overlapping target names (a temporary for `state.json.backup` never matches
/// `state.json`, and vice versa). Non-UTF-8 names never match: garbage
/// collection prefers a false negative over touching a foreign file.
fn is_temporary_name_for(file_name: &OsStr, candidate: &OsStr) -> bool {
    let (Some(file_name), Some(candidate)) = (file_name.to_str(), candidate.to_str()) else {
        return false;
    };
    let Some(stamp) = candidate
        .strip_prefix('.')
        .and_then(|rest| rest.strip_prefix(file_name))
        .and_then(|rest| rest.strip_prefix('.'))
        .and_then(|rest| rest.strip_suffix(".tmp"))
    else {
        return false;
    };
    let mut fields = 0_usize;
    for field in stamp.split('.') {
        if field.is_empty() || !field.bytes().all(|byte| byte.is_ascii_digit()) {
            return false;
        }
        fields += 1;
    }
    fields == 4
}

/// Best-effort removal of temporary files beside `target` left by writers that
/// died between the temporary write and the rename.
///
/// Called only after a successful rename. Only regular files whose name
/// matches this target's exact temporary pattern (see
/// [`is_temporary_name_for`]) are considered, and only when their modification
/// time is at least [`STALE_TEMPORARY_AGE`] old — a fresh temporary may belong
/// to a live concurrent writer. Every filesystem error is ignored: a missed
/// collection only leaves litter for a later save, and garbage collection must
/// never fail the save that triggered it.
fn collect_stale_temporaries(target: &Path) {
    let Some(file_name) = target.file_name() else {
        return;
    };
    let Ok(entries) = fs::read_dir(parent_directory(target)) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        if !is_temporary_name_for(file_name, &entry.file_name()) {
            continue;
        }
        // DirEntry::metadata does not follow symlinks, so a symlink dressed up
        // in a temporary name is skipped rather than dereferenced.
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let stale = metadata.is_file()
            && metadata
                .modified()
                .ok()
                .and_then(|modified| now.duration_since(modified).ok())
                .is_some_and(|age| age >= STALE_TEMPORARY_AGE);
        if stale {
            let _ = fs::remove_file(entry.path());
        }
    }
}

fn quarantine_name(file_name: &OsStr, attempt: u16) -> OsString {
    let (nanos, sequence) = unique_stamp();
    let mut name = OsString::from(file_name);
    name.push(format!(
        ".corrupt-{}-{}-{}-{}",
        nanos,
        process::id(),
        sequence,
        attempt
    ));
    name
}

fn create_pending_file(target: &Path) -> Result<PendingFile, PersistenceError> {
    let parent = parent_directory(target);
    let file_name = validate_file_name(target)?;

    for attempt in 0..128_u16 {
        let path = parent.join(temporary_name(file_name, attempt));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok(PendingFile::new(path, file)),
            Err(source) if source.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(source) => {
                return Err(io_error("create temporary persistence file", &path, source))
            }
        }
    }

    Err(io_error(
        "choose an unused temporary persistence path for",
        target,
        io::Error::new(
            io::ErrorKind::AlreadyExists,
            "exhausted temporary persistence file names",
        ),
    ))
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), PersistenceError> {
    let directory =
        File::open(path).map_err(|source| io_error("open persistence directory", path, source))?;
    directory
        .sync_all()
        .map_err(|source| io_error("sync persistence directory", path, source))
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<(), PersistenceError> {
    // std does not expose a portable directory-sync operation. The file itself
    // has still been synced before the rename.
    Ok(())
}

fn io_error(operation: &'static str, path: &Path, source: io::Error) -> PersistenceError {
    PersistenceError::Io {
        operation,
        path: path.to_path_buf(),
        source,
    }
}

/// Owns the temporary handle and removes the temporary path unless persisted.
///
/// The file handle is explicitly dropped before cleanup so failure cleanup
/// works on Windows as well as Unix.
struct PendingFile {
    path: PathBuf,
    file: Option<File>,
    armed: bool,
}

impl PendingFile {
    fn new(path: PathBuf, file: File) -> Self {
        Self {
            path,
            file: Some(file),
            armed: true,
        }
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn file_mut(&mut self) -> &mut File {
        self.file
            .as_mut()
            .expect("pending persistence file was already closed")
    }

    fn close(&mut self) {
        self.file.take();
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for PendingFile {
    fn drop(&mut self) {
        self.file.take();
        if self.armed {
            let _ = fs::remove_file(&self.path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};
    use tempfile::tempdir;

    #[derive(Debug, Deserialize, Eq, PartialEq, Serialize)]
    struct TestState {
        name: String,
        count: u64,
        entries: Vec<String>,
    }

    fn state(name: &str, count: u64, entries: &[&str]) -> TestState {
        TestState {
            name: name.to_string(),
            count,
            entries: entries.iter().map(|entry| (*entry).to_string()).collect(),
        }
    }

    fn temporary_siblings(path: &Path) -> Vec<PathBuf> {
        let expected_prefix = format!(
            ".{}.",
            path.file_name()
                .expect("test path should have a name")
                .to_string_lossy()
        );
        fs::read_dir(parent_directory(path))
            .expect("test directory should be readable")
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|entry| {
                let name = entry
                    .file_name()
                    .expect("directory entry should have a name")
                    .to_string_lossy();
                name.starts_with(&expected_prefix) && name.ends_with(".tmp")
            })
            .collect()
    }

    fn quarantine_siblings(path: &Path) -> Vec<PathBuf> {
        let expected_prefix = format!(
            "{}.corrupt-",
            path.file_name()
                .expect("test path should have a name")
                .to_string_lossy()
        );
        fs::read_dir(parent_directory(path))
            .expect("test directory should be readable")
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|entry| {
                entry
                    .file_name()
                    .expect("directory entry should have a name")
                    .to_string_lossy()
                    .starts_with(&expected_prefix)
            })
            .collect()
    }

    fn expect_quarantined(outcome: QuarantinedLoad<TestState>) -> PathBuf {
        match outcome {
            QuarantinedLoad::Quarantined { path, .. } => path,
            QuarantinedLoad::Missing => panic!("corrupt state was treated as missing"),
            QuarantinedLoad::Loaded(state) => {
                panic!("corrupt state unexpectedly parsed: {state:?}")
            }
        }
    }

    #[test]
    fn pretty_json_round_trip_creates_parent_directories() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("nested/state.json");
        let expected = state("active", 7, &["one", "two"]);

        write_json_atomic(&path, &expected).unwrap();

        let loaded: Option<TestState> = load_json_optional(&path).unwrap();
        assert_eq!(loaded, Some(expected));

        let raw = fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\n  \"name\": \"active\""));
        assert!(raw.ends_with('\n'));
        assert!(temporary_siblings(&path).is_empty());
    }

    #[test]
    fn atomic_write_replaces_existing_contents_without_stale_bytes() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("activity.json");
        let initial = state(
            "a deliberately much longer previous value",
            999_999,
            &["alpha", "beta", "gamma", "delta"],
        );
        let replacement = state("new", 1, &[]);

        write_json_atomic(&path, &initial).unwrap();
        write_json_atomic(&path, &replacement).unwrap();

        let loaded: TestState = load_json_optional(&path).unwrap().unwrap();
        assert_eq!(loaded, replacement);
        let raw = fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("previous"));
        assert!(!raw.contains("gamma"));
        assert!(temporary_siblings(&path).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn ordinary_replacement_preserves_mode_and_secret_replacement_enforces_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempdir().unwrap();
        let document = directory.path().join("script.sh");
        fs::write(&document, b"old").unwrap();
        fs::set_permissions(&document, fs::Permissions::from_mode(0o755)).unwrap();
        write_bytes_atomic(&document, b"new").unwrap();
        assert_eq!(
            fs::metadata(&document).unwrap().permissions().mode() & 0o777,
            0o755
        );

        let secret = directory.path().join("keys.env");
        fs::write(&secret, b"OLD=value\n").unwrap();
        fs::set_permissions(&secret, fs::Permissions::from_mode(0o644)).unwrap();
        write_secret_bytes_atomic(&secret, b"NEW=secret\n").unwrap();
        assert_eq!(fs::read(&secret).unwrap(), b"NEW=secret\n");
        assert_eq!(
            fs::metadata(&secret).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(temporary_siblings(&secret).is_empty());
    }

    #[test]
    fn failed_rename_cleans_up_the_temporary_file() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("destination-is-a-directory.json");
        fs::create_dir(&path).unwrap();

        let result = write_json_atomic(&path, &state("cannot replace directory", 1, &[]));

        assert!(result.is_err());
        assert!(path.is_dir());
        assert!(temporary_siblings(&path).is_empty());
    }

    #[test]
    fn optional_load_returns_none_for_a_missing_file() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("does-not-exist.json");

        let loaded: Option<TestState> = load_json_optional(&path).unwrap();

        assert_eq!(loaded, None);
    }

    #[test]
    fn corrupt_json_is_quarantined_with_original_bytes_preserved() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("routines.json");
        let corrupt_contents = b"{ \"routines\": [ definitely not json";
        fs::write(&path, corrupt_contents).unwrap();

        let outcome: QuarantinedLoad<TestState> = load_json_optional_quarantining(&path).unwrap();

        let (quarantined_path, reason) = match outcome {
            QuarantinedLoad::Quarantined { path, reason } => (path, reason),
            QuarantinedLoad::Missing => panic!("corrupt state was treated as missing"),
            QuarantinedLoad::Loaded(_) => panic!("corrupt state unexpectedly parsed"),
        };
        assert!(!path.exists());
        assert!(quarantined_path.exists());
        assert_eq!(quarantined_path.parent(), path.parent());
        assert!(quarantined_path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("routines.json.corrupt-"));
        assert_eq!(fs::read(quarantined_path).unwrap(), corrupt_contents);
        assert!(!reason.is_empty());
    }

    #[test]
    fn directory_syncs_are_debounced_per_parent_directory() {
        let directory = tempdir().unwrap();
        let parent = directory.path();

        assert!(sync_directory_debounced(parent).unwrap());
        assert!(
            !sync_directory_debounced(parent).unwrap(),
            "a directory synced moments ago should be skipped"
        );

        // A different directory is tracked independently.
        let other = tempdir().unwrap();
        assert!(sync_directory_debounced(other.path()).unwrap());

        // Once the recorded sync ages past the window, the directory syncs again.
        lock_recent_directory_syncs()
            .insert(parent.to_path_buf(), Instant::now() - DIRECTORY_SYNC_WINDOW);
        assert!(sync_directory_debounced(parent).unwrap());
    }

    #[test]
    fn quarantining_a_missing_file_is_a_noop() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("missing.json");

        assert_eq!(quarantine_corrupt_file(&path).unwrap(), None);
    }

    #[test]
    fn truncated_json_is_quarantined_and_a_fresh_save_round_trips() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("state.json");
        write_json_atomic(&path, &state("before-crash", 3, &["a", "b"])).unwrap();
        let full = fs::read(&path).unwrap();
        let truncated = full[..full.len() * 6 / 10].to_vec();
        fs::write(&path, &truncated).unwrap();

        let quarantined_path = expect_quarantined(load_json_optional_quarantining(&path).unwrap());

        assert!(!path.exists());
        assert_eq!(fs::read(&quarantined_path).unwrap(), truncated);

        let replacement = state("after-recovery", 4, &["c"]);
        write_json_atomic(&path, &replacement).unwrap();
        assert_eq!(load_json_optional(&path).unwrap(), Some(replacement));
        assert_eq!(fs::read(&quarantined_path).unwrap(), truncated);
    }

    #[test]
    fn empty_file_is_quarantined_with_the_original_preserved() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("state.json");
        fs::write(&path, b"").unwrap();

        let quarantined_path = expect_quarantined(load_json_optional_quarantining(&path).unwrap());

        assert!(!path.exists());
        assert!(fs::read(&quarantined_path).unwrap().is_empty());

        let replacement = state("fresh", 1, &[]);
        write_json_atomic(&path, &replacement).unwrap();
        assert_eq!(load_json_optional(&path).unwrap(), Some(replacement));
    }

    #[test]
    fn wrong_shape_json_is_quarantined_with_bytes_preserved() {
        let directory = tempdir().unwrap();

        let array = directory.path().join("array.json");
        fs::write(&array, b"[1, 2, 3]").unwrap();
        let quarantined = expect_quarantined(load_json_optional_quarantining(&array).unwrap());
        assert_eq!(fs::read(quarantined).unwrap(), b"[1, 2, 3]");
        assert!(!array.exists());

        let wrong_types = directory.path().join("types.json");
        let contents = b"{ \"name\": 7, \"count\": \"seven\", \"entries\": {} }";
        fs::write(&wrong_types, contents).unwrap();
        let quarantined =
            expect_quarantined(load_json_optional_quarantining(&wrong_types).unwrap());
        assert_eq!(fs::read(quarantined).unwrap(), contents);
        assert!(!wrong_types.exists());
    }

    #[test]
    fn non_utf8_bytes_are_quarantined_byte_for_byte() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("state.json");
        let corrupt = b"\xFF\xFE{\"name\": \"x\"";
        fs::write(&path, corrupt).unwrap();

        let quarantined_path = expect_quarantined(load_json_optional_quarantining(&path).unwrap());

        assert!(!path.exists());
        assert_eq!(fs::read(&quarantined_path).unwrap(), corrupt);
    }

    #[test]
    fn loading_a_directory_at_the_state_path_is_an_error_not_a_quarantine() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("state.json");
        fs::create_dir(&path).unwrap();
        fs::write(path.join("inner.txt"), b"user data").unwrap();

        let result: Result<QuarantinedLoad<TestState>, PersistenceError> =
            load_json_optional_quarantining(&path);

        assert!(matches!(result, Err(PersistenceError::Io { .. })));
        assert!(path.is_dir());
        assert_eq!(fs::read(path.join("inner.txt")).unwrap(), b"user data");
        assert!(quarantine_siblings(&path).is_empty());
    }

    /// Push a file's mtime far enough into the past that the stale-temporary
    /// collector must treat it as litter from a crashed writer.
    fn age_beyond_stale_threshold(path: &Path) {
        File::options()
            .write(true)
            .open(path)
            .expect("aged test file should open for writing")
            .set_modified(SystemTime::now() - STALE_TEMPORARY_AGE - Duration::from_secs(60))
            .expect("test file mtime should be settable");
    }

    #[test]
    fn stale_temporary_files_from_a_crashed_writer_block_nothing_and_are_collected() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("state.json");
        let original = state("survivor", 1, &["kept"]);
        write_json_atomic(&path, &original).unwrap();

        // A writer that crashed after writing its temporary but before the
        // rename leaves exactly this behind; hours later it cannot belong to
        // any live writer.
        let stale = directory.path().join(".state.json.4242.1.2.0.tmp");
        fs::write(&stale, b"{ \"name\": \"half-writ").unwrap();
        age_beyond_stale_threshold(&stale);

        assert_eq!(load_json_optional(&path).unwrap(), Some(original));

        let replacement = state("replacement", 2, &[]);
        write_json_atomic(&path, &replacement).unwrap();
        assert_eq!(load_json_optional(&path).unwrap(), Some(replacement));

        // The successful save collects the crashed writer's litter.
        assert!(!stale.exists());
        assert!(temporary_siblings(&path).is_empty());
    }

    #[test]
    fn stale_temporary_collection_spares_fresh_and_foreign_files() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("state.json");

        // Fresh temporary: a concurrent writer may still be mid-flight, so it
        // is left alone no matter that it matches the pattern.
        let fresh = directory.path().join(".state.json.4243.9.9.0.tmp");
        fs::write(&fresh, b"{").unwrap();

        // Old files that do not match this target's exact temporary pattern
        // are never touched, regardless of age.
        let foreign = [
            directory.path().join(".other.json.4242.1.2.0.tmp"),
            directory.path().join(".state.json.backup.4242.1.2.0.tmp"),
            directory.path().join(".state.json.4242.1.2.tmp"),
            directory.path().join(".state.json.4242.1.2.0.extra.tmp"),
            directory.path().join("state.json.4242.1.2.0.tmp"),
        ];
        for file in &foreign {
            fs::write(file, b"not ours to delete").unwrap();
            age_beyond_stale_threshold(file);
        }

        write_json_atomic(&path, &state("writer", 1, &[])).unwrap();

        assert!(fresh.exists(), "a fresh temporary may have a live owner");
        for file in &foreign {
            assert!(file.exists(), "non-matching name was deleted: {file:?}");
        }
    }

    #[test]
    fn temporary_name_matching_is_exact() {
        let name = OsStr::new("state.json");
        assert!(is_temporary_name_for(
            name,
            OsStr::new(".state.json.4242.1.2.0.tmp")
        ));
        assert!(is_temporary_name_for(name, &temporary_name(name, 3)));

        for miss in [
            "state.json",
            ".state.json.tmp",
            ".state.json.4242.1.2.tmp",
            ".state.json.4242.1.2.0.5.tmp",
            ".state.json.4242.1.2.x.tmp",
            ".state.json..1.2.0.tmp",
            ".state.json.4242.1.2.0.tmp.bak",
            "state.json.4242.1.2.0.tmp",
            ".other.json.4242.1.2.0.tmp",
            ".state.json.backup.4242.1.2.0.tmp",
        ] {
            assert!(!is_temporary_name_for(name, OsStr::new(miss)), "{miss}");
        }
    }

    #[test]
    fn repeated_corruption_quarantines_every_generation_without_overwriting() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("state.json");

        fs::write(&path, b"first corruption").unwrap();
        let first = expect_quarantined(load_json_optional_quarantining(&path).unwrap());
        fs::write(&path, b"second corruption").unwrap();
        let second = expect_quarantined(load_json_optional_quarantining(&path).unwrap());

        assert_ne!(first, second);
        assert_eq!(fs::read(&first).unwrap(), b"first corruption");
        assert_eq!(fs::read(&second).unwrap(), b"second corruption");
    }
}
