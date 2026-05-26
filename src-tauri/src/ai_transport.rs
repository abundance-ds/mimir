use crate::ai_models::ModelRegistry;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use std::{collections::HashMap, time::Duration};

#[derive(Debug, Clone)]
pub struct TransportResponse {
    pub body: String,
}

pub async fn post_json(
    registry: &ModelRegistry,
    url: &str,
    headers: &HashMap<String, String>,
    body: serde_json::Value,
) -> Result<TransportResponse, String> {
    validate_url_host(registry, url)?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(|err| format!("Could not create AI HTTP client: {}", err))?;

    let response = client
        .post(url)
        .headers(build_headers(headers)?)
        .json(&body)
        .send()
        .await
        .map_err(|err| format!("AI request failed: {}", redact_error(&err.to_string())))?;

    let status = response.status().as_u16();
    let body = response
        .text()
        .await
        .map_err(|err| format!("Could not read AI response: {}", err))?;

    if (200..300).contains(&status) {
        Ok(TransportResponse { body })
    } else {
        Err(format!(
            "AI provider returned {}: {}",
            status,
            redact_error(&body)
        ))
    }
}

pub fn build_headers(headers: &HashMap<String, String>) -> Result<HeaderMap, String> {
    let mut map = HeaderMap::new();
    for (key, value) in headers {
        let name = HeaderName::from_bytes(key.as_bytes())
            .map_err(|err| format!("Invalid AI request header {}: {}", key, err))?;
        let value = HeaderValue::from_str(value)
            .map_err(|err| format!("Invalid AI request header {} value: {}", key, err))?;
        map.insert(name, value);
    }
    Ok(map)
}

pub fn validate_url_host(registry: &ModelRegistry, raw_url: &str) -> Result<(), String> {
    let parsed = url::Url::parse(raw_url).map_err(|err| format!("Invalid AI URL: {}", err))?;
    let host = parsed
        .host_str()
        .ok_or_else(|| "AI URL has no host".to_string())?;

    let mut allowed = vec![
        "api.anthropic.com".to_string(),
        "api.openai.com".to_string(),
        "generativelanguage.googleapis.com".to_string(),
    ];
    allowed.extend(crate::ai_models::provider_hosts(registry));

    #[cfg(debug_assertions)]
    {
        if host == "localhost" || host == "127.0.0.1" {
            return Ok(());
        }
    }

    if allowed.iter().any(|item| item == host) {
        Ok(())
    } else {
        Err(format!("AI URL host not in allowlist: {}", host))
    }
}

pub fn redact_error(value: &str) -> String {
    let mut redacted = value.to_string();
    for marker in ["sk-", "sk-ant-", "AIza"] {
        if let Some(idx) = redacted.find(marker) {
            let end = (idx + marker.len() + 8).min(redacted.len());
            redacted.replace_range(idx..end, "[redacted]");
        }
    }
    redacted
}
