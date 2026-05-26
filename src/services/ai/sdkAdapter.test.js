import { describe, it, expect } from 'vitest'
import { normalizeSdkUsage, addUsage, providerBaseUrl, resolveModel } from './sdkAdapter'

describe('normalizeSdkUsage', () => {
  it('handles AI SDK v6 nested usage shape', () => {
    const usage = {
      inputTokens: { total: 1000, noCache: 400, cacheRead: 500, cacheWrite: 100 },
      outputTokens: { total: 200, reasoning: 50 },
      totalTokens: 1200,
    }
    const modelConfig = {
      provider: 'anthropic',
      pricing: { inputPerMillion: 3, outputPerMillion: 15, cacheReadInputPerMillion: 0.3 },
    }
    const result = normalizeSdkUsage(usage, modelConfig)
    expect(result.inputTokens).toBe(1000)
    expect(result.inputNoCacheTokens).toBe(400)
    expect(result.cacheReadInputTokens).toBe(500)
    expect(result.cacheWriteInputTokens).toBe(100)
    expect(result.outputTokens).toBe(200)
    expect(result.reasoningTokens).toBe(50)
    expect(result.totalTokens).toBe(1200)
    expect(result.cachedInputTokens).toBe(500) // legacy alias
  })

  it('handles flat numeric usage (v5 style or simple providers)', () => {
    const usage = {
      inputTokens: 500,
      outputTokens: 100,
      totalTokens: 600,
    }
    const result = normalizeSdkUsage(usage, {})
    expect(result.inputTokens).toBe(500)
    expect(result.outputTokens).toBe(100)
    expect(result.totalTokens).toBe(600)
    expect(result.inputNoCacheTokens).toBe(500) // no cache -> all fresh
    expect(result.cacheReadInputTokens).toBe(0)
    expect(result.cacheWriteInputTokens).toBe(0)
    expect(result.reasoningTokens).toBe(0)
  })

  it('handles missing/undefined usage gracefully', () => {
    const result = normalizeSdkUsage(undefined, {})
    expect(result.inputTokens).toBe(0)
    expect(result.outputTokens).toBe(0)
    expect(result.totalTokens).toBe(0)
    expect(result.estimatedCost).toBe(0)
  })

  it('handles null usage gracefully', () => {
    const result = normalizeSdkUsage(null, {})
    expect(result.inputTokens).toBe(0)
    expect(result.outputTokens).toBe(0)
    expect(result.totalTokens).toBe(0)
  })

  it('handles empty object usage', () => {
    const result = normalizeSdkUsage({}, {})
    expect(result.inputTokens).toBe(0)
    expect(result.outputTokens).toBe(0)
    expect(result.totalTokens).toBe(0)
  })

  it('reads promptTokens as fallback for inputTokens', () => {
    const usage = {
      promptTokens: 300,
      completionTokens: 80,
      totalTokens: 380,
    }
    const result = normalizeSdkUsage(usage, {})
    expect(result.inputTokens).toBe(300)
    expect(result.outputTokens).toBe(80)
  })

  it('reads inputTokenDetails cache fields', () => {
    const usage = {
      inputTokens: 1000,
      inputTokenDetails: { cacheReadTokens: 600, cacheWriteTokens: 100 },
      outputTokens: 200,
    }
    const result = normalizeSdkUsage(usage, {})
    expect(result.cacheReadInputTokens).toBe(600)
    expect(result.cacheWriteInputTokens).toBe(100)
    expect(result.inputNoCacheTokens).toBe(300) // 1000 - 600 - 100
  })

  it('reads legacy cachedInputTokens field', () => {
    const usage = {
      inputTokens: 800,
      cachedInputTokens: 500,
      outputTokens: 150,
    }
    const result = normalizeSdkUsage(usage, {})
    expect(result.cacheReadInputTokens).toBe(500)
  })

  it('reads outputTokenDetails.reasoningTokens', () => {
    const usage = {
      inputTokens: 500,
      outputTokens: 300,
      outputTokenDetails: { reasoningTokens: 120 },
    }
    const result = normalizeSdkUsage(usage, {})
    expect(result.reasoningTokens).toBe(120)
  })

  it('reads top-level reasoningTokens', () => {
    const usage = {
      inputTokens: 500,
      outputTokens: 300,
      reasoningTokens: 80,
    }
    const result = normalizeSdkUsage(usage, {})
    expect(result.reasoningTokens).toBe(80)
  })

  it('calculates cost from Anthropic pricing with cache', () => {
    const usage = {
      inputTokens: { total: 1000, noCache: 200, cacheRead: 700, cacheWrite: 100 },
      outputTokens: { total: 500, reasoning: 0 },
    }
    const modelConfig = {
      provider: 'anthropic',
      pricing: {
        inputPerMillion: 3,
        outputPerMillion: 15,
        cacheReadInputPerMillion: 0.3,
        cacheWriteInputPerMillion: 3.75,
      },
    }
    const result = normalizeSdkUsage(usage, modelConfig)
    const expected =
      (200 / 1_000_000) * 3 +
      (700 / 1_000_000) * 0.3 +
      (100 / 1_000_000) * 3.75 +
      (500 / 1_000_000) * 15
    expect(result.estimatedCost).toBeCloseTo(expected, 10)
  })

  it('uses default Anthropic cache pricing when not explicit', () => {
    const usage = {
      inputTokens: { total: 1000, noCache: 200, cacheRead: 700, cacheWrite: 100 },
      outputTokens: { total: 100, reasoning: 0 },
    }
    const modelConfig = {
      provider: 'anthropic',
      pricing: { inputPerMillion: 3, outputPerMillion: 15 },
    }
    const result = normalizeSdkUsage(usage, modelConfig)
    // cacheRead defaults to inputPrice * 0.1 = 0.3
    // cacheWrite defaults to inputPrice * 1.25 = 3.75
    const expected =
      (200 / 1_000_000) * 3 +
      (700 / 1_000_000) * 0.3 +
      (100 / 1_000_000) * 3.75 +
      (100 / 1_000_000) * 15
    expect(result.estimatedCost).toBeCloseTo(expected, 10)
  })

  it('calculates totalTokens from input+output when totalTokens is missing', () => {
    const usage = {
      inputTokens: 400,
      outputTokens: 200,
    }
    const result = normalizeSdkUsage(usage, {})
    expect(result.totalTokens).toBe(600)
  })

  it('uses explicit totalTokens over computed sum', () => {
    const usage = {
      inputTokens: 400,
      outputTokens: 200,
      totalTokens: 999,
    }
    const result = normalizeSdkUsage(usage, {})
    expect(result.totalTokens).toBe(999)
  })
})

describe('addUsage', () => {
  it('accumulates two usage objects', () => {
    const a = {
      inputTokens: 100,
      inputNoCacheTokens: 50,
      cachedInputTokens: 50,
      cacheReadInputTokens: 50,
      cacheWriteInputTokens: 10,
      outputTokens: 200,
      reasoningTokens: 30,
      totalTokens: 300,
      estimatedCost: 0.001,
    }
    const b = {
      inputTokens: 200,
      inputNoCacheTokens: 100,
      cachedInputTokens: 100,
      cacheReadInputTokens: 100,
      cacheWriteInputTokens: 20,
      outputTokens: 300,
      reasoningTokens: 50,
      totalTokens: 500,
      estimatedCost: 0.002,
    }
    const result = addUsage(a, b)
    expect(result.inputTokens).toBe(300)
    expect(result.inputNoCacheTokens).toBe(150)
    expect(result.cachedInputTokens).toBe(150)
    expect(result.cacheReadInputTokens).toBe(150)
    expect(result.cacheWriteInputTokens).toBe(30)
    expect(result.outputTokens).toBe(500)
    expect(result.reasoningTokens).toBe(80)
    expect(result.totalTokens).toBe(800)
    expect(result.estimatedCost).toBeCloseTo(0.003)
  })

  it('handles undefined first argument', () => {
    const b = { inputTokens: 100, outputTokens: 200, totalTokens: 300 }
    const result = addUsage(undefined, b)
    expect(result.inputTokens).toBe(100)
    expect(result.outputTokens).toBe(200)
  })

  it('handles undefined second argument', () => {
    const a = { inputTokens: 100, outputTokens: 200, totalTokens: 300 }
    const result = addUsage(a, undefined)
    expect(result.inputTokens).toBe(100)
    expect(result.outputTokens).toBe(200)
  })

  it('handles both undefined', () => {
    const result = addUsage(undefined, undefined)
    expect(result.inputTokens).toBe(0)
    expect(result.outputTokens).toBe(0)
    expect(result.totalTokens).toBe(0)
  })

  it('handles null arguments', () => {
    const result = addUsage(null, null)
    expect(result.inputTokens).toBe(0)
    expect(result.outputTokens).toBe(0)
  })

  it('handles partial usage objects with missing fields', () => {
    const a = { inputTokens: 100 }
    const b = { outputTokens: 200 }
    const result = addUsage(a, b)
    expect(result.inputTokens).toBe(100)
    expect(result.outputTokens).toBe(200)
    expect(result.totalTokens).toBe(0)
    expect(result.reasoningTokens).toBe(0)
  })
})

describe('providerBaseUrl', () => {
  it('strips /messages from Anthropic URLs', () => {
    expect(providerBaseUrl('anthropic', 'https://api.anthropic.com/v1/messages'))
      .toBe('https://api.anthropic.com/v1')
  })

  it('strips /responses from OpenAI URLs', () => {
    expect(providerBaseUrl('openai', 'https://api.openai.com/v1/responses'))
      .toBe('https://api.openai.com/v1')
  })

  it('strips /chat/completions from OpenAI URLs', () => {
    expect(providerBaseUrl('openai', 'https://api.openai.com/v1/chat/completions'))
      .toBe('https://api.openai.com/v1')
  })

  it('strips /models from Google URLs', () => {
    expect(providerBaseUrl('google', 'https://generativelanguage.googleapis.com/v1beta/models'))
      .toBe('https://generativelanguage.googleapis.com/v1beta')
  })

  it('strips trailing slashes', () => {
    expect(providerBaseUrl('anthropic', 'https://api.anthropic.com/v1/messages/'))
      .toBe('https://api.anthropic.com/v1')
  })

  it('handles null/undefined URL', () => {
    expect(providerBaseUrl('anthropic', null)).toBe('')
    expect(providerBaseUrl('openai', undefined)).toBe('')
  })

  it('returns URL as-is for unknown providers', () => {
    expect(providerBaseUrl('custom', 'https://custom.api.com/v1'))
      .toBe('https://custom.api.com/v1')
  })
})

describe('resolveModel', () => {
  const registry = {
    models: [
      { id: 'claude-sonnet-4-6', provider: 'anthropic', model: 'claude-sonnet-4-6' },
      { id: 'claude-haiku-4-5', provider: 'anthropic', model: 'claude-haiku-4-5' },
      { id: 'gpt-5.4', provider: 'openai', model: 'gpt-5.4' },
    ],
    defaults: {
      chat: ['claude-sonnet-4-6'],
      rewrite: ['claude-sonnet-4-6'],
      ghost: ['claude-haiku-4-5'],
      extract: ['claude-haiku-4-5'],
    },
  }

  it('resolves by explicit modelId', () => {
    const model = resolveModel(registry, 'chat', 'gpt-5.4')
    expect(model.id).toBe('gpt-5.4')
    expect(model.provider).toBe('openai')
  })

  it('resolves by feature default', () => {
    const model = resolveModel(registry, 'ghost')
    expect(model.id).toBe('claude-haiku-4-5')
  })

  it('falls back to first model when no feature default', () => {
    const model = resolveModel(registry, 'unknown-feature')
    expect(model.id).toBe('claude-sonnet-4-6')
  })

  it('throws for unknown modelId', () => {
    expect(() => resolveModel(registry, 'chat', 'nonexistent')).toThrow('Unknown AI model id')
  })

  it('throws when no models configured', () => {
    expect(() => resolveModel({ models: [] }, 'chat')).toThrow('No AI models configured')
  })

  it('throws when models array is missing', () => {
    expect(() => resolveModel({}, 'chat')).toThrow('No AI models configured')
  })
})
