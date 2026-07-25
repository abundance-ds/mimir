//! Crash-safe persistence for workbench and editor settings.

use serde::Serialize;
use serde_json::{Map, Value};
use std::{
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
};

use crate::{
    ai_models::app_config_dir,
    persistence::{load_json_optional_quarantining, write_json_atomic, QuarantinedLoad},
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsLoadResponse {
    settings: Value,
    diagnostic: Option<String>,
    quarantined_path: Option<String>,
}

static SETTINGS_IO: Mutex<()> = Mutex::new(());

fn lock_settings_io() -> MutexGuard<'static, ()> {
    SETTINGS_IO
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn settings_path() -> Result<PathBuf, String> {
    Ok(app_config_dir()?.join("settings.json"))
}

fn load_settings_at(path: &Path) -> Result<SettingsLoadResponse, String> {
    match load_json_optional_quarantining::<Map<String, Value>>(path)
        .map_err(|error| error.to_string())?
    {
        QuarantinedLoad::Missing => Ok(SettingsLoadResponse {
            settings: Value::Object(Map::new()),
            diagnostic: None,
            quarantined_path: None,
        }),
        QuarantinedLoad::Loaded(settings) => Ok(SettingsLoadResponse {
            settings: Value::Object(settings),
            diagnostic: None,
            quarantined_path: None,
        }),
        QuarantinedLoad::Quarantined {
            path: quarantined,
            reason,
        } => Ok(SettingsLoadResponse {
            settings: Value::Object(Map::new()),
            diagnostic: Some(format!(
                "Invalid settings were moved to {}: {reason}",
                quarantined.display()
            )),
            quarantined_path: Some(quarantined.to_string_lossy().into_owned()),
        }),
    }
}

fn save_settings_at(path: &Path, settings: &Value) -> Result<(), String> {
    if !settings.is_object() {
        return Err("Settings must be a JSON object.".into());
    }
    write_json_atomic(path, settings).map_err(|error| error.to_string())
}

fn save_editor_settings_at(path: &Path, editor: &Value) -> Result<(), String> {
    if !editor.is_object() {
        return Err("Editor settings must be a JSON object.".into());
    }
    let loaded = load_settings_at(path)?;
    let mut settings = loaded.settings.as_object().cloned().unwrap_or_default();
    settings.insert("editor".into(), editor.clone());
    save_settings_at(path, &Value::Object(settings))
}

#[tauri::command]
pub fn settings_load() -> Result<SettingsLoadResponse, String> {
    let _guard = lock_settings_io();
    load_settings_at(&settings_path()?)
}

#[tauri::command]
pub fn settings_save(settings: Value) -> Result<(), String> {
    let _guard = lock_settings_io();
    save_settings_at(&settings_path()?, &settings)
}

#[tauri::command]
pub fn settings_save_editor(editor: Value) -> Result<(), String> {
    let _guard = lock_settings_io();
    save_editor_settings_at(&settings_path()?, &editor)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn missing_settings_are_an_empty_object_and_saves_round_trip() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("settings.json");
        assert_eq!(
            load_settings_at(&path).unwrap().settings,
            serde_json::json!({})
        );

        let settings = serde_json::json!({
            "editor": { "editorTheme": "parchment" },
            "apps": { "scratch": { "expanded": true } }
        });
        save_settings_at(&path, &settings).unwrap();
        assert_eq!(load_settings_at(&path).unwrap().settings, settings);
    }

    #[test]
    fn corrupt_settings_are_preserved_before_the_next_atomic_save() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let corrupt = b"{\"editor\":";
        std::fs::write(&path, corrupt).unwrap();

        let loaded = load_settings_at(&path).unwrap();
        assert_eq!(loaded.settings, serde_json::json!({}));
        assert!(loaded.diagnostic.as_deref().unwrap().contains("moved"));
        let quarantined = PathBuf::from(loaded.quarantined_path.unwrap());
        assert_eq!(std::fs::read(&quarantined).unwrap(), corrupt);
        assert!(!path.exists());

        save_settings_at(&path, &serde_json::json!({ "editor": {} })).unwrap();
        assert_eq!(std::fs::read(&quarantined).unwrap(), corrupt);
    }

    #[test]
    fn settings_save_rejects_non_object_state() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("settings.json");
        assert!(save_settings_at(&path, &serde_json::json!("bad"))
            .unwrap_err()
            .contains("JSON object"));
        assert!(!path.exists());
    }

    #[test]
    fn editor_section_updates_preserve_other_settings_and_reject_invalid_values() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("settings.json");
        save_settings_at(
            &path,
            &serde_json::json!({
                "editor": { "editorTheme": "old" },
                "apps": { "scratch": { "expanded": true } }
            }),
        )
        .unwrap();

        save_editor_settings_at(
            &path,
            &serde_json::json!({ "editorTheme": "parchment", "editorFontSize": 16 }),
        )
        .unwrap();
        assert_eq!(
            load_settings_at(&path).unwrap().settings,
            serde_json::json!({
                "editor": { "editorTheme": "parchment", "editorFontSize": 16 },
                "apps": { "scratch": { "expanded": true } }
            })
        );
        assert!(
            save_editor_settings_at(&path, &serde_json::json!("invalid"))
                .unwrap_err()
                .contains("JSON object")
        );
    }
}
