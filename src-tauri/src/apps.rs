use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppManifest {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub icon: String,
    #[serde(default = "default_width")]
    pub width: f64,
    #[serde(default = "default_height")]
    pub height: f64,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default = "default_ui")]
    pub ui: String,
    #[serde(default)]
    pub setup: Option<serde_json::Value>,
}

fn default_width() -> f64 {
    800.0
}
fn default_height() -> f64 {
    600.0
}
fn default_ui() -> String {
    "custom".to_string()
}

fn home_dir() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| "No home directory found".to_string())
}

fn apps_dir() -> Result<PathBuf, String> {
    Ok(home_dir()?.join(".shoulders-v3").join("apps"))
}

fn app_dir(app_id: &str) -> Result<PathBuf, String> {
    Ok(apps_dir()?.join(app_id))
}

fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 60 {
        return Err("ID must be 1-60 characters".to_string());
    }
    if id.contains("..") || id.contains('/') || id.contains('\\') {
        return Err("ID contains invalid characters".to_string());
    }
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("ID must be alphanumeric with hyphens only".to_string());
    }
    Ok(())
}

fn validate_path(path: &str) -> Result<(), String> {
    if path.is_empty() || path.contains("..") || path.starts_with('/') || path.starts_with('\\') {
        return Err(format!("Invalid path: {}", path));
    }
    Ok(())
}

// --- Protocol handler ---

fn inject_sdk(html: &str) -> String {
    let sdk_tags = "<link rel=\"stylesheet\" href=\"/_sdk/theme.css\"><script src=\"/_sdk/shoulders-sdk.js\"></script>";
    if let Some(pos) = html.find("</head>") {
        format!("{}{}{}", &html[..pos], sdk_tags, &html[pos..])
    } else if let Some(pos) = html.find("<body") {
        format!("{}{}{}", &html[..pos], sdk_tags, &html[pos..])
    } else {
        format!("{}{}", sdk_tags, html)
    }
}

fn sdk_js_content() -> &'static str {
    include_str!("../../src/apps/sdk/shoulders-sdk.js")
}

fn theme_css_content() -> &'static str {
    include_str!("../../src/apps/sdk/theme-base.css")
}

pub fn serve_app_file(request: tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    let path = request.uri().path().trim_start_matches('/');

    if path.contains("..") {
        return tauri::http::Response::builder()
            .status(403)
            .body(b"Forbidden".to_vec())
            .unwrap();
    }

    // SDK virtual routes
    if path == "_sdk/shoulders-sdk.js" || path.ends_with("/_sdk/shoulders-sdk.js") {
        return tauri::http::Response::builder()
            .status(200)
            .header("Content-Type", "application/javascript")
            .header("Access-Control-Allow-Origin", "*")
            .body(sdk_js_content().as_bytes().to_vec())
            .unwrap();
    }
    if path == "_sdk/theme.css" || path.ends_with("/_sdk/theme.css") {
        return tauri::http::Response::builder()
            .status(200)
            .header("Content-Type", "text/css")
            .header("Access-Control-Allow-Origin", "*")
            .body(theme_css_content().as_bytes().to_vec())
            .unwrap();
    }

    // Parse: {appId}/{filepath...}
    let parts: Vec<&str> = path.splitn(2, '/').collect();
    if parts.len() < 2 {
        return tauri::http::Response::builder()
            .status(404)
            .body(b"Not found: need appId/path".to_vec())
            .unwrap();
    }

    let app_id = parts[0];
    let file_path = parts[1];

    if file_path.is_empty() {
        return tauri::http::Response::builder()
            .status(404)
            .body(b"No file path specified".to_vec())
            .unwrap();
    }

    let home = match home_dir() {
        Ok(h) => h,
        Err(_) => {
            return tauri::http::Response::builder()
                .status(500)
                .body(b"No home dir".to_vec())
                .unwrap();
        }
    };

    let full_path = home
        .join(".shoulders-v3")
        .join("apps")
        .join(app_id)
        .join(file_path);

    match fs::read(&full_path) {
        Ok(content) => {
            let mime = match file_path.rsplit('.').next().unwrap_or("") {
                "html" => "text/html",
                "js" | "mjs" => "application/javascript",
                "css" => "text/css",
                "json" => "application/json",
                "svg" => "image/svg+xml",
                "png" => "image/png",
                "jpg" | "jpeg" => "image/jpeg",
                "woff2" => "font/woff2",
                _ => "application/octet-stream",
            };

            // Inject SDK into index.html
            let body = if file_path == "index.html" || file_path.ends_with("/index.html") {
                let html = String::from_utf8_lossy(&content);
                inject_sdk(&html).into_bytes()
            } else {
                content
            };

            tauri::http::Response::builder()
                .status(200)
                .header("Content-Type", mime)
                .header("Access-Control-Allow-Origin", "*")
                .body(body)
                .unwrap()
        }
        Err(_) => tauri::http::Response::builder()
            .status(404)
            .body(format!("Not found: {}", file_path).into_bytes())
            .unwrap(),
    }
}

// --- Commands ---

#[tauri::command]
pub fn app_discover() -> Result<Vec<AppManifest>, String> {
    let dir = apps_dir()?;
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut apps = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            let manifest_path = entry.path().join("manifest.json");
            if let Ok(content) = fs::read_to_string(&manifest_path) {
                if let Ok(manifest) = serde_json::from_str::<AppManifest>(&content) {
                    apps.push(manifest);
                }
            }
        }
    }
    apps.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(apps)
}

#[tauri::command]
pub fn app_create(app_id: String, manifest_json: String) -> Result<String, String> {
    validate_id(&app_id)?;
    let dir = app_dir(&app_id)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let manifest_path = dir.join("manifest.json");
    fs::write(&manifest_path, &manifest_json).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn app_write_file(app_id: String, path: String, content: String) -> Result<(), String> {
    validate_id(&app_id)?;
    validate_path(&path)?;
    let file_path = app_dir(&app_id)?.join(&path);
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&file_path, &content).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn app_delete(app_id: String) -> Result<(), String> {
    validate_id(&app_id)?;
    let dir = app_dir(&app_id)?;
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn app_open_window(
    app: tauri::AppHandle,
    app_id: String,
    title: String,
    width: f64,
    height: f64,
) -> Result<String, String> {
    validate_id(&app_id)?;
    let label = format!(
        "app-{}-{}",
        app_id,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    );
    let url = format!("app://localhost/{}/index.html", app_id);

    let mut builder = tauri::WebviewWindowBuilder::new(
        &app,
        &label,
        tauri::WebviewUrl::External(url.parse().map_err(|e: url::ParseError| e.to_string())?),
    )
    .title(&title)
    .inner_size(width, height)
    .min_inner_size(400.0, 300.0)
    .center()
    .decorations(true);

    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true);
    }

    builder.build().map_err(|e| e.to_string())?;

    Ok(label)
}

#[tauri::command]
pub fn app_data_load(
    app_id: String,
    project_id: String,
    key: String,
) -> Result<Option<String>, String> {
    validate_id(&app_id)?;
    validate_path(&project_id)?;
    validate_path(&key)?;
    let file_path = app_dir(&app_id)?
        .join("data")
        .join(&project_id)
        .join(format!("{}.json", key));
    if file_path.exists() {
        let content = fs::read_to_string(&file_path).map_err(|e| e.to_string())?;
        Ok(Some(content))
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub fn app_data_save(
    app_id: String,
    project_id: String,
    key: String,
    value: String,
) -> Result<(), String> {
    validate_id(&app_id)?;
    validate_path(&project_id)?;
    validate_path(&key)?;
    let data_dir = app_dir(&app_id)?.join("data").join(&project_id);
    fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let file_path = data_dir.join(format!("{}.json", key));
    fs::write(&file_path, &value).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn app_data_delete(app_id: String, project_id: String, key: String) -> Result<(), String> {
    validate_id(&app_id)?;
    validate_path(&project_id)?;
    validate_path(&key)?;
    let file_path = app_dir(&app_id)?
        .join("data")
        .join(&project_id)
        .join(format!("{}.json", key));
    if file_path.exists() {
        fs::remove_file(&file_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn app_data_keys(app_id: String, project_id: String) -> Result<Vec<String>, String> {
    validate_id(&app_id)?;
    validate_path(&project_id)?;
    let data_dir = app_dir(&app_id)?.join("data").join(&project_id);
    if !data_dir.exists() {
        return Ok(Vec::new());
    }
    let mut keys = Vec::new();
    let entries = fs::read_dir(&data_dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        if let Some(name) = entry.file_name().to_str() {
            if name.ends_with(".json") {
                keys.push(name.trim_end_matches(".json").to_string());
            }
        }
    }
    keys.sort();
    Ok(keys)
}

fn load_manifest(app_id: &str) -> Result<AppManifest, String> {
    validate_id(app_id)?;
    let manifest_path = app_dir(app_id)?.join("manifest.json");
    let content = fs::read_to_string(&manifest_path)
        .map_err(|e| format!("Cannot read manifest for '{}': {}", app_id, e))?;
    serde_json::from_str(&content).map_err(|e| format!("Invalid manifest for '{}': {}", app_id, e))
}

fn check_http_permission(manifest: &AppManifest, url: &url::Url) -> Result<(), String> {
    let http_permissions: Vec<&str> = manifest
        .permissions
        .iter()
        .filter_map(|p| p.strip_prefix("http:"))
        .collect();

    if http_permissions.is_empty() {
        return Err(format!(
            "App '{}' has no HTTP permissions. Add \"http:{{host}}\" to the permissions array in manifest.json",
            manifest.id
        ));
    }

    if http_permissions.contains(&"*") {
        return Ok(());
    }

    let host = url.host_str().unwrap_or("");
    for domain in &http_permissions {
        if host == *domain || host.ends_with(&format!(".{}", domain)) {
            return Ok(());
        }
    }

    Err(format!(
        "App '{}' cannot access '{}'. Add \"http:{}\" to permissions in manifest.json. Declared: {:?}",
        manifest.id, host, host, http_permissions
    ))
}

#[derive(Debug, Serialize, Deserialize)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: String,
}

#[tauri::command]
pub async fn app_http_request(
    app: tauri::AppHandle,
    app_id: String,
    url: String,
    method: Option<String>,
    headers: Option<HashMap<String, String>>,
    body: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<HttpResponse, String> {
    validate_id(&app_id)?;

    let parsed_url = url::Url::parse(&url).map_err(|e| format!("Invalid URL: {}", e))?;
    match parsed_url.scheme() {
        "http" | "https" => {}
        scheme => {
            return Err(format!(
                "Unsupported scheme '{}'. Only http and https are allowed.",
                scheme
            ))
        }
    }

    let manifest = load_manifest(&app_id)?;
    check_http_permission(&manifest, &parsed_url)?;

    let timeout = timeout_ms.unwrap_or(30000).min(120000);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(timeout))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let method_str = method.as_deref().unwrap_or("GET");
    let reqwest_method = reqwest::Method::from_bytes(method_str.as_bytes())
        .map_err(|_| format!("Invalid HTTP method: {}", method_str))?;

    let mut request = client.request(reqwest_method.clone(), parsed_url);

    if let Some(hdrs) = &headers {
        for (k, v) in hdrs {
            request = request.header(k.as_str(), v.as_str());
        }
    }

    if let Some(b) = &body {
        request = request.body(b.clone());
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {}", e))?;

    let status = response.status().as_u16();
    let response_headers: HashMap<String, String> = response
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;
    if bytes.len() > 10 * 1024 * 1024 {
        return Err("Response exceeds 10MB limit".to_string());
    }
    let response_body = String::from_utf8_lossy(&bytes).into_owned();

    let audit_state = app.state::<crate::audit::AuditDbState>();
    let _ = crate::audit::audit_log_internal(
        &audit_state,
        "app.http_request",
        None,
        None,
        Some(format!("app:{}", &app_id)),
        Some(
            serde_json::json!({
                "appId": &app_id,
                "url": &url,
                "method": method_str,
                "status": status,
            })
            .to_string(),
        ),
    );

    Ok(HttpResponse {
        status,
        headers: response_headers,
        body: response_body,
    })
}
