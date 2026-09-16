import { effectScope, reactive, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useGraphMutations } from './useGraphMutations.js'
import { UNASSIGNED } from './workRow.js'

describe('project board drag ordering', () => {
  let scope, graph, actions, boardIssues
  const owner = { relation: 'assigned_to', target: 'owner', legacy: false }
  const related = { relation: 'related_to', target: 'note', legacy: false }
  const task = (id, projectId, rank) => ({
    id, kind: 'issue', title: id, status: 'plan', assigneeId: 'owner', projectId, rank,
    sourceRevision: `${id}-revision`,
    relations: [owner, related, ...(projectId ? [{ relation: 'part_of', target: projectId, legacy: false }] : [])],
  })

  beforeEach(() => {
    scope = effectScope()
    boardIssues = ref([])
    graph = reactive({
      projects: [{ id: 'project', kind: 'project', title: 'Project' }],
      update: vi.fn(async patch => ({ id: patch.id, sourceRevision: `${patch.id}-updated` })),
    })
    actions = scope.run(() => useGraphMutations({
      graph, boardIssues, diagnostic: vi.fn(), restoreGraphFocus: vi.fn(),
    }))
  })
  afterEach(() => scope.stop())

  function resultingOrder() {
    const ranks = new Map(graph.update.mock.calls.map(([patch]) => [patch.id, patch.setProperties.rank]))
    return [...boardIssues.value]
      .filter(issue => ranks.has(issue.id))
      .sort((a, b) => ranks.get(a.id) - ranks.get(b.id) || a.title.localeCompare(b.title))
      .map(issue => issue.id)
  }

  it.each(['old-label', 'deleted-project', ''])('reorders %s in No project without changing any assignment', async projectId => {
    const loose = task('loose', '', 1000)
    const orphan = task('a-orphan', 'missing-project', 2000)
    const moved = task('z-moved', projectId, 3000)
    boardIssues.value = [loose, orphan, moved, task('assigned', 'project', 1000)]
    await actions.reorderIssue({ issue: moved, columnId: UNASSIGNED, beforeId: orphan.id, groupBy: 'project' })
    expect(resultingOrder()).toEqual(['loose', 'z-moved', 'a-orphan'])
    for (const [patch] of graph.update.mock.calls) {
      expect(patch).toEqual({
        id: patch.id, expectedRevision: `${patch.id}-revision`, setProperties: { rank: expect.any(Number) },
      })
    }
  })

  it('moves from a project before an orphan, clearing only the moved task project assignment', async () => {
    const moved = task('z-moved', 'project', 1000)
    const orphan = task('a-orphan', 'deleted-project', 1000)
    const loose = task('loose', '', 2000)
    boardIssues.value = [moved, orphan, loose]
    await actions.reorderIssue({ issue: moved, columnId: UNASSIGNED, beforeId: orphan.id, groupBy: 'project' })
    expect(resultingOrder()).toEqual(['z-moved', 'a-orphan', 'loose'])
    expect(graph.update).toHaveBeenCalledWith({
      id: moved.id, expectedRevision: moved.sourceRevision, setProperties: { rank: 1000 },
      relations: [owner, related], removeProperties: ['legacyProject'],
    })
    for (const [patch] of graph.update.mock.calls.filter(([patch]) => patch.id !== moved.id)) {
      expect(Object.keys(patch).sort()).toEqual(['expectedRevision', 'id', 'setProperties'])
      expect(Object.keys(patch.setProperties)).toEqual(['rank'])
    }
  })

  it('appends a card after all No project variants when dropped at the end', async () => {
    const moved = task('moved', 'project', 1000)
    boardIssues.value = [task('orphan', 'missing', 1000), task('legacy', 'old-label', 2000), task('loose', '', 3000), moved]
    await actions.reorderIssue({ issue: moved, columnId: UNASSIGNED, beforeId: null, groupBy: 'project' })
    expect(resultingOrder()).toEqual(['orphan', 'legacy', 'loose', 'moved'])
  })

  it('replaces an orphaned assignment when moving into a real project', async () => {
    const moved = task('orphan', 'deleted-project', 1000)
    boardIssues.value = [task('assigned', 'project', 1000), moved]
    await actions.reorderIssue({ issue: moved, columnId: 'project', beforeId: null, groupBy: 'project' })
    expect(resultingOrder()).toEqual(['assigned', 'orphan'])
    expect(graph.update).toHaveBeenCalledWith({
      id: moved.id, expectedRevision: moved.sourceRevision,
      setProperties: { rank: 2000, legacyProject: 'project' },
      relations: [owner, related, { relation: 'part_of', target: 'project', legacy: false }],
    })
  })

  it('changes only rank when reordering within a real project', async () => {
    const moved = task('moved', 'project', 1000)
    boardIssues.value = [moved, task('other', 'project', 2000)]
    await actions.reorderIssue({ issue: moved, columnId: 'project', beforeId: null, groupBy: 'project' })
    expect(resultingOrder()).toEqual(['other', 'moved'])
    expect(graph.update).toHaveBeenCalledWith({
      id: moved.id, expectedRevision: moved.sourceRevision, setProperties: { rank: 2000 },
    })
  })
})

describe('closed issue Undo', () => {
  let scope, graph, actions, diagnostic
  const issue = { id: 'a', kind: 'issue', title: 'Active issue', status: 'plan', rank: 42, sourceRevision: 'before' }

  beforeEach(() => {
    scope = effectScope()
    diagnostic = vi.fn()
    graph = reactive({
      nodes: [issue],
      update: vi.fn(async patch => ({ id: patch.id, provenance: { sourceRevision: `closed-${patch.id}` } })),
    })
    actions = scope.run(() => useGraphMutations({
      graph, boardIssues: ref([issue]), diagnostic, restoreGraphFocus: vi.fn(),
    }))
  })
  afterEach(() => scope.stop())

  it('does not offer Undo for a rejected close or for a project move', async () => {
    graph.update.mockRejectedValueOnce(new Error('Conflict'))
    await actions.moveIssue({ issue, status: 'done' })
    expect(actions.closedIssueUndo.value).toBeNull()
    await actions.moveIssue({ issue, projectId: 'project-a' })
    expect(actions.closedIssueUndo.value).toBeNull()
  })

  it('restores a dragged issue status and original rank', async () => {
    await actions.reorderIssue({ issue, columnId: 'done', groupBy: 'status' })
    await actions.undoClosedIssues()
    expect(graph.update).toHaveBeenLastCalledWith({
      id: 'a', expectedRevision: 'closed-a', setProperties: { status: 'plan', rank: 42 }, removeProperties: [],
    })
  })

  it('keeps the closing revision after a conflict and offers a retry without overwriting later edits', async () => {
    await actions.patchIssue({ issue, setProperties: { status: 'cancelled' } })
    graph.nodes = [{ ...issue, status: 'cancelled', sourceRevision: 'someone-elses-edit' }]
    graph.update.mockRejectedValueOnce(new Error('Revision conflict'))
    await actions.undoClosedIssues()
    expect(actions.closedIssueUndoError.value).toContain('Revision conflict')
    expect(actions.closedIssueUndo.value.entries).toHaveLength(1)
    await actions.undoClosedIssues()
    expect(graph.update).toHaveBeenLastCalledWith(expect.objectContaining({ expectedRevision: 'closed-a' }))
    expect(actions.closedIssueUndo.value).toBeNull()
  })

  it('undoes only successful bulk closes and retries only failed restores', async () => {
    const second = { ...issue, id: 'b', status: undefined }
    graph.update.mockRejectedValueOnce(new Error('Close conflict'))
    await actions.bulkMoveIssues({ issues: [{ ...issue, id: 'failed' }, issue, second], columnId: 'done', groupBy: 'status' })
    expect(actions.closedIssueUndo.value.entries.map(entry => entry.patch.id)).toEqual(['a', 'b'])
    graph.update.mockRejectedValueOnce(new Error('Restore conflict'))
    await actions.undoClosedIssues()
    expect(graph.update).toHaveBeenLastCalledWith(expect.objectContaining({
      id: 'b', setProperties: {}, removeProperties: ['status'],
    }))
    expect(actions.closedIssueUndo.value.entries.map(entry => entry.patch.id)).toEqual(['a'])
    await actions.undoClosedIssues()
    expect(actions.closedIssueUndo.value).toBeNull()
    expect(diagnostic).toHaveBeenCalledTimes(2)
  })

  it('ignores repeated Undo clicks while a restore is pending', async () => {
    await actions.moveIssue({ issue, status: 'done' })
    let finish
    graph.update.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = actions.undoClosedIssues()
    await actions.undoClosedIssues()
    actions.dismissClosedIssueUndo()
    expect(graph.update).toHaveBeenCalledTimes(2)
    expect(actions.closedIssueUndo.value).not.toBeNull()
    finish({})
    await pending
    expect(actions.undoingClosedIssues.value).toBe(false)
  })
})

describe('document navigation after graph mutations', () => {
  let scope, graph, actions, openNode
  beforeEach(() => {
    scope = effectScope()
    openNode = vi.fn()
    graph = reactive({
      section: 'work', workspaceProjectId: 'project-alpha',
      create: vi.fn(async () => ({ id: 'created' })),
      undoDelete: vi.fn(async () => ({ id: 'restored' })),
    })
    actions = scope.run(() => useGraphMutations({
      graph, boardIssues: ref([]), diagnostic: vi.fn(),
      restoreGraphFocus: vi.fn(), openNode,
    }))
  })
  afterEach(() => scope.stop())

  it('opens the saved entry after creation and keeps its project relationship', async () => {
    actions.openCreate('issue')
    await actions.createNode({ kind: 'issue', title: 'Created' }, { another: false })
    expect(graph.create).toHaveBeenCalledWith(expect.objectContaining({
      relations: [{ relation: 'part_of', target: 'project-alpha', legacy: false }],
    }))
    expect(actions.createOpen.value).toBe(false)
    expect(openNode).toHaveBeenCalledWith('created')
  })

  it('uses the selected time sheet project instead of adding a second parent relation', async () => {
    actions.openRelatedCreate({ kind: 'timesheet', parent: { kind: 'project', id: 'project-alpha' } })
    expect(actions.createKind.value).toBe('timesheet')
    await actions.createNode({ kind: 'timesheet', title: 'September', properties: { period: '2026-09', entries: [] },
      relations: [{ relation: 'part_of', target: 'project-beta' }, { relation: 'assigned_to', target: 'alex' }],
    }, { another: false })
    expect(graph.create.mock.calls[0][0].relations).toEqual([
      { relation: 'part_of', target: 'project-beta' }, { relation: 'assigned_to', target: 'alex' },
    ])
  })

  it('keeps Create another in its form until the user finishes creation', async () => {
    actions.openCreate('issue')
    const reset = vi.fn()
    await actions.createNode({ kind: 'issue', title: 'Created' }, { another: true, reset })
    expect(reset).toHaveBeenCalledOnce()
    expect(actions.createOpen.value).toBe(true)
    expect(openNode).not.toHaveBeenCalled()
  })

  it('opens a restored entry after Undo but does not navigate after failure', async () => {
    await actions.undoDelete()
    expect(openNode).toHaveBeenCalledWith('restored')
    graph.undoDelete.mockRejectedValueOnce(new Error('Restore conflict'))
    await actions.undoDelete()
    expect(actions.undoError.value).toBe('Restore conflict')
    expect(openNode).toHaveBeenCalledOnce()
  })

  it('keeps a failed create draft in the dialog without opening a document', async () => {
    actions.openCreate('issue')
    graph.create.mockRejectedValueOnce(new Error('Read-only scope'))
    await actions.createNode({ kind: 'issue', title: 'Created' }, { another: false })
    expect(actions.createOpen.value).toBe(true)
    expect(actions.createError.value).toBe('Read-only scope')
    expect(openNode).not.toHaveBeenCalled()
  })
})
