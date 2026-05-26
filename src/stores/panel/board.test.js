import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useBoardStore } from './board.js'
import { useProjectStore } from './projects.js'

vi.mock('../../services/board/loader.js', async () => {
  const actual = await vi.importActual('../../services/board/loader.js')
  return { ...actual, discoverEntries: vi.fn(async () => []) }
})
vi.mock('./persistence.js', () => ({ schedulePersist: vi.fn() }))

function makeIssue(id, overrides = {}) {
  return {
    id,
    meta: {
      type: 'issue',
      title: `Issue ${id}`,
      status: 'backlog',
      priority: 'normal',
      tags: [],
      deliverables: [],
      links: [],
      origin: {},
      created: '2025-01-01T00:00:00.000Z',
      updated: '2025-01-02T00:00:00.000Z',
      ...overrides,
    },
    body: '',
  }
}

function makeKnowledge(id, title = 'Knowledge') {
  return {
    id,
    meta: { type: 'knowledge', title, tags: [], created: '2025-01-01T00:00:00.000Z', updated: '2025-01-02T00:00:00.000Z' },
    body: 'Some content',
  }
}

describe('board store', () => {
  let store

  beforeEach(() => {
    store = useBoardStore()
  })

  describe('issueSearch', () => {
    it('filters columns by title', () => {
      store.entries = [
        makeIssue('a', { title: 'Fix login', status: 'backlog' }),
        makeIssue('b', { title: 'Add dashboard', status: 'backlog' }),
      ]
      store.issueSearch = 'login'

      const backlog = store.columns.find(c => c.status === 'backlog')
      expect(backlog.entries).toHaveLength(1)
      expect(backlog.entries[0].id).toBe('a')
    })

    it('filters by body text', () => {
      store.entries = [
        { ...makeIssue('a', { title: 'Task A', status: 'plan' }), body: 'involves authentication flow' },
        { ...makeIssue('b', { title: 'Task B', status: 'plan' }), body: 'unrelated' },
      ]
      store.issueSearch = 'authentication'

      const plan = store.columns.find(c => c.status === 'plan')
      expect(plan.entries).toHaveLength(1)
      expect(plan.entries[0].id).toBe('a')
    })

    it('empty search shows all entries', () => {
      store.entries = [
        makeIssue('a', { status: 'backlog' }),
        makeIssue('b', { status: 'backlog' }),
      ]
      store.issueSearch = ''

      const backlog = store.columns.find(c => c.status === 'backlog')
      expect(backlog.entries).toHaveLength(2)
    })
  })

  describe('toggleColumnHidden', () => {
    beforeEach(() => {
      const projStore = useProjectStore()
      projStore.projects = [{ id: 'p1', name: 'Test' }]
      store.activeProjectId = 'p1'
    })

    it('adds status to hiddenStatuses', () => {
      store.toggleColumnHidden('done')
      expect(store.hiddenStatuses.has('done')).toBe(true)
    })

    it('removes status on second toggle', () => {
      store.toggleColumnHidden('done')
      store.toggleColumnHidden('done')
      expect(store.hiddenStatuses.has('done')).toBe(false)
    })

    it('persists hiddenColumns on the project', () => {
      const projStore = useProjectStore()
      store.toggleColumnHidden('done')
      store.toggleColumnHidden('review')
      const proj = projStore.projects.find(p => p.id === 'p1')
      expect(proj.hiddenColumns).toEqual(expect.arrayContaining(['done', 'review']))
    })
  })

  describe('buildBoardContext', () => {
    it('returns empty string when no entries', () => {
      store.entries = []
      expect(store.buildBoardContext()).toBe('')
    })

    it('includes due date in active issues', () => {
      store.entries = [makeIssue('a', { title: 'Deadline task', dueDate: '2025-06-15' })]
      const ctx = store.buildBoardContext()
      expect(ctx).toContain('due 2025-06-15')
    })

    it('includes overdue section when issues are past due', () => {
      const yesterday = new Date()
      yesterday.setDate(yesterday.getDate() - 1)
      const dateStr = yesterday.toISOString().slice(0, 10)

      store.entries = [makeIssue('a', { title: 'Late task', dueDate: dateStr })]
      const ctx = store.buildBoardContext()
      expect(ctx).toContain('OVERDUE')
      expect(ctx).toContain('Late task')
    })

    it('does not mark done issues as overdue', () => {
      const yesterday = new Date()
      yesterday.setDate(yesterday.getDate() - 1)
      const dateStr = yesterday.toISOString().slice(0, 10)

      store.entries = [makeIssue('a', { title: 'Finished', dueDate: dateStr, status: 'done' })]
      const ctx = store.buildBoardContext()
      expect(ctx).not.toContain('OVERDUE')
    })

    it('includes knowledge entries', () => {
      store.entries = [makeKnowledge('k1', 'Protocol design')]
      const ctx = store.buildBoardContext()
      expect(ctx).toContain('Protocol design')
    })

    it('includes issue count breakdown', () => {
      store.entries = [
        makeIssue('a', { status: 'backlog' }),
        makeIssue('b', { status: 'in-progress' }),
      ]
      const ctx = store.buildBoardContext()
      expect(ctx).toContain('2 issues')
      expect(ctx).toContain('1 backlog')
      expect(ctx).toContain('1 in progress')
    })
  })
})
