use crate::{
    ai_keys::{key_status, resolve_api_key, set_api_key, AiKeyStatus},
    ai_models::{app_config_dir, load_registry, resolve_model, ModelRegistry},
    ai_providers::{build_provider_request, parse_provider_response},
    ai_transport::post_json,
    ai_usage::NormalizedUsage,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiGenerateRequest {
    pub correlation_id: Option<String>,
    pub feature: String,
    pub model_id: Option<String>,
    pub workspace_id: Option<String>,
    pub document_id: Option<String>,
    pub system: Option<String>,
    pub messages: Vec<AiMessage>,
    pub response_format: Option<String>,
    pub stream: Option<bool>,
    pub max_output_tokens: Option<u32>,
    pub temperature: Option<f32>,
    pub metadata: Option<Value>,
    pub provider_options: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiGenerateResponse {
    pub correlation_id: String,
    pub feature: String,
    pub model_id: String,
    pub provider: String,
    pub provider_model: String,
    pub route: String,
    pub text: String,
    pub json: Option<Value>,
    pub usage: NormalizedUsage,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSetApiKeyRequest {
    pub provider: String,
    pub api_key: String,
}

#[tauri::command]
pub fn ai_config_dir() -> Result<String, String> {
    Ok(app_config_dir()?.to_string_lossy().to_string())
}

#[tauri::command]
pub fn ai_model_registry() -> Result<ModelRegistry, String> {
    load_registry()
}

#[tauri::command]
pub fn ai_key_status() -> Result<Vec<AiKeyStatus>, String> {
    let registry = load_registry()?;
    Ok(key_status(&registry))
}

#[tauri::command]
pub fn ai_set_api_key(request: AiSetApiKeyRequest) -> Result<AiKeyStatus, String> {
    let registry = load_registry()?;
    set_api_key(&registry, &request.provider, request.api_key)
}

#[tauri::command]
pub async fn ai_generate(request: AiGenerateRequest) -> Result<AiGenerateResponse, String> {
    generate_internal(request).await
}

pub(crate) async fn generate_internal(
    request: AiGenerateRequest,
) -> Result<AiGenerateResponse, String> {
    if request.stream.unwrap_or(false) {
        return Err("Streaming AI requests are not implemented in v0.3 foundation yet".to_string());
    }
    if request.messages.is_empty() {
        return Err("AI request requires at least one message".to_string());
    }

    let registry = load_registry()?;
    let model = resolve_model(&registry, &request.feature, request.model_id.as_deref())?;
    let provider = registry
        .providers
        .get(&model.provider)
        .ok_or_else(|| format!("Missing provider config for {}", model.provider))?;
    let (api_key, key_source) = resolve_api_key(provider)?;
    let provider_request = build_provider_request(&request, &model, provider, &api_key)?;
    let transport_response = post_json(
        &registry,
        &provider_request.url,
        &provider_request.headers,
        provider_request.body,
    )
    .await?;
    let wants_json = request.response_format.as_deref() == Some("json");
    let mut parsed =
        parse_provider_response(&model.provider, &transport_response.body, wants_json)?;
    parsed.usage = parsed.usage.with_cost(&model);

    Ok(AiGenerateResponse {
        correlation_id: request.correlation_id.unwrap_or_else(new_correlation_id),
        feature: request.feature,
        model_id: model.id,
        provider: model.provider,
        provider_model: model.model,
        route: format!("direct:{}", key_source),
        text: parsed.text,
        json: parsed.json,
        usage: parsed.usage,
    })
}

fn new_correlation_id() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or_default();
    format!("ai_{}", millis)
}
