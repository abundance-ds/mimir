//! Crash-safe persistence for the editor session.
//!
//! Session state contains recoverable unsaved buffers, so it must not use the
//! generic document writer. Malformed state is quarantined byte-for-byte before
//! a later save can create a clean replacement.

use serde::Serialize;
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

use crate::{
    ai_models::app_config_dir,
    persistence::{load_json_optional_quarantining, write_json_atomic, QuarantinedLoad},
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionLoadResponse {
    session: Option<Value>,
    diagnostic: Option<String>,
    quarantined_path: Option<String>,
}

fn session_path() -> Result<PathBuf, String> {
    Ok(app_config_dir()?.join("session.json"))
}

fn load_session_at(path: &Path) -> Result<SessionLoadResponse, String> {
    match load_json_optional_quarantining::<Map<String, Value>>(path)
        .map_err(|error| error.to_string())?
    {
        QuarantinedLoad::Missing => Ok(SessionLoadResponse {
            session: None,
            diagnostic: None,
            quarantined_path: None,
        }),
        QuarantinedLoad::Loaded(session) => Ok(SessionLoadResponse {
            session: Some(Value::Object(session)),
            diagnostic: None,
            quarantined_path: None,
        }),
        QuarantinedLoad::Quarantined {
            path: quarantined,
            reason,
        } => Ok(SessionLoadResponse {
            session: None,
            diagnostic: Some(format!(
                "Invalid editor session was moved to {}: {reason}",
                quarantined.display()
            )),
            quarantined_path: Some(quarantined.to_string_lossy().into_owned()),
        }),
    }
}

fn save_session_at(path: &Path, session: &Value) -> Result<(), String> {
    if !session.is_object() {
        return Err("Editor session must be a JSON object.".into());
    }
    write_json_atomic(path, session).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn session_load() -> Result<SessionLoadResponse, String> {
    load_session_at(&session_path()?)
}

#[tauri::command]
pub fn session_save(session: Value) -> Result<(), String> {
    save_session_at(&session_path()?, &session)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn missing_and_valid_sessions_round_trip_atomically() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("nested").join("session.json");

        let missing = load_session_at(&path).unwrap();
        assert!(missing.session.is_none());
        assert!(missing.diagnostic.is_none());

        let expected = serde_json::json!({
            "openFiles": [
                { "path": "/work/notes.md", "content": "unsaved", "dirty": true }
            ],
            "activeFileIndex": 0,
            "zoomLevel": 1.1
        });
        save_session_at(&path, &expected).unwrap();

        let loaded = load_session_at(&path).unwrap();
        assert_eq!(loaded.session, Some(expected));
        assert!(loaded.diagnostic.is_none());
        assert!(std::fs::read_to_string(path).unwrap().ends_with('\n'));
    }

    #[test]
    fn malformed_session_is_quarantined_before_a_clean_replacement() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("session.json");
        let corrupt = b"{\"openFiles\":[";
        std::fs::write(&path, corrupt).unwrap();

        let loaded = load_session_at(&path).unwrap();
        assert!(loaded.session.is_none());
        assert!(loaded.diagnostic.as_deref().unwrap().contains("moved"));
        let quarantined = PathBuf::from(loaded.quarantined_path.unwrap());
        assert!(!path.exists());
        assert_eq!(std::fs::read(&quarantined).unwrap(), corrupt);

        let replacement = serde_json::json!({ "openFiles": [] });
        save_session_at(&path, &replacement).unwrap();
        assert_eq!(load_session_at(&path).unwrap().session, Some(replacement));
        assert_eq!(std::fs::read(&quarantined).unwrap(), corrupt);
    }

    #[test]
    fn valid_json_with_the_wrong_top_level_shape_is_quarantined() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("session.json");
        std::fs::write(&path, b"[]").unwrap();

        let loaded = load_session_at(&path).unwrap();
        assert!(loaded.session.is_none());
        assert!(loaded.quarantined_path.is_some());
        assert!(!path.exists());
    }

    #[test]
    fn save_rejects_non_object_state_without_touching_disk() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("session.json");

        assert!(save_session_at(&path, &serde_json::json!([]))
            .unwrap_err()
            .contains("JSON object"));
        assert!(!path.exists());
    }

    #[test]
    fn truncated_session_is_quarantined_and_recovery_round_trips() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("session.json");
        let original = serde_json::json!({
            "openFiles": [
                { "path": "/work/notes.md", "content": "unsaved work", "dirty": true }
            ],
            "activeFileIndex": 0
        });
        save_session_at(&path, &original).unwrap();
        let full = std::fs::read(&path).unwrap();
        let truncated = full[..full.len() * 6 / 10].to_vec();
        std::fs::write(&path, &truncated).unwrap();

        let loaded = load_session_at(&path).unwrap();
        assert!(loaded.session.is_none());
        assert!(loaded.diagnostic.as_deref().unwrap().contains("moved"));
        let quarantined = PathBuf::from(loaded.quarantined_path.unwrap());
        assert!(!path.exists());
        assert_eq!(std::fs::read(&quarantined).unwrap(), truncated);

        let replacement = serde_json::json!({ "openFiles": [] });
        save_session_at(&path, &replacement).unwrap();
        assert_eq!(load_session_at(&path).unwrap().session, Some(replacement));
        assert_eq!(std::fs::read(&quarantined).unwrap(), truncated);
    }

    #[test]
    fn empty_session_file_is_quarantined_with_bytes_preserved() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("session.json");
        std::fs::write(&path, b"").unwrap();

        let loaded = load_session_at(&path).unwrap();
        assert!(loaded.session.is_none());
        assert!(loaded.diagnostic.is_some());
        let quarantined = PathBuf::from(loaded.quarantined_path.unwrap());
        assert!(!path.exists());
        assert!(std::fs::read(&quarantined).unwrap().is_empty());

        let replacement = serde_json::json!({ "openFiles": [] });
        save_session_at(&path, &replacement).unwrap();
        assert_eq!(load_session_at(&path).unwrap().session, Some(replacement));
    }

    #[test]
    fn non_utf8_session_bytes_are_quarantined_byte_for_byte() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("session.json");
        let corrupt = b"\xC3\x28{\"openFiles\"";
        std::fs::write(&path, corrupt).unwrap();

        let loaded = load_session_at(&path).unwrap();
        assert!(loaded.session.is_none());
        let quarantined = PathBuf::from(loaded.quarantined_path.unwrap());
        assert!(!path.exists());
        assert_eq!(std::fs::read(quarantined).unwrap(), corrupt);
    }

    #[test]
    fn session_path_occupied_by_a_directory_errors_without_destroying_it() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("session.json");
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("user-file.txt"), b"precious").unwrap();

        assert!(load_session_at(&path).is_err());
        assert!(save_session_at(&path, &serde_json::json!({})).is_err());
        assert!(path.is_dir());
        assert_eq!(
            std::fs::read(path.join("user-file.txt")).unwrap(),
            b"precious"
        );
    }

    #[test]
    fn unexpected_field_types_inside_the_session_object_load_verbatim() {
        // NOTE: the native layer validates only the top-level shape; the
        // renderer owns the inner session schema and must tolerate drift.
        let directory = tempdir().unwrap();
        let path = directory.path().join("session.json");
        let session = serde_json::json!({
            "openFiles": "not-an-array",
            "activeFileIndex": { "nested": true },
            "zoomLevel": null
        });
        save_session_at(&path, &session).unwrap();

        let loaded = load_session_at(&path).unwrap();
        assert_eq!(loaded.session, Some(session));
        assert!(loaded.diagnostic.is_none());
    }

    #[test]
    fn stale_temporary_files_beside_the_session_block_nothing() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("session.json");
        let original = serde_json::json!({ "openFiles": [] });
        save_session_at(&path, &original).unwrap();
        let stale = directory.path().join(".session.json.4242.1.2.0.tmp");
        std::fs::write(&stale, b"{\"openFiles\":[").unwrap();

        assert_eq!(load_session_at(&path).unwrap().session, Some(original));

        let replacement = serde_json::json!({ "openFiles": [], "zoomLevel": 1.5 });
        save_session_at(&path, &replacement).unwrap();
        assert_eq!(load_session_at(&path).unwrap().session, Some(replacement));
        assert!(stale.exists());
    }
}
