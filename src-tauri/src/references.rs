use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CslName {
    pub family: Option<String>,
    pub given: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CslDate {
    #[serde(rename = "date-parts", default)]
    pub date_parts: Vec<Vec<i32>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CslEntry {
    #[serde(rename = "type", default)]
    pub entry_type: String,
    #[serde(rename = "_key", default)]
    pub key: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub author: Vec<CslName>,
    #[serde(default)]
    pub issued: Option<CslDate>,
    #[serde(rename = "container-title", default)]
    pub container_title: Option<String>,
    #[serde(default)]
    pub volume: Option<String>,
    #[serde(default)]
    pub issue: Option<String>,
    #[serde(default)]
    pub page: Option<String>,
    #[serde(rename = "DOI", default)]
    pub doi: Option<String>,
    #[serde(rename = "URL", default)]
    pub url: Option<String>,
    // Allow additional fields to pass through
    #[serde(flatten)]
    pub extra: serde_json::Value,
}

fn refs_dir() -> Result<std::path::PathBuf, String> {
    // Use the same data_dir pattern as ai_keys.rs
    let base = dirs::data_dir()
        .or_else(|| dirs::home_dir().map(|h| h.join(".local/share")))
        .ok_or("Could not determine data directory")?;
    let dir = base.join("shoulders-v3").join("references");
    Ok(dir)
}

fn library_path() -> Result<std::path::PathBuf, String> {
    Ok(refs_dir()?.join("library.json"))
}

fn read_library() -> Result<Vec<CslEntry>, String> {
    let path = library_path()?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let content =
        std::fs::read_to_string(&path).map_err(|e| format!("Could not read library: {}", e))?;
    serde_json::from_str(&content).map_err(|e| format!("Could not parse library: {}", e))
}

fn write_library(entries: &[CslEntry]) -> Result<(), String> {
    let path = library_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Could not create refs dir: {}", e))?;
    }
    let json = serde_json::to_string_pretty(entries)
        .map_err(|e| format!("Could not serialize library: {}", e))?;
    std::fs::write(&path, json).map_err(|e| format!("Could not write library: {}", e))
}

/// Generate a cite key from author + year: "smith2023", "smith2023a", etc.
fn generate_key(entry: &CslEntry, existing_keys: &[String]) -> String {
    let last_name = entry
        .author
        .first()
        .and_then(|a| a.family.as_deref())
        .unwrap_or("unknown")
        .to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect::<String>();

    let year = entry
        .issued
        .as_ref()
        .and_then(|d| d.date_parts.first())
        .and_then(|parts| parts.first())
        .map(|y| y.to_string())
        .unwrap_or_default();

    let base = format!("{}{}", last_name, year);
    if base.is_empty() {
        return format!("ref{}", existing_keys.len());
    }

    if !existing_keys.contains(&base) {
        return base;
    }

    // Add suffix: a, b, c, ...
    for suffix in b'a'..=b'z' {
        let candidate = format!("{}{}", base, suffix as char);
        if !existing_keys.contains(&candidate) {
            return candidate;
        }
    }

    format!("{}{}", base, existing_keys.len())
}

#[tauri::command]
pub fn ref_dir() -> Result<String, String> {
    let dir = refs_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create refs dir: {}", e))?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn ref_list() -> Result<Vec<CslEntry>, String> {
    read_library()
}

#[tauri::command]
pub fn ref_add(mut entry: CslEntry) -> Result<Vec<CslEntry>, String> {
    let mut library = read_library()?;
    let existing_keys: Vec<String> = library.iter().map(|e| e.key.clone()).collect();

    if entry.key.is_empty() {
        entry.key = generate_key(&entry, &existing_keys);
    }

    // Check for duplicate key
    if existing_keys.contains(&entry.key) {
        return Err(format!("Reference with key '{}' already exists", entry.key));
    }

    library.push(entry);
    write_library(&library)?;
    Ok(library)
}

#[tauri::command]
pub fn ref_remove(key: String) -> Result<Vec<CslEntry>, String> {
    let mut library = read_library()?;
    library.retain(|e| e.key != key);
    write_library(&library)?;
    Ok(library)
}

#[tauri::command]
pub fn ref_update(entry: CslEntry) -> Result<Vec<CslEntry>, String> {
    let mut library = read_library()?;
    if let Some(existing) = library.iter_mut().find(|e| e.key == entry.key) {
        *existing = entry;
    } else {
        return Err(format!("Reference with key '{}' not found", entry.key));
    }
    write_library(&library)?;
    Ok(library)
}
