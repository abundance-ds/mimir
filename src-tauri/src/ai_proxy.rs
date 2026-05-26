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
        // Audit: log AI request start
        {
            let audit_state = app.state::<crate::audit::AuditDbState>();
            let _ = crate::audit::audit_log_internal(
                &audit_state,
                "ai.request",
                None,
                None,
                Some(format!("ai:{}", &model_id)),
                Some(
                    serde_json::json!({
                        "correlationId": &correlation_id,
                        "feature": &feature,
                        "provider": &provider_name,
                        "modelId": &model_id,
                        "providerModel": &provider_model,
                        "route": &route,
                    })
                    .to_string(),
                ),
            );
        }

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
            // Audit: log AI request error
            {
                let audit_state = app.state::<crate::audit::AuditDbState>();
                let _ = crate::audit::audit_log_internal(
                    &audit_state,
                    "ai.error",
                    None,
                    None,
                    Some(format!("ai:{}", &model_id)),
                    Some(
                        serde_json::json!({
                            "correlationId": &correlation_id,
                            "feature": &feature,
                            "provider": &provider_name,
                            "modelId": &model_id,
                            "status": status,
                        })
                        .to_string(),
                    ),
                );
            }
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

        // Audit: log AI request completion
        {
            let audit_state = app.state::<crate::audit::AuditDbState>();
            let _ = crate::audit::audit_log_internal(
                &audit_state,
                if aborted { "ai.abort" } else { "ai.complete" },
                None,
                None,
                Some(format!("ai:{}", &model_id)),
                Some(
                    serde_json::json!({
                        "correlationId": &correlation_id,
                        "feature": &feature,
                        "provider": &provider_name,
                        "modelId": &model_id,
                        "aborted": aborted,
                    })
                    .to_string(),
                ),
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
            &registry,
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

    resolve_model(
        &registry,
        request.feature.as_deref().unwrap_or("chat"),
        None,
    )
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
