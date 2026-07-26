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
    // Masks every occurrence of a key-like token. Known key prefixes are masked
    // together with the full token run that follows them (alphanumerics, `-`,
    // `_`), so no tail of a key survives into error strings or events. Bearer
    // tokens are masked after the `Bearer ` marker regardless of prefix when
    // they look like credentials rather than prose. All scanning is
    // char-boundary-safe: match starts come from `str::find` and token ends
    // come from `char_indices`, so multi-byte provider error bodies cannot
    // cause a panic.
    let mut redacted = value.to_string();
    // "sk-" also subsumes "sk-ant-..." keys because the token run keeps going
    // through `-`; the longer marker is kept for clarity.
    for marker in ["sk-", "sk-ant-", "AIza"] {
        redacted = mask_prefixed_tokens(&redacted, marker);
    }
    mask_bearer_tokens(&redacted)
}

fn is_key_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '-' || ch == '_'
}

fn is_bearer_token_char(ch: char) -> bool {
    // Bearer credentials additionally allow `.` (JWT segment separators).
    is_key_char(ch) || ch == '.'
}

/// Replaces every token that starts with `marker` (marker included) with
/// `[redacted]`, extending through the whole plausible key charset run.
fn mask_prefixed_tokens(input: &str, marker: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(idx) = rest.find(marker) {
        out.push_str(&rest[..idx]);
        let after = &rest[idx + marker.len()..];
        let token_len = after
            .char_indices()
            .find(|(_, ch)| !is_key_char(*ch))
            .map(|(pos, _)| pos)
            .unwrap_or(after.len());
        out.push_str("[redacted]");
        rest = &after[token_len..];
    }
    out.push_str(rest);
    out
}

/// Replaces credential-looking tokens after `Bearer ` with `[redacted]`,
/// keeping the marker itself. Prose after "Bearer" (e.g. "Bearer
/// authentication failed") is left alone: only runs of at least 12 token
/// characters containing a digit are treated as credentials.
fn mask_bearer_tokens(input: &str) -> String {
    const MARKER: &str = "Bearer ";
    const MIN_TOKEN_LEN: usize = 12;
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(idx) = rest.find(MARKER) {
        let token_start = idx + MARKER.len();
        out.push_str(&rest[..token_start]);
        let after = &rest[token_start..];
        let token_len = after
            .char_indices()
            .find(|(_, ch)| !is_bearer_token_char(*ch))
            .map(|(pos, _)| pos)
            .unwrap_or(after.len());
        let token = &after[..token_len];
        if token.chars().count() >= MIN_TOKEN_LEN && token.chars().any(|ch| ch.is_ascii_digit()) {
            out.push_str("[redacted]");
        } else {
            out.push_str(token);
        }
        rest = &after[token_len..];
    }
    out.push_str(rest);
    out
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
            assert!(
                validate_url_host(&registry, url).is_ok(),
                "{} rejected",
                url
            );
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
        assert!(
            error.contains("not in allowlist"),
            "unexpected error: {}",
            error
        );
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
        assert!(
            invalid.contains("Invalid AI URL"),
            "unexpected error: {}",
            invalid
        );
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
        // The marker and the entire key charset run after it are replaced.
        assert_eq!(redact_error("boom sk-abcdefgh12345"), "boom [redacted]");
        assert_eq!(
            redact_error("key AIzaSyABCDEF123456 invalid"),
            "key [redacted] invalid"
        );
        assert_eq!(redact_error("sk-12345678"), "[redacted]");
        // Strings without markers pass through untouched.
        assert_eq!(redact_error("plain error"), "plain error");
    }

    #[test]
    fn redact_error_masks_the_entire_key_token() {
        // No tail of a long key survives: the run of alphanumerics, `-` and
        // `_` after the marker is wiped along with it.
        let out = redact_error("sk-ant-api03-SECRET_SECRET-SECRET123");
        assert_eq!(out, "[redacted]");
        assert!(!out.contains("SECRET"), "{}", out);
        // The mask stops at the first non-key character.
        assert_eq!(
            redact_error("invalid key sk-ant-api03-abc123. Check settings"),
            "invalid key [redacted]. Check settings"
        );
    }

    #[test]
    fn redact_error_masks_every_occurrence_of_every_marker() {
        assert_eq!(
            redact_error("first sk-aaa111bbb then sk-ccc222ddd done"),
            "first [redacted] then [redacted] done"
        );
        // Mixed markers in one string are all masked.
        assert_eq!(
            redact_error("openai sk-proj-abc123 google AIzaSyXYZ789 anthropic sk-ant-api03-def456"),
            "openai [redacted] google [redacted] anthropic [redacted]"
        );
    }

    #[test]
    fn redact_error_is_char_boundary_safe_around_multibyte_text() {
        // The old fixed-window replace_range cut at marker + 8 raw bytes; with
        // a short key followed by multi-byte chars that offset lands inside a
        // `€` and panicked. The rewrite must mask the key and keep the
        // surrounding UTF-8 intact.
        assert_eq!(
            redact_error("Schlüssel sk-a€€€€ ungültig"),
            "Schlüssel [redacted]€€€€ ungültig"
        );
        assert_eq!(redact_error("sk-a€€€€"), "[redacted]€€€€");
        // Multi-byte text before and after a full-length key.
        assert_eq!(
            redact_error("Fehler „sk-ant-api03-geheim123“ bitte prüfen"),
            "Fehler „[redacted]“ bitte prüfen"
        );
    }

    #[test]
    fn redact_error_masks_bearer_tokens_without_known_prefixes() {
        // Long digit-bearing runs after "Bearer " are credentials.
        assert_eq!(
            redact_error("Authorization: Bearer tok_live_12345"),
            "Authorization: Bearer [redacted]"
        );
        // JWT-style tokens (with `.` separators) are wiped in full.
        assert_eq!(
            redact_error("Bearer eyJhbGciOi1.eyJzdWIiOi2.sig3 rejected"),
            "Bearer [redacted] rejected"
        );
        // Prose after "Bearer" is not a credential: no digits.
        assert_eq!(
            redact_error("Bearer authentication failed"),
            "Bearer authentication failed"
        );
        // Short tokens are left alone even with digits.
        assert_eq!(redact_error("Bearer abc123 bad"), "Bearer abc123 bad");
        // Known-prefix keys behind Bearer are caught by the prefix pass first.
        assert_eq!(
            redact_error("Bearer sk-ant-api03-tail and Bearer sk-short"),
            "Bearer [redacted] and Bearer [redacted]"
        );
    }
}
