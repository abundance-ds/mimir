import { createPinia, setActivePinia } from 'pinia'
import { effectScope, nextTick, reactive } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useBusinessGraphStore } from '../../../stores/businessGraph.js'
import { useGraphViewState } from './useGraphViewState.js'
import { groupWorkRows } from './workRow.js'

describe('Work closed issue visibility', () => {
  let scope, graph
  beforeEach(() => {
    setActivePinia(createPinia())
    scope = effectScope()
    graph = useBusinessGraphStore()
    graph.nodes = [
      { id: 'project', kind: 'project', title: 'Project' },
      { id: 'active', kind: 'issue', title: 'Active issue', projectId: 'project' },
      { id: 'closed', kind: 'issue', title: 'Closed issue', status: 'done' },
      { id: 'cancelled', kind: 'issue', title: 'Cancelled issue', status: 'cancelled', projectId: 'old-label' },
    ]
  })
  afterEach(() => scope.stop())

  function render(work = {}) {
    const settings = reactive({ settingsReady: true, businessGraphViewState: { work }, set: vi.fn() })
    const state = scope.run(() => useGraphViewState({ graph, settings }))
    return { state, settings }
  }

  it('defaults old settings to open work without losing statusless issues', () => {
    const { state } = render({ groupBy: 'project' })
    expect(state.showClosedIssues.value).toBe(false)
    expect(state.showEmptyProjects.value).toBe(false)
    expect(state.boardIssues.value.map(issue => issue.id)).toEqual(['active'])
    expect(state.boardStatuses.value.map(status => status.id)).toContain('done')
    expect(state.boardStatuses.value.map(status => status.id)).not.toContain('cancelled')
    expect(state.emptyCopy.value).toContain('Show closed issues in Display')
  })

  it('keeps the No project baseline stable through search without including hidden closed issues', () => {
    const { state } = render()
    graph.searchQuery = 'absent'
    expect(state.boardIssues.value).toEqual([])
    expect(state.unsearchedWorkIssues.value.map(issue => issue.id)).toEqual(['active'])
    state.showClosedIssues.value = true
    expect(state.unsearchedWorkIssues.value).toHaveLength(3)
    expect(state.boardIssues.value).toEqual([])
  })

  it('uses all task filters for the column baseline but never search', () => {
    graph.nodes.push(
      { id: 'urgent', kind: 'issue', title: 'Urgent task', projectId: 'project', priority: 'high', assigneeId: 'owner' },
      { id: 'other', kind: 'issue', title: 'Other task', priority: 'high' },
    )
    const { state } = render()
    graph.searchQuery = 'absent'
    state.priorityFilter.value = 'high'
    expect(state.unsearchedWorkIssues.value.map(issue => issue.id)).toEqual(['urgent', 'other'])
    state.assigneeFilter.value = 'owner'
    expect(state.unsearchedWorkIssues.value.map(issue => issue.id)).toEqual(['urgent'])
    state.assigneeFilter.value = '__unassigned__'
    expect(state.unsearchedWorkIssues.value.map(issue => issue.id)).toEqual(['other'])
    state.projectFilter.value = 'project'
    expect(state.unsearchedWorkIssues.value).toEqual([])
    state.assigneeFilter.value = ''
    expect(state.unsearchedWorkIssues.value.map(issue => issue.id)).toEqual(['urgent'])
    expect(state.boardIssues.value).toEqual([])
  })

  it('saves and restores both values of the empty-project preference', async () => {
    const { state, settings } = render()
    state.showEmptyProjects.value = true
    await nextTick()
    const saved = settings.set.mock.lastCall[1]
    const restored = render(saved.work)
    expect(restored.state.showEmptyProjects.value).toBe(true)
    restored.state.showEmptyProjects.value = false
    await nextTick()
    expect(restored.settings.set.mock.lastCall[1].work.showEmptyProjects).toBe(false)
  })

  it('gives visible Cancelled issues their own list group', () => {
    const { state } = render({ showClosedIssues: true })
    expect(groupWorkRows(state.boardIssues.value).map(group => [group.id, group.items.length]))
      .toEqual([['backlog', 1], ['done', 1], ['cancelled', 1]])
  })

  it('persists switching the setting off and restores false', async () => {
    const { state, settings } = render({ showClosedIssues: true })
    state.showClosedIssues.value = false
    await nextTick()
    const saved = settings.set.mock.lastCall[1]
    expect(saved.work.showClosedIssues).toBe(false)
    scope.stop()
    scope = effectScope()
    const restored = render(saved.work).state
    expect(restored.showClosedIssues.value).toBe(false)
    expect(restored.boardIssues.value.map(issue => issue.id)).toEqual(['active'])
  })
})
