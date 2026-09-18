import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'
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
  lookupGraph: vi.fn(),
  graphLinkTargets: vi.fn(),
  graphReferences: vi.fn(),
  listenForGraphChanges: vi.fn(),
  openBusinessGraph: vi.fn(),
  queryGraph: vi.fn(),
  restoreGraphNode: vi.fn(),
  refreshBusinessGraph: vi.fn(),
  searchGraph: vi.fn(),
  updateGraphNode: vi.fn(),
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
  refreshBusinessGraph,
  updateGraphNode,
} from '../../services/businessGraph.js'
import { useBusinessGraphStore } from '../../stores/businessGraph.js'
import { useLaunchersStore } from '../../stores/launchers.js'
import { useSettingsStore } from '../../stores/settings.js'
import BusinessGraphApp from './BusinessGraphApp.vue'
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
  })

  afterEach(async () => {
    useBusinessGraphStore(pinia).stop()
    await useSettingsStore(pinia).flush()
    localStorage.removeItem('mimir:editor:settings:v1')
  })

  function render({ start = true } = {}) {
    if (start) void useBusinessGraphStore(pinia).start('/alpha')
    return mount(BusinessGraphApp, {
      attachTo: document.body,
      props: {
        workspacePath: '/alpha',
        active: true,
      },
      global: { plugins: [pinia] },
    })
  }

  it('routes cards to Editor documents while keeping the board in place', async () => {
    const wrapper = render()
    await flushPromises()
    expect(wrapper.findAll('[data-board-column]')).toHaveLength(6)
    expect(wrapper.findAll('[data-graph-section]').map(tab => tab.text())).toEqual(['Home', 'Work', 'Graph'])
    await wrapper.get('[data-board-card="issue-1"]').trigger('click')
    expect(wrapper.emitted('openGraphNode')).toEqual([[{ id: 'issue-1' }]])
    expect(wrapper.find('[data-graph-inspector]').exists()).toBe(false)
    expect(wrapper.findAll('[data-board-column]')).toHaveLength(6)
    expect(getGraphNode).not.toHaveBeenCalled()
    await wrapper.get('[data-graph-section="all"]').trigger('click')
    await wrapper.get('[data-graph-node="project-alpha"]').trigger('click')
    expect(wrapper.emitted('openGraphNode').at(-1)).toEqual([{ id: 'project-alpha' }])
    expect(wrapper.find('[data-graph-node="project-alpha"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('navigates directly between Work, Graph, and Changes without a second Graph toolbar', async () => {
    const wrapper = render()
    await flushPromises()
    const nav = wrapper.get('[data-graph-topbar] nav')
    expect(nav.findAll('button').map(button => button.text())).toEqual(['Home', 'Work', 'Graph', 'Changes'])
    await wrapper.get('[data-graph-control="graph-changes"]').trigger('click')
    expect(wrapper.find('[data-graph-now]').exists()).toBe(true)
    expect(nav.findAll('[aria-current="page"]').map(button => button.text())).toEqual(['Changes'])
    expect(wrapper.find('[data-graph-viewbar]').exists()).toBe(false)
    await wrapper.get('[data-graph-section="all"]').trigger('click')
    expect(wrapper.findAll('[data-graph-view]')).toHaveLength(0)
    expect(wrapper.find('[data-graph-entries]').exists()).toBe(true)
    expect(nav.findAll('[aria-current="page"]').map(button => button.text())).toEqual(['Graph'])
    expect(wrapper.find('.graph-entries-tools').exists()).toBe(false)
    await wrapper.get('[data-graph-control="graph-changes"]').trigger('click')
    expect(wrapper.find('[data-graph-now]').exists()).toBe(true)
    await wrapper.get('[data-graph-section="all"]').trigger('click')
    expect(wrapper.find('[data-graph-entries]').exists()).toBe(true)
    await wrapper.get('[data-graph-section="work"]').trigger('click')
    expect(wrapper.findAll('[data-graph-view]').map(tab => tab.text())).toEqual(['Board', 'List'])
    wrapper.unmount()
  })

  it('puts the current workspace first in the Project filter and keeps row navigation consistent', async () => {
    const wrapper = render()
    await flushPromises()
    const graph = useBusinessGraphStore(pinia)
    graph.setWorkspaceConfiguration({ project: 'project-alpha' })
    await wrapper.get('[data-graph-section="all"]').trigger('click')
    await wrapper.get('[data-graph-control="graph-filter-project"]').trigger('click')
    expect(new DOMWrapper(document.body).get('[data-graph-column-filter]').text()).toContain('Current workspace')
    await new DOMWrapper(document.body).get('[data-graph-control="graph-filter-option-project-project-alpha"]').trigger('click')
    await flushPromises()
    expect(queryGraph).toHaveBeenLastCalledWith(expect.objectContaining({ projectIds: ['project-alpha'] }))
    expect(wrapper.get('[data-graph-control="graph-filter-project"]').attributes('title')).toContain('Project Alpha')
    await wrapper.get('[data-entry-row="issue-1"] .graph-entry-project').trigger('click')
    expect(wrapper.emitted('openGraphNode').at(-1)).toEqual([{ id: 'issue-1' }])
    await wrapper.get('[data-entry-row="project-alpha"] .graph-entry-kind').trigger('click')
    expect(wrapper.emitted('openGraphNode').at(-1)).toEqual([{ id: 'project-alpha' }])
    wrapper.unmount()
  })

  it('opens the current Project from Work and applies a Project home work request without stale filters', async () => {
    const wrapper = render()
    await flushPromises()
    const graph = useBusinessGraphStore(pinia)
    graph.setWorkspaceConfiguration({ project: 'project-alpha' })
    await flushPromises()
    await wrapper.get('[data-graph-control="work-open-project"]').trigger('click')
    expect(graph.section).toBe('home')
    expect(wrapper.find('[data-graph-home]').exists()).toBe(true)
    expect(wrapper.emitted('openGraphNode')).toBeUndefined()
    expect(graph.workProjectId).toBe('')
    await wrapper.get('[data-graph-section="all"]').trigger('click')
    await wrapper.get('[data-graph-search]').setValue('absent')
    graph.requestedProjectWork = { id: 'project-alpha', title: 'Project Alpha' }
    await flushPromises()
    expect(graph.section).toBe('work')
    expect(graph.searchQuery).toBe('')
    expect(graph.workProjectId).toBe('project-alpha')
    expect(wrapper.get('[data-board-project-filter]').text()).toContain('Project Alpha')
    expect(wrapper.find('[data-board-card="issue-1"]').exists()).toBe(true)
    expect(wrapper.find('[data-board-card="issue-legacy"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('cancels pending search on Changes and retains Work view and Graph filters', async () => {
    const wrapper = render()
    await flushPromises()
    await wrapper.get('[data-graph-view="list"]').trigger('click')
    await wrapper.get('[data-graph-section="all"]').trigger('click')
    const graph = useBusinessGraphStore(pinia)
    graph.graphKinds = ['issue']
    await wrapper.get('[data-graph-search]').setValue('evidence')
    await wrapper.get('[data-graph-control="graph-changes"]').trigger('click')
    await new Promise(resolve => setTimeout(resolve, 120))
    await flushPromises()
    expect(searchGraph).not.toHaveBeenCalled()
    expect(wrapper.get('[data-graph-search]').element.value).toBe('')
    expect(wrapper.find('[data-graph-now]').exists()).toBe(true)
    await wrapper.get('[data-graph-section="work"]').trigger('click')
    expect(wrapper.get('[data-graph-view="list"]').attributes('aria-pressed')).toBe('true')
    await wrapper.get('[data-graph-section="all"]').trigger('click')
    expect(wrapper.find('[data-graph-entries]').exists()).toBe(true)
    expect(wrapper.get('[data-graph-control="graph-filter-kind"]').attributes('title')).toBe('Kind: Task')
    expect(graph.graphKinds).toEqual(['issue'])
    wrapper.unmount()
  })

  it.each(['projects', 'knowledge', 'all'])('opens saved %s state without a kind filter', async section => {
    const settings = useSettingsStore()
    await settings.load()
    settings.set('businessGraphViewState', {
      section,
      sectionViews: { projects: 'portfolio' },
      graph: { kind: 'knowledge' },
      work: {},
    })

    const wrapper = render()
    await flushPromises()

    expect(wrapper.get('[data-graph-section="all"]').attributes('aria-current')).toBe('page')
    expect(wrapper.find('[data-graph-entries]').exists()).toBe(true)
    expect(useBusinessGraphStore(pinia).graphKinds).toEqual([])
    expect(wrapper.findAll('[data-graph-node]').map(row => row.attributes('data-graph-node')))
      .toEqual(expect.arrayContaining(['issue-1', 'issue-legacy', 'project-alpha']))
    wrapper.unmount()
  })

  it('keeps active Graph filters visible when returning from Work', async () => {
    const wrapper = render()
    await flushPromises()
    await wrapper.get('[data-graph-section="all"]').trigger('click')
    await wrapper.get('[data-graph-control="graph-filter-kind"]').trigger('click')
    await new DOMWrapper(document.body).get('[data-graph-control="graph-filter-option-kind-issue"]').trigger('click')
    await wrapper.get('[data-graph-section="work"]').trigger('click')
    await wrapper.get('[data-graph-section="all"]').trigger('click')
    expect(wrapper.get('[data-graph-control="graph-filter-kind"]').attributes('title')).toContain('Task')
    await wrapper.get('[data-graph-control="graph-filter-clear-kind"]').trigger('click')
    expect(useBusinessGraphStore(pinia).graphKinds).toEqual([])
    wrapper.unmount()
  })

  it('uses No project for orphan tasks in the Board, List, and saved Project filter', async () => {
    summaries.push(
      { id: 'issue-unassigned', kind: 'issue', title: 'No assignment', status: 'plan', scopeId: 'team:main' },
      { id: 'issue-orphan', kind: 'issue', title: 'Deleted project task', projectId: 'deleted-project', status: 'plan', scopeId: 'team:main' },
    )
    const settings = useSettingsStore()
    await settings.load()
    settings.set('businessGraphViewState', {
      section: 'work', sectionViews: { work: 'board' },
      work: { project: 'fde', groupBy: 'project' },
    })
    const wrapper = render()
    await flushPromises()
    const expectedIds = ['issue-legacy', 'issue-unassigned', 'issue-orphan'].sort()
    expect(wrapper.get('[data-board-project-filter]').text()).toContain('No project')
    expect(wrapper.get('[data-board-column="__unassigned__"] .board-column-count').text()).toBe('3')
    expect(wrapper.findAll('[data-board-card]').map(card => card.attributes('data-board-card')).sort()).toEqual(expectedIds)
    await wrapper.get('[data-graph-view="list"]').trigger('click')
    expect(wrapper.findAll('[data-graph-node]').map(row => row.attributes('data-graph-node')).sort()).toEqual(expectedIds)
    expect(wrapper.text()).not.toContain('deleted-project')
    expect(settings.businessGraphViewState.work.project).toBe('__unassigned__')
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
    await wrapper.get('[data-graph-control="work-show-empty-projects"]').trigger('click')
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
    await wrapper.get('[data-graph-control="work-show-closed"]').trigger('click')
    await flushPromises()

    expect(settings.businessGraphViewState.work).toEqual({
      project: 'project-alpha',
      groupBy: 'status',
      sortBy: 'updated',
      priority: 'high',
      assignee: '',
      collapsedStatuses: ['backlog'],
      showClosedIssues: true,
      showEmptyProjects: true,
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
    expect(restored.get('[data-graph-control="work-show-closed"]').attributes('aria-checked')).toBe('true')
    expect(restored.findComponent({ name: 'WorkBoard' }).props('showEmptyProjects')).toBe(true)
    expect(restored.get('[data-board-priority-filter]').text()).toContain('High')
    expect(restored.get('[data-board-column="backlog"]')
      .attributes('data-board-column-collapsed')).toBe('true')
    restored.unmount()
  })

  it('filters work by owner and marks the configured person as you', async () => {
    summaries.push(
      { id: 'person-anna', kind: 'person', title: 'Anna Berg', teamMember: true, status: 'active', scopeId: 'team:main', sourceRevision: 'anna-rev' },
      { id: 'person-paul', kind: 'person', title: 'Paul Priorb', teamMember: true, status: 'active', scopeId: 'team:main', sourceRevision: 'paul-rev' },
      { id: 'person-old', kind: 'person', title: 'Former Member', teamMember: true, status: 'former', scopeId: 'team:main', sourceRevision: 'old-rev' },
    )
    summaries[0].assigneeId = 'person-anna'
    summaries[2].assigneeId = 'person-paul'
    const settings = useSettingsStore()
    await settings.load()
    settings.set('businessGraphSelfPersonId', 'person-paul')
    const wrapper = render()
    await flushPromises()

    expect(wrapper.get('[data-board-card="issue-1"] .board-row-owner').text()).toBe('AB')
    expect(wrapper.get('[data-board-card="issue-legacy"] .board-row-owner').text()).toBe('you')
    expect(wrapper.get('[data-board-card="issue-legacy"]').attributes('aria-label'))
      .toContain('assigned to you')
    expect(wrapper.text()).not.toContain('set date')

    const ownerReset = wrapper.get('[data-graph-control="board-assignee-filter-clear"]')
    expect(ownerReset.attributes('disabled')).toBeDefined()
    expect(ownerReset.attributes('aria-label')).toBe('Work for anyone is shown')
    await wrapper.get('[data-board-assignee-filter]').trigger('click')
    await flushPromises()
    const options = [...document.querySelectorAll('[data-graph-select-option]')]
    expect(options.map(option => option.dataset.graphSelectOption))
      .toEqual(['', 'person-paul', 'person-anna', '__unassigned__'])
    expect(options[1].textContent).toContain('You')
    options[1].click()
    await flushPromises()

    expect(wrapper.findAll('[data-board-card]').map(card => card.attributes('data-board-card')))
      .toEqual(['issue-legacy'])
    expect(wrapper.get('[data-board-assignee-filter]').text()).toContain('You')
    expect(wrapper.get('[data-board-assignee-filter]').classes()).toContain('graph-project-view-active')
    expect(wrapper.get('[data-board-assignee-filter]').attributes('aria-label')).toBe('Owner view: You')
    expect(ownerReset.attributes('aria-label')).toBe('Show work for anyone')
    expect(settings.businessGraphViewState.work.assignee).toBe('person-paul')

    await ownerReset.trigger('click')
    expect(wrapper.findAll('[data-board-card]')).toHaveLength(2)
    expect(settings.businessGraphViewState.work.assignee).toBe('')
    await wrapper.get('[data-board-assignee-filter]').trigger('click')
    document.querySelector('[data-graph-select-option="__unassigned__"]').click()
    await flushPromises()
    expect(wrapper.findAll('[data-board-card]')).toHaveLength(0)
    expect(wrapper.text()).toContain('No work matches this view')
    wrapper.unmount()
  })

  it('groups the Work list by the board grouping', async () => {
    summaries[0].dueDate = '2020-01-01'
    summaries[2].waitingFor = 'Anna'
    const wrapper = render()
    await flushPromises()

    expect(wrapper.find('[data-graph-view="attention"]').exists()).toBe(false)
    await wrapper.get('[data-graph-view="list"]').trigger('click')
    const groups = () => wrapper.findAll('[data-graph-group]').map(group => group.attributes('data-graph-group'))
    expect(groups()).toEqual(['plan', 'review'])
    expect(wrapper.findAll('[data-graph-node]').map(row => row.attributes('data-graph-node')))
      .toEqual(['issue-1', 'issue-legacy'])
    expect(wrapper.find('.entity-kind').exists()).toBe(false)
    expect(wrapper.get('[data-graph-node="issue-1"] .work-project').text()).toBe('Project Alpha')
    expect(wrapper.get('[data-graph-node="issue-1"] .work-due').text()).toMatch(/^\d+d overdue$/)
    expect(wrapper.get('[data-graph-node="issue-legacy"] .work-waiting').text()).toBe('waiting for Anna')

    await wrapper.get('[data-board-group]').trigger('click')
    document.querySelector('[data-graph-select-option="project"]').click()
    await flushPromises()
    expect(groups()).toEqual(['project-alpha', '__unassigned__'])

    wrapper.unmount()
  })

  it('keeps the Project filter across Work views and primary navigation', async () => {
    const wrapper = render()
    await flushPromises()

    await wrapper.get('[data-board-project-filter]').trigger('click')
    document.querySelector('[data-graph-select-option="project-alpha"]').click()
    await wrapper.get('[data-graph-view="list"]').trigger('click')
    expect(wrapper.findAll('[data-graph-node]').map(row => row.attributes('data-graph-node')))
      .toEqual(['issue-1'])

    await wrapper.get('[data-graph-section="all"]').trigger('click')
    await wrapper.get('[data-graph-section="work"]').trigger('click')

    expect(wrapper.get('[data-board-project-filter]').text()).toContain('Project Alpha')
    expect(wrapper.get('[data-board-project-filter]').classes()).toContain('graph-project-view-active')
    expect(wrapper.findAll('[data-graph-node]').map(row => row.attributes('data-graph-node')))
      .toEqual(['issue-1'])
    wrapper.unmount()
  })

  it('restores the retired meeting inbox as the Graph list', async () => {
    const settings = useSettingsStore()
    settings.settingsReady = true
    settings.businessGraphViewState = { section: 'all', sectionViews: { all: 'meetings' } }
    const wrapper = render()
    await flushPromises()
    expect(useBusinessGraphStore().view).toBe('list')
    expect(wrapper.find('[data-graph-view="meetings"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('opens a record requested by Scribe after the Graph mounts', async () => {
    const graph = useBusinessGraphStore()
    graph.requestedNodeId = 'issue-1'
    let finishMount
    vi.mocked(openBusinessGraph).mockImplementationOnce(() => new Promise(resolve => { finishMount = resolve }))
    const wrapper = render()
    await flushPromises()
    expect(getGraphNode).not.toHaveBeenCalled()
    expect(graph.requestedNodeId).toBe('issue-1')
    finishMount({ scopes: scopeRows })
    await flushPromises()
    expect(wrapper.emitted('openGraphNode')).toEqual([[{ id: 'issue-1' }]])
    expect(getGraphNode).not.toHaveBeenCalled()
    expect(graph.requestedNodeId).toBe('')
    wrapper.unmount()
  })

  it('uses the shared graph mount without restarting or stopping it', async () => {
    const graph = useBusinessGraphStore()
    await graph.start('/alpha')
    const stop = vi.spyOn(graph, 'stop')
    const wrapper = render({ start: false })
    await flushPromises()
    expect(openBusinessGraph).toHaveBeenCalledOnce()
    wrapper.unmount()
    expect(stop).not.toHaveBeenCalled()
    expect(graph.nodes).toHaveLength(3)
  })

  it('allows shared graph hydration to finish after the projection unmounts', async () => {
    let resolveMount
    const unlisten = vi.fn()
    vi.mocked(openBusinessGraph).mockImplementationOnce(() => new Promise(resolve => { resolveMount = resolve }))
    vi.mocked(listenForGraphChanges).mockResolvedValueOnce(unlisten)
    const wrapper = render()
    wrapper.unmount()
    resolveMount({ scopes: scopeRows, nodeCount: 3, diagnosticCount: 0, graphRevision: 7 })
    await flushPromises()
    expect(unlisten).not.toHaveBeenCalled()
    expect(useBusinessGraphStore().nodes).toHaveLength(3)
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
      scopeId: 'team:main',
      title: 'Draft evidence map',
    }))
    expect(wrapper.emitted('openGraphNode')).toEqual([[{ id: 'issue-1' }]])
    wrapper.unmount()
  })

  it('keeps projection keyboard shortcuts separate from Editor navigation', async () => {
    const wrapper = render()
    await flushPromises()
    await wrapper.get('[data-business-graph-app]').trigger('keydown', { key: 'f', metaKey: true })
    expect(document.activeElement).toBe(wrapper.get('[data-graph-search]').element)
    await wrapper.get('[data-business-graph-app]').trigger('keydown', { key: '/' })
    expect(document.activeElement).toBe(wrapper.get('[data-graph-search]').element)
    await wrapper.get('[data-board-card="issue-1"]').trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('openGraphNode')).toEqual([[{ id: 'issue-1' }]])
    await wrapper.get('[data-business-graph-app]').trigger('keydown', { key: 'f' })
    await wrapper.get('[data-business-graph-app]').trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('[data-graph-inspector]').exists()).toBe(false)
    expect(wrapper.emitted('openGraphNode')).toHaveLength(1)
    wrapper.unmount()
  })

  it('restores projection entry focus to the last opened card', async () => {
    const wrapper = render()
    await flushPromises()
    const card = wrapper.get('[data-board-card="issue-legacy"]')
    await card.trigger('keydown', { key: 'Enter' })
    const outside = document.createElement('button')
    document.body.append(outside)
    outside.focus()
    wrapper.vm.focusEntry()
    expect(document.activeElement).toBe(card.element)
    expect(wrapper.find('[data-graph-inspector]').exists()).toBe(false)
    outside.remove()
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
    const input = wrapper.get('[data-graph-search]').element
    input.focus()
    wrapper.vm.focusEntry()
    await flushPromises()
    expect(document.activeElement).toBe(input)
    wrapper.unmount()
  })

  it('clears projection search without closing an Editor document', async () => {
    const wrapper = render()
    await flushPromises()
    await wrapper.get('[data-board-card="issue-1"]').trigger('click')
    await flushPromises()

    const search = wrapper.get('[data-graph-search]')
    search.element.focus()
    await search.setValue('evidence')
    await search.trigger('keydown', { key: 'Escape' })
    expect(search.element.value).toBe('')
    expect(wrapper.emitted('openGraphNode')).toEqual([[{ id: 'issue-1' }]])

    await search.trigger('keydown', { key: 'Escape' })
    await flushPromises()
    expect(wrapper.find('[data-graph-inspector]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('filters Work immediately in its existing columns and restores cards on clear', async () => {
    const wrapper = render()
    await flushPromises()
    const board = wrapper.get('[data-graph-work-board]').element
    const columns = wrapper.findAll('[data-board-column]').map(item => item.element)
    const input = wrapper.get('[data-graph-search]')
    expect(input.attributes('placeholder')).toBe('Filter work…')

    await input.setValue('ALPHA heor')
    expect(searchGraph).not.toHaveBeenCalled()
    expect(wrapper.get('[data-graph-work-board]').element).toBe(board)
    expect(wrapper.findAll('[data-board-column]').map(item => item.element)).toEqual(columns)
    expect(wrapper.findAll('[data-board-card]').map(item => item.attributes('data-board-card'))).toEqual(['issue-1'])
    expect(wrapper.get('[data-board-column="plan"] .board-column-count').text()).toBe('1')
    await input.trigger('keydown', { key: 'ArrowDown' })
    await flushPromises()
    expect(document.activeElement).toBe(wrapper.get('[data-board-card="issue-1"]').element)

    await input.setValue('no matching work')
    expect(wrapper.findAll('[data-board-card]')).toHaveLength(0)
    expect(wrapper.findAll('[data-board-column]').map(item => item.element)).toEqual(columns)
    expect(wrapper.get('.graph-search-count').text()).toBe('0')
    expect(wrapper.findAll('.board-no-matches')).toHaveLength(columns.length)
    await input.trigger('keydown', { key: 'Escape' })
    expect(wrapper.findAll('[data-board-card]')).toHaveLength(2)
    expect(document.activeElement).toBe(input.element)
    wrapper.unmount()
  })

  it('shares closed issue visibility across grouping, Board, List, and search without filtering Graph', async () => {
    summaries.push(
      { ...summaries[0], id: 'done', title: 'Closed evidence', status: 'done' },
      { ...summaries[0], id: 'cancelled', title: 'Cancelled evidence', status: 'cancelled' },
    )
    const wrapper = render()
    await flushPromises()
    const graph = useBusinessGraphStore()
    expect(wrapper.findAll('[data-board-card]')).toHaveLength(2)
    expect(wrapper.get('[data-board-column="done"]').findAll('[data-board-card]')).toHaveLength(0)
    expect(wrapper.find('[data-board-column="cancelled"]').exists()).toBe(false)

    await wrapper.get('[data-graph-display-trigger]').trigger('click')
    await wrapper.get('[data-board-group]').trigger('click')
    document.querySelector('[data-graph-select-option="project"]').click()
    await flushPromises()
    expect(wrapper.findAll('[data-board-card]')).toHaveLength(2)
    await wrapper.get('[data-graph-search]').setValue('evidence')
    expect(wrapper.findAll('[data-board-card]')).toHaveLength(1)
    await wrapper.get('[data-graph-control="work-show-closed"]').trigger('click')
    expect(wrapper.findAll('[data-board-card]')).toHaveLength(3)
    await wrapper.get('[data-graph-view="list"]').trigger('click')
    expect(wrapper.findAll('[data-graph-node]')).toHaveLength(3)
    await wrapper.get('[data-graph-display-trigger]').trigger('click')
    await wrapper.get('[data-board-group]').trigger('click')
    document.querySelector('[data-graph-select-option="status"]').click()
    await flushPromises()
    expect(wrapper.findComponent({ name: 'EntityList' }).text()).toContain('Cancelled')
    await wrapper.get('[data-graph-view="board"]').trigger('click')
    expect(wrapper.get('[data-board-column="cancelled"] [data-board-card]').attributes('data-board-card')).toBe('cancelled')
    await wrapper.get('[data-graph-display-trigger]').trigger('click')
    await wrapper.get('[data-graph-control="work-show-closed"]').trigger('click')
    expect(wrapper.findAll('[data-board-card]')).toHaveLength(1)
    await wrapper.get('[data-graph-view="list"]').trigger('click')
    expect(wrapper.findAll('[data-graph-node]')).toHaveLength(1)
    graph.clearSearch()
    await wrapper.get('[data-graph-section="all"]').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('[data-graph-node]')).toHaveLength(5)
    wrapper.unmount()
  })

  it('hides an issue dropped in Done and restores it with revision-safe Undo', async () => {
    const wrapper = render()
    await flushPromises()
    const column = wrapper.get('[data-board-column="done"]').element
    document.elementFromPoint = vi.fn(() => column)
    await wrapper.get('[data-board-card="issue-1"]')
      .trigger('pointerdown', { button: 0, clientX: 0, clientY: 0 })
    document.dispatchEvent(Object.assign(new Event('pointermove'), { clientX: 200, clientY: 200 }))
    document.dispatchEvent(new Event('pointerup'))
    await flushPromises()
    expect(wrapper.find('[data-board-card="issue-1"]').exists()).toBe(false)
    expect(wrapper.get('[data-graph-close-undo]').text()).toContain('Closed “Extract evidence”')
    await wrapper.get('[data-graph-control="undo-close-issues"]').trigger('click')
    await flushPromises()
    expect(updateGraphNode).toHaveBeenLastCalledWith(expect.objectContaining({
      id: 'issue-1', expectedRevision: 'next-rev', setProperties: { status: 'plan' }, removeProperties: ['rank'],
    }))
    expect(wrapper.get('[data-board-column="plan"] [data-board-card]').attributes('data-board-card')).toBe('issue-1')
    expect(wrapper.find('[data-graph-close-undo]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('places project drops around orphaned cards and preserves orphan references during a reorder', async () => {
    summaries[0].rank = 1000
    summaries[0].assigneeId = 'owner'
    summaries[0].relations = [
      { relation: 'part_of', target: 'project-alpha', legacy: false },
      { relation: 'assigned_to', target: 'owner', legacy: false },
    ]
    summaries[2].rank = 500
    const records = new Map(summaries.map(summary => {
      const node = full(summary.id)
      node.properties.rank = summary.rank
      if (summary.relations) node.relations = summary.relations
      return [node.id, node]
    }))
    let revision = 0
    vi.mocked(updateGraphNode).mockImplementation(async patch => {
      const current = records.get(patch.id)
      expect(patch.expectedRevision).toBe(current.provenance.sourceRevision)
      const properties = { ...current.properties, ...patch.setProperties }
      for (const key of patch.removeProperties || []) delete properties[key]
      const updated = {
        ...current, properties, relations: patch.relations ?? current.relations,
        provenance: { ...current.provenance, sourceRevision: `drag-revision-${++revision}` },
      }
      records.set(patch.id, updated)
      return updated
    })
    const wrapper = render()
    await flushPromises()
    try {
      await wrapper.get('[data-graph-display-trigger]').trigger('click')
      await wrapper.get('[data-board-group]').trigger('click')
      document.querySelector('[data-graph-select-option="project"]').click()
      await flushPromises()
      await wrapper.get('[data-board-sort]').trigger('click')
      document.querySelector('[data-graph-select-option="rank"]').click()
      await flushPromises()
      const noProject = wrapper.get('[data-board-column="__unassigned__"]')
      const order = () => noProject.findAll('[data-board-card]').map(card => card.attributes('data-board-card'))
      async function dropBefore(movedId, beforeId) {
        const before = wrapper.get(`[data-board-card="${beforeId}"]`).element
        before.getBoundingClientRect = () => ({ top: 100, height: 84 })
        document.elementFromPoint = vi.fn(() => before)
        await wrapper.get(`[data-board-card="${movedId}"]`).trigger('pointerdown', { button: 0, clientX: 0, clientY: 0 })
        document.dispatchEvent(Object.assign(new Event('pointermove'), { clientX: 200, clientY: 110 }))
        document.dispatchEvent(new Event('pointerup'))
        await flushPromises()
      }

      await dropBefore('issue-1', 'issue-legacy')
      expect(order()).toEqual(['issue-1', 'issue-legacy'])
      expect(wrapper.find('[data-board-column="project-alpha"]').exists()).toBe(false)
      expect(records.get('issue-1').properties.legacyProject).toBeUndefined()
      expect(records.get('issue-1').properties.status).toBe('plan')
      expect(records.get('issue-1').relations).toEqual([{ relation: 'assigned_to', target: 'owner', legacy: false }])

      vi.mocked(updateGraphNode).mockClear()
      await dropBefore('issue-legacy', 'issue-1')
      expect(order()).toEqual(['issue-legacy', 'issue-1'])
      expect(records.get('issue-legacy').properties.legacyProject).toBe('fde')
      for (const [patch] of updateGraphNode.mock.calls) {
        expect(Object.keys(patch).sort()).toEqual(['expectedRevision', 'id', 'setProperties'])
        expect(Object.keys(patch.setProperties)).toEqual(['rank'])
      }
    } finally {
      wrapper.unmount()
    }
  })

  it('hides empty project columns after task filters while keeping search columns and project choices stable', async () => {
    summaries.push({ id: 'idle', kind: 'project', title: 'Idle project', scopeId: 'team:main' })
    const wrapper = render()
    await flushPromises()
    await wrapper.get('[data-graph-display-trigger]').trigger('click')
    await wrapper.get('[data-board-group]').trigger('click')
    document.querySelector('[data-graph-select-option="project"]').click()
    await flushPromises()
    const columns = () => wrapper.findAll('[data-board-column]').map(el => el.attributes('data-board-column'))
    expect(columns()).toEqual(['project-alpha', '__unassigned__'])
    const originalColumns = wrapper.findAll('[data-board-column]').map(el => el.element)
    await wrapper.get('[data-graph-search]').setValue('absent')
    expect(wrapper.findAll('[data-board-card]')).toHaveLength(0)
    expect(wrapper.findAll('[data-board-column]').map(el => el.element)).toEqual(originalColumns)
    await wrapper.get('[data-graph-search]').setValue('')
    await wrapper.get('[data-graph-filters-trigger]').trigger('click')
    await wrapper.get('[data-board-priority-filter]').trigger('click')
    document.querySelector('[data-graph-select-option="high"]').click()
    await flushPromises()
    expect(columns()).toEqual(['project-alpha'])
    await wrapper.get('[data-board-project-filter]').trigger('click')
    expect(document.querySelector('[data-graph-select-option="idle"]')).not.toBeNull()
    document.querySelector('[data-graph-select-option=""]').click()
    await flushPromises()
    await wrapper.get('[data-graph-display-trigger]').trigger('click')
    await wrapper.get('[data-graph-control="work-show-empty-projects"]').trigger('click')
    expect(columns()).toEqual(['project-alpha', 'idle'])
    await wrapper.get('[data-graph-control="work-show-empty-projects"]').trigger('click')
    expect(columns()).toEqual(['project-alpha'])
    wrapper.unmount()
  })

  it('combines Work search with filters and keeps grouping in List', async () => {
    const wrapper = render()
    await flushPromises()
    await wrapper.get('[data-graph-filters-trigger]').trigger('click')
    await wrapper.get('[data-board-priority-filter]').trigger('click')
    document.querySelector('[data-graph-select-option="high"]').click()
    await flushPromises()
    const input = wrapper.get('[data-graph-search]')
    await input.setValue('anna')
    expect(wrapper.findAll('[data-board-card]')).toHaveLength(0)
    await input.setValue('evidence')
    expect(wrapper.findAll('[data-board-card]')).toHaveLength(1)
    await wrapper.get('[data-graph-view="list"]').trigger('click')
    expect(wrapper.find('[data-graph-work-board]').exists()).toBe(false)
    expect(wrapper.findAll('[data-graph-node]')).toHaveLength(1)
    expect(wrapper.findComponent({ name: 'EntityList' }).props('groupBy')).toBe('status')
    await wrapper.get('[data-graph-view="board"]').trigger('click')
    expect(wrapper.findAll('[data-board-card]')).toHaveLength(1)
    wrapper.unmount()
  })

  it('filters the active projection through a persistent debounced search', async () => {
    const wrapper = render()
    await flushPromises()
    await wrapper.get('[data-graph-section="all"]').trigger('click')
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
      order: { sortBy: 'relevance', direction: 'desc' },
    })
    expect(wrapper.find('[data-graph-filter-banner]').exists()).toBe(false)
    expect(wrapper.get('.graph-search-count').text()).toBe('1')

    await wrapper.get('[data-graph-control="clear-search"]').trigger('click')
    expect(input.element.value).toBe('')
    expect(wrapper.find('[data-graph-control="clear-search"]').exists()).toBe(false)
    expect(document.activeElement).toBe(input.element)
    wrapper.unmount()
  })

  it('keeps the query when clearing column filters and restores browse sort after search', async () => {
    const wrapper = render()
    await flushPromises()
    await wrapper.get('[data-graph-section="all"]').trigger('click')
    await wrapper.get('[data-graph-control="graph-sort-created"]').trigger('click')
    await wrapper.get('[data-graph-search]').setValue('evidence')
    await new Promise(resolve => setTimeout(resolve, 130))
    await flushPromises()
    expect(wrapper.get('[data-graph-control="graph-best-match"]').attributes('aria-pressed')).toBe('true')
    await wrapper.get('[data-graph-control="graph-filter-kind"]').trigger('click')
    await new DOMWrapper(document.body).get('[data-graph-control="graph-filter-option-kind-project"]').trigger('click')
    expect(useBusinessGraphStore(pinia).graphKinds).toEqual(['project'])
    await wrapper.get('[data-graph-control="graph-clear-filters"]').trigger('click')
    expect(wrapper.get('[data-graph-search]').element.value).toBe('evidence')
    await wrapper.get('[data-graph-control="graph-sort-title"]').trigger('click')
    expect(useBusinessGraphStore(pinia).graphSearchOrder.sortBy).toBe('title')
    await wrapper.get('[data-graph-control="graph-best-match"]').trigger('click')
    expect(useBusinessGraphStore(pinia).graphSearchOrder.sortBy).toBe('relevance')
    await wrapper.get('[data-graph-control="clear-search"]').trigger('click')
    expect(wrapper.get('th[aria-sort]').text()).toBe('Created')
    wrapper.unmount()
  })

  it('resets work filters beside the controls that own them', async () => {
    const wrapper = render()
    await flushPromises()

    const viewbarGroups = wrapper.get('.graph-viewbar').element.children
    expect([...viewbarGroups].map(group => group.className)).toEqual([
      'graph-views',
      'graph-filters-root',
      'graph-display-root',
    ])
    const filtersTrigger = wrapper.get('[data-graph-filters-trigger]')
    expect(filtersTrigger.attributes('aria-expanded')).toBe('false')
    await filtersTrigger.trigger('click')
    expect(filtersTrigger.attributes('aria-expanded')).toBe('true')
    expect(wrapper.get('[data-graph-filters-popover]').isVisible()).toBe(true)
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
    expect(wrapper.get('[data-graph-filter-chip="project"]').text())
      .toContain('Project: Project Alpha')
    expect(wrapper.findAll('[data-board-card]').map(card => card.attributes('data-board-card')))
      .toEqual(['issue-1'])
    await projectReset.trigger('click')
    expect(wrapper.get('[data-board-project-filter]').text()).toContain('All projects')
    expect(wrapper.get('[data-board-project-filter]').classes()).not.toContain('graph-project-view-active')
    expect(wrapper.findAll('[data-board-card]')).toHaveLength(2)

    await wrapper.get('[data-board-project-filter]').trigger('click')
    expect(document.querySelector('[data-graph-select-option="fde"]')).toBeNull()
    document.querySelector('[data-graph-select-option="__unassigned__"]').click()
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

    await wrapper.get('[data-graph-display-trigger]').trigger('click')
    const columnsReset = wrapper.get('[data-graph-control="board-columns-expand-all"]')
    expect(columnsReset.attributes('disabled')).toBeDefined()
    await wrapper.get('[data-board-columns-trigger]').trigger('click')
    const planColumn = document.querySelector('[data-graph-control="board-column-plan"]')
    planColumn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    planColumn.click()
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
    await wrapper.get('[data-graph-section="all"]').trigger('click')
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
      order: { sortBy: 'relevance', direction: 'desc' },
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
    expect(document.activeElement).toBe(wrapper.get('[data-graph-node="issue-1"]').element)

    search.element.focus()
    await search.trigger('keydown', { key: 'ArrowUp' })
    await flushPromises()
    expect(document.activeElement).toBe(wrapper.get('[data-graph-node="project-alpha"]').element)
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
    await wrapper.get('[data-graph-section="all"]').trigger('click')

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
      order: { sortBy: 'relevance', direction: 'desc' },
    })
    expect(wrapper.find('[data-graph-filter-banner]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('synchronizes external find and clear commands with the search field', async () => {
    vi.mocked(searchGraph).mockResolvedValue([{ node: summaries[0] }])
    const wrapper = render()
    await flushPromises()

    const graph = useBusinessGraphStore(pinia)
    await graph.search('evidence')
    await flushPromises()

    const search = wrapper.get('[data-graph-search]')
    expect(search.element.value).toBe('evidence')
    expect(wrapper.get('.graph-search-count').text()).toBe('1')
    expect(wrapper.find('[data-graph-filter-banner]').exists()).toBe(false)

    await wrapper.get('[data-graph-control="clear-search"]').trigger('click')
    await flushPromises()
    expect(search.element.value).toBe('')
    expect(wrapper.find('[data-graph-control="clear-search"]').exists()).toBe(false)

    await graph.search('evidence')
    await flushPromises()
    expect(search.element.value).toBe('evidence')

    graph.clearSearch()
    await flushPromises()
    expect(search.element.value).toBe('')
    expect(wrapper.find('[data-graph-control="clear-search"]').exists()).toBe(false)

    const callsBeforePendingClear = searchGraph.mock.calls.length
    await search.setValue('bank')
    graph.clearSearch()
    await flushPromises()
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(search.element.value).toBe('')
    expect(searchGraph).toHaveBeenCalledTimes(callsBeforePendingClear)
    wrapper.unmount()
  })

  it('dismisses custom scope, filter, and column menus when the user clicks elsewhere', async () => {
    const wrapper = render()
    await flushPromises()
    const outside = document.createElement('button')
    document.body.append(outside)

    await wrapper.get('[data-graph-scope-trigger]').trigger('click')
    expect(wrapper.find('[data-graph-scope-menu]').exists()).toBe(true)
    outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await flushPromises()
    expect(wrapper.find('[data-graph-scope-menu]').exists()).toBe(false)

    const filtersTrigger = wrapper.get('[data-graph-filters-trigger]')
    await filtersTrigger.trigger('click')
    expect(wrapper.get('[data-graph-filters-popover]').isVisible()).toBe(true)
    outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await flushPromises()
    expect(wrapper.get('[data-graph-filters-popover]').isVisible()).toBe(false)

    await wrapper.get('[data-graph-display-trigger]').trigger('click')
    await wrapper.get('[data-board-columns-trigger]').trigger('click')
    await flushPromises()
    expect(document.querySelector('[data-board-columns-menu]')).not.toBeNull()
    outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await flushPromises()
    expect(document.querySelector('[data-board-columns-menu]')).toBeNull()
    wrapper.unmount()
  })

  it('navigates scope, filter, and column menus with the keyboard and restores their triggers', async () => {
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

    const filtersTrigger = wrapper.get('[data-graph-filters-trigger]')
    filtersTrigger.element.focus()
    await filtersTrigger.trigger('keydown', { key: 'ArrowDown' })
    await flushPromises()
    expect(document.activeElement).toBe(wrapper.get('[data-board-project-filter]').element)

    await wrapper.get('[data-graph-display-trigger]').trigger('keydown', { key: 'ArrowDown' })
    await flushPromises()
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

  it('keeps create and AI preparation errors inside the active surface', async () => {
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

    wrapper.unmount()
  })

  it('uses accessible listboxes for projection filters and creation', async () => {
    const wrapper = render()
    await flushPromises()

    expect(document.querySelector('select, datalist')).toBeNull()
    expect(wrapper.get('[data-board-sort]').attributes('role')).toBe('combobox')

    await wrapper.get('[data-business-graph-app]').trigger('keydown', { key: 'n' })
    const dialog = document.querySelector('[data-graph-create-dialog]')
    expect(dialog.querySelector('[data-create-kind]').getAttribute('role')).toBe('combobox')
    expect(dialog.querySelector('[data-create-scope]').getAttribute('role')).toBe('combobox')
    expect(document.querySelector('select, datalist')).toBeNull()
    wrapper.unmount()
  })

  it('refreshes and changes projection scopes without editing open documents', async () => {
    const wrapper = render()
    await flushPromises()
    await wrapper.get('[data-board-card="issue-1"]').trigger('click')
    vi.mocked(queryGraph).mockClear()
    await wrapper.get('[data-graph-refresh]').trigger('click')
    await flushPromises()
    expect(refreshBusinessGraph).toHaveBeenCalledOnce()
    expect(queryGraph).toHaveBeenCalled()
    vi.mocked(queryGraph).mockClear()
    await wrapper.get('[data-graph-scope-trigger]').trigger('click')
    await wrapper.get('[data-scope-option="private:local"]').trigger('click')
    await flushPromises()
    expect(queryGraph).toHaveBeenCalled()
    expect(updateGraphNode).not.toHaveBeenCalled()
    expect(wrapper.emitted('openGraphNode')).toEqual([[{ id: 'issue-1' }]])
    wrapper.unmount()
  })


})
