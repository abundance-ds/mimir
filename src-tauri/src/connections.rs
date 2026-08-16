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

const MIMIR_KEYCHAIN_SERVICE: &str = "rs.shoulde.mimir";
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
struct Secret {
    value: String,
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

#[tauri::command]
pub async fn connections_connect_google(
    manager: tauri::State<'_, ConnectionManager>,
) -> Result<ConnectionStatus, String> {
    let client_id = configured_google_client_id().ok_or_else(|| {
        "This Mimir build has no Google sign-in client. Add MIMIR_GOOGLE_OAUTH_CLIENT_ID when you build the app."
            .to_string()
    })?;
    let oauth = OauthLoopback::new().await?;
    let mut authorize = url::Url::parse("https://accounts.google.com/o/oauth2/v2/auth")
        .map_err(|error| error.to_string())?;
    authorize
        .query_pairs_mut()
        .append_pair("client_id", &client_id)
        .append_pair("redirect_uri", &oauth.redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("scope", GOOGLE_SCOPES)
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent select_account")
        .append_pair("code_challenge", &oauth.challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &oauth.state);
    open_system_browser(authorize.as_str())?;
    let code = oauth.receive_code().await?;

    let form = {
        let mut form = url::form_urlencoded::Serializer::new(String::new());
        form.append_pair("client_id", &client_id)
            .append_pair("code", &code)
            .append_pair("code_verifier", &oauth.verifier)
            .append_pair("redirect_uri", &oauth.redirect_uri)
            .append_pair("grant_type", "authorization_code");
        if let Some(secret) = configured_google_client_secret() {
            form.append_pair("client_secret", &secret);
        }
        form.finish()
    };
    let response = manager
        .runtime
        .http
        .post("https://oauth2.googleapis.com/token")
        .header("content-type", "application/x-www-form-urlencoded")
        .body(form)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status();
    let value: Value = response
        .json()
        .await
        .map_err(|error| format!("Google returned invalid sign-in data: {error}"))?;
    if !status.is_success() {
        return Err(format!(
            "Google sign-in failed with HTTP {status}{}",
            remote_error_suffix(&value.to_string())
        ));
    }
    let access_token = required_json_string(&value, "access_token")?;
    let identity = manager
        .runtime
        .http
        .get("https://openidconnect.googleapis.com/v1/userinfo")
        .bearer_auth(&access_token)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !identity.status().is_success() {
        return Err(
            "Google sign-in succeeded, but Mimir could not read the account identity.".into(),
        );
    }
    let identity: Value = identity
        .json()
        .await
        .map_err(|error| format!("Google returned invalid account data: {error}"))?;
    let email = required_json_string(&identity, "email")?;
    let mut bundle = GoogleBundle {
        access_token,
        refresh_token: value
            .get("refresh_token")
            .and_then(Value::as_str)
            .map(str::to_string),
        expires_at: Some(
            unix_seconds()
                + value
                    .get("expires_in")
                    .and_then(Value::as_i64)
                    .unwrap_or(3600),
        ),
        scope: value
            .get("scope")
            .and_then(Value::as_str)
            .unwrap_or(GOOGLE_SCOPES)
            .to_string(),
        auth: Some(json!({
            "client_id": client_id,
            "email": identity.get("email").and_then(Value::as_str),
            "name": identity.get("name").and_then(Value::as_str),
        })),
    };
    let mut store = google_store()?;
    let id = email.to_lowercase();
    if bundle.refresh_token.is_none() {
        bundle.refresh_token = store
            .accounts
            .iter()
            .find(|account| account.id.eq_ignore_ascii_case(&id))
            .and_then(|account| account.bundle.refresh_token.clone());
    }
    upsert_google_account(
        &mut store,
        GoogleAccount {
            id,
            email,
            name: identity
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_string),
            bundle,
        },
    );
    write_google_store(&store)?;
    manager.refresh_provider("google")?;
    Ok(google_status())
}

#[tauri::command]
pub async fn connections_connect_slack(
    manager: tauri::State<'_, ConnectionManager>,
) -> Result<ConnectionStatus, String> {
    let client_id = configured_slack_client_id().ok_or_else(|| {
        "This Mimir build has no Slack sign-in client. Add MIMIR_SLACK_CLIENT_ID when you build the app."
            .to_string()
    })?;
    let oauth = OauthLoopback::new().await?;
    let mut authorize = url::Url::parse("https://slack.com/oauth/v2/authorize")
        .map_err(|error| error.to_string())?;
    authorize
        .query_pairs_mut()
        .append_pair("client_id", &client_id)
        .append_pair("redirect_uri", &oauth.redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("user_scope", SLACK_USER_SCOPES)
        .append_pair("code_challenge", &oauth.challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &oauth.state);
    open_system_browser(authorize.as_str())?;
    let code = oauth.receive_code().await?;
    let form = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("client_id", &client_id)
        .append_pair("code", &code)
        .append_pair("code_verifier", &oauth.verifier)
        .append_pair("redirect_uri", &oauth.redirect_uri)
        .finish();
    let response = manager
        .runtime
        .http
        .post("https://slack.com/api/oauth.v2.access")
        .header("content-type", "application/x-www-form-urlencoded")
        .body(form)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status();
    let value: Value = response
        .json()
        .await
        .map_err(|error| format!("Slack returned invalid sign-in data: {error}"))?;
    if !status.is_success() || value.get("ok") == Some(&Value::Bool(false)) {
        let reason = value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("unknown_error");
        return Err(format!("Slack sign-in failed: {reason}"));
    }
    let access_token = value
        .pointer("/authed_user/access_token")
        .and_then(Value::as_str)
        .or_else(|| value.get("access_token").and_then(Value::as_str))
        .ok_or_else(|| "Slack sign-in returned no user access token.".to_string())?;
    let account = value
        .pointer("/team/name")
        .and_then(Value::as_str)
        .unwrap_or("Slack workspace");
    let stored = json!({
        "access_token": access_token,
        "refresh_token": slack_oauth_optional(&value, "refresh_token"),
        "account": account,
        "team_id": value.pointer("/team/id").and_then(Value::as_str),
        "user_id": value.pointer("/authed_user/id").and_then(Value::as_str),
        "expires_at": slack_oauth_i64(&value, "expires_in").map(|seconds| unix_seconds() + seconds),
    });
    write_secret(
        MIMIR_KEYCHAIN_SERVICE,
        "slack:default",
        &serde_json::to_string(&stored).map_err(|error| error.to_string())?,
    )?;
    manager.refresh_provider("slack")?;
    Ok(slack_status())
}

#[tauri::command]
pub async fn connections_connect_slack_token(
    token: String,
    manager: tauri::State<'_, ConnectionManager>,
) -> Result<ConnectionStatus, String> {
    let token = slack_personal_token(&token)?;
    let response = manager
        .runtime
        .http
        .post("https://slack.com/api/auth.test")
        .bearer_auth(token)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status();
    let value: Value = response
        .json()
        .await
        .map_err(|error| format!("Slack returned invalid token data: {error}"))?;
    if !status.is_success() || value.get("ok") != Some(&Value::Bool(true)) {
        let reason = value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("invalid_auth");
        return Err(format!("Slack rejected this personal token: {reason}"));
    }
    let team = value
        .get("team")
        .and_then(Value::as_str)
        .unwrap_or("Slack workspace");
    let user = value.get("user").and_then(Value::as_str);
    let account = user
        .map(|user| format!("{team} · {user}"))
        .unwrap_or_else(|| team.to_string());
    let stored = json!({
        "access_token": token,
        "refresh_token": null,
        "account": account,
        "team_id": value.get("team_id").and_then(Value::as_str),
        "user_id": value.get("user_id").and_then(Value::as_str),
        "expires_at": null,
    });
    write_secret(
        MIMIR_KEYCHAIN_SERVICE,
        "slack:default",
        &serde_json::to_string(&stored).map_err(|error| error.to_string())?,
    )?;
    manager.refresh_provider("slack")?;
    Ok(slack_status())
}

#[tauri::command]
pub async fn connections_connect_granola(
    api_key: String,
    manager: tauri::State<'_, ConnectionManager>,
) -> Result<ConnectionStatus, String> {
    let api_key = api_key.trim();
    if !api_key.starts_with("grn_") {
        return Err("Enter a Granola API key that starts with grn_.".into());
    }
    let response = manager
        .runtime
        .http
        .get(format!("{GRANOLA_API_ROOT}/notes"))
        .bearer_auth(api_key)
        .query(&[("page_size", "1")])
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status();
    let value: Value = response
        .json()
        .await
        .map_err(|error| format!("Granola returned invalid connection data: {error}"))?;
    if !status.is_success() {
        return Err(format!(
            "Granola rejected this API key with HTTP {status}{}",
            remote_error_suffix(&value.to_string())
        ));
    }
    let account = value
        .pointer("/notes/0/owner/email")
        .and_then(Value::as_str)
        .unwrap_or("Personal API key");
    let stored = json!({ "api_key": api_key, "account": account });
    write_secret(
        MIMIR_KEYCHAIN_SERVICE,
        "granola:default",
        &serde_json::to_string(&stored).map_err(|error| error.to_string())?,
    )?;
    manager.refresh_provider("granola")?;
    Ok(granola_status())
}

#[tauri::command]
pub fn connections_disconnect(
    provider: String,
    account: Option<String>,
    manager: tauri::State<'_, ConnectionManager>,
) -> Result<Vec<ConnectionStatus>, String> {
    match provider.as_str() {
        "google" => {
            if let Some(account) = account.filter(|value| !value.trim().is_empty()) {
                let mut store = google_store()?;
                let id = resolve_google_account(&store, Some(&account))?.id.clone();
                store.accounts.retain(|entry| entry.id != id);
                normalize_google_store(&mut store);
                write_google_store(&store)?;
            } else {
                delete_secret(GOOGLE_ACCOUNTS_KEY)?;
                delete_secret("google:default")?;
            }
        }
        "slack" => delete_secret("slack:default")?,
        "granola" => delete_secret("granola:default")?,
        _ => return Err(format!("Unknown connection provider: {provider}")),
    }
    manager.refresh_provider(&provider)?;
    Ok(manager.statuses())
}

#[tauri::command]
pub fn connections_set_google_default(
    account: String,
    manager: tauri::State<'_, ConnectionManager>,
) -> Result<ConnectionStatus, String> {
    let mut store = google_store()?;
    let id = resolve_google_account(&store, Some(&account))?.id.clone();
    store.default_account = Some(id);
    write_google_store(&store)?;
    manager.refresh_provider("google")?;
    Ok(google_status())
}

fn google_status() -> ConnectionStatus {
    match google_store() {
        Ok(store) if store.accounts.is_empty() => {
            disconnected_status("google", "Google", "Gmail, Calendar, and Drive")
        }
        Ok(store) => {
            let default = resolve_google_account(&store, None).ok();
            let connected = store
                .accounts
                .iter()
                .any(|account| !google_needs_sign_in(&account.bundle));
            let count = store.accounts.len();
            ConnectionStatus {
                provider: "google",
                name: "Google",
                state: if connected {
                    "connected"
                } else {
                    "needs_sign_in"
                },
                account: default.map(|account| account.email.clone()),
                accounts: store
                    .accounts
                    .iter()
                    .map(|account| ConnectionAccountStatus {
                        id: account.id.clone(),
                        label: account.email.clone(),
                        detail: account.name.clone(),
                        state: if google_needs_sign_in(&account.bundle) {
                            "needs_sign_in"
                        } else {
                            "connected"
                        },
                        is_default: store.default_account.as_deref() == Some(&account.id),
                    })
                    .collect(),
                oauth_available: configured_google_client_id().is_some(),
                detail: if !connected {
                    "Sign in again to restore Gmail, Calendar, and Drive.".into()
                } else if count == 1 {
                    "Gmail, Calendar, and Drive are available to agents.".into()
                } else {
                    format!("{count} Google accounts are available to agents.")
                },
            }
        }
        Err(error) => needs_sign_in_status("google", "Google", error),
    }
}

fn slack_status() -> ConnectionStatus {
    match slack_bundle(DEFAULT_ACCOUNT) {
        Ok(Some(bundle)) if slack_needs_sign_in(&bundle) => ConnectionStatus {
            provider: "slack",
            name: "Slack",
            state: "needs_sign_in",
            account: bundle.account,
            accounts: Vec::new(),
            oauth_available: configured_slack_client_id().is_some(),
            detail: "Sign in again to restore Slack access.".into(),
        },
        Ok(Some(bundle)) => ConnectionStatus {
            provider: "slack",
            name: "Slack",
            state: "connected",
            account: bundle.account,
            accounts: Vec::new(),
            oauth_available: configured_slack_client_id().is_some(),
            detail: "Search, read, and send tools are available to agents.".into(),
        },
        Ok(None) => disconnected_status("slack", "Slack", "Search, read, and send messages"),
        Err(error) => needs_sign_in_status("slack", "Slack", error),
    }
}

fn granola_status() -> ConnectionStatus {
    match granola_bundle() {
        Ok(Some(bundle)) => ConnectionStatus {
            provider: "granola",
            name: "Granola",
            state: "connected",
            account: bundle.account,
            accounts: Vec::new(),
            oauth_available: false,
            detail: "Meeting notes and transcripts are available to agents.".into(),
        },
        Ok(None) => disconnected_status("granola", "Granola", "Meeting notes and transcripts"),
        Err(error) => needs_sign_in_status("granola", "Granola", error),
    }
}

fn disconnected_status(
    provider: &'static str,
    name: &'static str,
    capability: &str,
) -> ConnectionStatus {
    ConnectionStatus {
        provider,
        name,
        state: "not_connected",
        account: None,
        accounts: Vec::new(),
        oauth_available: match provider {
            "google" => configured_google_client_id().is_some(),
            "slack" => configured_slack_client_id().is_some(),
            _ => false,
        },
        detail: format!("Connect to use {capability}."),
    }
}

fn needs_sign_in_status(
    provider: &'static str,
    name: &'static str,
    error: String,
) -> ConnectionStatus {
    ConnectionStatus {
        provider,
        name,
        state: "needs_sign_in",
        account: None,
        accounts: Vec::new(),
        oauth_available: match provider {
            "google" => configured_google_client_id().is_some(),
            "slack" => configured_slack_client_id().is_some(),
            _ => false,
        },
        detail: truncate(&error, 160),
    }
}

fn google_needs_sign_in(bundle: &GoogleBundle) -> bool {
    bundle
        .expires_at
        .is_some_and(|expires| expires <= unix_seconds() + 60)
        && bundle.refresh_token.is_none()
}

fn slack_needs_sign_in(bundle: &SlackBundle) -> bool {
    bundle
        .expires_at
        .is_some_and(|expires| expires <= unix_seconds() + 60)
        && bundle.refresh_token.is_none()
}

fn slack_personal_token(value: &str) -> Result<&str, String> {
    let token = value.trim();
    if token.starts_with("xoxp-") {
        Ok(token)
    } else {
        Err("Enter a Slack personal token that starts with xoxp-.".into())
    }
}

pub(crate) fn local_diagnostics() -> Value {
    let manager = ConnectionManager::new(ToolRegistry::default());
    let statuses = manager
        .map(|manager| manager.statuses())
        .unwrap_or_else(|_| vec![google_status(), slack_status(), granola_status()]);
    let diagnostic = |provider: &str| {
        let status = statuses.iter().find(|status| status.provider == provider);
        json!({
            "status": status.map(|status| status.state).unwrap_or("error"),
            "detail": status.map(|status| status.detail.as_str()).unwrap_or("status unavailable"),
            "account": status.and_then(|status| status.account.as_deref()),
        })
    };
    json!({
        "remoteChecked": false,
        "google": diagnostic("google"),
        "slack": diagnostic("slack"),
        "granola": diagnostic("granola"),
    })
}

fn register_google_tools(
    registry: &ToolRegistry,
    runtime: &ConnectionRuntime,
    store: &GoogleStore,
) -> Result<(), String> {
    let accounts = store
        .accounts
        .iter()
        .filter(|account| !google_needs_sign_in(&account.bundle))
        .collect::<Vec<_>>();
    let has_any = |scopes: &[&str]| {
        accounts
            .iter()
            .any(|account| account.bundle.has_any(scopes))
    };
    let schema = |properties: Value, required: &[&str]| {
        google_object_schema(
            properties,
            required,
            &accounts,
            store.default_account.as_deref(),
        )
    };
    if has_any(&[
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.modify",
        "https://mail.google.com/",
    ]) {
        register(
            registry,
            runtime,
            "gmail.search",
            "gmail_search",
            "Search Gmail messages.",
            schema(
                json!({
                    "query": { "type": "string", "description": "Gmail search syntax." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 50, "default": 10 },
                    "page_token": { "type": "string" }
                }),
                &[],
            ),
        )?;
        register(
            registry,
            runtime,
            "gmail.read",
            "gmail_read",
            "Read a Gmail message or thread.",
            schema(
                json!({
                    "message_id": { "type": "string" },
                    "thread_id": { "type": "string" }
                }),
                &[],
            ),
        )?;
    }
    if has_any(&[
        "https://www.googleapis.com/auth/gmail.send",
        "https://mail.google.com/",
    ]) {
        register(
            registry,
            runtime,
            "gmail.send",
            "gmail_send",
            "Send or reply to Gmail.",
            schema(
                json!({
                    "to": { "type": "string", "minLength": 1 },
                    "subject": { "type": "string" },
                    "body": { "type": "string", "minLength": 1 },
                    "cc": { "type": "string" },
                    "bcc": { "type": "string" },
                    "thread_id": { "type": "string" },
                    "reply_to_message_id": { "type": "string" }
                }),
                &["to", "body"],
            ),
        )?;
    }
    if has_any(&[
        "https://www.googleapis.com/auth/calendar.events.readonly",
        "https://www.googleapis.com/auth/calendar.events",
        "https://www.googleapis.com/auth/calendar.readonly",
        "https://www.googleapis.com/auth/calendar",
    ]) {
        register(
            registry,
            runtime,
            "calendar.list",
            "calendar_list",
            "List Google Calendar events.",
            schema(
                json!({
                    "from": { "type": "string", "description": "Inclusive RFC 3339 start." },
                    "to": { "type": "string", "description": "Exclusive RFC 3339 end." },
                    "calendar_id": { "type": "string", "default": "primary" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 100, "default": 20 },
                    "page_token": { "type": "string" }
                }),
                &["from", "to"],
            ),
        )?;
    }
    if has_any(&[
        "https://www.googleapis.com/auth/calendar.events",
        "https://www.googleapis.com/auth/calendar",
    ]) {
        register(
            registry,
            runtime,
            "calendar.create",
            "calendar_create",
            "Create a Google Calendar event.",
            schema(
                json!({
                    "summary": { "type": "string", "minLength": 1 },
                    "start": { "type": "string", "description": "RFC 3339 date-time." },
                    "end": { "type": "string", "description": "RFC 3339 date-time." },
                    "calendar_id": { "type": "string", "default": "primary" },
                    "attendees": { "type": "array", "items": { "type": "string" } },
                    "description": { "type": "string" }
                }),
                &["summary", "start", "end"],
            ),
        )?;
    }
    if has_any(&[
        "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
        "https://www.googleapis.com/auth/calendar.calendarlist",
        "https://www.googleapis.com/auth/calendar.readonly",
        "https://www.googleapis.com/auth/calendar",
    ]) {
        register(
            registry,
            runtime,
            "calendar.calendars",
            "calendar_calendars",
            "List the Google calendars available to the user.",
            schema(
                json!({
                    "limit": { "type": "integer", "minimum": 1, "maximum": 250, "default": 100 },
                    "page_token": { "type": "string" },
                    "include_hidden": { "type": "boolean", "default": false }
                }),
                &[],
            ),
        )?;
    }
    if has_any(&[
        "https://www.googleapis.com/auth/calendar.events.freebusy",
        "https://www.googleapis.com/auth/calendar.freebusy",
        "https://www.googleapis.com/auth/calendar.readonly",
        "https://www.googleapis.com/auth/calendar",
    ]) {
        register(
            registry,
            runtime,
            "calendar.freebusy",
            "calendar_freebusy",
            "Read availability across Google calendars.",
            schema(
                json!({
                    "from": { "type": "string", "description": "Inclusive RFC 3339 start." },
                    "to": { "type": "string", "description": "Exclusive RFC 3339 end." },
                    "calendar_ids": {
                        "type": "array",
                        "items": { "type": "string", "minLength": 1 },
                        "minItems": 1,
                        "maxItems": 50,
                        "default": ["primary"]
                    },
                    "time_zone": { "type": "string", "description": "Optional IANA time zone." }
                }),
                &["from", "to"],
            ),
        )?;
    }
    if has_any(&[
        "https://www.googleapis.com/auth/drive.readonly",
        "https://www.googleapis.com/auth/drive",
    ]) {
        register(
            registry,
            runtime,
            "drive.search",
            "drive_search",
            "Search Google Drive files.",
            schema(
                json!({
                    "query": { "type": "string" },
                    "type": {
                        "type": "string",
                        "enum": ["document", "spreadsheet", "presentation", "pdf", "folder", "image", "any"]
                    },
                    "folder_id": { "type": "string" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 100, "default": 20 },
                    "page_token": { "type": "string" }
                }),
                &[],
            ),
        )?;
        register(
            registry,
            runtime,
            "drive.read",
            "drive_read",
            "Read Drive metadata and normalized Docs, Sheets, Slides, or text content.",
            schema(
                json!({
                    "file_id": { "type": "string", "minLength": 1 },
                    "max_chars": { "type": "integer", "minimum": 1000, "maximum": 100000, "default": 30000 }
                }),
                &["file_id"],
            ),
        )?;
    }
    Ok(())
}

fn register_slack_tools(
    registry: &ToolRegistry,
    runtime: &ConnectionRuntime,
) -> Result<(), String> {
    register(
        registry,
        runtime,
        "slack.search",
        "slack_search",
        "Search Slack messages.",
        object_schema(
            json!({
                "query": { "type": "string", "minLength": 1 },
                "limit": { "type": "integer", "minimum": 1, "maximum": 100, "default": 20 }
            }),
            &["query"],
        ),
    )?;
    register(
        registry,
        runtime,
        "slack.read",
        "slack_read",
        "Read a Slack channel or thread.",
        object_schema(
            json!({
                "channel": { "type": "string", "minLength": 1 },
                "thread_ts": { "type": "string" },
                "limit": { "type": "integer", "minimum": 1, "maximum": 100, "default": 50 },
                "cursor": { "type": "string" }
            }),
            &["channel"],
        ),
    )?;
    register(
        registry,
        runtime,
        "slack.send",
        "slack_send",
        "Send a Slack message.",
        object_schema(
            json!({
                "channel": { "type": "string", "minLength": 1 },
                "text": { "type": "string", "minLength": 1 },
                "thread_ts": { "type": "string" }
            }),
            &["channel", "text"],
        ),
    )
}

fn register_granola_tools(
    registry: &ToolRegistry,
    runtime: &ConnectionRuntime,
) -> Result<(), String> {
    register(
        registry,
        runtime,
        "granola.search",
        "granola_search",
        "Find Granola meeting notes by title or owner.",
        object_schema(
            json!({
                "query": { "type": "string" },
                "from": { "type": "string", "description": "Only notes created on or after this ISO date." },
                "to": { "type": "string", "description": "Only notes created before this ISO date." },
                "limit": { "type": "integer", "minimum": 1, "maximum": 30, "default": 10 },
                "cursor": { "type": "string" }
            }),
            &[],
        ),
    )?;
    register(
        registry,
        runtime,
        "granola.get",
        "granola_get",
        "Read one Granola meeting note and, when requested, its transcript.",
        object_schema(
            json!({
                "id": { "type": "string", "minLength": 1 },
                "transcript": { "type": "boolean", "default": false },
                "max_chars": { "type": "integer", "minimum": 1000, "maximum": 50000, "default": 20000 }
            }),
            &["id"],
        ),
    )?;
    Ok(())
}

fn register(
    registry: &ToolRegistry,
    runtime: &ConnectionRuntime,
    canonical: &'static str,
    alias: &'static str,
    description: &'static str,
    schema: Value,
) -> Result<(), String> {
    let runtime = runtime.clone();
    let provider = if canonical.starts_with("slack.") {
        "slack"
    } else if canonical.starts_with("granola.") {
        "granola"
    } else {
        "google"
    };
    let registration = ToolRegistration::new(
        ToolDescriptor::new(
            canonical,
            alias,
            description,
            schema,
            ToolOwner::Provider(provider.to_string()),
            ToolSource::Integration(provider.to_string()),
        )
        .with_annotations(connection_annotations(canonical)),
        move |_context: ToolCallContext, input: Value| {
            let runtime = runtime.clone();
            async move {
                runtime
                    .execute(canonical, input)
                    .await
                    .map(ToolResult::new)
                    .map_err(|message| ToolError::new(ToolErrorCode::Handler, message))
            }
        },
    );
    registry
        .register(registration)
        .map_err(|error| error.to_string())?;
    Ok(())
}

impl ConnectionRuntime {
    async fn execute(&self, tool: &str, input: Value) -> Result<Value, String> {
        let result = match tool {
            "gmail.search" => self.gmail_search(&input).await,
            "gmail.read" => self.gmail_read(&input).await,
            "gmail.send" => self.gmail_send(&input).await,
            "calendar.list" => self.calendar_list(&input).await,
            "calendar.create" => self.calendar_create(&input).await,
            "calendar.calendars" => self.calendar_calendars(&input).await,
            "calendar.freebusy" => self.calendar_freebusy(&input).await,
            "drive.search" => self.drive_search(&input).await,
            "drive.read" => self.drive_read(&input).await,
            "slack.search" => self.slack_search(&input).await,
            "slack.read" => self.slack_read(&input).await,
            "slack.send" => self.slack_send(&input).await,
            "granola.search" => self.granola_search(&input).await,
            "granola.get" => self.granola_get(&input).await,
            _ => Err(format!("Unknown connection tool: {tool}")),
        }?;
        if matches!(
            tool.split_once('.').map(|(provider, _)| provider),
            Some("gmail" | "calendar" | "drive")
        ) {
            return add_google_account_to_result(&input, result);
        }
        Ok(result)
    }

    async fn google_request(
        &self,
        input: &Value,
        method: Method,
        url: &str,
        query: &[(&str, String)],
        body: Option<Value>,
    ) -> Result<reqwest::Response, String> {
        let token = self.google_access_token(input).await?;
        let mut request = self.http.request(method, url).bearer_auth(token);
        if !query.is_empty() {
            request = request.query(query);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.map_err(|error| error.to_string())?;
        if response.status().is_success() {
            return Ok(response);
        }
        let status = response.status();
        let message = response.text().await.unwrap_or_default();
        Err(format!(
            "Google request failed with HTTP {status}{}",
            remote_error_suffix(&message)
        ))
    }

    async fn google_json(
        &self,
        input: &Value,
        method: Method,
        url: &str,
        query: &[(&str, String)],
        body: Option<Value>,
    ) -> Result<Value, String> {
        self.google_request(input, method, url, query, body)
            .await?
            .json()
            .await
            .map_err(|error| format!("Google returned invalid JSON: {error}"))
    }

    async fn google_access_token(&self, input: &Value) -> Result<String, String> {
        let store = google_store()?;
        let account = resolve_google_account(&store, string(input, "account").as_deref())?;
        let account_id = account.id.clone();
        let email = account.email.clone();
        let mut bundle = account.bundle.clone();
        if google_needs_sign_in(&bundle) {
            return Err(format!(
                "Google account {email} needs sign-in. Reconnect it in Settings → Connections."
            ));
        }
        if bundle.expires_at.unwrap_or(i64::MAX) > unix_seconds() + 60
            || bundle.refresh_token.is_none()
        {
            return Ok(bundle.access_token);
        }
        let client_id = bundle
            .auth
            .as_ref()
            .and_then(|auth| auth.get("client_id"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(configured_google_client_id)
            .ok_or_else(|| {
                "Google needs sign-in. Connect Google in Settings → Connections.".to_string()
            })?;
        let refresh_token = bundle.refresh_token.clone().unwrap_or_default();
        let form = {
            let mut form = url::form_urlencoded::Serializer::new(String::new());
            form.append_pair("client_id", &client_id)
                .append_pair("refresh_token", &refresh_token)
                .append_pair("grant_type", "refresh_token");
            if let Some(secret) = configured_google_client_secret() {
                form.append_pair("client_secret", &secret);
            }
            form.finish()
        };
        let response = self
            .http
            .post("https://oauth2.googleapis.com/token")
            .header("content-type", "application/x-www-form-urlencoded")
            .body(form)
            .send()
            .await
            .map_err(|error| error.to_string())?;
        let status = response.status();
        let value: Value = response
            .json()
            .await
            .map_err(|error| format!("Google token refresh returned invalid JSON: {error}"))?;
        if !status.is_success() {
            return Err(format!("Google token refresh failed with HTTP {status}"));
        }
        bundle.access_token = required_json_string(&value, "access_token")?;
        bundle.expires_at = Some(
            unix_seconds()
                + value
                    .get("expires_in")
                    .and_then(Value::as_i64)
                    .unwrap_or(3600),
        );
        if let Some(scope) = value.get("scope").and_then(Value::as_str) {
            bundle.scope = scope.to_string();
        }
        let access_token = bundle.access_token.clone();
        save_google_bundle(&account_id, bundle)?;
        Ok(access_token)
    }

    async fn gmail_search(&self, input: &Value) -> Result<Value, String> {
        let limit = int(input, "limit", 10, 1, 50);
        let mut query = vec![("maxResults", limit.to_string())];
        if let Some(value) = string(input, "query") {
            query.push(("q", value));
        }
        if let Some(value) = string(input, "page_token") {
            query.push(("pageToken", value));
        }
        let list = self
            .google_json(
                input,
                Method::GET,
                "https://gmail.googleapis.com/gmail/v1/users/me/messages",
                &query,
                None,
            )
            .await?;
        let mut messages = Vec::new();
        for item in list
            .get("messages")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(id) = item.get("id").and_then(Value::as_str) else {
                continue;
            };
            let detail = self
                .google_json(
                    input,
                    Method::GET,
                    &format!(
                        "https://gmail.googleapis.com/gmail/v1/users/me/messages/{}",
                        url_encode(id)
                    ),
                    &[
                        ("format", "metadata".into()),
                        ("metadataHeaders", "From".into()),
                        ("metadataHeaders", "Subject".into()),
                        ("metadataHeaders", "Date".into()),
                    ],
                    None,
                )
                .await?;
            messages.push(gmail_summary(&detail));
        }
        Ok(json!({
            "messages": messages,
            "nextPageToken": list.get("nextPageToken"),
            "resultSizeEstimate": list.get("resultSizeEstimate")
        }))
    }

    async fn gmail_read(&self, input: &Value) -> Result<Value, String> {
        if let Some(id) = string(input, "message_id") {
            let message = self
                .google_json(
                    input,
                    Method::GET,
                    &format!(
                        "https://gmail.googleapis.com/gmail/v1/users/me/messages/{}",
                        url_encode(&id)
                    ),
                    &[("format", "full".into())],
                    None,
                )
                .await?;
            return Ok(json!({ "message": read_gmail_message(&message) }));
        }
        let id = string(input, "thread_id")
            .ok_or_else(|| "message_id or thread_id is required.".to_string())?;
        let thread = self
            .google_json(
                input,
                Method::GET,
                &format!(
                    "https://gmail.googleapis.com/gmail/v1/users/me/threads/{}",
                    url_encode(&id)
                ),
                &[("format", "full".into())],
                None,
            )
            .await?;
        let messages = thread
            .get("messages")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(read_gmail_message)
            .collect::<Vec<_>>();
        Ok(
            json!({ "threadId": thread.get("id").unwrap_or(&Value::String(id)), "messages": messages }),
        )
    }

    async fn gmail_send(&self, input: &Value) -> Result<Value, String> {
        let to = required_string(input, "to")?;
        let body = required_string(input, "body")?;
        let mut subject = string(input, "subject");
        let mut thread_id = string(input, "thread_id");
        let mut in_reply_to = None;
        let mut references = None;
        if let Some(reply_id) = string(input, "reply_to_message_id") {
            let original = self
                .google_json(
                    input,
                    Method::GET,
                    &format!(
                        "https://gmail.googleapis.com/gmail/v1/users/me/messages/{}",
                        url_encode(&reply_id)
                    ),
                    &[("format", "metadata".into())],
                    None,
                )
                .await?;
            let headers = gmail_headers(original.get("payload"));
            in_reply_to = headers.get("message-id").cloned();
            references = [headers.get("references").cloned(), in_reply_to.clone()]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" ")
                .into();
            thread_id = thread_id.or_else(|| {
                original
                    .get("threadId")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            });
            subject = subject.or_else(|| headers.get("subject").map(|value| reply_subject(value)));
        }
        let subject = subject.ok_or_else(|| "subject is required.".to_string())?;
        let mut lines = vec![format!("To: {}", safe_header(&to))];
        if let Some(value) = string(input, "cc") {
            lines.push(format!("Cc: {}", safe_header(&value)));
        }
        if let Some(value) = string(input, "bcc") {
            lines.push(format!("Bcc: {}", safe_header(&value)));
        }
        lines.push(format!("Subject: {}", safe_header(&subject)));
        if let Some(value) = in_reply_to {
            lines.push(format!("In-Reply-To: {}", safe_header(&value)));
        }
        if let Some(value) = references.filter(|value: &String| !value.is_empty()) {
            lines.push(format!("References: {}", safe_header(&value)));
        }
        lines.push("Content-Type: text/plain; charset=\"UTF-8\"".into());
        lines.push(String::new());
        lines.push(body);
        let raw = URL_SAFE_NO_PAD.encode(lines.join("\r\n"));
        self.google_json(
            input,
            Method::POST,
            "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
            &[],
            Some(json!({ "raw": raw, "threadId": thread_id })),
        )
        .await
    }

    async fn calendar_list(&self, input: &Value) -> Result<Value, String> {
        let calendar = string(input, "calendar_id").unwrap_or_else(|| "primary".into());
        let mut query = vec![
            ("timeMin", required_string(input, "from")?),
            ("timeMax", required_string(input, "to")?),
            ("singleEvents", "true".into()),
            ("orderBy", "startTime".into()),
            ("maxResults", int(input, "limit", 20, 1, 100).to_string()),
        ];
        if let Some(value) = string(input, "page_token") {
            query.push(("pageToken", value));
        }
        self.google_json(
            input,
            Method::GET,
            &format!(
                "https://www.googleapis.com/calendar/v3/calendars/{}/events",
                url_encode(&calendar)
            ),
            &query,
            None,
        )
        .await
    }

    async fn calendar_create(&self, input: &Value) -> Result<Value, String> {
        let calendar = string(input, "calendar_id").unwrap_or_else(|| "primary".into());
        let attendees = input
            .get("attendees")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(|email| json!({ "email": email }))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        self.google_json(
            input,
            Method::POST,
            &format!(
                "https://www.googleapis.com/calendar/v3/calendars/{}/events",
                url_encode(&calendar)
            ),
            &[],
            Some(json!({
                "summary": required_string(input, "summary")?,
                "description": string(input, "description"),
                "start": { "dateTime": required_string(input, "start")? },
                "end": { "dateTime": required_string(input, "end")? },
                "attendees": attendees
            })),
        )
        .await
    }

    async fn calendar_calendars(&self, input: &Value) -> Result<Value, String> {
        let mut query = vec![
            (
                "maxResults",
                int(input, "limit", 100, 1, 250).to_string(),
            ),
            (
                "showHidden",
                input
                    .get("include_hidden")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                    .to_string(),
            ),
            (
                "fields",
                "nextPageToken,nextSyncToken,items(id,summary,description,location,timeZone,colorId,backgroundColor,foregroundColor,selected,primary,accessRole,hidden,deleted)"
                    .into(),
            ),
        ];
        if let Some(value) = string(input, "page_token") {
            query.push(("pageToken", value));
        }
        self.google_json(
            input,
            Method::GET,
            "https://www.googleapis.com/calendar/v3/users/me/calendarList",
            &query,
            None,
        )
        .await
    }

    async fn calendar_freebusy(&self, input: &Value) -> Result<Value, String> {
        let calendar_ids = input
            .get("calendar_ids")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .take(50)
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .filter(|values| !values.is_empty())
            .unwrap_or_else(|| vec!["primary".into()]);
        let mut body = json!({
            "timeMin": required_string(input, "from")?,
            "timeMax": required_string(input, "to")?,
            "calendarExpansionMax": 50,
            "items": calendar_ids
                .into_iter()
                .map(|id| json!({ "id": id }))
                .collect::<Vec<_>>()
        });
        if let Some(time_zone) = string(input, "time_zone") {
            body["timeZone"] = Value::String(time_zone);
        }
        self.google_json(
            input,
            Method::POST,
            "https://www.googleapis.com/calendar/v3/freeBusy",
            &[],
            Some(body),
        )
        .await
    }

    async fn drive_search(&self, input: &Value) -> Result<Value, String> {
        let mut clauses = vec!["trashed = false".to_string()];
        if let Some(value) = string(input, "query") {
            clauses.push(format!("name contains '{}'", escape_drive_query(&value)));
        }
        if let Some(value) = string(input, "folder_id") {
            clauses.push(format!("'{}' in parents", escape_drive_query(&value)));
        }
        if let Some(mime) = drive_mime(string(input, "type").as_deref()) {
            clauses.push(mime.into());
        }
        let mut query = vec![
            ("q", clauses.join(" and ")),
            ("pageSize", int(input, "limit", 20, 1, 100).to_string()),
            (
                "fields",
                "nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink,owners(emailAddress,displayName),size)".into(),
            ),
        ];
        if let Some(value) = string(input, "page_token") {
            query.push(("pageToken", value));
        }
        self.google_json(
            input,
            Method::GET,
            "https://www.googleapis.com/drive/v3/files",
            &query,
            None,
        )
        .await
    }

    async fn drive_read(&self, input: &Value) -> Result<Value, String> {
        let id = required_string(input, "file_id")?;
        let metadata = self
            .google_json(
                input,
                Method::GET,
                &format!(
                    "https://www.googleapis.com/drive/v3/files/{}",
                    url_encode(&id)
                ),
                &[(
                    "fields",
                    "id,name,mimeType,modifiedTime,webViewLink,owners(emailAddress,displayName),size"
                        .into(),
                )],
                None,
            )
            .await?;
        let mime = metadata
            .get("mimeType")
            .and_then(Value::as_str)
            .unwrap_or("");
        let content = if mime == "application/vnd.google-apps.document" {
            Some(
                self.google_request(
                    input,
                    Method::GET,
                    &format!(
                        "https://www.googleapis.com/drive/v3/files/{}/export",
                        url_encode(&id)
                    ),
                    &[("mimeType", "text/plain".into())],
                    None,
                )
                .await?
                .text()
                .await
                .map_err(|error| error.to_string())?,
            )
        } else if mime == "application/vnd.google-apps.spreadsheet" {
            let spreadsheet = self
                .google_json(
                    input,
                    Method::GET,
                    &format!(
                        "https://sheets.googleapis.com/v4/spreadsheets/{}",
                        url_encode(&id)
                    ),
                    &[
                        ("includeGridData", "true".into()),
                        (
                            "fields",
                            "spreadsheetId,properties(title,locale,timeZone),sheets(properties(sheetId,title,index,gridProperties(rowCount,columnCount)),data(startRow,startColumn,rowData(values(effectiveValue,formattedValue))))"
                                .into(),
                        ),
                    ],
                    None,
                )
                .await?;
            Some(spreadsheet_text(&spreadsheet))
        } else if mime == "application/vnd.google-apps.presentation" {
            let presentation = self
                .google_json(
                    input,
                    Method::GET,
                    &format!(
                        "https://slides.googleapis.com/v1/presentations/{}",
                        url_encode(&id)
                    ),
                    &[("fields", "presentationId,title,slides".into())],
                    None,
                )
                .await?;
            Some(presentation_text(&presentation))
        } else if mime.starts_with("text/")
            || matches!(mime, "application/json" | "application/xml")
        {
            Some(
                self.google_request(
                    input,
                    Method::GET,
                    &format!(
                        "https://www.googleapis.com/drive/v3/files/{}",
                        url_encode(&id)
                    ),
                    &[("alt", "media".into())],
                    None,
                )
                .await?
                .text()
                .await
                .map_err(|error| error.to_string())?,
            )
        } else {
            None
        };
        let max_chars = int(input, "max_chars", 30_000, 1_000, 100_000) as usize;
        let content_available = content.is_some();
        Ok(json!({
            "file": metadata,
            "content": content.map(|value| truncate(&value, max_chars)),
            "contentAvailable": content_available
        }))
    }

    async fn slack_api(
        &self,
        method: &str,
        verb: Method,
        query: &[(&str, String)],
        body: Option<Value>,
    ) -> Result<Value, String> {
        let token = self.slack_access_token().await?;
        let send = || {
            let mut request = self
                .http
                .request(verb.clone(), format!("https://slack.com/api/{method}"))
                .bearer_auth(&token);
            if !query.is_empty() {
                request = request.query(query);
            }
            if let Some(body) = body.clone() {
                request = request.json(&body);
            }
            request.send()
        };
        let mut response = send().await.map_err(|error| error.to_string())?;
        if response.status() == StatusCode::TOO_MANY_REQUESTS {
            let retry = response
                .headers()
                .get(RETRY_AFTER)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(1);
            if retry > 5 {
                return Err(format!("Slack rate limited. Retry after {retry} seconds."));
            }
            tokio::time::sleep(Duration::from_secs(retry)).await;
            response = send().await.map_err(|error| error.to_string())?;
        }
        let status = response.status();
        let value: Value = response
            .json()
            .await
            .map_err(|error| format!("Slack returned invalid JSON: {error}"))?;
        if !status.is_success() || value.get("ok") == Some(&Value::Bool(false)) {
            let reason = value
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("unknown_error");
            return Err(format!("Slack {method}: {reason}"));
        }
        Ok(value)
    }

    async fn slack_access_token(&self) -> Result<String, String> {
        let mut bundle = slack_bundle(&self.slack_account)?.ok_or_else(|| {
            "Slack is not connected. Connect Slack in Settings → Connections.".to_string()
        })?;
        if bundle.expires_at.unwrap_or(i64::MAX) > unix_seconds() + 60 {
            return Ok(bundle.access_token);
        }
        let refresh_token = bundle.refresh_token.clone().ok_or_else(|| {
            "Slack needs sign-in. Connect Slack in Settings → Connections.".to_string()
        })?;
        let client_id = configured_slack_client_id().ok_or_else(|| {
            "Slack needs sign-in. Connect Slack in Settings → Connections.".to_string()
        })?;
        let form = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("grant_type", "refresh_token")
            .append_pair("refresh_token", &refresh_token)
            .append_pair("client_id", &client_id)
            .finish();
        let response = self
            .http
            .post("https://slack.com/api/oauth.v2.access")
            .header("content-type", "application/x-www-form-urlencoded")
            .body(form)
            .send()
            .await
            .map_err(|error| error.to_string())?;
        let status = response.status();
        let value: Value = response
            .json()
            .await
            .map_err(|error| format!("Slack returned invalid refresh data: {error}"))?;
        if !status.is_success() || value.get("ok") == Some(&Value::Bool(false)) {
            return Err("Slack needs sign-in. Connect Slack in Settings → Connections.".into());
        }
        bundle.access_token = slack_oauth_value(&value, "access_token")?;
        bundle.refresh_token =
            slack_oauth_optional(&value, "refresh_token").or(bundle.refresh_token);
        bundle.expires_at =
            slack_oauth_i64(&value, "expires_in").map(|seconds| unix_seconds() + seconds);
        write_secret(
            MIMIR_KEYCHAIN_SERVICE,
            &format!("slack:{}", self.slack_account),
            &serde_json::to_string(&bundle.as_stored()).map_err(|error| error.to_string())?,
        )?;
        Ok(bundle.access_token)
    }

    async fn slack_search(&self, input: &Value) -> Result<Value, String> {
        self.slack_api(
            "search.messages",
            Method::GET,
            &[
                ("query", required_string(input, "query")?),
                ("count", int(input, "limit", 20, 1, 100).to_string()),
            ],
            None,
        )
        .await
    }

    async fn slack_read(&self, input: &Value) -> Result<Value, String> {
        let channel = required_string(input, "channel")?;
        let limit = int(input, "limit", 50, 1, 100).to_string();
        let mut query = vec![("channel", channel), ("limit", limit)];
        let method = if let Some(thread) = string(input, "thread_ts") {
            query.push(("ts", thread));
            "conversations.replies"
        } else {
            "conversations.history"
        };
        if let Some(cursor) = string(input, "cursor") {
            query.push(("cursor", cursor));
        }
        self.slack_api(method, Method::GET, &query, None).await
    }

    async fn slack_send(&self, input: &Value) -> Result<Value, String> {
        self.slack_api(
            "chat.postMessage",
            Method::POST,
            &[],
            Some(json!({
                "channel": required_string(input, "channel")?,
                "text": required_string(input, "text")?,
                "thread_ts": string(input, "thread_ts")
            })),
        )
        .await
    }

    async fn granola_json(
        &self,
        endpoint: &str,
        query: &[(&str, String)],
    ) -> Result<Value, String> {
        let bundle = granola_bundle()?.ok_or_else(|| {
            "Granola is not connected. Connect Granola in Settings → Connections.".to_string()
        })?;
        let response = self
            .http
            .get(format!("{GRANOLA_API_ROOT}{endpoint}"))
            .bearer_auth(bundle.api_key)
            .query(query)
            .send()
            .await
            .map_err(|error| error.to_string())?;
        let status = response.status();
        let value = response
            .json::<Value>()
            .await
            .map_err(|error| format!("Granola returned invalid JSON: {error}"))?;
        if !status.is_success() {
            return Err(format!(
                "Granola request failed with HTTP {status}{}",
                remote_error_suffix(&value.to_string())
            ));
        }
        Ok(value)
    }

    async fn granola_search(&self, input: &Value) -> Result<Value, String> {
        let limit = int(input, "limit", 10, 1, 30);
        let mut query = vec![("page_size", limit.to_string())];
        if let Some(value) = string(input, "from") {
            query.push(("created_after", value));
        }
        if let Some(value) = string(input, "to") {
            query.push(("created_before", value));
        }
        if let Some(value) = string(input, "cursor") {
            query.push(("cursor", value));
        }
        let mut value = self.granola_json("/notes", &query).await?;
        if let Some(needle) = string(input, "query").map(|value| value.to_lowercase()) {
            if let Some(notes) = value.get_mut("notes").and_then(Value::as_array_mut) {
                notes.retain(|note| {
                    [
                        note.get("title").and_then(Value::as_str),
                        note.pointer("/owner/name").and_then(Value::as_str),
                        note.pointer("/owner/email").and_then(Value::as_str),
                    ]
                    .into_iter()
                    .flatten()
                    .any(|field| field.to_lowercase().contains(&needle))
                });
            }
        }
        Ok(value)
    }

    async fn granola_get(&self, input: &Value) -> Result<Value, String> {
        let id = required_string(input, "id")?;
        let query = input
            .get("transcript")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            .then(|| ("include", "transcript".to_string()))
            .into_iter()
            .collect::<Vec<_>>();
        let mut value = self
            .granola_json(&format!("/notes/{}", url_encode(&id)), &query)
            .await?;
        let max_chars = int(input, "max_chars", 20_000, 1_000, 50_000) as usize;
        if let Some(markdown) = value.get_mut("summary_markdown") {
            if let Some(text) = markdown.as_str() {
                *markdown = Value::String(truncate(text, max_chars));
            }
        }
        Ok(value)
    }
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

fn read_secret(account: &str) -> Result<Option<Secret>, String> {
    let entry =
        keyring::Entry::new(MIMIR_KEYCHAIN_SERVICE, account).map_err(|error| error.to_string())?;
    match entry.get_password() {
        Ok(value) if !value.trim().is_empty() => Ok(Some(Secret { value })),
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn write_secret(service: &str, account: &str, value: &str) -> Result<(), String> {
    keyring::Entry::new(service, account)
        .map_err(|error| error.to_string())?
        .set_password(value)
        .map_err(|error| error.to_string())
}

fn delete_secret(account: &str) -> Result<(), String> {
    let entry =
        keyring::Entry::new(MIMIR_KEYCHAIN_SERVICE, account).map_err(|error| error.to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn object_schema(properties: Value, required: &[&str]) -> Value {
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false
    })
}

fn google_object_schema(
    mut properties: Value,
    required: &[&str],
    accounts: &[&GoogleAccount],
    default_account: Option<&str>,
) -> Value {
    let emails = accounts
        .iter()
        .map(|account| account.email.clone())
        .collect::<Vec<_>>();
    let mut account = json!({
        "type": "string",
        "description": "Connected Google account email. Uses the marked default when omitted.",
        "enum": emails,
    });
    if let Some(default) = default_account.and_then(|default| {
        accounts
            .iter()
            .find(|account| account.id.eq_ignore_ascii_case(default))
            .map(|account| account.email.clone())
    }) {
        account["default"] = Value::String(default);
    }
    if let Some(properties) = properties.as_object_mut() {
        properties.insert("account".into(), account);
    }
    object_schema(properties, required)
}

fn connection_annotations(canonical: &str) -> ToolAnnotations {
    let write = matches!(canonical, "gmail.send" | "calendar.create" | "slack.send");
    ToolAnnotations {
        read_only_hint: Some(!write),
        destructive_hint: Some(false),
        idempotent_hint: (!write).then_some(true),
    }
}

fn gmail_summary(message: &Value) -> Value {
    let headers = gmail_headers(message.get("payload"));
    json!({
        "id": message.get("id"),
        "threadId": message.get("threadId"),
        "from": headers.get("from"),
        "subject": headers.get("subject"),
        "date": headers.get("date"),
        "snippet": message.get("snippet"),
        "internalDate": message.get("internalDate")
    })
}

fn read_gmail_message(message: &Value) -> Value {
    let headers = gmail_headers(message.get("payload"));
    let body = gmail_body(message.get("payload")).unwrap_or_default();
    json!({
        "id": message.get("id"),
        "threadId": message.get("threadId"),
        "labelIds": message.get("labelIds"),
        "snippet": message.get("snippet"),
        "internalDate": message.get("internalDate"),
        "from": headers.get("from"),
        "to": headers.get("to"),
        "cc": headers.get("cc"),
        "subject": headers.get("subject"),
        "date": headers.get("date"),
        "messageId": headers.get("message-id"),
        "body": body
    })
}

fn gmail_headers(payload: Option<&Value>) -> std::collections::HashMap<String, String> {
    payload
        .and_then(|value| value.get("headers"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|header| {
            Some((
                header.get("name")?.as_str()?.to_lowercase(),
                header.get("value")?.as_str()?.to_string(),
            ))
        })
        .collect()
}

fn gmail_body(payload: Option<&Value>) -> Option<String> {
    let payload = payload?;
    if let Some(parts) = payload.get("parts").and_then(Value::as_array) {
        for preferred in ["text/plain", "text/html"] {
            for part in parts {
                if part.get("mimeType").and_then(Value::as_str) == Some(preferred) {
                    if let Some(value) = gmail_body(Some(part)) {
                        return Some(value);
                    }
                }
            }
        }
        for part in parts {
            if let Some(value) = gmail_body(Some(part)) {
                return Some(value);
            }
        }
    }
    let data = payload.pointer("/body/data")?.as_str()?;
    let decoded = URL_SAFE_NO_PAD.decode(data.trim_end_matches('=')).ok()?;
    let text = String::from_utf8_lossy(&decoded).to_string();
    if payload.get("mimeType").and_then(Value::as_str) == Some("text/html") {
        Some(strip_html(&text))
    } else {
        Some(text)
    }
}

fn strip_html(input: &str) -> String {
    let mut output = String::new();
    let mut tag = false;
    for character in input.chars() {
        match character {
            '<' => tag = true,
            '>' => {
                tag = false;
                if !output.ends_with([' ', '\n']) {
                    output.push(' ');
                }
            }
            _ if !tag => output.push(character),
            _ => {}
        }
    }
    output.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn remote_error_suffix(raw: &str) -> String {
    let message = serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|value| {
            value
                .pointer("/error/message")
                .or_else(|| value.get("error_description"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_default();
    if message.is_empty() {
        String::new()
    } else {
        format!(": {}", truncate(&message, 240))
    }
}

fn drive_mime(kind: Option<&str>) -> Option<&'static str> {
    match kind {
        Some("document") => Some("mimeType = 'application/vnd.google-apps.document'"),
        Some("spreadsheet") => Some("mimeType = 'application/vnd.google-apps.spreadsheet'"),
        Some("presentation") => Some("mimeType = 'application/vnd.google-apps.presentation'"),
        Some("pdf") => Some("mimeType = 'application/pdf'"),
        Some("folder") => Some("mimeType = 'application/vnd.google-apps.folder'"),
        Some("image") => Some("mimeType contains 'image/'"),
        _ => None,
    }
}

fn spreadsheet_text(spreadsheet: &Value) -> String {
    let mut output = String::new();
    if let Some(title) = spreadsheet
        .pointer("/properties/title")
        .and_then(Value::as_str)
    {
        output.push_str("# Spreadsheet: ");
        output.push_str(title.trim());
        output.push_str("\n\n");
    }
    for (sheet_index, sheet) in spreadsheet
        .get("sheets")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
    {
        let title = sheet
            .pointer("/properties/title")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("Sheet {}", sheet_index + 1));
        output.push_str("## Sheet: ");
        output.push_str(&title);
        output.push('\n');

        let mut rows =
            std::collections::BTreeMap::<usize, std::collections::BTreeMap<usize, String>>::new();
        for grid in sheet
            .get("data")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let start_row = grid.get("startRow").and_then(Value::as_u64).unwrap_or(0) as usize;
            let start_column =
                grid.get("startColumn").and_then(Value::as_u64).unwrap_or(0) as usize;
            for (row_offset, row) in grid
                .get("rowData")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .enumerate()
            {
                for (column_offset, cell) in row
                    .get("values")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .enumerate()
                {
                    let value = sheet_cell_text(cell);
                    if !value.is_empty() {
                        rows.entry(start_row + row_offset)
                            .or_default()
                            .insert(start_column + column_offset, value);
                    }
                }
            }
        }
        if rows.is_empty() {
            output.push_str("(no populated cells)\n\n");
            continue;
        }
        for (row_index, cells) in rows {
            let last_column = cells.keys().next_back().copied().unwrap_or(0);
            let values = (0..=last_column)
                .map(|column| cells.get(&column).cloned().unwrap_or_default())
                .collect::<Vec<_>>();
            output.push_str(&(row_index + 1).to_string());
            output.push('\t');
            output.push_str(&values.join("\t"));
            output.push('\n');
        }
        output.push('\n');
    }
    output.trim_end().to_string()
}

fn sheet_cell_text(cell: &Value) -> String {
    let value = cell
        .get("formattedValue")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            let effective = cell.get("effectiveValue")?;
            effective
                .get("stringValue")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| effective.get("numberValue").map(|value| value.to_string()))
                .or_else(|| {
                    effective
                        .get("boolValue")
                        .and_then(Value::as_bool)
                        .map(|value| value.to_string())
                })
                .or_else(|| {
                    effective
                        .pointer("/errorValue/message")
                        .and_then(Value::as_str)
                        .map(|value| format!("#ERROR: {value}"))
                })
        })
        .unwrap_or_default();
    value.replace(['\r', '\n', '\t'], " ").trim().to_string()
}

fn presentation_text(presentation: &Value) -> String {
    let mut output = String::new();
    if let Some(title) = presentation.get("title").and_then(Value::as_str) {
        output.push_str("# Presentation: ");
        output.push_str(title.trim());
        output.push_str("\n\n");
    }
    for (index, slide) in presentation
        .get("slides")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
    {
        output.push_str(&format!("## Slide {}\n", index + 1));
        let mut blocks = Vec::new();
        for element in slide
            .get("pageElements")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            slide_element_text(element, &mut blocks);
        }
        let notes = slide
            .pointer("/slideProperties/notesPage/pageElements")
            .and_then(Value::as_array)
            .map(|elements| {
                let mut notes = Vec::new();
                for element in elements {
                    slide_element_text(element, &mut notes);
                }
                notes
            })
            .unwrap_or_default();
        if blocks.is_empty() {
            output.push_str("(no text)\n");
        } else {
            output.push_str(&blocks.join("\n"));
            output.push('\n');
        }
        if !notes.is_empty() {
            output.push_str("\nSpeaker notes:\n");
            output.push_str(&notes.join("\n"));
            output.push('\n');
        }
        output.push('\n');
    }
    output.trim_end().to_string()
}

fn slide_element_text(element: &Value, output: &mut Vec<String>) {
    if let Some(shape) = element.get("shape") {
        if let Some(text) = shape.get("text") {
            push_text_content(text, output);
        }
    }
    if let Some(word_art) = element
        .pointer("/wordArt/renderedText")
        .and_then(Value::as_str)
        .map(clean_text_block)
        .filter(|value| !value.is_empty())
    {
        output.push(word_art);
    }
    if let Some(rows) = element
        .pointer("/table/tableRows")
        .and_then(Value::as_array)
    {
        for row in rows {
            let cells = row
                .get("tableCells")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|cell| text_content(cell.get("text").unwrap_or(&Value::Null)))
                .collect::<Vec<_>>();
            if cells.iter().any(|cell| !cell.is_empty()) {
                output.push(cells.join("\t"));
            }
        }
    }
    for child in element
        .pointer("/elementGroup/children")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        slide_element_text(child, output);
    }
}

fn push_text_content(text: &Value, output: &mut Vec<String>) {
    let content = text_content(text);
    if !content.is_empty() {
        output.push(content);
    }
}

fn text_content(text: &Value) -> String {
    let content = text
        .get("textElements")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|element| element.pointer("/textRun/content").and_then(Value::as_str))
        .collect::<String>();
    clean_text_block(&content)
}

fn clean_text_block(value: &str) -> String {
    value
        .replace('\r', "")
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn escape_drive_query(value: &str) -> String {
    value.replace('\\', "\\\\").replace('\'', "\\'")
}

fn safe_header(value: &str) -> String {
    value.replace(['\r', '\n'], " ").trim().to_string()
}

fn reply_subject(value: &str) -> String {
    if value.to_lowercase().starts_with("re:") {
        value.to_string()
    } else {
        format!("Re: {value}")
    }
}

fn string(input: &Value, key: &str) -> Option<String> {
    input
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn required_string(input: &Value, key: &str) -> Result<String, String> {
    string(input, key).ok_or_else(|| format!("{key} is required."))
}

fn required_json_string(input: &Value, key: &str) -> Result<String, String> {
    input
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{key} is missing."))
}

fn int(input: &Value, key: &str, fallback: i64, minimum: i64, maximum: i64) -> i64 {
    input
        .get(key)
        .and_then(Value::as_i64)
        .unwrap_or(fallback)
        .clamp(minimum, maximum)
}

fn url_encode(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

fn truncate(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        return value.to_string();
    }
    value
        .chars()
        .take(limit.saturating_sub(1))
        .collect::<String>()
        + "…"
}

fn unix_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

struct OauthLoopback {
    listener: tokio::net::TcpListener,
    redirect_uri: String,
    state: String,
    verifier: String,
    challenge: String,
}

impl OauthLoopback {
    async fn new() -> Result<Self, String> {
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|error| format!("Mimir could not start the sign-in callback: {error}"))?;
        let port = listener
            .local_addr()
            .map_err(|error| error.to_string())?
            .port();
        let verifier = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        Ok(Self {
            listener,
            redirect_uri: format!("http://127.0.0.1:{port}/callback"),
            state: uuid::Uuid::new_v4().simple().to_string(),
            verifier,
            challenge,
        })
    }

    async fn receive_code(&self) -> Result<String, String> {
        let (mut stream, _) =
            tokio::time::timeout(Duration::from_secs(180), self.listener.accept())
                .await
                .map_err(|_| "Sign-in timed out. Try Connect again.".to_string())?
                .map_err(|error| {
                    format!("Mimir could not receive the sign-in callback: {error}")
                })?;
        let mut request = vec![0u8; 8192];
        let length = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut request))
            .await
            .map_err(|_| "The sign-in callback did not finish.".to_string())?
            .map_err(|error| error.to_string())?;
        let request = String::from_utf8_lossy(&request[..length]);
        let target = request
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .ok_or_else(|| "The sign-in callback was invalid.".to_string())?;
        let callback = url::Url::parse(&format!("http://127.0.0.1{target}"))
            .map_err(|_| "The sign-in callback URL was invalid.".to_string())?;
        let values = callback
            .query_pairs()
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect::<std::collections::HashMap<_, _>>();
        let success = values.get("state") == Some(&self.state) && values.contains_key("code");
        let body = if success {
            "<!doctype html><meta charset=\"utf-8\"><title>Mimir connected</title><p>Connected. You can close this page and return to Mimir.</p>"
        } else {
            "<!doctype html><meta charset=\"utf-8\"><title>Mimir sign-in stopped</title><p>Mimir could not complete sign-in. Return to Mimir and try again.</p>"
        };
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        let _ = stream.write_all(response.as_bytes()).await;
        if values.get("state") != Some(&self.state) {
            return Err("Sign-in returned an invalid security state. Try again.".into());
        }
        if let Some(error) = values.get("error") {
            return Err(format!("Sign-in was not completed: {error}"));
        }
        values
            .get("code")
            .cloned()
            .ok_or_else(|| "Sign-in returned no authorization code.".to_string())
    }
}

fn open_system_browser(url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(target_os = "linux")]
    let mut command = std::process::Command::new("xdg-open");
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = std::process::Command::new("cmd");
        command.args(["/C", "start", ""]);
        command
    };
    command
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Mimir could not open the sign-in page: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn google_bundle_for_test(expires_at: Option<i64>, refresh: Option<&str>) -> GoogleBundle {
        GoogleBundle {
            access_token: "token".into(),
            refresh_token: refresh.map(str::to_string),
            expires_at,
            scope: GOOGLE_SCOPES.into(),
            auth: Some(json!({ "email": "work@example.com", "client_id": "client" })),
        }
    }

    fn google_store_for_test(emails: &[&str]) -> GoogleStore {
        let accounts = emails
            .iter()
            .map(|email| GoogleAccount {
                id: email.to_lowercase(),
                email: (*email).into(),
                name: None,
                bundle: google_bundle_for_test(None, Some("refresh")),
            })
            .collect::<Vec<_>>();
        GoogleStore {
            default_account: accounts.first().map(|account| account.id.clone()),
            accounts,
        }
    }

    #[test]
    fn expired_google_connection_only_needs_sign_in_without_refresh_token() {
        assert!(google_needs_sign_in(&google_bundle_for_test(
            Some(unix_seconds() - 1),
            None,
        )));
        assert!(!google_needs_sign_in(&google_bundle_for_test(
            Some(unix_seconds() - 1),
            Some("refresh"),
        )));
    }

    #[test]
    fn utility_encoders_keep_queries_and_headers_safe() {
        assert_eq!(escape_drive_query("Rob's \\ draft"), "Rob\\'s \\\\ draft");
        assert_eq!(safe_header("hello\r\nBcc: x"), "hello  Bcc: x");
        assert_eq!(reply_subject("Status"), "Re: Status");
        assert_eq!(reply_subject("RE: Status"), "RE: Status");
    }

    #[test]
    fn slack_personal_token_accepts_only_user_tokens() {
        assert_eq!(
            slack_personal_token(" xoxp-example ").unwrap(),
            "xoxp-example"
        );
        assert!(slack_personal_token("xoxb-example").is_err());
        assert!(slack_personal_token("").is_err());
    }

    #[test]
    fn google_scopes_cover_calendar_discovery_and_availability() {
        assert!(GOOGLE_SCOPES
            .contains("https://www.googleapis.com/auth/calendar.calendarlist.readonly"));
        assert!(GOOGLE_SCOPES.contains("https://www.googleapis.com/auth/calendar.events.freebusy"));
    }

    #[test]
    fn google_registration_includes_calendar_discovery_and_freebusy() {
        let registry = ToolRegistry::default();
        let runtime = ConnectionRuntime {
            http: Client::new(),
            slack_account: DEFAULT_ACCOUNT.into(),
        };
        let store = google_store_for_test(&["work@example.com", "me@example.net"]);
        register_google_tools(&registry, &runtime, &store).unwrap();
        let names = registry
            .snapshot()
            .tools
            .into_iter()
            .map(|tool| tool.canonical_name)
            .collect::<std::collections::HashSet<_>>();
        assert!(names.contains("calendar.calendars"));
        assert!(names.contains("calendar.freebusy"));
        assert!(names.contains("drive.read"));
        let gmail = registry.descriptor("gmail.search").unwrap();
        assert_eq!(
            gmail.input_schema["properties"]["account"]["enum"],
            json!(["work@example.com", "me@example.net"])
        );
        assert_eq!(
            gmail.input_schema["properties"]["account"]["default"],
            "work@example.com"
        );
    }

    #[test]
    fn google_accounts_keep_one_default_and_resolve_explicit_email() {
        let mut store = google_store_for_test(&["work@example.com"]);
        upsert_google_account(
            &mut store,
            GoogleAccount {
                id: "ME@EXAMPLE.NET".into(),
                email: "me@example.net".into(),
                name: Some("Personal".into()),
                bundle: google_bundle_for_test(None, Some("refresh")),
            },
        );
        assert_eq!(
            resolve_google_account(&store, None).unwrap().email,
            "work@example.com"
        );
        assert_eq!(
            resolve_google_account(&store, Some("ME@example.net"))
                .unwrap()
                .email,
            "me@example.net"
        );
        store.default_account = Some("me@example.net".into());
        normalize_google_store(&mut store);
        assert_eq!(
            resolve_google_account(&store, None).unwrap().email,
            "me@example.net"
        );
    }

    #[test]
    fn spreadsheet_content_keeps_tabs_rows_and_sheet_names() {
        let spreadsheet = json!({
            "properties": { "title": "Pipeline" },
            "sheets": [{
                "properties": { "title": "Q3" },
                "data": [{
                    "startRow": 1,
                    "startColumn": 0,
                    "rowData": [
                        { "values": [
                            { "formattedValue": "Client" },
                            { "formattedValue": "Value" }
                        ] },
                        { "values": [
                            { "formattedValue": "Acme\nLabs" },
                            { "effectiveValue": { "numberValue": 42 } }
                        ] }
                    ]
                }]
            }]
        });
        assert_eq!(
            spreadsheet_text(&spreadsheet),
            "# Spreadsheet: Pipeline\n\n## Sheet: Q3\n2\tClient\tValue\n3\tAcme Labs\t42"
        );
    }

    #[test]
    fn presentation_content_includes_shapes_tables_groups_and_notes() {
        let presentation = json!({
            "title": "Pitch",
            "slides": [{
                "pageElements": [
                    { "shape": { "text": { "textElements": [
                        { "textRun": { "content": "Opening\n" } }
                    ] } } },
                    { "table": { "tableRows": [{ "tableCells": [
                        { "text": { "textElements": [
                            { "textRun": { "content": "A" } }
                        ] } },
                        { "text": { "textElements": [
                            { "textRun": { "content": "B" } }
                        ] } }
                    ] }] } },
                    { "elementGroup": { "children": [
                        { "wordArt": { "renderedText": "Grouped" } }
                    ] } }
                ],
                "slideProperties": { "notesPage": { "pageElements": [
                    { "shape": { "text": { "textElements": [
                        { "textRun": { "content": "Ask about timing." } }
                    ] } } }
                ] } }
            }]
        });
        assert_eq!(
            presentation_text(&presentation),
            "# Presentation: Pitch\n\n## Slide 1\nOpening\nA\tB\nGrouped\n\nSpeaker notes:\nAsk about timing."
        );
    }

    #[test]
    fn provider_tools_have_provider_ownership() {
        let registry = ToolRegistry::default();
        let runtime = ConnectionRuntime {
            http: Client::new(),
            slack_account: DEFAULT_ACCOUNT.into(),
        };
        register_slack_tools(&registry, &runtime).unwrap();
        assert!(registry.snapshot().tools.iter().all(|tool| {
            tool.owner == ToolOwner::Provider("slack".into())
                && tool.source == ToolSource::Integration("slack".into())
        }));
    }
}
