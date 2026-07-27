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
  openBusinessGraph,
  queryGraph,
  restoreGraphNode,
  searchGraph,
  updateGraphNode,
} from '../services/businessGraph.js'

export const BUSINESS_SECTIONS = Object.freeze([
  { id: 'now', label: 'Now', kinds: [] },
  { id: 'work', label: 'Work', kinds: ['issue'] },
  { id: 'projects', label: 'Projects', kinds: ['project'] },
  {
    id: 'knowledge',
    label: 'Knowledge',
    kinds: [
      'note', 'decision', 'record', 'study', 'evidence', 'dataset', 'analysis',
      'model', 'endpoint', 'publication', 'submission', 'research-question',
      'method', 'client-request',
    ],
  },
  { id: 'all', label: 'All', kinds: [] },
])

export const useBusinessGraphStore = defineStore('businessGraph', () => {
  const status = ref(null)
  const nodes = ref([])
  const diagnostics = ref([])
  const events = ref([])
  const eventTotal = ref(0)
  const loading = ref(false)
  const refreshing = ref(false)
  const error = ref('')
  const conflict = ref(null)
  const activeScopeIds = ref([])
  const section = ref('now')
  const view = ref('stream')
  const sectionViews = ref({
    now: 'stream',
    work: 'board',
    projects: 'portfolio',
    knowledge: 'list',
    all: 'list',
  })
  const searchQuery = ref('')
  const searchResults = ref([])
  const searching = ref(false)
  const selectedNode = ref(null)
  const selectedNeighbors = ref([])
  const contextTrail = ref([])
  const lastDeletion = ref(null)
  const projectRoot = ref('')
  const teamRoot = ref('')
  let unlisten = null
  let refreshTimer = null
  let searchGeneration = 0
  let deletionTimer = null

  const scopes = computed(() => status.value?.scopes || [])
  const selectedScopes = computed(() => (
    scopes.value.filter(scope => activeScopeIds.value.includes(scope.id))
  ))
  const visibleNodes = computed(() => {
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

  async function start(workspace, sharedTeamRoot = '') {
    const nextProject = String(workspace || '').trim()
    const nextTeam = String(sharedTeamRoot || '').trim()
    if (!nextProject) {
      reset()
      return
    }
    loading.value = true
    error.value = ''
    try {
      const mounted = await openBusinessGraph(nextProject, nextTeam)
      projectRoot.value = nextProject
      teamRoot.value = nextTeam
      applyStatus(mounted)
      await refresh()
      await startListening()
    } catch (cause) {
      error.value = errorMessage(cause)
      throw cause
    } finally {
      loading.value = false
    }
  }

  async function refresh({ quiet = false } = {}) {
    if (!status.value) return
    if (!quiet) refreshing.value = true
    try {
      const scopeIds = activeScopeIds.value
      const [result, nextDiagnostics, eventPage] = await Promise.all([
        queryGraph({ scopeIds, limit: 500 }),
        graphDiagnostics(),
        graphEvents({ scopeIds, limit: 500 }),
      ])
      nodes.value = Array.isArray(result?.items) ? result.items : []
      diagnostics.value = Array.isArray(nextDiagnostics) ? nextDiagnostics : []
      events.value = Array.isArray(eventPage?.items) ? eventPage.items : []
      eventTotal.value = Number(eventPage?.total) || events.value.length
      status.value = {
        ...status.value,
        nodeCount: result?.total ?? nodes.value.length,
        diagnosticCount: diagnostics.value.length,
        graphRevision: result?.graphRevision ?? status.value.graphRevision,
      }
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

  async function search(value) {
    const query = String(value || '')
    searchQuery.value = query
    const generation = ++searchGeneration
    if (!query.trim()) {
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
    const previous = contextTrail.value.at(-1)
    if (previous?.id !== node.id) {
      contextTrail.value.push({
        id: node.id,
        kind: node.kind,
        title: node.title,
        origin,
      })
      contextTrail.value = contextTrail.value.slice(-8)
    }
    return node
  }

  async function stepTo(index) {
    const item = contextTrail.value[index]
    if (!item) return
    contextTrail.value = contextTrail.value.slice(0, index + 1)
    restoreProjection(item.origin)
    const [node, neighbors] = await Promise.all([
      getGraphNode(item.id),
      graphNeighbors(item.id, { scopeIds: activeScopeIds.value }),
    ])
    selectedNode.value = node
    selectedNeighbors.value = Array.isArray(neighbors) ? neighbors : []
  }

  function closeInspector({ restore = true } = {}) {
    const origin = contextTrail.value[0]?.origin
    selectedNode.value = null
    selectedNeighbors.value = []
    contextTrail.value = []
    if (restore && origin) restoreProjection(origin)
  }

  async function create(create) {
    conflict.value = null
    const created = await createGraphNode({
      ...create,
      scopeId: create.scopeId || defaultWriteScope(),
    })
    await refresh({ quiet: true })
    await openNode(created.id)
    return created
  }

  async function update(patch) {
    const before = selectedNode.value ? cloneGraphValue(selectedNode.value) : null
    conflict.value = null
    if (selectedNode.value?.id === patch.id) {
      selectedNode.value = optimisticNode(selectedNode.value, patch)
    }
    try {
      const updated = await updateGraphNode({
        ...patch,
        expectedRevision: patch.expectedRevision
          || before?.provenance?.sourceRevision
          || before?.sourceRevision,
      })
      selectedNode.value = updated
      replaceSummary(updated)
      return updated
    } catch (cause) {
      if (before) selectedNode.value = before
      conflict.value = conflictValue(cause, patch.id)
      await refresh({ quiet: true })
      throw cause
    }
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
  }

  function setView(next) {
    view.value = next
    sectionViews.value[section.value] = next
  }

  async function setScopes(ids) {
    const mounted = new Set(scopes.value.map(scope => scope.id))
    const next = [...new Set((ids || []).filter(id => mounted.has(id)))]
    activeScopeIds.value = next.length ? next : scopes.value.map(scope => scope.id)
    await refresh()
  }

  async function toggleScope(id) {
    const active = new Set(activeScopeIds.value)
    if (active.has(id) && active.size > 1) active.delete(id)
    else active.add(id)
    await setScopes([...active])
  }

  function applyStatus(next) {
    status.value = next || {
      scopes: [],
      nodeCount: 0,
      diagnosticCount: 0,
      graphRevision: 0,
    }
    const mounted = new Set(scopes.value.map(scope => scope.id))
    const retained = activeScopeIds.value.filter(id => mounted.has(id))
    activeScopeIds.value = retained.length ? retained : scopes.value.map(scope => scope.id)
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
  }

  function reset() {
    stop()
    status.value = null
    nodes.value = []
    diagnostics.value = []
    events.value = []
    eventTotal.value = 0
    activeScopeIds.value = []
    selectedNode.value = null
    selectedNeighbors.value = []
    contextTrail.value = []
    lastDeletion.value = null
    error.value = ''
    conflict.value = null
    projectRoot.value = ''
    teamRoot.value = ''
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

  function defaultWriteScope() {
    return scopes.value.find(scope => scope.kind === 'project')?.id
      || scopes.value.find(scope => scope.kind === 'private')?.id
      || scopes.value[0]?.id
      || ''
  }

  function replaceSummary(node) {
    const summary = {
      id: node.id,
      kind: node.kind,
      title: node.title,
      summary: node.summary || '',
      tags: node.tags || [],
      status: node.properties?.status,
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

  return {
    status,
    nodes,
    diagnostics,
    events,
    eventTotal,
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
    contextTrail,
    lastDeletion,
    projectRoot,
    teamRoot,
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
    search,
    clearSearch,
    openNode,
    stepTo,
    closeInspector,
    create,
    update,
    remove,
    undoDelete,
    setSection,
    setView,
    setScopes,
    toggleScope,
    stop,
    reset,
    defaultWriteScope,
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
