import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { getGraphNode, queryGraph } from '../services/businessGraph.js'
import { readFile } from '../services/fileSystem.js'
import { useBusinessGraphStore } from './businessGraph.js'
import {
  NETWORK_PAGE_SIZE,
  PIPELINE_COLUMNS,
  PLAY_TAG,
  TRIGGER_TAG,
  buildCompanyRows,
  buildNetworkRows,
  buildPlayRows,
  buildTriggerRows,
  companyFilterOptions,
  companyTypeFromGuess,
  filterCompanyRows,
  filterNetworkRows,
  filterPlayRows,
  filterTriggerRows,
  groupConnections,
  networkFilterOptions,
  parseConnections,
  playFilterOptions,
  sanitizeHiddenColumns,
  triggerFilterOptions,
} from '../mimir/apps/business-graph/pipelineModel.js'

const PAGE = 500
const FETCH_CONCURRENCY = 6
export const CONNECTIONS_PATH = 'resources/connections.csv'

function emptyFilters() {
  return {
    companies: { type: [], country: [], stage: [], trigger: [], play: [], connections: [] },
    triggers: { category: [], for: [], rating: [] },
    plays: { for: [], verdict: [] },
    network: { type: [], connections: [], messaged: [], inPipeline: [] },
  }
}

export const usePipelineStore = defineStore('businessGraphPipeline', () => {
  const graph = useBusinessGraphStore()
  const companies = ref([])
  const triggers = ref([])
  const plays = ref([])
  const loading = ref(false)
  const loaded = ref(false)
  const error = ref('')
  const connections = ref([])
  const connectionsState = ref('idle') // idle | loading | ready | missing | error
  const connectionsError = ref('')
  const filters = ref(emptyFilters())
  const includeUnstaged = ref(false)
  const hiddenColumns = ref({ companies: [], triggers: [], plays: [], network: [] })
  const networkLimit = ref(NETWORK_PAGE_SIZE)
  const cache = new Map()
  let generation = 0
  let connectionsGeneration = 0

  const active = computed(() => graph.section === 'pipeline' && Boolean(graph.status))
  const query = computed(() => graph.searchQuery)
  const groups = computed(() => groupConnections(connections.value))
  const companyRows = computed(() => buildCompanyRows({
    companies: companies.value, triggers: triggers.value, plays: plays.value, groups: groups.value,
  }))
  const triggerRows = computed(() => buildTriggerRows(triggers.value, plays.value))
  const playRows = computed(() => buildPlayRows(plays.value, triggers.value))
  const networkRows = computed(() => buildNetworkRows(groups.value, companies.value))
  const visibleCompanyRows = computed(() => filterCompanyRows(companyRows.value, {
    query: query.value, filters: filters.value.companies, includeUnstaged: includeUnstaged.value,
  }))
  const visibleTriggerRows = computed(() => filterTriggerRows(triggerRows.value, { query: query.value, filters: filters.value.triggers }))
  const visiblePlayRows = computed(() => filterPlayRows(playRows.value, { query: query.value, filters: filters.value.plays }))
  const visibleNetworkRows = computed(() => filterNetworkRows(networkRows.value, { query: query.value, filters: filters.value.network }))
  const shownNetworkRows = computed(() => visibleNetworkRows.value.slice(0, networkLimit.value))
  const filterOptions = computed(() => ({
    companies: companyFilterOptions(companyRows.value),
    triggers: triggerFilterOptions(triggerRows.value),
    plays: playFilterOptions(playRows.value),
    network: networkFilterOptions(networkRows.value),
  }))
  const visibleCount = computed(() => ({
    companies: visibleCompanyRows.value.length,
    triggers: visibleTriggerRows.value.length,
    plays: visiblePlayRows.value.length,
    network: visibleNetworkRows.value.length,
  })[graph.view] ?? 0)

  async function pageAll(request, current) {
    const items = []
    let revision = null
    for (;;) {
      const result = await queryGraph({ scopeIds: [...graph.activeScopeIds], ...request,
        order: { sortBy: 'title', direction: 'asc' }, offset: items.length, limit: PAGE })
      if (!current()) return null
      // Restart if entries moved between pages.
      if (revision != null && result?.graphRevision != null && revision !== result.graphRevision) {
        items.length = 0
        revision = null
        continue
      }
      revision = result?.graphRevision ?? null
      const page = Array.isArray(result?.items) ? result.items : []
      items.push(...page)
      if (page.length < PAGE || items.length >= (result?.total ?? items.length)) return items
    }
  }

  // Summaries carry no custom properties, so read full nodes. Unchanged
  // revisions come from the cache.
  async function fullNodes(summaries, current) {
    const results = new Array(summaries.length)
    let next = 0
    async function worker() {
      while (next < summaries.length) {
        const index = next++
        const summary = summaries[index]
        const hit = cache.get(summary.id)
        if (hit && summary.sourceRevision && hit.revision === summary.sourceRevision) {
          results[index] = hit.node
          continue
        }
        const node = await getGraphNode(summary.id)
        if (!current()) return
        if (node) remember(node, summary.sourceRevision)
        results[index] = node
      }
    }
    await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, summaries.length) }, worker))
    return results.filter(Boolean)
  }

  function remember(node, revision = node?.provenance?.sourceRevision || node?.sourceRevision) {
    if (node?.id && revision) cache.set(node.id, { revision, node })
  }

  async function load({ withConnections = false } = {}) {
    const request = ++generation
    const current = () => request === generation
    loading.value = true
    error.value = ''
    if (withConnections || connectionsState.value === 'idle') void loadConnections()
    try {
      const [companySummaries, triggerSummaries, playSummaries] = await Promise.all([
        pageAll({ kinds: ['company'] }, current),
        pageAll({ kinds: ['note'], tags: [TRIGGER_TAG] }, current),
        pageAll({ kinds: ['note'], tags: [PLAY_TAG] }, current),
      ])
      if (!current() || !companySummaries || !triggerSummaries || !playSummaries) return
      const [nextCompanies, nextTriggers, nextPlays] = await Promise.all([
        fullNodes(companySummaries, current), fullNodes(triggerSummaries, current), fullNodes(playSummaries, current),
      ])
      if (!current()) return
      const ids = new Set([...nextCompanies, ...nextTriggers, ...nextPlays].map(node => node.id))
      for (const id of cache.keys()) if (!ids.has(id)) cache.delete(id)
      companies.value = nextCompanies
      triggers.value = nextTriggers
      plays.value = nextPlays
      loaded.value = true
    } catch (cause) {
      if (current()) error.value = message(cause)
    } finally {
      if (current()) loading.value = false
    }
  }

  async function loadConnections() {
    const request = ++connectionsGeneration
    const root = String(graph.teamRoot || '').replace(/\/+$/, '')
    if (!root) {
      connections.value = []
      connectionsState.value = 'missing'
      return
    }
    connectionsState.value = 'loading'
    connectionsError.value = ''
    try {
      const content = await readFile(`${root}/${CONNECTIONS_PATH}`)
      if (request !== connectionsGeneration) return
      connections.value = parseConnections(content || '')
      connectionsState.value = content ? 'ready' : 'missing'
    } catch (cause) {
      if (request !== connectionsGeneration) return
      connections.value = []
      const text = message(cause)
      // A missing file is a normal setup state, not a failure.
      if (/not found|no such file|does not exist|os error 2|cannot find/i.test(text)) connectionsState.value = 'missing'
      else {
        connectionsState.value = 'error'
        connectionsError.value = text
      }
    }
  }

  async function updateCompany(row, { setProperties = {}, removeProperties = [] } = {}) {
    const node = companies.value.find(item => item.id === row.id) || row.node
    const updated = await graph.update({
      id: node.id,
      expectedRevision: node?.provenance?.sourceRevision || node?.sourceRevision,
      ...(Object.keys(setProperties).length ? { setProperties } : {}),
      ...(removeProperties.length ? { removeProperties } : {}),
    })
    replaceNode(updated)
    return updated
  }

  async function setCompanyProperty(row, key, value) {
    const next = String(value ?? '').trim()
    return updateCompany(row, next ? { setProperties: { [key]: next } } : { removeProperties: [key] })
  }

  /** Add a Network company: stage an existing company node or create one. */
  async function addToPipeline(networkRow) {
    if (networkRow.company) return setCompanyProperty({ id: networkRow.company.id, node: networkRow.company }, 'pipelineStage', 'Target')
    const companyType = companyTypeFromGuess(networkRow.type)
    const created = await graph.create({
      kind: 'company',
      title: networkRow.title,
      properties: { pipelineStage: 'Target', ...(companyType ? { companyType } : {}) },
    })
    if (created?.id) replaceNode(created)
    return created
  }

  function replaceNode(node) {
    if (!node?.id || node.kind !== 'company') return
    remember(node)
    const index = companies.value.findIndex(item => item.id === node.id)
    if (index >= 0) companies.value.splice(index, 1, node)
    else companies.value.push(node)
  }

  function setFilter(view, filter, values) {
    filters.value = { ...filters.value, [view]: { ...filters.value[view], [filter]: [...values] } }
    if (view === 'network') networkLimit.value = NETWORK_PAGE_SIZE
  }

  function clearFilters(view) {
    filters.value = { ...filters.value, [view]: emptyFilters()[view] }
    if (view === 'companies') includeUnstaged.value = false
    if (view === 'network') networkLimit.value = NETWORK_PAGE_SIZE
  }

  function setColumnHidden(view, column, hidden) {
    const current = new Set(hiddenColumns.value[view] || [])
    if (hidden) current.add(column)
    else current.delete(column)
    hiddenColumns.value = { ...hiddenColumns.value, [view]: sanitizeHiddenColumns(view, [...current]) }
  }

  function restoreViewState(saved = {}) {
    const hidden = saved.hiddenColumns || {}
    hiddenColumns.value = Object.fromEntries(Object.keys(PIPELINE_COLUMNS)
      .map(view => [view, sanitizeHiddenColumns(view, hidden[view])]))
    includeUnstaged.value = saved.includeUnstaged === true
  }

  function viewState() {
    return {
      hiddenColumns: Object.fromEntries(Object.entries(hiddenColumns.value).map(([view, ids]) => [view, [...ids]])),
      includeUnstaged: includeUnstaged.value,
    }
  }

  function showMoreNetwork() {
    networkLimit.value += NETWORK_PAGE_SIZE
  }

  function reset() {
    generation += 1
    connectionsGeneration += 1
    cache.clear()
    companies.value = []
    triggers.value = []
    plays.value = []
    connections.value = []
    connectionsState.value = 'idle'
    loaded.value = false
    loading.value = false
    error.value = ''
  }

  // Load when the section opens; while open, follow the Graph revision.
  // Unchanged nodes come from the cache, so a reload reads only edits.
  watch(active, isActive => {
    if (isActive) void load({ withConnections: true })
  }, { immediate: true })
  watch(() => [graph.status?.graphRevision, graph.activeScopeIds.join('\n')], () => {
    if (!loaded.value && !loading.value) return
    if (active.value) void load()
  })
  watch(() => graph.teamRoot, () => { if (active.value) void loadConnections() })
  watch(() => graph.projectRoot, root => { if (!root) reset() })
  watch(query, () => { networkLimit.value = NETWORK_PAGE_SIZE })

  return {
    companies, triggers, plays, loading, loaded, error,
    connections, connectionsState, connectionsError,
    filters, includeUnstaged, hiddenColumns, networkLimit,
    companyRows, triggerRows, playRows, networkRows,
    visibleCompanyRows, visibleTriggerRows, visiblePlayRows, visibleNetworkRows, shownNetworkRows,
    filterOptions, visibleCount,
    load, loadConnections, updateCompany, setCompanyProperty, addToPipeline,
    setFilter, clearFilters, setColumnHidden, restoreViewState, viewState, showMoreNetwork, reset,
  }
})

function message(cause) {
  return cause instanceof Error ? cause.message : String(cause || 'The pipeline could not load.')
}
