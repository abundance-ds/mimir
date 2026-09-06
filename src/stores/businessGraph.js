import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  createGraphNode,
  deleteGraphNode,
  getGraphNode,
  graphDiagnostics,
  graphEvents,
  graphNeighbors,
  listenForGraphChanges,
  moveGraphNodeScope,
  openBusinessGraph,
  queryGraph,
  restoreGraphNode,
  searchGraph,
  updateGraphNode,
} from '../services/businessGraph.js'
import { defaultGraphWriteScope } from './businessGraphScopes.js'
import { cachedWorkspaceConfig } from '../services/workspaceConfig.js'
import { filterWork, workSearchIndex } from './businessGraphWorkSearch.js'

export const BUSINESS_SECTIONS = Object.freeze([
  { id: 'work', label: 'Work', kinds: ['issue'] },
  { id: 'all', label: 'Graph', kinds: [] },
])

const EVENT_PAGE_SIZE = 50
const MAX_SUMMARY_EVENTS = 2_000

export const useBusinessGraphStore = defineStore('businessGraph', () => {
  const status = ref(null)
  const nodes = ref([])
  const diagnostics = ref([])
  const events = ref([])
  const eventTotal = ref(0)
  const eventOffset = ref(0)
  const eventLimit = ref(EVENT_PAGE_SIZE)
  const eventsLoading = ref(false)
  const loading = ref(false)
  const refreshing = ref(false)
  const error = ref('')
  const conflict = ref(null)
  const activeScopeIds = ref([])
  const section = ref('work')
  const view = ref('board')
  const sectionViews = ref({
    all: 'list',
    work: 'board',
  })
  const searchQuery = ref('')
  const searchResults = ref([])
  const searching = ref(false)
  const selectedNode = ref(null)
  const selectedNeighbors = ref([])
  const inspectionHistory = ref([])
  const inspectionHistoryIndex = ref(-1)
  const lastDeletion = ref(null)
  const projectRoot = ref('')
  const teamRoot = ref('')
  const workspaceProjectId = ref('')
  const workspaceGraphScope = ref('team')
  let unlisten = null
  let refreshTimer = null
  let searchGeneration = 0
  let eventLoadGeneration = 0
  let deletionTimer = null

  const scopes = computed(() => status.value?.scopes || [])
  const selectedScopes = computed(() => (
    scopes.value.filter(scope => activeScopeIds.value.includes(scope.id))
  ))
  const workIndex = computed(() => workSearchIndex(nodes.value))
  const visibleNodes = computed(() => {
    if (section.value === 'work') {
      return filterWork(issues.value, workIndex.value, searchQuery.value)
    }
    const definition = BUSINESS_SECTIONS.find(item => item.id === section.value)
    const kinds = new Set(definition?.kinds || [])
    const items = searchQuery.value.trim() ? searchResults.value : nodes.value
    return kinds.size ? items.filter(item => kinds.has(item.kind)) : items
  })
  const issues = computed(() => nodes.value.filter(node => node.kind === 'issue'))
  const projects = computed(() => nodes.value.filter(node => node.kind === 'project'))
  const people = computed(() => nodes.value.filter(node => node.kind === 'person'))
  const companies = computed(() => nodes.value.filter(node => node.kind === 'company'))
  const scopeCounts = computed(() => Object.fromEntries(
    scopes.value.map(scope => [
      scope.id,
      nodes.value.filter(node => node.scopeId === scope.id).length,
    ]),
  ))
  const issueCounts = computed(() => {
    const counts = {}
    for (const issue of issues.value) {
      const status = issue.status || 'backlog'
      counts[status] = (counts[status] || 0) + 1
    }
    return counts
  })
  const latestActors = computed(() => {
    const actors = {}
    for (const event of events.value) {
      if (!actors[event.nodeId] && event.actor) actors[event.nodeId] = event.actor
    }
    return actors
  })
  const historyBack = computed(() => (
    inspectionHistory.value[inspectionHistoryIndex.value - 1] || null
  ))
  const historyForward = computed(() => (
    inspectionHistory.value[inspectionHistoryIndex.value + 1] || null
  ))

  // The first projection only needs the node query, so the change listener is
  // installed before it (no file change can slip through the mount window) and
  // diagnostics plus change history hydrate after the board is already on
  // screen instead of holding the loading state open.
  async function start(workspace) {
    const nextProject = String(workspace || '').trim()
    if (!nextProject) {
      reset()
      return
    }
    loading.value = true
    error.value = ''
    try {
      const workspaceConfig = cachedWorkspaceConfig(nextProject)
      workspaceProjectId.value = String(workspaceConfig?.project || '').trim()
      const mounted = await openBusinessGraph(nextProject)
      const nextTeam = mounted?.scopes?.find(scope => scope.kind === 'team')?.root || ''
      workspaceGraphScope.value = workspaceConfig?.graphScope === 'workspace'
        ? 'workspace'
        : (nextTeam ? 'team' : 'workspace')
      projectRoot.value = nextProject
      teamRoot.value = nextTeam
      applyStatus(mounted)
      eventOffset.value = 0
      await startListening()
      await loadNodes()
    } catch (cause) {
      error.value = errorMessage(cause)
      loading.value = false
      throw cause
    }
    loading.value = false
    try {
      await loadAuxiliary()
    } catch (cause) {
      error.value = errorMessage(cause)
    }
  }

  async function refresh({ quiet = false } = {}) {
    if (!status.value) return
    if (!quiet) refreshing.value = true
    try {
      await Promise.all([loadNodes(), loadAuxiliary()])
      error.value = ''
      if (searchQuery.value.trim()) await search(searchQuery.value)
      if (selectedNode.value?.id) await reloadSelected()
    } catch (cause) {
      error.value = errorMessage(cause)
      if (!quiet) throw cause
    } finally {
      refreshing.value = false
    }
  }

  async function loadNodes() {
    const result = await queryGraph({ scopeIds: activeScopeIds.value, limit: 500 })
    nodes.value = Array.isArray(result?.items) ? result.items : []
    status.value = {
      ...status.value,
      nodeCount: result?.total ?? nodes.value.length,
      graphRevision: result?.graphRevision ?? status.value.graphRevision,
    }
  }

  async function loadAuxiliary() {
    const [nextDiagnostics] = await Promise.all([
      graphDiagnostics(),
      loadEventPage(eventOffset.value),
    ])
    diagnostics.value = Array.isArray(nextDiagnostics) ? nextDiagnostics : []
    status.value = { ...status.value, diagnosticCount: diagnostics.value.length }
  }

  async function loadEventPage(offset = 0) {
    const requestedOffset = Math.max(0, Math.floor(Number(offset) || 0))
    const generation = ++eventLoadGeneration
    eventsLoading.value = true
    try {
      let page = await graphEvents({
        scopeIds: activeScopeIds.value,
        offset: requestedOffset,
        limit: eventLimit.value,
      })
      if (generation !== eventLoadGeneration) return page
      let total = Math.max(0, Number(page?.total) || 0)
      if (total > 0 && requestedOffset >= total) {
        const lastOffset = Math.floor((total - 1) / eventLimit.value) * eventLimit.value
        page = await graphEvents({
          scopeIds: activeScopeIds.value,
          offset: lastOffset,
          limit: eventLimit.value,
        })
        if (generation !== eventLoadGeneration) return page
        total = Math.max(0, Number(page?.total) || 0)
      }
      events.value = Array.isArray(page?.items) ? page.items : []
      eventTotal.value = total || events.value.length
      eventOffset.value = Math.max(0, Number(page?.offset) || 0)
      return page
    } finally {
      if (generation === eventLoadGeneration) eventsLoading.value = false
    }
  }

  async function fetchEventsSince(since) {
    const scopeIds = [...activeScopeIds.value]
    const items = []
    let total = 0
    while (items.length < MAX_SUMMARY_EVENTS) {
      const page = await graphEvents({
        scopeIds,
        since: String(since || ''),
        offset: items.length,
        limit: 500,
      })
      const pageItems = Array.isArray(page?.items) ? page.items : []
      total = Math.max(0, Number(page?.total) || pageItems.length)
      items.push(...pageItems.slice(0, MAX_SUMMARY_EVENTS - items.length))
      if (!pageItems.length || items.length >= total) break
    }
    return {
      items,
      total,
      offset: 0,
      limit: items.length,
      since: String(since || ''),
    }
  }

  async function search(value) {
    const query = String(value || '')
    searchQuery.value = query
    const generation = ++searchGeneration
    if (!query.trim() || section.value === 'work') {
      searchResults.value = []
      searching.value = false
      return
    }
    searching.value = true
    try {
      const results = await searchGraph(query, {
        scopeIds: activeScopeIds.value,
        limit: 100,
      })
      if (generation !== searchGeneration) return
      searchResults.value = (Array.isArray(results) ? results : [])
        .map(result => result.node || result)
    } catch (cause) {
      if (generation === searchGeneration) error.value = errorMessage(cause)
    } finally {
      if (generation === searchGeneration) searching.value = false
    }
  }

  function prepareSearch(value) {
    searchGeneration += 1
    searchQuery.value = String(value || '')
    searchResults.value = []
    searching.value = false
  }

  function clearSearch() {
    searchGeneration += 1
    searchQuery.value = ''
    searchResults.value = []
    searching.value = false
  }

  async function openNode(id, origin = projectionState()) {
    const node = await getGraphNode(id)
    if (!node) throw new Error(`Graph node not found: ${id}`)
    const neighbors = await graphNeighbors(id, { scopeIds: activeScopeIds.value })
    selectedNode.value = node
    selectedNeighbors.value = Array.isArray(neighbors) ? neighbors : []
    const current = inspectionHistory.value[inspectionHistoryIndex.value]
    if (current?.id !== node.id) {
      const next = inspectionHistory.value.slice(0, inspectionHistoryIndex.value + 1)
      next.push({
        id: node.id,
        kind: node.kind,
        title: historyTitle(node),
        origin,
      })
      inspectionHistory.value = next.slice(-24)
      inspectionHistoryIndex.value = inspectionHistory.value.length - 1
    }
    return node
  }

  async function navigateHistory(direction) {
    const index = inspectionHistoryIndex.value + Math.sign(Number(direction) || 0)
    const item = inspectionHistory.value[index]
    if (!item) return
    restoreProjection(item.origin)
    const [node, neighbors] = await Promise.all([
      getGraphNode(item.id),
      graphNeighbors(item.id, { scopeIds: activeScopeIds.value }),
    ])
    if (!node) throw new Error(`Graph node not found: ${item.id}`)
    selectedNode.value = node
    selectedNeighbors.value = Array.isArray(neighbors) ? neighbors : []
    inspectionHistoryIndex.value = index
  }

  function closeInspector({ restore = true } = {}) {
    const origin = inspectionHistory.value[0]?.origin
    selectedNode.value = null
    selectedNeighbors.value = []
    inspectionHistory.value = []
    inspectionHistoryIndex.value = -1
    if (restore && origin) restoreProjection(origin)
  }

  async function create(create) {
    conflict.value = null
    const relations = Array.isArray(create.relations) ? [...create.relations] : []
    if (
      create.kind === 'issue'
      && workspaceProjectId.value
      && !relations.some(edge => edge.relation === 'part_of')
    ) {
      relations.push({
        relation: 'part_of',
        target: workspaceProjectId.value,
        legacy: false,
      })
    }
    const created = await createGraphNode({
      ...create,
      relations,
      scopeId: create.scopeId || defaultWriteScope(create.kind),
    })
    await refresh({ quiet: true })
    await openNode(created.id)
    return created
  }

  async function update(patch) {
    // Only the inspected node moves optimistically, and only it lends its
    // revision. A patch for another node — a board drag, a bulk edit — must
    // leave the open object alone: taking it over would swap the inspected
    // object under the user, and its revision belongs to a different source.
    const inspected = selectedNode.value?.id === patch.id ? selectedNode.value : null
    const before = inspected ? cloneGraphValue(inspected) : null
    conflict.value = null
    if (inspected) selectedNode.value = optimisticNode(inspected, patch)
    try {
      const updated = await updateGraphNode({
        ...patch,
        expectedRevision: patch.expectedRevision
          || before?.provenance?.sourceRevision
          || before?.sourceRevision,
      })
      if (selectedNode.value?.id === updated.id) selectedNode.value = updated
      replaceSummary(updated)
      const historyItem = inspectionHistory.value[inspectionHistoryIndex.value]
      if (historyItem?.id === updated.id) {
        inspectionHistory.value[inspectionHistoryIndex.value] = {
          ...historyItem,
          kind: updated.kind,
          title: historyTitle(updated),
        }
      }
      return updated
    } catch (cause) {
      if (before) selectedNode.value = before
      conflict.value = conflictValue(cause, patch.id)
      await refresh({ quiet: true })
      throw cause
    }
  }

  async function moveScope(id, targetScopeId, expectedRevision = null) {
    const current = selectedNode.value?.id === id
      ? selectedNode.value
      : await getGraphNode(id)
    const moved = await moveGraphNodeScope({
      id,
      targetScopeId,
      expectedRevision: expectedRevision
        || current?.provenance?.sourceRevision
        || current?.sourceRevision,
    })
    if (selectedNode.value?.id === moved.id) selectedNode.value = moved
    replaceSummary(moved)
    return moved
  }

  async function remove(id, expectedRevision = null) {
    const node = selectedNode.value?.id === id
      ? cloneGraphValue(selectedNode.value)
      : await getGraphNode(id)
    const result = await deleteGraphNode({
      id,
      expectedRevision: expectedRevision
        || node?.provenance?.sourceRevision
        || node?.sourceRevision,
    })
    closeInspector({ restore: false })
    await refresh({ quiet: true })
    clearTimeout(deletionTimer)
    lastDeletion.value = {
      ...result,
      title: node?.title || id,
    }
    deletionTimer = setTimeout(() => {
      lastDeletion.value = null
    }, 15_000)
    return result
  }

  async function undoDelete() {
    const deletion = lastDeletion.value
    if (!deletion?.undoToken) return null
    const restored = await restoreGraphNode(deletion.undoToken)
    clearTimeout(deletionTimer)
    lastDeletion.value = null
    await refresh({ quiet: true })
    await openNode(restored.id)
    return restored
  }

  function setSection(next) {
    if (!BUSINESS_SECTIONS.some(item => item.id === next)) return
    sectionViews.value[section.value] = view.value
    section.value = next
    view.value = sectionViews.value[next] || 'list'
    if (searchQuery.value.trim()) void search(searchQuery.value)
  }

  function setView(next) {
    view.value = next
    sectionViews.value[section.value] = next
  }

  async function setScopes(ids) {
    const mounted = new Set(scopes.value.map(scope => scope.id))
    const next = [...new Set((ids || []).filter(id => mounted.has(id)))]
    activeScopeIds.value = next.length ? next : scopes.value.map(scope => scope.id)
    eventOffset.value = 0
    await refresh()
  }

  async function toggleScope(id) {
    const active = new Set(activeScopeIds.value)
    if (active.has(id) && active.size > 1) active.delete(id)
    else active.add(id)
    await setScopes([...active])
  }

  function applyStatus(next) {
    const previousScopes = scopes.value
    const previouslyComposedAll = previousScopes.length === 0
      || previousScopes.every(scope => activeScopeIds.value.includes(scope.id))
    status.value = next || {
      scopes: [],
      nodeCount: 0,
      diagnosticCount: 0,
      graphRevision: 0,
    }
    const mounted = new Set(scopes.value.map(scope => scope.id))
    const retained = activeScopeIds.value.filter(id => mounted.has(id))
    activeScopeIds.value = previouslyComposedAll || !retained.length
      ? scopes.value.map(scope => scope.id)
      : retained
  }

  async function startListening() {
    if (unlisten) return
    unlisten = await listenForGraphChanges(() => {
      clearTimeout(refreshTimer)
      refreshTimer = setTimeout(() => void refresh({ quiet: true }), 80)
    })
  }

  function stop() {
    clearTimeout(refreshTimer)
    clearTimeout(deletionTimer)
    refreshTimer = null
    unlisten?.()
    unlisten = null
    searchGeneration += 1
    eventLoadGeneration += 1
    searching.value = false
    eventsLoading.value = false
  }

  function reset() {
    stop()
    status.value = null
    nodes.value = []
    diagnostics.value = []
    events.value = []
    eventTotal.value = 0
    eventOffset.value = 0
    eventsLoading.value = false
    activeScopeIds.value = []
    selectedNode.value = null
    selectedNeighbors.value = []
    inspectionHistory.value = []
    inspectionHistoryIndex.value = -1
    lastDeletion.value = null
    searchQuery.value = ''
    searchResults.value = []
    error.value = ''
    conflict.value = null
    projectRoot.value = ''
    teamRoot.value = ''
    workspaceProjectId.value = ''
    workspaceGraphScope.value = 'team'
  }

  async function reloadSelected() {
    const id = selectedNode.value?.id
    if (!id) return
    const [node, neighbors] = await Promise.all([
      getGraphNode(id),
      graphNeighbors(id, { scopeIds: activeScopeIds.value }),
    ])
    if (!node) {
      closeInspector({ restore: false })
      return
    }
    selectedNode.value = node
    selectedNeighbors.value = Array.isArray(neighbors) ? neighbors : []
  }

  function projectionState() {
    return {
      section: section.value,
      view: view.value,
      searchQuery: searchQuery.value,
    }
  }

  function restoreProjection(origin) {
    if (!origin) return
    section.value = origin.section || section.value
    view.value = origin.view || view.value
    if (origin.searchQuery !== searchQuery.value) void search(origin.searchQuery || '')
  }

  function defaultWriteScope(kind = '') {
    return defaultGraphWriteScope(scopes.value, kind, workspaceGraphScope.value)
  }

  function setWorkspaceConfiguration(config) {
    workspaceProjectId.value = String(config?.project || '').trim()
    workspaceGraphScope.value = config?.graphScope === 'workspace' ? 'workspace' : 'team'
  }

  function replaceSummary(node) {
    const summary = {
      id: node.id,
      kind: node.kind,
      title: node.title,
      summary: node.summary || '',
      tags: node.tags || [],
      status: node.properties?.status || node.properties?.projectStatus,
      priority: node.properties?.priority,
      dueDate: node.properties?.dueDate,
      projectId: node.relations?.find(edge => edge.relation === 'part_of')?.target
        || node.properties?.legacyProject,
      assigneeId: node.relations?.find(edge => edge.relation === 'assigned_to')?.target
        || node.properties?.legacyAssignee,
      waitingFor: node.properties?.waitingFor,
      remindAt: node.properties?.remindAt,
      snoozeUntil: node.properties?.snoozeUntil,
      rank: node.properties?.rank,
      slug: node.properties?.slug,
      needsDetail: Boolean(node.properties?.needsDetail),
      teamMember: Boolean(node.properties?.teamMember),
      deliverables: (Array.isArray(node.properties?.deliverables) ? node.properties.deliverables : [])
        .map(item => (typeof item === 'string' ? item : item?.path || ''))
        .filter(Boolean),
      relations: node.relations || [],
      updatedAt: node.updatedAt || '',
      scopeId: node.provenance?.scopeId,
      sourceRevision: node.provenance?.sourceRevision,
    }
    const index = nodes.value.findIndex(item => item.id === node.id)
    if (index >= 0) nodes.value.splice(index, 1, summary)
    else nodes.value.unshift(summary)
  }

  function historyTitle(node) {
    return String(node?.title || '').trim() || `Untitled ${node?.kind || 'object'}`
  }

  return {
    status,
    nodes,
    diagnostics,
    events,
    eventTotal,
    eventOffset,
    eventLimit,
    eventsLoading,
    loading,
    refreshing,
    error,
    conflict,
    activeScopeIds,
    section,
    view,
    sectionViews,
    searchQuery,
    searchResults,
    searching,
    selectedNode,
    selectedNeighbors,
    inspectionHistory,
    inspectionHistoryIndex,
    historyBack,
    historyForward,
    lastDeletion,
    projectRoot,
    teamRoot,
    workspaceProjectId,
    workspaceGraphScope,
    scopes,
    selectedScopes,
    visibleNodes,
    issues,
    projects,
    people,
    companies,
    scopeCounts,
    issueCounts,
    latestActors,
    start,
    refresh,
    loadEventPage,
    fetchEventsSince,
    search,
    prepareSearch,
    clearSearch,
    openNode,
    navigateHistory,
    closeInspector,
    create,
    update,
    moveScope,
    remove,
    undoDelete,
    setSection,
    setView,
    setScopes,
    toggleScope,
    stop,
    reset,
    defaultWriteScope,
    setWorkspaceConfiguration,
  }
})

function optimisticNode(node, patch) {
  const next = cloneGraphValue(node)
  for (const field of ['title', 'summary', 'body', 'tags', 'relations']) {
    if (patch[field] !== undefined) next[field] = cloneGraphValue(patch[field])
  }
  next.properties = { ...(next.properties || {}), ...(patch.setProperties || {}) }
  for (const key of patch.removeProperties || []) delete next.properties[key]
  return next
}

function cloneGraphValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function conflictValue(cause, id) {
  const message = errorMessage(cause)
  const data = cause?.data || cause?.cause?.data || null
  if (data?.conflict || /source changed|conflict/i.test(message)) {
    return { id, message, ...data }
  }
  return null
}

function errorMessage(cause) {
  return cause instanceof Error ? cause.message : String(cause || 'Business graph operation failed.')
}
