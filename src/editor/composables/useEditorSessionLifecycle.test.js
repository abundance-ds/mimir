import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia, storeToRefs } from 'pinia'
import { ref } from 'vue'
import { useEditorSessionLifecycle } from './useEditorSessionLifecycle.js'
import { useFileStore } from '../../stores/files.js'
import { graphDocumentState } from '../../stores/graphDocuments.js'
import { graphSource } from '../../services/businessGraph.js'
import { loadSession, saveSession } from '../../services/session.js'

vi.mock('../../services/session.js', () => ({ loadSession: vi.fn(), saveSession: vi.fn() }))
vi.mock('../../services/businessGraph.js', () => ({ graphSource: vi.fn(), getGraphNode: vi.fn(), saveGraphSource: vi.fn(), updateGraphNode: vi.fn(), moveGraphNodeScope: vi.fn() }))
vi.mock('../../stores/businessGraph.js', () => ({ useBusinessGraphStore: () => ({ nodes: [] }) }))

const path = '/workspace/graph/note.md'
function document(title = 'Current', revision = 'current') {
  return {
    content: `---\ntitle: ${title}\n---\nBody.`, sourceRevision: revision, bodyFrom: 20,
    node: { id: 'note', kind: 'note', title, body: 'Body.', properties: {}, relations: [], tags: [],
      provenance: { scopeId: 'project:test', sourcePath: path, sourceRevision: revision } },
  }
}
function harness() {
  const files = useFileStore()
  const state = storeToRefs(files)
  const zoom = ref(100)
  const readFile = vi.fn().mockResolvedValue('Ordinary disk content')
  const onError = vi.fn()
  const lifecycle = useEditorSessionLifecycle({ fileManager: files, openFiles: state.openFiles,
    activeFileIndex: state.activeFileIndex, readFile, getZoomLevel: () => zoom.value,
    setZoomLevel: value => { zoom.value = value }, flushEditorContent: vi.fn(), onError })
  return { files, lifecycle, readFile, onError }
}
beforeEach(() => {
  setActivePinia(createPinia())
  vi.resetAllMocks()
  vi.useFakeTimers()
  graphSource.mockResolvedValue(document())
})
afterEach(() => vi.useRealTimers())

describe('Graph session hydration', () => {
  it('restores an ordinary draft with the disk text as its saved baseline', async () => {
    loadSession.mockResolvedValue({ openFiles: [{ path: '/ordinary.md', content: 'Unsaved draft', dirty: true }] })
    const { files, lifecycle } = harness()
    await lifecycle.hydrate()
    expect(files.currentFile).toMatchObject({ content: 'Unsaved draft', savedContent: 'Ordinary disk content', dirty: true })
    files.updateContent('Ordinary disk content')
    expect(files.currentFile.dirty).toBe(false)
  })

  it('loads a clean Details tab from the native source rather than an old persisted draft', async () => {
    loadSession.mockResolvedValue({ openFiles: [{ path, kind: 'graph', graph: { nodeId: 'note', restoreView: 'graph' } }], activeFileIndex: 0 })
    const { files, lifecycle, readFile } = harness()
    await lifecycle.hydrate()
    expect(files.currentFile).toMatchObject({ path, kind: 'graph', dirty: false, content: document().content, graph: { sourceRevision: 'current', draft: { title: 'Current' } } })
    expect(readFile).not.toHaveBeenCalled()
  })

  it('restores one dirty Details draft and its old revision even when a clean duplicate is active', async () => {
    const graph = graphDocumentState(document('Original', 'old'))
    graph.draft.body = 'Unsaved rich text'
    graph.version = 3
    loadSession.mockResolvedValue({ openFiles: [
      { path, kind: 'graph', graph, content: document('Original', 'old').content, dirty: true },
      { path, kind: 'text', graph: { nodeId: 'note', restoreView: 'text' } },
    ], activeFileIndex: 1 })
    const { files, lifecycle } = harness()
    await lifecycle.hydrate()
    expect(files.openFiles).toHaveLength(1)
    expect(files.currentFile).toMatchObject({ kind: 'graph', dirty: true, graph: { sourceRevision: 'old', draft: { body: 'Unsaved rich text' }, version: 3 } })
    await files.refreshGraphDocuments()
    expect(files.currentFile.graph.sourceRevision).toBe('old')
    expect(saveSession).toHaveBeenCalled()
  })

  it('keeps a dirty source buffer and its baseline while current YAML is malformed', async () => {
    const graph = graphDocumentState(document('Original', 'old'))
    loadSession.mockResolvedValue({ openFiles: [{ path, kind: 'text', graph, dirty: true, content: 'Unsaved raw source' }] })
    graphSource.mockResolvedValue({ node: null, content: '---\ntitle: [\n---\nMalformed.', sourceRevision: 'malformed', bodyFrom: 18 })
    const { files, lifecycle } = harness()
    await lifecycle.hydrate()
    expect(files.currentFile).toMatchObject({ kind: 'text', content: 'Unsaved raw source', dirty: true, graph: { sourceRevision: 'old', unavailable: false } })
  })

  it('opens a clean malformed source in source mode with its exact text', async () => {
    const source = { node: null, content: '---\ntitle: [\n---\nRecover me.', sourceRevision: 'invalid', bodyFrom: 18 }
    graphSource.mockResolvedValue(source)
    loadSession.mockResolvedValue({ openFiles: [{ path, kind: 'graph', graph: { nodeId: 'note' } }] })
    const { files, lifecycle } = harness()
    await lifecycle.hydrate()
    expect(files.currentFile).toMatchObject({ kind: 'text', content: source.content, dirty: false, graph: { node: null, sourceRevision: 'invalid' } })
  })

  it('retains missing or unmounted Graph paths and reconnects after the mount', async () => {
    const graph = graphDocumentState(document('Original', 'old'))
    graph.draft.body = 'Kept rich draft'
    loadSession.mockResolvedValue({ openFiles: [
      { path, kind: 'graph', graph, content: document().content, dirty: true },
      { path: '/team/graph/clean.md', kind: 'graph', graph: { nodeId: 'clean' } },
    ] })
    graphSource.mockResolvedValue(null)
    const { files, lifecycle, readFile } = harness()
    await lifecycle.hydrate()
    expect(files.openFiles).toHaveLength(2)
    expect(files.openFiles[0]).toMatchObject({ path, dirty: true, graph: { unavailable: true, sourceRevision: 'old', draft: { body: 'Kept rich draft' } } })
    expect(files.openFiles[1].graph.unavailable).toBe(true)
    expect(readFile).not.toHaveBeenCalled()
    graphSource.mockResolvedValue(document())
    await files.refreshGraphDocuments()
    expect(files.openFiles[0].graph.unavailable).toBe(false)
    expect(files.openFiles[0].graph.sourceRevision).toBe('old')
    expect(files.openFiles[1].graph.draft.title).toBe('Current')
  })

  it('retains a Graph draft when native reading fails, but keeps ordinary recovery unchanged', async () => {
    loadSession.mockResolvedValue({ openFiles: [
      { path, kind: 'text', graph: graphDocumentState(document('Original', 'old')), dirty: true, content: 'Graph draft' },
      { path: '/ordinary.md', dirty: true, content: 'Ordinary draft' },
    ] })
    graphSource.mockRejectedValue(new Error('Not mounted'))
    const { files, lifecycle, readFile } = harness()
    readFile.mockRejectedValue(new Error('Missing'))
    await lifecycle.hydrate()
    expect(files.openFiles[0]).toMatchObject({ path, content: 'Graph draft', graph: { unavailable: true } })
    expect(files.openFiles[1]).toMatchObject({ path: null, content: 'Ordinary draft', dirty: true })
  })

  it('classifies legacy Graph paths through Rust while ordinary Markdown remains ordinary', async () => {
    loadSession.mockResolvedValue({ openFiles: [{ path }, { path: '/ordinary.md' }] })
    const { files, lifecycle, readFile } = harness()
    await lifecycle.hydrate()
    expect(graphSource).toHaveBeenCalledTimes(1)
    expect(files.openFiles[0]).toMatchObject({ kind: 'text', graph: { sourceRevision: 'current' } })
    expect(files.openFiles[1].graph).toBeNull()
    expect(readFile).toHaveBeenCalledWith('/ordinary.md')
  })

  it('reclassifies legacy session source tabs when their Graph workspace mounts later', async () => {
    loadSession.mockResolvedValue({ openFiles: [{ path }, { path: '/workspace/graph/dirty.md', dirty: true, content: 'Older draft' }] })
    graphSource.mockResolvedValue(null)
    const { files, lifecycle } = harness()
    await lifecycle.hydrate()
    expect(files.openFiles.every(file => !file.graph)).toBe(true)
    graphSource.mockResolvedValue(document())
    await files.refreshGraphDocuments()
    expect(files.openFiles[0]).toMatchObject({ kind: 'text', dirty: false, content: document().content, graph: { sourceRevision: 'current' } })
    expect(files.openFiles[1]).toMatchObject({ kind: 'text', dirty: true, content: 'Older draft', graph: { sourceRevision: '' } })
  })
})
