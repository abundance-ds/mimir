use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use reqwest::{header::RETRY_AFTER, Client, Method, StatusCode};
use rusqlite::{params, params_from_iter, Connection};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use crate::tool_registry::{
    ToolAnnotations, ToolCallContext, ToolDescriptor, ToolError, ToolErrorCode, ToolOwner,
    ToolRegistration, ToolRegistry, ToolResult, ToolSource,
};

const MIMIR_KEYCHAIN_SERVICE: &str = "rs.shoulde.mimir";
const LEGACY_KEYCHAIN_SERVICE: &str = concat!("M", "i", "m");
const DEFAULT_ACCOUNT: &str = "default";

#[derive(Clone)]
struct ConnectionRuntime {
    http: Client,
    google_account: String,
    slack_account: String,
}

#[derive(Clone)]
struct Secret {
    value: String,
    service: &'static str,
}

pub(crate) fn register_native_tools(registry: &ToolRegistry) -> Result<(), String> {
    let settings = read_connection_settings();
    let legacy_defaults = read_legacy_connection_defaults();
    let google_account = connection_account(&settings, &legacy_defaults, "google");
    let slack_account = connection_account(&settings, &legacy_defaults, "slack");
    let runtime = ConnectionRuntime {
        http: Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|error| error.to_string())?,
        google_account: google_account.clone(),
        slack_account: slack_account.clone(),
    };

    // Credential-backed connections must be explicitly configured before
    // startup probes Keychain. The old unconditional probe produced multiple
    // password dialogs even though no Google or Slack tools were registered.
    if credential_connection_declared(&settings, &legacy_defaults, "google") {
        if let Some(bundle) = google_bundle(&google_account).ok().flatten() {
            register_google_tools(registry, &runtime, &bundle)?;
        }
    }
    if credential_connection_declared(&settings, &legacy_defaults, "slack")
        && slack_token(&slack_account).ok().flatten().is_some()
    {
        register_slack_tools(registry, &runtime)?;
    }
    if enabled(&settings, "granola") {
        register_granola_tools(registry, &runtime)?;
    }
    Ok(())
}

pub(crate) fn local_diagnostics() -> Value {
    let settings = read_connection_settings();
    let legacy_defaults = read_legacy_connection_defaults();
    let google_account = connection_account(&settings, &legacy_defaults, "google");
    let slack_account = connection_account(&settings, &legacy_defaults, "slack");

    let google = if !enabled(&settings, "google") {
        connection_diagnostic("disabled", "disabled in settings", Some(&google_account))
    } else {
        match google_bundle(&google_account) {
            Ok(Some(_)) => connection_diagnostic(
                "configured",
                "credentials found; remote service not checked",
                Some(&google_account),
            ),
            Ok(None) => {
                connection_diagnostic("missing", "credentials not found", Some(&google_account))
            }
            Err(error) => connection_diagnostic(
                "error",
                &format!("keychain or credential error: {}", truncate(&error, 160)),
                Some(&google_account),
            ),
        }
    };
    let slack = if !enabled(&settings, "slack") {
        connection_diagnostic("disabled", "disabled in settings", Some(&slack_account))
    } else {
        match slack_token(&slack_account) {
            Ok(Some(_)) => connection_diagnostic(
                "configured",
                "credential found; remote service not checked",
                Some(&slack_account),
            ),
            Ok(None) => {
                connection_diagnostic("missing", "credential not found", Some(&slack_account))
            }
            Err(error) => connection_diagnostic(
                "error",
                &format!("keychain error: {}", truncate(&error, 160)),
                Some(&slack_account),
            ),
        }
    };
    let granola = if !enabled(&settings, "granola") {
        connection_diagnostic("disabled", "disabled in settings", None)
    } else {
        let cache = granola_db_path().exists();
        let token_path = granola_token_path();
        let token = granola_has_token(&token_path);
        match (cache, token, token_path.exists()) {
            (true, true, _) => {
                connection_diagnostic("configured", "local cache and sync credential found", None)
            }
            (true, false, _) => {
                connection_diagnostic("configured", "local cache found; sync unavailable", None)
            }
            (false, true, _) => connection_diagnostic(
                "configured",
                "sync credential found; local cache not created yet",
                None,
            ),
            (false, false, true) => {
                connection_diagnostic("error", "local token state is not usable", None)
            }
            (false, false, false) => {
                connection_diagnostic("missing", "cache and credential not found", None)
            }
        }
    };

    json!({
        "remoteChecked": false,
        "google": google,
        "slack": slack,
        "granola": granola,
    })
}

fn connection_diagnostic(status: &str, detail: &str, account: Option<&str>) -> Value {
    json!({
        "status": status,
        "detail": detail,
        "account": account,
    })
}

fn register_google_tools(
    registry: &ToolRegistry,
    runtime: &ConnectionRuntime,
    bundle: &GoogleBundle,
) -> Result<(), String> {
    if bundle.has_any(&[
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
            object_schema(
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
            object_schema(
                json!({
                    "message_id": { "type": "string" },
                    "thread_id": { "type": "string" }
                }),
                &[],
            ),
        )?;
    }
    if bundle.has_any(&[
        "https://www.googleapis.com/auth/gmail.send",
        "https://mail.google.com/",
    ]) {
        register(
            registry,
            runtime,
            "gmail.send",
            "gmail_send",
            "Send or reply to Gmail.",
            object_schema(
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
    if bundle.has_any(&[
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
            object_schema(
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
    if bundle.has_any(&[
        "https://www.googleapis.com/auth/calendar.events",
        "https://www.googleapis.com/auth/calendar",
    ]) {
        register(
            registry,
            runtime,
            "calendar.create",
            "calendar_create",
            "Create a Google Calendar event.",
            object_schema(
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
    if bundle.has_any(&[
        "https://www.googleapis.com/auth/drive.readonly",
        "https://www.googleapis.com/auth/drive",
    ]) {
        register(
            registry,
            runtime,
            "drive.search",
            "drive_search",
            "Search Google Drive files.",
            object_schema(
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
            "Read Drive metadata and text content when available.",
            object_schema(
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
    let cache = granola_db_path();
    let token = granola_token_path();
    let (reads_available, sync_available) =
        granola_capabilities(cache.exists(), granola_has_token(&token));
    if reads_available {
        register(
            registry,
            runtime,
            "granola.search",
            "granola_search",
            "Search synced Granola meetings.",
            object_schema(
                json!({
                    "query": { "type": "string" },
                    "attendee": { "type": "string" },
                    "from": { "type": "string" },
                    "to": { "type": "string" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 50, "default": 10 },
                    "offset": { "type": "integer", "minimum": 0, "default": 0 }
                }),
                &[],
            ),
        )?;
        register(
            registry,
            runtime,
            "granola.get",
            "granola_get",
            "Read one synced Granola meeting.",
            object_schema(
                json!({
                    "id": { "type": "string", "minLength": 1 },
                    "transcript": { "type": "boolean", "default": false },
                    "transcript_limit": { "type": "integer", "minimum": 1, "maximum": 500, "default": 100 },
                    "max_chars": { "type": "integer", "minimum": 1000, "maximum": 50000, "default": 20000 }
                }),
                &["id"],
            ),
        )?;
    }
    if sync_available {
        register(
            registry,
            runtime,
            "granola.sync",
            "granola_sync",
            "Sync Granola meetings or one transcript.",
            object_schema(
                json!({
                    "full": {
                        "type": "boolean",
                        "default": false,
                        "description": "Fetch the complete remote set and prune deleted cached meetings only when every page is received."
                    },
                    "max_pages": { "type": "integer", "minimum": 1, "maximum": 100, "default": 20 },
                    "transcript_id": { "type": "string" }
                }),
                &[],
            ),
        )?;
    }
    Ok(())
}

fn granola_capabilities(cache_exists: bool, token_exists: bool) -> (bool, bool) {
    (cache_exists || token_exists, token_exists)
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
    let registration = ToolRegistration::new(
        ToolDescriptor::new(
            canonical,
            alias,
            description,
            schema,
            ToolOwner::Core,
            ToolSource::Native,
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
        match tool {
            "gmail.search" => self.gmail_search(&input).await,
            "gmail.read" => self.gmail_read(&input).await,
            "gmail.send" => self.gmail_send(&input).await,
            "calendar.list" => self.calendar_list(&input).await,
            "calendar.create" => self.calendar_create(&input).await,
            "drive.search" => self.drive_search(&input).await,
            "drive.read" => self.drive_read(&input).await,
            "slack.search" => self.slack_search(&input).await,
            "slack.read" => self.slack_read(&input).await,
            "slack.send" => self.slack_send(&input).await,
            "granola.search" => granola_search(&input),
            "granola.get" => granola_get(&input),
            "granola.sync" => self.granola_sync(&input).await,
            _ => Err(format!("Unknown connection tool: {tool}")),
        }
    }

    async fn google_request(
        &self,
        method: Method,
        url: &str,
        query: &[(&str, String)],
        body: Option<Value>,
    ) -> Result<reqwest::Response, String> {
        let token = self.google_access_token().await?;
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
        method: Method,
        url: &str,
        query: &[(&str, String)],
        body: Option<Value>,
    ) -> Result<Value, String> {
        self.google_request(method, url, query, body)
            .await?
            .json()
            .await
            .map_err(|error| format!("Google returned invalid JSON: {error}"))
    }

    async fn google_access_token(&self) -> Result<String, String> {
        let mut bundle = google_bundle(&self.google_account)?
            .ok_or_else(|| "Google is not connected.".to_string())?;
        if bundle.expires_at.unwrap_or(i64::MAX) > unix_seconds() + 60
            || bundle.refresh_token.is_none()
        {
            return Ok(bundle.access_token);
        }
        let client = google_client(&self.google_account)?
            .ok_or_else(|| "Google OAuth client is not configured.".to_string())?;
        let refresh_token = bundle.refresh_token.clone().unwrap_or_default();
        let form = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("client_id", &client.0)
            .append_pair("client_secret", &client.1)
            .append_pair("refresh_token", &refresh_token)
            .append_pair("grant_type", "refresh_token")
            .finish();
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
        write_secret(
            bundle.service,
            &format!("google:{}", self.google_account),
            &serde_json::to_string(&bundle.as_stored()).map_err(|error| error.to_string())?,
        )?;
        Ok(bundle.access_token)
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
        } else if mime.starts_with("text/")
            || matches!(mime, "application/json" | "application/xml")
        {
            Some(
                self.google_request(
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
        let token = slack_token(&self.slack_account)?
            .ok_or_else(|| "Slack is not connected.".to_string())?
            .value;
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

    async fn granola_sync(&self, input: &Value) -> Result<Value, String> {
        let transcript_id = string(input, "transcript_id");
        let mut tokens = load_granola_tokens()?;
        let access_token = self.granola_access_token(&mut tokens).await?;
        if let Some(id) = transcript_id {
            let data = self
                .granola_api(
                    &access_token,
                    "/v1/get-document-transcript",
                    json!({ "document_id": id }),
                )
                .await?;
            let entries = data
                .as_array()
                .cloned()
                .or_else(|| data.get("transcript").and_then(Value::as_array).cloned())
                .unwrap_or_default();
            let mut db = open_granola_db()?;
            let tx = db.transaction().map_err(|error| error.to_string())?;
            tx.execute("DELETE FROM transcripts WHERE note_id = ?1", [&id])
                .map_err(|error| error.to_string())?;
            for entry in &entries {
                tx.execute(
                    "INSERT INTO transcripts (note_id, text, start_time, source) VALUES (?1, ?2, ?3, ?4)",
                    params![
                        id,
                        entry.get("text").and_then(Value::as_str).unwrap_or(""),
                        entry
                            .get("start_timestamp")
                            .and_then(Value::as_str)
                            .unwrap_or(""),
                        entry.get("source").and_then(Value::as_str).unwrap_or("")
                    ],
                )
                .map_err(|error| error.to_string())?;
            }
            tx.commit().map_err(|error| error.to_string())?;
            return Ok(json!({ "ok": true, "transcriptId": id, "segments": entries.len() }));
        }

        let full = input.get("full").and_then(Value::as_bool).unwrap_or(false);
        let max_pages = int(input, "max_pages", 20, 1, 100);
        let db = open_granola_db()?;
        let last_updated = if full {
            None
        } else {
            db.query_row("SELECT MAX(updated_at) FROM notes", [], |row| {
                row.get::<_, Option<String>>(0)
            })
            .map_err(|error| error.to_string())?
        };
        let mut synced = 0usize;
        let mut fetched = 0usize;
        let mut pages = 0usize;
        let mut remote_ids = HashSet::new();
        let mut complete = false;
        for page in 0..max_pages {
            pages += 1;
            let data = self
                .granola_api(
                    &access_token,
                    "/v2/get-documents",
                    json!({
                        "limit": 100,
                        "offset": page * 100,
                        "include_last_viewed_panel": true
                    }),
                )
                .await?;
            let documents = data
                .get("docs")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            fetched += documents.len();
            remote_ids.extend(documents.iter().filter_map(|document| {
                document
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            }));
            let fresh = documents
                .iter()
                .filter(|document| {
                    last_updated.as_ref().is_none_or(|last| {
                        document
                            .get("updated_at")
                            .and_then(Value::as_str)
                            .is_some_and(|updated| updated > last.as_str())
                    })
                })
                .cloned()
                .collect::<Vec<_>>();
            if !fresh.is_empty() {
                granola_upsert_documents(&db, &fresh)?;
                synced += fresh.len();
            }
            if documents.len() < 100 {
                complete = true;
                break;
            }
            if !full && fresh.is_empty() {
                break;
            }
        }
        let pruned = granola_prune_if_complete(&db, full, complete, &remote_ids)?;
        let synced_at = chrono::Utc::now().to_rfc3339();
        db.execute(
            "INSERT INTO meta (key, value) VALUES ('last_sync_at', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [&synced_at],
        )
        .map_err(|error| error.to_string())?;
        Ok(json!({
            "ok": true,
            "synced": synced,
            "fetched": fetched,
            "pages": pages,
            "full": full,
            "complete": complete,
            "pruned": pruned,
            "syncedAt": synced_at
        }))
    }

    async fn granola_api(
        &self,
        access_token: &str,
        endpoint: &str,
        body: Value,
    ) -> Result<Value, String> {
        let response = self
            .http
            .post(format!("https://api.granola.ai{endpoint}"))
            .bearer_auth(access_token)
            .header("content-type", "application/json")
            .header("user-agent", "Granola/7.319.1")
            .header("x-client-version", "7.319.1")
            .header("x-granola-platform", std::env::consts::OS)
            .json(&body)
            .send()
            .await
            .map_err(|error| error.to_string())?;
        let status = response.status();
        let value = response
            .json::<Value>()
            .await
            .map_err(|error| format!("Granola returned invalid JSON: {error}"))?;
        if !status.is_success() {
            return Err(format!("Granola API {endpoint} failed with HTTP {status}"));
        }
        Ok(value)
    }

    async fn granola_access_token(&self, tokens: &mut GranolaTokens) -> Result<String, String> {
        if tokens.expires_at() > unix_seconds() + 120 {
            return Ok(tokens.access_token.clone());
        }
        let response = self
            .http
            .post("https://api.granola.ai/v1/refresh-access-token")
            .bearer_auth(&tokens.access_token)
            .json(&json!({ "refresh_token": tokens.refresh_token }))
            .send()
            .await
            .map_err(|error| error.to_string())?;
        let value = if response.status().is_success() {
            response
                .json::<Value>()
                .await
                .map_err(|error| error.to_string())?
        } else {
            let client_id = std::env::var("GRANOLA_WORKOS_CLIENT_ID")
                .unwrap_or_else(|_| "client_01JZJ0XBDAT8PHJWQY09Y0VD61".into());
            let response = self
                .http
                .post("https://api.workos.com/user_management/authenticate")
                .json(&json!({
                    "client_id": client_id,
                    "grant_type": "refresh_token",
                    "refresh_token": tokens.refresh_token
                }))
                .send()
                .await
                .map_err(|error| error.to_string())?;
            let status = response.status();
            let value = response
                .json::<Value>()
                .await
                .map_err(|error| error.to_string())?;
            if !status.is_success() {
                return Err(format!("Granola token refresh failed with HTTP {status}"));
            }
            value
        };
        tokens.access_token = required_json_string(&value, "access_token")?;
        tokens.refresh_token = value
            .get("refresh_token")
            .and_then(Value::as_str)
            .unwrap_or(&tokens.refresh_token)
            .to_string();
        tokens.expires_in = value
            .get("expires_in")
            .and_then(Value::as_i64)
            .unwrap_or(21_600);
        tokens.obtained_at = unix_millis();
        store_granola_tokens(tokens)?;
        Ok(tokens.access_token.clone())
    }
}

#[derive(Clone)]
struct GoogleBundle {
    access_token: String,
    refresh_token: Option<String>,
    expires_at: Option<i64>,
    scope: String,
    auth: Option<Value>,
    service: &'static str,
}

impl GoogleBundle {
    fn has_any(&self, scopes: &[&str]) -> bool {
        self.scope.trim().is_empty()
            || self
                .scope
                .split_whitespace()
                .any(|granted| scopes.contains(&granted))
    }

    fn as_stored(&self) -> Value {
        json!({
            "access_token": self.access_token,
            "refresh_token": self.refresh_token,
            "expires_at": self.expires_at,
            "scope": self.scope,
            "auth": self.auth
        })
    }
}

fn google_bundle(account: &str) -> Result<Option<GoogleBundle>, String> {
    let Some(secret) = read_secret(&format!("google:{account}"))? else {
        return Ok(None);
    };
    let value: Value = serde_json::from_str(&secret.value)
        .map_err(|_| "Invalid Google token bundle.".to_string())?;
    Ok(Some(GoogleBundle {
        access_token: required_json_string(&value, "access_token")?,
        refresh_token: value
            .get("refresh_token")
            .and_then(Value::as_str)
            .map(str::to_string),
        expires_at: value.get("expires_at").and_then(Value::as_i64),
        scope: value
            .get("scope")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        auth: value.get("auth").cloned(),
        service: secret.service,
    }))
}

fn google_client(account: &str) -> Result<Option<(String, String)>, String> {
    if let (Ok(id), Ok(secret)) = (
        std::env::var("MIMIR_GOOGLE_OAUTH_CLIENT_ID"),
        std::env::var("MIMIR_GOOGLE_OAUTH_CLIENT_SECRET"),
    ) {
        if !id.trim().is_empty() && !secret.trim().is_empty() {
            return Ok(Some((id, secret)));
        }
    }
    let Some(secret) = read_secret(&format!("google-client:{account}"))? else {
        return Ok(None);
    };
    let value: Value = serde_json::from_str(&secret.value)
        .map_err(|_| "Invalid Google OAuth client.".to_string())?;
    Ok(Some((
        required_json_string(&value, "client_id")?,
        required_json_string(&value, "client_secret")?,
    )))
}

fn slack_token(account: &str) -> Result<Option<Secret>, String> {
    read_secret(&format!("slack:{account}"))
}

fn read_secret(account: &str) -> Result<Option<Secret>, String> {
    for service in [MIMIR_KEYCHAIN_SERVICE, LEGACY_KEYCHAIN_SERVICE] {
        let entry = keyring::Entry::new(service, account).map_err(|error| error.to_string())?;
        match entry.get_password() {
            Ok(value) if !value.trim().is_empty() => return Ok(Some(Secret { value, service })),
            Ok(_) | Err(keyring::Error::NoEntry) => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(None)
}

fn write_secret(service: &str, account: &str, value: &str) -> Result<(), String> {
    keyring::Entry::new(service, account)
        .map_err(|error| error.to_string())?
        .set_password(value)
        .map_err(|error| error.to_string())
}

fn object_schema(properties: Value, required: &[&str]) -> Value {
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false
    })
}

fn connection_annotations(canonical: &str) -> ToolAnnotations {
    let write = matches!(
        canonical,
        "gmail.send" | "calendar.create" | "slack.send" | "granola.sync"
    );
    ToolAnnotations {
        read_only_hint: Some(!write),
        destructive_hint: Some(false),
        idempotent_hint: (!write).then_some(true),
    }
}

fn read_connection_settings() -> Value {
    let Some(home) = dirs::home_dir() else {
        return json!({});
    };
    fs::read_to_string(home.join(".mimir").join("settings.json"))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| json!({}))
}

fn read_legacy_connection_defaults() -> Value {
    let Some(home) = dirs::home_dir() else {
        return json!({});
    };
    let path = home
        .join(format!(".{}", concat!("m", "i", "m")))
        .join("config.yaml");
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_yaml::from_str::<Value>(&raw).ok())
        .and_then(|value| value.get("defaults").cloned())
        .unwrap_or_else(|| json!({}))
}

fn connection_account(settings: &Value, legacy_defaults: &Value, name: &str) -> String {
    settings
        .pointer(&format!("/connections/{name}/account"))
        .and_then(Value::as_str)
        .or_else(|| legacy_defaults.get(name).and_then(Value::as_str))
        .map(str::trim)
        .filter(|account| !account.is_empty())
        .unwrap_or(DEFAULT_ACCOUNT)
        .to_string()
}

fn enabled(settings: &Value, name: &str) -> bool {
    match settings.pointer(&format!("/connections/{name}")) {
        Some(Value::Bool(value)) => *value,
        Some(Value::Object(value)) => value
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        _ => true,
    }
}

fn credential_connection_declared(settings: &Value, legacy_defaults: &Value, name: &str) -> bool {
    if settings.pointer(&format!("/connections/{name}")).is_some() {
        return enabled(settings, name);
    }
    legacy_defaults
        .get(name)
        .and_then(Value::as_str)
        .is_some_and(|account| !account.trim().is_empty())
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

fn unix_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[derive(Clone)]
struct GranolaTokens {
    access_token: String,
    refresh_token: String,
    expires_in: i64,
    obtained_at: i64,
    token_path: PathBuf,
    root: Value,
}

impl GranolaTokens {
    fn expires_at(&self) -> i64 {
        self.obtained_at / 1000 + self.expires_in
    }
}

fn granola_token_path() -> PathBuf {
    std::env::var_os("GRANOLA_TOKEN_PATH")
        .map(PathBuf::from)
        .or_else(|| {
            dirs::home_dir().map(|home| {
                home.join("Library")
                    .join("Application Support")
                    .join("Granola")
                    .join("supabase.json")
            })
        })
        .unwrap_or_default()
}

fn granola_db_path() -> PathBuf {
    if let Some(path) = std::env::var_os("GRANOLA_MIMIR_DB_PATH") {
        return PathBuf::from(path);
    }
    let Some(home) = dirs::home_dir() else {
        return PathBuf::new();
    };
    let native = home
        .join(".mimir")
        .join("connections")
        .join("granola.sqlite");
    if native.exists() {
        return native;
    }
    let legacy = home
        .join(format!(".{}", concat!("m", "i", "m")))
        .join("private")
        .join("granola")
        .join("granola.sqlite");
    if legacy.exists() {
        legacy
    } else {
        native
    }
}

fn granola_has_token(path: &Path) -> bool {
    read_json(path)
        .and_then(|value| value.get("workos_tokens").cloned())
        .and_then(|value| value.as_str().map(str::to_string))
        .and_then(|value| serde_json::from_str::<Value>(&value).ok())
        .is_some_and(|value| value.get("access_token").and_then(Value::as_str).is_some())
        || stored_granola_tokens(path).is_some()
}

fn load_granola_tokens() -> Result<GranolaTokens, String> {
    let token_path = granola_token_path();
    let root = read_json(&token_path)
        .ok_or_else(|| "Granola token file is unavailable. Open Granola once.".to_string())?;
    let primary = root
        .get("workos_tokens")
        .and_then(Value::as_str)
        .and_then(|value| serde_json::from_str::<Value>(value).ok());
    let value = primary
        .or_else(|| stored_granola_tokens(&token_path))
        .ok_or_else(|| "Granola token file has no usable token.".to_string())?;
    Ok(GranolaTokens {
        access_token: required_json_string(&value, "access_token")?,
        refresh_token: required_json_string(&value, "refresh_token")?,
        expires_in: value
            .get("expires_in")
            .and_then(Value::as_i64)
            .unwrap_or(21_600),
        obtained_at: value
            .get("obtained_at")
            .and_then(Value::as_i64)
            .unwrap_or_else(unix_millis),
        token_path,
        root,
    })
}

fn stored_granola_tokens(token_path: &Path) -> Option<Value> {
    let root = read_json(&token_path.parent()?.join("stored-accounts.json"))?;
    let accounts = root.get("accounts")?.as_str()?;
    let accounts: Value = serde_json::from_str(accounts).ok()?;
    let token = accounts.as_array()?.first()?.get("tokens")?;
    match token {
        Value::String(value) => serde_json::from_str(value).ok(),
        Value::Object(_) => Some(token.clone()),
        _ => None,
    }
}

fn store_granola_tokens(tokens: &mut GranolaTokens) -> Result<(), String> {
    let value = json!({
        "access_token": tokens.access_token,
        "refresh_token": tokens.refresh_token,
        "expires_in": tokens.expires_in,
        "obtained_at": tokens.obtained_at
    });
    tokens.root["workos_tokens"] =
        Value::String(serde_json::to_string(&value).map_err(|error| error.to_string())?);
    crate::persistence::write_bytes_atomic(
        &tokens.token_path,
        serde_json::to_vec_pretty(&tokens.root)
            .map_err(|error| error.to_string())?
            .as_slice(),
    )
    .map_err(|error| error.to_string())
}

fn open_granola_db() -> Result<Connection, String> {
    let path = granola_db_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let db = Connection::open(path).map_err(|error| error.to_string())?;
    db.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA foreign_keys = ON;
         CREATE TABLE IF NOT EXISTS notes (
           id TEXT PRIMARY KEY, title TEXT, created_at TEXT, updated_at TEXT,
           owner_name TEXT, owner_email TEXT, summary_markdown TEXT,
           notes_markdown TEXT, calendar_start TEXT, calendar_end TEXT,
           synced_at INTEGER DEFAULT (unixepoch())
         );
         CREATE TABLE IF NOT EXISTS attendees (
           note_id TEXT REFERENCES notes(id) ON DELETE CASCADE, name TEXT, email TEXT
         );
         CREATE TABLE IF NOT EXISTS transcripts (
           note_id TEXT REFERENCES notes(id) ON DELETE CASCADE,
           text TEXT, start_time TEXT, source TEXT
         );
         CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
         CREATE INDEX IF NOT EXISTS idx_attendees_note ON attendees(note_id);
         CREATE INDEX IF NOT EXISTS idx_transcripts_note ON transcripts(note_id);
         CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at DESC);",
    )
    .map_err(|error| error.to_string())?;
    Ok(db)
}

fn granola_search(input: &Value) -> Result<Value, String> {
    let db = open_granola_db()?;
    let mut clauses = Vec::new();
    let mut values = Vec::<rusqlite::types::Value>::new();
    for term in string(input, "query")
        .unwrap_or_default()
        .split_whitespace()
        .take(8)
    {
        clauses.push(
            "(LOWER(COALESCE(n.title,'') || ' ' || COALESCE(n.summary_markdown,'') || ' ' || COALESCE(n.notes_markdown,'')) LIKE ? ESCAPE '\\'
              OR EXISTS (SELECT 1 FROM attendees ax WHERE ax.note_id = n.id AND LOWER(COALESCE(ax.name,'') || ' ' || COALESCE(ax.email,'')) LIKE ? ESCAPE '\\'))"
                .to_string(),
        );
        let pattern = like_pattern(term);
        values.push(pattern.clone().into());
        values.push(pattern.into());
    }
    if let Some(attendee) = string(input, "attendee") {
        clauses.push(
            "EXISTS (SELECT 1 FROM attendees aa WHERE aa.note_id = n.id AND LOWER(COALESCE(aa.name,'') || ' ' || COALESCE(aa.email,'')) LIKE ? ESCAPE '\\')"
                .to_string(),
        );
        values.push(like_pattern(&attendee).into());
    }
    if let Some(from) = string(input, "from") {
        clauses.push("COALESCE(n.calendar_start,n.created_at,n.updated_at) >= ?".into());
        values.push(date_bound(&from, false).into());
    }
    if let Some(to) = string(input, "to") {
        clauses.push("COALESCE(n.calendar_start,n.created_at,n.updated_at) <= ?".into());
        values.push(date_bound(&to, true).into());
    }
    let limit = int(input, "limit", 10, 1, 50);
    let offset = int(input, "offset", 0, 0, 100_000);
    values.push(limit.into());
    values.push(offset.into());
    let where_clause = if clauses.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", clauses.join(" AND "))
    };
    let sql = format!(
        "SELECT n.id,n.title,n.created_at,n.updated_at,n.calendar_start,n.calendar_end,
                n.owner_name,n.owner_email,n.summary_markdown,
                GROUP_CONCAT(a.name, char(31))
         FROM notes n LEFT JOIN attendees a ON a.note_id=n.id
         {where_clause}
         GROUP BY n.id
         ORDER BY COALESCE(n.calendar_start,n.created_at,n.updated_at) DESC
         LIMIT ? OFFSET ?"
    );
    let mut statement = db.prepare(&sql).map_err(|error| error.to_string())?;
    let notes = statement
        .query_map(params_from_iter(values), |row| {
            let attendees: String = row.get::<_, Option<String>>(9)?.unwrap_or_default();
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "title": row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                "createdAt": row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                "updatedAt": row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                "calendarStart": row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                "calendarEnd": row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                "owner": {
                    "name": row.get::<_, Option<String>>(6)?.unwrap_or_default(),
                    "email": row.get::<_, Option<String>>(7)?.unwrap_or_default()
                },
                "summary": truncate(&row.get::<_, Option<String>>(8)?.unwrap_or_default(), 1000),
                "attendees": attendees.split('\u{1f}').filter(|value| !value.is_empty()).collect::<Vec<_>>()
            }))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(json!({ "notes": notes, "limit": limit, "offset": offset }))
}

fn granola_get(input: &Value) -> Result<Value, String> {
    let id = required_string(input, "id")?;
    let db = open_granola_db()?;
    let note = db
        .query_row(
            "SELECT id,title,created_at,updated_at,calendar_start,calendar_end,
                    owner_name,owner_email,summary_markdown,notes_markdown
             FROM notes WHERE id=?1",
            [&id],
            |row| {
                Ok(json!({
                    "id": row.get::<_, String>(0)?,
                    "title": row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    "createdAt": row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                    "updatedAt": row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                    "calendarStart": row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                    "calendarEnd": row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                    "owner": {
                        "name": row.get::<_, Option<String>>(6)?.unwrap_or_default(),
                        "email": row.get::<_, Option<String>>(7)?.unwrap_or_default()
                    },
                    "summary": row.get::<_, Option<String>>(8)?.unwrap_or_default(),
                    "notes": row.get::<_, Option<String>>(9)?.unwrap_or_default()
                }))
            },
        )
        .map_err(|error| {
            if matches!(error, rusqlite::Error::QueryReturnedNoRows) {
                format!("Granola meeting '{id}' was not found.")
            } else {
                error.to_string()
            }
        })?;
    let attendees = db
        .prepare("SELECT name,email FROM attendees WHERE note_id=?1 ORDER BY name,email")
        .map_err(|error| error.to_string())?
        .query_map([&id], |row| {
            Ok(json!({
                "name": row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                "email": row.get::<_, Option<String>>(1)?.unwrap_or_default()
            }))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let max_chars = int(input, "max_chars", 20_000, 1_000, 50_000) as usize;
    let markdown = format!(
        "{}{}",
        note.get("summary")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(|value| format!("## Summary\n\n{value}\n\n"))
            .unwrap_or_default(),
        note.get("notes").and_then(Value::as_str).unwrap_or("")
    );
    let mut output = note;
    output["attendees"] = Value::Array(attendees);
    output["markdown"] = Value::String(truncate(&markdown, max_chars));
    if input
        .get("transcript")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        let limit = int(input, "transcript_limit", 100, 1, 500);
        let transcript = db
            .prepare(
                "SELECT text,start_time,source FROM transcripts
                 WHERE note_id=?1 ORDER BY start_time LIMIT ?2",
            )
            .map_err(|error| error.to_string())?
            .query_map(params![id, limit], |row| {
                Ok(json!({
                    "text": row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                    "startTime": row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    "source": row.get::<_, Option<String>>(2)?.unwrap_or_default()
                }))
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        output["transcript"] = Value::Array(transcript);
    }
    Ok(output)
}

fn granola_upsert_documents(db: &Connection, documents: &[Value]) -> Result<(), String> {
    db.execute_batch("BEGIN IMMEDIATE")
        .map_err(|error| error.to_string())?;
    let result = (|| {
        for document in documents {
            let id = document.get("id").and_then(Value::as_str).unwrap_or("");
            if id.is_empty() {
                continue;
            }
            let summary = document
                .pointer("/last_viewed_panel/content")
                .map(prosemirror_markdown)
                .unwrap_or_default();
            db.execute(
                "INSERT INTO notes (
                   id,title,created_at,updated_at,owner_name,owner_email,
                   summary_markdown,notes_markdown,calendar_start,calendar_end,synced_at
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,unixepoch())
                 ON CONFLICT(id) DO UPDATE SET
                   title=excluded.title,created_at=excluded.created_at,
                   updated_at=excluded.updated_at,owner_name=excluded.owner_name,
                   owner_email=excluded.owner_email,summary_markdown=excluded.summary_markdown,
                   notes_markdown=excluded.notes_markdown,calendar_start=excluded.calendar_start,
                   calendar_end=excluded.calendar_end,synced_at=excluded.synced_at",
                params![
                    id,
                    document.get("title").and_then(Value::as_str).unwrap_or(""),
                    document
                        .get("created_at")
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                    document
                        .get("updated_at")
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                    document
                        .pointer("/people/creator/name")
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                    document
                        .pointer("/people/creator/email")
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                    summary,
                    document
                        .get("notes_markdown")
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                    document
                        .pointer("/google_calendar_event/start/dateTime")
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                    document
                        .pointer("/google_calendar_event/end/dateTime")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                ],
            )
            .map_err(|error| error.to_string())?;
            db.execute("DELETE FROM attendees WHERE note_id=?1", [id])
                .map_err(|error| error.to_string())?;
            for attendee in document
                .pointer("/google_calendar_event/attendees")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                db.execute(
                    "INSERT INTO attendees (note_id,name,email) VALUES (?1,?2,?3)",
                    params![
                        id,
                        attendee
                            .get("displayName")
                            .and_then(Value::as_str)
                            .unwrap_or(""),
                        attendee.get("email").and_then(Value::as_str).unwrap_or("")
                    ],
                )
                .map_err(|error| error.to_string())?;
            }
        }
        Ok::<(), String>(())
    })();
    if result.is_ok() {
        db.execute_batch("COMMIT")
            .map_err(|error| error.to_string())?;
    } else {
        let _ = db.execute_batch("ROLLBACK");
    }
    result
}

fn granola_prune_if_complete(
    db: &Connection,
    full: bool,
    complete: bool,
    remote_ids: &HashSet<String>,
) -> Result<usize, String> {
    if !full || !complete {
        return Ok(0);
    }
    db.execute_batch(
        "BEGIN IMMEDIATE;
         CREATE TEMP TABLE IF NOT EXISTS granola_remote_ids (
           id TEXT PRIMARY KEY
         );
         DELETE FROM granola_remote_ids;",
    )
    .map_err(|error| error.to_string())?;
    let result = (|| {
        for id in remote_ids {
            db.execute(
                "INSERT OR IGNORE INTO granola_remote_ids (id) VALUES (?1)",
                [id],
            )
            .map_err(|error| error.to_string())?;
        }
        db.execute(
            "DELETE FROM notes WHERE id NOT IN (SELECT id FROM granola_remote_ids)",
            [],
        )
        .map_err(|error| error.to_string())
    })();
    if result.is_ok() {
        db.execute_batch("COMMIT")
            .map_err(|error| error.to_string())?;
    } else {
        let _ = db.execute_batch("ROLLBACK");
    }
    result
}

fn prosemirror_markdown(node: &Value) -> String {
    if let Some(text) = node.as_str() {
        return text.to_string();
    }
    let kind = node.get("type").and_then(Value::as_str).unwrap_or("");
    let children = node
        .get("content")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let inline = || {
        children
            .iter()
            .map(prosemirror_markdown)
            .collect::<String>()
    };
    match kind {
        "doc" => children
            .iter()
            .map(prosemirror_markdown)
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n"),
        "heading" => format!(
            "{} {}",
            "#".repeat(
                node.pointer("/attrs/level")
                    .and_then(Value::as_u64)
                    .unwrap_or(1)
                    .clamp(1, 6) as usize
            ),
            inline()
        ),
        "paragraph" => inline(),
        "text" => node
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        "hardBreak" => "\n".into(),
        _ => inline(),
    }
}

fn like_pattern(value: &str) -> String {
    format!(
        "%{}%",
        value
            .to_lowercase()
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    )
}

fn date_bound(value: &str, upper: bool) -> String {
    if value.len() == 10
        && value.as_bytes().get(4) == Some(&b'-')
        && value.as_bytes().get(7) == Some(&b'-')
    {
        format!(
            "{value}T{}",
            if upper {
                "23:59:59.999"
            } else {
                "00:00:00.000"
            }
        )
    } else {
        value.to_string()
    }
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_are_enabled_by_default_and_accept_boolean_or_object_disables() {
        assert!(enabled(&json!({}), "google"));
        assert!(!enabled(
            &json!({ "connections": { "google": false } }),
            "google"
        ));
        assert!(!enabled(
            &json!({ "connections": { "google": { "enabled": false } } }),
            "google"
        ));
    }

    #[test]
    fn startup_probes_only_declared_credential_connections() {
        assert!(!credential_connection_declared(
            &json!({}),
            &json!({}),
            "google"
        ));
        assert!(credential_connection_declared(
            &json!({ "connections": { "google": true } }),
            &json!({}),
            "google"
        ));
        assert!(!credential_connection_declared(
            &json!({ "connections": { "google": false } }),
            &json!({ "google": "legacy@example.com" }),
            "google"
        ));
        assert!(credential_connection_declared(
            &json!({}),
            &json!({ "google": "legacy@example.com" }),
            "google"
        ));
    }

    #[test]
    fn connection_accounts_prefer_mimir_then_predecessor_then_default() {
        let legacy = serde_yaml::from_str::<Value>(
            "defaults:\n  google: work@example.com\n  slack: team-one\n",
        )
        .unwrap();
        let legacy = legacy.get("defaults").unwrap();
        assert_eq!(
            connection_account(&json!({}), legacy, "google"),
            "work@example.com"
        );
        assert_eq!(
            connection_account(
                &json!({ "connections": { "google": { "account": "new-account" } } }),
                legacy,
                "google",
            ),
            "new-account"
        );
        assert_eq!(
            connection_account(&json!({}), &json!({}), "slack"),
            DEFAULT_ACCOUNT
        );
    }

    #[test]
    fn granola_token_exposes_reads_before_the_first_cache_sync() {
        assert_eq!(granola_capabilities(false, true), (true, true));
        assert_eq!(granola_capabilities(true, false), (true, false));
        assert_eq!(granola_capabilities(false, false), (false, false));
    }

    #[test]
    fn granola_full_sync_prunes_only_after_a_complete_remote_walk() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE notes (id TEXT PRIMARY KEY);
             INSERT INTO notes (id) VALUES ('keep'), ('stale');",
        )
        .unwrap();
        let remote_ids = HashSet::from(["keep".to_string()]);

        assert_eq!(
            granola_prune_if_complete(&db, true, false, &remote_ids).unwrap(),
            0
        );
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM notes", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            2
        );

        assert_eq!(
            granola_prune_if_complete(&db, true, true, &remote_ids).unwrap(),
            1
        );
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM notes", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            db.query_row("SELECT id FROM notes", [], |row| row.get::<_, String>(0))
                .unwrap(),
            "keep"
        );
    }

    #[test]
    fn utility_encoders_keep_queries_and_headers_safe() {
        assert_eq!(escape_drive_query("Rob's \\ draft"), "Rob\\'s \\\\ draft");
        assert_eq!(safe_header("hello\r\nBcc: x"), "hello  Bcc: x");
        assert_eq!(reply_subject("Status"), "Re: Status");
        assert_eq!(reply_subject("RE: Status"), "RE: Status");
    }

    #[test]
    fn prose_mirror_conversion_keeps_basic_meeting_structure() {
        let value = json!({
            "type": "doc",
            "content": [
                { "type": "heading", "attrs": { "level": 2 }, "content": [
                    { "type": "text", "text": "Decisions" }
                ]},
                { "type": "paragraph", "content": [
                    { "type": "text", "text": "Ship the release." }
                ]}
            ]
        });
        assert_eq!(
            prosemirror_markdown(&value),
            "## Decisions\n\nShip the release."
        );
    }
}
