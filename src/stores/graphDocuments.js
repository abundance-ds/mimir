import { graphSource, moveGraphNodeScope, saveGraphSource, serializeGraphSource, updateGraphNode } from '../services/businessGraph.js'
import { buildInspectorSave, hydrateInspectorDraft } from '../mimir/apps/business-graph/graphInspectorPersistence.js'
import { splitValues } from '../mimir/apps/business-graph/graphInspectorModel.js'

export const cloneGraphDocument = value => value == null ? value : JSON.parse(JSON.stringify(value))
export const GRAPH_UNAVAILABLE = 'This Graph source is unavailable. The draft is kept in this tab.'

// This only selects paths to ask Rust about. It never grants Graph behavior.
export const isGraphSourceCandidate = path => /\/graph\/[^/]+\.md$/.test(String(path || ''))

export function graphDocumentState(document) {
  const node = document.node ? cloneGraphDocument(document.node) : null
  const draft = {}
  if (node) hydrateInspectorDraft(draft, node)
  return {
    node, nodeId: node?.id || null, draft, sourceRevision: document.sourceRevision,
    bodyFrom: document.bodyFrom, version: 0, unavailable: false, closedUndo: null,
  }
}

export function restoredGraphState(graph) {
  return {
    node: null, nodeId: graph?.nodeId || graph?.node?.id || null, draft: {},
    sourceRevision: '', bodyFrom: 0, version: 0, unavailable: false,
    ...cloneGraphDocument(graph),
  }
}

export function graphExportContent(file, nodes = []) {
  if (file.kind === 'text') return Promise.resolve(file.content)
  if (!file.graph?.node) throw new Error('This Graph draft has no entry to export.')
  const node = cloneGraphDocument(file.graph.node)
  const { draft } = file.graph
  const { payload } = buildInspectorSave({ node, draft, nodes, validate: false,
    tags: splitValues(node.kind === 'issue' ? draft.labels : draft.tags) })
  for (const key of ['title', 'summary', 'body', 'tags', 'relations']) {
    if (payload[key] !== undefined) node[key] = payload[key]
  }
  Object.assign(node.properties, payload.setProperties)
  for (const key of payload.removeProperties) delete node.properties[key]
  return serializeGraphSource(node)
}

// The source path is checked by Rust under the same gate as Graph mutations.
// A Graph source must never fall through to the ordinary file writer.
export async function writeGraphDocument(file, snapshot, nodes = []) {
  const { graph, content, kind, path } = snapshot
  if (!path || graph.unavailable) throw new Error(GRAPH_UNAVAILABLE)
  if (kind === 'text') {
    return { path, document: await saveGraphSource({ path, content, expectedRevision: graph.sourceRevision }) }
  }
  if (!graph.node || !graph.draft.title?.trim()) throw new Error('Enter a title before saving this entry.')
  let payload, targetScopeId
  if (kind === 'undo-close') {
    const undo = graph.closedUndo
    if (!undo || undo.sourceRevision !== graph.sourceRevision || undo.sourcePath !== path) throw new Error('This close action can no longer be undone.')
    payload = {
      id: undo.nodeId, expectedRevision: undo.sourceRevision, expectedSourcePath: undo.sourcePath,
      setProperties: { status: undo.status, ...(undo.rank == null ? {} : { rank: undo.rank }) },
      removeProperties: undo.rank == null ? ['rank'] : [],
    }
  } else {
    const built = buildInspectorSave({
      node: graph.node, draft: graph.draft, nodes,
      tags: splitValues(graph.node.kind === 'issue' ? graph.draft.labels : graph.draft.tags),
    })
    payload = { ...built.payload, expectedRevision: graph.sourceRevision, expectedSourcePath: path }
    targetScopeId = built.targetScopeId
  }
  let node = await updateGraphNode(payload)
  // Retain the committed revision even if a later move or source read fails.
  // A retry must not repeat the body write against the preceding revision.
  file.graph.node = cloneGraphDocument(node)
  file.graph.sourceRevision = node.provenance.sourceRevision
  if (targetScopeId && targetScopeId !== node.provenance.scopeId) {
    node = await moveGraphNodeScope({
      id: node.id, targetScopeId, expectedRevision: node.provenance.sourceRevision,
      expectedSourcePath: node.provenance.sourcePath,
    })
    file.path = node.provenance.sourcePath
    file.graph.node = cloneGraphDocument(node)
    file.graph.sourceRevision = node.provenance.sourceRevision
  }
  const document = await graphSource(node.provenance.sourcePath)
  if (!document) throw new Error('The Graph source is no longer mounted. The draft is kept in this tab.')
  return { path: node.provenance.sourcePath, document }
}

export function graphSourceBodyStart(state) {
  const text = state.doc.toString()
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) || []
  // Rust's trim_end uses Unicode White_Space, including CR/LF and NEL.
  const delimiter = line => line.replace(/\p{White_Space}+$/u, '') === '---'
  if (!lines.length || !delimiter(lines[0])) return 0
  let offset = lines[0].length
  for (const line of lines.slice(1)) {
    offset += line.length
    if (delimiter(line)) return offset
  }
  // The source parser retains an incomplete header as text. Completion stays
  // suppressed until its closing fence exists, so typing metadata is safe.
  return state.doc.length
}
