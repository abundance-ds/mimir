import { computed, ref, watch } from 'vue'
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
  refreshBusinessGraph,
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
  const changedSources = ref(null)
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
  const requestedNodeId = ref('')
  const selectedNeighbors = ref([])
  const lastDeletion = ref(null)
  const projectRoot = ref('')
  const teamRoot = ref('')
  const workspaceProjectId = ref('')
  const workspaceGraphScope = ref('team')
  const workspaceProject = ref(null)
  const graphKinds = ref([])
  const graphAvailableKinds = ref([])
  const graphOrder = ref({ sortBy: 'updated', direction: 'desc' })
  const graphSearchOrder = ref({ sortBy: 'relevance', direction: 'desc' })
  const graphProjectIds = ref([])
  const graphProjects = ref([])
  const graphItems = ref([])
  const graphTotal = ref(0)
  const searchHasMore = ref(false)
  const loadingMore = ref(false)
  const projectionLoading = ref(false)
  let projectionGeneration = 0
  let projectionRevision = null
  let started = false
  let unlisten = null
  let refreshTimer = null
  let searchGeneration = 0
  let eventLoadGeneration = 0
  let deletionTimer = null
  let lifecycleGeneration = 0
  let nodeLoadGeneration = 0
  let resettingSearchOrder = false

  const scopes = computed(() => status.value?.scopes || [])
  const selectedScopes = computed(() => (
    scopes.value.filter(scope => activeScopeIds.value.includes(scope.id))
  ))
  const workIndex = computed(() => workSearchIndex(nodes.value))
  const graphFilters = computed(() => {
    if (section.value !== 'all' || (view.value === 'changes' && !searchQuery.value.trim())) return {}
    return {
      order: { ...graphOrder.value },
      ...(graphKinds.value.length ? { kinds: graphKinds.value } : {}),
      ...(graphProjectIds.value.length ? { projectIds: graphProjectIds.value } : {}),
    }
  })
  const hasGraphFilters = computed(() => Object.keys(graphFilters.value).length > 0)
  const canLoadMore = computed(() => section.value === 'all' && (
    searchQuery.value.trim() ? searchHasMore.value : hasGraphFilters.value && graphItems.value.length < graphTotal.value
  ))
  const visibleNodes = computed(() => {
    if (section.value === 'work') {
      return filterWork(issues.value, workIndex.value, searchQuery.value)
    }
    const definition = BUSINESS_SECTIONS.find(item => item.id === section.value)
    const kinds = new Set(definition?.kinds || [])
    const items = searchQuery.value.trim() ? searchResults.value
      : hasGraphFilters.value ? graphItems.value : nodes.value
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
  // The first projection only needs the node query, so the change listener is
  // installed before it (no file change can slip through the mount window) and
  // diagnostics plus change history hydrate after the board is already on
  // screen instead of holding the loading state open.
  async function start(workspace, { mountedStatus = null } = {}) {
    const nextProject = String(workspace || '').trim()
    if (!nextProject) {
      reset()
      return
    }
    stop()
    const generation = lifecycleGeneration
    loading.value = true
    error.value = ''
    try {
      const workspaceConfig = cachedWorkspaceConfig(nextProject)
      workspaceProjectId.value = String(workspaceConfig?.project || '').trim()
      const mounted = mountedStatus || await openBusinessGraph(nextProject)
      if (generation !== lifecycleGeneration) return false
      const nextTeam = mounted?.scopes?.find(scope => scope.kind === 'team')?.root || ''
      workspaceGraphScope.value = workspaceConfig?.graphScope === 'workspace'
        ? 'workspace'
        : (nextTeam ? 'team' : 'workspace')
      projectRoot.value = nextProject
      teamRoot.value = nextTeam
      applyStatus(mounted)
      started = true
      eventOffset.value = 0
      await startListening(generation)
      if (generation !== lifecycleGeneration) return false
      await loadNodes(generation)
      if (generation !== lifecycleGeneration) return false
      await loadGraphProjection(generation)
      if (generation !== lifecycleGeneration) return false
      if (searchQuery.value.trim()) await search(searchQuery.value)
    } catch (cause) {
      if (generation !== lifecycleGeneration) return false
      error.value = errorMessage(cause)
      loading.value = false
      throw cause
    }
    loading.value = false
    try {
      await loadAuxiliary(generation)
    } catch (cause) {
      if (generation === lifecycleGeneration) error.value = errorMessage(cause)
    }
    return generation === lifecycleGeneration
  }

  async function refresh({ quiet = false, reconcile = false } = {}) {
    if (!status.value) return
    const generation = lifecycleGeneration
    if (!quiet) refreshing.value = true
    try {
      // Only the explicit Refresh action requests disk reconciliation.
      // Watcher, mutation, and scope updates already have a current index.
      if (reconcile) await refreshBusinessGraph()
      if (generation !== lifecycleGeneration) return
      await Promise.all([loadNodes(generation), loadAuxiliary(generation), loadGraphProjection(generation)])
      if (generation !== lifecycleGeneration) return
      error.value = ''
      if (searchQuery.value.trim()) await search(searchQuery.value)
      if (selectedNode.value?.id) await reloadSelected()
    } catch (cause) {
      if (generation !== lifecycleGeneration) return
      error.value = errorMessage(cause)
      if (!quiet) throw cause
    } finally {
      if (generation === lifecycleGeneration) refreshing.value = false
    }
  }

  async function loadNodes(generation = lifecycleGeneration) {
    const request = ++nodeLoadGeneration
    const result = await queryGraph({ scopeIds: activeScopeIds.value, limit: 500 })
    if (generation !== lifecycleGeneration || request !== nodeLoadGeneration) return
    nodes.value = Array.isArray(result?.items) ? result.items : []
    graphAvailableKinds.value = result?.availableKinds || [...new Set(nodes.value.map(node => node.kind).filter(Boolean))]
    status.value = {
      ...status.value,
      nodeCount: result?.total ?? nodes.value.length,
      graphRevision: result?.graphRevision ?? status.value?.graphRevision,
    }
    await Promise.all([
      loadWorkspaceProject(generation, request),
      loadGraphProjects(result, generation, request),
    ])
  }

  // This catalog is independent of table filters and includes projects past page one.
  async function loadGraphProjects(initial, generation, request) {
    if ((initial?.total ?? nodes.value.length) <= 500) {
      graphProjects.value = nodes.value.filter(node => node.kind === 'project')
      return
    }
    const items = []
    let revision = null
    do {
      const result = await queryGraph({ scopeIds: activeScopeIds.value, kinds: ['project'],
        order: { sortBy: 'title', direction: 'asc' }, offset: items.length, limit: 500 })
      if (generation !== lifecycleGeneration || request !== nodeLoadGeneration) return
      if (revision != null && result?.graphRevision != null && revision !== result.graphRevision) {
        items.length = 0
        revision = null
        continue
      }
      revision = result?.graphRevision ?? null
      const page = Array.isArray(result?.items) ? result.items : []
      items.push(...page)
      if (page.length < 500 || items.length >= result.total) break
    } while (true)
    graphProjects.value = items.filter(node => node.kind === 'project')
  }

  async function loadWorkspaceProject(generation = lifecycleGeneration, request = nodeLoadGeneration) {
    const id = workspaceProjectId.value
    const project = id ? (nodes.value.find(node => node.id === id) || await getGraphNode(id)) : null
    if (generation !== lifecycleGeneration || request !== nodeLoadGeneration || id !== workspaceProjectId.value) return
    workspaceProject.value = project?.kind === 'project' ? project : null
  }

  async function loadGraphProjection(generation = lifecycleGeneration, append = false) {
    const request = ++projectionGeneration
    if (!hasGraphFilters.value || !started) {
      graphItems.value = []
      graphTotal.value = 0
      projectionLoading.value = false
      return
    }
    if (append) loadingMore.value = true
    else projectionLoading.value = true
    try {
      const targetCount = append ? 500 : Math.max(500, graphItems.value.length)
      const offset = append ? graphItems.value.length : 0
      const items = []
      let result, revision = append ? projectionRevision : null
      do {
        const pageOffset = offset + items.length
        result = await queryGraph({
          scopeIds: activeScopeIds.value, ...graphFilters.value, limit: 500,
          ...(pageOffset ? { offset: pageOffset } : {}),
        })
        if (generation !== lifecycleGeneration || request !== projectionGeneration) return
        // Restart if entries moved between pages. A quiet refresh retains the
        // number of entries already shown, including entries opened past page one.
        if (revision != null && result?.graphRevision != null && revision !== result.graphRevision) {
          return await loadGraphProjection(generation)
        }
        revision = result?.graphRevision ?? null
        const page = Array.isArray(result?.items) ? result.items : []
        items.push(...page)
        if (page.length < 500 || offset + items.length >= (result?.total ?? offset + items.length)) break
      } while (items.length < targetCount)
      graphItems.value = append ? [...new Map([...graphItems.value, ...items].map(node => [node.id, node])).values()] : items
      graphTotal.value = items.length ? (result?.total ?? graphItems.value.length) : graphItems.value.length
      projectionRevision = revision
    } catch (cause) {
      if (generation === lifecycleGeneration && request === projectionGeneration) throw cause
    } finally {
      if (generation === lifecycleGeneration && request === projectionGeneration) {
        projectionLoading.value = false
        loadingMore.value = false
      }
    }
  }

  watch(() => JSON.stringify(graphFilters.value), () => {
    projectionGeneration += 1
    searchGeneration += 1
    graphItems.value = []
    searchResults.value = []
    graphTotal.value = 0
    searchHasMore.value = false
    loadingMore.value = false
    searching.value = false
    if (!started || loading.value) return
    void loadGraphProjection().catch(cause => { error.value = errorMessage(cause) })
    if (searchQuery.value.trim()) void search(searchQuery.value)
  }, { flush: 'sync' })

  watch(workspaceProjectId, () => {
    workspaceProject.value = null
    if (started && !loading.value) void loadWorkspaceProject().catch(cause => { error.value = errorMessage(cause) })
  }, { flush: 'sync' })

  watch(graphSearchOrder, () => {
    if (resettingSearchOrder) return
    searchGeneration += 1
    searchHasMore.value = false
    loadingMore.value = false
    if (started && searchQuery.value.trim()) void search(searchQuery.value)
  }, { deep: true, flush: 'sync' })

  async function loadAuxiliary(generation = lifecycleGeneration) {
    const [nextDiagnostics] = await Promise.all([
      graphDiagnostics(),
      loadEventPage(eventOffset.value),
    ])
    if (generation !== lifecycleGeneration) return
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

  async function search(value, { append = false } = {}) {
    const query = String(value || '')
    const targetCount = append || query !== searchQuery.value ? 100 : Math.max(100, searchResults.value.length)
    if (query !== searchQuery.value) resetSearchOrder()
    searchQuery.value = query
    const generation = ++searchGeneration
    if (!query.trim() || section.value === 'work') {
      searchResults.value = []
      searching.value = false
      searchHasMore.value = false
      loadingMore.value = false
      return
    }
    if (append) loadingMore.value = true
    else searching.value = true
    try {
      const offset = append ? searchResults.value.length : 0
      const items = []
      let hasMore = false
      do {
        const pageOffset = offset + items.length
        const results = await searchGraph(query, {
          scopeIds: activeScopeIds.value,
          ...graphFilters.value,
          order: { ...graphSearchOrder.value },
          limit: 100,
          ...(pageOffset ? { offset: pageOffset } : {}),
        })
        if (generation !== searchGeneration) return
        const page = (Array.isArray(results) ? results : []).map(result => result.node || result)
        items.push(...page)
        hasMore = page.length === 100
      } while (hasMore && items.length < targetCount)
      searchHasMore.value = hasMore
      searchResults.value = append ? [...new Map([...searchResults.value, ...items].map(node => [node.id, node])).values()] : items
    } catch (cause) {
      if (generation === searchGeneration) error.value = errorMessage(cause)
    } finally {
      if (generation === searchGeneration) {
        searching.value = false
        loadingMore.value = false
      }
    }
  }

  async function loadMoreGraphEntries() {
    if (!canLoadMore.value || loadingMore.value || searching.value || projectionLoading.value) return
    try {
      if (searchQuery.value.trim()) await search(searchQuery.value, { append: true })
      else await loadGraphProjection(lifecycleGeneration, true)
    } catch (cause) {
      error.value = errorMessage(cause)
    }
  }

  function resetSearchOrder() {
    // Set before the query, so changing the query never starts a stale request.
    if (graphSearchOrder.value.sortBy !== 'relevance' || graphSearchOrder.value.direction !== 'desc') {
      resettingSearchOrder = true
      graphSearchOrder.value = { sortBy: 'relevance', direction: 'desc' }
      resettingSearchOrder = false
    }
  }

  function prepareSearch(value) {
    if (String(value || '') !== searchQuery.value) resetSearchOrder()
    searchGeneration += 1
    searchHasMore.value = false
    loadingMore.value = false
    searchQuery.value = String(value || '')
    searchResults.value = []
    searching.value = false
  }

  function clearSearch() {
    searchGeneration += 1
    searchHasMore.value = false
    loadingMore.value = false
    searchQuery.value = ''
    searchResults.value = []
    searching.value = false
  }

  async function openNode(id) {
    const node = await getGraphNode(id)
    if (!node) throw new Error(`Graph node not found: ${id}`)
    const neighbors = await graphNeighbors(id, { scopeIds: activeScopeIds.value })
    selectedNode.value = node
    selectedNeighbors.value = Array.isArray(neighbors) ? neighbors : []
    return node
  }

  function closeInspector() {
    selectedNode.value = null
    selectedNeighbors.value = []
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

  async function remove(id, expectedRevision = null, expectedSourcePath = null) {
    const node = selectedNode.value?.id === id
      ? cloneGraphValue(selectedNode.value)
      : await getGraphNode(id)
    const result = await deleteGraphNode({
      id,
      ...(expectedSourcePath ? { expectedSourcePath } : {}),
      expectedRevision: expectedRevision
        || node?.provenance?.sourceRevision
        || node?.sourceRevision,
    })
    closeInspector()
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
    searchGeneration += 1
    searchResults.value = []
    searching.value = false
    projectionGeneration += 1
    graphItems.value = []
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

  async function startListening(generation) {
    if (unlisten) return
    const cleanup = await listenForGraphChanges(payload => {
      if (generation !== lifecycleGeneration) return
      changedSources.value = payload
      clearTimeout(refreshTimer)
      refreshTimer = setTimeout(() => void refresh({ quiet: true }), 80)
    })
    if (generation !== lifecycleGeneration) cleanup?.()
    else unlisten = cleanup
  }

  function stop() {
    started = false
    projectionGeneration += 1
    projectionLoading.value = false
    graphItems.value = []
    graphTotal.value = 0
    searchHasMore.value = false
    loadingMore.value = false
    searchResults.value = []
    workspaceProject.value = null
    graphProjects.value = []
    graphAvailableKinds.value = []
    lifecycleGeneration += 1
    nodeLoadGeneration += 1
    changedSources.value = null
    loading.value = false
    refreshing.value = false
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
    requestedNodeId.value = ''
    nodes.value = []
    diagnostics.value = []
    events.value = []
    eventTotal.value = 0
    eventOffset.value = 0
    eventsLoading.value = false
    activeScopeIds.value = []
    selectedNode.value = null
    selectedNeighbors.value = []
    lastDeletion.value = null
    searchQuery.value = ''
    searchResults.value = []
    error.value = ''
    conflict.value = null
    projectRoot.value = ''
    teamRoot.value = ''
    workspaceProjectId.value = ''
    graphProjectIds.value = []
    graphKinds.value = []
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
      closeInspector()
      return
    }
    selectedNode.value = node
    selectedNeighbors.value = Array.isArray(neighbors) ? neighbors : []
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
      createdAt: node.createdAt || '',
      updatedAt: node.updatedAt || '',
      scopeId: node.provenance?.scopeId,
      sourceRevision: node.provenance?.sourceRevision,
    }
    const index = nodes.value.findIndex(item => item.id === node.id)
    if (index >= 0) nodes.value.splice(index, 1, summary)
    else nodes.value.unshift(summary)
  }

  return {
    status,
    changedSources,
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
    requestedNodeId,
    selectedNeighbors,
    lastDeletion,
    projectRoot,
    teamRoot,
    workspaceProjectId,
    workspaceGraphScope,
    workspaceProject,
    graphKinds,
    graphAvailableKinds,
    graphOrder,
    graphSearchOrder,
    graphProjectIds,
    graphProjects,
    canLoadMore,
    loadingMore,
    loadMoreGraphEntries,
    projectionLoading,
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
