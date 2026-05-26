import { invoke } from '@tauri-apps/api/core'

export function createCorrelationId(prefix = 'ai') {
  const random = crypto.getRandomValues(new Uint32Array(2))
  return `${prefix}_${Date.now()}_${random[0].toString(36)}${random[1].toString(36)}`
}

export async function getAiConfigDir() {
  return invoke('ai_config_dir')
}

export async function getModelRegistry() {
  return invoke('ai_model_registry')
}

export async function getAiKeyStatus() {
  return invoke('ai_key_status')
}

export async function setAiApiKey(provider, apiKey) {
  return invoke('ai_set_api_key', {
    request: { provider, apiKey },
  })
}

export async function generateAiText(request) {
  return invoke('ai_generate', {
    request: {
      correlationId: request.correlationId || createCorrelationId(request.feature || 'ai'),
      feature: request.feature,
      modelId: request.modelId || null,
      workspaceId: request.workspaceId || null,
      documentId: request.documentId || null,
      system: request.system || null,
      messages: request.messages || [],
      responseFormat: request.responseFormat || 'text',
      stream: Boolean(request.stream),
      maxOutputTokens: request.maxOutputTokens || null,
      temperature: request.temperature ?? null,
      metadata: request.metadata || null,
      providerOptions: request.providerOptions || null,
    },
  })
}
