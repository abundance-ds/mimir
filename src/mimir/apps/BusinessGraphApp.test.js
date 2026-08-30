import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../services/businessGraph.js', () => ({
  createGraphNode: vi.fn(),
  deleteGraphNode: vi.fn(),
  getGraphNode: vi.fn(),
  graphContext: vi.fn(),
  graphDiagnostics: vi.fn(),
  graphEvents: vi.fn(),
  graphNeighbors: vi.fn(),
  listenForGraphChanges: vi.fn(),
  openBusinessGraph: vi.fn(),
  queryGraph: vi.fn(),
  restoreGraphNode: vi.fn(),
  searchGraph: vi.fn(),
  updateGraphNode: vi.fn(),
}))

vi.mock('../../services/externalLinks.js', () => ({
  openExternalUrl: vi.fn(),
}))

vi.mock('../../services/meetings.js', async importOriginal => ({
  ...(await importOriginal()),
  fileMeetingToGraph: vi.fn(),
}))

import {
  createGraphNode,
  deleteGraphNode,
  getGraphNode,
  graphContext,
  graphDiagnostics,
  graphEvents,
  graphNeighbors,
  listenForGraphChanges,
  openBusinessGraph,
  queryGraph,
  searchGraph,
  updateGraphNode,
} from '../../services/businessGraph.js'
import { openExternalUrl } from '../../services/externalLinks.js'
import { fileMeetingToGraph } from '../../services/meetings.js'
import { useBusinessGraphStore } from '../../stores/businessGraph.js'
import { useLaunchersStore } from '../../stores/launchers.js'
import { useMeetingsStore } from '../../stores/meetings.js'
import { useSettingsStore } from '../../stores/settings.js'
import BusinessGraphApp from './BusinessGraphApp.vue'
import DispatchBar from './business-graph/DispatchBar.vue'
import GraphInspector from './business-graph/GraphInspector.vue'
import GraphSummaryDialog from './business-graph/GraphSummaryDialog.vue'

const scopeRows = [
  { id: 'private:local', kind: 'private', root: '/private' },
  { id: 'project:alpha', kind: 'project', root: '/alpha' },
  { id: 'team:main', kind: 'team', root: '/team' },
]
const summaries = [
  {
    id: 'issue-1',
    kind: 'issue',
    title: 'Extract evidence',
    summary: '',
    tags: ['heor'],
    status: 'plan',
    priority: 'high',
    projectId: 'project-alpha',
    scopeId: 'project:alpha',
    sourceRevision: 'issue-rev',
  },
  {
    id: 'project-alpha',
    kind: 'project',
    title: 'Project Alpha',
    summary: 'Global value evidence strategy',
    tags: ['client'],
    scopeId: 'team:main',
    sourceRevision: 'project-rev',
  },
  {
    id: 'issue-legacy',
    kind: 'issue',
    title: 'Reply to Anna',
    summary: '',
    tags: [],
    status: 'review',
    priority: 'normal',
    projectId: 'fde',
    scopeId: 'project:alpha',
    sourceRevision: 'legacy-rev',
  },
]
const initialSummaries = JSON.parse(JSON.stringify(summaries))

function full(id) {
  const summary = summaries.find(item => item.id === id)
  return {
    ...summary,
    body: id === 'issue-1' ? 'Review extraction criteria.' : 'Project context.',
    createdAt: '2026-07-20T08:15:00Z',
    updatedAt: '2026-08-15T14:45:00Z',
    relations: id === 'issue-1'
      ? [{ relation: 'part_of', target: 'project-alpha', legacy: false }]
      : [],
    properties: {
      'issue-1': {
        status: 'plan',
        priority: 'high',
        legacyProject: 'project-alpha',
        labels: [{ name: 'heor', color: 'blue' }],
      },
      // A source written before projects were graph nodes: the project and
      // assignee are plain labels, not ids.
      'issue-legacy': {
        status: 'review',
        priority: 'normal',
        legacyProject: 'fde',
        legacyAssignee: 'Paul',
      },
    }[id] || {},
    provenance: {
      scopeId: summary.scopeId,
      sourceRevision: summary.sourceRevision,
      sourcePath: `/alpha/${id}.md`,
    },
  }
}

describe('BusinessGraphApp', () => {
  let pinia

  beforeEach(() => {
    localStorage.removeItem('mimir:editor:settings:v1')
    summaries.splice(0, summaries.length, ...JSON.parse(JSON.stringify(initialSummaries)))
    pinia = createPinia()
    setActivePinia(pinia)
    vi.resetAllMocks()
    vi.mocked(openBusinessGraph).mockResolvedValue({
      scopes: scopeRows,
      nodeCount: 2,
      diagnosticCount: 0,
      graphRevision: 7,
    })
    vi.mocked(queryGraph).mockResolvedValue({
      items: summaries,
      total: 2,
      graphRevision: 7,
    })
    vi.mocked(graphDiagnostics).mockResolvedValue([])
    vi.mocked(graphEvents).mockResolvedValue({ items: [], total: 0 })
    vi.mocked(graphContext).mockResolvedValue({
      graphRevision: 7,
      markdown: '# Business graph context\n\nIssue context.',
    })
    vi.mocked(graphNeighbors).mockImplementation(async id => (
      id === 'issue-1'
        ? [{
            relation: 'part_of',
            direction: 'outgoing',
            node: summaries[1],
          }]
        : []
    ))
    vi.mocked(getGraphNode).mockImplementation(async id => full(id))
    vi.mocked(listenForGraphChanges).mockResolvedValue(vi.fn())
    vi.mocked(searchGraph).mockResolvedValue([])
    vi.mocked(updateGraphNode).mockImplementation(async patch => {
      const current = full(patch.id)
      const editable = Object.fromEntries(
        ['title', 'summary', 'body', 'tags', 'relations']
          .filter(key => patch[key] !== undefined)
          .map(key => [key, patch[key]]),
      )
      return {
        ...current,
        ...editable,
        properties: {
          ...current.properties,
          ...(patch.setProperties || {}),
        },
        provenance: {
          ...current.provenance,
          sourceRevision: 'next-rev',
        },
      }
    })
    vi.mocked(createGraphNode).mockResolvedValue(full('issue-1'))
    vi.mocked(deleteGraphNode).mockResolvedValue({
      id: 'issue-1',
      undoToken: 'undo-issue-1',
    })
    vi.mocked(fileMeetingToGraph).mockResolvedValue({ graphNodeId: 'meeting-filed' })
  })

  afterEach(async () => {
    await useSettingsStore(pinia).flush()
    localStorage.removeItem('mimir:editor:settings:v1')
  })

  function render() {
    return mount(BusinessGraphApp, {
      attachTo: document.body,
      props: {
        workspacePath: '/alpha',
        active: true,
      },
      global: { plugins: [pinia] },
    })
  }

  it('is one native scoped instrument with a real board and object history', async () => {
    const wrapper = render()
    await flushPromises()

    expect(wrapper.get('[data-business-graph-app]').exists()).toBe(true)
    expect(wrapper.findAll('[data-board-column]')).toHaveLength(6)
    expect(wrapper.get('[data-board-card="issue-1"]').text()).toContain('Extract evidence')
    expect(wrapper.findAll('[data-graph-section]').map(tab => tab.text())).toEqual([
      'Work',
      'Projects',
      'Knowledge',
      'Journal',
      'All',
      'Changes',
    ])

    await wrapper.get('[data-board-card="issue-1"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-inspector-body] .cm-content').text()).toBe('Review extraction criteria.')
    await wrapper.get('[data-inspector-focus]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-business-graph-app]').attributes('data-graph-mode')).toBe('focus')
    expect(wrapper.get('[data-inspector-body] .cm-content').text()).toBe('Review extraction criteria.')
    expect(wrapper.find('[data-graph-context-trail]').exists()).toBe(false)

    await wrapper.get('[data-graph-control="focus-related-project-alpha"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-inspector-title]').element.value).toBe('Project Alpha')
    expect(wrapper.find('[data-graph-context-trail]').exists()).toBe(false)
    expect(wrapper.get('[data-inspector-history-back]').attributes('title'))
      .toBe('Back to Extract evidence')

    await wrapper.get('[data-inspector-history-back]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-inspector-title]').element.value).toBe('Extract evidence')
    expect(wrapper.get('[data-inspector-history-forward]').attributes('title'))
      .toBe('Forward to Project Alpha')

    await wrapper.get('[data-inspector-history-forward]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-inspector-title]').element.value).toBe('Project Alpha')
    wrapper.unmount()
  })

  it('opens a web URL emitted by the editable working note', async () => {
    const wrapper = render()
    await flushPromises()
    await wrapper.get('[data-board-card="issue-1"]').trigger('click')
    await flushPromises()

    wrapper.findComponent(GraphInspector).vm.$emit(
      'open-url',
      'https://example.com/docs',
    )
    await flushPromises()

    expect(openExternalUrl).toHaveBeenCalledWith('https://example.com/docs')
    wrapper.unmount()
  })

  it('converts saved hidden status columns into collapsed columns', async () => {
    const settings = useSettingsStore()
    await settings.load()
    settings.set('businessGraphViewState', {
      section: 'work',
      sectionViews: { work: 'board' },
      work: {
        groupBy: 'status',
        sortBy: 'priority',
        priority: '',
        visibleStatuses: ['plan', 'in-progress', 'waiting', 'review', 'done'],
      },
    })

    const wrapper = render()
    await flushPromises()

    expect(wrapper.get('[data-board-column="backlog"]')
      .attributes('data-board-column-collapsed')).toBe('true')
    expect(wrapper.findAll('[data-board-column]')).toHaveLength(6)
    wrapper.unmount()
  })

  it('persists and restores the complete Work view state', async () => {
    const settings = useSettingsStore()
    await settings.load()
    const wrapper = render()
    await flushPromises()

    await wrapper.get('[data-board-project-filter]').trigger('click')
    document.querySelector('[data-graph-select-option="project-alpha"]').click()
    await flushPromises()
    await wrapper.get('[data-board-group]').trigger('click')
    document.querySelector('[data-graph-select-option="project"]').click()
    await flushPromises()
    await wrapper.get('[data-board-sort]').trigger('click')
    document.querySelector('[data-graph-select-option="updated"]').click()
    await flushPromises()
    await wrapper.get('[data-board-priority-filter]').trigger('click')
    document.querySelector('[data-graph-select-option="high"]').click()
    await flushPromises()
    await wrapper.get('[data-board-group]').trigger('click')
    document.querySelector('[data-graph-select-option="status"]').click()
    await flushPromises()
    await wrapper.get('[data-board-columns-trigger]').trigger('click')
    document.querySelector('[data-graph-control="board-column-backlog"]').click()
    await flushPromises()

    expect(settings.businessGraphViewState.work).toEqual({
      project: 'project-alpha',
      groupBy: 'status',
      sortBy: 'updated',
      priority: 'high',
      collapsedStatuses: ['backlog'],
    })
    await settings.flush()
    wrapper.unmount()

    pinia = createPinia()
    setActivePinia(pinia)
    const restoredSettings = useSettingsStore()
    await restoredSettings.load()
    const restored = render()
    await flushPromises()

    expect(restored.get('[data-board-project-filter]').text()).toContain('Project Alpha')
    expect(restored.get('[data-board-sort]').text()).toContain('Updated')
    expect(restored.get('[data-board-priority-filter]').text()).toContain('High')
    expect(restored.get('[data-board-column="backlog"]')
      .attributes('data-board-column-collapsed')).toBe('true')
    restored.unmount()
  })

  it('keeps the Project view across Work views and section navigation', async () => {
    const wrapper = render()
    await flushPromises()

    await wrapper.get('[data-board-project-filter]').trigger('click')
    document.querySelector('[data-graph-select-option="project-alpha"]').click()
    await wrapper.get('[data-graph-view="list"]').trigger('click')
    expect(wrapper.findAll('[data-graph-node]').map(row => row.attributes('data-graph-node')))
      .toEqual(['issue-1'])

    await wrapper.get('[data-graph-section="projects"]').trigger('click')
    await wrapper.get('[data-graph-section="work"]').trigger('click')

    expect(wrapper.get('[data-board-project-filter]').text()).toContain('Project Alpha')
    expect(wrapper.get('[data-board-project-filter]').classes()).toContain('graph-project-view-active')
    expect(wrapper.findAll('[data-graph-node]').map(row => row.attributes('data-graph-node')))
      .toEqual(['issue-1'])
    wrapper.unmount()
  })

  it('files a meeting and refreshes both Scribe and Graph projections', async () => {
    const wrapper = render()
    await flushPromises()
    const meetings = useMeetingsStore()
    const graph = useBusinessGraphStore()
    meetings.meetings = [{
      id: 'meeting-ready',
      title: 'Delivery review',
      lifecycle: 'ready',
      summary: '# BLUF\n\n- Ship Friday.',
      startedAt: '2026-08-28T10:00:00.000Z',
      durationMs: 1_800_000,
      graphNodeId: null,
      graphDraft: {
        projectResolved: true,
        projectId: null,
        peopleIds: [],
        scopeId: 'team:main',
      },
    }]
    const flushMeeting = vi.spyOn(meetings, 'flushMeetingDraft').mockResolvedValue(true)
    vi.spyOn(meetings, 'hydrateMeeting').mockResolvedValue(meetings.meetings[0])
    const refreshMeetings = vi.spyOn(meetings, 'refresh').mockResolvedValue(true)
    const refreshGraph = vi.spyOn(graph, 'refresh').mockResolvedValue(true)

    await wrapper.get('[data-graph-section="knowledge"]').trigger('click')
    await wrapper.get('[data-graph-view="meetings"]').trigger('click')
    await wrapper.get('[data-meeting-inbox-row="meeting-ready"]').trigger('click')
    await wrapper.get('[data-meeting-file]').trigger('click')
    await flushPromises()

    expect(flushMeeting).toHaveBeenCalledWith('meeting-ready')
    expect(fileMeetingToGraph).toHaveBeenCalledWith({
      meetingId: 'meeting-ready',
      scopeId: 'team:main',
      projectId: null,
      peopleIds: [],
    })
    expect(refreshMeetings).toHaveBeenCalled()
    expect(refreshGraph).toHaveBeenCalledWith({ quiet: true })
    wrapper.unmount()
  })

  it('mounts the shared team root once settings resolve after the first open', async () => {
    const settings = useSettingsStore()
    const wrapper = render()
    await flushPromises()
    expect(openBusinessGraph).toHaveBeenCalledWith('/alpha', '')

    settings.mimirTeamFolder = '/team'
    await flushPromises()

    expect(openBusinessGraph).toHaveBeenCalledTimes(2)
    expect(openBusinessGraph).toHaveBeenLastCalledWith('/alpha', '/team')
    wrapper.unmount()
  })

  it('stops a graph mount that finishes after the app unmounts', async () => {
    let resolveMount
    const unlisten = vi.fn()
    vi.mocked(openBusinessGraph).mockImplementationOnce(() => new Promise(resolve => {
      resolveMount = resolve
    }))
    vi.mocked(listenForGraphChanges).mockResolvedValueOnce(unlisten)
    const wrapper = render()

    expect(openBusinessGraph).toHaveBeenCalledWith('/alpha', '')
    wrapper.unmount()
    resolveMount({
      scopes: scopeRows,
      nodeCount: 2,
      diagnosticCount: 0,
      graphRevision: 7,
    })
    await flushPromises()

    expect(unlisten).toHaveBeenCalledOnce()
  })

  it('saves an issue whose project is a legacy label instead of a graph node', async () => {
    const wrapper = render()
    await flushPromises()

    await wrapper.get('[data-board-card="issue-legacy"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-inspector-waiting]').setValue('Anna')
    await wrapper.get('[data-graph-control="peek-close"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-graph-save-error]').exists()).toBe(false)
    const patch = vi.mocked(updateGraphNode).mock.calls.at(-1)[0]
    expect(patch.relations).toEqual([])
    expect(patch.setProperties.legacyProject).toBe('fde')
    expect(wrapper.get('[data-business-graph-app]').attributes('data-graph-mode')).toBe('scan')
    wrapper.unmount()
  })

  it('launches a selected interactive agent to summarise scoped change history', async () => {
    useLaunchersStore().presets = [{
      id: 'review',
      title: 'Review with Codex',
      kind: 'agent',
      agentId: 'codex',
      binary: '/bin/codex',
      enabled: true,
    }]
    const wrapper = render()
    await flushPromises()
    vi.mocked(graphEvents).mockResolvedValueOnce({
      items: [{
        id: 'event-summary',
        eventType: 'status-changed',
        action: 'graph.update',
        timestamp: '2026-07-29T12:00:00Z',
        graphRevision: 7,
        nodeId: 'issue-1',
        nodeKind: 'issue',
        title: 'Extract evidence',
        scopeId: 'project:alpha',
        summary: 'Status changed from plan to in-progress',
        actor: { kind: 'human', id: 'local', label: 'You' },
        changes: [{ field: 'status', before: 'plan', after: 'in-progress' }],
        data: {},
      }],
      total: 1,
      offset: 0,
      limit: 1,
    })

    wrapper.findComponent(GraphSummaryDialog).vm.$emit('launch', {
      presetId: 'review',
      since: '2026-07-20',
      instructions: 'Focus on decisions.',
    })
    await flushPromises()

    expect(wrapper.emitted('startWork')).toHaveLength(1)
    expect(wrapper.emitted('startWork')[0][0]).toMatchObject({
      presetId: 'review',
      sourceType: 'business-graph-summary',
      nodeId: 'changes',
      nodeKind: 'history',
      title: expect.stringMatching(/^Changes since /),
      scopeIds: scopeRows.map(scope => scope.id),
      graphEventSince: expect.stringMatching(/^2026-07-19T22:00:00\.000Z$|^2026-07-20T/),
      graphEventCount: 1,
      graphContextShortened: false,
    })
    expect(graphEvents).toHaveBeenLastCalledWith({
      scopeIds: scopeRows.map(scope => scope.id),
      since: expect.stringMatching(/^2026-07-19T22:00:00\.000Z$|^2026-07-20T/),
      offset: 0,
      limit: 500,
    })
    expect(wrapper.emitted('startWork')[0][0].prompt)
      .toContain('Mimir fetched the history before launching you.')
    expect(wrapper.emitted('startWork')[0][0].prompt).toContain('You updated issue “Extract evidence”')
    expect(wrapper.emitted('startWork')[0][0].prompt).not.toContain('event-summary')
    expect(wrapper.emitted('startWork')[0][0].prompt).not.toContain('issue-1')
    expect(wrapper.emitted('startWork')[0][0].prompt).toContain('Do not call graph_events')
    expect(wrapper.emitted('startWork')[0][0].prompt).toContain('Focus on decisions.')
    wrapper.unmount()
  })

  it('does not launch an agent when the summary dialog closes during preparation', async () => {
    let resolveEvents
    vi.mocked(graphEvents).mockImplementationOnce(() => new Promise(resolve => {
      resolveEvents = resolve
    }))
    const wrapper = render()
    await flushPromises()
    const dialog = wrapper.findComponent(GraphSummaryDialog)

    dialog.vm.$emit('launch', {
      presetId: 'review',
      since: '2026-07-20',
      instructions: '',
    })
    await Promise.resolve()
    expect(dialog.props('busy')).toBe(true)

    dialog.vm.$emit('close')
    resolveEvents({
      items: [{
        timestamp: '2026-07-29T12:00:00Z',
        eventType: 'updated',
        action: 'graph.update',
        nodeKind: 'issue',
        title: 'Should not launch',
        actor: { kind: 'human', id: 'local-human', label: 'You' },
        changes: [],
      }],
      total: 1,
    })
    await flushPromises()

    expect(wrapper.emitted('startWork')).toBeUndefined()
    expect(dialog.props('busy')).toBe(false)
    wrapper.unmount()
  })

  it('does not launch a change summary after the app unmounts', async () => {
    const wrapper = render()
    await flushPromises()
    let resolveEvents
    vi.mocked(graphEvents).mockImplementationOnce(() => new Promise(resolve => {
      resolveEvents = resolve
    }))
    wrapper.findComponent(GraphSummaryDialog).vm.$emit('launch', {
      presetId: 'review',
      since: '2026-07-20',
      instructions: '',
    })
    await Promise.resolve()

    wrapper.unmount()
    resolveEvents({
      items: [{
        timestamp: '2026-07-29T12:00:00Z',
        eventType: 'updated',
        action: 'graph.update',
        nodeKind: 'issue',
        title: 'Should not launch',
        actor: { kind: 'human', id: 'local-human', label: 'You' },
        changes: [],
      }],
      total: 1,
    })
    await flushPromises()

    expect(wrapper.emitted('startWork')).toBeUndefined()
  })

  it('moves board cards through optimistic revision-aware graph patches', async () => {
    const wrapper = render()
    await flushPromises()

    await wrapper.get('[data-board-columns-trigger]').trigger('click')
    document.querySelector('[data-graph-control="board-column-in-progress"]').click()
    await flushPromises()
    expect(wrapper.get('[data-board-column="in-progress"]')
      .attributes('data-board-column-collapsed')).toBe('true')

    // Pointer-driven, because Tauri swallows the webview's HTML5 drag and drop
    // (docs/gotchas.md#html5-drag-and-drop-is-dead-inside-the-webview).
    const column = wrapper.get('[data-board-column="in-progress"]').element
    document.elementFromPoint = vi.fn(() => column)
    await wrapper.get('[data-board-card="issue-1"]')
      .trigger('pointerdown', { button: 0, clientX: 0, clientY: 0 })
    document.dispatchEvent(
      Object.assign(new Event('pointermove'), { clientX: 200, clientY: 200 }),
    )
    document.dispatchEvent(new Event('pointerup'))
    await flushPromises()

    expect(updateGraphNode).toHaveBeenCalledWith(expect.objectContaining({
      id: 'issue-1',
      expectedRevision: 'issue-rev',
      setProperties: expect.objectContaining({ status: 'in-progress' }),
    }))
    wrapper.unmount()
  })

  it('offers a keyboard-equivalent board move with the same revision-aware patch', async () => {
    const wrapper = render()
    await flushPromises()

    await wrapper.get('[data-board-card="issue-1"]').trigger('keydown', {
      key: 'ArrowRight',
    })
    await flushPromises()

    expect(updateGraphNode).toHaveBeenCalledWith(expect.objectContaining({
      id: 'issue-1',
      expectedRevision: 'issue-rev',
      setProperties: { status: 'in-progress' },
    }))
    wrapper.unmount()
  })

  it('supports keyboard-first creation and explicit physical scope choice', async () => {
    const wrapper = render()
    await flushPromises()
    await wrapper.get('[data-business-graph-app]').trigger('keydown', { key: 'n' })

    expect(document.querySelector('[data-graph-create-dialog]')).not.toBeNull()
    const dialog = document.querySelector('[data-graph-create-dialog]')
    const title = dialog.querySelector('[data-create-title]')
    title.value = 'Draft evidence map'
    title.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    dialog.querySelector('[data-create-submit]').click()
    await flushPromises()

    expect(createGraphNode).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'issue',
      scopeId: 'project:alpha',
      title: 'Draft evidence map',
    }))
    wrapper.unmount()
  })

  it('supports scan, Peek, and Focus entirely from the keyboard', async () => {
    const wrapper = render()
    await flushPromises()

    await wrapper.get('[data-business-graph-app]').trigger('keydown', {
      key: 'f',
      metaKey: true,
    })
    expect(document.activeElement).toBe(wrapper.get('[data-graph-search]').element)

    await wrapper.get('[data-business-graph-app]').trigger('keydown', { key: '/' })
    expect(document.activeElement).toBe(wrapper.get('[data-dispatch-input]').element)

    await wrapper.get('[data-board-card="issue-1"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-business-graph-app]').trigger('keydown', { key: 'f' })
    await flushPromises()
    expect(wrapper.get('[data-business-graph-app]').attributes('data-graph-mode')).toBe('focus')

    await wrapper.get('[data-business-graph-app]').trigger('keydown', { key: 'Escape' })
    expect(wrapper.get('[data-business-graph-app]').attributes('data-graph-mode')).toBe('peek')
    await wrapper.get('[data-business-graph-app]').trigger('keydown', { key: 'Escape' })
    expect(wrapper.get('[data-business-graph-app]').attributes('data-graph-mode')).toBe('scan')
    wrapper.unmount()
  })

  it('keeps a real focus chain through board, Peek, Focus, Escape, and close', async () => {
    const wrapper = render()
    await flushPromises()

    const card = wrapper.get('[data-board-card="issue-1"]')
    card.element.focus()
    await card.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(wrapper.get('[data-business-graph-app]').attributes('data-graph-mode')).toBe('peek')

    const focusButton = wrapper.get('[data-inspector-focus]')
    focusButton.element.focus()
    await focusButton.trigger('click')
    await flushPromises()
    expect(document.activeElement).toBe(wrapper.get('[data-graph-control="focus-back"]').element)

    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
    }))
    await flushPromises()
    expect(wrapper.get('[data-business-graph-app]').attributes('data-graph-mode')).toBe('peek')
    expect(document.activeElement).toBe(wrapper.get('[data-inspector-title]').element)

    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
    }))
    await flushPromises()
    expect(wrapper.get('[data-business-graph-app]').attributes('data-graph-mode')).toBe('scan')
    expect(document.activeElement).toBe(wrapper.get('[data-board-card="issue-1"]').element)
    wrapper.unmount()
  })

  it('lands workbench entry focus in the active projection once the graph settles', async () => {
    const wrapper = render()

    // Requested while the graph is still loading: park on the root so app
    // shortcuts work immediately.
    wrapper.vm.focusEntry()
    expect(document.activeElement).toBe(wrapper.get('[data-business-graph-app]').element)

    await flushPromises()
    expect(document.activeElement).toBe(wrapper.get('[data-board-card="issue-1"]').element)

    // A repeat request must never steal focus already inside the app.
    const input = wrapper.get('[data-dispatch-input]').element
    input.focus()
    wrapper.vm.focusEntry()
    await flushPromises()
    expect(document.activeElement).toBe(input)
    wrapper.unmount()
  })

  it('keeps dispatch focus usable after opening and closing a lookup result', async () => {
    const wrapper = render()
    await flushPromises()
    vi.mocked(searchGraph).mockResolvedValue([{ node: summaries[0] }])

    const input = wrapper.get('[data-dispatch-input]')
    input.element.focus()
    await input.setValue('Extract')
    await new Promise(resolve => setTimeout(resolve, 180))
    await flushPromises()
    await input.trigger('keydown', { key: 'Tab' })
    await flushPromises()

    expect(wrapper.get('[data-business-graph-app]').attributes('data-graph-mode')).toBe('peek')
    expect(document.activeElement).toBe(input.element)
    input.element.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
    }))
    await flushPromises()
    expect(wrapper.get('[data-business-graph-app]').attributes('data-graph-mode')).toBe('scan')
    expect(document.activeElement).toBe(input.element)
    wrapper.unmount()
  })

  it('clears a populated search before allowing Escape to close Peek', async () => {
    const wrapper = render()
    await flushPromises()
    await wrapper.get('[data-board-card="issue-1"]').trigger('click')
    await flushPromises()

    const search = wrapper.get('[data-graph-search]')
    search.element.focus()
    await search.setValue('evidence')
    await search.trigger('keydown', { key: 'Escape' })
    expect(search.element.value).toBe('')
    expect(wrapper.get('[data-business-graph-app]').attributes('data-graph-mode')).toBe('peek')

    await search.trigger('keydown', { key: 'Escape' })
    await flushPromises()
    expect(wrapper.get('[data-business-graph-app]').attributes('data-graph-mode')).toBe('scan')
    wrapper.unmount()
  })

  it('filters the active projection through a persistent debounced search', async () => {
    const wrapper = render()
    await flushPromises()
    vi.mocked(searchGraph).mockResolvedValue([{ node: summaries[0] }])

    const input = wrapper.get('[data-graph-search]')
    await input.setValue('evidence')

    expect(searchGraph).not.toHaveBeenCalled()
    expect(wrapper.get('.graph-searching').attributes('aria-label')).toBe('Searching the graph')

    await new Promise(resolve => setTimeout(resolve, 120))
    await flushPromises()

    expect(searchGraph).toHaveBeenCalledWith('evidence', {
      scopeIds: ['private:local', 'project:alpha', 'team:main'],
      limit: 100,
    })
    expect(wrapper.find('[data-graph-filter-banner]').exists()).toBe(false)
    expect(wrapper.get('.graph-search-count').text()).toBe('1')

    await wrapper.get('[data-graph-control="clear-search"]').trigger('click')
    expect(input.element.value).toBe('')
    expect(wrapper.find('[data-graph-control="clear-search"]').exists()).toBe(false)
    expect(document.activeElement).toBe(input.element)
    wrapper.unmount()
  })

  it('keeps search and kind filters in their controls without adding projection headers', async () => {
    vi.mocked(searchGraph).mockResolvedValue([
      { node: summaries[0] },
      { node: summaries[1] },
    ])
    const wrapper = render()
    await flushPromises()
    await wrapper.get('[data-graph-section="all"]').trigger('click')

    const input = wrapper.get('[data-graph-search]')
    await input.setValue('evidence')
    await new Promise(resolve => setTimeout(resolve, 120))
    await flushPromises()

    const kindReset = wrapper.get('[data-graph-control="all-kind-filter-clear"]')
    expect(kindReset.attributes('disabled')).toBeDefined()
    await wrapper.get('[data-all-kind-filter]').trigger('click')
    document.querySelector('[data-graph-select-option="project"]').click()
    await flushPromises()

    expect(wrapper.get('[data-all-kind-filter]').text()).toContain('Projects')
    expect(kindReset.attributes('disabled')).toBeUndefined()
    expect(wrapper.findAll('[data-graph-node]').map(row => row.attributes('data-graph-node'))).toEqual([
      'project-alpha',
    ])
    expect(wrapper.text()).not.toContain('Showing:')
    expect(wrapper.find('[data-graph-filter-banner]').exists()).toBe(false)

    await kindReset.trigger('click')
    expect(wrapper.get('[data-all-kind-filter]').text()).toContain('All kinds')
    expect(kindReset.attributes('disabled')).toBeDefined()
    expect(wrapper.findAll('[data-graph-node]')).toHaveLength(2)

    await wrapper.get('[data-graph-control="clear-search"]').trigger('click')
    expect(input.element.value).toBe('')
    wrapper.unmount()
  })

  it('resets work filters beside the controls that own them', async () => {
    const wrapper = render()
    await flushPromises()

    const viewbarGroups = wrapper.get('.graph-viewbar').element.children
    expect([...viewbarGroups].map(group => group.className)).toEqual([
      'graph-views',
      'graph-project-view',
      'graph-work-controls',
    ])
    const projectReset = wrapper.get('[data-graph-control="board-project-filter-clear"]')
    expect(projectReset.attributes('disabled')).toBeDefined()
    expect(projectReset.attributes('aria-label')).toBe('All projects are shown')
    expect(wrapper.get('[data-board-project-filter]').classes()).not.toContain('graph-project-view-active')
    await wrapper.get('[data-board-project-filter]').trigger('click')
    document.querySelector('[data-graph-select-option="project-alpha"]').click()
    await flushPromises()
    expect(projectReset.attributes('disabled')).toBeUndefined()
    expect(projectReset.attributes('aria-label')).toBe('Show all projects')
    expect(wrapper.get('[data-board-project-filter]').text()).toContain('Project Alpha')
    expect(wrapper.get('[data-board-project-filter]').classes()).toContain('graph-project-view-active')
    expect(wrapper.get('[data-board-project-filter]').attributes('aria-label'))
      .toBe('Project view: Project Alpha')
    expect(wrapper.findAll('[data-board-card]').map(card => card.attributes('data-board-card')))
      .toEqual(['issue-1'])
    await projectReset.trigger('click')
    expect(wrapper.get('[data-board-project-filter]').text()).toContain('All projects')
    expect(wrapper.get('[data-board-project-filter]').classes()).not.toContain('graph-project-view-active')
    expect(wrapper.findAll('[data-board-card]')).toHaveLength(2)

    await wrapper.get('[data-board-project-filter]').trigger('click')
    document.querySelector('[data-graph-select-option="fde"]').click()
    await flushPromises()
    expect(wrapper.findAll('[data-board-card]').map(card => card.attributes('data-board-card')))
      .toEqual(['issue-legacy'])
    await projectReset.trigger('click')

    const priorityReset = wrapper.get('[data-graph-control="board-priority-filter-clear"]')
    expect(priorityReset.attributes('disabled')).toBeDefined()
    await wrapper.get('[data-board-priority-filter]').trigger('click')
    document.querySelector('[data-graph-select-option="high"]').click()
    await flushPromises()
    expect(priorityReset.attributes('disabled')).toBeUndefined()
    expect(wrapper.get('[data-board-priority-filter]').text()).toContain('High')
    await priorityReset.trigger('click')
    expect(wrapper.get('[data-board-priority-filter]').text()).toContain('All priorities')

    const columnsReset = wrapper.get('[data-graph-control="board-columns-expand-all"]')
    expect(columnsReset.attributes('disabled')).toBeDefined()
    await wrapper.get('[data-board-columns-trigger]').trigger('click')
    document.querySelector('[data-graph-control="board-column-plan"]').click()
    await flushPromises()
    expect(columnsReset.attributes('disabled')).toBeUndefined()
    expect(columnsReset.attributes('aria-label')).toContain('Plan')
    expect(wrapper.findAll('[data-board-column]')).toHaveLength(6)
    expect(wrapper.get('[data-board-column="plan"]').attributes('data-board-column-collapsed'))
      .toBe('true')
    expect(wrapper.get('[data-board-expand="plan"]').text()).toContain('1')
    await wrapper.get('[data-board-expand="plan"]').trigger('click')
    expect(columnsReset.attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-board-column="plan"]').attributes('data-board-column-collapsed'))
      .toBeUndefined()

    document.querySelector('[data-graph-control="board-column-plan"]').click()
    await flushPromises()
    await columnsReset.trigger('click')
    expect(columnsReset.attributes('disabled')).toBeDefined()
    expect(wrapper.findAll('[data-board-column]')).toHaveLength(6)
    expect(wrapper.get('[data-board-column="plan"]').attributes('data-board-column-collapsed'))
      .toBeUndefined()
    wrapper.unmount()
  })

  it('keeps every character typed while replacing a committed search', async () => {
    const wrapper = render()
    await flushPromises()
    vi.mocked(searchGraph).mockResolvedValue([{ node: summaries[0] }])

    const input = wrapper.get('[data-graph-search]')
    await input.setValue('b')
    await new Promise(resolve => setTimeout(resolve, 120))
    await flushPromises()
    expect(input.element.value).toBe('b')

    for (const value of ['ba', 'ban', 'bank']) {
      await input.setValue(value)
      await flushPromises()
      expect(input.element.value).toBe(value)
    }

    await new Promise(resolve => setTimeout(resolve, 120))
    await flushPromises()
    expect(input.element.value).toBe('bank')
    expect(searchGraph).toHaveBeenLastCalledWith('bank', {
      scopeIds: ['private:local', 'project:alpha', 'team:main'],
      limit: 100,
    })
    wrapper.unmount()
  })

  it('moves directly from search into the first or last result with arrow keys', async () => {
    const wrapper = render()
    await flushPromises()
    await wrapper.get('[data-graph-section="all"]').trigger('click')
    vi.mocked(searchGraph).mockResolvedValue([
      { node: summaries[0] },
      { node: summaries[1] },
    ])

    const search = wrapper.get('[data-graph-search]')
    await search.setValue('evidence')
    await new Promise(resolve => setTimeout(resolve, 120))
    await flushPromises()

    await search.trigger('keydown', { key: 'ArrowDown' })
    await flushPromises()
    const listbox = wrapper.get('[data-graph-entity-list]')
    expect(document.activeElement).toBe(listbox.element)
    expect(listbox.attributes('aria-activedescendant')).toBe('graph-list-option-issue-1')

    search.element.focus()
    await search.trigger('keydown', { key: 'ArrowUp' })
    await flushPromises()
    expect(document.activeElement).toBe(listbox.element)
    expect(listbox.attributes('aria-activedescendant')).toBe('graph-list-option-project-alpha')
    await wrapper.get('[data-graph-section="work"]').trigger('click')
    wrapper.unmount()
  })

  it('ignores stale results without overwriting the newer input draft', async () => {
    let resolveFirstSearch
    const firstSearch = new Promise(resolve => {
      resolveFirstSearch = resolve
    })
    vi.mocked(searchGraph).mockImplementation(query => (
      query === 'b'
        ? firstSearch
        : Promise.resolve([{ node: summaries[0] }])
    ))
    const wrapper = render()
    await flushPromises()

    const input = wrapper.get('[data-graph-search]')
    await input.setValue('b')
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(searchGraph).toHaveBeenCalledTimes(1)

    await input.setValue('ba')
    await flushPromises()
    expect(input.element.value).toBe('ba')

    resolveFirstSearch([{ node: summaries[1] }])
    await flushPromises()
    expect(input.element.value).toBe('ba')
    expect(wrapper.find('[data-graph-filter-banner]').exists()).toBe(false)
    expect(wrapper.find('.graph-search-count').exists()).toBe(false)

    await new Promise(resolve => setTimeout(resolve, 120))
    await flushPromises()
    expect(input.element.value).toBe('ba')
    expect(searchGraph).toHaveBeenLastCalledWith('ba', {
      scopeIds: ['private:local', 'project:alpha', 'team:main'],
      limit: 100,
    })
    expect(wrapper.find('[data-graph-filter-banner]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('synchronizes external find and clear commands with the search field', async () => {
    vi.mocked(searchGraph).mockResolvedValue([{ node: summaries[0] }])
    const wrapper = render()
    await flushPromises()

    const dispatch = wrapper.get('[data-dispatch-input]')
    await dispatch.setValue('/find evidence')
    await dispatch.trigger('keydown', { key: 'Enter' })
    await flushPromises()

    const search = wrapper.get('[data-graph-search]')
    expect(search.element.value).toBe('evidence')
    expect(wrapper.get('.graph-search-count').text()).toBe('1')
    expect(wrapper.find('[data-graph-filter-banner]').exists()).toBe(false)

    await wrapper.get('[data-graph-control="clear-search"]').trigger('click')
    await flushPromises()
    expect(search.element.value).toBe('')
    expect(wrapper.find('[data-graph-control="clear-search"]').exists()).toBe(false)

    await dispatch.setValue('/find evidence')
    await dispatch.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(search.element.value).toBe('evidence')

    await dispatch.setValue('/clear')
    await dispatch.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(search.element.value).toBe('')
    expect(wrapper.find('[data-graph-control="clear-search"]').exists()).toBe(false)

    const callsBeforePendingClear = searchGraph.mock.calls.length
    await search.setValue('bank')
    await dispatch.setValue('/clear')
    await dispatch.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(search.element.value).toBe('')
    expect(searchGraph).toHaveBeenCalledTimes(callsBeforePendingClear)
    wrapper.unmount()
  })

  it('dismisses custom scope and column menus when the user clicks elsewhere', async () => {
    const wrapper = render()
    await flushPromises()
    const outside = document.createElement('button')
    document.body.append(outside)

    await wrapper.get('[data-graph-scope-trigger]').trigger('click')
    expect(wrapper.find('[data-graph-scope-menu]').exists()).toBe(true)
    outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await flushPromises()
    expect(wrapper.find('[data-graph-scope-menu]').exists()).toBe(false)

    await wrapper.get('[data-board-columns-trigger]').trigger('click')
    await flushPromises()
    expect(document.querySelector('[data-board-columns-menu]')).not.toBeNull()
    outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await flushPromises()
    expect(document.querySelector('[data-board-columns-menu]')).toBeNull()
    wrapper.unmount()
  })

  it('navigates scope and column menus with arrows and restores their triggers', async () => {
    const wrapper = render()
    await flushPromises()

    const scopeTrigger = wrapper.get('[data-graph-scope-trigger]')
    scopeTrigger.element.focus()
    await scopeTrigger.trigger('keydown', { key: 'ArrowDown' })
    await flushPromises()
    expect(document.activeElement).toBe(wrapper.get('[data-scope-option="private:local"]').element)

    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'End',
      bubbles: true,
    }))
    expect(document.activeElement).toBe(wrapper.get('[data-scope-option="team:main"]').element)
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
    }))
    await flushPromises()
    expect(document.activeElement).toBe(scopeTrigger.element)

    const columnsTrigger = wrapper.get('[data-board-columns-trigger]')
    columnsTrigger.element.focus()
    await columnsTrigger.trigger('keydown', { key: 'ArrowUp' })
    await flushPromises()
    const columnItems = [...document.querySelectorAll(
      '[data-board-columns-menu] [role="menuitemcheckbox"]',
    )]
    expect(document.activeElement).toBe(columnItems.at(-1))
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
    }))
    await flushPromises()
    expect(document.activeElement).toBe(columnsTrigger.element)
    wrapper.unmount()
  })

  it('keeps create, save, and AI preparation errors inside the active surface', async () => {
    const wrapper = render()
    await flushPromises()

    vi.mocked(createGraphNode).mockRejectedValueOnce(new Error('Project source is read-only'))
    await wrapper.get('[data-business-graph-app]').trigger('keydown', { key: 'n' })
    const createDialog = document.querySelector('[data-graph-create-dialog]')
    const title = createDialog.querySelector('[data-create-title]')
    title.value = 'Cannot create this'
    title.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    createDialog.querySelector('[data-create-submit]').click()
    await flushPromises()
    expect(document.querySelector('[data-graph-create-error]').textContent).toContain('read-only')
    createDialog.querySelector('[data-graph-control="create-close"]').click()
    await flushPromises()

    await wrapper.get('[data-board-card="issue-1"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-inspector-focus]').trigger('click')
    await flushPromises()
    vi.mocked(updateGraphNode).mockRejectedValueOnce(new Error('Write failed unexpectedly'))
    await wrapper.get('[data-inspector-title]').setValue('Conflicting title')
    await wrapper.get('[data-inspector-save]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-graph-save-error]').text()).toContain('Write failed unexpectedly')

    vi.mocked(searchGraph).mockResolvedValue([{ node: summaries[0] }])
    vi.mocked(graphContext).mockRejectedValue(new Error('Context could not be assembled'))
    const input = wrapper.get('[data-dispatch-input]')
    await input.trigger('focus')
    await input.setValue('work Extract')
    await new Promise(resolve => setTimeout(resolve, 180))
    await flushPromises()
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(wrapper.get('[data-dispatch-pack]').text()).toContain('Context could not be assembled')
    expect(wrapper.emitted('startWork')).toBeUndefined()
    wrapper.unmount()
  })

  it('uses polished Vue listboxes instead of native dropdowns in every graph flow', async () => {
    const wrapper = render()
    await flushPromises()

    expect(document.querySelector('select, datalist')).toBeNull()
    expect(wrapper.get('[data-board-sort]').attributes('role')).toBe('combobox')

    await wrapper.get('[data-board-card="issue-1"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-inspector-status]').attributes('role')).toBe('combobox')
    expect(wrapper.get('[data-inspector-project]').attributes('role')).toBe('combobox')

    await wrapper.get('[data-inspector-focus]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-inspector-project]').attributes('role')).toBe('combobox')
    expect(wrapper.get('[data-inspector-assignee]').attributes('role')).toBe('combobox')
    expect(wrapper.get('[data-inspector-body] .cm-content').exists()).toBe(true)

    await wrapper.get('[data-business-graph-app]').trigger('keydown', { key: 'n' })
    const dialog = document.querySelector('[data-graph-create-dialog]')
    expect(dialog.querySelector('[data-create-kind]').getAttribute('role')).toBe('combobox')
    expect(dialog.querySelector('[data-create-scope]').getAttribute('role')).toBe('combobox')
    expect(document.querySelector('select, datalist')).toBeNull()
    wrapper.unmount()
  })

  it('assembles bounded scoped context before requesting an agent Activity', async () => {
    const wrapper = render()
    await flushPromises()
    vi.mocked(searchGraph).mockResolvedValue([{ node: summaries[0] }])

    const input = wrapper.get('[data-dispatch-input]')
    await input.trigger('focus')
    await input.setValue('work Extract')
    await new Promise(resolve => setTimeout(resolve, 180))
    await flushPromises()

    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(graphContext).toHaveBeenCalledWith({
      focusId: 'issue-1',
      scopeIds: ['private:local', 'project:alpha', 'team:main'],
      maxNodes: 16,
    })
    expect(wrapper.get('[data-dispatch-pack]').text()).toContain('Issue context.')

    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(wrapper.emitted('startWork')[0][0]).toEqual(expect.objectContaining({
      nodeId: 'issue-1',
      nodeKind: 'issue',
      graphRevision: 7,
      prompt: expect.stringContaining('<graph-context>'),
    }))
    expect(wrapper.emitted('startWork')[0][0].prompt).toContain('untrusted business data')
    expect(wrapper.emitted('startWork')[0][0].prompt).toContain('Objective:')
    wrapper.unmount()
  })

  it('commits a Focus draft before refreshing or changing physical scope', async () => {
    const wrapper = render()
    await flushPromises()
    await wrapper.get('[data-board-card="issue-1"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-inspector-focus]').trigger('click')
    await wrapper.get('[data-inspector-title]').setValue('Evidence extraction — reviewed')
    vi.mocked(queryGraph).mockClear()

    await wrapper.get('[data-graph-refresh]').trigger('click')
    await flushPromises()

    expect(updateGraphNode).toHaveBeenCalledWith(expect.objectContaining({
      id: 'issue-1',
      title: 'Evidence extraction — reviewed',
    }))
    expect(queryGraph).toHaveBeenCalled()
    expect(updateGraphNode.mock.invocationCallOrder.at(-1))
      .toBeLessThan(queryGraph.mock.invocationCallOrder[0])

    await wrapper.get('[data-inspector-title]').setValue('Evidence extraction — scoped')
    vi.mocked(queryGraph).mockClear()
    await wrapper.get('[data-graph-scope-trigger]').trigger('click')
    await wrapper.get('[data-scope-option="private:local"]').trigger('click')
    await flushPromises()

    expect(updateGraphNode).toHaveBeenLastCalledWith(expect.objectContaining({
      id: 'issue-1',
      title: 'Evidence extraction — scoped',
    }))
    expect(queryGraph).toHaveBeenCalled()
    expect(updateGraphNode.mock.invocationCallOrder.at(-1))
      .toBeLessThan(queryGraph.mock.invocationCallOrder[0])
    wrapper.unmount()
  })

  it('uses a recoverable in-product confirmation before deletion', async () => {
    const wrapper = render()
    await flushPromises()
    await wrapper.get('[data-board-card="issue-1"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-graph-control="peek-more"]').trigger('click')
    await wrapper.get('[data-inspector-delete]').trigger('click')
    await flushPromises()

    const dialog = document.querySelector('[data-graph-confirm-dialog]')
    expect(dialog).not.toBeNull()
    expect(dialog.textContent).toContain('Move “Extract evidence” to Trash?')
    expect(deleteGraphNode).not.toHaveBeenCalled()
    dialog.querySelector('[data-graph-control="confirm-submit"]').click()
    await flushPromises()

    expect(deleteGraphNode).toHaveBeenCalledWith({
      id: 'issue-1',
      expectedRevision: 'issue-rev',
    })
    expect(document.querySelector('[data-graph-confirm-dialog]')).toBeNull()
    expect(wrapper.get('[data-graph-undo]').text()).toContain('Extract evidence')
    wrapper.unmount()
  })

  it('moves from project dashboard context to a correctly related decision', async () => {
    const wrapper = render()
    await flushPromises()
    await wrapper.get('[data-graph-section="projects"]').trigger('click')
    await wrapper.get('[data-project-card="project-alpha"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-inspector-focus]').trigger('click')
    await wrapper.get('[data-graph-control="focus-more"]').trigger('click')
    await wrapper.get('[data-inspector-record-decision]').trigger('click')
    await flushPromises()

    const dialog = document.querySelector('[data-graph-create-dialog]')
    expect(dialog.querySelector('[data-create-kind]').textContent).toContain('Decision')
    const title = dialog.querySelector('[data-create-title]')
    title.value = 'Use the matched cohort'
    title.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    dialog.querySelector('[data-create-submit]').click()
    await flushPromises()

    expect(createGraphNode).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'decision',
      title: 'Use the matched cohort',
      relations: [{
        relation: 'part_of',
        target: 'project-alpha',
        legacy: false,
      }],
    }))
    wrapper.unmount()
  })

  it('routes dispatched lines to a background agent Activity with graph context', async () => {
    const wrapper = render()
    await flushPromises()
    const input = wrapper.get('[data-dispatch-input]')
    await input.trigger('focus')
    await input.setValue('file the payer objection from the call')
    await new Promise(resolve => setTimeout(resolve, 180))
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(graphContext).toHaveBeenCalledWith(expect.objectContaining({
      scopeIds: ['private:local', 'project:alpha', 'team:main'],
      maxNodes: 12,
    }))
    const request = wrapper.emitted('startWork')[0][0]
    expect(request.background).toBe(true)
    expect(request.prompt).toContain('file the payer objection from the call')
    expect(request.prompt).toContain('untrusted business data')
    wrapper.unmount()
  })

  it('does not pump queued dispatch work after the app unmounts', async () => {
    vi.useFakeTimers()
    try {
      const wrapper = render()
      await flushPromises()
      const dispatch = wrapper.findComponent(DispatchBar)

      dispatch.vm.$emit('dispatch', 'first capture')
      dispatch.vm.$emit('dispatch', 'second capture')
      await flushPromises()
      expect(graphContext).toHaveBeenCalledTimes(1)
      expect(wrapper.emitted('startWork')).toHaveLength(1)

      wrapper.unmount()
      await vi.advanceTimersByTimeAsync(1_600)
      await flushPromises()

      expect(graphContext).toHaveBeenCalledTimes(1)
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })
})
