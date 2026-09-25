//! Checked writes for document tools. The ordinary Editor writer shares this
//! gate, so two local writes cannot pass the same content check.
use serde::Serialize;
use std::{fs, path::Path, sync::Mutex};

static WRITES: Mutex<()> = Mutex::new(());

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentFile {
    path: String,
    content: String,
    open_paths: Vec<String>,
}

#[tauri::command]
pub fn document_file_read(path: String, open_paths: Vec<String>) -> Result<DocumentFile, String> {
    let canonical =
        fs::canonicalize(&path).map_err(|err| format!("Could not read {path}: {err}"))?;
    let content =
        fs::read_to_string(&canonical).map_err(|err| format!("Could not read {path}: {err}"))?;
    let open_paths = open_paths
        .into_iter()
        .filter(|candidate| fs::canonicalize(candidate).is_ok_and(|resolved| resolved == canonical))
        .collect();
    Ok(DocumentFile {
        path: canonical.to_string_lossy().into_owned(),
        content,
        open_paths,
    })
}

#[tauri::command]
pub fn document_file_write(
    path: String,
    content: String,
    expected_content: String,
) -> Result<(), String> {
    let _guard = WRITES.lock().map_err(|err| err.to_string())?;
    let canonical =
        fs::canonicalize(&path).map_err(|err| format!("Could not read {path}: {err}"))?;
    // A replaced file link must not redirect a request after its snapshot.
    if canonical != Path::new(&path) {
        return Err("Document path changed. Read the document again.".into());
    }
    let current =
        fs::read_to_string(&canonical).map_err(|err| format!("Could not read {path}: {err}"))?;
    if current != expected_content {
        return Err("Document conflict: saved text changed. Read the document again.".into());
    }
    write(&canonical, &content)
}

pub fn write_text(path: &Path, content: &str) -> Result<(), String> {
    let _guard = WRITES.lock().map_err(|err| err.to_string())?;
    write(path, content)
}

fn write(path: &Path, content: &str) -> Result<(), String> {
    crate::persistence::write_bytes_atomic(path, content.as_bytes())
        .map_err(|err| format!("Could not write {}: {err}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checked_write_preserves_newer_text_and_line_endings() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("note.md");
        write_text(&file, "First\r\nSecond\r\n").unwrap();
        let snapshot = document_file_read(file.to_string_lossy().into(), vec![]).unwrap();
        document_file_write(
            snapshot.path.clone(),
            "Changed\r\n".into(),
            snapshot.content.clone(),
        )
        .unwrap();
        assert!(
            document_file_write(snapshot.path, "Stale".into(), snapshot.content)
                .unwrap_err()
                .contains("conflict")
        );
        assert_eq!(fs::read_to_string(file).unwrap(), "Changed\r\n");
    }

    #[test]
    fn concurrent_changes_cannot_both_replace_the_same_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("note.md");
        write_text(&file, "Original").unwrap();
        let snapshot = document_file_read(file.to_string_lossy().into(), vec![]).unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let workers: Vec<_> = ["First", "Second"]
            .into_iter()
            .map(|content| {
                let barrier = barrier.clone();
                let path = snapshot.path.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    document_file_write(path, content.into(), "Original".into())
                })
            })
            .collect();
        assert_eq!(
            workers
                .into_iter()
                .filter_map(|worker| worker.join().unwrap().ok())
                .count(),
            1
        );
    }

    #[cfg(unix)]
    #[test]
    fn resolves_open_aliases_and_preserves_links() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("note.md");
        let alias = dir.path().join("alias.md");
        write_text(&file, "Original").unwrap();
        std::os::unix::fs::symlink(&file, &alias).unwrap();
        let alias = alias.to_string_lossy().into_owned();
        let snapshot = document_file_read(alias.clone(), vec![alias.clone()]).unwrap();
        assert_eq!(snapshot.open_paths, vec![alias.clone()]);
        document_file_write(snapshot.path, "Comment".into(), snapshot.content).unwrap();
        assert!(fs::symlink_metadata(&alias)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read_to_string(alias).unwrap(), "Comment");
    }
}
