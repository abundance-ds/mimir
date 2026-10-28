import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope, nextTick, reactive } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../services/businessGraph.js', () => ({
  createGraphNode: vi.fn(),
  getGraphNode: vi.fn(),
  queryGraph: vi.fn(async () => ({ items: [], total: 0 })),
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
vi.mock('../../../services/timesheetExport.js', () => ({ exportCsvFile: vi.fn(async () => true) }))

import { updateGraphNode } from '../../../services/businessGraph.js'
import { exportCsvFile } from '../../../services/timesheetExport.js'
import { useBusinessGraphStore } from '../../../stores/businessGraph.js'
import { usePipelineStore } from '../../../stores/businessGraphPipeline.js'
import PipelineWorkspace from './PipelineWorkspace.vue'
import { useGraphViewState, VIEWS_BY_SECTION } from './useGraphViewState.js'
import { parseCsv } from '../../../shared/csv.js'
import { parseConnections } from './pipelineModel.js'

const company = (id, title, properties = {}) => ({
  id, kind: 'company', title, properties, provenance: { scopeId: 'team:main', sourceRevision: `${id}-r1` },
})

let wrapper, pipeline, graph
const body = () => new DOMWrapper(document.body)
const rows = () => wrapper.findAll('[data-pipeline-row]').map(row => row.attributes('data-pipeline-row'))
const headers = () => wrapper.findAll('thead th').map(cell => cell.text())

beforeEach(() => {
  setActivePinia(createPinia())
  graph = useBusinessGraphStore()
  pipeline = usePipelineStore()
  pipeline.companies = [
    company('northwind', 'Northwind Health Economics', { pipelineStage: 'Proposal', companyType: 'HEOR consultancy', hqCountry: 'United Kingdom', pipelineNextStep: 'Send the case study' }),
    company('contoso', 'Contoso Therapeutics', { pipelineStage: 'Target', companyType: 'Pharma', hqCountry: 'Switzerland' }),
    company('tailspin', 'Tailspin Outcomes', { companyType: 'HEOR consultancy' }),
  ]
  pipeline.connections = parseConnections('First Name,Last Name,Company,Position,Messaged\nAda,Example,Northwind Health Economics,Partner,Yes\n')
  pipeline.connectionsState = 'ready'
  pipeline.loaded = true
})
afterEach(() => { wrapper?.unmount(); vi.clearAllMocks() })

function render(view = 'companies') {
  wrapper = mount(PipelineWorkspace, {
    attachTo: document.body,
    props: { view, viewOptions: VIEWS_BY_SECTION.pipeline, emptyTitle: 'Nothing matches this view', emptyCopy: 'Clear search or filters.' },
  })
  return wrapper
}

describe('Pipeline companies', () => {
  it('shows staged companies by default, includes the rest on request, and names active filters', async () => {
    render()
    expect(rows()).toEqual(['contoso', 'northwind'])
    await wrapper.get('[data-graph-control="pipeline-show-unstaged"]').trigger('click')
    expect(rows()).toEqual(['contoso', 'northwind', 'tailspin'])
    expect(wrapper.get('[data-graph-control="pipeline-clear-filter-unstaged"]').text()).toBe('All companies')
    await wrapper.get('[data-graph-control="pipeline-clear-filter-unstaged"]').trigger('click')
    expect(rows()).toEqual(['contoso', 'northwind'])
  })

  it('filters by a column and clears the filter from its chip', async () => {
    render()
    await wrapper.get('[data-graph-control="graph-filter-companies-type"]').trigger('click')
    await body().get('[data-graph-control="graph-filter-option-companies-type-Pharma"]').trigger('click')
    expect(rows()).toEqual(['contoso'])
    const chip = wrapper.get('[data-graph-control="pipeline-clear-filter-type"]')
    expect(chip.text()).toBe('Type: Pharma')
    await chip.trigger('click')
    expect(rows()).toEqual(['contoso', 'northwind'])
  })

  it('filters by the connections bucket and by search over connection names', async () => {
    render()
    pipeline.setFilter('companies', 'connections', ['1'])
    await nextTick()
    expect(rows()).toEqual(['northwind'])
    pipeline.clearFilters('companies')
    graph.searchQuery = 'ada'
    await nextTick()
    expect(rows()).toEqual(['northwind'])
  })

  it('commits the next step on Enter and cancels it on Escape', async () => {
    vi.mocked(updateGraphNode).mockImplementation(async patch => ({
      ...pipeline.companies[0], properties: { ...pipeline.companies[0].properties, ...patch.setProperties },
      provenance: { scopeId: 'team:main', sourceRevision: 'northwind-r2' },
    }))
    render()
    await wrapper.get('[data-pipeline-row-button="northwind"]').trigger('click')
    const input = wrapper.get('[data-graph-control="pipeline-next-step"]')
    expect(input.element.value).toBe('Send the case study')
    expect(input.attributes('autocorrect')).toBe('off')
    expect(input.attributes('spellcheck')).toBe('false')

    await input.setValue('Draft a note')
    await input.trigger('keydown', { key: 'Escape' })
    expect(input.element.value).toBe('Send the case study')
    expect(updateGraphNode).not.toHaveBeenCalled()

    await input.setValue('Book a call')
    await input.trigger('blur')
    expect(updateGraphNode).not.toHaveBeenCalled()
    await input.trigger('keydown', { key: 'Enter', isComposing: true })
    expect(updateGraphNode).not.toHaveBeenCalled()
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(updateGraphNode).toHaveBeenCalledWith(expect.objectContaining({
      id: 'northwind', expectedRevision: 'northwind-r1', setProperties: { pipelineNextStep: 'Book a call' },
    }))
    expect(wrapper.find('[data-pipeline-row="northwind"]').text()).toContain('Book a call')
  })

  it('saves the stage from the row detail with the expected revision', async () => {
    vi.mocked(updateGraphNode).mockImplementation(async patch => ({
      ...pipeline.companies[1], properties: { ...pipeline.companies[1].properties, ...patch.setProperties },
      provenance: { scopeId: 'team:main', sourceRevision: 'contoso-r2' },
    }))
    render()
    await wrapper.get('[data-pipeline-row-button="contoso"]').trigger('click')
    await wrapper.get('[data-graph-control="pipeline-stage"]').trigger('click')
    await body().get('[data-graph-select-option="Client"]').trigger('click')
    await flushPromises()
    expect(updateGraphNode).toHaveBeenCalledWith(expect.objectContaining({
      id: 'contoso', expectedRevision: 'contoso-r1', setProperties: { pipelineStage: 'Client' },
    }))
  })

  it('shows a failed save and keeps the draft', async () => {
    vi.mocked(updateGraphNode).mockRejectedValue(new Error('Source changed'))
    render()
    await wrapper.get('[data-pipeline-row-button="northwind"]').trigger('click')
    const input = wrapper.get('[data-graph-control="pipeline-next-step"]')
    await input.setValue('Book a call')
    await wrapper.get('[data-graph-control="pipeline-next-step-save"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('Not saved. Source changed')
    expect(input.element.value).toBe('Book a call')
  })

  it('exports the shown rows', async () => {
    render()
    pipeline.setFilter('companies', 'stage', ['Proposal'])
    await nextTick()
    await wrapper.get('[data-graph-control="pipeline-export"]').trigger('click')
    await flushPromises()
    const [name, content] = vi.mocked(exportCsvFile).mock.calls.at(-1)
    expect(name).toBe('Pipeline companies')
    expect(parseCsv(content).map(row => row[0])).toEqual(['Company', 'Northwind Health Economics'])
  })
})

describe('Pipeline columns', () => {
  it('hides a column, keeps the name column, and persists the choice per view', async () => {
    const settings = reactive({ settingsReady: true, businessGraphViewState: { pipeline: { hiddenColumns: { triggers: ['rating'] } } }, set: vi.fn() })
    const scope = effectScope()
    scope.run(() => useGraphViewState({ graph, settings, pipeline }))
    expect(pipeline.hiddenColumns.triggers).toEqual(['rating'])
    render()
    expect(headers()).toContain('Next step')
    await wrapper.get('[data-graph-control="pipeline-columns"]').trigger('click')
    const name = body().get('[data-graph-control="pipeline-column-companies-company"]')
    expect(name.attributes('disabled')).toBeDefined()
    expect(name.attributes('aria-checked')).toBe('true')
    await name.trigger('click')
    await body().get('[data-graph-control="pipeline-column-companies-nextStep"]').trigger('click')
    expect(headers()).not.toContain('Next step')
    expect(headers()[0]).toBe('Company')
    expect(wrapper.get('[data-graph-control="pipeline-columns"]').text()).toContain('1 hidden')
    await flushPromises()
    expect(settings.set).toHaveBeenLastCalledWith('businessGraphViewState', expect.objectContaining({
      pipeline: { hiddenColumns: { companies: ['nextStep'], triggers: ['rating'], plays: [], network: [] }, includeUnstaged: false },
    }))
    scope.stop()
  })
})

describe('Pipeline status', () => {
  it('shows Retry instead of an empty table after a failed first load', async () => {
    pipeline.loaded = false
    pipeline.error = 'Graph is busy'
    render()
    expect(wrapper.text()).toContain('The pipeline could not load')
    expect(wrapper.find('[data-pipeline-table]').exists()).toBe(false)
    expect(wrapper.find('[data-graph-control="pipeline-retry"]').exists()).toBe(true)
  })

  it('shows a neutral note when the connections file is missing', async () => {
    pipeline.connections = []
    pipeline.connectionsState = 'missing'
    render('network')
    expect(wrapper.text()).toContain('No connections file. Add resources/connections.csv')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })

  it('lists network companies and adds one to the pipeline', async () => {
    pipeline.connections = parseConnections('First Name,Last Name,Company,Position\nEve,Fixture,Wingtip Analytics,Consultant\n')
    render('network')
    expect(rows()).toEqual(['wingtip analytics'])
    const spy = vi.spyOn(pipeline, 'addToPipeline').mockResolvedValue({})
    await wrapper.get('[data-graph-control="pipeline-add-wingtip-analytics"]').trigger('click')
    await flushPromises()
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ title: 'Wingtip Analytics', type: 'Consultancy' }))
    expect(wrapper.text()).toContain('Wingtip Analytics is in the pipeline at stage Target.')
  })
})
