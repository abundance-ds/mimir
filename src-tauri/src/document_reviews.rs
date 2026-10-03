//! Durable review discussions and decisions, independent of the visible tab.
//! Each document has a small checked record. Finished records remain readable;
//! the next review replaces the record after its threads reach the document.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};

static WRITES: Mutex<()> = Mutex::new(());

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRecord {
    key: String,
    revision: u64,
    session: serde_json::Value,
}

fn record_path(root: &Path, key: &str) -> Result<PathBuf, String> {
    if key.is_empty() || key.len() > 8192 {
        return Err("Invalid review document.".into());
    }
    let digest = Sha256::digest(key.as_bytes());
    Ok(root.join(format!("{digest:x}.json")))
}

fn read_at(root: &Path, key: &str) -> Result<Option<ReviewRecord>, String> {
    let path = record_path(root, key)?;
    let value: Option<ReviewRecord> = crate::persistence::load_json_optional(&path)
        .map_err(|error| format!("Could not read saved review: {error}"))?;
    if value.as_ref().is_some_and(|record| record.key != key) {
        return Err("Saved review belongs to another document.".into());
    }
    Ok(value)
}

fn save_at(
    root: &Path,
    key: String,
    session: serde_json::Value,
    expected_revision: u64,
) -> Result<u64, String> {
    let _guard = WRITES.lock().map_err(|error| error.to_string())?;
    let current = read_at(root, &key)?;
    let revision = current.as_ref().map_or(0, |record| record.revision);
    if revision != expected_revision {
        return Err("The review changed in another window. Reopen it before continuing.".into());
    }
    if current.as_ref().is_some_and(|record| {
        record
            .session
            .get("completed")
            .and_then(|value| value.as_bool())
            != Some(true)
            && record.session.get("id") != session.get("id")
    }) {
        return Err(
            "This document has a saved review. Open it before starting another review.".into(),
        );
    }
    if session.get("version").and_then(|value| value.as_u64()) != Some(1)
        || session.get("id").and_then(|value| value.as_str()).is_none()
    {
        return Err("Invalid review state.".into());
    }
    let record = ReviewRecord {
        key: key.clone(),
        revision: revision + 1,
        session,
    };
    crate::persistence::write_json_atomic(record_path(root, &key)?, &record)
        .map_err(|error| format!("Could not save review: {error}"))?;
    Ok(record.revision)
}

pub fn has_pending_review(key: &str) -> Result<bool, String> {
    Ok(
        document_review_read(key.to_string())?.is_some_and(|record| {
            record
                .session
                .get("completed")
                .and_then(|value| value.as_bool())
                != Some(true)
        }),
    )
}

#[tauri::command]
pub fn document_review_read(key: String) -> Result<Option<ReviewRecord>, String> {
    read_at(
        &crate::ai_models::app_config_dir()?.join("document-reviews"),
        &key,
    )
}

#[tauri::command]
pub fn document_review_save(
    key: String,
    session: serde_json::Value,
    expected_revision: u64,
) -> Result<u64, String> {
    save_at(
        &crate::ai_models::app_config_dir()?.join("document-reviews"),
        key,
        session,
        expected_revision,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(completed: bool) -> serde_json::Value {
        serde_json::json!({"version":1,"id":"review-1","completed":completed,"comments":[{"text":"Keep this discussion"}]})
    }

    #[test]
    fn finished_discussions_survive_reload_and_stale_writes_fail() {
        let dir = tempfile::tempdir().unwrap();
        let key = "/project/note.md".to_string();
        let revision = save_at(dir.path(), key.clone(), session(false), 0).unwrap();
        let next = save_at(dir.path(), key.clone(), session(true), revision).unwrap();
        let loaded = read_at(dir.path(), &key).unwrap().unwrap();
        assert_eq!(loaded.revision, next);
        assert_eq!(
            loaded.session["comments"][0]["text"],
            "Keep this discussion"
        );
        assert_eq!(loaded.session["completed"], true);
        assert!(save_at(dir.path(), key, session(false), revision).is_err());
    }

    #[test]
    fn documents_and_drafts_never_share_a_record() {
        let dir = tempfile::tempdir().unwrap();
        save_at(dir.path(), "/X/note.md".into(), session(false), 0).unwrap();
        assert!(read_at(dir.path(), "/Y/note.md").unwrap().is_none());
        assert!(read_at(dir.path(), "draft:1").unwrap().is_none());
        assert_eq!(
            record_path(dir.path(), "../../outside").unwrap().parent(),
            Some(dir.path())
        );
    }

    #[test]
    fn a_new_review_cannot_replace_an_unfinished_review() {
        let dir = tempfile::tempdir().unwrap();
        let key = "/project/note.md".to_string();
        let revision = save_at(dir.path(), key.clone(), session(false), 0).unwrap();
        let mut next = session(false);
        next["id"] = "review-2".into();
        assert!(save_at(dir.path(), key.clone(), next, revision)
            .unwrap_err()
            .contains("saved review"));
        assert_eq!(
            read_at(dir.path(), &key).unwrap().unwrap().session["id"],
            "review-1"
        );
    }
}
