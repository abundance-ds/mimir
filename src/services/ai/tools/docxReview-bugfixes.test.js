import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Bug B: annotateDocx.js must call checkPathAccess for outside-project paths ──

const mockAnnotateDocx = vi.fn()
const mockCheckPathAccess = vi.fn()

vi.mock('../../docx/writer', () => ({
  annotateDocx: (...args) => mockAnnotateDocx(...args),
}))
vi.mock('./pathPermission', async (importOriginal) => {
  const original = await importOriginal()
  return {
    ...original,
    checkPathAccess: (...args) => mockCheckPathAccess(...args),
  }
})
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

import { createAnnotateDocxTool } from './annotateDocx'

describe('Bug B: annotateDocx path permission enforcement', () => {
  const context = {
    sessionId: 'sess-1',
    projectPath: '/workspace/project',
    approvalMode: 'normal',
    policy: {},
    onApprovalRequest: vi.fn().mockResolvedValue({ approved: true }),
  }

  beforeEach(() => {
    mockCheckPathAccess.mockReset()
    mockAnnotateDocx.mockReset()
  })

  it('annotate_docx calls checkPathAccess', async () => {
    mockCheckPathAccess.mockResolvedValue(null)
    mockAnnotateDocx.mockResolvedValue({
      success: true,
      outputPath: '/workspace/project/out.docx',
      summary: { total: 1, succeeded: 1, failed: 0 },
      results: [],
    })

    const tools = createAnnotateDocxTool(context)
    await tools.annotate_docx.execute({
      target: 'manuscript.docx',
      operations: [{ type: 'add_comment', anchorText: 'text', commentText: 'note' }],
    })

    expect(mockCheckPathAccess).toHaveBeenCalledWith(
      '/workspace/project/manuscript.docx',
      'annotate_docx',
      expect.objectContaining({ sessionId: 'sess-1' }),
    )
  })
})

// ── Bug D: disabledTools must be enforced in tool creation ──

describe('Bug D: disabledTools enforcement', () => {
  it('createMimTools excludes tools in disabledTools list', async () => {
    const { createMimTools } = await import('./index')

    const tools = createMimTools({
      sessionId: 'test',
      workspacePath: '/proj',
      projectId: 'p1',
      policy: {},
      disabledTools: ['annotate_docx', 'search_web'],
    })

    expect(tools).not.toHaveProperty('annotate_docx')
    expect(tools).not.toHaveProperty('search_web')
    expect(tools).toHaveProperty('read')
  })

  it('createMimTools includes all tools when disabledTools is empty', async () => {
    const { createMimTools } = await import('./index')

    const tools = createMimTools({
      sessionId: 'test',
      workspacePath: '/proj',
      projectId: 'p1',
      policy: {},
      disabledTools: [],
    })

    expect(tools).toHaveProperty('annotate_docx')
    expect(tools).toHaveProperty('search_web')
    expect(tools).toHaveProperty('read')
  })
})
