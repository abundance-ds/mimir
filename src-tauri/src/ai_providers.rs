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
        "messages": request.messages.iter().filter(|message| message.role != "system").map(|message| {
            json!({ "role": normalize_anthropic_role(&message.role), "content": message.content })
        }).collect::<Vec<_>>(),
    });
    let mut thinking_enabled = false;

    if let Some(system) = merged_system(request) {
        // Prompt caching: cache_control is not a valid top-level Messages API
        // parameter; it belongs on a content block. The system prompt is the
        // stable prefix here, so mark it as the cache breakpoint.
        body["system"] = json!([{
            "type": "text",
            "text": system,
            "cache_control": { "type": "ephemeral" }
        }]);
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
    // System-role messages are already merged into the leading system entry;
    // filter them here (as the Anthropic/Google builders do) so system
    // content is not sent twice.
    input.extend(
        request
            .messages
            .iter()
            .filter(|message| message.role != "system")
            .map(|message| {
                json!({ "role": normalize_openai_role(&message.role), "content": message.content })
            }),
    );

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

#[cfg(test)]
mod tests {
    use super::*;

    fn model(value: Value) -> AiModelConfig {
        serde_json::from_value(value).unwrap()
    }

    fn provider(url: &str) -> AiProviderConfig {
        AiProviderConfig {
            url: url.to_string(),
            api_key_env: "TEST_KEY".to_string(),
        }
    }

    fn message(role: &str, content: &str) -> AiMessage {
        AiMessage {
            role: role.to_string(),
            content: content.to_string(),
        }
    }

    fn request(messages: Vec<AiMessage>) -> AiGenerateRequest {
        AiGenerateRequest {
            correlation_id: None,
            feature: "chat".to_string(),
            model_id: None,
            workspace_id: None,
            document_id: None,
            system: None,
            messages,
            response_format: None,
            stream: None,
            max_output_tokens: None,
            temperature: None,
            metadata: None,
            provider_options: None,
        }
    }

    fn anthropic_model() -> AiModelConfig {
        model(serde_json::json!({
            "id": "claude-test",
            "name": "Claude Test",
            "provider": "anthropic",
            "model": "claude-test-1"
        }))
    }

    #[test]
    fn anthropic_request_shapes_auth_headers_and_body() {
        let mut req = request(vec![
            message("system", "Rule one"),
            message("user", "hi"),
            message("tool", "tool output"),
        ]);
        req.system = Some("  Base  ".to_string());
        req.temperature = Some(0.25);

        let built = build_provider_request(
            &req,
            &anthropic_model(),
            &provider("https://api.anthropic.com/v1/messages"),
            "KEY",
        )
        .unwrap();

        assert_eq!(built.url, "https://api.anthropic.com/v1/messages");
        assert_eq!(built.headers.get("x-api-key").unwrap(), "KEY");
        assert_eq!(
            built.headers.get("anthropic-version").unwrap(),
            "2023-06-01"
        );
        assert_eq!(
            built.headers.get("content-type").unwrap(),
            "application/json"
        );

        assert_eq!(built.body["model"], "claude-test-1");
        assert_eq!(built.body["max_tokens"], 1200);
        assert_eq!(built.body["temperature"], 0.25);
        // cache_control is not a valid top-level Messages API parameter.
        assert!(built.body.get("cache_control").is_none());
        // request.system and system-role messages merge into one system content
        // block carrying the prompt-caching breakpoint.
        let system = built.body["system"].as_array().unwrap();
        assert_eq!(system.len(), 1);
        assert_eq!(system[0]["type"], "text");
        assert_eq!(system[0]["text"], "Base\n\nRule one");
        assert_eq!(system[0]["cache_control"]["type"], "ephemeral");
        // System messages are filtered out; unknown roles collapse to "user".
        let messages = built.body["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["role"], "user");
        assert_eq!(messages[0]["content"], "hi");
        assert_eq!(messages[1]["role"], "user");
        assert_eq!(messages[1]["content"], "tool output");
    }

    #[test]
    fn anthropic_thinking_budget_raises_max_tokens_and_drops_temperature() {
        let mut req = request(vec![message("user", "hi")]);
        req.max_output_tokens = Some(1000);
        req.temperature = Some(0.5);
        let model = model(serde_json::json!({
            "id": "claude-test",
            "name": "Claude Test",
            "provider": "anthropic",
            "model": "claude-test-1",
            "control": {
                "kind": "thinking",
                "label": "Thinking",
                "default": "deep",
                "options": [
                    { "id": "none", "label": "Off" },
                    { "id": "deep", "label": "Deep", "budgetTokens": 2048 }
                ]
            }
        }));

        let built =
            build_provider_request(&req, &model, &provider("https://api.anthropic.com/v1"), "K")
                .unwrap();
        assert_eq!(built.body["thinking"]["type"], "enabled");
        assert_eq!(built.body["thinking"]["budget_tokens"], 2048);
        // max_tokens must exceed the thinking budget.
        assert_eq!(built.body["max_tokens"], 2049);
        // Temperature is not sent alongside thinking.
        assert!(built.body.get("temperature").is_none());

        // A larger max_tokens is preserved as-is.
        req.max_output_tokens = Some(4000);
        let built =
            build_provider_request(&req, &model, &provider("https://api.anthropic.com/v1"), "K")
                .unwrap();
        assert_eq!(built.body["max_tokens"], 4000);

        // Selecting the "none" option disables thinking and restores temperature.
        req.provider_options = Some(serde_json::json!({ "controlId": "none" }));
        let built =
            build_provider_request(&req, &model, &provider("https://api.anthropic.com/v1"), "K")
                .unwrap();
        assert_eq!(built.body["thinking"]["type"], "disabled");
        assert_eq!(built.body["temperature"], 0.5);
    }

    #[test]
    fn anthropic_effort_control_maps_to_adaptive_thinking() {
        let mut req = request(vec![message("user", "hi")]);
        req.temperature = Some(0.5);
        let model = model(serde_json::json!({
            "id": "claude-test",
            "name": "Claude Test",
            "provider": "anthropic",
            "model": "claude-test-1",
            "control": {
                "kind": "effort",
                "label": "Effort",
                "default": "high",
                "options": [
                    { "id": "none", "label": "Off" },
                    { "id": "high", "label": "High", "providerValue": "maximum" }
                ]
            }
        }));

        let built =
            build_provider_request(&req, &model, &provider("https://api.anthropic.com/v1"), "K")
                .unwrap();
        assert_eq!(built.body["thinking"]["type"], "adaptive");
        // providerValue overrides the option id when present.
        assert_eq!(built.body["output_config"]["effort"], "maximum");
        assert!(built.body.get("temperature").is_none());
    }

    #[test]
    fn openai_request_uses_bearer_auth_and_prepends_system() {
        let mut req = request(vec![
            message("system", "Be terse"),
            message("user", "hi"),
            message("assistant", "hello"),
        ]);
        req.temperature = Some(0.25);
        req.response_format = Some("json".to_string());
        let model = model(serde_json::json!({
            "id": "gpt-test",
            "name": "GPT Test",
            "provider": "openai",
            "model": "gpt-test-1"
        }));

        let built = build_provider_request(
            &req,
            &model,
            &provider("https://api.openai.com/v1/responses"),
            "KEY",
        )
        .unwrap();

        assert_eq!(built.headers.get("authorization").unwrap(), "Bearer KEY");
        assert_eq!(built.body["model"], "gpt-test-1");
        assert_eq!(built.body["max_output_tokens"], 1200);
        assert_eq!(built.body["store"], false);
        assert_eq!(built.body["temperature"], 0.25);
        assert_eq!(built.body["text"]["format"]["type"], "json_object");

        let input = built.body["input"].as_array().unwrap();
        // Merged system message goes first; system-role messages are filtered
        // out of the input list so system content is sent exactly once.
        assert_eq!(input.len(), 3);
        assert_eq!(input[0]["role"], "system");
        assert_eq!(input[0]["content"], "Be terse");
        assert_eq!(input[1]["role"], "user");
        assert_eq!(input[1]["content"], "hi");
        assert_eq!(input[2]["role"], "assistant");
        assert_eq!(input[2]["content"], "hello");
    }

    #[test]
    fn openai_effort_control_sets_reasoning_and_summary() {
        let mut req = request(vec![message("user", "hi")]);
        let model = model(serde_json::json!({
            "id": "gpt-test",
            "name": "GPT Test",
            "provider": "openai",
            "model": "gpt-test-1",
            "control": {
                "kind": "effort",
                "label": "Effort",
                "default": "medium",
                "options": [
                    { "id": "none", "label": "Off" },
                    { "id": "medium", "label": "Medium" }
                ]
            }
        }));

        let built =
            build_provider_request(&req, &model, &provider("https://api.openai.com/v1"), "K")
                .unwrap();
        assert_eq!(built.body["reasoning"]["effort"], "medium");
        assert_eq!(built.body["reasoning"]["summary"], "auto");

        req.provider_options = Some(serde_json::json!({ "controlId": "none" }));
        let built =
            build_provider_request(&req, &model, &provider("https://api.openai.com/v1"), "K")
                .unwrap();
        assert_eq!(built.body["reasoning"]["effort"], "none");
        assert!(built.body["reasoning"].get("summary").is_none());
    }

    #[test]
    fn google_request_builds_keyed_url_and_maps_roles() {
        let mut req = request(vec![
            message("system", "Be brief"),
            message("user", "hi"),
            message("assistant", "hello"),
        ]);
        req.response_format = Some("json".to_string());
        let model = model(serde_json::json!({
            "id": "gemini-test",
            "name": "Gemini Test",
            "provider": "google",
            "model": "gemini-test-1",
            "control": {
                "kind": "thinking",
                "label": "Thinking",
                "default": "low",
                "options": [{ "id": "low", "label": "Low", "providerValue": "LOW" }]
            }
        }));

        let built = build_provider_request(
            &req,
            &model,
            // Trailing slash is trimmed before the model path is appended.
            &provider("https://generativelanguage.googleapis.com/v1beta/models/"),
            "KEY",
        )
        .unwrap();

        assert_eq!(
            built.url,
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-test-1:generateContent?key=KEY"
        );
        // Auth travels in the URL; the only header is content-type.
        assert_eq!(built.headers.len(), 1);
        assert_eq!(
            built.headers.get("content-type").unwrap(),
            "application/json"
        );

        let contents = built.body["contents"].as_array().unwrap();
        assert_eq!(contents.len(), 2);
        assert_eq!(contents[0]["role"], "user");
        assert_eq!(contents[1]["role"], "model");
        assert_eq!(contents[1]["parts"][0]["text"], "hello");
        assert_eq!(
            built.body["systemInstruction"]["parts"][0]["text"],
            "Be brief"
        );
        assert_eq!(
            built.body["generationConfig"]["thinkingConfig"]["thinkingLevel"],
            "LOW"
        );
        assert_eq!(
            built.body["generationConfig"]["responseMimeType"],
            "application/json"
        );
        assert_eq!(built.body["generationConfig"]["maxOutputTokens"], 1200);
    }

    #[test]
    fn unknown_providers_are_rejected() {
        let req = request(vec![message("user", "hi")]);
        let model = model(serde_json::json!({
            "id": "x",
            "name": "X",
            "provider": "mystery",
            "model": "m"
        }));
        // .err().expect(..) instead of .expect_err(..): ProviderRequest and
        // ProviderResponse do not derive Debug, and tests must not change them.
        let error = build_provider_request(&req, &model, &provider("https://x.example"), "K")
            .err()
            .expect("unknown provider must fail");
        assert!(error.contains("Unsupported AI provider"), "{}", error);

        let error = parse_provider_response("mystery", "{}", false)
            .err()
            .expect("unknown provider must fail");
        assert!(error.contains("Unsupported AI provider"), "{}", error);
    }

    #[test]
    fn parse_anthropic_response_joins_text_and_normalizes_usage() {
        let body = serde_json::json!({
            "content": [
                { "type": "thinking", "thinking": "hmm" },
                { "type": "text", "text": "Hello " },
                { "type": "text", "text": "world" }
            ],
            "usage": {
                "input_tokens": 10,
                "cache_read_input_tokens": 40,
                "cache_creation_input_tokens": 5,
                "output_tokens": 7
            }
        })
        .to_string();

        let parsed = parse_provider_response("anthropic", &body, false).unwrap();
        assert_eq!(parsed.text, "Hello world");
        assert!(parsed.json.is_none());
        // Anthropic's input_tokens excludes cache reads/writes, so the
        // normalized total input adds them back.
        assert_eq!(parsed.usage.input_tokens, 55);
        assert_eq!(parsed.usage.input_no_cache_tokens, 10);
        assert_eq!(parsed.usage.cache_read_input_tokens, 40);
        assert_eq!(parsed.usage.cached_input_tokens, 40);
        assert_eq!(parsed.usage.cache_write_input_tokens, 5);
        assert_eq!(parsed.usage.output_tokens, 7);
        assert_eq!(parsed.usage.total_tokens, 62);
        assert_eq!(parsed.usage.reasoning_tokens, 0);
    }

    #[test]
    fn parse_openai_response_prefers_output_text_and_reads_details() {
        let body = serde_json::json!({
            "output_text": "{\"answer\":42}",
            "usage": {
                "input_tokens": 100,
                "output_tokens": 20,
                "input_tokens_details": { "cached_tokens": 60 },
                "output_tokens_details": { "reasoning_tokens": 5 }
            }
        })
        .to_string();

        let parsed = parse_provider_response("openai", &body, true).unwrap();
        assert_eq!(parsed.text, "{\"answer\":42}");
        assert_eq!(parsed.json.unwrap()["answer"], 42);
        assert_eq!(parsed.usage.input_tokens, 100);
        assert_eq!(parsed.usage.input_no_cache_tokens, 40);
        assert_eq!(parsed.usage.cached_input_tokens, 60);
        assert_eq!(parsed.usage.cache_write_input_tokens, 0);
        assert_eq!(parsed.usage.output_tokens, 20);
        assert_eq!(parsed.usage.reasoning_tokens, 5);
        assert_eq!(parsed.usage.total_tokens, 120);
    }

    #[test]
    fn parse_openai_response_falls_back_to_output_array() {
        let body = serde_json::json!({
            "output": [
                { "type": "reasoning", "summary": [] },
                {
                    "type": "message",
                    "content": [
                        { "type": "output_text", "text": "Hi" },
                        { "content": " there" }
                    ]
                }
            ]
        })
        .to_string();

        let parsed = parse_provider_response("openai", &body, false).unwrap();
        assert_eq!(parsed.text, "Hi there");
    }

    #[test]
    fn parse_google_response_reads_candidates_and_usage() {
        let body = serde_json::json!({
            "candidates": [
                { "content": { "parts": [ { "text": "Hallo " }, { "text": "Welt" } ] } }
            ],
            "usageMetadata": {
                "promptTokenCount": 50,
                "cachedContentTokenCount": 20,
                "candidatesTokenCount": 10,
                "thoughtsTokenCount": 4,
                "totalTokenCount": 64
            }
        })
        .to_string();

        let parsed = parse_provider_response("google", &body, false).unwrap();
        assert_eq!(parsed.text, "Hallo Welt");
        assert_eq!(parsed.usage.input_tokens, 50);
        assert_eq!(parsed.usage.input_no_cache_tokens, 30);
        assert_eq!(parsed.usage.cached_input_tokens, 20);
        // Output combines candidate and thought tokens.
        assert_eq!(parsed.usage.output_tokens, 14);
        assert_eq!(parsed.usage.reasoning_tokens, 4);
        assert_eq!(parsed.usage.total_tokens, 64);
    }

    #[test]
    fn parse_google_response_computes_total_when_absent() {
        let body = serde_json::json!({
            "candidates": [ { "content": { "parts": [ { "text": "x" } ] } } ],
            "usageMetadata": {
                "promptTokenCount": 5,
                "candidatesTokenCount": 3,
                "thoughtsTokenCount": 2
            }
        })
        .to_string();
        let parsed = parse_provider_response("google", &body, false).unwrap();
        assert_eq!(parsed.usage.total_tokens, 10);
    }

    #[test]
    fn invalid_response_bodies_error_per_provider() {
        for provider in ["anthropic", "openai", "google"] {
            let error = parse_provider_response(provider, "not json", false)
                .err()
                .expect("invalid JSON must fail");
            assert!(error.contains("Invalid"), "{}: {}", provider, error);
        }
    }

    #[test]
    fn merged_system_combines_field_and_system_messages() {
        let mut req = request(vec![
            message("system", "  Rule one  "),
            message("user", "hi"),
            message("system", "   "),
        ]);
        req.system = Some("  Base  ".to_string());
        assert_eq!(merged_system(&req).unwrap(), "Base\n\nRule one");

        let empty = request(vec![message("user", "hi")]);
        assert!(merged_system(&empty).is_none());

        let mut blank = request(vec![]);
        blank.system = Some("   ".to_string());
        assert!(merged_system(&blank).is_none());
    }

    #[test]
    fn selected_control_option_prefers_requested_then_default_then_first() {
        let model = model(serde_json::json!({
            "id": "m",
            "name": "M",
            "provider": "anthropic",
            "model": "m1",
            "control": {
                "kind": "effort",
                "label": "Effort",
                "default": "mid",
                "options": [
                    { "id": "low", "label": "Low" },
                    { "id": "mid", "label": "Mid" }
                ]
            }
        }));

        // No request selection: control default wins.
        let req = request(vec![]);
        let (kind, option) = selected_control_option(&req, &model).unwrap();
        assert_eq!(kind, "effort");
        assert_eq!(option.id, "mid");

        // Explicit controlId wins.
        let mut req = request(vec![]);
        req.provider_options = Some(serde_json::json!({ "controlId": "low" }));
        assert_eq!(selected_control_option(&req, &model).unwrap().1.id, "low");

        // Legacy "control" key is honored too.
        let mut req = request(vec![]);
        req.provider_options = Some(serde_json::json!({ "control": "low" }));
        assert_eq!(selected_control_option(&req, &model).unwrap().1.id, "low");

        // Unknown requested id falls back to the default option.
        let mut req = request(vec![]);
        req.provider_options = Some(serde_json::json!({ "controlId": "bogus" }));
        assert_eq!(selected_control_option(&req, &model).unwrap().1.id, "mid");

        // Whitespace-only ids are ignored (treated as no selection).
        let mut req = request(vec![]);
        req.provider_options = Some(serde_json::json!({ "controlId": "  " }));
        assert_eq!(selected_control_option(&req, &model).unwrap().1.id, "mid");

        // When even the default id is unknown, the first option is used.
        let broken = self::model(serde_json::json!({
            "id": "m", "name": "M", "provider": "anthropic", "model": "m1",
            "control": {
                "kind": "effort", "label": "Effort", "default": "missing",
                "options": [ { "id": "low", "label": "Low" } ]
            }
        }));
        assert_eq!(selected_control_option(&req, &broken).unwrap().1.id, "low");

        // Models without a control block yield None.
        let plain = self::model(serde_json::json!({
            "id": "m", "name": "M", "provider": "anthropic", "model": "m1"
        }));
        assert!(selected_control_option(&req, &plain).is_none());
    }

    #[test]
    fn parse_json_text_extracts_embedded_objects() {
        assert!(parse_json_text("{\"a\":1}", false).is_none());
        assert_eq!(parse_json_text("{\"a\":1}", true).unwrap()["a"], 1);
        assert_eq!(
            parse_json_text("Sure thing: {\"a\": 1} — done!", true).unwrap()["a"],
            1
        );
        assert!(parse_json_text("no json here", true).is_none());
    }
}
