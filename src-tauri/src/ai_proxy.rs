use crate::{
    ai_keys::resolve_api_key,
    ai_models::{load_registry, resolve_model, AiModelConfig, ModelRegistry},
    ai_transport::{build_headers, redact_error, validate_url_host},
};
use futures_util::StreamExt;
use serde::Deserialize;
use std::{collections::HashMap, sync::Mutex, time::Duration};
use tauri::{Emitter, Manager, State};

pub struct AiStreamSession {
    pub cancel_tx: tokio::sync::watch::Sender<bool>,
}

#[derive(Default)]
pub struct AiStreamState {
    pub sessions: Mutex<HashMap<String, AiStreamSession>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProxyRequest {
    pub correlation_id: String,
    pub feature: Option<String>,
    pub provider: String,
    pub model_id: Option<String>,
    pub provider_model: Option<String>,
    pub url: String,
    pub headers: HashMap<String, String>,
    pub body: String,
}

#[tauri::command]
pub async fn ai_proxy_stream(
    app: tauri::AppHandle,
    state: State<'_, AiStreamState>,
    request: AiProxyRequest,
) -> Result<(), String> {
    let registry = load_registry()?;
    validate_url_host(&registry, &request.url)?;

    let model = resolve_proxy_model(&registry, &request)?;
    if model.provider != request.provider {
        return Err(format!(
            "AI proxy provider mismatch: request={} model={}",
            request.provider, model.provider
        ));
    }

    let provider = registry
        .providers
        .get(&model.provider)
        .ok_or_else(|| format!("Missing provider config for {}", model.provider))?;
    let (api_key, key_source) = resolve_api_key(provider)?;
    let headers = authenticated_headers(&request.provider, request.headers, &api_key);
    let url = authenticated_url(&request.provider, &request.url, &api_key)?;

    let (cancel_tx, mut cancel_rx) = tokio::sync::watch::channel(false);
    {
        let mut sessions = state.sessions.lock().map_err(|err| err.to_string())?;
        sessions.insert(
            request.correlation_id.clone(),
            AiStreamSession { cancel_tx },
        );
    }

    let chunk_event = format!("ai-stream-chunk-{}", request.correlation_id);
    let done_event = format!("ai-stream-done-{}", request.correlation_id);
    let error_event = format!("ai-stream-error-{}", request.correlation_id);
    let correlation_id = request.correlation_id.clone();
    let feature = request
        .feature
        .clone()
        .unwrap_or_else(|| "chat".to_string());
    let provider_name = request.provider.clone();
    let model_id = model.id.clone();
    let provider_model = model.model.clone();
    let route = format!("direct:{}", key_source);
    let body = request.body;

    tauri::async_runtime::spawn(async move {
        let client = match reqwest::Client::builder()
            .timeout(Duration::from_secs(300))
            .build()
        {
            Ok(client) => client,
            Err(err) => {
                let _ = app.emit(
                    &error_event,
                    serde_json::json!({ "error": err.to_string() }),
                );
                let stream_state = app.state::<AiStreamState>();
                if let Ok(mut sessions) = stream_state.sessions.lock() {
                    sessions.remove(&correlation_id);
                }
                return;
            }
        };

        let response = match client
            .post(&url)
            .headers(match build_headers(&headers) {
                Ok(headers) => headers,
                Err(err) => {
                    let _ = app.emit(&error_event, serde_json::json!({ "error": err }));
                    let stream_state = app.state::<AiStreamState>();
                    if let Ok(mut sessions) = stream_state.sessions.lock() {
                        sessions.remove(&correlation_id);
                    }
                    return;
                }
            })
            .body(body)
            .send()
            .await
        {
            Ok(response) => response,
            Err(err) => {
                let _ = app.emit(
                    &error_event,
                    serde_json::json!({ "error": format!("AI request failed: {}", redact_error(&err.to_string())) }),
                );
                let stream_state = app.state::<AiStreamState>();
                if let Ok(mut sessions) = stream_state.sessions.lock() {
                    sessions.remove(&correlation_id);
                }
                return;
            }
        };

        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            let body = response.text().await.unwrap_or_default();
            let _ = app.emit(
                &error_event,
                serde_json::json!({
                    "error": format!("AI provider returned {}: {}", status, redact_error(&body)),
                    "status": status,
                    "correlationId": correlation_id,
                    "feature": feature,
                    "provider": provider_name,
                    "modelId": model_id,
                    "providerModel": provider_model,
                    "route": route,
                }),
            );
            let stream_state = app.state::<AiStreamState>();
            if let Ok(mut sessions) = stream_state.sessions.lock() {
                sessions.remove(&correlation_id);
            }
            return;
        }

        let mut stream = response.bytes_stream();
        let mut aborted = false;
        let mut utf8_buf: Vec<u8> = Vec::new();

        loop {
            tokio::select! {
                chunk = stream.next() => {
                    match chunk {
                        Some(Ok(bytes)) => {
                            // Prepend any leftover incomplete UTF-8 bytes from previous chunk
                            let combined = if utf8_buf.is_empty() {
                                bytes.to_vec()
                            } else {
                                let mut combined = std::mem::take(&mut utf8_buf);
                                combined.extend_from_slice(&bytes);
                                combined
                            };

                            // Find the longest valid UTF-8 prefix: scan backwards from the
                            // end to detect an incomplete multi-byte sequence.
                            let valid_up_to = match std::str::from_utf8(&combined) {
                                Ok(_) => combined.len(),
                                Err(e) => {
                                    // valid_up_to marks the end of valid UTF-8; everything
                                    // after it is either an incomplete sequence or a single
                                    // invalid byte.
                                    let boundary = e.valid_up_to();
                                    let tail = &combined[boundary..];
                                    // Check if the tail looks like an incomplete multi-byte
                                    // lead (1-3 bytes). If so, hold it for the next chunk.
                                    if tail.len() <= 3 && tail[0] >= 0x80 {
                                        boundary
                                    } else {
                                        // Truly invalid byte(s) — include them (lossy) so we
                                        // don't stall forever.
                                        combined.len()
                                    }
                                }
                            };

                            if valid_up_to < combined.len() {
                                utf8_buf = combined[valid_up_to..].to_vec();
                            }

                            let data = String::from_utf8_lossy(&combined[..valid_up_to]).to_string();
                            if !data.is_empty() {
                                let _ = app.emit(
                                    &chunk_event,
                                    serde_json::json!({
                                        "data": data,
                                        "correlationId": &correlation_id,
                                        "feature": &feature,
                                        "provider": &provider_name,
                                        "modelId": &model_id,
                                        "providerModel": &provider_model,
                                        "route": &route,
                                    }),
                                );
                            }
                        }
                        Some(Err(err)) => {
                            let _ = app.emit(
                                &error_event,
                                serde_json::json!({
                                    "error": redact_error(&err.to_string()),
                                    "correlationId": &correlation_id,
                                    "feature": &feature,
                                    "provider": &provider_name,
                                    "modelId": &model_id,
                                    "providerModel": &provider_model,
                                    "route": &route,
                                }),
                            );
                            // Clean up session before returning
                            let stream_state = app.state::<AiStreamState>();
                            if let Ok(mut sessions) = stream_state.sessions.lock() {
                                sessions.remove(&correlation_id);
                            }
                            return;
                        }
                        None => break,
                    }
                }
                _ = cancel_rx.changed() => {
                    if *cancel_rx.borrow() {
                        aborted = true;
                        break;
                    }
                }
            }
        }

        // Flush any remaining buffered bytes (lossy — stream ended mid-character)
        if !utf8_buf.is_empty() {
            let data = String::from_utf8_lossy(&utf8_buf).to_string();
            let _ = app.emit(
                &chunk_event,
                serde_json::json!({
                    "data": data,
                    "correlationId": &correlation_id,
                    "feature": &feature,
                    "provider": &provider_name,
                    "modelId": &model_id,
                    "providerModel": &provider_model,
                    "route": &route,
                }),
            );
        }

        let _ = app.emit(
            &done_event,
            serde_json::json!({
                "correlationId": &correlation_id,
                "aborted": aborted,
                "feature": &feature,
                "provider": &provider_name,
                "modelId": &model_id,
                "providerModel": &provider_model,
                "route": &route,
            }),
        );

        // Clean up session automatically after stream completes
        let stream_state = app.state::<AiStreamState>();
        let _ = stream_state.sessions.lock().map(|mut s| {
            s.remove(&correlation_id);
        });
    });

    Ok(())
}

#[tauri::command]
pub fn ai_abort(state: State<'_, AiStreamState>, correlation_id: String) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|err| err.to_string())?;
    if let Some(session) = sessions.get(&correlation_id) {
        let _ = session.cancel_tx.send(true);
    }
    Ok(())
}

#[tauri::command]
pub fn ai_cleanup(state: State<'_, AiStreamState>, correlation_id: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|err| err.to_string())?;
    sessions.remove(&correlation_id);
    Ok(())
}

fn resolve_proxy_model(
    registry: &ModelRegistry,
    request: &AiProxyRequest,
) -> Result<AiModelConfig, String> {
    if request
        .model_id
        .as_deref()
        .filter(|id| !id.is_empty())
        .is_some()
    {
        return resolve_model(
            registry,
            request.feature.as_deref().unwrap_or("chat"),
            request.model_id.as_deref(),
        );
    }

    if let Some(provider_model) = request.provider_model.as_deref() {
        if let Some(model) = registry
            .models
            .iter()
            .find(|model| model.provider == request.provider && model.model == provider_model)
        {
            return Ok(model.clone());
        }
    }

    resolve_model(registry, request.feature.as_deref().unwrap_or("chat"), None)
}

fn authenticated_headers(
    provider: &str,
    mut headers: HashMap<String, String>,
    api_key: &str,
) -> HashMap<String, String> {
    for name in ["authorization", "x-api-key", "x-goog-api-key"] {
        remove_header_case(&mut headers, name);
    }

    match provider {
        "anthropic" => {
            headers.insert("x-api-key".to_string(), api_key.to_string());
        }
        "openai" => {
            headers.insert("authorization".to_string(), format!("Bearer {}", api_key));
        }
        "google" => {
            headers.insert("x-goog-api-key".to_string(), api_key.to_string());
        }
        _ => {
            eprintln!(
                "[ai_proxy] warning: no auth handler for provider '{}'",
                provider
            );
        }
    }

    headers
}

fn authenticated_url(provider: &str, raw_url: &str, api_key: &str) -> Result<String, String> {
    if provider != "google" {
        return Ok(raw_url.to_string());
    }

    let mut parsed = url::Url::parse(raw_url).map_err(|err| format!("Invalid AI URL: {}", err))?;
    if parsed.query_pairs().any(|(key, _)| key == "key") {
        let pairs = parsed
            .query_pairs()
            .filter(|(key, _)| key != "key")
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect::<Vec<_>>();
        parsed.set_query(None);
        {
            let mut query = parsed.query_pairs_mut();
            for (key, value) in pairs {
                query.append_pair(&key, &value);
            }
            query.append_pair("key", api_key);
        }
    }
    Ok(parsed.to_string())
}

fn remove_header_case(headers: &mut HashMap<String, String>, name: &str) {
    let existing = headers
        .keys()
        .filter(|key| key.eq_ignore_ascii_case(name))
        .cloned()
        .collect::<Vec<_>>();
    for key in existing {
        headers.remove(&key);
    }
}

// NOTE: ai_proxy_stream itself is not unit-tested here: it loads the real
// model registry from disk and spawns an HTTP request task, neither of which
// belongs in a unit test. Its pure helpers and the session-state commands it
// relies on for abort/cleanup are covered below.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_models::{AiProviderConfig, ModelDefaults};

    fn model(id: &str, provider: &str, provider_model: &str) -> AiModelConfig {
        serde_json::from_value(serde_json::json!({
            "id": id,
            "name": id,
            "provider": provider,
            "model": provider_model
        }))
        .unwrap()
    }

    fn registry() -> ModelRegistry {
        let mut providers = HashMap::new();
        providers.insert(
            "anthropic".to_string(),
            AiProviderConfig {
                url: "https://api.anthropic.com/v1/messages".to_string(),
                api_key_env: "ANTHROPIC_API_KEY".to_string(),
            },
        );
        providers.insert(
            "openai".to_string(),
            AiProviderConfig {
                url: "https://api.openai.com/v1/responses".to_string(),
                api_key_env: "OPENAI_API_KEY".to_string(),
            },
        );
        ModelRegistry {
            version: 1,
            models: vec![
                model("claude-a", "anthropic", "claude-3"),
                model("gpt-b", "openai", "gpt-4o"),
            ],
            providers,
            defaults: ModelDefaults {
                chat: vec!["gpt-b".to_string()],
                rewrite: vec!["claude-a".to_string()],
                ..ModelDefaults::default()
            },
            legacy_ids: HashMap::new(),
        }
    }

    fn proxy_request(
        provider: &str,
        model_id: Option<&str>,
        provider_model: Option<&str>,
        feature: Option<&str>,
    ) -> AiProxyRequest {
        AiProxyRequest {
            correlation_id: "corr-1".to_string(),
            feature: feature.map(ToOwned::to_owned),
            provider: provider.to_string(),
            model_id: model_id.map(ToOwned::to_owned),
            provider_model: provider_model.map(ToOwned::to_owned),
            url: "https://api.anthropic.com/v1/messages".to_string(),
            headers: HashMap::new(),
            body: String::new(),
        }
    }

    #[test]
    fn resolve_proxy_model_prefers_explicit_model_id() {
        let registry = registry();
        let request = proxy_request("anthropic", Some("claude-a"), Some("gpt-4o"), None);
        let resolved = resolve_proxy_model(&registry, &request).unwrap();
        assert_eq!(resolved.id, "claude-a");

        let unknown = proxy_request("anthropic", Some("nope"), None, None);
        let error = resolve_proxy_model(&registry, &unknown).expect_err("unknown id must fail");
        assert!(error.contains("Unknown AI model id"), "{}", error);
    }

    #[test]
    fn resolve_proxy_model_falls_back_to_provider_model_match() {
        let registry = registry();
        // Empty model_id is treated as absent.
        let request = proxy_request("anthropic", Some(""), Some("claude-3"), None);
        let resolved = resolve_proxy_model(&registry, &request).unwrap();
        assert_eq!(resolved.id, "claude-a");

        // The provider must match too, otherwise defaults kick in.
        let mismatched = proxy_request("openai", None, Some("claude-3"), None);
        let resolved = resolve_proxy_model(&registry, &mismatched).unwrap();
        assert_eq!(resolved.id, "gpt-b"); // chat default
    }

    #[test]
    fn resolve_proxy_model_uses_feature_defaults_last() {
        let registry = registry();
        let chat = proxy_request("anthropic", None, None, None);
        assert_eq!(resolve_proxy_model(&registry, &chat).unwrap().id, "gpt-b");

        let rewrite = proxy_request("anthropic", None, None, Some("rewrite"));
        assert_eq!(
            resolve_proxy_model(&registry, &rewrite).unwrap().id,
            "claude-a"
        );

        // "auto" is a sentinel handled by resolve_model: defaults apply.
        let auto = proxy_request("anthropic", Some("auto"), None, Some("rewrite"));
        assert_eq!(
            resolve_proxy_model(&registry, &auto).unwrap().id,
            "claude-a"
        );
    }

    #[test]
    fn authenticated_headers_replace_caller_auth_per_provider() {
        let mut incoming = HashMap::new();
        incoming.insert("Authorization".to_string(), "Bearer attacker".to_string());
        incoming.insert("X-Api-Key".to_string(), "attacker".to_string());
        incoming.insert("X-GOOG-API-KEY".to_string(), "attacker".to_string());
        incoming.insert("content-type".to_string(), "application/json".to_string());

        let headers = authenticated_headers("anthropic", incoming.clone(), "real-key");
        assert_eq!(headers.get("x-api-key").unwrap(), "real-key");
        assert!(!headers
            .keys()
            .any(|k| k.eq_ignore_ascii_case("authorization")));
        assert!(!headers
            .keys()
            .any(|k| k.eq_ignore_ascii_case("x-goog-api-key")));
        assert_eq!(headers.get("content-type").unwrap(), "application/json");

        let headers = authenticated_headers("openai", incoming.clone(), "real-key");
        assert_eq!(headers.get("authorization").unwrap(), "Bearer real-key");
        assert!(!headers.keys().any(|k| k.eq_ignore_ascii_case("x-api-key")));

        let headers = authenticated_headers("google", incoming.clone(), "real-key");
        assert_eq!(headers.get("x-goog-api-key").unwrap(), "real-key");

        // Unknown providers get caller auth stripped and nothing added.
        let headers = authenticated_headers("mystery", incoming, "real-key");
        for name in ["authorization", "x-api-key", "x-goog-api-key"] {
            assert!(!headers.keys().any(|k| k.eq_ignore_ascii_case(name)));
        }
        assert_eq!(headers.get("content-type").unwrap(), "application/json");
    }

    #[test]
    fn authenticated_url_replaces_google_key_param_only() {
        // Non-google URLs pass through untouched, even with a key param.
        assert_eq!(
            authenticated_url("openai", "https://api.openai.com/v1?key=old", "real").unwrap(),
            "https://api.openai.com/v1?key=old"
        );

        // A caller-supplied key param is replaced with the resolved key.
        let url = authenticated_url(
            "google",
            "https://generativelanguage.googleapis.com/v1beta/models/g:generateContent?key=attacker&alt=sse",
            "real",
        )
        .unwrap();
        assert!(url.contains("key=real"), "{}", url);
        assert!(!url.contains("attacker"), "{}", url);
        assert!(url.contains("alt=sse"), "{}", url);

        // Characterization: without an existing key param nothing is added —
        // auth then travels via the x-goog-api-key header instead.
        let untouched = authenticated_url(
            "google",
            "https://generativelanguage.googleapis.com/v1beta/models/g:generateContent",
            "real",
        )
        .unwrap();
        assert!(!untouched.contains("key="), "{}", untouched);

        let error =
            authenticated_url("google", "not a url", "real").expect_err("invalid URL must fail");
        assert!(error.contains("Invalid AI URL"), "{}", error);
    }

    #[test]
    fn remove_header_case_drops_all_case_variants() {
        let mut headers = HashMap::new();
        headers.insert("Authorization".to_string(), "a".to_string());
        headers.insert("AUTHORIZATION".to_string(), "b".to_string());
        headers.insert("authorization".to_string(), "c".to_string());
        headers.insert("x-other".to_string(), "keep".to_string());
        remove_header_case(&mut headers, "authorization");
        assert_eq!(headers.len(), 1);
        assert_eq!(headers.get("x-other").unwrap(), "keep");
    }

    #[test]
    fn abort_signals_session_and_cleanup_removes_it() {
        let app = tauri::test::mock_app();
        app.manage(AiStreamState::default());

        let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
        app.state::<AiStreamState>()
            .sessions
            .lock()
            .unwrap()
            .insert("abc".to_string(), AiStreamSession { cancel_tx });

        // Abort flips the watch flag but leaves the session registered —
        // removal is the stream task's (or ai_cleanup's) job.
        ai_abort(app.state(), "abc".to_string()).unwrap();
        assert!(*cancel_rx.borrow());
        assert!(app
            .state::<AiStreamState>()
            .sessions
            .lock()
            .unwrap()
            .contains_key("abc"));

        ai_cleanup(app.state(), "abc".to_string()).unwrap();
        assert!(app
            .state::<AiStreamState>()
            .sessions
            .lock()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn abort_and_cleanup_ignore_unknown_sessions() {
        let app = tauri::test::mock_app();
        app.manage(AiStreamState::default());
        ai_abort(app.state(), "missing".to_string()).unwrap();
        ai_cleanup(app.state(), "missing".to_string()).unwrap();
        assert!(app
            .state::<AiStreamState>()
            .sessions
            .lock()
            .unwrap()
            .is_empty());
    }
}
