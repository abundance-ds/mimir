import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

export function openBusinessGraph(projectRoot) {
  return invoke('graph_open', {
    projectRoot: requiredPath(projectRoot, 'project graph root'),
  })
}

export function businessGraphStatus() {
  return invoke('graph_status')
}

export function getGraphNode(id) {
  return invoke('graph_get', { id: requiredId(id) })
}

export function graphSource(path) {
  return invoke('graph_source', { path: requiredPath(path, 'graph source') })
}

export function saveGraphSource(request) {
  return invoke('graph_source_save', { request })
}

export function serializeGraphSource(node) {
  return invoke('graph_source_serialize', { node })
}

export function queryGraph(query = {}) {
  return invoke('graph_query', { query: normalizeQuery(query) })
}

export function searchGraph(query, { scopeIds = [], kinds = [], projectIds = [], relatedTo = '', limit = 25, order, offset = 0 } = {}) {
  return invoke('graph_search', {
    query: String(query || '').trim(),
    scopeIds: normalizeStrings(scopeIds),
    ...(kinds.length ? { kinds: normalizeStrings(kinds) } : {}),
    ...(projectIds.length ? { projectIds: normalizeStrings(projectIds) } : {}),
    ...(relatedTo ? { relatedTo: requiredId(relatedTo) } : {}),
    ...(order ? { order } : {}),
    ...(offset ? { offset: Math.max(0, Math.floor(Number(offset) || 0)) } : {}),
    limit,
  })
}

export function lookupGraph(query, { scopeIds = [], limit = 12 } = {}) {
  return invoke('graph_lookup', {
    query: String(query || '').trim(),
    scopeIds: normalizeStrings(scopeIds),
    limit: Math.min(50, Math.max(1, Math.floor(Number(limit) || 12))),
  })
}

export function graphLinkTargets(ids, { scopeIds = [] } = {}) {
  return invoke('graph_link_targets', {
    ids: normalizeStrings(ids),
    scopeIds: normalizeStrings(scopeIds),
  })
}

export function graphReferences(id, { scopeIds = [] } = {}) {
  return invoke('graph_references', {
    id: requiredId(id),
    scopeIds: normalizeStrings(scopeIds),
  })
}

export function graphNeighbors(id, { scopeIds = [] } = {}) {
  return invoke('graph_neighbors', {
    id: requiredId(id),
    scopeIds: normalizeStrings(scopeIds),
  })
}

export function graphDiagnostics() {
  return invoke('graph_diagnostics')
}

export function graphEvents(query = {}) {
  return invoke('graph_events', {
    query: {
      scopeIds: normalizeStrings(query.scopeIds),
      ...(query.since ? { since: String(query.since) } : {}),
      offset: Math.max(0, Number(query.offset) || 0),
      limit: Math.min(500, Math.max(1, Number(query.limit) || 200)),
    },
  })
}

export function graphMigrationReport() {
  return invoke('graph_migration_report')
}

export function graphContext(request = {}) {
  return invoke('graph_context', {
    request: {
      ...(request.focusId ? { focusId: requiredId(request.focusId) } : {}),
      scopeIds: normalizeStrings(request.scopeIds),
      maxNodes: Math.min(40, Math.max(1, Number(request.maxNodes) || 12)),
    },
  })
}

export function refreshBusinessGraph() {
  return invoke('graph_refresh')
}

export function createGraphNode(create, actor = localGraphActor()) {
  return invoke('graph_create', { create, actor })
}

export function updateGraphNode(patch, actor = localGraphActor()) {
  return invoke('graph_update', { patch, actor })
}

export function moveGraphNodeScope(request, actor = localGraphActor()) {
  return invoke('graph_move_scope', {
    request: {
      id: requiredId(request.id),
      targetScopeId: requiredId(request.targetScopeId),
      ...(request.expectedRevision ? { expectedRevision: String(request.expectedRevision) } : {}),
      ...(request.expectedSourcePath ? { expectedSourcePath: String(request.expectedSourcePath) } : {}),
    },
    actor,
  })
}

export function deleteGraphNode(request, actor = localGraphActor()) {
  return invoke('graph_delete', { request, actor })
}

export function restoreGraphNode(undoToken, actor = localGraphActor()) {
  return invoke('graph_restore', {
    request: { undoToken: String(undoToken || '').trim() },
    actor,
  })
}

export function listenForGraphChanges(handler) {
  return listen('mimir://graph-changed', event => handler(event.payload))
}

function normalizeQuery(query) {
  return {
    ...(query.order ? { order: query.order } : {}),
    ...(query.projectIds?.length ? { projectIds: normalizeStrings(query.projectIds) } : {}),
    ...(query.relatedTo ? { relatedTo: requiredId(query.relatedTo) } : {}),
    scopeIds: normalizeStrings(query.scopeIds),
    kinds: normalizeStrings(query.kinds),
    tags: normalizeStrings(query.tags),
    ...(query.status ? { status: String(query.status) } : {}),
    offset: Math.max(0, Number(query.offset) || 0),
    limit: Math.min(500, Math.max(1, Number(query.limit) || 100)),
  }
}

function normalizeStrings(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(String).filter(Boolean))]
}

function requiredId(value) {
  const id = String(value || '').trim()
  if (!id) throw new Error('Graph node id is required.')
  return id
}

function requiredPath(value, label) {
  const path = String(value || '').trim()
  if (!path) throw new Error(`${label} is required.`)
  return path
}

function localGraphActor() {
  return {
    kind: 'human',
    id: 'local-human',
    label: 'You',
    initials: 'ME',
  }
}
