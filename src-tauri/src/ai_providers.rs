use crate::{
    ai::{AiGenerateRequest, AiMessage},
    ai_models::{AiModelConfig, AiProviderConfig},
    ai_usage::NormalizedUsage,
};
use serde_json::{json, Value};
use std::collections::HashMap;

pub struct ProviderRequest {
    pub url: String,
    pub headers: HashMap<String, String>,
    pub body: Value,
}

pub struct ProviderResponse {
    pub text: String,
    pub json: Option<Value>,
    pub usage: NormalizedUsage,
}

pub fn build_provider_request(
    request: &AiGenerateRequest,
    model: &AiModelConfig,
    provider: &AiProviderConfig,
    api_key: &str,
) -> Result<ProviderRequest, String> {
    match model.provider.as_str() {
        "anthropic" => build_anthropic_request(request, model, provider, api_key),
        "openai" => build_openai_request(request, model, provider, api_key),
        "google" => build_google_request(request, model, provider, api_key),
        other => Err(format!("Unsupported AI provider: {}", other)),
    }
}

pub fn parse_provider_response(
    provider: &str,
    body: &str,
    wants_json: bool,
) -> Result<ProviderResponse, String> {
    match provider {
        "anthropic" => parse_anthropic_response(body, wants_json),
        "openai" => parse_openai_response(body, wants_json),
        "google" => parse_google_response(body, wants_json),
        other => Err(format!("Unsupported AI provider: {}", other)),
    }
}

fn build_anthropic_request(
    request: &AiGenerateRequest,
    model: &AiModelConfig,
    provider: &AiProviderConfig,
    api_key: &str,
) -> Result<ProviderRequest, String> {
    let mut headers = HashMap::new();
    headers.insert("content-type".to_string(), "application/json".to_string());
    headers.insert("x-api-key".to_string(), api_key.to_string());
    headers.insert("anthropic-version".to_string(), "2023-06-01".to_string());

    let mut max_tokens = request.max_output_tokens.unwrap_or(1200);
    let mut body = json!({
        "model": model.model,
        "max_tokens": max_tokens,
        "cache_control": { "type": "ephemeral" },
        "messages": request.messages.iter().filter(|message| message.role != "system").map(|message| {
            json!({ "role": normalize_anthropic_role(&message.role), "content": message.content })
        }).collect::<Vec<_>>(),
    });
    let mut thinking_enabled = false;

    if let Some(system) = merged_system(request) {
        body["system"] = json!(system);
    }
    if let Some((kind, option)) = selected_control_option(request, model) {
        let option_id = option.id.as_str();
        if kind == "effort" {
            if option_id == "none" {
                body["thinking"] = json!({ "type": "disabled" });
            } else {
                thinking_enabled = true;
                body["thinking"] = json!({ "type": "adaptive" });
                body["output_config"] = json!({
                    "effort": option.provider_value.as_deref().unwrap_or(option_id)
                });
            }
        } else if kind == "thinking" {
            if option_id == "none" {
                body["thinking"] = json!({ "type": "disabled" });
            } else if let Some(budget_tokens) = option.budget_tokens {
                thinking_enabled = true;
                if max_tokens <= budget_tokens {
                    max_tokens = budget_tokens + 1;
                    body["max_tokens"] = json!(max_tokens);
                }
                body["thinking"] = json!({
                    "type": "enabled",
                    "budget_tokens": budget_tokens
                });
            }
        }
    }
    if !thinking_enabled {
        if let Some(temperature) = request.temperature {
            body["temperature"] = json!(temperature);
        }
    }

    Ok(ProviderRequest {
        url: provider.url.clone(),
        headers,
        body,
    })
}

fn build_openai_request(
    request: &AiGenerateRequest,
    model: &AiModelConfig,
    provider: &AiProviderConfig,
    api_key: &str,
) -> Result<ProviderRequest, String> {
    let mut headers = HashMap::new();
    headers.insert("content-type".to_string(), "application/json".to_string());
    headers.insert("authorization".to_string(), format!("Bearer {}", api_key));

    let mut input = Vec::new();
    if let Some(system) = merged_system(request) {
        input.push(json!({ "role": "system", "content": system }));
    }
    input.extend(request.messages.iter().map(|message| {
        json!({ "role": normalize_openai_role(&message.role), "content": message.content })
    }));

    let mut body = json!({
        "model": model.model,
        "input": input,
        "max_output_tokens": request.max_output_tokens.unwrap_or(1200),
        "store": false,
    });

    if let Some((kind, option)) = selected_control_option(request, model) {
        if kind == "effort" {
            let effort = option
                .provider_value
                .as_deref()
                .unwrap_or(option.id.as_str());
            body["reasoning"] = json!({ "effort": effort });
            if effort != "none" {
                body["reasoning"]["summary"] = json!("auto");
            }
        }
    }
    if let Some(temperature) = request.temperature {
        body["temperature"] = json!(temperature);
    }
    if request.response_format.as_deref() == Some("json") {
        body["text"] = json!({ "format": { "type": "json_object" } });
    }

    Ok(ProviderRequest {
        url: provider.url.clone(),
        headers,
        body,
    })
}

fn build_google_request(
    request: &AiGenerateRequest,
    model: &AiModelConfig,
    provider: &AiProviderConfig,
    api_key: &str,
) -> Result<ProviderRequest, String> {
    let base = provider.url.trim_end_matches('/');
    let url = format!("{}/{}:generateContent?key={}", base, model.model, api_key);

    let mut headers = HashMap::new();
    headers.insert("content-type".to_string(), "application/json".to_string());

    let mut body = json!({
        "contents": request.messages.iter().filter(|message| message.role != "system").map(google_message).collect::<Vec<_>>(),
        "generationConfig": {
            "maxOutputTokens": request.max_output_tokens.unwrap_or(1200),
        }
    });

    if let Some(system) = merged_system(request) {
        body["systemInstruction"] = json!({ "parts": [{ "text": system }] });
    }
    if let Some(temperature) = request.temperature {
        body["generationConfig"]["temperature"] = json!(temperature);
    }
    if let Some((kind, option)) = selected_control_option(request, model) {
        if kind == "thinking" {
            body["generationConfig"]["thinkingConfig"] = json!({
                "thinkingLevel": option.provider_value.as_deref().unwrap_or(option.id.as_str())
            });
        }
    }
    if request.response_format.as_deref() == Some("json") {
        body["generationConfig"]["responseMimeType"] = json!("application/json");
    }

    Ok(ProviderRequest { url, headers, body })
}

fn parse_anthropic_response(body: &str, wants_json: bool) -> Result<ProviderResponse, String> {
    let value: Value =
        serde_json::from_str(body).map_err(|err| format!("Invalid Anthropic response: {}", err))?;
    let text = value
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("");
    let usage = value.get("usage").unwrap_or(&Value::Null);
    let input = usage
        .get("input_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let cache_hit = usage
        .get("cache_read_input_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let cache_write = usage
        .get("cache_creation_input_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let output = usage
        .get("output_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);

    Ok(ProviderResponse {
        json: parse_json_text(&text, wants_json),
        text,
        usage: NormalizedUsage {
            input_tokens: input + cache_hit + cache_write,
            input_no_cache_tokens: input,
            cached_input_tokens: cache_hit,
            cache_read_input_tokens: cache_hit,
            cache_write_input_tokens: cache_write,
            output_tokens: output,
            reasoning_tokens: 0,
            total_tokens: input + cache_hit + cache_write + output,
            estimated_cost: 0.0,
        },
    })
}

fn parse_openai_response(body: &str, wants_json: bool) -> Result<ProviderResponse, String> {
    let value: Value =
        serde_json::from_str(body).map_err(|err| format!("Invalid OpenAI response: {}", err))?;
    let text = value
        .get("output_text")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| extract_openai_output_text(&value));
    let usage = value.get("usage").unwrap_or(&Value::Null);
    let input = usage
        .get("input_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let output = usage
        .get("output_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let cached = usage
        .get("input_tokens_details")
        .and_then(|details| details.get("cached_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let reasoning = usage
        .get("output_tokens_details")
        .and_then(|details| details.get("reasoning_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);

    Ok(ProviderResponse {
        json: parse_json_text(&text, wants_json),
        text,
        usage: NormalizedUsage {
            input_tokens: input,
            input_no_cache_tokens: input.saturating_sub(cached),
            cached_input_tokens: cached,
            cache_read_input_tokens: cached,
            cache_write_input_tokens: 0,
            output_tokens: output,
            reasoning_tokens: reasoning,
            total_tokens: input + output,
            estimated_cost: 0.0,
        },
    })
}

fn parse_google_response(body: &str, wants_json: bool) -> Result<ProviderResponse, String> {
    let value: Value =
        serde_json::from_str(body).map_err(|err| format!("Invalid Google response: {}", err))?;
    let text = value
        .get("candidates")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(|candidate| candidate.get("content"))
        .and_then(|content| content.get("parts"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("");
    let usage = value.get("usageMetadata").unwrap_or(&Value::Null);
    let input = usage
        .get("promptTokenCount")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let cached = usage
        .get("cachedContentTokenCount")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let candidates = usage
        .get("candidatesTokenCount")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let thoughts = usage
        .get("thoughtsTokenCount")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let total = usage
        .get("totalTokenCount")
        .and_then(Value::as_u64)
        .unwrap_or(input + candidates + thoughts);

    Ok(ProviderResponse {
        json: parse_json_text(&text, wants_json),
        text,
        usage: NormalizedUsage {
            input_tokens: input,
            input_no_cache_tokens: input.saturating_sub(cached),
            cached_input_tokens: cached,
            cache_read_input_tokens: cached,
            cache_write_input_tokens: 0,
            output_tokens: candidates + thoughts,
            reasoning_tokens: thoughts,
            total_tokens: total,
            estimated_cost: 0.0,
        },
    })
}

fn merged_system(request: &AiGenerateRequest) -> Option<String> {
    let mut parts = Vec::new();
    if let Some(system) = request
        .system
        .as_ref()
        .filter(|text| !text.trim().is_empty())
    {
        parts.push(system.trim().to_string());
    }
    parts.extend(
        request
            .messages
            .iter()
            .filter(|message| message.role == "system")
            .map(|message| message.content.trim().to_string())
            .filter(|text| !text.is_empty()),
    );
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n\n"))
    }
}

fn selected_control_option<'a>(
    request: &AiGenerateRequest,
    model: &'a AiModelConfig,
) -> Option<(&'a str, &'a crate::ai_models::AiModelControlOption)> {
    let control = model.control.as_ref()?;
    let requested = request_control_id(request).unwrap_or(control.default.as_str());
    let option = control
        .options
        .iter()
        .find(|option| option.id == requested)
        .or_else(|| {
            control
                .options
                .iter()
                .find(|option| option.id == control.default)
        })
        .or_else(|| control.options.first())?;
    Some((control.kind.as_str(), option))
}

fn request_control_id(request: &AiGenerateRequest) -> Option<&str> {
    request
        .provider_options
        .as_ref()
        .and_then(|options| {
            options
                .get("controlId")
                .or_else(|| options.get("control"))
                .and_then(Value::as_str)
        })
        .filter(|value| !value.trim().is_empty())
}

fn normalize_anthropic_role(role: &str) -> &str {
    if role == "assistant" {
        "assistant"
    } else {
        "user"
    }
}

fn normalize_openai_role(role: &str) -> &str {
    match role {
        "assistant" => "assistant",
        "system" => "system",
        _ => "user",
    }
}

fn google_message(message: &AiMessage) -> Value {
    let role = if message.role == "assistant" {
        "model"
    } else {
        "user"
    };
    json!({ "role": role, "parts": [{ "text": message.content }] })
}

fn parse_json_text(text: &str, wants_json: bool) -> Option<Value> {
    if !wants_json {
        return None;
    }

    serde_json::from_str(text.trim()).ok().or_else(|| {
        let start = text.find('{')?;
        let end = text.rfind('}')?;
        serde_json::from_str(&text[start..=end]).ok()
    })
}

fn extract_openai_output_text(value: &Value) -> String {
    value
        .get("output")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("content").and_then(Value::as_array))
        .flatten()
        .filter_map(|part| {
            part.get("text")
                .or_else(|| part.get("content"))
                .and_then(Value::as_str)
        })
        .collect::<Vec<_>>()
        .join("")
}
