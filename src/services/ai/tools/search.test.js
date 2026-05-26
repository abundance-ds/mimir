import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockInvoke = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args) => mockInvoke(...args),
}))

vi.mock('./helpers', () => ({
  readDocument: vi.fn().mockResolvedValue({
    documentId: 'doc-1',
    title: 'Test',
    path: '/test.md',
    content: 'This paper references [@smith2024] and [@jones2023; @doe2025].',
  }),
  readReferences: vi.fn().mockResolvedValue([
    { _key: 'smith2024', title: 'Smith Paper', author: [{ family: 'Smith', given: 'A' }] },
    { _key: 'jones2023', title: 'Jones Study', author: [{ family: 'Jones', given: 'B' }] },
    { _key: 'unused2022', title: 'Unused Ref', author: [{ family: 'Unused', given: 'C' }] },
  ]),
  referenceHaystack: (ref) => [ref._key, ref.title, (ref.author || []).map(a => a.family).join(' ')].join(' ').toLowerCase(),
  limitText: (t, max) => (t && t.length > max ? t.slice(0, max) + '...' : t || ''),
  MAX_TOOL_OUTPUT_CHARS: 24000,
}))

vi.mock('../../audit.js', () => ({
  logAudit: vi.fn(),
}))

import { createSearchTool } from './search'

const context = {
  sessionId: 's1',
  workspacePath: '/projects/myapp',
  approvalMode: 'bypass',
  policy: {},
}

describe('search tool', () => {
  beforeEach(() => {
    mockInvoke.mockReset()
  })

  describe('scope: project', () => {
    it('searches file content via invoke', async () => {
      mockInvoke.mockResolvedValue([
        { path: '/projects/myapp/src/main.js', line: 10, snippet: 'const x = 42' },
      ])

      const { search } = createSearchTool(context)
      const result = await search.execute({ scope: 'project', query: 'const x' })

      expect(mockInvoke).toHaveBeenCalledWith('search_file_content', {
        path: '/projects/myapp',
        query: 'const x',
        file_pattern: null,
        max_results: 10,
      })
      expect(result.count).toBe(1)
      expect(result.matches[0].path).toBe('src/main.js')
    })

    it('returns error without query', async () => {
      const { search } = createSearchTool(context)
      const result = await search.execute({ scope: 'project' })
      expect(result.error).toMatch(/Query is required/)
    })

    it('returns error without workspacePath', async () => {
      const { search } = createSearchTool({ sessionId: 's1', approvalMode: 'bypass', policy: {} })
      const result = await search.execute({ scope: 'project', query: 'test' })
      expect(result.error).toMatch(/No project folder/)
    })
  })

  describe('scope: references', () => {
    it('searches reference library by query terms', async () => {
      const { search } = createSearchTool(context)
      const result = await search.execute({ scope: 'references', query: 'smith' })

      expect(result.count).toBe(1)
      expect(result.references[0]._key).toBe('smith2024')
    })

    it('returns error without query', async () => {
      const { search } = createSearchTool(context)
      const result = await search.execute({ scope: 'references' })
      expect(result.error).toMatch(/Query is required/)
    })
  })

  describe('scope: citations', () => {
    it('checks citation coverage', async () => {
      const { search } = createSearchTool(context)
      const result = await search.execute({ scope: 'citations' })

      expect(result.citationsInDocument).toBe(3)
      expect(result.matched).toContain('smith2024')
      expect(result.matched).toContain('jones2023')
      expect(result.missing).toContain('doe2025')
    })

    it('includes unused references when requested', async () => {
      const { search } = createSearchTool(context)
      const result = await search.execute({ scope: 'citations', include_unused: true })

      expect(result.unusedReferences).toContain('unused2022')
    })
  })

  it('returns error for unknown scope', async () => {
    const { search } = createSearchTool(context)
    const result = await search.execute({ scope: 'invalid' })
    expect(result.error).toMatch(/Unknown scope/)
  })
})
