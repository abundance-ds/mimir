import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

export function openBusinessGraph(projectRoot, teamRoot = '') {
  return invoke('graph_open', {
    projectRoot: requiredPath(projectRoot, 'project graph root'),
    teamRoot: optionalPath(teamRoot),
  })
}

export function businessGraphStatus() {
  return invoke('graph_status')
}

export function getGraphNode(id) {
  return invoke('graph_get', { id: requiredId(id) })
}

export function queryGraph(query = {}) {
  return invoke('graph_query', { query: normalizeQuery(query) })
}

export function searchGraph(query, { scopeIds = [], limit = 25 } = {}) {
  return invoke('graph_search', {
    query: String(query || '').trim(),
    scopeIds: normalizeStrings(scopeIds),
    limit,
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

function optionalPath(value) {
  const path = String(value || '').trim()
  return path || null
}

function localGraphActor() {
  return {
    kind: 'human',
    id: 'local-human',
    label: 'You',
    initials: 'ME',
  }
}
