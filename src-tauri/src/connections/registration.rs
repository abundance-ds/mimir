use super::*;

pub(super) fn register_google_tools(
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

pub(super) fn register_slack_tools(
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

pub(super) fn register_granola_tools(
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

pub(super) fn register(
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
