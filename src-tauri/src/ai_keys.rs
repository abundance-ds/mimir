#[cfg(debug_assertions)]
use crate::ai_models::ensure_config_dir;
use crate::ai_models::{AiProviderConfig, ModelRegistry};
#[cfg(debug_assertions)]
use crate::persistence::write_secret_bytes_atomic;
use serde::Serialize;
#[cfg(debug_assertions)]
use std::{collections::HashMap, fs, path::PathBuf};

const KEYRING_SERVICE: &str = "rs.shoulde.mimir";

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
                Ok(AiKeyStatus {
                    provider: provider.to_string(),
                    key_env: config.api_key_env.clone(),
                    configured: true,
                    source: Some("file".to_string()),
                })
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
    let content = if content.is_empty() {
        content
    } else {
        format!("{}\n", content)
    };
    write_secret_bytes_atomic(&path, content.as_bytes())
        .map_err(|err| format!("Could not write {}: {}", path.display(), err))
}

// NOTE: resolve_api_key, key_status, and set_api_key are intentionally not
// covered here: each one calls into the OS keychain (read_keyring /
// write_keyring) before any other source is consulted, and there is no seam
// to stub that out without changing behavior. Tests must not touch the real
// keychain, so only the pure parsing/path layers below are exercised.
//
// The debug-only file sources are all #[cfg(debug_assertions)], so this test
// module is too; `cargo test` builds with debug assertions by default.
#[cfg(all(test, debug_assertions))]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::sync::{Mutex, MutexGuard};

    // Serializes tests that mutate process-global environment variables.
    // (The repo has no serial-test dependency; a shared mutex is the
    // convention-compatible minimal alternative.)
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    struct EnvGuard {
        key: &'static str,
        original: Option<OsString>,
        _lock: MutexGuard<'static, ()>,
    }

    impl EnvGuard {
        fn set(key: &'static str, value: &std::path::Path) -> Self {
            let lock = ENV_LOCK.lock().unwrap_or_else(|poison| poison.into_inner());
            let original = std::env::var_os(key);
            std::env::set_var(key, value);
            Self {
                key,
                original,
                _lock: lock,
            }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match &self.original {
                Some(value) => std::env::set_var(self.key, value),
                None => std::env::remove_var(self.key),
            }
        }
    }

    #[test]
    fn parse_env_content_reads_assignments_and_skips_noise() {
        let content = "\
# comment line
   # indented comment

ANTHROPIC_API_KEY = sk-test-123
OPENAI_API_KEY=\"quoted value\"
GEMINI_API_KEY='single quoted'
INNER_EQUALS=a=b=c
no_equals_sign_line
DUPLICATE=first
DUPLICATE=second
";
        let keys = parse_env_content(content).unwrap();
        assert_eq!(keys.get("ANTHROPIC_API_KEY").unwrap(), "sk-test-123");
        assert_eq!(keys.get("OPENAI_API_KEY").unwrap(), "quoted value");
        assert_eq!(keys.get("GEMINI_API_KEY").unwrap(), "single quoted");
        // Only the first '=' splits; the rest stays in the value.
        assert_eq!(keys.get("INNER_EQUALS").unwrap(), "a=b=c");
        // Within one file, a later duplicate assignment wins (HashMap insert).
        assert_eq!(keys.get("DUPLICATE").unwrap(), "second");
        assert!(!keys.contains_key("no_equals_sign_line"));
        assert_eq!(keys.len(), 5);
    }

    #[test]
    fn unquote_env_value_strips_only_matched_quote_pairs() {
        assert_eq!(unquote_env_value("\"value\""), "value");
        assert_eq!(unquote_env_value("'value'"), "value");
        assert_eq!(unquote_env_value("plain"), "plain");
        // Mismatched quotes are left alone.
        assert_eq!(unquote_env_value("\"value'"), "\"value'");
        // Too short to be a pair.
        assert_eq!(unquote_env_value("\""), "\"");
        assert_eq!(unquote_env_value(""), "");
    }

    #[test]
    fn dotenv_candidates_walk_up_from_the_working_directory() {
        // Read-only with respect to the environment: uses the real cwd.
        let cwd = std::env::current_dir().unwrap();
        let candidates = dotenv_candidates().unwrap();
        assert_eq!(candidates[0], cwd.join(".env"));
        if let Some(parent) = cwd.parent() {
            assert_eq!(candidates[1], parent.join(".env"));
            if let Some(grandparent) = parent.parent() {
                assert_eq!(candidates[2], grandparent.join(".env"));
            }
        }
        assert!(candidates.len() <= 3);
        // Order matters: load_dotenv_keys uses or_insert, so the nearest
        // .env (cwd first) wins for duplicate keys across candidate files.
    }

    #[test]
    fn file_keys_round_trip_through_home_scoped_keys_env() {
        let home = tempfile::tempdir().unwrap();
        let _guard = EnvGuard::set("HOME", home.path());

        // Missing file reads as empty.
        assert!(load_file_keys().unwrap().is_empty());

        let mut keys = HashMap::new();
        keys.insert("B_KEY".to_string(), "beta".to_string());
        keys.insert("A_KEY".to_string(), "alpha value".to_string());
        save_file_keys(&keys).unwrap();

        let path = home.path().join(".mimir").join("keys.env");
        let written = fs::read_to_string(&path).unwrap();
        // Rows are sorted by key and the file ends with a newline.
        assert_eq!(written, "A_KEY=alpha value\nB_KEY=beta\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }

        assert_eq!(load_file_keys().unwrap(), keys);

        // An empty map writes an empty file (no trailing newline).
        save_file_keys(&HashMap::new()).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "");
        assert!(load_file_keys().unwrap().is_empty());
    }
}
