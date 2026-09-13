use super::*;

pub(super) fn validate_meeting_config(config: &MeetingConfig) -> Result<(), String> {
    if config.ignored_apps.len() > 128 {
        return Err("Cannot ignore more than 128 meeting apps".into());
    }
    let mut app_ids = std::collections::BTreeSet::new();
    for app in &config.ignored_apps {
        if app.app_id.is_empty()
            || app.app_id.len() > 255
            || !app
                .app_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
            || app.app_name.trim().is_empty()
            || app.app_name.trim() != app.app_name
            || app.app_name.len() > 255
            || app.app_name.chars().any(char::is_control)
        {
            return Err("Ignored meeting app must have a valid app ID and name".into());
        }
        if !app_ids.insert(app.app_id.to_ascii_lowercase()) {
            return Err("Ignored meeting apps cannot contain duplicate app IDs".into());
        }
    }
    if config.auto_record {
        return Err(
            "Automatic meeting recording is disabled; every recording requires explicit human consent"
                .into(),
        );
    }
    if let Some(device_id) = &config.microphone_device_id {
        crate::meetings::runtime::validate_microphone_device_id(device_id)?;
    }
    if config.local_model.trim() != config.local_model || config.local_model.is_empty() {
        return Err("Local meeting model cannot be empty or padded with whitespace".into());
    }
    ConfigIdentifier::new(config.local_model.clone(), "local model id")
        .map_err(|error| error.to_string())?;
    match config.transcription_mode.as_str() {
        "local" => {}
        "custom" => {
            if config.custom_url.is_empty() {
                return Err("Custom meeting transcription URL cannot be empty".into());
            }
            validate_custom_https_url(&config.custom_url)?;
            ConfigIdentifier::new(config.custom_model.clone(), "custom model id")
                .map_err(|error| error.to_string())?;
        }
        _ => return Err("Meeting transcription mode must be local or custom".into()),
    }
    if !config.custom_url.is_empty() {
        validate_custom_https_url(&config.custom_url)?;
    }
    if !config.custom_model.is_empty() {
        ConfigIdentifier::new(config.custom_model.clone(), "custom model id")
            .map_err(|error| error.to_string())?;
    }
    crate::meetings::runtime::summary_template_instructions(&config.summary_template).ok_or_else(
        || "Summary format must be standard, brief, decisions-actions, or detailed".to_string(),
    )?;
    crate::meetings::runtime::require_summary_prompt(&config.summary_prompt)
        .map_err(|error| error.to_string())?;
    for (label, value) in [
        ("summary preset", config.summary_preset.as_str()),
        ("knowledge-graph preset", config.kg_preset.as_str()),
    ] {
        if !value.is_empty() {
            ConfigIdentifier::new(value.to_string(), label).map_err(|error| error.to_string())?;
        }
    }
    if !matches!(config.kg_prompt.as_str(), "ask" | "always-draft" | "never") {
        return Err("Knowledge-graph follow-up must be ask, always-draft, or never".into());
    }
    if config
        .retention_days
        .is_some_and(|days| !(1..=3_650).contains(&days))
    {
        return Err("Meeting retention must be between 1 and 3650 days".into());
    }
    Ok(())
}

pub(super) fn store_and_verify_secret(
    secrets: &dyn MeetingSecretStore,
    endpoint: &CustomSttEndpoint,
    secret: &str,
) -> Result<(), String> {
    secrets.set(endpoint, secret)?;
    match secrets.read(endpoint) {
        Ok(Some(stored)) if stored == secret => Ok(()),
        Ok(_) => {
            let _ = secrets.clear();
            Err("The OS keychain did not confirm the saved meeting transcription credential".into())
        }
        Err(error) => {
            let _ = secrets.clear();
            Err(format!(
                "The OS keychain could not confirm the saved meeting transcription credential: {error}"
            ))
        }
    }
}

pub(super) fn validate_custom_https_url(raw: &str) -> Result<(), String> {
    custom_stt_endpoint_from_https_url(raw).map(|_| ())
}

pub(super) fn configured_custom_stt_endpoint(
    config: &MeetingConfig,
) -> Result<Option<CustomSttEndpoint>, String> {
    if config.transcription_mode != "custom" {
        return Ok(None);
    }
    stored_custom_stt_endpoint(config)
}

pub(super) fn stored_custom_stt_endpoint(
    config: &MeetingConfig,
) -> Result<Option<CustomSttEndpoint>, String> {
    if config.custom_url.is_empty() {
        return Ok(None);
    }
    custom_stt_endpoint_from_https_url(&config.custom_url).map(Some)
}

pub(super) fn custom_stt_endpoint_from_https_url(raw: &str) -> Result<CustomSttEndpoint, String> {
    let parsed = Url::parse(raw)
        .map_err(|_| "Custom meeting transcription URL is not a valid absolute URL".to_string())?;
    if parsed.scheme() != "https" {
        return Err("Custom meeting transcription URL must use HTTPS".into());
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "Custom meeting transcription URL requires a public hostname".to_string())?
        .to_string();
    let mut websocket = parsed;
    websocket
        .set_scheme("wss")
        .map_err(|_| "Custom meeting transcription URL must use HTTPS".to_string())?;
    CustomSttEndpoint::new(websocket.as_str(), &host)
        .map_err(|error| format!("Unsafe custom meeting transcription URL: {error}"))
}

pub(super) fn validate_content_fields(
    title: Option<&str>,
    summary: Option<&str>,
    notes: &str,
    tags: &[String],
    kg_decision: Option<&str>,
    graph_node_id: Option<&str>,
    graph_draft: &MeetingGraphDraft,
) -> Result<(), String> {
    if let Some(title) = title {
        if title.trim().is_empty() || title.chars().count() > 512 {
            return Err("Meeting title must contain 1 to 512 characters".into());
        }
    }
    if summary.is_some_and(|value| value.len() > MAX_SUMMARY_BYTES) {
        return Err("Meeting summary exceeds the 4 MiB safety limit".into());
    }
    if notes.len() > MAX_SUMMARY_BYTES || notes.contains('\0') {
        return Err("Meeting notes exceed the 4 MiB safety limit or contain invalid text".into());
    }
    if tags.len() > MAX_TAGS
        || tags.iter().any(|tag| {
            tag.trim().is_empty()
                || tag.chars().count() > MAX_TAG_CHARS
                || tag.len() > MAX_TAG_BYTES
                || tag.chars().any(char::is_control)
        })
    {
        return Err("Meeting tags exceed the count, length, or character safety limit".into());
    }
    if kg_decision.is_some_and(|decision| !matches!(decision, "create-draft" | "not-now" | "never"))
    {
        return Err("Invalid persisted knowledge-graph decision".into());
    }
    if graph_node_id.is_some_and(|id| {
        id.trim().is_empty() || id.len() > 120 || id.chars().any(|character| character.is_control())
    }) {
        return Err("Invalid linked Graph meeting id".into());
    }
    validate_graph_draft(graph_draft).map_err(|error| error.to_string())?;
    Ok(())
}
