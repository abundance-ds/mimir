//! Small, shared persistence primitives for durable local application state.
//!
//! State is serialized before the destination is touched, written to a unique
//! temporary file in the destination directory, flushed to disk, and then
//! atomically renamed into place. Keeping the temporary file beside the target
//! is important: a rename is only guaranteed to be atomic within one
//! filesystem.

use serde::{de::DeserializeOwned, Serialize};
use std::{
    ffi::{OsStr, OsString},
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    process,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
use thiserror::Error;

static UNIQUE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

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

    sync_directory(parent)?;
    Ok(())
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
    fn quarantining_a_missing_file_is_a_noop() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("missing.json");

        assert_eq!(quarantine_corrupt_file(&path).unwrap(), None);
    }
}
