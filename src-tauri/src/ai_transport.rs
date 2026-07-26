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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_models::{AiProviderConfig, ModelDefaults, ModelRegistry};

    fn registry_with_providers(providers: &[(&str, &str)]) -> ModelRegistry {
        ModelRegistry {
            version: 1,
            models: Vec::new(),
            providers: providers
                .iter()
                .map(|(name, url)| {
                    (
                        name.to_string(),
                        AiProviderConfig {
                            url: url.to_string(),
                            api_key_env: format!("{}_KEY", name.to_uppercase()),
                        },
                    )
                })
                .collect(),
            defaults: ModelDefaults::default(),
            legacy_ids: HashMap::new(),
        }
    }

    #[test]
    fn builtin_hosts_are_allowed() {
        let registry = registry_with_providers(&[]);
        for url in [
            "https://api.anthropic.com/v1/messages",
            "https://api.openai.com/v1/responses",
            "https://generativelanguage.googleapis.com/v1beta/models/x:generateContent",
        ] {
            assert!(validate_url_host(&registry, url).is_ok(), "{} rejected", url);
        }
    }

    #[test]
    fn registry_provider_hosts_are_allowed() {
        let registry =
            registry_with_providers(&[("custom", "https://llm.internal.example/v1/chat")]);
        assert!(validate_url_host(&registry, "https://llm.internal.example/other/path").is_ok());
    }

    #[test]
    fn unknown_hosts_are_rejected() {
        let registry = registry_with_providers(&[]);
        let error = validate_url_host(&registry, "https://evil.example.com/v1/messages")
            .expect_err("unknown host must be rejected");
        assert!(error.contains("not in allowlist"), "unexpected error: {}", error);
        // Matching is exact host equality, so lookalike suffixed domains fail too.
        assert!(validate_url_host(&registry, "https://api.anthropic.com.evil.com/v1").is_err());
    }

    #[test]
    fn host_comparison_uses_parser_normalized_lowercase() {
        let registry = registry_with_providers(&[]);
        // url::Url lowercases the host during parsing, so case variants pass.
        assert!(validate_url_host(&registry, "https://API.OPENAI.COM/v1/responses").is_ok());
    }

    #[test]
    fn urls_without_hosts_or_unparseable_urls_are_rejected() {
        let registry = registry_with_providers(&[]);
        let no_host = validate_url_host(&registry, "data:text/plain,hello")
            .expect_err("host-less URL must be rejected");
        assert!(no_host.contains("no host"), "unexpected error: {}", no_host);
        let invalid = validate_url_host(&registry, "not a url")
            .expect_err("unparseable URL must be rejected");
        assert!(invalid.contains("Invalid AI URL"), "unexpected error: {}", invalid);
    }

    #[test]
    fn loopback_bypass_tracks_build_profile() {
        let registry = registry_with_providers(&[]);
        let localhost = validate_url_host(&registry, "http://localhost:11434/v1/chat");
        let loopback = validate_url_host(&registry, "http://127.0.0.1:8080/v1");
        // The localhost/127.0.0.1 bypass sits inside #[cfg(debug_assertions)] in
        // validate_url_host, so it exists only in debug builds (the profile
        // `cargo test` uses by default). A release-profile test run compiles the
        // bypass out, and loopback hosts must then be rejected. cfg!() here keeps
        // the assertion correct for whichever profile the tests run under.
        if cfg!(debug_assertions) {
            assert!(localhost.is_ok());
            assert!(loopback.is_ok());
        } else {
            assert!(localhost.is_err());
            assert!(loopback.is_err());
        }
    }

    #[test]
    fn build_headers_maps_names_and_values() {
        let mut input = HashMap::new();
        input.insert("x-api-key".to_string(), "secret".to_string());
        input.insert("anthropic-version".to_string(), "2023-06-01".to_string());
        let map = build_headers(&input).unwrap();
        assert_eq!(map.len(), 2);
        assert_eq!(map.get("x-api-key").unwrap(), "secret");
        assert_eq!(map.get("anthropic-version").unwrap(), "2023-06-01");
    }

    #[test]
    fn build_headers_rejects_invalid_names_and_values() {
        let mut bad_name = HashMap::new();
        bad_name.insert("bad header".to_string(), "value".to_string());
        let error = build_headers(&bad_name).expect_err("header name with space must fail");
        assert!(error.contains("Invalid AI request header"), "{}", error);

        let mut bad_value = HashMap::new();
        bad_value.insert("x-api-key".to_string(), "line\nbreak".to_string());
        let error = build_headers(&bad_value).expect_err("header value with newline must fail");
        assert!(error.contains("Invalid AI request header"), "{}", error);
    }

    #[test]
    fn redact_error_masks_key_prefixes() {
        // Each marker plus the following 8 characters is replaced.
        assert_eq!(
            redact_error("boom sk-abcdefgh12345"),
            "boom [redacted]12345"
        );
        assert_eq!(
            redact_error("key AIzaSyABCDEF123456 invalid"),
            "key [redacted]123456 invalid"
        );
        // A short key is wiped entirely.
        assert_eq!(redact_error("sk-12345678"), "[redacted]");
        // Strings without markers pass through untouched.
        assert_eq!(redact_error("plain error"), "plain error");
    }

    #[test]
    fn redact_error_only_masks_a_fixed_window_after_the_first_marker() {
        // Characterization of current behavior, not an endorsement: only
        // marker + 8 chars are replaced, and only the first occurrence per
        // marker. The tail of a longer key survives into the error string,
        // and bearer tokens without a known prefix are not redacted at all.
        let out = redact_error("sk-ant-api03-SECRETSECRETSECRET");
        assert!(out.starts_with("[redacted]"), "{}", out);
        assert!(out.contains("SECRETSECRET"), "{}", out);
        assert_eq!(
            redact_error("Authorization: Bearer tok_live_12345"),
            "Authorization: Bearer tok_live_12345"
        );
    }
}
