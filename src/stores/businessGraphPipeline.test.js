import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../services/businessGraph.js', () => ({
  createGraphNode: vi.fn(),
  getGraphNode: vi.fn(),
  queryGraph: vi.fn(),
  updateGraphNode: vi.fn(),
  deleteGraphNode: vi.fn(),
  graphDiagnostics: vi.fn(async () => []),
  graphEvents: vi.fn(async () => ({ items: [], total: 0 })),
  graphNeighbors: vi.fn(async () => []),
  listenForGraphChanges: vi.fn(async () => () => {}),
  moveGraphNodeScope: vi.fn(),
  openBusinessGraph: vi.fn(),
  refreshBusinessGraph: vi.fn(),
  restoreGraphNode: vi.fn(),
  searchGraph: vi.fn(async () => []),
}))
vi.mock('../services/fileSystem.js', () => ({ readFile: vi.fn() }))

import { createGraphNode, getGraphNode, queryGraph, updateGraphNode } from '../services/businessGraph.js'
import { readFile } from '../services/fileSystem.js'
import { useBusinessGraphStore } from './businessGraph.js'
import { usePipelineStore } from './businessGraphPipeline.js'

const companies = Array.from({ length: 14 }, (_, index) => ({
  id: `company-${index}`, kind: 'company', title: `Example Company ${index}`, sourceRevision: `r${index}`, scopeId: 'team:main',
}))
const trigger = { id: 'trigger-hire', kind: 'note', title: 'New lead hired', tags: ['sales-trigger'], sourceRevision: 't1' }
const play = { id: 'play-intro', kind: 'note', title: 'Warm introduction', tags: ['sales-play'], sourceRevision: 'p1' }

function full(summary) {
  return {
    ...summary,
    properties: summary.id === 'company-0'
      ? { pipelineStage: 'Target', pipelineNextStep: 'Call', connectionAliases: ['Ex Co'] }
      : summary.kind === 'company' ? { pipelineStage: 'Contacted' } : {},
    provenance: { scopeId: 'team:main', sourceRevision: summary.sourceRevision },
  }
}

let inFlight = 0, maxInFlight = 0
beforeEach(() => {
  setActivePinia(createPinia())
  inFlight = 0
  maxInFlight = 0
  vi.mocked(queryGraph).mockImplementation(async query => {
    const items = query.tags?.includes('sales-trigger') ? [trigger]
      : query.tags?.includes('sales-play') ? [play] : query.kinds?.includes('company') ? companies : []
    return { items, total: items.length, graphRevision: 7 }
  })
  vi.mocked(getGraphNode).mockImplementation(async id => {
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise(resolve => setTimeout(resolve, 1))
    inFlight -= 1
    return full([...companies, trigger, play].find(item => item.id === id))
  })
  vi.mocked(readFile).mockResolvedValue('First Name,Last Name,Company,Position,Messaged\nAda,Example,Ex Co,Partner,Yes\n')
})
afterEach(() => vi.clearAllMocks())

function setup() {
  const graph = useBusinessGraphStore()
  graph.status = { scopes: [{ id: 'team:main', kind: 'team', root: '/team' }], graphRevision: 7 }
  graph.activeScopeIds = ['team:main']
  graph.teamRoot = '/team'
  const pipeline = usePipelineStore()
  return { graph, pipeline }
}

describe('Pipeline store', () => {
  it('loads tagged notes and full companies with bounded concurrency when the section opens', async () => {
    const { graph, pipeline } = setup()
    expect(queryGraph).not.toHaveBeenCalled()
    graph.section = 'pipeline'
    await vi.waitFor(() => expect(pipeline.loaded).toBe(true))
    expect(queryGraph).toHaveBeenCalledWith(expect.objectContaining({ kinds: ['note'], tags: ['sales-trigger'] }))
    expect(queryGraph).toHaveBeenCalledWith(expect.objectContaining({ kinds: ['note'], tags: ['sales-play'] }))
    expect(maxInFlight).toBeLessThanOrEqual(6)
    expect(pipeline.companies).toHaveLength(14)
    expect(readFile).toHaveBeenCalledWith('/team/resources/connections.csv')
    expect(pipeline.connectionsState).toBe('ready')
    expect(pipeline.companyRows.find(row => row.id === 'company-0').connectionCount).toBe(1)
  })

  it('refetches only nodes whose revision changed when the graph revision changes', async () => {
    const { graph, pipeline } = setup()
    graph.section = 'pipeline'
    await vi.waitFor(() => expect(pipeline.loaded).toBe(true))
    vi.mocked(getGraphNode).mockClear()
    companies[3] = { ...companies[3], sourceRevision: 'r3b' }
    graph.status = { ...graph.status, graphRevision: 8 }
    await flushPromises()
    await vi.waitFor(() => expect(pipeline.loading).toBe(false))
    expect(vi.mocked(getGraphNode).mock.calls.map(call => call[0])).toEqual(['company-3'])
    companies[3] = { ...companies[3], sourceRevision: 'r3' }
  })

  it('pages through more than 500 entries', async () => {
    const many = Array.from({ length: 501 }, (_, index) => ({ id: `c${index}`, kind: 'company', title: `C ${index}`, sourceRevision: 'x' }))
    vi.mocked(queryGraph).mockImplementation(async query => {
      if (!query.kinds?.includes('company')) return { items: [], total: 0, graphRevision: 1 }
      return { items: many.slice(query.offset, query.offset + query.limit), total: many.length, graphRevision: 1 }
    })
    vi.mocked(getGraphNode).mockImplementation(async id => ({ id, kind: 'company', title: id, properties: {}, provenance: { sourceRevision: 'x' } }))
    const { graph, pipeline } = setup()
    graph.section = 'pipeline'
    await vi.waitFor(() => expect(pipeline.loaded).toBe(true))
    expect(pipeline.companies).toHaveLength(501)
    expect(queryGraph).toHaveBeenCalledWith(expect.objectContaining({ kinds: ['company'], offset: 500 }))
  })

  it('keeps an error with retry instead of an empty result', async () => {
    vi.mocked(queryGraph).mockRejectedValueOnce(new Error('Graph is busy'))
    const { graph, pipeline } = setup()
    graph.section = 'pipeline'
    await vi.waitFor(() => expect(pipeline.error).toBe('Graph is busy'))
    await vi.waitFor(() => expect(pipeline.loading).toBe(false))
    expect(pipeline.loaded).toBe(false)
    await pipeline.load()
    expect(pipeline.error).toBe('')
    expect(pipeline.loaded).toBe(true)
  })

  it('treats a missing connections file or Team root as a normal state', async () => {
    vi.mocked(readFile).mockRejectedValueOnce(new Error('No such file or directory (os error 2)'))
    const { pipeline, graph } = setup()
    await pipeline.loadConnections()
    expect(pipeline.connectionsState).toBe('missing')
    vi.mocked(readFile).mockRejectedValueOnce(new Error('Permission denied'))
    await pipeline.loadConnections()
    expect(pipeline.connectionsState).toBe('error')
    graph.teamRoot = ''
    await pipeline.loadConnections()
    expect(pipeline.connectionsState).toBe('missing')
  })

  it('saves a property with the expected revision and removes an empty value', async () => {
    const { graph, pipeline } = setup()
    graph.section = 'pipeline'
    await vi.waitFor(() => expect(pipeline.loaded).toBe(true))
    const row = pipeline.companyRows.find(item => item.id === 'company-0')
    vi.mocked(updateGraphNode).mockImplementation(async patch => ({
      ...full(companies[0]), properties: { ...full(companies[0]).properties, ...patch.setProperties },
      provenance: { sourceRevision: 'r0b' },
    }))
    await pipeline.setCompanyProperty(row, 'pipelineStage', 'Proposal')
    expect(updateGraphNode).toHaveBeenCalledWith(expect.objectContaining({
      id: 'company-0', expectedRevision: 'r0', setProperties: { pipelineStage: 'Proposal' },
    }))
    expect(pipeline.companyRows.find(item => item.id === 'company-0').stage).toBe('Proposal')
    await pipeline.setCompanyProperty(pipeline.companyRows.find(item => item.id === 'company-0'), 'pipelineNextStep', '  ')
    expect(updateGraphNode).toHaveBeenLastCalledWith(expect.objectContaining({ expectedRevision: 'r0b', removeProperties: ['pipelineNextStep'] }))
  })

  it('adds a Network company as a Target company node with a guessed type', async () => {
    const { pipeline } = setup()
    vi.mocked(createGraphNode).mockResolvedValue({ id: 'company-new', kind: 'company', title: 'Wingtip Analytics', properties: { pipelineStage: 'Target' }, provenance: { sourceRevision: 'n1' } })
    await pipeline.addToPipeline({ title: 'Wingtip Analytics', type: 'Consultancy', company: null })
    expect(createGraphNode).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'company', title: 'Wingtip Analytics', properties: { pipelineStage: 'Target', companyType: 'Consultancy' },
    }))
    expect(pipeline.companies.map(node => node.id)).toContain('company-new')
  })

  it('keeps hidden columns valid and never hides the name column', () => {
    const { pipeline } = setup()
    pipeline.setColumnHidden('companies', 'company', true)
    pipeline.setColumnHidden('companies', 'nextStep', true)
    expect(pipeline.hiddenColumns.companies).toEqual(['nextStep'])
    pipeline.restoreViewState({ hiddenColumns: { triggers: ['rating', 'trigger', 'bogus'] }, includeUnstaged: true })
    expect(pipeline.viewState()).toEqual({
      hiddenColumns: { companies: [], triggers: ['rating'], plays: [], network: [] },
      includeUnstaged: true,
    })
  })
})
