use super::*;

pub(super) async fn send_client_message<S>(
    websocket: &mut tokio_tungstenite::WebSocketStream<S>,
    message: &ClientMessage,
) -> Result<(), String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let encoded =
        serde_json::to_string(message).map_err(|_| "could not encode STT request".to_string())?;
    websocket
        .send(Message::text(encoded))
        .await
        .map_err(|_| "could not send STT request".to_string())
}

pub(super) async fn receive_server_message<S>(
    websocket: &mut tokio_tungstenite::WebSocketStream<S>,
) -> Result<ServerMessage, String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    loop {
        let message = timeout(PROVIDER_RESPONSE_TIMEOUT, websocket.next())
            .await
            .map_err(|_| "custom provider response timed out".to_string())?
            .ok_or_else(|| "custom provider closed the connection".to_string())?
            .map_err(|_| "custom provider WebSocket failed".to_string())?;
        match message {
            Message::Text(text) => {
                if text.len() > MAX_PROVIDER_RESPONSE_BYTES {
                    return Err("custom provider response exceeded its size bound".into());
                }
                let message: ServerMessage = serde_json::from_str(text.as_str())
                    .map_err(|_| "custom provider emitted invalid protocol JSON".to_string())?;
                message
                    .validate()
                    .map_err(|error| format!("custom provider protocol error: {error}"))?;
                return Ok(message);
            }
            Message::Ping(bytes) => websocket
                .send(Message::Pong(bytes))
                .await
                .map_err(|_| "could not answer custom provider heartbeat".to_string())?,
            Message::Pong(_) => {}
            Message::Binary(_) => {
                return Err("custom provider sent an unexpected binary response".into())
            }
            Message::Close(_) => return Err("custom provider closed the connection".into()),
            Message::Frame(_) => {
                return Err("custom provider exposed an unexpected raw frame".into())
            }
        }
    }
}

pub(super) fn reconnect_delay(attempt: u8) -> Duration {
    let multiplier = 2_u32.saturating_pow(u32::from(attempt.saturating_sub(1)));
    BASE_RECONNECT_DELAY
        .saturating_mul(multiplier)
        .min(MAX_RECONNECT_DELAY)
}

pub(super) fn retryable_transport(message: String) -> ProviderFailure {
    ProviderFailure {
        code: sanitize_error_code(&message),
        retryable: true,
        retry_after: None,
    }
}

pub(super) fn retryable(code: &str) -> ProviderFailure {
    ProviderFailure {
        code: code.into(),
        retryable: true,
        retry_after: None,
    }
}

pub(super) fn non_retryable(message: impl ToString) -> ProviderFailure {
    ProviderFailure {
        code: sanitize_error_code(&message.to_string()),
        retryable: false,
        retry_after: None,
    }
}

pub(super) fn sanitize_error_code(message: &str) -> String {
    opaque_diagnostic_code("transport-error", message)
}

pub(super) fn opaque_provider_error_code(code: &str) -> String {
    opaque_diagnostic_code("provider-error", code)
}

pub(super) fn actionable_openai_error_code(code: &str) -> String {
    match code {
        "invalid_api_key" | "authentication_error" => "authentication-failed".into(),
        "insufficient_quota" => "quota-exhausted".into(),
        "rate_limit_exceeded" => "rate-limited".into(),
        "model_not_found" => "model-unavailable".into(),
        "invalid_model" => "unsupported-transcription-model".into(),
        "missing_model" => "transcription-session-selector-missing".into(),
        _ => opaque_provider_error_code(code),
    }
}

pub(super) fn opaque_diagnostic_code(prefix: &str, sensitive: &str) -> String {
    let digest = format!("{:x}", Sha256::digest(sensitive.as_bytes()));
    format!("{prefix}-{}", &digest[..16])
}

pub(super) fn sanitize_wire_component(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '-'
            }
        })
        .collect()
}

pub(super) fn stable_durable_id(prefix: &str, values: &[&str]) -> String {
    let mut hasher = Sha256::new();
    for value in values {
        hasher.update((value.len() as u64).to_be_bytes());
        hasher.update(value.as_bytes());
    }
    format!("{prefix}:{:x}", hasher.finalize())
}

pub(super) fn validate_path_component(value: &str, label: &str) -> Result<(), String> {
    let path = Path::new(value);
    if value.is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        || value.contains(['/', '\\'])
    {
        return Err(format!("{label} is not a safe path component"));
    }
    Ok(())
}

pub(super) fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}
