//! Crash-safe persistence for workbench and editor settings.

use serde::{Deserialize, Serialize};
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
    // When the load just quarantined a corrupt settings file, the fresh file
    // would otherwise contain only the editor section; salvage whatever other
    // sections the quarantined copy still legibly holds.
    if let Some(quarantined) = &loaded.quarantined_path {
        for (section, value) in salvaged_sections(Path::new(quarantined)) {
            settings.entry(section).or_insert(value);
        }
    }
    settings.insert("editor".into(), editor.clone());
    save_settings_at(path, &Value::Object(settings))
}

/// Best-effort recovery of settings sections from a just-quarantined file.
///
/// A quarantined file failed the strict parse, but some corruption modes —
/// e.g. trailing garbage after a complete object, left by a non-atomic
/// overwrite — still carry a readable JSON object at the front. Lenient
/// parsing reads that first value and ignores trailing bytes. Anything that
/// does not yield an object (truncated, binary, wrong top-level shape)
/// salvages nothing, as do read failures: the quarantined copy itself is
/// never modified and remains available for manual recovery.
fn salvaged_sections(quarantined: &Path) -> Map<String, Value> {
    let Ok(bytes) = std::fs::read(quarantined) else {
        return Map::new();
    };
    let mut deserializer = serde_json::Deserializer::from_slice(&bytes);
    match Value::deserialize(&mut deserializer) {
        Ok(Value::Object(sections)) => sections,
        _ => Map::new(),
    }
}

/// Saved interface zoom (`editor.workbenchZoom`, percent) as a webview zoom factor.
/// Read once at main-window creation so startup paints at the saved zoom;
/// afterwards the renderer settings store owns every zoom change.
pub fn initial_workbench_zoom_factor() -> f64 {
    let _guard = lock_settings_io();
    settings_path()
        .and_then(|path| load_settings_at(&path))
        .map(|loaded| workbench_zoom_factor_from(&loaded.settings))
        .unwrap_or(1.0)
}

fn workbench_zoom_factor_from(settings: &Value) -> f64 {
    let percent = settings
        .get("editor")
        .and_then(|editor| editor.get("workbenchZoom"))
        .and_then(Value::as_f64)
        .unwrap_or(100.0);
    percent.clamp(50.0, 200.0) / 100.0
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
            "apps": { "ledger": { "expanded": true } }
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
    fn workbench_zoom_factor_clamps_defaults_and_rejects_non_numbers() {
        let zoom = |value: serde_json::Value| workbench_zoom_factor_from(&value);
        assert_eq!(zoom(serde_json::json!({})), 1.0);
        assert_eq!(zoom(serde_json::json!({ "editor": {} })), 1.0);
        assert_eq!(
            zoom(serde_json::json!({ "editor": { "workbenchZoom": 125 } })),
            1.25
        );
        assert_eq!(
            zoom(serde_json::json!({ "editor": { "workbenchZoom": 10 } })),
            0.5
        );
        assert_eq!(
            zoom(serde_json::json!({ "editor": { "workbenchZoom": 9000 } })),
            2.0
        );
        assert_eq!(
            zoom(serde_json::json!({ "editor": { "workbenchZoom": "huge" } })),
            1.0
        );
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
                "apps": { "ledger": { "expanded": true } }
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
                "apps": { "ledger": { "expanded": true } }
            })
        );
        assert!(
            save_editor_settings_at(&path, &serde_json::json!("invalid"))
                .unwrap_err()
                .contains("JSON object")
        );
    }

    #[test]
    fn truncated_settings_are_quarantined_and_a_clean_save_round_trips() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let original = serde_json::json!({
            "editor": { "editorTheme": "parchment", "workbenchZoom": 125 },
            "apps": { "ledger": { "expanded": true } }
        });
        save_settings_at(&path, &original).unwrap();
        let full = std::fs::read(&path).unwrap();
        let truncated = full[..full.len() * 6 / 10].to_vec();
        std::fs::write(&path, &truncated).unwrap();

        let loaded = load_settings_at(&path).unwrap();
        assert_eq!(loaded.settings, serde_json::json!({}));
        assert!(loaded.diagnostic.as_deref().unwrap().contains("moved"));
        let quarantined = PathBuf::from(loaded.quarantined_path.unwrap());
        assert!(!path.exists());
        assert_eq!(std::fs::read(&quarantined).unwrap(), truncated);

        let replacement = serde_json::json!({ "editor": { "editorTheme": "slate" } });
        save_settings_at(&path, &replacement).unwrap();
        assert_eq!(load_settings_at(&path).unwrap().settings, replacement);
        assert_eq!(std::fs::read(&quarantined).unwrap(), truncated);
    }

    #[test]
    fn empty_settings_file_is_quarantined_and_defaults_apply() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("settings.json");
        std::fs::write(&path, b"").unwrap();

        let loaded = load_settings_at(&path).unwrap();
        assert_eq!(loaded.settings, serde_json::json!({}));
        assert_eq!(workbench_zoom_factor_from(&loaded.settings), 1.0);
        let quarantined = PathBuf::from(loaded.quarantined_path.unwrap());
        assert!(!path.exists());
        assert!(std::fs::read(&quarantined).unwrap().is_empty());
    }

    #[test]
    fn top_level_array_settings_are_quarantined_with_bytes_preserved() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("settings.json");
        std::fs::write(&path, b"[\"dark\"]").unwrap();

        let loaded = load_settings_at(&path).unwrap();
        assert_eq!(loaded.settings, serde_json::json!({}));
        let quarantined = PathBuf::from(loaded.quarantined_path.unwrap());
        assert!(!path.exists());
        assert_eq!(std::fs::read(quarantined).unwrap(), b"[\"dark\"]");
    }

    #[test]
    fn non_utf8_settings_bytes_are_quarantined_byte_for_byte() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let corrupt = b"\xFF\xFE{\"editor\"";
        std::fs::write(&path, corrupt).unwrap();

        let loaded = load_settings_at(&path).unwrap();
        assert_eq!(loaded.settings, serde_json::json!({}));
        let quarantined = PathBuf::from(loaded.quarantined_path.unwrap());
        assert!(!path.exists());
        assert_eq!(std::fs::read(quarantined).unwrap(), corrupt);
    }

    #[test]
    fn settings_path_occupied_by_a_directory_errors_without_destroying_it() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("settings.json");
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("user-file.txt"), b"precious").unwrap();

        assert!(load_settings_at(&path).is_err());
        assert!(save_settings_at(&path, &serde_json::json!({})).is_err());
        assert!(save_editor_settings_at(&path, &serde_json::json!({})).is_err());
        assert!(path.is_dir());
        assert_eq!(
            std::fs::read(path.join("user-file.txt")).unwrap(),
            b"precious"
        );
    }

    fn quarantine_copies(directory: &Path) -> Vec<PathBuf> {
        std::fs::read_dir(directory)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|entry| {
                entry
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("settings.json.corrupt-")
            })
            .collect()
    }

    #[test]
    fn editor_save_over_corrupt_settings_salvages_legible_sections_after_quarantine() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("settings.json");
        // A complete object with trailing garbage (e.g. a shorter non-atomic
        // overwrite over a longer file) fails the strict parse and is
        // quarantined, but its sections are still legible.
        let corrupt =
            b"{\"apps\": {\"ledger\": {\"expanded\": true}}, \"editor\": {\"editorTheme\": \"old\"}}}}}";
        std::fs::write(&path, corrupt).unwrap();

        save_editor_settings_at(&path, &serde_json::json!({ "editorTheme": "parchment" })).unwrap();

        // Non-editor sections are salvaged from the quarantined copy into the
        // fresh file; the newly saved editor section wins over the old one.
        assert_eq!(
            load_settings_at(&path).unwrap().settings,
            serde_json::json!({
                "apps": { "ledger": { "expanded": true } },
                "editor": { "editorTheme": "parchment" }
            })
        );
        let quarantined = quarantine_copies(directory.path());
        assert_eq!(quarantined.len(), 1);
        assert_eq!(std::fs::read(&quarantined[0]).unwrap(), corrupt);
    }

    #[test]
    fn editor_save_over_unsalvageable_settings_writes_only_the_editor_section() {
        // Truncated mid-token: no complete JSON value can be read back.
        let directory = tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let corrupt = b"{\"apps\": {\"ledger\": {\"expanded\": tru";
        std::fs::write(&path, corrupt).unwrap();

        save_editor_settings_at(&path, &serde_json::json!({ "editorTheme": "parchment" })).unwrap();

        assert_eq!(
            load_settings_at(&path).unwrap().settings,
            serde_json::json!({ "editor": { "editorTheme": "parchment" } })
        );
        let quarantined = quarantine_copies(directory.path());
        assert_eq!(quarantined.len(), 1);
        assert_eq!(std::fs::read(&quarantined[0]).unwrap(), corrupt);

        // A legible value of the wrong top-level shape salvages nothing either.
        let array_dir = tempdir().unwrap();
        let array_path = array_dir.path().join("settings.json");
        std::fs::write(&array_path, b"[\"dark\"]").unwrap();

        save_editor_settings_at(&array_path, &serde_json::json!({ "editorTheme": "slate" }))
            .unwrap();

        assert_eq!(
            load_settings_at(&array_path).unwrap().settings,
            serde_json::json!({ "editor": { "editorTheme": "slate" } })
        );
        let quarantined = quarantine_copies(array_dir.path());
        assert_eq!(quarantined.len(), 1);
        assert_eq!(std::fs::read(&quarantined[0]).unwrap(), b"[\"dark\"]");
    }

    #[test]
    fn stale_temporary_files_beside_settings_block_nothing_and_old_ones_are_collected() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let original = serde_json::json!({ "editor": { "editorTheme": "parchment" } });
        save_settings_at(&path, &original).unwrap();

        // Hours old: litter from a crashed writer, collected on the next save.
        let stale = directory.path().join(".settings.json.4242.1.2.0.tmp");
        std::fs::write(&stale, b"{\"editor\":").unwrap();
        std::fs::File::options()
            .write(true)
            .open(&stale)
            .unwrap()
            .set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(3 * 3600))
            .unwrap();

        // Fresh: could belong to a live concurrent writer, left alone.
        let fresh = directory.path().join(".settings.json.4243.3.4.0.tmp");
        std::fs::write(&fresh, b"{\"editor\":").unwrap();

        assert_eq!(load_settings_at(&path).unwrap().settings, original);

        let replacement = serde_json::json!({ "editor": {} });
        save_settings_at(&path, &replacement).unwrap();
        assert_eq!(load_settings_at(&path).unwrap().settings, replacement);
        assert!(!stale.exists());
        assert!(fresh.exists());
    }
}
