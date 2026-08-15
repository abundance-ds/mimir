use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    path::{Component, Path, PathBuf},
    time::Duration,
};

const MAX_DUPLICATE_FILES: usize = 512;
const MAX_DUPLICATE_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AppMode {
    Embedded,
    Terminal,
    Process,
    Window,
    RustHelper,
    Action,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppToolDefinition {
    pub name: String,
    pub description: String,
    #[serde(default = "empty_object")]
    pub input_schema: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_alias: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppDefinition {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub mode: AppMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub helper: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action_tool: Option<String>,
    #[serde(default)]
    pub launch_only: bool,
    #[serde(default)]
    pub tools: Vec<AppToolDefinition>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledApp {
    #[serde(flatten)]
    pub definition: AppDefinition,
    pub directory: String,
    pub manifest_path: String,
    pub builtin: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppDiagnostic {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppCatalog {
    pub directory: String,
    pub apps: Vec<InstalledApp>,
    pub diagnostics: Vec<AppDiagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "mode",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ResolvedAppLaunch {
    Embedded {
        app_id: String,
        url: String,
    },
    Terminal {
        app_id: String,
        preset: String,
        args: Vec<String>,
        env: BTreeMap<String, String>,
    },
    Process {
        app_id: String,
        command: String,
        args: Vec<String>,
        cwd: String,
        env: BTreeMap<String, String>,
        launch_only: bool,
    },
    Window {
        app_id: String,
        url: String,
    },
    RustHelper {
        app_id: String,
        helper: String,
    },
    Action {
        app_id: String,
        tool: String,
    },
}

pub fn default_apps_dir() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|home| home.join(".mimir").join("apps"))
        .ok_or_else(|| "Could not resolve the home directory for apps.".to_string())
}

pub fn builtin_apps() -> Vec<InstalledApp> {
    vec![
        InstalledApp {
            definition: AppDefinition {
                // Keep the original id and data key so the former Scratch app
                // reopens with its durable text intact.
                id: "scratch".into(),
                title: "Today".into(),
                description: "Write today in a focused Markdown journal.".into(),
                mode: AppMode::Embedded,
                entry: Some("mimir://builtin/scratch".into()),
                command: None,
                args: Vec::new(),
                env: BTreeMap::new(),
                preset: None,
                helper: None,
                action_tool: None,
                launch_only: false,
                tools: Vec::new(),
            },
            directory: "builtin".into(),
            manifest_path: "builtin:scratch".into(),
            builtin: true,
        },
        InstalledApp {
            definition: AppDefinition {
                id: "business-graph".into(),
                title: "Business graph".into(),
                description:
                    "Run work, projects, relationships, and durable knowledge from one graph."
                        .into(),
                mode: AppMode::RustHelper,
                entry: None,
                command: None,
                args: Vec::new(),
                env: BTreeMap::new(),
                preset: None,
                helper: Some("business-graph".into()),
                action_tool: None,
                launch_only: false,
                tools: Vec::new(),
            },
            directory: "builtin".into(),
            manifest_path: "builtin:business-graph".into(),
            builtin: true,
        },
        InstalledApp {
            definition: AppDefinition {
                id: "scribe".into(),
                title: "Scribe".into(),
                description:
                    "Record meetings, follow the live transcript, and turn outcomes into reviewed knowledge."
                        .into(),
                mode: AppMode::RustHelper,
                entry: None,
                command: None,
                args: Vec::new(),
                env: BTreeMap::new(),
                preset: None,
                helper: Some("scribe".into()),
                action_tool: None,
                launch_only: false,
                tools: Vec::new(),
            },
            directory: "builtin".into(),
            manifest_path: "builtin:scribe".into(),
            builtin: true,
        },
        InstalledApp {
            definition: AppDefinition {
                id: "tracker".into(),
                title: "Tracker".into(),
                description:
                    "See where the day went, correct the record, and interrupt accidental drift."
                        .into(),
                mode: AppMode::RustHelper,
                entry: None,
                command: None,
                args: Vec::new(),
                env: BTreeMap::new(),
                preset: None,
                helper: Some("tracker".into()),
                action_tool: None,
                launch_only: false,
                tools: Vec::new(),
            },
            directory: "builtin".into(),
            manifest_path: "builtin:tracker".into(),
            builtin: true,
        },
    ]
}

pub fn load_catalog(directory: &Path) -> AppCatalog {
    let mut catalog = AppCatalog {
        directory: directory.to_string_lossy().into_owned(),
        apps: builtin_apps(),
        diagnostics: Vec::new(),
    };
    let mut manifest_paths = match fs::read_dir(directory) {
        Ok(entries) => entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let path = entry.path();
                if path.is_dir() {
                    let manifest = path.join("app.toml");
                    manifest.exists().then_some(manifest)
                } else if path.extension().and_then(|value| value.to_str()) == Some("toml") {
                    Some(path)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return catalog,
        Err(error) => {
            catalog.diagnostics.push(AppDiagnostic {
                path: catalog.directory.clone(),
                field: None,
                message: format!("Could not read apps directory: {error}"),
            });
            return catalog;
        }
    };
    manifest_paths.sort();

    let mut ids = catalog
        .apps
        .iter()
        .map(|app| app.definition.id.clone())
        .collect::<HashSet<_>>();
    for manifest_path in manifest_paths {
        let display_path = manifest_path.to_string_lossy().into_owned();
        let source = match fs::read_to_string(&manifest_path) {
            Ok(source) => source,
            Err(error) => {
                catalog.diagnostics.push(AppDiagnostic {
                    path: display_path,
                    field: None,
                    message: format!("Could not read app manifest: {error}"),
                });
                continue;
            }
        };
        let definition = match toml::from_str::<AppDefinition>(&source) {
            Ok(definition) => definition,
            Err(error) => {
                catalog.diagnostics.push(AppDiagnostic {
                    path: display_path,
                    field: None,
                    message: format!("Invalid TOML: {error}"),
                });
                continue;
            }
        };
        let app_directory = manifest_path.parent().unwrap_or(directory);
        if let Err((field, message)) = validate_definition(&definition, app_directory) {
            catalog.diagnostics.push(AppDiagnostic {
                path: display_path,
                field: Some(field),
                message,
            });
            continue;
        }
        if !ids.insert(definition.id.clone()) {
            catalog.diagnostics.push(AppDiagnostic {
                path: display_path,
                field: Some("id".into()),
                message: format!(
                    "Duplicate app id '{}'; built-ins and earlier manifests keep ownership.",
                    definition.id
                ),
            });
            continue;
        }
        catalog.apps.push(InstalledApp {
            definition,
            directory: app_directory.to_string_lossy().into_owned(),
            manifest_path: display_path,
            builtin: false,
        });
    }
    catalog.apps.sort_by(|left, right| {
        left.definition
            .title
            .cmp(&right.definition.title)
            .then(left.definition.id.cmp(&right.definition.id))
    });
    catalog
}

pub fn create_local_app(
    directory: &Path,
    id: &str,
    title: &str,
    description: Option<&str>,
) -> Result<AppCatalog, String> {
    validate_id(id)?;
    validate_title(title)?;
    fs::create_dir_all(directory).map_err(|error| {
        format!(
            "Could not create apps directory {}: {error}",
            directory.display()
        )
    })?;
    ensure_id_available(directory, id)?;

    let target = directory.join(id);
    if target.exists() {
        return Err(format!("App path '{}' already exists.", target.display()));
    }
    let staging = directory.join(format!(".{id}.creating-{}", uuid::Uuid::new_v4().simple()));
    fs::create_dir(&staging)
        .map_err(|error| format!("Could not stage app '{}': {error}", staging.display()))?;

    let result = (|| {
        let description = description
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("A small local instrument built for this workbench.");
        crate::persistence::write_bytes_atomic(
            staging.join("app.toml"),
            starter_manifest(id, title.trim(), description).as_bytes(),
        )
        .map_err(|error| format!("Could not write app manifest: {error}"))?;
        crate::persistence::write_bytes_atomic(
            staging.join("index.html"),
            starter_html(title.trim()).as_bytes(),
        )
        .map_err(|error| format!("Could not write app entry: {error}"))?;
        fs::rename(&staging, &target)
            .map_err(|error| format!("Could not install app '{}': {error}", target.display()))?;
        Ok::<(), String>(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result?;
    Ok(load_catalog(directory))
}

pub fn duplicate_local_app(
    directory: &Path,
    app_id: &str,
    new_id: &str,
    title: Option<&str>,
) -> Result<AppCatalog, String> {
    validate_id(new_id)?;
    let catalog = load_catalog(directory);
    let source = find_local_app(&catalog, app_id)?;
    ensure_id_available(directory, new_id)?;
    let new_title = title
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("{} Copy", source.definition.title));
    validate_title(&new_title)?;

    let source_manifest = PathBuf::from(&source.manifest_path);
    let package_directory = source_manifest.file_name().and_then(|value| value.to_str())
        == Some("app.toml")
        && source_manifest.parent() != Some(directory);
    let staging = directory.join(format!(
        ".{new_id}.duplicating-{}",
        uuid::Uuid::new_v4().simple()
    ));
    let target = if package_directory {
        directory.join(new_id)
    } else {
        directory.join(format!("{new_id}.toml"))
    };
    if target.exists() {
        return Err(format!("App path '{}' already exists.", target.display()));
    }

    let result = (|| {
        let target_manifest = if package_directory {
            copy_tree_limited(
                source_manifest
                    .parent()
                    .ok_or_else(|| "App package has no parent directory.".to_string())?,
                &staging,
            )?;
            staging.join("app.toml")
        } else {
            fs::create_dir(&staging)
                .map_err(|error| format!("Could not stage app duplicate: {error}"))?;
            let staged_manifest = staging.join(format!("{new_id}.toml"));
            fs::copy(&source_manifest, &staged_manifest)
                .map_err(|error| format!("Could not copy app manifest: {error}"))?;
            staged_manifest
        };
        update_manifest_identity(&target_manifest, app_id, Some(new_id), Some(&new_title))?;
        let definition = read_definition(&target_manifest)?;
        let definition_directory = if package_directory {
            target_manifest.parent().unwrap_or(directory)
        } else {
            directory
        };
        validate_definition(&definition, definition_directory)
            .map_err(|(field, message)| format!("{field}: {message}"))?;

        if package_directory {
            fs::rename(&staging, &target)
                .map_err(|error| format!("Could not install app duplicate: {error}"))?;
        } else {
            let staged_manifest = staging.join(format!("{new_id}.toml"));
            fs::rename(&staged_manifest, &target)
                .map_err(|error| format!("Could not install app duplicate: {error}"))?;
            fs::remove_dir(&staging)
                .map_err(|error| format!("Could not finish app duplicate: {error}"))?;
        }
        Ok::<(), String>(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result?;
    Ok(load_catalog(directory))
}

pub fn update_local_app_title(
    directory: &Path,
    app_id: &str,
    title: &str,
) -> Result<AppCatalog, String> {
    validate_title(title)?;
    let catalog = load_catalog(directory);
    let app = find_local_app(&catalog, app_id)?;
    let manifest = PathBuf::from(&app.manifest_path);
    update_manifest_identity(&manifest, app_id, None, Some(title.trim()))?;
    let definition = read_definition(&manifest)?;
    validate_definition(&definition, manifest.parent().unwrap_or(directory))
        .map_err(|(field, message)| format!("{field}: {message}"))?;
    Ok(load_catalog(directory))
}

pub fn trash_local_app_with(
    directory: &Path,
    app_id: &str,
    move_to_trash: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<AppCatalog, String> {
    let catalog = load_catalog(directory);
    let app = find_local_app(&catalog, app_id)?;
    let manifest = PathBuf::from(&app.manifest_path);
    let target = if manifest.file_name().and_then(|value| value.to_str()) == Some("app.toml")
        && manifest.parent() != Some(directory)
    {
        manifest
            .parent()
            .ok_or_else(|| "App package has no parent directory.".to_string())?
            .to_path_buf()
    } else {
        manifest
    };
    let parent = target
        .parent()
        .ok_or_else(|| "App definition has no parent directory.".to_string())?;
    if parent != directory {
        return Err("Refusing to Trash an app outside the apps directory.".into());
    }
    move_to_trash(&target)?;
    Ok(load_catalog(directory))
}

fn find_local_app<'a>(catalog: &'a AppCatalog, app_id: &str) -> Result<&'a InstalledApp, String> {
    catalog
        .apps
        .iter()
        .find(|app| app.definition.id == app_id && !app.builtin)
        .ok_or_else(|| {
            if catalog
                .apps
                .iter()
                .any(|app| app.definition.id == app_id && app.builtin)
            {
                format!("Built-in app '{app_id}' cannot be modified.")
            } else {
                format!("Local app '{app_id}' was not found.")
            }
        })
}

fn ensure_id_available(directory: &Path, id: &str) -> Result<(), String> {
    if load_catalog(directory)
        .apps
        .iter()
        .any(|app| app.definition.id == id)
    {
        return Err(format!("App id '{id}' is already installed."));
    }
    Ok(())
}

fn validate_title(title: &str) -> Result<(), String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("Title must not be empty.".into());
    }
    if title.chars().count() > 120 {
        return Err("Title must be at most 120 characters.".into());
    }
    if title.contains(['\0', '\n', '\r']) {
        return Err("Title must be one line without NUL bytes.".into());
    }
    Ok(())
}

fn read_definition(path: &Path) -> Result<AppDefinition, String> {
    let source = fs::read_to_string(path)
        .map_err(|error| format!("Could not read app manifest '{}': {error}", path.display()))?;
    toml::from_str(&source)
        .map_err(|error| format!("Invalid app manifest '{}': {error}", path.display()))
}

fn update_manifest_identity(
    path: &Path,
    expected_id: &str,
    new_id: Option<&str>,
    new_title: Option<&str>,
) -> Result<(), String> {
    let source = fs::read_to_string(path)
        .map_err(|error| format!("Could not read app manifest '{}': {error}", path.display()))?;
    let current: AppDefinition = toml::from_str(&source)
        .map_err(|error| format!("Invalid app manifest '{}': {error}", path.display()))?;
    if current.id != expected_id {
        return Err(format!(
            "App manifest changed: expected id '{expected_id}', found '{}'.",
            current.id
        ));
    }

    let mut replaced_id = new_id.is_none();
    let mut replaced_title = new_title.is_none();
    let had_newline = source.ends_with('\n');
    let mut output = Vec::new();
    let mut in_top_level = true;
    for line in source.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with('[') {
            in_top_level = false;
        }
        let key = in_top_level
            .then(|| trimmed.split_once('=').map(|(key, _)| key.trim()))
            .flatten();
        if key == Some("id") {
            if let Some(value) = new_id {
                let indent = &line[..line.len() - trimmed.len()];
                output.push(format!("{indent}id = {}", toml_string(value)));
                replaced_id = true;
                continue;
            }
        }
        if key == Some("title") {
            if let Some(value) = new_title {
                let indent = &line[..line.len() - trimmed.len()];
                output.push(format!("{indent}title = {}", toml_string(value)));
                replaced_title = true;
                continue;
            }
        }
        output.push(line.to_string());
    }
    if !replaced_id || !replaced_title {
        return Err("App manifest must define top-level id and title fields.".into());
    }
    let mut updated = output.join("\n");
    if had_newline {
        updated.push('\n');
    }
    let parsed: AppDefinition = toml::from_str(&updated)
        .map_err(|error| format!("Updated app manifest would be invalid: {error}"))?;
    if parsed.id != new_id.unwrap_or(expected_id) {
        return Err("Updated app manifest did not preserve the expected id.".into());
    }
    crate::persistence::write_bytes_atomic(path, updated.as_bytes())
        .map_err(|error| format!("Could not update app manifest: {error}"))
}

fn toml_string(value: &str) -> String {
    toml::Value::String(value.to_string()).to_string()
}

fn copy_tree_limited(source: &Path, target: &Path) -> Result<(), String> {
    if fs::symlink_metadata(source)
        .map_err(|error| format!("Could not inspect app package: {error}"))?
        .file_type()
        .is_symlink()
    {
        return Err("App duplicate does not follow a symlinked package directory.".into());
    }
    let mut entries = 0usize;
    let mut bytes = 0u64;
    copy_tree_entry(source, target, &mut entries, &mut bytes)
}

fn copy_tree_entry(
    source: &Path,
    target: &Path,
    entries: &mut usize,
    bytes: &mut u64,
) -> Result<(), String> {
    fs::create_dir(target).map_err(|error| {
        format!(
            "Could not stage app directory '{}': {error}",
            target.display()
        )
    })?;
    for entry in fs::read_dir(source).map_err(|error| {
        format!(
            "Could not read app directory '{}': {error}",
            source.display()
        )
    })? {
        let entry = entry.map_err(|error| format!("Could not read app entry: {error}"))?;
        *entries += 1;
        if *entries > MAX_DUPLICATE_FILES {
            return Err(format!(
                "App duplicate exceeds the {} entry safety limit.",
                MAX_DUPLICATE_FILES
            ));
        }
        let metadata = fs::symlink_metadata(entry.path())
            .map_err(|error| format!("Could not inspect app entry: {error}"))?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "App duplicate does not follow symlink '{}'.",
                entry.path().display()
            ));
        }
        let destination = target.join(entry.file_name());
        if metadata.is_dir() {
            copy_tree_entry(&entry.path(), &destination, entries, bytes)?;
            continue;
        }
        if !metadata.is_file() {
            return Err(format!(
                "App duplicate cannot copy special entry '{}'.",
                entry.path().display()
            ));
        }
        *bytes = bytes.saturating_add(metadata.len());
        if *bytes > MAX_DUPLICATE_BYTES {
            return Err(format!(
                "App duplicate exceeds the {}MB safety limit.",
                MAX_DUPLICATE_BYTES / 1024 / 1024
            ));
        }
        fs::copy(entry.path(), destination)
            .map_err(|error| format!("Could not copy app entry: {error}"))?;
    }
    Ok(())
}

fn starter_manifest(id: &str, title: &str, description: &str) -> String {
    let alias = if id
        .chars()
        .next()
        .is_some_and(|character| character.is_ascii_alphabetic() || character == '_')
    {
        format!("{id}_read")
    } else {
        format!("app_{id}_read")
    };
    format!(
        r#"id = {}
title = {}
description = {}
mode = "embedded"
entry = "index.html"

[[tools]]
name = "read"
mcpAlias = {}
description = "Read this instrument's current note."
inputSchema = {{ type = "object", properties = {{}} }}
"#,
        toml_string(id),
        toml_string(title),
        toml_string(description),
        toml_string(&alias),
    )
}

fn starter_html(title: &str) -> String {
    let title = title
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;");
    format!(
        r#"<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{title}</title>
  <style>
    html, body {{ height: 100%; }}
    body {{ background: var(--color-chrome-high); padding: 18px; }}
    main {{ display: flex; height: 100%; flex-direction: column; border: 1px solid var(--color-rule); background: var(--color-surface); }}
    header, footer {{ display: flex; align-items: center; gap: 16px; padding: 12px 14px; background: var(--color-chrome-high); }}
    header {{ border-bottom: 1px solid var(--color-rule); }}
    footer {{ border-top: 1px solid var(--color-rule); color: var(--color-ink-3); font-size: 11px; }}
    header div {{ flex: 1; }}
    h1 {{ margin: 2px 0 0; font-family: var(--font-sans); font-size: 19px; }}
    small, #state {{ color: var(--color-ink-3); font-family: var(--font-mono); font-size: 9px; letter-spacing: .12em; }}
    textarea {{ min-height: 0; flex: 1; resize: none; border: 0; border-radius: 0; padding: 18px; font-family: var(--font-mono); font-size: 12px; line-height: 1.7; }}
    footer span {{ min-width: 0; flex: 1; }}
    footer button {{ padding: 5px 10px; font-size: 11px; }}
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <small>LOCAL INSTRUMENT</small>
        <h1>{title}</h1>
      </div>
      <span id="state">Ready</span>
    </header>
    <textarea id="note" aria-label="{title} note" placeholder="Shape this instrument into whatever you need."></textarea>
    <footer>
      <span>Autosaves locally · MCP tool <code>read</code> is live while open</span>
      <button id="save">Save now</button>
    </footer>
  </main>
  <script>
    const note = document.querySelector('#note')
    const state = document.querySelector('#state')
    let timer
    async function save() {{
      clearTimeout(timer)
      state.textContent = 'Saving'
      await mimir.data.save('note', {{ text: note.value, updatedAt: new Date().toISOString() }})
      state.textContent = 'Saved'
    }}
    note.addEventListener('input', () => {{
      state.textContent = 'Unsaved'
      clearTimeout(timer)
      timer = setTimeout(save, 350)
    }})
    document.querySelector('#save').addEventListener('click', save)
    mimir.tools.handle('read', () => ({{
      value: {{ text: note.value, characters: note.value.length }},
      displayText: note.value || '(The instrument is empty.)'
    }}))
    mimir.data.load('note').then(saved => {{
      note.value = saved?.text || ''
      state.textContent = 'Ready'
      note.focus()
    }}).catch(error => {{
      state.textContent = error.message
    }})
  </script>
</body>
</html>
"#
    )
}

pub fn validate_definition(
    definition: &AppDefinition,
    app_directory: &Path,
) -> Result<(), (String, String)> {
    validate_id(&definition.id).map_err(|message| ("id".into(), message))?;
    if definition.title.trim().is_empty() {
        return Err(("title".into(), "Title must not be empty.".into()));
    }
    if definition.args.iter().any(|arg| arg.contains('\0')) {
        return Err((
            "args".into(),
            "Arguments must not contain NUL bytes.".into(),
        ));
    }
    for (key, value) in &definition.env {
        if key.is_empty() || key.contains(['=', '\0']) || value.contains('\0') {
            return Err((
                "env".into(),
                "Environment contains an invalid entry.".into(),
            ));
        }
    }
    let mut tool_names = HashSet::new();
    for (index, tool) in definition.tools.iter().enumerate() {
        validate_id(&tool.name).map_err(|message| (format!("tools[{index}].name"), message))?;
        if !tool_names.insert(tool.name.as_str()) {
            return Err((
                format!("tools[{index}].name"),
                format!("Duplicate app tool name '{}'.", tool.name),
            ));
        }
        if tool.description.trim().is_empty() {
            return Err((
                format!("tools[{index}].description"),
                "Tool description must not be empty.".into(),
            ));
        }
        if !tool.input_schema.is_object() {
            return Err((
                format!("tools[{index}].inputSchema"),
                "Tool input schema must be a JSON object.".into(),
            ));
        }
    }

    match definition.mode {
        AppMode::Embedded | AppMode::Window => {
            let entry = required(&definition.entry, "entry")?;
            validate_entry(entry, app_directory).map_err(|message| ("entry".into(), message))?;
        }
        AppMode::Terminal => {
            required(&definition.preset, "preset")?;
        }
        AppMode::Process => {
            let command = required(&definition.command, "command")?;
            if command.contains('\0') {
                return Err((
                    "command".into(),
                    "Command must not contain NUL bytes.".into(),
                ));
            }
        }
        AppMode::RustHelper => {
            validate_id(required(&definition.helper, "helper")?)
                .map_err(|message| ("helper".into(), message))?;
        }
        AppMode::Action => {
            let tool = required(&definition.action_tool, "actionTool")?;
            if tool.trim().is_empty() || tool.contains(char::is_whitespace) {
                return Err((
                    "actionTool".into(),
                    "Action tool must be one canonical tool name without whitespace.".into(),
                ));
            }
        }
    }
    Ok(())
}

pub fn resolve_launch(
    app: &InstalledApp,
    workspace: Option<&Path>,
) -> Result<ResolvedAppLaunch, String> {
    let definition = &app.definition;
    validate_definition(definition, Path::new(&app.directory))
        .map_err(|(field, message)| format!("{}.{}: {message}", definition.id, field))?;
    let app_id = definition.id.clone();
    match definition.mode {
        AppMode::Embedded => Ok(ResolvedAppLaunch::Embedded {
            app_id,
            url: resolve_entry(app, definition.entry.as_deref().unwrap())?,
        }),
        AppMode::Window => Ok(ResolvedAppLaunch::Window {
            app_id,
            url: resolve_entry(app, definition.entry.as_deref().unwrap())?,
        }),
        AppMode::Terminal => Ok(ResolvedAppLaunch::Terminal {
            app_id,
            preset: definition.preset.clone().unwrap(),
            args: definition.args.clone(),
            env: definition.env.clone(),
        }),
        AppMode::Process => {
            let cwd = workspace
                .map(Path::to_path_buf)
                .unwrap_or_else(|| PathBuf::from(&app.directory));
            Ok(ResolvedAppLaunch::Process {
                app_id,
                command: definition.command.clone().unwrap(),
                args: definition.args.clone(),
                cwd: cwd.to_string_lossy().into_owned(),
                env: definition.env.clone(),
                launch_only: definition.launch_only,
            })
        }
        AppMode::RustHelper => Ok(ResolvedAppLaunch::RustHelper {
            app_id,
            helper: definition.helper.clone().unwrap(),
        }),
        AppMode::Action => Ok(ResolvedAppLaunch::Action {
            app_id,
            tool: definition.action_tool.clone().unwrap(),
        }),
    }
}

fn resolve_entry(app: &InstalledApp, entry: &str) -> Result<String, String> {
    if entry.starts_with("mimir://")
        || entry.starts_with("http://")
        || entry.starts_with("https://")
    {
        return Ok(entry.into());
    }
    let path = Path::new(&app.directory).join(entry);
    path.canonicalize()
        .map(|path| format!("file://{}", path.to_string_lossy()))
        .map_err(|error| format!("Could not resolve app entry '{}': {error}", path.display()))
}

fn validate_entry(entry: &str, app_directory: &Path) -> Result<(), String> {
    if entry.starts_with("mimir://")
        || entry.starts_with("http://")
        || entry.starts_with("https://")
    {
        return Ok(());
    }
    let path = Path::new(entry);
    if path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_)))
    {
        return Err("Entry must be an app-relative path or an http(s)/mimir URL.".into());
    }
    if !app_directory.join(path).is_file() {
        return Err(format!("Entry '{}' does not exist.", entry));
    }
    Ok(())
}

fn required<'a>(value: &'a Option<String>, field: &str) -> Result<&'a str, (String, String)> {
    value
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            (
                field.into(),
                format!("{field} is required for this app mode."),
            )
        })
}

fn validate_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 64
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("Id must be 1-64 ASCII letters, numbers, hyphens, or underscores.".into());
    }
    Ok(())
}

fn empty_object() -> Value {
    serde_json::json!({ "type": "object", "properties": {} })
}

fn sdk_js_content() -> &'static str {
    include_str!("../../src/apps/sdk/mimir-sdk.js")
}

fn theme_css_content() -> &'static str {
    include_str!("../../src/apps/sdk/theme-base.css")
}

pub fn serve_app_file(request: tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    let path = request.uri().path().trim_start_matches('/');
    if path == "_sdk/mimir-sdk.js" || path.ends_with("/_sdk/mimir-sdk.js") {
        return response(
            200,
            "application/javascript",
            sdk_js_content().as_bytes().to_vec(),
        );
    }
    if path == "_sdk/theme.css" || path.ends_with("/_sdk/theme.css") {
        return response(200, "text/css", theme_css_content().as_bytes().to_vec());
    }

    let Some((app_id, relative)) = path.split_once('/') else {
        return response(404, "text/plain", b"Expected app-id/path.".to_vec());
    };
    if validate_id(app_id).is_err() || validate_relative_path(relative).is_err() {
        return response(403, "text/plain", b"Forbidden.".to_vec());
    }

    let directory = match default_apps_dir() {
        Ok(directory) => directory,
        Err(error) => return response(500, "text/plain", error.into_bytes()),
    };
    let catalog = load_catalog(&directory);
    let Some(app) = catalog
        .apps
        .iter()
        .find(|app| !app.builtin && app.definition.id == app_id)
    else {
        return response(404, "text/plain", b"Unknown app.".to_vec());
    };
    let root = match Path::new(&app.directory).canonicalize() {
        Ok(root) => root,
        Err(error) => return response(404, "text/plain", error.to_string().into_bytes()),
    };
    let file = match root.join(relative).canonicalize() {
        Ok(file) if file.starts_with(&root) => file,
        _ => return response(403, "text/plain", b"Forbidden.".to_vec()),
    };
    let content = match fs::read(&file) {
        Ok(content) => content,
        Err(error) => return response(404, "text/plain", error.to_string().into_bytes()),
    };
    let content_type = match file.extension().and_then(|extension| extension.to_str()) {
        Some("html") => "text/html",
        Some("js" | "mjs") => "application/javascript",
        Some("css") => "text/css",
        Some("json") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("woff2") => "font/woff2",
        _ => "application/octet-stream",
    };
    let body = if content_type == "text/html" {
        inject_sdk(&String::from_utf8_lossy(&content)).into_bytes()
    } else {
        content
    };
    response(200, content_type, body)
}

fn response(
    status: u16,
    content_type: &'static str,
    body: Vec<u8>,
) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .header("Content-Type", content_type)
        .header("Access-Control-Allow-Origin", "*")
        .body(body)
        .expect("static app response must be valid")
}

fn inject_sdk(html: &str) -> String {
    let sdk = r#"<link rel="stylesheet" href="/_sdk/theme.css"><script src="/_sdk/mimir-sdk.js"></script>"#;
    if let Some(position) = html.find("</head>") {
        format!("{}{}{}", &html[..position], sdk, &html[position..])
    } else {
        format!("{sdk}{html}")
    }
}

fn validate_relative_path(value: &str) -> Result<(), String> {
    let path = Path::new(value);
    if value.is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_)))
    {
        return Err("Path must remain inside the app directory.".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn app_catalog() -> Result<AppCatalog, String> {
    let directory = default_apps_dir()?;
    tauri::async_runtime::spawn_blocking(move || {
        fs::create_dir_all(&directory).map_err(|error| {
            format!(
                "Could not create apps directory {}: {error}",
                directory.display()
            )
        })?;
        Ok::<_, String>(load_catalog(&directory))
    })
    .await
    .map_err(|error| format!("App catalog task failed: {error}"))?
}

#[tauri::command]
pub async fn app_reload() -> Result<AppCatalog, String> {
    app_catalog().await
}

#[tauri::command]
pub async fn app_create(
    id: String,
    title: String,
    description: Option<String>,
) -> Result<AppCatalog, String> {
    let directory = default_apps_dir()?;
    tauri::async_runtime::spawn_blocking(move || {
        create_local_app(&directory, &id, &title, description.as_deref())
    })
    .await
    .map_err(|error| format!("App creation task failed: {error}"))?
}

#[tauri::command]
pub async fn app_duplicate(
    app_id: String,
    new_id: String,
    title: Option<String>,
) -> Result<AppCatalog, String> {
    let directory = default_apps_dir()?;
    tauri::async_runtime::spawn_blocking(move || {
        duplicate_local_app(&directory, &app_id, &new_id, title.as_deref())
    })
    .await
    .map_err(|error| format!("App duplication task failed: {error}"))?
}

#[tauri::command]
pub async fn app_update_title(app_id: String, title: String) -> Result<AppCatalog, String> {
    let directory = default_apps_dir()?;
    tauri::async_runtime::spawn_blocking(move || {
        update_local_app_title(&directory, &app_id, &title)
    })
    .await
    .map_err(|error| format!("App update task failed: {error}"))?
}

#[tauri::command]
pub async fn app_trash(app_id: String) -> Result<AppCatalog, String> {
    let directory = default_apps_dir()?;
    tauri::async_runtime::spawn_blocking(move || {
        trash_local_app_with(&directory, &app_id, |path| {
            trash::delete(path).map_err(|error| {
                format!("Could not move app '{}' to Trash: {error}", path.display())
            })
        })
    })
    .await
    .map_err(|error| format!("App Trash task failed: {error}"))?
}

#[tauri::command]
pub async fn app_resolve(
    app_id: String,
    workspace_path: Option<String>,
) -> Result<ResolvedAppLaunch, String> {
    let directory = default_apps_dir()?;
    tauri::async_runtime::spawn_blocking(move || {
        fs::create_dir_all(&directory).map_err(|error| {
            format!(
                "Could not create apps directory {}: {error}",
                directory.display()
            )
        })?;
        let catalog = load_catalog(&directory);
        let app = catalog
            .apps
            .iter()
            .find(|app| app.definition.id == app_id)
            .ok_or_else(|| format!("App '{app_id}' was not found."))?;
        resolve_launch(app, workspace_path.as_deref().map(Path::new))
    })
    .await
    .map_err(|error| format!("App resolution task failed: {error}"))?
}

#[tauri::command]
pub async fn app_open_window(
    app: tauri::AppHandle,
    app_id: String,
    workspace_path: Option<String>,
) -> Result<String, String> {
    let resolved = app_resolve(app_id.clone(), workspace_path).await?;
    let url = match resolved {
        ResolvedAppLaunch::Window { url, .. } | ResolvedAppLaunch::Embedded { url, .. } => url,
        _ => return Err(format!("App '{app_id}' does not have a web UI.")),
    };
    let label = format!("app-{app_id}-{}", uuid::Uuid::new_v4().simple());
    let webview_url = if let Some(relative) = url.strip_prefix("file://") {
        tauri::WebviewUrl::External(
            format!("file://{relative}")
                .parse()
                .map_err(|error: url::ParseError| error.to_string())?,
        )
    } else if url.starts_with("http://") || url.starts_with("https://") {
        tauri::WebviewUrl::External(
            url.parse()
                .map_err(|error: url::ParseError| error.to_string())?,
        )
    } else {
        return Err(format!("App URL '{url}' cannot open in a separate window."));
    };
    tauri::WebviewWindowBuilder::new(&app, &label, webview_url)
        .title(app_id)
        .inner_size(900.0, 680.0)
        .min_inner_size(400.0, 300.0)
        .center()
        .build()
        .map_err(|error| format!("Could not open app window: {error}"))?;
    Ok(label)
}

fn app_data_path(app_id: &str, key: &str) -> Result<PathBuf, String> {
    validate_id(app_id)?;
    validate_relative_path(key)?;
    let root = dirs::home_dir()
        .ok_or_else(|| "Could not resolve the home directory for app data.".to_string())?
        .join(".mimir")
        .join("app-data")
        .join(app_id);
    Ok(root.join(format!("{key}.json")))
}

#[tauri::command]
pub fn app_data_load(app_id: String, key: String) -> Result<Option<String>, String> {
    let path = app_data_path(&app_id, &key)?;
    match fs::read_to_string(path) {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Could not read app data: {error}")),
    }
}

#[tauri::command]
pub fn app_data_save(app_id: String, key: String, value: String) -> Result<(), String> {
    let path = app_data_path(&app_id, &key)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create app data directory: {error}"))?;
    }
    crate::persistence::write_bytes_atomic(&path, value.as_bytes())
        .map_err(|error| format!("Could not save app data: {error}"))
}

#[tauri::command]
pub fn app_data_delete(app_id: String, key: String) -> Result<(), String> {
    let path = app_data_path(&app_id, &key)?;
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Could not delete app data: {error}")),
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: String,
}

#[tauri::command]
pub async fn app_http_request(
    url: String,
    method: Option<String>,
    headers: Option<HashMap<String, String>>,
    body: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<HttpResponse, String> {
    let parsed = url::Url::parse(&url).map_err(|error| format!("Invalid URL: {error}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Only http and https URLs are supported.".into());
    }
    let method = reqwest::Method::from_bytes(method.as_deref().unwrap_or("GET").as_bytes())
        .map_err(|error| format!("Invalid HTTP method: {error}"))?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(
            timeout_ms.unwrap_or(30_000).min(120_000),
        ))
        .build()
        .map_err(|error| format!("Could not create HTTP client: {error}"))?;
    let mut request = client.request(method, parsed);
    for (key, value) in headers.unwrap_or_default() {
        request = request.header(key, value);
    }
    if let Some(body) = body {
        request = request.body(body);
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("App HTTP request failed: {error}"))?;
    let status = response.status().as_u16();
    let headers = response
        .headers()
        .iter()
        .map(|(key, value)| {
            (
                key.to_string(),
                value.to_str().unwrap_or_default().to_string(),
            )
        })
        .collect();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("Could not read app HTTP response: {error}"))?;
    if bytes.len() > 10 * 1024 * 1024 {
        return Err("App HTTP response exceeds the 10MB limit.".into());
    }
    Ok(HttpResponse {
        status,
        headers,
        body: String::from_utf8_lossy(&bytes).into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn write_embedded_app(root: &Path, id: &str, title: &str) {
        let directory = root.join(id);
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("index.html"), "<main>hello</main>").unwrap();
        fs::write(
            directory.join("app.toml"),
            format!(
                r#"
id = "{id}"
title = "{title}"
description = "A local embedded app."
mode = "embedded"
entry = "index.html"
"#
            ),
        )
        .unwrap();
    }

    #[test]
    fn catalog_loads_builtins_and_owned_manifests() {
        let directory = tempdir().unwrap();
        write_embedded_app(directory.path(), "inspector", "Inspector");
        let catalog = load_catalog(directory.path());
        assert_eq!(catalog.apps.len(), 5);
        assert!(catalog
            .apps
            .iter()
            .any(|app| app.definition.id == "scratch" && app.builtin));
        assert!(catalog.apps.iter().any(|app| {
            app.definition.id == "tracker"
                && app.definition.helper.as_deref() == Some("tracker")
                && app.builtin
        }));
        let today = catalog
            .apps
            .iter()
            .find(|app| app.definition.id == "scratch")
            .unwrap();
        assert!(
            today.definition.tools.is_empty(),
            "Today belongs in mimir_state, not a standalone tool"
        );
        assert!(catalog
            .apps
            .iter()
            .any(|app| app.definition.id == "business-graph" && app.builtin));
        let scribe = catalog
            .apps
            .iter()
            .find(|app| app.definition.id == "scribe")
            .unwrap();
        assert!(scribe.builtin);
        assert_eq!(scribe.definition.mode, AppMode::RustHelper);
        assert_eq!(scribe.definition.helper.as_deref(), Some("scribe"));
        assert!(scribe.definition.tools.is_empty());
        assert!(catalog
            .apps
            .iter()
            .any(|app| app.definition.id == "inspector" && !app.builtin));
        assert!(catalog.diagnostics.is_empty());
    }

    #[test]
    fn manifests_cannot_shadow_builtin_ids() {
        let directory = tempdir().unwrap();
        write_embedded_app(directory.path(), "scratch", "Shadow");
        let catalog = load_catalog(directory.path());
        assert_eq!(
            catalog
                .apps
                .iter()
                .filter(|app| app.definition.id == "scratch")
                .count(),
            1
        );
        assert!(catalog.diagnostics[0].message.contains("Duplicate"));
    }

    #[test]
    fn embedded_entry_cannot_escape_app_directory() {
        let directory = tempdir().unwrap();
        let definition = AppDefinition {
            id: "escape".into(),
            title: "Escape".into(),
            description: String::new(),
            mode: AppMode::Embedded,
            entry: Some("../secret.html".into()),
            command: None,
            args: Vec::new(),
            env: BTreeMap::new(),
            preset: None,
            helper: None,
            action_tool: None,
            launch_only: false,
            tools: Vec::new(),
        };
        let error = validate_definition(&definition, directory.path()).unwrap_err();
        assert_eq!(error.0, "entry");
        assert!(error.1.contains("relative"));
    }

    #[test]
    fn every_host_mode_resolves_to_an_explicit_launch_plan() {
        let directory = tempdir().unwrap();
        fs::write(directory.path().join("index.html"), "ok").unwrap();
        let cases = [
            (
                AppMode::Embedded,
                Some("index.html"),
                None,
                None,
                None,
                None,
            ),
            (AppMode::Terminal, None, None, Some("codex"), None, None),
            (AppMode::Process, None, Some("node"), None, None, None),
            (AppMode::Window, Some("index.html"), None, None, None, None),
            (
                AppMode::RustHelper,
                None,
                None,
                None,
                Some("business-graph"),
                None,
            ),
            (
                AppMode::Action,
                None,
                None,
                None,
                None,
                Some("files.refresh"),
            ),
        ];
        for (index, (mode, entry, command, preset, helper, action)) in cases.into_iter().enumerate()
        {
            let app = InstalledApp {
                definition: AppDefinition {
                    id: format!("app-{index}"),
                    title: format!("App {index}"),
                    description: String::new(),
                    mode,
                    entry: entry.map(str::to_string),
                    command: command.map(str::to_string),
                    args: vec!["--flag".into()],
                    env: BTreeMap::new(),
                    preset: preset.map(str::to_string),
                    helper: helper.map(str::to_string),
                    action_tool: action.map(str::to_string),
                    launch_only: false,
                    tools: Vec::new(),
                },
                directory: directory.path().to_string_lossy().into_owned(),
                manifest_path: directory
                    .path()
                    .join("app.toml")
                    .to_string_lossy()
                    .into_owned(),
                builtin: false,
            };
            assert!(resolve_launch(&app, Some(directory.path())).is_ok());
        }
    }

    #[test]
    fn terminal_launch_plan_preserves_manifest_environment() {
        let directory = tempdir().unwrap();
        let app = InstalledApp {
            definition: AppDefinition {
                id: "reviewer".into(),
                title: "Reviewer".into(),
                description: String::new(),
                mode: AppMode::Terminal,
                entry: None,
                command: None,
                args: vec!["--app-flag".into()],
                env: BTreeMap::from([
                    ("REVIEW_MODE".into(), "focused".into()),
                    ("WITH_SPACE".into(), "exact value".into()),
                ]),
                preset: Some("codex".into()),
                helper: None,
                action_tool: None,
                launch_only: false,
                tools: Vec::new(),
            },
            directory: directory.path().to_string_lossy().into_owned(),
            manifest_path: directory
                .path()
                .join("app.toml")
                .to_string_lossy()
                .into_owned(),
            builtin: false,
        };

        let plan = resolve_launch(&app, Some(directory.path())).unwrap();
        assert_eq!(
            plan,
            ResolvedAppLaunch::Terminal {
                app_id: "reviewer".into(),
                preset: "codex".into(),
                args: vec!["--app-flag".into()],
                env: BTreeMap::from([
                    ("REVIEW_MODE".into(), "focused".into()),
                    ("WITH_SPACE".into(), "exact value".into()),
                ]),
            }
        );
        assert_eq!(
            serde_json::to_value(plan).unwrap()["env"]["REVIEW_MODE"],
            "focused"
        );
    }

    #[test]
    fn tool_definitions_require_unique_names_and_object_schemas() {
        let mut definition = builtin_apps()[0].definition.clone();
        definition.tools.push(AppToolDefinition {
            name: "read".into(),
            description: "Read the current value.".into(),
            input_schema: empty_object(),
            mcp_alias: None,
        });
        definition.tools.push(AppToolDefinition {
            name: "read".into(),
            description: "Duplicate.".into(),
            input_schema: serde_json::json!([]),
            mcp_alias: None,
        });
        let error = validate_definition(&definition, Path::new("builtin")).unwrap_err();
        assert!(error.0.contains("name"));
        assert!(error.1.contains("Duplicate"));
    }

    #[test]
    fn creates_a_runnable_local_instrument_with_a_live_tool() {
        let directory = tempdir().unwrap();

        let catalog = create_local_app(
            directory.path(),
            "field-notes",
            "Field Notes",
            Some("A tiny working notebook."),
        )
        .unwrap();

        let app = catalog
            .apps
            .iter()
            .find(|app| app.definition.id == "field-notes")
            .unwrap();
        assert!(!app.builtin);
        assert_eq!(app.definition.mode, AppMode::Embedded);
        assert_eq!(
            app.definition.tools[0].mcp_alias.as_deref(),
            Some("field-notes_read")
        );
        assert!(directory.path().join("field-notes/index.html").is_file());
        let html = fs::read_to_string(directory.path().join("field-notes/index.html")).unwrap();
        assert!(html.contains("mimir.data.save"));
        assert!(html.contains("mimir.tools.handle('read'"));

        let numeric = create_local_app(directory.path(), "24-hours", "24 Hours", None).unwrap();
        let numeric = numeric
            .apps
            .iter()
            .find(|app| app.definition.id == "24-hours")
            .unwrap();
        assert_eq!(
            numeric.definition.tools[0].mcp_alias.as_deref(),
            Some("app_24-hours_read")
        );
    }

    #[test]
    fn duplicate_clones_assets_but_rejects_existing_and_builtin_ids() {
        let directory = tempdir().unwrap();
        write_embedded_app(directory.path(), "inspector", "Inspector");
        fs::write(
            directory.path().join("inspector/details.js"),
            "export const detail = 1",
        )
        .unwrap();

        let catalog = duplicate_local_app(
            directory.path(),
            "inspector",
            "inspector-copy",
            Some("Inspector Copy"),
        )
        .unwrap();
        let copy = catalog
            .apps
            .iter()
            .find(|app| app.definition.id == "inspector-copy")
            .unwrap();
        assert_eq!(copy.definition.title, "Inspector Copy");
        assert!(directory.path().join("inspector-copy/details.js").is_file());
        assert!(
            duplicate_local_app(directory.path(), "inspector", "inspector-copy", None)
                .unwrap_err()
                .contains("already installed")
        );
        assert!(
            duplicate_local_app(directory.path(), "scratch", "scratch-copy", None)
                .unwrap_err()
                .contains("Built-in")
        );
    }

    #[test]
    fn title_update_preserves_stable_identity_and_manifest_comments() {
        let directory = tempdir().unwrap();
        write_embedded_app(directory.path(), "inspector", "Inspector");
        let manifest = directory.path().join("inspector/app.toml");
        let mut source = fs::read_to_string(&manifest).unwrap();
        source.insert_str(0, "# keep this human note\n");
        fs::write(&manifest, source).unwrap();

        let catalog =
            update_local_app_title(directory.path(), "inspector", "Project Inspector").unwrap();
        let app = catalog
            .apps
            .iter()
            .find(|app| app.definition.id == "inspector")
            .unwrap();
        assert_eq!(app.definition.title, "Project Inspector");
        let updated = fs::read_to_string(manifest).unwrap();
        assert!(updated.starts_with("# keep this human note\n"));
        assert!(updated.contains("id = \"inspector\""));
    }

    #[test]
    fn trash_targets_one_exact_local_definition_and_never_builtins() {
        let directory = tempdir().unwrap();
        write_embedded_app(directory.path(), "inspector", "Inspector");
        let mut trashed = None;

        let catalog = trash_local_app_with(directory.path(), "inspector", |path| {
            trashed = Some(path.to_path_buf());
            fs::remove_dir_all(path).map_err(|error| error.to_string())
        })
        .unwrap();

        assert_eq!(trashed, Some(directory.path().join("inspector")));
        assert!(!catalog
            .apps
            .iter()
            .any(|app| app.definition.id == "inspector"));
        assert!(
            trash_local_app_with(directory.path(), "scratch", |_| Ok(()))
                .unwrap_err()
                .contains("Built-in")
        );
    }
}
