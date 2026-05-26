import { describe, it, expect } from 'vitest'
import { mapAiError, describeAiError } from './errors'

describe('mapAiError', () => {
  describe('auth errors', () => {
    it('detects missing API key', () => {
      const result = mapAiError(new Error('No API key configured for anthropic'))
      expect(result.kind).toBe('auth')
      expect(result.message).toContain('key missing')
    })

    it('detects allowlist block', () => {
      const result = mapAiError(new Error('URL not in allowlist'))
      expect(result.kind).toBe('auth')
      expect(result.message).toContain('blocked')
    })

    it('detects 401 unauthorized', () => {
      const result = mapAiError(new Error('API returned 401 Unauthorized'))
      expect(result.kind).toBe('auth')
      expect(result.message).toContain('key rejected')
    })

    it('detects 403 forbidden', () => {
      const result = mapAiError(new Error('403 Forbidden'))
      expect(result.kind).toBe('auth')
    })

    it('detects unauthorized keyword', () => {
      const result = mapAiError(new Error('Request unauthorized'))
      expect(result.kind).toBe('auth')
    })

    it('detects forbidden keyword', () => {
      const result = mapAiError(new Error('Access forbidden'))
      expect(result.kind).toBe('auth')
    })
  })

  describe('rate limit errors', () => {
    it('detects 429 status', () => {
      const result = mapAiError(new Error('HTTP 429'))
      expect(result.kind).toBe('limit')
      expect(result.message).toContain('Rate limit')
    })

    it('detects rate limit keyword', () => {
      const result = mapAiError(new Error('Rate limit exceeded'))
      expect(result.kind).toBe('limit')
    })

    it('detects quota keyword', () => {
      const result = mapAiError(new Error('API quota exceeded'))
      expect(result.kind).toBe('limit')
    })

    it('detects context length exceeded', () => {
      const result = mapAiError(new Error('Maximum context length exceeded'))
      expect(result.kind).toBe('limit')
      expect(result.message).toContain('too long')
    })

    it('detects too many tokens', () => {
      const result = mapAiError(new Error('Too many tokens in request'))
      expect(result.kind).toBe('limit')
    })

    it('detects max_tokens error', () => {
      const result = mapAiError(new Error('max_tokens must be less than'))
      expect(result.kind).toBe('limit')
    })

    it('detects 413 payload too large', () => {
      const result = mapAiError(new Error('413 Payload Too Large'))
      expect(result.kind).toBe('limit')
      expect(result.message).toContain('too large')
    })

    it('detects request entity too large', () => {
      const result = mapAiError(new Error('Request entity too large'))
      expect(result.kind).toBe('limit')
    })
  })

  describe('network errors', () => {
    it('detects timeout', () => {
      const result = mapAiError(new Error('Request timed out'))
      expect(result.kind).toBe('network')
      expect(result.message).toContain('timed out')
    })

    it('detects ETIMEDOUT', () => {
      const result = mapAiError(new Error('ETIMEDOUT'))
      expect(result.kind).toBe('network')
    })

    it('detects timeout keyword', () => {
      const result = mapAiError(new Error('Connection timeout'))
      expect(result.kind).toBe('network')
    })

    it('detects fetch failed', () => {
      const result = mapAiError(new Error('fetch failed'))
      expect(result.kind).toBe('network')
      expect(result.message).toContain('Network')
    })

    it('detects ECONNREFUSED', () => {
      const result = mapAiError(new Error('ECONNREFUSED'))
      expect(result.kind).toBe('network')
    })

    it('detects ENOTFOUND', () => {
      const result = mapAiError(new Error('ENOTFOUND'))
      expect(result.kind).toBe('network')
    })

    it('detects network keyword', () => {
      const result = mapAiError(new Error('network error'))
      expect(result.kind).toBe('network')
    })
  })

  describe('provider errors', () => {
    it('detects content filter', () => {
      const result = mapAiError(new Error('Content filter triggered'))
      expect(result.kind).toBe('provider')
      expect(result.message).toContain('content filter')
    })

    it('detects safety block', () => {
      const result = mapAiError(new Error('Request blocked by safety filters'))
      expect(result.kind).toBe('provider')
    })

    it('detects generic provider error', () => {
      const result = mapAiError(new Error('AI provider returned something unexpected'))
      expect(result.kind).toBe('provider')
    })
  })

  describe('unknown errors', () => {
    it('returns unknown for unrecognized errors', () => {
      const result = mapAiError(new Error('Something completely different'))
      expect(result.kind).toBe('unknown')
      expect(result.message).toBeTruthy()
    })

    it('handles string input', () => {
      const result = mapAiError('plain string error')
      expect(result.kind).toBe('unknown')
    })

    it('handles undefined input', () => {
      const result = mapAiError(undefined)
      expect(result.kind).toBe('unknown')
    })

    it('handles null input', () => {
      const result = mapAiError(null)
      expect(result.kind).toBe('unknown')
    })

    it('handles empty error message', () => {
      const result = mapAiError(new Error(''))
      expect(result.kind).toBe('unknown')
    })
  })

  describe('error messages contain actionable info', () => {
    it('auth errors suggest what went wrong', () => {
      const result = mapAiError(new Error('401'))
      expect(result.message.length).toBeGreaterThan(5)
    })

    it('rate limit errors suggest waiting', () => {
      const result = mapAiError(new Error('429'))
      expect(result.message).toContain('try again')
    })

    it('network errors mention connectivity', () => {
      const result = mapAiError(new Error('fetch failed'))
      expect(result.message).toContain('connection')
    })
  })
})

describe('describeAiError (deprecated alias)', () => {
  it('returns the message string from mapAiError', () => {
    const result = describeAiError(new Error('401'))
    expect(typeof result).toBe('string')
    expect(result).toBe(mapAiError(new Error('401')).message)
  })
})
