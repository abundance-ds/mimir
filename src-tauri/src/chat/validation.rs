use super::*;

pub(super) fn normalize_body(value: &str) -> Result<String, String> {
    let value = value.replace("\r\n", "\n").replace('\r', "\n");
    let value = value.trim_end_matches('\n').to_string();
    if value.trim().is_empty() {
        return Err("Message cannot be empty.".into());
    }
    if value.len() > MAX_MESSAGE_BYTES {
        return Err(format!(
            "Message is too long; keep it below {MAX_MESSAGE_BYTES} UTF-8 bytes."
        ));
    }
    Ok(value)
}

pub(super) fn normalize_reaction(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 32
        || value.chars().any(char::is_control)
        || value.contains(char::is_whitespace)
    {
        return Err("A reaction must be one emoji or short token.".into());
    }
    Ok(value.to_string())
}

pub(super) fn mentions_account(body: &str, account: &str) -> bool {
    let expected = account.to_lowercase();
    body.split(|character: char| {
        !(character.is_ascii_alphanumeric() || "-_[]{}^`@".contains(character))
    })
    .any(|word| {
        word.strip_prefix('@')
            .is_some_and(|value| value.eq_ignore_ascii_case(&expected))
    })
}

pub(super) fn normalize_target(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.starts_with(['#', '&']) {
        normalize_channel(value)
    } else {
        normalize_nick(value)
    }
}

pub(super) fn normalize_channel(value: &str) -> Result<String, String> {
    let value = value.trim();
    let value = if value.starts_with(['#', '&']) {
        value.to_string()
    } else {
        format!("#{value}")
    };
    if value.len() < 2
        || value.len() > 64
        || !value
            .chars()
            .skip(1)
            .all(|character| character.is_ascii_alphanumeric() || "-_.".contains(character))
    {
        return Err(
            "Channel names may contain letters, numbers, dashes, underscores, and dots.".into(),
        );
    }
    Ok(value.to_lowercase())
}

pub(super) fn normalize_nick(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 32
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-_[]{}^`".contains(character))
    {
        return Err("Invalid chat account or direct-message target.".into());
    }
    Ok(value.to_lowercase())
}

pub(super) fn validate_message_id(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 256
        || value
            .chars()
            .any(|character| character.is_whitespace() || character == ';')
    {
        return Err("Invalid reply message ID.".into());
    }
    Ok(value.to_string())
}

pub(super) fn clean_irc_parameter(value: &str) -> String {
    value.replace(['\r', '\n', '\0'], " ").trim().to_string()
}

pub(super) fn normalize_agent_label(value: &str) -> String {
    let label: String = value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || "-_".contains(*character))
        .take(16)
        .collect();
    if label.is_empty() {
        "agent".into()
    } else {
        label.to_lowercase()
    }
}

pub(super) fn has_tag(message: &IrcMessage, name: &str) -> bool {
    message
        .tags
        .as_ref()
        .is_some_and(|tags| tags.iter().any(|tag| tag.0 == name))
}

pub(super) fn tag(message: &IrcMessage, name: &str) -> Option<String> {
    message
        .tags
        .as_ref()?
        .iter()
        .find_map(|tag| if tag.0 == name { tag.1.clone() } else { None })
}

pub(super) fn has_unknown_numeric_command(line: &str) -> bool {
    let command = if line.starts_with(':') {
        line.split_whitespace().nth(1)
    } else {
        line.split_whitespace().next()
    };
    command.is_some_and(|value| value.len() == 3 && value.chars().all(|c| c.is_ascii_digit()))
}

pub(super) fn synthetic_message_id(target: &str, time: &str, sender: &str, body: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(target);
    hash.update([0]);
    hash.update(time);
    hash.update([0]);
    hash.update(sender);
    hash.update([0]);
    hash.update(body);
    format!("local-{:x}", hash.finalize())[..30].to_string()
}

pub(super) fn timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub(super) fn validate_config(config: &ChatConfig) -> Result<(), String> {
    let endpoint =
        Url::parse(&config.endpoint).map_err(|_| "Invalid chat endpoint.".to_string())?;
    match endpoint.scheme() {
        "wss" => {}
        "ws" if endpoint
            .host_str()
            .is_some_and(|host| host == "localhost" || host == "127.0.0.1" || host == "::1") => {}
        _ => return Err("Chat endpoint must use wss://, except for localhost development.".into()),
    }
    normalize_nick(&config.account)?;
    if config.display_name.chars().count() > 80 {
        return Err("Display name is too long.".into());
    }
    Ok(())
}

pub(super) fn websocket_origin(endpoint: &str) -> Result<String, String> {
    let url = Url::parse(endpoint).map_err(|error| error.to_string())?;
    let scheme = if url.scheme() == "wss" {
        "https"
    } else {
        "http"
    };
    let host = url
        .host_str()
        .ok_or_else(|| "Chat endpoint has no host.".to_string())?;
    let port = url
        .port()
        .map(|port| format!(":{port}"))
        .unwrap_or_default();
    Ok(format!("{scheme}://{host}{port}"))
}

#[cfg(all(target_os = "macos", not(debug_assertions)))]
pub(super) fn store_credential(
    _path: &std::path::Path,
    config: &ChatConfig,
    password: &str,
) -> Result<(), String> {
    use security_framework::os::macos::keychain::SecKeychain;

    SecKeychain::default()
        .map_err(|error| error.to_string())?
        .set_generic_password(
            KEYCHAIN_SERVICE,
            &credential_key(config),
            password.as_bytes(),
        )
        .map_err(|error| error.to_string())
}

#[cfg(all(target_os = "macos", not(debug_assertions)))]
pub(super) fn load_credential(
    _path: &std::path::Path,
    config: &ChatConfig,
) -> Result<Option<String>, String> {
    use security_framework::os::macos::keychain::SecKeychain;

    let keychain = SecKeychain::default().map_err(|error| error.to_string())?;
    match keychain.find_generic_password(KEYCHAIN_SERVICE, &credential_key(config)) {
        Ok((password, _)) => String::from_utf8(password.to_vec())
            .map(Some)
            .map_err(|_| "The saved chat passphrase is not valid UTF-8.".to_string()),
        Err(error) if error.code() == -25300 => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(any(not(target_os = "macos"), debug_assertions))]
pub(super) fn store_credential(
    path: &std::path::Path,
    config: &ChatConfig,
    password: &str,
) -> Result<(), String> {
    let value = serde_json::to_vec(&json!({
        "credentialKey": credential_key(config),
        "password": password,
    }))
    .map_err(|error| error.to_string())?;
    crate::persistence::write_secret_bytes_atomic(path, &value).map_err(|error| error.to_string())
}

#[cfg(any(not(target_os = "macos"), debug_assertions))]
pub(super) fn load_credential(
    path: &std::path::Path,
    config: &ChatConfig,
) -> Result<Option<String>, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let value: Value = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    if value.get("credentialKey").and_then(Value::as_str) != Some(credential_key(config).as_str()) {
        return Ok(None);
    }
    Ok(value
        .get("password")
        .and_then(Value::as_str)
        .map(str::to_string))
}

pub(super) fn credential_key(config: &ChatConfig) -> String {
    let host = Url::parse(&config.endpoint)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .unwrap_or_else(|| "chat".into());
    format!("chat:{}@{host}", config.account.to_lowercase())
}

pub(super) fn read_config_at(path: &std::path::Path) -> Result<Option<ChatConfig>, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|error| format!("Invalid chat configuration: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

pub(super) fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(super) fn read_lock<T>(lock: &RwLock<T>) -> std::sync::RwLockReadGuard<'_, T> {
    lock.read().unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(super) fn write_lock<T>(lock: &RwLock<T>) -> std::sync::RwLockWriteGuard<'_, T> {
    lock.write()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
