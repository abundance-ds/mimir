import { describe, it, expect, vi } from 'vitest'

const mockAnnotateDocx = vi.fn()

vi.mock('../../docx/writer', () => ({
  annotateDocx: (...args) => mockAnnotateDocx(...args),
}))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

import { getToolMeta } from './gate'
import { createAnnotateDocxTool } from './annotateDocx'

describe('annotateDocx tool', () => {
  describe('tool metadata (TOOL_META)', () => {
    it('annotate_docx is write category, medium risk', () => {
      const meta = getToolMeta('annotate_docx')
      expect(meta.category).toBe('write')
      expect(meta.risk).toBe('medium')
    })

    it('unknown tools get safe defaults', () => {
      const meta = getToolMeta('read_docx')
      expect(meta.category).toBe('general')
      expect(meta.risk).toBe('low')
    })
  })

  describe('createAnnotateDocxTool', () => {
    const mockContext = {
      sessionId: 'test-session',
      projectPath: '/workspace/project',
      policy: {},
      onApprovalRequest: vi.fn().mockResolvedValue({ approved: true }),
    }

    it('returns annotate_docx tool', () => {
      const tools = createAnnotateDocxTool(mockContext)
      expect(Object.keys(tools)).toContain('annotate_docx')
      expect(Object.keys(tools)).toHaveLength(1)
    })

    it('annotate_docx defaults author to mim terminal', async () => {
      mockAnnotateDocx.mockResolvedValue({
        success: true,
        outputPath: '/workspace/project/out.docx',
        summary: { total: 1, succeeded: 1, failed: 0 },
        results: [{ index: 0, success: true }],
      })

      const tools = createAnnotateDocxTool(mockContext)
      await tools.annotate_docx.execute({
        target: 'test.docx',
        operations: [{ type: 'add_comment', anchorText: 'hello', commentText: 'note' }],
      })

      expect(mockAnnotateDocx).toHaveBeenCalledWith(
        '/workspace/project/test.docx',
        expect.arrayContaining([
          expect.objectContaining({ author: 'mim terminal' }),
        ]),
      )
    })

    it('blocks path traversal outside project', async () => {
      const tools = createAnnotateDocxTool(mockContext)
      const result = await tools.annotate_docx.execute({ target: '../../etc/passwd', operations: [{ type: 'add_comment', anchorText: 'x', commentText: 'y' }] })
      expect(result.error).toMatch(/traversal|outside|blocked/i)
    })

    it('returns error when no project linked', async () => {
      const tools = createAnnotateDocxTool({ sessionId: 'test', policy: {} })
      const result = await tools.annotate_docx.execute({ target: 'doc.docx', operations: [{ type: 'add_comment', anchorText: 'x', commentText: 'y' }] })
      expect(result.error).toMatch(/project/i)
    })
  })
})
