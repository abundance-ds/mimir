import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

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
  restoreGraphNode: vi.fn(),
  searchGraph: vi.fn(),
  updateGraphNode: vi.fn(),
}))

import {
  getGraphNode,
  graphDiagnostics,
  graphEvents,
  graphNeighbors,
  listenForGraphChanges,
  openBusinessGraph,
  queryGraph,
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

  it('mounts and composes all physical scopes by default', async () => {
    const store = useBusinessGraphStore()
    await store.start('/alpha', '/team')

    expect(openBusinessGraph).toHaveBeenCalledWith('/alpha', '/team')
    expect(store.activeScopeIds).toEqual(scopes.map(scope => scope.id))
    expect(queryGraph).toHaveBeenCalledWith({
      scopeIds: scopes.map(scope => scope.id),
      limit: 500,
    })
    expect(store.issues).toHaveLength(1)
    expect(store.projects).toHaveLength(1)
    expect(store.scopeCounts['project:alpha']).toBe(1)
  })

  it('keeps an inspectable context trail while preserving projection origin', async () => {
    const store = useBusinessGraphStore()
    await store.start('/alpha')
    store.section = 'projects'
    store.view = 'portfolio'

    await store.openNode('project-alpha')
    store.section = 'work'
    await store.openNode('issue-1')

    expect(store.contextTrail.map(item => item.id)).toEqual(['project-alpha', 'issue-1'])
    await store.stepTo(0)
    expect(store.selectedNode.id).toBe('project-alpha')
    expect(store.section).toBe('projects')
    expect(store.view).toBe('portfolio')
  })

  it('invalidates an in-flight result when a newer search draft is prepared', async () => {
    let resolveSearch
    vi.mocked(searchGraph).mockReturnValue(new Promise(resolve => {
      resolveSearch = resolve
    }))
    const store = useBusinessGraphStore()
    await store.start('/alpha')

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
})
