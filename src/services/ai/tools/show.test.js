import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

const mockReadEntry = vi.fn()
const mockIssuesDir = vi.fn()
const mockKnowledgeDir = vi.fn()

vi.mock('../../board/loader.js', () => ({
  readEntry: (...args) => mockReadEntry(...args),
  issuesDir: (...args) => mockIssuesDir(...args),
  knowledgeDir: (...args) => mockKnowledgeDir(...args),
  ensureIssuesDir: vi.fn(),
  ensureKnowledgeDir: vi.fn(),
  parseBoardEntry: vi.fn(),
  validateIssueMeta: vi.fn(() => ({ valid: true, errors: [] })),
}))

vi.mock('../../audit.js', () => ({
  logAudit: vi.fn(),
}))

import { createShowTool } from './show'

const context = {
  sessionId: 'sess-1',
  projectId: 'proj-1',
  approvalMode: 'bypass',
  policy: {},
}

describe('show tool', () => {
  beforeEach(() => {
    mockReadEntry.mockReset()
    mockIssuesDir.mockReset()
    mockKnowledgeDir.mockReset()
  })

  it('returns empty object when no projectId', () => {
    const tools = createShowTool({})
    expect(tools).toEqual({})
  })

  it('rejects non-@issues/ and non-@knowledge/ paths', async () => {
    const { show } = createShowTool(context)
    const result = await show.execute({ target: 'some/file.md' })
    expect(result.error).toMatch(/supports @issues\/ and @knowledge\//)
  })

  it('returns issue card for valid entry via @issues/', async () => {
    mockReadEntry.mockResolvedValue({
      id: 'ISSUE-1',
      meta: { title: 'Fix bug', type: 'issue', status: 'in-progress', priority: 'high', tags: ['ui'] },
      body: 'Some description',
    })
    mockIssuesDir.mockResolvedValue('/data/projects/proj-1/issues')

    const { show } = createShowTool(context)
    const result = await show.execute({ target: '@issues/ISSUE-1' })

    expect(result._render).toBe('issue_card')
    expect(result.id).toBe('ISSUE-1')
    expect(result.title).toBe('Fix bug')
    expect(result.type).toBe('issue')
    expect(result.status).toBe('in-progress')
    expect(result.priority).toBe('high')
    expect(result.tags).toEqual(['ui'])
    expect(result.boardFilePath).toBe('/data/projects/proj-1/issues/ISSUE-1.md')
    expect(mockReadEntry).toHaveBeenCalledWith('proj-1', 'ISSUE-1')
  })

  it('returns knowledge card via @knowledge/', async () => {
    mockReadEntry.mockResolvedValue({
      id: 'note-1',
      meta: { title: 'My Note', type: 'knowledge', tags: ['idea'] },
      body: 'Note body',
    })
    mockKnowledgeDir.mockResolvedValue('/data/projects/proj-1/knowledge')

    const { show } = createShowTool(context)
    const result = await show.execute({ target: '@knowledge/note-1' })

    expect(result._render).toBe('issue_card')
    expect(result.id).toBe('note-1')
    expect(result.title).toBe('My Note')
    expect(result.type).toBe('knowledge')
    expect(result.boardFilePath).toBe('/data/projects/proj-1/knowledge/note-1.md')
    expect(mockReadEntry).toHaveBeenCalledWith('proj-1', 'note-1')
  })

  it('strips .md extension from target', async () => {
    mockReadEntry.mockResolvedValue({
      id: 'ISSUE-2',
      meta: { title: 'Test', type: 'issue', status: 'todo', priority: 'medium' },
      body: '',
    })
    mockIssuesDir.mockResolvedValue('/data/issues')

    const { show } = createShowTool(context)
    await show.execute({ target: '@issues/ISSUE-2.md' })
    expect(mockReadEntry).toHaveBeenCalledWith('proj-1', 'ISSUE-2')
  })

  it('calculates task progress from checkboxes', async () => {
    mockReadEntry.mockResolvedValue({
      id: 'ISSUE-3',
      meta: { title: 'Checklist', type: 'issue', status: 'todo', priority: 'low' },
      body: '- [x] done\n- [ ] pending\n- [x] also done\n- [ ] another',
    })
    mockIssuesDir.mockResolvedValue('/data/issues')

    const { show } = createShowTool(context)
    const result = await show.execute({ target: '@issues/ISSUE-3' })
    expect(result.taskProgress).toEqual({ done: 2, total: 4 })
  })

  it('returns null taskProgress when no checkboxes', async () => {
    mockReadEntry.mockResolvedValue({
      id: 'ISSUE-4',
      meta: { title: 'No tasks', type: 'issue', status: 'done', priority: 'low' },
      body: 'Just text, no checkboxes',
    })
    mockIssuesDir.mockResolvedValue('/data/issues')

    const { show } = createShowTool(context)
    const result = await show.execute({ target: '@issues/ISSUE-4' })
    expect(result.taskProgress).toBeNull()
  })

  it('returns error when readEntry throws', async () => {
    mockReadEntry.mockRejectedValue(new Error('Entry not found'))
    mockIssuesDir.mockResolvedValue('/data/issues')

    const { show } = createShowTool(context)
    const result = await show.execute({ target: '@issues/MISSING' })
    expect(result.error).toBe('Entry not found')
  })
})
