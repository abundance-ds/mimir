import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockInvoke = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args) => mockInvoke(...args),
}))

vi.mock('./pathHandlers', () => ({
  isAtPath: (p) => p?.startsWith('@'),
  resolveAtPath: vi.fn(),
}))

vi.mock('./pathPermission', () => ({
  checkPathAccess: vi.fn().mockResolvedValue(null),
}))

vi.mock('../../comments/parser.js', () => ({
  stripCommentTags: (t) => t,
  parseCommentTags: (t) => ({
    cleanText: t,
    comments: [],
    offsetMap: [],
  }),
}))

vi.mock('../../audit.js', () => ({
  logAudit: vi.fn(),
}))

const mockReadDocxAsText = vi.fn()
const mockGetDocxComments = vi.fn()

vi.mock('../../docx/reader', () => ({
  readDocxAsText: (...args) => mockReadDocxAsText(...args),
}))

vi.mock('../../docx/writer', () => ({
  getDocxComments: (...args) => mockGetDocxComments(...args),
}))

import { createReadTool } from './read'
import { resolveAtPath } from './pathHandlers'

describe('read tool', () => {
  beforeEach(() => {
    mockInvoke.mockReset()
    mockReadDocxAsText.mockReset()
    mockGetDocxComments.mockReset()
    vi.mocked(resolveAtPath).mockReset()
  })

  describe('@editor path', () => {
    it('reads document content from getDocument context', async () => {
      const ctx = {
        sessionId: 's1',
        approvalMode: 'bypass',
        policy: {},
        getDocument: () => ({
          content: '# Hello\nWorld',
          path: '/docs/test.md',
        }),
      }

      const { read } = createReadTool(ctx)
      vi.mocked(resolveAtPath).mockResolvedValue({ virtual: true, subpath: '', handler: {}, relative: '' })

      const result = await read.execute({ target: '@editor' })

      expect(result.title).toBeDefined()
      expect(result.content).toContain('Hello')
      expect(result.characters).toBe(13)
      expect(result.path).toBe('/docs/test.md')
    })

    it('marks re-reads with stale note', async () => {
      const readHistory = new Set()
      const ctx = {
        sessionId: 's1',
        approvalMode: 'bypass',
        policy: {},
        _readHistory: readHistory,
        getDocument: () => ({
          content: 'Test content',
          path: '/test.md',
        }),
      }

      vi.mocked(resolveAtPath).mockResolvedValue({ virtual: true, subpath: '', handler: {}, relative: '' })

      const { read } = createReadTool(ctx)
      const first = await read.execute({ target: '@editor' })
      expect(first.note).toBeUndefined()

      const second = await read.execute({ target: '@editor' })
      expect(second.note).toMatch(/stale/)
    })
  })

  describe('@library.json path', () => {
    it('reads library file via invoke', async () => {
      vi.mocked(resolveAtPath).mockResolvedValue({
        absolutePath: '/data/shoulders/references/library.json',
        handler: {},
        relative: '',
      })
      mockInvoke.mockResolvedValue({ content: '[{"_key":"smith2024"}]' })

      const { read } = createReadTool({
        sessionId: 's1',
        approvalMode: 'bypass',
        policy: {},
      })
      const result = await read.execute({ target: '@library.json' })

      expect(result.path).toBe('@library.json')
      expect(result.content).toContain('smith2024')
      expect(mockInvoke).toHaveBeenCalledWith('read_text_file', {
        path: '/data/shoulders/references/library.json',
      })
    })
  })

  describe('project text files', () => {
    it('reads file via invoke', async () => {
      mockInvoke.mockResolvedValue({ content: 'file content here' })

      const { read } = createReadTool({
        sessionId: 's1',
        workspacePath: '/projects/myapp',
        approvalMode: 'bypass',
        policy: {},
      })
      const result = await read.execute({ target: 'src/main.js' })

      expect(result.path).toBe('src/main.js')
      expect(result.content).toBe('file content here')
    })

    it('blocks path traversal', async () => {
      const { read } = createReadTool({
        sessionId: 's1',
        workspacePath: '/projects/myapp',
        approvalMode: 'bypass',
        policy: {},
      })
      const result = await read.execute({ target: '../../etc/passwd' })

      expect(result.error).toMatch(/traversal|Invalid/)
    })
  })

  describe('error handling', () => {
    it('returns error for unresolvable @-path', async () => {
      vi.mocked(resolveAtPath).mockResolvedValue(null)

      const { read } = createReadTool({
        sessionId: 's1',
        approvalMode: 'bypass',
        policy: {},
      })
      const result = await read.execute({ target: '@unknown' })
      expect(result.error).toMatch(/Cannot resolve/)
    })

    it('returns error when invoke throws', async () => {
      mockInvoke.mockRejectedValue(new Error('File not found'))

      const { read } = createReadTool({
        sessionId: 's1',
        workspacePath: '/projects/myapp',
        approvalMode: 'bypass',
        policy: {},
      })
      const result = await read.execute({ target: 'missing.txt' })
      expect(result.error).toMatch(/Failed to read/)
    })
  })

  describe('.docx files', () => {
    const docxCtx = {
      sessionId: 's1',
      workspacePath: '/projects/myapp',
      approvalMode: 'bypass',
      policy: {},
    }

    it('reads docx as text by default', async () => {
      mockReadDocxAsText.mockResolvedValue('Extracted DOCX content here')

      const { read } = createReadTool(docxCtx)
      const result = await read.execute({ target: 'manuscript.docx' })

      expect(result.path).toBe('manuscript.docx')
      expect(result.text).toContain('Extracted DOCX content')
      expect(mockReadDocxAsText).toHaveBeenCalledWith('/projects/myapp/manuscript.docx')
    })

    it('reads docx metadata when docx_metadata is true', async () => {
      mockGetDocxComments.mockResolvedValue({
        success: true,
        comments: [{ id: 'c1', text: 'Review note' }],
        trackedChanges: [{ type: 'insertion' }],
        metadata: { author: 'Reviewer' },
      })

      const { read } = createReadTool(docxCtx)
      const result = await read.execute({ target: 'report.docx', docx_metadata: true })

      expect(result.comments).toHaveLength(1)
      expect(result.trackedChanges).toHaveLength(1)
      expect(result.metadata.author).toBe('Reviewer')
    })

    it('returns error when docx read fails', async () => {
      mockReadDocxAsText.mockRejectedValue(new Error('Corrupt file'))

      const { read } = createReadTool(docxCtx)
      const result = await read.execute({ target: 'bad.docx' })
      expect(result.error).toMatch(/Failed to read .docx/)
    })

    it('returns error when docx metadata extraction fails', async () => {
      mockGetDocxComments.mockResolvedValue({ success: false, error: 'Parse error' })

      const { read } = createReadTool(docxCtx)
      const result = await read.execute({ target: 'bad.docx', docx_metadata: true })
      expect(result.error).toBe('Parse error')
    })
  })
})
