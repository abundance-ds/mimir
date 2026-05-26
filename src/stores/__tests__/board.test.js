import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useBoardStore } from '../panel/board.js'

vi.mock('../../services/board/loader.js', () => ({
  COLUMN_STATUSES: ['backlog', 'plan', 'in-progress', 'review', 'done'],
  STATUS_LABELS: {
    backlog: 'Backlog',
    plan: 'Plan',
    'in-progress': 'In Progress',
    review: 'Review',
    done: 'Done',
  },
  discoverEntries: vi.fn(),
  writeEntry: vi.fn(),
  deleteEntry: vi.fn(),
  moveEntry: vi.fn(),
}))

import {
  discoverEntries,
  writeEntry,
  deleteEntry,
  moveEntry,
} from '../../services/board/loader.js'

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeIssue(overrides = {}) {
  return {
    id: overrides.id || 'issue-1',
    meta: {
      type: 'issue',
      title: overrides.title || 'Test issue',
      status: overrides.status || 'backlog',
      priority: overrides.priority || 'normal',
      tags: overrides.tags || [],
      links: [],
      deliverables: [],
      origin: {},
      created: '2026-05-19T10:00:00.000Z',
      updated: overrides.updated || '2026-05-19T12:00:00.000Z',
    },
    body: overrides.body || '',
    path: '/mock/issues/' + (overrides.id || 'issue-1') + '.md',
  }
}

function makeKnowledge(overrides = {}) {
  return {
    id: overrides.id || 'knowledge-1',
    meta: {
      type: 'knowledge',
      title: overrides.title || 'Test knowledge entry',
      tags: overrides.tags || [],
      created: '2026-05-19T10:00:00.000Z',
      updated: overrides.updated || '2026-05-19T12:00:00.000Z',
    },
    body: overrides.body || 'Knowledge body content',
    path: '/mock/knowledge/' + (overrides.id || 'knowledge-1') + '.md',
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('board store', () => {
  let store

  beforeEach(() => {
    vi.clearAllMocks()
    store = useBoardStore()
  })

  // ---- Computed: issues and notes ----

  describe('issues and knowledge', () => {
    it('issues filters entries by type === "issue"', () => {
      store.entries = [makeIssue(), makeKnowledge()]
      expect(store.issues).toHaveLength(1)
      expect(store.issues[0].meta.type).toBe('issue')
    })

    it('knowledge filters entries by type === "knowledge"', () => {
      store.entries = [makeIssue(), makeKnowledge()]
      expect(store.knowledge).toHaveLength(1)
      expect(store.knowledge[0].meta.type).toBe('knowledge')
    })

    it('both return empty arrays when entries is empty', () => {
      store.entries = []
      expect(store.issues).toEqual([])
      expect(store.knowledge).toEqual([])
    })
  })

  // ---- Computed: columns ----

  describe('columns', () => {
    it('returns 5 columns with correct status and label', () => {
      expect(store.columns).toHaveLength(5)
      expect(store.columns.map(c => c.status)).toEqual([
        'backlog', 'plan', 'in-progress', 'review', 'done',
      ])
      expect(store.columns.map(c => c.label)).toEqual([
        'Backlog', 'Plan', 'In Progress', 'Review', 'Done',
      ])
    })

    it('places issues into correct columns by status', () => {
      store.entries = [
        makeIssue({ id: 'i1', status: 'backlog' }),
        makeIssue({ id: 'i2', status: 'review' }),
        makeIssue({ id: 'i3', status: 'done' }),
      ]
      expect(store.columns[0].entries).toHaveLength(1)
      expect(store.columns[0].entries[0].id).toBe('i1')
      expect(store.columns[3].entries).toHaveLength(1)
      expect(store.columns[3].entries[0].id).toBe('i2')
      expect(store.columns[4].entries).toHaveLength(1)
      expect(store.columns[4].entries[0].id).toBe('i3')
    })

    it('only shows issues with column statuses', () => {
      store.entries = [
        makeIssue({ id: 'i1', status: 'backlog' }),
        makeIssue({ id: 'i2', status: 'done' }),
      ]
      const allColumnEntries = store.columns.flatMap(c => c.entries)
      expect(allColumnEntries).toHaveLength(2)
    })

    it('sorts entries within columns by priority weight (urgent > high > normal > low)', () => {
      store.entries = [
        makeIssue({ id: 'low', status: 'backlog', priority: 'low' }),
        makeIssue({ id: 'urgent', status: 'backlog', priority: 'urgent' }),
        makeIssue({ id: 'normal', status: 'backlog', priority: 'normal' }),
        makeIssue({ id: 'high', status: 'backlog', priority: 'high' }),
      ]
      const ids = store.columns[0].entries.map(e => e.id)
      expect(ids).toEqual(['urgent', 'high', 'normal', 'low'])
    })

    it('empty columns have empty entries array', () => {
      store.entries = [makeIssue({ id: 'i1', status: 'backlog' })]
      expect(store.columns[1].entries).toEqual([])
      expect(store.columns[2].entries).toEqual([])
      expect(store.columns[3].entries).toEqual([])
      expect(store.columns[4].entries).toEqual([])
    })
  })

  // ---- Computed: filteredKnowledge ----

  describe('filteredKnowledge', () => {
    it('returns all knowledge entries when no search/filter', () => {
      store.entries = [makeKnowledge({ id: 'n1' }), makeKnowledge({ id: 'n2' })]
      expect(store.filteredKnowledge).toHaveLength(2)
    })

    it('filters by tag when noteTagFilter is set', () => {
      store.entries = [
        makeKnowledge({ id: 'n1', tags: ['design'] }),
        makeKnowledge({ id: 'n2', tags: ['backend'] }),
      ]
      store.noteTagFilter = 'design'
      expect(store.filteredKnowledge).toHaveLength(1)
      expect(store.filteredKnowledge[0].id).toBe('n1')
    })

    it('filters by search query (matches title)', () => {
      store.entries = [
        makeKnowledge({ id: 'n1', title: 'Architecture decisions' }),
        makeKnowledge({ id: 'n2', title: 'Meeting notes' }),
      ]
      store.noteSearch = 'architecture'
      expect(store.filteredKnowledge).toHaveLength(1)
      expect(store.filteredKnowledge[0].id).toBe('n1')
    })

    it('filters by search query (matches body)', () => {
      store.entries = [
        makeKnowledge({ id: 'n1', body: 'We discussed the database migration' }),
        makeKnowledge({ id: 'n2', body: 'Nothing relevant here' }),
      ]
      store.noteSearch = 'database'
      expect(store.filteredKnowledge).toHaveLength(1)
      expect(store.filteredKnowledge[0].id).toBe('n1')
    })

    it('combines tag filter and search', () => {
      store.entries = [
        makeKnowledge({ id: 'n1', title: 'API design', tags: ['design'] }),
        makeKnowledge({ id: 'n2', title: 'UI design', tags: ['design'] }),
        makeKnowledge({ id: 'n3', title: 'API refactor', tags: ['backend'] }),
      ]
      store.noteTagFilter = 'design'
      store.noteSearch = 'api'
      expect(store.filteredKnowledge).toHaveLength(1)
      expect(store.filteredKnowledge[0].id).toBe('n1')
    })

    it('sorts by updated desc', () => {
      store.entries = [
        makeKnowledge({ id: 'n1', updated: '2026-05-19T08:00:00.000Z' }),
        makeKnowledge({ id: 'n2', updated: '2026-05-19T14:00:00.000Z' }),
        makeKnowledge({ id: 'n3', updated: '2026-05-19T10:00:00.000Z' }),
      ]
      const ids = store.filteredKnowledge.map(n => n.id)
      expect(ids).toEqual(['n2', 'n3', 'n1'])
    })
  })

  // ---- Computed: allTags ----

  describe('allTags', () => {
    it('collects unique tags from all entries', () => {
      store.entries = [
        makeIssue({ tags: ['bug', 'urgent'] }),
        makeKnowledge({ tags: ['bug', 'design'] }),
      ]
      expect(store.allTags).toEqual(['bug', 'design', 'urgent'])
    })

    it('returns sorted array', () => {
      store.entries = [
        makeKnowledge({ tags: ['zebra', 'alpha', 'middle'] }),
      ]
      expect(store.allTags).toEqual(['alpha', 'middle', 'zebra'])
    })

    it('returns empty array when no tags', () => {
      store.entries = [makeIssue({ tags: [] }), makeKnowledge({ tags: [] })]
      expect(store.allTags).toEqual([])
    })
  })

  // ---- Computed: selectedEntry ----

  describe('selectedEntry', () => {
    it('returns entry when selectedEntryId matches', () => {
      store.entries = [makeIssue({ id: 'issue-1' })]
      store.selectedEntryId = 'issue-1'
      expect(store.selectedEntry).not.toBeNull()
      expect(store.selectedEntry.id).toBe('issue-1')
    })

    it('returns null when no match', () => {
      store.entries = [makeIssue({ id: 'issue-1' })]
      store.selectedEntryId = 'nonexistent'
      expect(store.selectedEntry).toBeNull()
    })

    it('returns null when selectedEntryId is empty', () => {
      store.entries = [makeIssue({ id: 'issue-1' })]
      store.selectedEntryId = ''
      expect(store.selectedEntry).toBeNull()
    })
  })

  // ---- Computed: boardSummary ----

  describe('boardSummary', () => {
    it('returns correct issue and note counts', () => {
      store.entries = [
        makeIssue({ id: 'i1', status: 'backlog' }),
        makeIssue({ id: 'i2', status: 'done' }),
        makeKnowledge({ id: 'n1' }),
      ]
      expect(store.boardSummary.issueCount).toBe(2)
      expect(store.boardSummary.knowledgeCount).toBe(1)
    })

    it('returns byStatus counts for each column status', () => {
      store.entries = [
        makeIssue({ id: 'i1', status: 'backlog' }),
        makeIssue({ id: 'i2', status: 'backlog' }),
        makeIssue({ id: 'i3', status: 'review' }),
        makeIssue({ id: 'i4', status: 'done' }),
      ]
      expect(store.boardSummary.byStatus).toEqual({
        backlog: 2,
        plan: 0,
        'in-progress': 0,
        review: 1,
        done: 1,
      })
    })
  })

  // ---- Action: loadBoard ----

  describe('loadBoard', () => {
    it('calls discoverEntries with project ID', async () => {
      discoverEntries.mockResolvedValue([])
      await store.loadBoard('proj-1')
      expect(discoverEntries).toHaveBeenCalledWith('proj-1')
    })

    it('sets entries from result', async () => {
      const entries = [makeIssue(), makeKnowledge()]
      discoverEntries.mockResolvedValue(entries)
      await store.loadBoard('proj-1')
      expect(store.entries).toEqual(entries)
    })

    it('sets activeProjectId', async () => {
      discoverEntries.mockResolvedValue([])
      await store.loadBoard('proj-1')
      expect(store.activeProjectId).toBe('proj-1')
    })

    it('handles errors gracefully (entries becomes [])', async () => {
      store.entries = [makeIssue()]
      discoverEntries.mockRejectedValue(new Error('disk error'))
      await store.loadBoard('proj-1')
      expect(store.entries).toEqual([])
    })

    it('sets loading flag during load', async () => {
      let resolve
      discoverEntries.mockReturnValue(new Promise(r => { resolve = r }))

      const promise = store.loadBoard('proj-1')
      // Allow the dynamic import() to settle so discoverEntries is called
      await vi.dynamicImportSettled()
      expect(store.loading).toBe(true)

      resolve([])
      await promise
      expect(store.loading).toBe(false)
    })
  })

  // ---- Action: createEntry ----

  describe('createEntry', () => {
    beforeEach(() => {
      store.activeProjectId = 'proj-1'
      discoverEntries.mockResolvedValue([])
    })

    it('calls writeEntry with null ID and correct meta', async () => {
      writeEntry.mockResolvedValue('new-id')
      await store.createEntry('issue', { title: 'New issue', status: 'backlog', priority: 'high' }, 'body')
      expect(writeEntry).toHaveBeenCalledWith(
        'proj-1',
        null,
        { title: 'New issue', status: 'backlog', priority: 'high', type: 'issue' },
        'body',
      )
    })

    it('reloads board after creation', async () => {
      writeEntry.mockResolvedValue('new-id')
      await store.createEntry('issue', { title: 'New' })
      expect(discoverEntries).toHaveBeenCalledWith('proj-1')
    })

    it('returns the new entry ID', async () => {
      writeEntry.mockResolvedValue('issue-abc-123')
      const id = await store.createEntry('issue', { title: 'X' })
      expect(id).toBe('issue-abc-123')
    })

    it('does nothing when no activeProjectId', async () => {
      store.activeProjectId = ''
      const id = await store.createEntry('issue', { title: 'X' })
      expect(id).toBeNull()
      expect(writeEntry).not.toHaveBeenCalled()
    })
  })

  // ---- Action: updateEntry ----

  describe('updateEntry', () => {
    beforeEach(() => {
      store.activeProjectId = 'proj-1'
      discoverEntries.mockResolvedValue([])
    })

    it('calls writeEntry with existing ID', async () => {
      writeEntry.mockResolvedValue('issue-1')
      await store.updateEntry('issue-1', { type: 'issue', title: 'Updated' }, 'new body')
      expect(writeEntry).toHaveBeenCalledWith(
        'proj-1',
        'issue-1',
        { type: 'issue', title: 'Updated' },
        'new body',
      )
    })

    it('reloads board after update', async () => {
      writeEntry.mockResolvedValue('issue-1')
      await store.updateEntry('issue-1', { type: 'issue', title: 'Updated' }, 'body')
      expect(discoverEntries).toHaveBeenCalledWith('proj-1')
    })
  })

  // ---- Action: removeEntry ----

  describe('removeEntry', () => {
    beforeEach(() => {
      store.activeProjectId = 'proj-1'
      deleteEntry.mockResolvedValue()
    })

    it('calls deleteEntry with correct ID and type', async () => {
      store.entries = [makeIssue({ id: 'issue-1' })]
      await store.removeEntry('issue-1')
      expect(deleteEntry).toHaveBeenCalledWith('proj-1', 'issue-1', 'issue')
    })

    it('passes knowledge type when removing knowledge entry', async () => {
      store.entries = [makeKnowledge({ id: 'knowledge-1' })]
      await store.removeEntry('knowledge-1')
      expect(deleteEntry).toHaveBeenCalledWith('proj-1', 'knowledge-1', 'knowledge')
    })

    it('removes entry from local entries array', async () => {
      store.entries = [makeIssue({ id: 'issue-1' }), makeKnowledge({ id: 'knowledge-1' })]
      await store.removeEntry('issue-1')
      expect(store.entries).toHaveLength(1)
      expect(store.entries[0].id).toBe('knowledge-1')
    })

    it('clears selectedEntryId if removed entry was selected', async () => {
      store.entries = [makeIssue({ id: 'issue-1' })]
      store.selectedEntryId = 'issue-1'
      await store.removeEntry('issue-1')
      expect(store.selectedEntryId).toBe('')
    })
  })

  // ---- Action: moveIssue ----

  describe('moveIssue', () => {
    beforeEach(() => {
      store.activeProjectId = 'proj-1'
    })

    it('optimistically updates status in local state', async () => {
      store.entries = [makeIssue({ id: 'issue-1', status: 'backlog' })]
      moveEntry.mockResolvedValue()
      await store.moveIssue('issue-1', 'review')
      expect(store.entries[0].meta.status).toBe('review')
    })

    it('calls moveEntry on loader', async () => {
      store.entries = [makeIssue({ id: 'issue-1', status: 'backlog' })]
      moveEntry.mockResolvedValue()
      await store.moveIssue('issue-1', 'review')
      expect(moveEntry).toHaveBeenCalledWith('proj-1', 'issue-1', 'review')
    })

    it('rolls back on failure', async () => {
      store.entries = [makeIssue({ id: 'issue-1', status: 'backlog' })]
      moveEntry.mockRejectedValue(new Error('write failed'))
      await store.moveIssue('issue-1', 'review')
      expect(store.entries[0].meta.status).toBe('backlog')
    })
  })

  // ---- Action: selectEntry / clearSelection ----

  describe('selectEntry / clearSelection', () => {
    it('selectEntry sets selectedEntryId', () => {
      store.selectEntry('issue-1')
      expect(store.selectedEntryId).toBe('issue-1')
    })

    it('clearSelection resets selectedEntryId to empty string', () => {
      store.selectedEntryId = 'issue-1'
      store.clearSelection()
      expect(store.selectedEntryId).toBe('')
    })
  })

  // ---- Action: buildBoardContext ----

  describe('buildBoardContext', () => {
    it('returns empty string when no entries', () => {
      store.entries = []
      expect(store.buildBoardContext()).toBe('')
    })

    it('returns formatted context with issue counts, active issues, recent notes, and tags', () => {
      store.entries = [
        makeIssue({ id: 'i1', title: 'Fix login', status: 'in-progress', priority: 'high', tags: ['auth'] }),
        makeIssue({ id: 'i2', title: 'Add tests', status: 'done', priority: 'normal' }),
        makeKnowledge({ id: 'n1', title: 'Sprint plan', tags: ['planning'] }),
      ]
      const ctx = store.buildBoardContext()

      expect(ctx).toContain('2 issues')
      expect(ctx).toContain('1 knowledge entries')
      expect(ctx).toContain('Fix login')
      expect(ctx).toContain('in-progress')
      expect(ctx).toContain('high priority')
      expect(ctx).toContain('Sprint plan')
      expect(ctx).toContain('auth')
      expect(ctx).toContain('planning')
    })

    it('contains board-context XML tags', () => {
      store.entries = [makeIssue()]
      const ctx = store.buildBoardContext()
      expect(ctx).toMatch(/^<board-context>/)
      expect(ctx).toMatch(/<\/board-context>$/)
    })
  })
})
