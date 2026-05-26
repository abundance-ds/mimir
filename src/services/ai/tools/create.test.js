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

vi.mock('../../audit.js', () => ({
  logAudit: vi.fn(),
}))

import { createCreateTool } from './create'
import { resolveAtPath } from './pathHandlers'

describe('create tool', () => {
  beforeEach(() => {
    mockInvoke.mockReset()
    vi.mocked(resolveAtPath).mockReset()
  })

  describe('@-paths (direct write)', () => {
    it('creates file at @issues/ path', async () => {
      const mockAfterWrite = vi.fn()
      vi.mocked(resolveAtPath).mockResolvedValue({
        absolutePath: '/data/issues/ISSUE-5.md',
        handler: { bypassProposals: true, afterWrite: mockAfterWrite },
        relative: 'ISSUE-5.md',
      })
      mockInvoke
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(undefined)

      const onProposal = vi.fn()
      const { create } = createCreateTool({
        sessionId: 's1',
        projectId: 'p1',
        approvalMode: 'bypass',
        policy: {},
        onProposal,
      })

      const result = await create.execute({ target: '@issues/ISSUE-5.md', content: '---\ntitle: New\n---\nBody' })

      expect(result.status).toBe('created')
      expect(result.characters).toBe(23)
      expect(mockInvoke).toHaveBeenCalledWith('path_exists', { path: '/data/issues/ISSUE-5.md' })
      expect(mockInvoke).toHaveBeenCalledWith('write_text_file', { path: '/data/issues/ISSUE-5.md', content: '---\ntitle: New\n---\nBody' })
      expect(mockAfterWrite).toHaveBeenCalled()
    })

    it('creates file at @knowledge/ path', async () => {
      const mockAfterWrite = vi.fn()
      vi.mocked(resolveAtPath).mockResolvedValue({
        absolutePath: '/data/knowledge/note-5.md',
        handler: { bypassProposals: true, afterWrite: mockAfterWrite },
        relative: 'note-5.md',
      })
      mockInvoke
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(undefined)

      const onProposal = vi.fn()
      const { create } = createCreateTool({
        sessionId: 's1',
        projectId: 'p1',
        approvalMode: 'bypass',
        policy: {},
        onProposal,
      })

      const result = await create.execute({ target: '@knowledge/note-5.md', content: '---\ntitle: My Note\n---\nBody' })

      expect(result.status).toBe('created')
      expect(mockInvoke).toHaveBeenCalledWith('path_exists', { path: '/data/knowledge/note-5.md' })
      expect(mockInvoke).toHaveBeenCalledWith('write_text_file', { path: '/data/knowledge/note-5.md', content: '---\ntitle: My Note\n---\nBody' })
      expect(mockAfterWrite).toHaveBeenCalled()
    })

    it('rejects if file already exists at @-path', async () => {
      vi.mocked(resolveAtPath).mockResolvedValue({
        absolutePath: '/data/issues/ISSUE-1.md',
        handler: { bypassProposals: true },
        relative: 'ISSUE-1.md',
      })
      mockInvoke.mockResolvedValueOnce(true)

      const { create } = createCreateTool({
        sessionId: 's1',
        projectId: 'p1',
        approvalMode: 'bypass',
        policy: {},
      })
      const result = await create.execute({ target: '@issues/ISSUE-1.md', content: 'x' })
      expect(result.error).toMatch(/already exists/)
    })
  })

  describe('project paths', () => {
    it('emits proposal in normal mode', async () => {
      mockInvoke.mockResolvedValueOnce(false)

      const onProposal = vi.fn()
      const { create } = createCreateTool({
        sessionId: 's1',
        workspacePath: '/projects/myapp',
        approvalMode: 'normal',
        policy: {},
        onProposal,
      })

      const result = await create.execute({ target: 'src/new-file.js', content: 'export default 42' })

      expect(result.status).toBe('pending_review')
      expect(onProposal).toHaveBeenCalledWith(expect.objectContaining({
        type: 'create',
        path: 'src/new-file.js',
        status: 'pending',
      }))
    })

    it('writes directly in bypass mode', async () => {
      mockInvoke
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(undefined)

      const onProposal = vi.fn()
      const { create } = createCreateTool({
        sessionId: 's1',
        workspacePath: '/projects/myapp',
        approvalMode: 'bypass',
        policy: {},
        onProposal,
      })

      const result = await create.execute({ target: 'src/new.js', content: 'hello' })

      expect(result.status).toBe('created')
      expect(mockInvoke).toHaveBeenCalledWith('write_text_file', { path: '/projects/myapp/src/new.js', content: 'hello' })
    })

    it('rejects if file already exists', async () => {
      mockInvoke.mockResolvedValueOnce(true)

      const { create } = createCreateTool({
        sessionId: 's1',
        workspacePath: '/projects/myapp',
        approvalMode: 'bypass',
        policy: {},
      })
      const result = await create.execute({ target: 'src/existing.js', content: 'x' })
      expect(result.error).toMatch(/already exists/)
    })

    it('blocks path traversal', async () => {
      const { create } = createCreateTool({
        sessionId: 's1',
        workspacePath: '/projects/myapp',
        approvalMode: 'bypass',
        policy: {},
      })
      const result = await create.execute({ target: '../../etc/evil.sh', content: 'x' })
      expect(result.error).toMatch(/traversal|Invalid/)
    })

    it('returns error without workspacePath', async () => {
      const { create } = createCreateTool({
        sessionId: 's1',
        approvalMode: 'bypass',
        policy: {},
      })
      const result = await create.execute({ target: 'file.js', content: 'x' })
      expect(result.error).toMatch(/No project folder/)
    })
  })
})
