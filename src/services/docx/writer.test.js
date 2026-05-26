import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockInvoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args) => mockInvoke(...args),
}))

import { annotateDocx, getDocxComments, validateDocx, generateRevisionPath } from './writer'

describe('writer', () => {
  beforeEach(() => {
    mockInvoke.mockReset()
  })

  describe('generateRevisionPath', () => {
    it('adds timestamp to path with extension', () => {
      const result = generateRevisionPath('/path/to/doc.docx')
      // Pattern: base_revision_YYYY-MM-DD-HH-mm.ext
      expect(result).toMatch(/^\/path\/to\/doc_revision_\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.docx$/)
    })

    it('handles path without extension', () => {
      const result = generateRevisionPath('/path/to/doc')
      // Should default to .docx extension
      expect(result).toMatch(/_revision_\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.docx$/)
      expect(result).toMatch(/^\/path\/to\/doc_revision_/)
    })
  })

  describe('parseSidecarResponse (via public API)', () => {
    it('returns structured error on invalid JSON from annotateDocx', async () => {
      mockInvoke.mockResolvedValue('NOT VALID JSON {{{')
      const result = await annotateDocx('/test.docx', [])
      expect(result.success).toBe(false)
      expect(result.error).toContain('invalid response')
    })

    it('returns structured error on invalid JSON from getDocxComments', async () => {
      mockInvoke.mockResolvedValue('')
      const result = await getDocxComments('/test.docx')
      expect(result.success).toBe(false)
      expect(result.error).toContain('invalid response')
    })

    it('returns structured error on invalid JSON from validateDocx', async () => {
      mockInvoke.mockResolvedValue(undefined)
      const result = await validateDocx('/test.docx')
      expect(result.success).toBe(false)
      expect(result.error).toContain('invalid response')
    })
  })

  describe('annotateDocx', () => {
    it('passes correct request to docx_annotate', async () => {
      mockInvoke.mockResolvedValue('{"success":true,"outputPath":"/out.docx","summary":{"total":1,"succeeded":1,"failed":0},"results":[]}')

      await annotateDocx('/test.docx', [{ type: 'add_comment', anchorText: 'hello', commentText: 'note' }])

      expect(mockInvoke).toHaveBeenCalledWith('docx_annotate', {
        requestJson: expect.any(String),
      })

      const requestJson = mockInvoke.mock.calls[0][1].requestJson
      const parsed = JSON.parse(requestJson)
      expect(parsed.command).toBe('annotate')
      expect(parsed.inputPath).toBe('/test.docx')
      expect(parsed.operations).toHaveLength(1)
      expect(parsed.operations[0].type).toBe('add_comment')
      expect(parsed.operations[0].anchorText).toBe('hello')
      expect(parsed.operations[0].commentText).toBe('note')
    })

    it('parses response correctly', async () => {
      const response = {
        success: true,
        outputPath: '/out.docx',
        summary: { total: 1, succeeded: 1, failed: 0 },
        results: [{ index: 0, success: true, commentId: '1' }],
      }
      mockInvoke.mockResolvedValue(JSON.stringify(response))

      const result = await annotateDocx('/test.docx', [{ type: 'add_comment', anchorText: 'hello', commentText: 'note' }])
      expect(result.success).toBe(true)
      expect(result.outputPath).toBe('/out.docx')
      expect(result.summary.total).toBe(1)
      expect(result.summary.succeeded).toBe(1)
      expect(result.results[0].commentId).toBe('1')
    })
  })

  describe('getDocxComments', () => {
    it('calls docx_read_comments with path', async () => {
      mockInvoke.mockResolvedValue('{"success":true,"comments":[],"trackedChanges":[],"metadata":{}}')

      await getDocxComments('/test.docx')

      expect(mockInvoke).toHaveBeenCalledWith('docx_read_comments', { path: '/test.docx' })
    })
  })

  describe('validateDocx', () => {
    it('calls docx_validate with path', async () => {
      mockInvoke.mockResolvedValue('{"success":true,"errors":[]}')

      await validateDocx('/test.docx')

      expect(mockInvoke).toHaveBeenCalledWith('docx_validate', { path: '/test.docx' })
    })
  })
})
