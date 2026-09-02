use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use reqwest::{header::RETRY_AFTER, Client, Method, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::tool_registry::{
    ToolAnnotations, ToolCallContext, ToolDescriptor, ToolError, ToolErrorCode, ToolOwner,
    ToolRegistration, ToolRegistry, ToolResult, ToolSource,
};

mod commands;
mod helpers;
mod oauth;
mod registration;
mod runtime_google;
mod runtime_other;
mod status;

pub use commands::*;
use helpers::*;
pub(crate) use oauth::{open_system_browser, OauthLoopback};
use registration::*;
pub(crate) use status::local_diagnostics;
use status::{
    google_needs_sign_in, google_status, granola_status, slack_needs_sign_in, slack_personal_token,
    slack_status,
};

pub(crate) const MIMIR_KEYCHAIN_SERVICE: &str = "rs.shoulde.mimir";
const DEFAULT_ACCOUNT: &str = "default";
const GOOGLE_ACCOUNTS_KEY: &str = "google:accounts";
const GOOGLE_SCOPES: &str = "openid email profile https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.freebusy https://www.googleapis.com/auth/drive.readonly";
const SLACK_USER_SCOPES: &str = "search:read,channels:read,channels:history,groups:read,groups:history,im:read,im:history,mpim:read,mpim:history,chat:write";
const GRANOLA_API_ROOT: &str = "https://public-api.granola.ai/v1";

#[derive(Clone)]
struct ConnectionRuntime {
    http: Client,
    slack_account: String,
}

#[derive(Clone)]
pub(crate) struct Secret {
    pub(crate) value: String,
}

pub struct ConnectionManager {
    registry: ToolRegistry,
    runtime: ConnectionRuntime,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionAccountStatus {
    id: String,
    label: String,
    detail: Option<String>,
    state: &'static str,
    is_default: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStatus {
    provider: &'static str,
    name: &'static str,
    state: &'static str,
    account: Option<String>,
    accounts: Vec<ConnectionAccountStatus>,
    oauth_available: bool,
    detail: String,
}

impl ConnectionManager {
    pub fn new(registry: ToolRegistry) -> Result<Self, String> {
        Ok(Self {
            registry,
            runtime: ConnectionRuntime {
                http: Client::builder()
                    .timeout(Duration::from_secs(30))
                    .build()
                    .map_err(|error| error.to_string())?,
                slack_account: DEFAULT_ACCOUNT.to_string(),
            },
        })
    }

    pub fn install(&self) -> Result<(), String> {
        for provider in ["google", "slack", "granola"] {
            self.refresh_provider(provider)?;
        }
        Ok(())
    }

    fn refresh_provider(&self, provider: &str) -> Result<(), String> {
        self.registry
            .unregister_owner(&ToolOwner::Provider(provider.to_string()));
        match provider {
            "google" => {
                let store = google_store()?;
                if store
                    .accounts
                    .iter()
                    .any(|account| !google_needs_sign_in(&account.bundle))
                {
                    register_google_tools(&self.registry, &self.runtime, &store)?;
                }
            }
            "slack" => {
                if slack_bundle(DEFAULT_ACCOUNT)?
                    .is_some_and(|bundle| !slack_needs_sign_in(&bundle))
                {
                    register_slack_tools(&self.registry, &self.runtime)?;
                }
            }
            "granola" => {
                if granola_bundle()?.is_some() {
                    register_granola_tools(&self.registry, &self.runtime)?;
                }
            }
            _ => return Err(format!("Unknown connection provider: {provider}")),
        }
        Ok(())
    }

    fn statuses(&self) -> Vec<ConnectionStatus> {
        vec![google_status(), slack_status(), granola_status()]
    }
}

#[tauri::command]
pub fn connections_status(manager: tauri::State<'_, ConnectionManager>) -> Vec<ConnectionStatus> {
    manager.statuses()
}

#[derive(Clone, Serialize, Deserialize)]
struct GoogleBundle {
    access_token: String,
    refresh_token: Option<String>,
    expires_at: Option<i64>,
    #[serde(default)]
    scope: String,
    auth: Option<Value>,
}

impl GoogleBundle {
    fn has_any(&self, scopes: &[&str]) -> bool {
        self.scope.trim().is_empty()
            || self
                .scope
                .split_whitespace()
                .any(|granted| scopes.contains(&granted))
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct GoogleAccount {
    id: String,
    email: String,
    name: Option<String>,
    bundle: GoogleBundle,
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct GoogleStore {
    default_account: Option<String>,
    #[serde(default)]
    accounts: Vec<GoogleAccount>,
}

fn google_store() -> Result<GoogleStore, String> {
    if let Some(secret) = read_secret(GOOGLE_ACCOUNTS_KEY)? {
        let mut store: GoogleStore = serde_json::from_str(&secret.value)
            .map_err(|_| "Invalid Google account store.".to_string())?;
        normalize_google_store(&mut store);
        return Ok(store);
    }
    let Some(secret) = read_secret("google:default")? else {
        return Ok(GoogleStore::default());
    };
    let bundle: GoogleBundle = serde_json::from_str(&secret.value)
        .map_err(|_| "Invalid Google token bundle.".to_string())?;
    if bundle.access_token.trim().is_empty() {
        return Err("Invalid Google token bundle.".into());
    }
    let email = bundle
        .auth
        .as_ref()
        .and_then(|auth| auth.get("email"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| DEFAULT_ACCOUNT.into());
    let id = email.to_lowercase();
    Ok(GoogleStore {
        default_account: Some(id.clone()),
        accounts: vec![GoogleAccount {
            id,
            email,
            name: bundle
                .auth
                .as_ref()
                .and_then(|auth| auth.get("name"))
                .and_then(Value::as_str)
                .map(str::to_string),
            bundle,
        }],
    })
}

fn normalize_google_store(store: &mut GoogleStore) {
    let mut seen = std::collections::HashSet::new();
    store.accounts.retain_mut(|account| {
        account.id = account.id.trim().to_lowercase();
        account.email = account.email.trim().to_string();
        !account.id.is_empty()
            && !account.email.is_empty()
            && !account.bundle.access_token.trim().is_empty()
            && seen.insert(account.id.clone())
    });
    if !store.accounts.iter().any(|account| {
        store
            .default_account
            .as_deref()
            .is_some_and(|default| account.id.eq_ignore_ascii_case(default))
    }) {
        store.default_account = store.accounts.first().map(|account| account.id.clone());
    }
    if let Some(default) = store.default_account.as_deref() {
        store
            .accounts
            .sort_by_key(|account| !account.id.eq_ignore_ascii_case(default));
    }
}

fn upsert_google_account(store: &mut GoogleStore, account: GoogleAccount) {
    if let Some(existing) = store
        .accounts
        .iter_mut()
        .find(|existing| existing.id.eq_ignore_ascii_case(&account.id))
    {
        *existing = account;
    } else {
        store.accounts.push(account);
    }
    normalize_google_store(store);
}

fn resolve_google_account<'a>(
    store: &'a GoogleStore,
    selector: Option<&str>,
) -> Result<&'a GoogleAccount, String> {
    let requested = selector.map(str::trim).filter(|value| !value.is_empty());
    let account = if let Some(requested) = requested {
        store.accounts.iter().find(|account| {
            account.id.eq_ignore_ascii_case(requested)
                || account.email.eq_ignore_ascii_case(requested)
        })
    } else {
        store
            .default_account
            .as_deref()
            .and_then(|default| {
                store
                    .accounts
                    .iter()
                    .find(|account| account.id.eq_ignore_ascii_case(default))
            })
            .or_else(|| store.accounts.first())
    };
    account.ok_or_else(|| {
        if let Some(requested) = requested {
            format!("Google account {requested} is not connected.")
        } else {
            "Google is not connected.".into()
        }
    })
}

fn add_google_account_to_result(input: &Value, mut result: Value) -> Result<Value, String> {
    let store = google_store()?;
    let account = resolve_google_account(&store, string(input, "account").as_deref())?;
    if let Some(object) = result.as_object_mut() {
        object.insert("account".into(), Value::String(account.email.clone()));
        Ok(result)
    } else {
        Ok(json!({ "account": account.email, "result": result }))
    }
}

fn write_google_store(store: &GoogleStore) -> Result<(), String> {
    let mut store = store.clone();
    normalize_google_store(&mut store);
    if store.accounts.is_empty() {
        delete_secret(GOOGLE_ACCOUNTS_KEY)?;
        delete_secret("google:default")?;
        return Ok(());
    }
    write_secret(
        MIMIR_KEYCHAIN_SERVICE,
        GOOGLE_ACCOUNTS_KEY,
        &serde_json::to_string(&store).map_err(|error| error.to_string())?,
    )?;
    let _ = delete_secret("google:default");
    Ok(())
}

fn save_google_bundle(account_id: &str, bundle: GoogleBundle) -> Result<(), String> {
    let mut store = google_store()?;
    let account = store
        .accounts
        .iter_mut()
        .find(|account| account.id.eq_ignore_ascii_case(account_id))
        .ok_or_else(|| format!("Google account {account_id} is not connected."))?;
    account.bundle = bundle;
    write_google_store(&store)
}

fn configured_google_client_id() -> Option<String> {
    std::env::var("MIMIR_GOOGLE_OAUTH_CLIENT_ID")
        .ok()
        .or_else(|| option_env!("MIMIR_GOOGLE_OAUTH_CLIENT_ID").map(str::to_string))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn configured_google_client_secret() -> Option<String> {
    std::env::var("MIMIR_GOOGLE_OAUTH_CLIENT_SECRET")
        .ok()
        .or_else(|| option_env!("MIMIR_GOOGLE_OAUTH_CLIENT_SECRET").map(str::to_string))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn configured_slack_client_id() -> Option<String> {
    std::env::var("MIMIR_SLACK_CLIENT_ID")
        .ok()
        .or_else(|| option_env!("MIMIR_SLACK_CLIENT_ID").map(str::to_string))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[derive(Clone)]
struct SlackBundle {
    access_token: String,
    refresh_token: Option<String>,
    account: Option<String>,
    expires_at: Option<i64>,
}

impl SlackBundle {
    fn as_stored(&self) -> Value {
        json!({
            "access_token": self.access_token,
            "refresh_token": self.refresh_token,
            "account": self.account,
            "expires_at": self.expires_at,
        })
    }
}

fn slack_bundle(account: &str) -> Result<Option<SlackBundle>, String> {
    let Some(secret) = read_secret(&format!("slack:{account}"))? else {
        return Ok(None);
    };
    let value: Value = serde_json::from_str(&secret.value)
        .map_err(|_| "Invalid Slack token bundle.".to_string())?;
    Ok(Some(SlackBundle {
        access_token: required_json_string(&value, "access_token")?,
        refresh_token: value
            .get("refresh_token")
            .and_then(Value::as_str)
            .map(str::to_string),
        account: value
            .get("account")
            .and_then(Value::as_str)
            .map(str::to_string),
        expires_at: value.get("expires_at").and_then(Value::as_i64),
    }))
}

fn slack_oauth_optional(value: &Value, key: &str) -> Option<String> {
    value
        .pointer(&format!("/authed_user/{key}"))
        .and_then(Value::as_str)
        .or_else(|| value.get(key).and_then(Value::as_str))
        .map(str::to_string)
}

fn slack_oauth_value(value: &Value, key: &str) -> Result<String, String> {
    slack_oauth_optional(value, key).ok_or_else(|| format!("Slack returned no {key}."))
}

fn slack_oauth_i64(value: &Value, key: &str) -> Option<i64> {
    value
        .pointer(&format!("/authed_user/{key}"))
        .and_then(Value::as_i64)
        .or_else(|| value.get(key).and_then(Value::as_i64))
}

#[derive(Clone)]
struct GranolaBundle {
    api_key: String,
    account: Option<String>,
}

fn granola_bundle() -> Result<Option<GranolaBundle>, String> {
    let Some(secret) = read_secret("granola:default")? else {
        return Ok(None);
    };
    let value: Value = serde_json::from_str(&secret.value)
        .map_err(|_| "Invalid Granola credential.".to_string())?;
    Ok(Some(GranolaBundle {
        api_key: required_json_string(&value, "api_key")?,
        account: value
            .get("account")
            .and_then(Value::as_str)
            .map(str::to_string),
    }))
}

pub(crate) fn read_secret(account: &str) -> Result<Option<Secret>, String> {
    let entry =
        keyring::Entry::new(MIMIR_KEYCHAIN_SERVICE, account).map_err(|error| error.to_string())?;
    match entry.get_password() {
        Ok(value) if !value.trim().is_empty() => Ok(Some(Secret { value })),
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

pub(crate) fn write_secret(service: &str, account: &str, value: &str) -> Result<(), String> {
    keyring::Entry::new(service, account)
        .map_err(|error| error.to_string())?
        .set_password(value)
        .map_err(|error| error.to_string())
}

pub(crate) fn delete_secret(account: &str) -> Result<(), String> {
    let entry =
        keyring::Entry::new(MIMIR_KEYCHAIN_SERVICE, account).map_err(|error| error.to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(test)]
mod tests;
