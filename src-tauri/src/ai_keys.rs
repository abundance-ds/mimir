#[cfg(debug_assertions)]
use crate::ai_models::ensure_config_dir;
use crate::ai_models::{AiProviderConfig, ModelRegistry};
use serde::Serialize;
#[cfg(debug_assertions)]
use std::{collections::HashMap, fs, path::PathBuf};

const KEYRING_SERVICE: &str = "com.shoulders.v3";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiKeyStatus {
    pub provider: String,
    pub key_env: String,
    pub configured: bool,
    pub source: Option<String>,
}

pub fn resolve_api_key(provider: &AiProviderConfig) -> Result<(String, String), String> {
    if let Some(value) = read_keyring(&provider.api_key_env)? {
        return Ok((value, "keychain".to_string()));
    }

    if let Ok(value) = std::env::var(&provider.api_key_env) {
        if !value.trim().is_empty() {
            return Ok((value, "env".to_string()));
        }
    }

    #[cfg(debug_assertions)]
    {
        let dotenv_keys = load_dotenv_keys().unwrap_or_default();
        if let Some(value) = dotenv_keys.get(&provider.api_key_env) {
            if !value.trim().is_empty() {
                return Ok((value.to_string(), ".env".to_string()));
            }
        }

        let file_keys = load_file_keys()?;
        if let Some(value) = file_keys.get(&provider.api_key_env) {
            if !value.trim().is_empty() {
                return Ok((value.to_string(), "file".to_string()));
            }
        }
    }

    Err(format!(
        "No API key configured for {}",
        provider.api_key_env
    ))
}

pub fn key_status(registry: &ModelRegistry) -> Vec<AiKeyStatus> {
    #[cfg(debug_assertions)]
    let file_keys = load_file_keys().unwrap_or_default();
    #[cfg(debug_assertions)]
    let dotenv_keys = load_dotenv_keys().unwrap_or_default();

    registry
        .providers
        .iter()
        .map(|(provider, config)| {
            let (configured, source) = match read_keyring(&config.api_key_env) {
                Ok(Some(_)) => (true, Some("keychain".to_string())),
                _ if std::env::var(&config.api_key_env)
                    .map(|v| !v.trim().is_empty())
                    .unwrap_or(false) =>
                {
                    (true, Some("env".to_string()))
                }
                #[cfg(debug_assertions)]
                _ if dotenv_keys
                    .get(&config.api_key_env)
                    .map(|v| !v.trim().is_empty())
                    .unwrap_or(false) =>
                {
                    (true, Some(".env".to_string()))
                }
                #[cfg(debug_assertions)]
                _ if file_keys
                    .get(&config.api_key_env)
                    .map(|v| !v.trim().is_empty())
                    .unwrap_or(false) =>
                {
                    (true, Some("file".to_string()))
                }
                _ => (false, None),
            };

            AiKeyStatus {
                provider: provider.clone(),
                key_env: config.api_key_env.clone(),
                configured,
                source,
            }
        })
        .collect()
}

pub fn set_api_key(
    registry: &ModelRegistry,
    provider: &str,
    value: String,
) -> Result<AiKeyStatus, String> {
    let config = registry
        .providers
        .get(provider)
        .ok_or_else(|| format!("Unknown provider: {}", provider))?;
    let trimmed = value.trim().to_string();

    if trimmed.is_empty() {
        let _ = delete_keyring(&config.api_key_env);
        #[cfg(debug_assertions)]
        {
            let mut file_keys = load_file_keys().unwrap_or_default();
            file_keys.remove(&config.api_key_env);
            save_file_keys(&file_keys)?;
        }
        return Ok(AiKeyStatus {
            provider: provider.to_string(),
            key_env: config.api_key_env.clone(),
            configured: false,
            source: None,
        });
    }

    match write_keyring(&config.api_key_env, &trimmed) {
        Ok(()) => Ok(AiKeyStatus {
            provider: provider.to_string(),
            key_env: config.api_key_env.clone(),
            configured: true,
            source: Some("keychain".to_string()),
        }),
        Err(_) => {
            #[cfg(debug_assertions)]
            {
                let mut file_keys = load_file_keys().unwrap_or_default();
                file_keys.insert(config.api_key_env.clone(), trimmed);
                save_file_keys(&file_keys)?;
                return Ok(AiKeyStatus {
                    provider: provider.to_string(),
                    key_env: config.api_key_env.clone(),
                    configured: true,
                    source: Some("file".to_string()),
                });
            }
            #[cfg(not(debug_assertions))]
            {
                Err(
                    "OS keychain is unavailable; refusing to store API key in plaintext"
                        .to_string(),
                )
            }
        }
    }
}

fn read_keyring(key: &str) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, key).map_err(|err| err.to_string())?;
    match entry.get_password() {
        Ok(value) if !value.trim().is_empty() => Ok(Some(value)),
        Ok(_) => Ok(None),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(err.to_string()),
    }
}

fn write_keyring(key: &str, value: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, key).map_err(|err| err.to_string())?;
    entry.set_password(value).map_err(|err| err.to_string())
}

fn delete_keyring(key: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, key).map_err(|err| err.to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(err.to_string()),
    }
}

#[cfg(debug_assertions)]
fn load_dotenv_keys() -> Result<HashMap<String, String>, String> {
    let mut keys = HashMap::new();
    for path in dotenv_candidates()? {
        if !path.exists() {
            continue;
        }
        for (key, value) in parse_env_file(&path)? {
            keys.entry(key).or_insert(value);
        }
    }
    Ok(keys)
}

#[cfg(debug_assertions)]
fn dotenv_candidates() -> Result<Vec<PathBuf>, String> {
    let cwd = std::env::current_dir().map_err(|err| err.to_string())?;
    let mut candidates = vec![cwd.join(".env")];
    if let Some(parent) = cwd.parent() {
        candidates.push(parent.join(".env"));
        if let Some(grandparent) = parent.parent() {
            candidates.push(grandparent.join(".env"));
        }
    }
    Ok(candidates)
}

#[cfg(debug_assertions)]
fn load_file_keys() -> Result<HashMap<String, String>, String> {
    let path = ensure_config_dir()?.join("keys.env");
    if !path.exists() {
        return Ok(HashMap::new());
    }

    let content = fs::read_to_string(&path)
        .map_err(|err| format!("Could not read {}: {}", path.display(), err))?;
    parse_env_content(&content)
}

#[cfg(debug_assertions)]
fn parse_env_file(path: &PathBuf) -> Result<HashMap<String, String>, String> {
    let content = fs::read_to_string(path)
        .map_err(|err| format!("Could not read {}: {}", path.display(), err))?;
    parse_env_content(&content)
}

#[cfg(debug_assertions)]
fn parse_env_content(content: &str) -> Result<HashMap<String, String>, String> {
    let mut keys = HashMap::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some((key, value)) = trimmed.split_once('=') {
            keys.insert(key.trim().to_string(), unquote_env_value(value.trim()));
        }
    }
    Ok(keys)
}

#[cfg(debug_assertions)]
fn unquote_env_value(value: &str) -> String {
    let bytes = value.as_bytes();
    if bytes.len() >= 2
        && ((bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"')
            || (bytes[0] == b'\'' && bytes[bytes.len() - 1] == b'\''))
    {
        value[1..value.len() - 1].to_string()
    } else {
        value.to_string()
    }
}

#[cfg(debug_assertions)]
fn save_file_keys(keys: &HashMap<String, String>) -> Result<(), String> {
    let path = ensure_config_dir()?.join("keys.env");
    let mut rows: Vec<_> = keys.iter().collect();
    rows.sort_by(|a, b| a.0.cmp(b.0));
    let content = rows
        .into_iter()
        .map(|(key, value)| format!("{}={}", key, value))
        .collect::<Vec<_>>()
        .join("\n");
    fs::write(
        &path,
        if content.is_empty() {
            content
        } else {
            format!("{}\n", content)
        },
    )
    .map_err(|err| format!("Could not write {}: {}", path.display(), err))
}
