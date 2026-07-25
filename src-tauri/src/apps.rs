use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    path::{Component, Path, PathBuf},
    time::Duration,
};

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
        .map(|home| home.join(".mim").join("apps"))
        .ok_or_else(|| "Could not resolve the home directory for apps.".to_string())
}

pub fn builtin_apps() -> Vec<InstalledApp> {
    vec![
        InstalledApp {
            definition: AppDefinition {
                id: "changes".into(),
                title: "Changes".into(),
                description: "Review the workspace's current Git changes.".into(),
                mode: AppMode::RustHelper,
                entry: None,
                command: None,
                args: Vec::new(),
                env: BTreeMap::new(),
                preset: None,
                helper: Some("git-changes".into()),
                action_tool: None,
                launch_only: false,
                tools: Vec::new(),
            },
            directory: "builtin".into(),
            manifest_path: "builtin:changes".into(),
            builtin: true,
        },
        InstalledApp {
            definition: AppDefinition {
                id: "scratch".into(),
                title: "Scratch".into(),
                description: "A fast workspace scratchpad with a live MCP tool.".into(),
                mode: AppMode::Embedded,
                entry: Some("mim://builtin/scratch".into()),
                command: None,
                args: Vec::new(),
                env: BTreeMap::new(),
                preset: None,
                helper: None,
                action_tool: None,
                launch_only: false,
                tools: vec![AppToolDefinition {
                    name: "read".into(),
                    description: "Read the current Scratch app text.".into(),
                    input_schema: empty_object(),
                    mcp_alias: Some("scratch_read".into()),
                }],
            },
            directory: "builtin".into(),
            manifest_path: "builtin:scratch".into(),
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
    if entry.starts_with("mim://") || entry.starts_with("http://") || entry.starts_with("https://")
    {
        return Ok(entry.into());
    }
    let path = Path::new(&app.directory).join(entry);
    path.canonicalize()
        .map(|path| format!("file://{}", path.to_string_lossy()))
        .map_err(|error| format!("Could not resolve app entry '{}': {error}", path.display()))
}

fn validate_entry(entry: &str, app_directory: &Path) -> Result<(), String> {
    if entry.starts_with("mim://") || entry.starts_with("http://") || entry.starts_with("https://")
    {
        return Ok(());
    }
    let path = Path::new(entry);
    if path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_)))
    {
        return Err("Entry must be an app-relative path or an http(s)/mim URL.".into());
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
    include_str!("../../src/apps/sdk/mim-sdk.js")
}

fn theme_css_content() -> &'static str {
    include_str!("../../src/apps/sdk/theme-base.css")
}

pub fn serve_app_file(request: tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    let path = request.uri().path().trim_start_matches('/');
    if path == "_sdk/mim-sdk.js" || path.ends_with("/_sdk/mim-sdk.js") {
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
    let sdk =
        r#"<link rel="stylesheet" href="/_sdk/theme.css"><script src="/_sdk/mim-sdk.js"></script>"#;
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
    tauri::async_runtime::spawn_blocking(move || load_catalog(&directory))
        .await
        .map_err(|error| format!("App catalog task failed: {error}"))
}

#[tauri::command]
pub async fn app_resolve(
    app_id: String,
    workspace_path: Option<String>,
) -> Result<ResolvedAppLaunch, String> {
    let directory = default_apps_dir()?;
    tauri::async_runtime::spawn_blocking(move || {
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
        .join(".mim")
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
        assert_eq!(catalog.apps.len(), 3);
        assert!(catalog
            .apps
            .iter()
            .any(|app| app.definition.id == "changes" && app.builtin));
        assert!(catalog
            .apps
            .iter()
            .any(|app| app.definition.id == "inspector" && !app.builtin));
        assert!(catalog.diagnostics.is_empty());
    }

    #[test]
    fn manifests_cannot_shadow_builtin_ids() {
        let directory = tempdir().unwrap();
        write_embedded_app(directory.path(), "changes", "Shadow");
        let catalog = load_catalog(directory.path());
        assert_eq!(
            catalog
                .apps
                .iter()
                .filter(|app| app.definition.id == "changes")
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
                Some("git-changes"),
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
    fn tool_definitions_require_unique_names_and_object_schemas() {
        let mut definition = builtin_apps()[1].definition.clone();
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
}
