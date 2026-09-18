import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

vi.mock('../services/workspaceConfig.js', () => ({ cachedWorkspaceConfig: vi.fn() }))
import { cachedWorkspaceConfig } from '../services/workspaceConfig.js'

vi.mock('../services/businessGraph.js', () => ({
  createGraphNode: vi.fn(),
  deleteGraphNode: vi.fn(),
  getGraphNode: vi.fn(),
  graphDiagnostics: vi.fn(),
  graphEvents: vi.fn(),
  graphNeighbors: vi.fn(),
  listenForGraphChanges: vi.fn(),
  openBusinessGraph: vi.fn(),
  queryGraph: vi.fn(),
  refreshBusinessGraph: vi.fn(),
  restoreGraphNode: vi.fn(),
  searchGraph: vi.fn(),
  updateGraphNode: vi.fn(),
}))

import {
  createGraphNode,
  deleteGraphNode,
  restoreGraphNode,
  getGraphNode,
  graphDiagnostics,
  graphEvents,
  graphNeighbors,
  listenForGraphChanges,
  openBusinessGraph,
  queryGraph,
  refreshBusinessGraph,
  searchGraph,
  updateGraphNode,
} from '../services/businessGraph.js'
import { useBusinessGraphStore } from './businessGraph.js'

const scopes = [
  { id: 'private:local', kind: 'private', root: '/private' },
  { id: 'project:alpha', kind: 'project', root: '/alpha' },
  { id: 'team:main', kind: 'team', root: '/team' },
]
const summaries = [
  {
    id: 'issue-1',
    kind: 'issue',
    title: 'Extract evidence',
    status: 'plan',
    priority: 'high',
    tags: ['heor'],
    scopeId: 'project:alpha',
    sourceRevision: 'rev-1',
  },
  {
    id: 'project-alpha',
    kind: 'project',
    title: 'Project Alpha',
    tags: [],
    scopeId: 'team:main',
    sourceRevision: 'rev-p',
  },
]

describe('business graph store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.resetAllMocks()
    vi.mocked(openBusinessGraph).mockResolvedValue({
      scopes,
      nodeCount: 2,
      diagnosticCount: 0,
      graphRevision: 1,
    })
    vi.mocked(queryGraph).mockResolvedValue({
      items: summaries,
      total: 2,
      graphRevision: 1,
    })
    vi.mocked(graphDiagnostics).mockResolvedValue([])
    vi.mocked(graphEvents).mockResolvedValue({ items: [], total: 0 })
    vi.mocked(listenForGraphChanges).mockResolvedValue(vi.fn())
    vi.mocked(searchGraph).mockResolvedValue([])
    vi.mocked(graphNeighbors).mockResolvedValue([])
    vi.mocked(getGraphNode).mockImplementation(async id => ({
      ...summaries.find(node => node.id === id),
      body: '',
      relations: [],
      properties: id === 'issue-1' ? { status: 'plan', priority: 'high' } : {},
      provenance: {
        scopeId: id === 'issue-1' ? 'project:alpha' : 'team:main',
        sourceRevision: id === 'issue-1' ? 'rev-1' : 'rev-p',
      },
    }))
  })

  afterEach(() => useBusinessGraphStore().stop())

  it('loads all selected Project tasks without reducing the general catalog and keeps them through refresh', async () => {
    const store = useBusinessGraphStore()
    const tasks = Array.from({ length: 501 }, (_, i) => ({ id: `task-${i}`, kind: 'issue', title: `Task ${i}`, projectId: 'project-alpha' }))
    queryGraph.mockImplementation(async query => query.projectIds?.includes('project-alpha') && query.kinds?.includes('issue')
      ? { items: tasks.slice(query.offset, query.offset + query.limit), total: tasks.length, graphRevision: 1 }
      : { items: summaries, total: summaries.length, graphRevision: 1 })
    await store.start('/alpha')
    store.workProjectId = 'project-alpha'
    await vi.waitFor(() => expect(store.workProjectLoading).toBe(false))
    expect(store.visibleNodes).toHaveLength(501)
    expect(store.nodes).toHaveLength(2)
    await store.refresh()
    expect(store.visibleNodes).toHaveLength(501)
    const readyQuery = queryGraph.getMockImplementation()
    queryGraph.mockImplementation(query => query.projectIds?.length ? Promise.reject(new Error('Project query failed')) : readyQuery(query))
    await expect(store.refresh()).rejects.toThrow('Project query failed')
    expect(store.error).toBe('Project query failed')
    expect(store.visibleNodes).toHaveLength(501)
    queryGraph.mockImplementation(readyQuery)
    await store.refresh()
    expect(store.error).toBe('')
    store.workProjectId = ''
    expect(store.visibleNodes.map(node => node.id)).toEqual(['issue-1'])
  })

  it('filters native queries and search without reducing the Work catalog', async () => {
    vi.mocked(cachedWorkspaceConfig).mockReturnValue({ project: 'project-alpha' })
    const store = useBusinessGraphStore()
    await store.start('/alpha')
    store.setSection('all')
    const oldNote = { id: 'old-note', kind: 'note', title: 'Old project note' }
    vi.mocked(queryGraph).mockImplementation(async query => ({
      items: query.projectIds?.length ? [oldNote] : summaries, total: query.projectIds?.length ? 1 : 2,
    }))
    store.graphProjectIds = ['project-alpha']
    store.graphKinds = ['note']
    await vi.waitFor(() => expect(store.visibleNodes).toEqual([oldNote]))
    expect(queryGraph).toHaveBeenLastCalledWith({
      scopeIds: scopes.map(scope => scope.id), projectIds: ['project-alpha'], kinds: ['note'], limit: 500,
      order: { sortBy: 'updated', direction: 'desc' },
    })
    await store.search('evidence')
    expect(searchGraph).toHaveBeenLastCalledWith('evidence', {
      scopeIds: scopes.map(scope => scope.id), projectIds: ['project-alpha'], kinds: ['note'], limit: 100,
      order: { sortBy: 'relevance', direction: 'desc' },
    })
    store.clearSearch()
    store.setSection('work')
    expect(store.visibleNodes).toEqual([summaries[0]])
    store.setSection('all')
    store.setView('changes')
    expect(store.visibleNodes).toEqual(summaries)
    expect(store.graphProjectIds).toEqual(['project-alpha'])
  })

  it('loads a complete project catalog and keeps membership filters independent of the workspace link', async () => {
    const store = useBusinessGraphStore()
    const project = { id: 'old-project', kind: 'project', title: 'Old Project' }
    vi.mocked(queryGraph).mockImplementation(async query => query.kinds?.includes('project')
      ? { items: [project], total: 1, graphRevision: 1 }
      : { items: [summaries[0]], total: 900, graphRevision: 1 })
    vi.mocked(cachedWorkspaceConfig).mockReturnValue({ project: 'old-project' })
    vi.mocked(getGraphNode).mockResolvedValue(project)
    await store.start('/alpha')
    expect(store.workspaceProject.title).toBe('Old Project')
    expect(store.graphProjects).toEqual([project])
    store.graphProjectIds = ['old-project']
    store.setWorkspaceConfiguration({ project: 'project-alpha' })
    await nextTick()
    expect(store.graphProjectIds).toEqual(['old-project'])
  })

  it('rejects old filtered queries and searches after the Project changes', async () => {
    const store = useBusinessGraphStore()
    await store.start('/alpha')
    store.setWorkspaceConfiguration({ project: 'project-alpha' })
    store.setSection('all')
    let finishQuery, finishSearch
    vi.mocked(queryGraph).mockReturnValueOnce(new Promise(resolve => { finishQuery = resolve }))
    store.graphProjectIds = ['project-alpha']
    vi.mocked(searchGraph).mockReturnValueOnce(new Promise(resolve => { finishSearch = resolve }))
    const pendingSearch = store.search('evidence')
    store.graphProjectIds = ['another-project']
    await vi.waitFor(() => expect(store.searching).toBe(false))
    finishQuery({ items: [{ id: 'stale' }] })
    finishSearch([{ node: { id: 'stale' } }])
    await pendingSearch
    store.clearSearch()
    expect(store.visibleNodes).not.toContainEqual({ id: 'stale' })
  })

  it('starts a changed search at Best match without bypassing the input debounce', async () => {
    const store = useBusinessGraphStore()
    await store.start('/alpha')
    store.setSection('all')
    store.graphOrder = { sortBy: 'project', direction: 'asc' }
    await store.search('evidence')
    store.graphSearchOrder = { sortBy: 'created', direction: 'desc' }
    await nextTick()
    vi.mocked(searchGraph).mockClear()
    store.prepareSearch('atlas')
    expect(searchGraph).not.toHaveBeenCalled()
    expect(store.graphSearchOrder).toEqual({ sortBy: 'relevance', direction: 'desc' })
    await store.search('atlas')
    expect(searchGraph).toHaveBeenCalledTimes(1)
    expect(searchGraph).toHaveBeenCalledWith('atlas', expect.objectContaining({ order: { sortBy: 'relevance', direction: 'desc' } }))
    store.clearSearch()
    expect(store.graphOrder).toEqual({ sortBy: 'project', direction: 'asc' })
  })

  it('rejects late search results after selected scopes change', async () => {
    const store = useBusinessGraphStore()
    await store.start('/alpha')
    store.setSection('all')
    let finish
    vi.mocked(searchGraph).mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const oldSearch = store.search('evidence')
    const changingScopes = store.setScopes(['team:main'])
    finish([{ node: { id: 'private-result' } }])
    await oldSearch
    await changingScopes
    expect(store.visibleNodes).toEqual([])
  })

  it('pages the selected Graph order and rejects a late page after the order changes', async () => {
    const store = useBusinessGraphStore()
    await store.start('/alpha')
    const firstPage = Array.from({ length: 500 }, (_, index) => ({ id: `node-${index}`, kind: 'note', title: `Note ${index}` }))
    vi.mocked(queryGraph).mockResolvedValue({ items: firstPage, total: 501, graphRevision: 1 })
    store.setSection('all')
    await vi.waitFor(() => expect(store.visibleNodes).toHaveLength(500))
    expect(store.canLoadMore).toBe(true)
    let finishPage
    vi.mocked(queryGraph).mockReturnValueOnce(new Promise(resolve => { finishPage = resolve }))
    const pending = store.loadMoreGraphEntries()
    expect(queryGraph).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 500, order: { sortBy: 'updated', direction: 'desc' } }))
    vi.mocked(queryGraph).mockResolvedValue({ items: [{ id: 'first-by-title', kind: 'note', title: 'A' }], total: 1 })
    store.graphOrder = { sortBy: 'title', direction: 'asc' }
    await vi.waitFor(() => expect(store.visibleNodes[0]?.id).toBe('first-by-title'))
    finishPage({ items: [{ id: 'stale' }], total: 501 })
    await pending
    expect(store.visibleNodes.map(node => node.id)).toEqual(['first-by-title'])
    expect(store.canLoadMore).toBe(false)
    expect(store.loadingMore).toBe(false)
    expect(store.nodes).toEqual(summaries)
  })

  it('retrieves search matches after the first page and retains them on refresh', async () => {
    const store = useBusinessGraphStore()
    await store.start('/alpha')
    store.setSection('all')
    store.setView('list')
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ node: { id: `match-${index}`, kind: 'note', title: `Note ${index}` } }))
    vi.mocked(searchGraph).mockResolvedValueOnce(firstPage)
    await store.search('note')
    expect(searchGraph).toHaveBeenLastCalledWith('note', expect.objectContaining({ order: { sortBy: 'relevance', direction: 'desc' } }))
    expect(store.canLoadMore).toBe(true)
    vi.mocked(searchGraph).mockResolvedValueOnce([{ node: { id: 'last', kind: 'note', title: 'Last note' } }])
    await store.loadMoreGraphEntries()
    expect(searchGraph).toHaveBeenLastCalledWith('note', expect.objectContaining({ offset: 100 }))
    expect(store.visibleNodes).toHaveLength(101)
    expect(store.canLoadMore).toBe(false)
    expect(store.view).toBe('list')
    vi.mocked(searchGraph).mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce([{ node: { id: 'last', kind: 'note', title: 'Last note' } }])
    await store.refresh({ quiet: true })
    expect(store.visibleNodes).toHaveLength(101)
    expect(store.canLoadMore).toBe(false)
  })

  it('retains loaded Graph pages on refresh and restarts pages if the graph revision changes', async () => {
    const store = useBusinessGraphStore()
    await store.start('/alpha')
    const entries = Array.from({ length: 501 }, (_, index) => ({ id: `entry-${index}`, kind: 'note', title: `Entry ${index}` }))
    let revision = 1
    vi.mocked(queryGraph).mockImplementation(async query => ({
      items: entries.slice(query.offset || 0, (query.offset || 0) + 500), total: entries.length, graphRevision: revision,
    }))
    store.setSection('all')
    await vi.waitFor(() => expect(store.visibleNodes).toHaveLength(500))
    await store.loadMoreGraphEntries()
    expect(store.visibleNodes).toHaveLength(501)
    await store.refresh({ quiet: true })
    expect(store.visibleNodes).toHaveLength(501)
    expect(store.canLoadMore).toBe(false)
    entries.push({ id: 'new-entry', kind: 'note', title: 'New entry' })
    store.graphOrder = { sortBy: 'title', direction: 'asc' }
    await vi.waitFor(() => expect(store.visibleNodes).toHaveLength(500))
    revision = 2
    entries.unshift({ id: 'earlier-entry', kind: 'note', title: 'Earlier entry' })
    await store.loadMoreGraphEntries()
    expect(store.visibleNodes[0].id).toBe('earlier-entry')
    expect(store.visibleNodes).toHaveLength(500)
    await store.loadMoreGraphEntries()
    expect(store.visibleNodes).toHaveLength(503)
    expect(new Set(store.visibleNodes.map(node => node.id)).size).toBe(503)
  })

  it('does not treat a linked non-Project entry as the current Project', async () => {
    const store = useBusinessGraphStore()
    await store.start('/alpha')
    store.setSection('all')
    store.setWorkspaceConfiguration({ project: 'project-alpha' })
    store.graphProjectIds = ['project-alpha']
    store.setWorkspaceConfiguration({ project: 'issue-1' })
    await nextTick()
    expect(store.workspaceProject).toBeNull()
    expect(store.graphProjectIds).toEqual(['project-alpha'])
  })

  it('mounts and composes all physical scopes by default', async () => {
    const store = useBusinessGraphStore()
    await store.start('/alpha')

    expect(openBusinessGraph).toHaveBeenCalledWith('/alpha')
    expect(store.activeScopeIds).toEqual(scopes.map(scope => scope.id))
    expect(queryGraph).toHaveBeenCalledWith({
      scopeIds: scopes.map(scope => scope.id),
      limit: 500,
    })
    expect(graphEvents).toHaveBeenCalledWith({
      scopeIds: scopes.map(scope => scope.id),
      offset: 0,
      limit: 50,
    })
    expect(store.issues).toHaveLength(1)
    expect(store.projects).toHaveLength(1)
    expect(store.scopeCounts['project:alpha']).toBe(1)
  })

  it('adopts a native setup mount without opening it again', async () => {
    const store = useBusinessGraphStore()
    await store.start('/alpha', { mountedStatus: { scopes, graphRevision: 4 } })
    expect(openBusinessGraph).not.toHaveBeenCalled()
    expect(listenForGraphChanges).toHaveBeenCalledOnce()
    expect(store.projectRoot).toBe('/alpha')
    expect(store.nodes).toEqual(summaries)
  })

  it('cannot restore a stopped store from a late native mount', async () => {
    const store = useBusinessGraphStore()
    let finish
    openBusinessGraph.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const pending = store.start('/alpha')
    store.stop()
    finish({ scopes, graphRevision: 1 })
    expect(await pending).toBe(false)
    expect(store.loading).toBe(false)
    expect(store.status).toBeNull()
    expect(listenForGraphChanges).not.toHaveBeenCalled()
    expect(queryGraph).not.toHaveBeenCalled()
  })

  it('cleans up a listener that arrives after the store stops', async () => {
    const store = useBusinessGraphStore()
    let finish
    const cleanup = vi.fn()
    listenForGraphChanges.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const pending = store.start('/alpha')
    await Promise.resolve()
    expect(listenForGraphChanges).toHaveBeenCalledOnce()
    store.stop()
    finish(cleanup)
    expect(await pending).toBe(false)
    expect(cleanup).toHaveBeenCalledOnce()
    expect(queryGraph).not.toHaveBeenCalled()
    listenForGraphChanges.mock.calls[0][0]({ graphRevision: 2 })
    expect(store.changedSources).toBeNull()
  })

  it('discards the previous mount query after a new workspace is loaded', async () => {
    const store = useBusinessGraphStore()
    let finish
    queryGraph.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const oldMount = store.start('/old')
    await vi.waitFor(() => expect(queryGraph).toHaveBeenCalledOnce())
    await store.start('/alpha')
    finish({ items: [{ id: 'old-only' }], total: 1, graphRevision: 99 })
    expect(await oldMount).toBe(false)
    expect(store.projectRoot).toBe('/alpha')
    expect(store.nodes).toEqual(summaries)
    expect(store.status.graphRevision).toBe(1)
  })

  it('returns created and restored entries without opening an inspector', async () => {
    const store = useBusinessGraphStore()
    await store.start('/alpha')
    const node = { ...summaries[0], properties: {}, provenance: { sourceRevision: 'created-rev' } }
    createGraphNode.mockResolvedValueOnce(node)
    expect(await store.create({ kind: 'issue', title: node.title })).toEqual(node)
    expect(getGraphNode).not.toHaveBeenCalled()
    expect(store.selectedNode).toBeNull()
    store.lastDeletion = { undoToken: 'undo' }
    restoreGraphNode.mockResolvedValueOnce(node)
    expect(await store.undoDelete()).toEqual(node)
    expect(restoreGraphNode).toHaveBeenCalledWith('undo')
    expect(getGraphNode).not.toHaveBeenCalled()
    expect(store.selectedNode).toBeNull()
  })

  it('preserves explicit source identity and revision guards on deletion', async () => {
    const store = useBusinessGraphStore()
    await store.start('/alpha')
    deleteGraphNode.mockResolvedValueOnce({ id: 'issue-1', undoToken: 'undo' })
    await store.remove('issue-1', 'editor-rev', '/alpha/issue-1.md')
    expect(deleteGraphNode).toHaveBeenCalledWith({
      id: 'issue-1', expectedRevision: 'editor-rev', expectedSourcePath: '/alpha/issue-1.md',
    })
    expect(store.lastDeletion).toMatchObject({ id: 'issue-1', title: 'Extract evidence', undoToken: 'undo' })
  })

  it('reconciles disk before reloading an explicit Refresh', async () => {
    const store = useBusinessGraphStore()
    await store.start('/alpha')
    queryGraph.mockClear()
    let finish
    refreshBusinessGraph.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const pending = store.refresh({ reconcile: true })
    expect(store.refreshing).toBe(true)
    expect(refreshBusinessGraph).toHaveBeenCalledOnce()
    expect(queryGraph).not.toHaveBeenCalled()
    finish({ graphRevision: 2 })
    await pending
    expect(queryGraph).toHaveBeenCalledOnce()
    expect(store.refreshing).toBe(false)
    store.stop()
  })

  it('keeps watcher, scope, and quiet reloads free of full disk scans', async () => {
    vi.useFakeTimers()
    const store = useBusinessGraphStore()
    try {
      await store.start('/alpha')
      const onChanged = listenForGraphChanges.mock.calls[0][0]
      onChanged({ graphRevision: 2 })
      await vi.advanceTimersByTimeAsync(80)
      await store.setScopes(['team:main'])
      await store.refresh({ quiet: true })
      expect(queryGraph).toHaveBeenCalledTimes(4)
      expect(refreshBusinessGraph).not.toHaveBeenCalled()
    } finally {
      store.stop()
      vi.useRealTimers()
    }
  })

  it('includes Team when it mounts after an initially complete Project view', async () => {
    const withoutTeam = scopes.filter(scope => scope.kind !== 'team')
    vi.mocked(openBusinessGraph)
      .mockResolvedValueOnce({
        scopes: withoutTeam,
        nodeCount: 1,
        diagnosticCount: 0,
        graphRevision: 1,
      })
      .mockResolvedValueOnce({
        scopes,
        nodeCount: 2,
        diagnosticCount: 0,
        graphRevision: 2,
      })
    const store = useBusinessGraphStore()

    await store.start('/alpha')
    expect(store.activeScopeIds).toEqual(withoutTeam.map(scope => scope.id))
    await store.start('/alpha')

    expect(store.activeScopeIds).toEqual(scopes.map(scope => scope.id))
    expect(queryGraph).toHaveBeenLastCalledWith({
      scopeIds: scopes.map(scope => scope.id),
      limit: 500,
    })
  })

  it('keeps an intentional scope filter when another scope mounts', async () => {
    const withoutTeam = scopes.filter(scope => scope.kind !== 'team')
    vi.mocked(openBusinessGraph)
      .mockResolvedValueOnce({
        scopes: withoutTeam,
        nodeCount: 1,
        diagnosticCount: 0,
        graphRevision: 1,
      })
      .mockResolvedValueOnce({
        scopes,
        nodeCount: 2,
        diagnosticCount: 0,
        graphRevision: 2,
      })
    const store = useBusinessGraphStore()

    await store.start('/alpha')
    await store.setScopes(['project:alpha'])
    await store.start('/alpha')

    expect(store.activeScopeIds).toEqual(['project:alpha'])
  })

  it('loads change history in bounded pages', async () => {
    const store = useBusinessGraphStore()
    await store.start('/alpha')
    const pageEvent = {
      id: 'event-51',
      nodeId: 'issue-1',
      actor: { label: 'Agent', initials: 'AG' },
    }
    vi.mocked(graphEvents).mockResolvedValueOnce({
      items: [pageEvent],
      total: 80,
      offset: 50,
      limit: 50,
    })

    await store.loadEventPage(50)

    expect(graphEvents).toHaveBeenLastCalledWith({
      scopeIds: scopes.map(scope => scope.id),
      offset: 50,
      limit: 50,
    })
    expect(store.events).toEqual([pageEvent])
    expect(store.eventOffset).toBe(50)
    expect(store.eventTotal).toBe(80)
  })

  it('fetches every event since a date without changing the visible history page', async () => {
    const store = useBusinessGraphStore()
    await store.start('/alpha')
    store.eventOffset = 50
    const firstPage = Array.from({ length: 500 }, (_, index) => ({ id: `event-${index}` }))
    const secondPage = Array.from({ length: 120 }, (_, index) => ({ id: `event-${index + 500}` }))
    vi.mocked(graphEvents)
      .mockResolvedValueOnce({ items: firstPage, total: 620, offset: 0, limit: 500 })
      .mockResolvedValueOnce({ items: secondPage, total: 620, offset: 500, limit: 500 })

    const page = await store.fetchEventsSince('2026-07-20T00:00:00Z')

    expect(graphEvents).toHaveBeenNthCalledWith(2, {
      scopeIds: scopes.map(scope => scope.id),
      since: '2026-07-20T00:00:00Z',
      offset: 0,
      limit: 500,
    })
    expect(graphEvents).toHaveBeenNthCalledWith(3, {
      scopeIds: scopes.map(scope => scope.id),
      since: '2026-07-20T00:00:00Z',
      offset: 500,
      limit: 500,
    })
    expect(page.items).toHaveLength(620)
    expect(store.eventOffset).toBe(50)
  })

  it('filters all loaded Work items by linked names and terms without the content-search limit', async () => {
    const store = useBusinessGraphStore()
    store.nodes = [
      { id: 'p', kind: 'project', title: 'Étude Alpha' },
      { id: 'a', kind: 'person', title: 'Anna Berg' },
      ...Array.from({ length: 150 }, (_, i) => ({
        id: `i-${i}`, kind: 'issue', title: 'Evidence review',
        projectId: 'p', assigneeId: 'a', tags: ['heor'],
      })),
    ]
    store.prepareSearch('ETUDE anna heor')
    expect(store.visibleNodes).toHaveLength(150)
    expect(searchGraph).not.toHaveBeenCalled()
    store.prepareSearch('missing')
    expect(store.visibleNodes).toHaveLength(0)
    store.clearSearch()
    expect(store.visibleNodes).toHaveLength(150)
  })

  it('switches between Work filtering and graph content search with the same query', async () => {
    const store = useBusinessGraphStore()
    await store.start('/alpha')
    store.prepareSearch('evidence')
    expect(store.visibleNodes.map(node => node.id)).toEqual(['issue-1'])
    let finishSearch
    searchGraph.mockReturnValue(new Promise(resolve => { finishSearch = resolve }))
    store.setSection('all')
    expect(store.searching).toBe(true)
    store.setSection('work')
    expect(store.searching).toBe(false)
    finishSearch([{ node: summaries[1] }])
    await Promise.resolve()
    expect(store.searchResults).toEqual([])
    expect(store.visibleNodes.map(node => node.id)).toEqual(['issue-1'])
  })

  it('invalidates an in-flight result when a newer search draft is prepared', async () => {
    let resolveSearch
    vi.mocked(searchGraph).mockReturnValue(new Promise(resolve => {
      resolveSearch = resolve
    }))
    const store = useBusinessGraphStore()
    await store.start('/alpha')

    store.setSection('all')
    const pending = store.search('b')
    expect(store.searching).toBe(true)

    store.prepareSearch('ba')
    expect(store.searchQuery).toBe('ba')
    expect(store.searchResults).toEqual([])
    expect(store.searching).toBe(false)

    resolveSearch([{ node: summaries[1] }])
    await pending
    expect(store.searchQuery).toBe('ba')
    expect(store.searchResults).toEqual([])
  })

  it('cannot remain stuck in a searching state after the graph stops', async () => {
    let resolveSearch
    vi.mocked(searchGraph).mockReturnValue(new Promise(resolve => {
      resolveSearch = resolve
    }))
    const store = useBusinessGraphStore()
    await store.start('/alpha')

    store.setSection('all')
    const pending = store.search('bank')
    expect(store.searching).toBe(true)
    store.stop()
    expect(store.searching).toBe(false)

    resolveSearch([{ node: summaries[0] }])
    await pending
    expect(store.searching).toBe(false)
    expect(store.searchResults).toEqual([])
  })

  it('rolls back optimistic edits and exposes revision conflicts', async () => {
    const store = useBusinessGraphStore()
    await store.start('/alpha')
    await store.openNode('issue-1')
    vi.mocked(updateGraphNode).mockRejectedValue(
      Object.assign(new Error('graph source changed'), {
        data: { conflict: true, actualRevision: 'rev-2' },
      }),
    )

    await expect(store.update({
      id: 'issue-1',
      title: 'Changed locally',
    })).rejects.toThrow('graph source changed')

    expect(updateGraphNode).toHaveBeenCalledWith(expect.objectContaining({
      id: 'issue-1',
      expectedRevision: 'rev-1',
    }))
    expect(store.conflict).toMatchObject({
      id: 'issue-1',
      actualRevision: 'rev-2',
    })
    expect(store.selectedNode.title).toBe('Extract evidence')
  })

  it('keeps the inspected object while another node is patched', async () => {
    const store = useBusinessGraphStore()
    await store.start('/alpha')
    await store.openNode('issue-1')
    vi.mocked(updateGraphNode).mockResolvedValue({
      id: 'project-alpha',
      kind: 'project',
      title: 'Project Alpha',
      tags: [],
      relations: [],
      properties: { status: 'in-progress' },
      provenance: { scopeId: 'team:main', sourceRevision: 'rev-p2' },
    })

    await store.update({ id: 'project-alpha', setProperties: { status: 'in-progress' } })

    // A board drag patches a card the user never opened: it must not borrow
    // the open object's revision, nor take its place in the inspector.
    expect(updateGraphNode).toHaveBeenCalledWith(expect.objectContaining({
      id: 'project-alpha',
      expectedRevision: undefined,
    }))
    expect(store.selectedNode.id).toBe('issue-1')
    expect(store.nodes.find(node => node.id === 'project-alpha').status).toBe('in-progress')
  })
})
