import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock generateAiText before importing the module under test
const mockGenerateAiText = vi.fn()

vi.mock('./client', () => ({
  generateAiText: (...args) => mockGenerateAiText(...args),
}))

vi.mock('../../stores/settings.js', () => ({
  useSettingsStore: () => ({ aiGhostModel: 'auto' }),
}))

const { requestGhostSuggestions } = await import('./ghost.js')

describe('requestGhostSuggestions', () => {
  beforeEach(() => {
    mockGenerateAiText.mockReset()
  })

  describe('auth error handling', () => {
    it('returns empty suggestions and auth message when API key is missing', async () => {
      mockGenerateAiText.mockRejectedValue(new Error('No API key configured for anthropic'))

      const result = await requestGhostSuggestions({
        before: 'Hello ',
        after: '',
        documentId: 'test-doc',
        fallback: ['fallback suggestion'],
      })

      expect(result.suggestions).toEqual([])
      expect(result.error).toBe('API key missing. Open Settings → AI to add your key.')
    })

    it('does not return fallback on auth errors', async () => {
      mockGenerateAiText.mockRejectedValue(new Error('no api key configured'))

      const fallback = ['some fallback']
      const result = await requestGhostSuggestions({
        before: 'Test ',
        after: '',
        documentId: 'doc',
        fallback,
      })

      // Auth errors should return empty array, NOT fallback
      expect(result.suggestions).toEqual([])
      expect(result.suggestions).not.toBe(fallback)
    })
  })

  describe('non-auth error handling', () => {
    it('returns fallback suggestions on network error', async () => {
      const networkError = new Error('fetch failed')

      mockGenerateAiText.mockRejectedValue(networkError)

      const fallback = ['fallback one', 'fallback two']
      const result = await requestGhostSuggestions({
        before: 'Test ',
        after: '',
        documentId: 'doc',
        fallback,
      })

      expect(result.suggestions).toBe(fallback)
      expect(result.error).toBe(networkError)
    })

    it('returns fallback on generic error', async () => {
      const genericError = new Error('Something completely unexpected')

      mockGenerateAiText.mockRejectedValue(genericError)

      const fallback = ['fb']
      const result = await requestGhostSuggestions({
        before: 'x',
        after: '',
        documentId: 'doc',
        fallback,
      })

      expect(result.suggestions).toBe(fallback)
      expect(result.error).toBe(genericError)
    })

    it('returns empty fallback by default when no fallback provided', async () => {
      mockGenerateAiText.mockRejectedValue(new Error('timeout'))

      const result = await requestGhostSuggestions({
        before: 'Test',
        after: '',
        documentId: 'doc',
      })

      expect(result.suggestions).toEqual([])
    })
  })

  describe('successful response', () => {
    it('returns cleaned suggestions from valid JSON response', async () => {
      mockGenerateAiText.mockResolvedValue({
        json: {
          suggestions: [' world', ' universe', ' planet'],
        },
      })

      const result = await requestGhostSuggestions({
        before: 'Hello',
        after: '',
        documentId: 'doc',
      })

      expect(result.suggestions).toEqual([' world', ' universe', ' planet'])
      expect(result.result).toBeDefined()
    })

    it('deduplicates suggestions', async () => {
      mockGenerateAiText.mockResolvedValue({
        json: {
          suggestions: [' world', ' world', ' planet'],
        },
      })

      const result = await requestGhostSuggestions({
        before: 'Hello',
        after: '',
        documentId: 'doc',
      })

      expect(result.suggestions).toEqual([' world', ' planet'])
    })

    it('filters out non-string and blank suggestions', async () => {
      mockGenerateAiText.mockResolvedValue({
        json: {
          suggestions: [' valid', null, '', '   ', 42, ' also valid'],
        },
      })

      const result = await requestGhostSuggestions({
        before: 'Test',
        after: '',
        documentId: 'doc',
      })

      expect(result.suggestions).toEqual([' valid', ' also valid'])
    })

    it('returns fallback when all suggestions are empty after cleaning', async () => {
      mockGenerateAiText.mockResolvedValue({
        json: {
          suggestions: ['', '   ', null],
        },
      })

      const fallback = ['fb']
      const result = await requestGhostSuggestions({
        before: 'Test',
        after: '',
        documentId: 'doc',
        fallback,
      })

      expect(result.suggestions).toBe(fallback)
    })

    it('caps suggestions at 5', async () => {
      mockGenerateAiText.mockResolvedValue({
        json: {
          suggestions: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
        },
      })

      const result = await requestGhostSuggestions({
        before: 'Test',
        after: '',
        documentId: 'doc',
      })

      expect(result.suggestions).toHaveLength(5)
    })
  })
})
