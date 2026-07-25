import { getModelRegistry } from './client'
import { createAiBridgeFetch } from './bridgeFetch'
import { controlForModel, resolveFeatureDefault } from './modelControls'

const DUMMY_KEY = 'mim-local-key'

async function loadProvider(provider) {
  switch (provider) {
    case 'anthropic': {
      const { createAnthropic } = await import('@ai-sdk/anthropic')
      return createAnthropic
    }
    case 'openai': {
      const { createOpenAI } = await import('@ai-sdk/openai')
      return createOpenAI
    }
    case 'google': {
      const { createGoogleGenerativeAI } = await import('@ai-sdk/google')
      return createGoogleGenerativeAI
    }
    default:
      throw new Error(`Unsupported AI provider: ${provider}`)
  }
}

export async function createSdkModel({
  modelId = null,
  feature = 'chat',
  correlationPrefix = 'chat',
  registry = null,
} = {}) {
  const modelRegistry = registry || await getModelRegistry()
  const modelConfig = resolveModel(modelRegistry, feature, modelId)
  const providerConfig = modelRegistry.providers?.[modelConfig.provider]

  if (!providerConfig) {
    throw new Error(`Missing provider config for ${modelConfig.provider}`)
  }

  const fetch = createAiBridgeFetch({
    feature,
    provider: modelConfig.provider,
    modelId: modelConfig.id,
    providerModel: modelConfig.model,
    correlationPrefix,
  })
  const baseURL = providerBaseUrl(modelConfig.provider, providerConfig.url)

  const createFn = await loadProvider(modelConfig.provider)
  return {
    model: createFn({ apiKey: DUMMY_KEY, baseURL, fetch })(modelConfig.model),
    modelConfig,
    providerConfig,
  }
}

export function resolveModel(registry, feature = 'chat', modelId = null) {
  if (modelId) {
    const model = registry.models?.find((item) => item.id === modelId)
    if (!model) throw new Error(`Unknown AI model id: ${modelId}`)
    return model
  }

  const defaultModel = resolveFeatureDefault(registry, feature)
  if (defaultModel) return defaultModel

  throw new Error('No AI models configured')
}

export function providerBaseUrl(provider, rawUrl) {
  const url = String(rawUrl || '').replace(/\/+$/, '')
  if (provider === 'anthropic') return url.replace(/\/messages$/, '')
  if (provider === 'openai') return url.replace(/\/responses$/, '').replace(/\/chat\/completions$/, '')
  if (provider === 'google') return url.replace(/\/models$/, '')
  return url
}

export function buildProviderOptions(modelConfig, controlId = null) {
  const options = {}
  const control = controlForModel(modelConfig, controlId)
  const selected = control.option
  const selectedId = selected?.id || control.id

  if (modelConfig?.provider === 'anthropic') {
    options.anthropic = {
      cacheControl: { type: 'ephemeral' },
    }

    if (control.kind === 'effort') {
      if (selectedId === 'none') {
        options.anthropic.thinking = { type: 'disabled' }
      } else {
        options.anthropic.thinking = { type: 'adaptive' }
        options.anthropic.effort = selected?.providerValue || selectedId
      }
    } else if (control.kind === 'thinking') {
      if (selectedId === 'none') {
        options.anthropic.thinking = { type: 'disabled' }
      } else if (selected?.budgetTokens) {
        options.anthropic.thinking = {
          type: 'enabled',
          budgetTokens: selected.budgetTokens,
        }
      }
    }
  }

  if (modelConfig?.provider === 'openai' && modelConfig?.capabilities?.reasoning) {
    options.openai = {
      reasoningEffort: selected?.providerValue || selectedId || 'medium',
      store: false,
    }
    if ((selected?.providerValue || selectedId) !== 'none') {
      options.openai.reasoningSummary = 'auto'
    }
  }

  if (modelConfig?.provider === 'google' && control.kind === 'thinking') {
    if (selectedId !== 'none') {
      options.google = {
        thinkingConfig: {
          thinkingLevel: selected?.providerValue || selectedId,
        },
      }
    }
  }

  return Object.keys(options).length ? options : undefined
}

export function normalizeSdkUsage(usage, modelConfig) {
  const input = normalizeInputTokens(usage)
  const output = normalizeOutputTokens(usage)
  const totalTokens = numberOrZero(usage?.totalTokens) || input.total + output.total
  const pricing = modelConfig?.pricing || {}
  const estimatedCost =
    (input.noCache / 1_000_000) * inputPrice(modelConfig) +
    (input.cacheRead / 1_000_000) * cacheReadPrice(modelConfig) +
    (input.cacheWrite / 1_000_000) * cacheWritePrice(modelConfig) +
    (output.total / 1_000_000) * numberOrZero(pricing.outputPerMillion)

  return {
    inputTokens: input.total,
    inputNoCacheTokens: input.noCache,
    cachedInputTokens: input.cacheRead, // legacy alias
    cacheReadInputTokens: input.cacheRead,
    cacheWriteInputTokens: input.cacheWrite,
    outputTokens: output.total,
    reasoningTokens: output.reasoning,
    totalTokens,
    estimatedCost,
  }
}

export function addUsage(a, b) {
  return {
    inputTokens: numberOrZero(a?.inputTokens) + numberOrZero(b?.inputTokens),
    inputNoCacheTokens: numberOrZero(a?.inputNoCacheTokens) + numberOrZero(b?.inputNoCacheTokens),
    cachedInputTokens: numberOrZero(a?.cachedInputTokens) + numberOrZero(b?.cachedInputTokens),
    cacheReadInputTokens: numberOrZero(a?.cacheReadInputTokens) + numberOrZero(b?.cacheReadInputTokens),
    cacheWriteInputTokens: numberOrZero(a?.cacheWriteInputTokens) + numberOrZero(b?.cacheWriteInputTokens),
    outputTokens: numberOrZero(a?.outputTokens) + numberOrZero(b?.outputTokens),
    reasoningTokens: numberOrZero(a?.reasoningTokens) + numberOrZero(b?.reasoningTokens),
    totalTokens: numberOrZero(a?.totalTokens) + numberOrZero(b?.totalTokens),
    estimatedCost: numberOrZero(a?.estimatedCost) + numberOrZero(b?.estimatedCost),
  }
}

function normalizeInputTokens(usage) {
  const source = usage?.inputTokens ?? usage?.promptTokens
  const total = tokenNumber(source, 'total')
  const cacheRead = firstNumber(
    tokenNumber(source, 'cacheRead'),
    usage?.inputTokenDetails?.cacheReadTokens,
    usage?.inputTokenDetails?.cachedTokens,
    usage?.cachedInputTokens,
  )
  const cacheWrite = firstNumber(
    tokenNumber(source, 'cacheWrite'),
    usage?.inputTokenDetails?.cacheWriteTokens,
    usage?.cacheCreationInputTokens,
  )
  const noCache = firstNumber(
    tokenNumber(source, 'noCache'),
    usage?.inputNoCacheTokens,
    Math.max(0, total - cacheRead - cacheWrite),
  )

  return {
    total,
    noCache,
    cacheRead,
    cacheWrite,
  }
}

function normalizeOutputTokens(usage) {
  const source = usage?.outputTokens ?? usage?.completionTokens
  const total = tokenNumber(source, 'total')
  const reasoning = firstNumber(
    tokenNumber(source, 'reasoning'),
    usage?.outputTokenDetails?.reasoningTokens,
    usage?.reasoningTokens,
  )

  return {
    total,
    reasoning,
  }
}

function tokenNumber(value, key) {
  if (value && typeof value === 'object') return numberOrZero(value[key])
  if (key === 'total') return numberOrZero(value)
  return 0
}

function firstNumber(...values) {
  for (const value of values) {
    const number = numberOrZero(value)
    if (number > 0) return number
  }
  return 0
}

function inputPrice(modelConfig) {
  return numberOrZero(modelConfig?.pricing?.inputPerMillion)
}

function cacheReadPrice(modelConfig) {
  const explicit = numberOrZero(modelConfig?.pricing?.cacheReadInputPerMillion)
  if (explicit > 0) return explicit
  if (modelConfig?.provider === 'anthropic') return inputPrice(modelConfig) * 0.1
  return inputPrice(modelConfig)
}

function cacheWritePrice(modelConfig) {
  const explicit = numberOrZero(modelConfig?.pricing?.cacheWriteInputPerMillion)
  if (explicit > 0) return explicit
  if (modelConfig?.provider === 'anthropic') return inputPrice(modelConfig) * 1.25
  return inputPrice(modelConfig)
}

function numberOrZero(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0
}
