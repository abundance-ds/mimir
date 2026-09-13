import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useFileStore } from './files.js'
import { getGraphNode, graphSource, moveGraphNodeScope, saveGraphSource, serializeGraphSource, updateGraphNode } from '../services/businessGraph.js'
import { saveFile, saveFileDialog } from '../services/fileSystem.js'

vi.mock('../services/fileSystem.js', () => ({ openFileDialog: vi.fn(), saveFileDialog: vi.fn(), saveFile: vi.fn() }))
vi.mock('../services/businessGraph.js', () => ({
  getGraphNode: vi.fn(), graphSource: vi.fn(), saveGraphSource: vi.fn(), serializeGraphSource: vi.fn(), updateGraphNode: vi.fn(), moveGraphNodeScope: vi.fn(),
}))
vi.mock('./businessGraph.js', () => ({ useBusinessGraphStore: () => ({ nodes: [] }) }))

const path = '/workspace/graph/note.md'
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))
function document({ targetPath = path, title = 'Note', body = 'Saved body', revision = 'r0', node = true, kind = 'note', properties = {} } = {}) {
  return {
    content: `---\nkind: ${kind}\ntitle: ${title}\n---\n${body}`,
    sourceRevision: revision, bodyFrom: 34,
    node: node ? {
      id: 'note', kind, title, summary: '', body, tags: [], relations: [], properties,
      provenance: { scopeId: 'project:test', sourcePath: targetPath, sourceRevision: revision },
    } : null,
  }
}
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve() }
let disk
let revision

beforeEach(() => {
  setActivePinia(createPinia())
  vi.resetAllMocks()
  vi.useFakeTimers()
  disk = new Map([[path, document()]])
  revision = 0
  serializeGraphSource.mockResolvedValue('Native formatted export')
  graphSource.mockImplementation(async target => clone(disk.get(target) || null))
  getGraphNode.mockImplementation(async id => clone([...disk.values()].find(value => value.node?.id === id)?.node || null))
  updateGraphNode.mockImplementation(async patch => {
    const current = disk.get(patch.expectedSourcePath)
    if (!current || current.sourceRevision !== patch.expectedRevision) throw new Error('Graph source changed')
    const properties = { ...current.node.properties, ...patch.setProperties }
    for (const key of patch.removeProperties || []) delete properties[key]
    const next = document({
      targetPath: patch.expectedSourcePath, title: patch.title ?? current.node.title,
      body: patch.body ?? current.node.body, kind: current.node.kind, properties, revision: `r${++revision}`,
    })
    disk.set(patch.expectedSourcePath, next)
    return clone(next.node)
  })
  saveGraphSource.mockImplementation(async request => {
    const current = disk.get(request.path)
    if (!current || current.sourceRevision !== request.expectedRevision) throw new Error('Graph source changed')
    const next = { ...clone(current), content: request.content, sourceRevision: `r${++revision}` }
    if (next.node) next.node.provenance.sourceRevision = next.sourceRevision
    disk.set(request.path, next)
    return clone(next)
  })
})
afterEach(() => vi.useRealTimers())

describe('Graph document lifecycle', () => {
  it('asks Rust only for candidate paths and leaves ordinary Markdown on its existing writer', async () => {
    const files = useFileStore()
    await files.openFile('/workspace/README.md', '[Note](mimir://graph/note)')
    expect(graphSource).not.toHaveBeenCalled()
    files.updateContent('Ordinary edit')
    await files.save()
    expect(saveFile).toHaveBeenCalledWith('/workspace/README.md', 'Ordinary edit')
    await files.openFile('/outside/graph/example.md', 'Not a mounted Graph source')
    expect(graphSource).toHaveBeenCalledWith('/outside/graph/example.md')
    expect(files.currentFile.graph).toBeUndefined()
  })

  it('classifies a Graph source without replacing the existing draft or mode when reopened', async () => {
    const files = useFileStore()
    await files.openFile(path, 'Old read outside Graph')
    const file = files.currentFile
    expect(file).toMatchObject({ kind: 'text', content: disk.get(path).content, graph: { sourceRevision: 'r0' } })
    files.updateContent('Unsaved raw text')
    await files.openGraphDocument(document(), { preview: true })
    expect(files.openFiles).toHaveLength(1)
    expect(files.currentFile.id).toBe(file.id)
    expect(file).toMatchObject({ kind: 'text', content: 'Unsaved raw text', dirty: true, preview: false })
  })

  it('deduplicates concurrent source opens after native classification', async () => {
    const files = useFileStore()
    const pending = deferred()
    graphSource.mockReturnValue(pending.promise)
    const first = files.openFile(path, 'First old read')
    const second = files.openFile(path, 'Second old read')
    pending.resolve(document())
    await Promise.all([first, second])
    expect(files.openFiles).toHaveLength(1)
    expect(files.currentFile.graph.node.id).toBe('note')
  })

  it('classifies a legacy candidate when it mounts and refuses to bless its older dirty buffer', async () => {
    const files = useFileStore()
    disk.delete(path)
    await files.openFile(path, 'Before mount')
    files.updateContent('Older unsaved buffer')
    const file = files.currentFile
    expect(file.graph).toBeFalsy()
    disk.set(path, document({ revision: 'mounted' }))
    await files.refreshGraphDocuments()
    expect(file).toMatchObject({ content: 'Older unsaved buffer', dirty: true, kind: 'text', graph: { sourceRevision: '' } })
    await expect(files.save(file)).rejects.toThrow('Graph source changed')
    expect(saveFile).not.toHaveBeenCalled()
  })

  it('asks native classification before saving a source opened before mount', async () => {
    const files = useFileStore()
    disk.delete(path)
    await files.openFile(path, 'Before mount')
    files.updateContent('Older unsaved buffer')
    disk.set(path, document({ revision: 'mounted' }))
    await expect(files.save()).rejects.toThrow('Graph source changed')
    expect(saveFile).not.toHaveBeenCalled()
  })

  it('serializes rich saves, advances their revision, and retains edits made during the first save', async () => {
    const files = useFileStore()
    await files.openGraphDocument(document())
    const file = files.currentFile
    const pending = deferred()
    const realUpdate = updateGraphNode.getMockImplementation()
    updateGraphNode.mockImplementationOnce(patch => pending.promise.then(() => realUpdate(patch)))
    file.graph.draft.body = 'First edit'
    files.graphDraftChanged(file)
    const first = files.save(file)
    file.graph.draft.body = 'Later edit'
    files.graphDraftChanged(file)
    const second = files.save(file)
    await flush()
    expect(updateGraphNode).toHaveBeenCalledTimes(1)
    pending.resolve()
    await first
    expect(file.graph.draft.body).toBe('Later edit')
    await second
    expect(updateGraphNode.mock.calls.map(([patch]) => [patch.body, patch.expectedRevision, patch.expectedSourcePath]))
      .toEqual([['First edit', 'r0', path], ['Later edit', 'r1', path]])
    expect(file).toMatchObject({ dirty: false, saveState: 'saved', graph: { sourceRevision: 'r2', draft: { body: 'Later edit' } } })
    expect(file.content).toContain('Later edit')
    expect(saveFile).not.toHaveBeenCalled()
  })

  it('keeps newer source text dirty after an older native write completes', async () => {
    const files = useFileStore()
    await files.openFile(path, '')
    const file = files.currentFile
    const pending = deferred()
    const realSave = saveGraphSource.getMockImplementation()
    saveGraphSource.mockImplementationOnce(request => pending.promise.then(() => realSave(request)))
    files.updateContent('First source edit')
    const writing = files.save(file)
    files.updateContent('Newer source edit')
    pending.resolve()
    await writing
    expect(file).toMatchObject({ content: 'Newer source edit', dirty: true, saveState: 'dirty', graph: { sourceRevision: 'r1' } })
    await files.save(file)
    expect(saveGraphSource).toHaveBeenLastCalledWith({ path, content: 'Newer source edit', expectedRevision: 'r1' })
    expect(file.dirty).toBe(false)
  })

  it('does not switch modes or replace text edited during the mode-switch read', async () => {
    const files = useFileStore()
    await files.openFile(path, '')
    const file = files.currentFile
    const pending = deferred()
    graphSource.mockReturnValueOnce(pending.promise)
    const switching = files.setGraphView(file, 'details')
    await flush()
    files.updateContent('Typing while the source is read')
    pending.resolve(document())
    expect(await switching).toBe(false)
    expect(file).toMatchObject({ kind: 'text', content: 'Typing while the source is read', dirty: true })
  })

  it('blocks every mode-switch entry point while a Graph review response is pending', async () => {
    const files = useFileStore()
    await files.openFile(path, '')
    const file = files.currentFile
    file.reviewPending = true
    await expect(files.setGraphView(file, 'details')).rejects.toThrow('Finish the review')
    expect(file.kind).toBe('text')
    file.reviewPending = false
    const pending = deferred()
    graphSource.mockReturnValueOnce(pending.promise)
    const switching = files.setGraphView(file, 'details')
    await flush()
    file.reviewPending = true
    pending.resolve(document())
    expect(await switching).toBe(false)
    expect(file.kind).toBe('text')
  })

  it('does not advance a source revision during a pending review and can refresh after it settles', async () => {
    const files = useFileStore()
    await files.openFile(path, '')
    const file = files.currentFile
    const pending = deferred()
    graphSource.mockReturnValueOnce(pending.promise)
    const refreshing = files.refreshGraphDocument(file)
    await flush()
    file.reviewPending = true
    disk.set(path, document({ title: 'External title', revision: 'external' }))
    pending.resolve(document({ title: 'External title', revision: 'external' }))
    expect(await refreshing).toBe(false)
    expect(file.graph.sourceRevision).toBe('r0')
    graphSource.mockClear()
    expect(await files.refreshGraphDocument(file)).toBe(false)
    expect(graphSource).not.toHaveBeenCalled()
    file.reviewPending = false
    expect(await files.refreshGraphDocument(file)).toBe(true)
    expect(file.graph.sourceRevision).toBe('external')
  })

  it('waits for rich writes before switching to the exact source snapshot', async () => {
    const files = useFileStore()
    await files.openGraphDocument(document())
    const file = files.currentFile
    file.graph.draft.body = 'Committed rich body'
    files.graphDraftChanged(file)
    const writing = files.save(file)
    const switching = files.setGraphView(file, 'source')
    await writing
    expect(await switching).toBe(true)
    expect(file).toMatchObject({ kind: 'text', content: disk.get(path).content, dirty: false, graph: { sourceRevision: 'r1' } })
  })

  it('preserves a failed Graph source draft and never falls through to saveFile', async () => {
    const files = useFileStore()
    await files.openFile(path, '')
    files.updateContent('Keep this draft')
    saveGraphSource.mockRejectedValue(new Error('Graph source changed'))
    await expect(files.save()).rejects.toThrow('Graph source changed')
    expect(files.currentFile).toMatchObject({ content: 'Keep this draft', dirty: true, saveState: 'failed', graph: { sourceRevision: 'r0' } })
    expect(saveFile).not.toHaveBeenCalled()
  })

  it('retains malformed source text and prevents a details view until it is repaired', async () => {
    const files = useFileStore()
    const malformed = { ...document({ node: false }), content: '---\ntitle: [unfinished\n---\nDraft.' }
    disk.set(path, malformed)
    await files.openFile(path, '')
    expect(files.currentFile.graph.node).toBeNull()
    await expect(files.setGraphView(files.currentFile, 'details')).rejects.toThrow('Correct the Markdown properties')
    expect(files.currentFile).toMatchObject({ kind: 'text', content: malformed.content })
  })

  it('rehydrates clean tabs but preserves the baseline and draft of dirty tabs', async () => {
    const files = useFileStore()
    await files.openGraphDocument(document())
    const file = files.currentFile
    disk.set(path, document({ title: 'External title', revision: 'external-1' }))
    await files.refreshGraphDocuments()
    expect(file.graph.draft.title).toBe('External title')
    file.graph.draft.body = 'Unsaved rich draft'
    files.graphDraftChanged(file)
    disk.set(path, document({ title: 'Another external title', revision: 'external-2' }))
    await files.refreshGraphDocuments()
    expect(file.graph.sourceRevision).toBe('external-1')
    expect(file.graph.draft.body).toBe('Unsaved rich draft')
    await expect(files.save(file)).rejects.toThrow('Graph source changed')
  })

  it('keeps the current clean draft object when a source event does not change its revision', async () => {
    const files = useFileStore()
    await files.openGraphDocument(document())
    const file = files.currentFile
    const graph = file.graph
    expect(await files.refreshGraphDocument(file)).toBe(false)
    expect(file.graph).toBe(graph)
    file.graph.unavailable = true
    expect(await files.refreshGraphDocument(file)).toBe(true)
    expect(file.graph.unavailable).toBe(false)
  })

  it('reads only affected source tabs for path events and all candidates for a mount refresh', async () => {
    const files = useFileStore()
    const otherPath = '/workspace/graph/other.md'
    disk.set(otherPath, document({ targetPath: otherPath }))
    await files.openFile(path, '')
    await files.openFile(otherPath, '')
    await files.openFile('/workspace/ordinary.md', 'Ordinary')
    graphSource.mockClear()
    await files.refreshGraphDocuments({ paths: [path] })
    expect(graphSource.mock.calls).toEqual([[path]])
    graphSource.mockClear()
    await files.refreshGraphDocuments()
    expect(graphSource.mock.calls.map(([path]) => path)).toEqual([path, otherPath])
  })

  it('pauses delayed Graph saves through a close decision and resumes only after cancel', async () => {
    const files = useFileStore()
    await files.openGraphDocument(document())
    const file = files.currentFile
    file.graph.draft.body = 'Keep until the close decision'
    files.graphDraftChanged(file)
    files.pauseGraphSave(file)
    files.graphDraftChanged(file)
    await vi.advanceTimersByTimeAsync(2000)
    expect(updateGraphNode).not.toHaveBeenCalled()
    files.resumeGraphSave(file)
    await vi.advanceTimersByTimeAsync(900)
    expect(updateGraphNode).toHaveBeenCalledTimes(1)
    expect(file.dirty).toBe(false)
    file.graph.draft.body = 'Discard this draft'
    files.graphDraftChanged(file)
    files.pauseGraphSave(file)
    files.closeFile(files.activeFileIndex)
    await vi.advanceTimersByTimeAsync(2000)
    expect(updateGraphNode).toHaveBeenCalledTimes(1)
  })

  it('records and undoes an issue close with the confirmed source revision and previous rank', async () => {
    const files = useFileStore()
    const issue = document({ kind: 'issue', properties: { status: 'planned', rank: 'a1' } })
    disk.set(path, issue)
    await files.openGraphDocument(issue)
    const file = files.currentFile
    file.graph.draft.status = 'done'
    files.graphDraftChanged(file)
    await files.save(file)
    expect(file.graph.closedUndo).toEqual({ nodeId: 'note', status: 'planned', rank: 'a1', sourcePath: path, sourceRevision: 'r1' })
    expect(await files.refreshGraphDocument(file)).toBe(false)
    expect(await files.undoGraphClose(file)).toBe(true)
    expect(updateGraphNode).toHaveBeenLastCalledWith({
      id: 'note', expectedRevision: 'r1', expectedSourcePath: path,
      setProperties: { status: 'planned', rank: 'a1' }, removeProperties: [],
    })
    expect(file).toMatchObject({ dirty: false, graph: { sourceRevision: 'r2', draft: { status: 'planned' }, closedUndo: null } })
  })

  it('keeps a failed close undo retryable but rejects undo when a draft is dirty', async () => {
    const files = useFileStore()
    const issue = document({ kind: 'issue', properties: { status: 'backlog' } })
    disk.set(path, issue)
    await files.openGraphDocument(issue)
    const file = files.currentFile
    file.graph.draft.status = 'cancelled'
    files.graphDraftChanged(file)
    await files.save(file)
    updateGraphNode.mockRejectedValueOnce(new Error('Temporary write failure'))
    await expect(files.undoGraphClose(file)).rejects.toThrow('Temporary write failure')
    expect(file.dirty).toBe(false)
    expect(file.graph.closedUndo.sourceRevision).toBe('r1')
    await files.undoGraphClose(file)
    expect(updateGraphNode).toHaveBeenLastCalledWith(expect.objectContaining({ removeProperties: ['rank'], setProperties: { status: 'backlog' } }))
    file.graph.draft.status = 'done'
    files.graphDraftChanged(file)
    await files.save(file)
    file.graph.draft.title = 'Pending title'
    files.graphDraftChanged(file)
    const calls = updateGraphNode.mock.calls.length
    await expect(files.undoGraphClose(file)).rejects.toThrow('Save this draft')
    expect(updateGraphNode).toHaveBeenCalledTimes(calls)
  })

  it('retains edits made during Undo and applies the reopened status to their next save', async () => {
    const files = useFileStore()
    const issue = document({ kind: 'issue', properties: { status: 'planned' } })
    disk.set(path, issue)
    await files.openGraphDocument(issue)
    const file = files.currentFile
    file.graph.draft.status = 'done'
    files.graphDraftChanged(file)
    await files.save(file)
    const pending = deferred()
    const realUpdate = updateGraphNode.getMockImplementation()
    updateGraphNode.mockImplementationOnce(patch => pending.promise.then(() => realUpdate(patch)))
    const undoing = files.undoGraphClose(file)
    await flush()
    file.graph.draft.title = 'Title typed during Undo'
    files.graphDraftChanged(file)
    const queuedSave = files.save(file)
    pending.resolve()
    expect(await undoing).toBe(false)
    expect(file).toMatchObject({ dirty: true, graph: { draft: { title: 'Title typed during Undo', status: 'planned' }, closedUndo: null } })
    await queuedSave
    expect(disk.get(path).node).toMatchObject({ title: 'Title typed during Undo', properties: { status: 'planned' } })
  })

  it('clears close Undo after another source revision replaces the confirmed close', async () => {
    const files = useFileStore()
    const issue = document({ kind: 'issue', properties: { status: 'backlog' } })
    disk.set(path, issue)
    await files.openGraphDocument(issue)
    const file = files.currentFile
    file.graph.draft.status = 'done'
    files.graphDraftChanged(file)
    await files.save(file)
    disk.set(path, document({ kind: 'issue', revision: 'external', properties: { status: 'done' } }))
    await files.refreshGraphDocument(file)
    expect(file.graph.closedUndo).toBeNull()
    await expect(files.undoGraphClose(file)).rejects.toThrow('can no longer be undone')
  })

  it('discards a slow refresh that predates a successful save', async () => {
    const files = useFileStore()
    await files.openGraphDocument(document())
    const file = files.currentFile
    const pending = deferred()
    graphSource.mockReturnValueOnce(pending.promise)
    const refreshing = files.refreshGraphDocument(file)
    await flush()
    file.graph.draft.body = 'Fresh saved body'
    files.graphDraftChanged(file)
    await files.save(file)
    pending.resolve(document())
    expect(await refreshing).toBe(false)
    expect(file.graph.sourceRevision).toBe('r1')
    expect(file.graph.draft.body).toBe('Fresh saved body')
  })

  it('keeps deleted or unmounted drafts and reconnects them without inventing a new baseline', async () => {
    const files = useFileStore()
    await files.openFile(path, '')
    const file = files.currentFile
    files.updateContent('Recoverable draft')
    disk.delete(path)
    await files.refreshGraphDocuments()
    expect(file).toMatchObject({ path, dirty: true, content: 'Recoverable draft', saveState: 'failed', graph: { unavailable: true, sourceRevision: 'r0' } })
    await expect(files.save(file)).rejects.toThrow('unavailable')
    disk.set(path, document({ revision: 'restored-externally' }))
    await files.refreshGraphDocuments()
    expect(file.graph.unavailable).toBe(false)
    expect(file.graph.sourceRevision).toBe('r0')
    await expect(files.save(file)).rejects.toThrow('Graph source changed')
  })

  it('rebinds the same tab only for a move confirmed by native paths and identity', async () => {
    const files = useFileStore()
    await files.openGraphDocument(document())
    const file = files.currentFile
    const id = file.id
    const movedPath = '/team/graph/note.md'
    disk.delete(path)
    disk.set(movedPath, document({ targetPath: movedPath, revision: 'moved' }))
    await files.refreshGraphDocuments()
    expect(file.path).toBe(path)
    expect(file.graph.unavailable).toBe(true)
    await files.refreshGraphDocuments({ paths: [path, movedPath] })
    expect(files.openFiles).toHaveLength(1)
    expect(file).toMatchObject({ id, path: movedPath, graph: { unavailable: false, sourceRevision: 'moved' } })
  })

  it('transfers a Graph draft and refuses transfer while a save is pending', async () => {
    const files = useFileStore()
    await files.openGraphDocument(document())
    const file = files.currentFile
    file.graph.draft.body = 'Transfer this draft'
    files.graphDraftChanged(file)
    files.newFile()
    const transfer = files.removeTabForTransfer(0)
    expect(transfer.graph.draft.body).toBe('Transfer this draft')
    files.addFileFromTransfer(transfer)
    const restored = files.currentFile
    expect(restored).toMatchObject({ dirty: true, kind: 'graph', graph: { sourceRevision: 'r0', draft: { body: 'Transfer this draft' } } })
    const pending = deferred()
    updateGraphNode.mockReturnValueOnce(pending.promise)
    const writing = files.save(restored)
    expect(files.removeTabForTransfer(files.activeFileIndex)).toBeNull()
    pending.resolve(document().node)
    await writing
  })

  it('exports a rich Graph draft without changing the original tab identity or draft', async () => {
    const files = useFileStore()
    await files.openGraphDocument(document())
    const file = files.currentFile
    file.graph.draft.body = 'Exported body'
    files.graphDraftChanged(file)
    saveFileDialog.mockResolvedValue('/exports/note.md')
    await files.saveAs(file)
    expect(saveFile).toHaveBeenCalledWith('/exports/note.md', 'Native formatted export')
    expect(serializeGraphSource).toHaveBeenCalledWith(expect.objectContaining({ body: 'Exported body' }))
    expect(updateGraphNode).not.toHaveBeenCalled()
    expect(file.path).toBe(path)
    expect(file.kind).toBe('graph')
    expect(file.dirty).toBe(true)
  })

  it('exports a deleted rich source with every draft field and unknown property retained', async () => {
    const files = useFileStore()
    const issue = document({ kind: 'issue', properties: { status: 'planned', custom: { retained: true }, priority: 'urgent' } })
    disk.set(path, issue)
    await files.openGraphDocument(issue)
    const file = files.currentFile
    file.graph.draft.title = 'Recovered title'
    file.graph.draft.status = 'done'
    file.graph.draft.body = 'Recovered [Jon](mimir://graph/jon).'
    files.graphDraftChanged(file)
    disk.delete(path)
    await files.refreshGraphDocuments()
    saveFileDialog.mockResolvedValue('/exports/recovered.md')
    await files.saveAs(file)
    expect(serializeGraphSource).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Recovered title', body: 'Recovered [Jon](mimir://graph/jon).',
      properties: expect.objectContaining({ custom: { retained: true }, status: 'done', priority: 'urgent' }),
    }))
    expect(saveFile).toHaveBeenCalledWith('/exports/recovered.md', 'Native formatted export')
    expect(file).toMatchObject({ path, dirty: true, graph: { unavailable: true, sourceRevision: 'r0', draft: { title: 'Recovered title' } } })
    expect(updateGraphNode).not.toHaveBeenCalled()
  })

  it('exports an unavailable raw source as exact user text without writing its old path', async () => {
    const files = useFileStore()
    await files.openFile(path, '')
    const file = files.currentFile
    files.updateContent('---\r\ntitle: [incomplete\r\nUnknown raw draft  \r\n')
    disk.delete(path)
    await files.refreshGraphDocuments()
    saveFileDialog.mockResolvedValue('/exports/raw.md')
    await files.saveAs(file)
    expect(saveFile).toHaveBeenCalledWith('/exports/raw.md', file.content)
    expect(saveGraphSource).not.toHaveBeenCalled()
    expect(serializeGraphSource).not.toHaveBeenCalled()
    expect(file).toMatchObject({ path, dirty: true, graph: { unavailable: true } })
  })

  it('does not change tabs when a Graph open request is stale', async () => {
    const files = useFileStore()
    await files.openFile('/ordinary.md', 'Keep this tab')
    const file = files.currentFile
    expect(await files.openGraphDocument(document(), { isCurrent: () => false })).toBeNull()
    expect(files.openFiles).toEqual([file])
    expect(files.currentFile).toBe(file)
  })

  it('does not reuse a Graph preview while its source review is pending', async () => {
    const files = useFileStore()
    await files.openGraphDocument(document(), { preview: true })
    const reviewed = files.currentFile
    reviewed.reviewPending = true
    const otherPath = '/workspace/graph/other.md'
    await files.openGraphDocument(document({ targetPath: otherPath }), { preview: true })
    expect(files.openFiles).toHaveLength(2)
    expect(reviewed.path).toBe(path)
    files.setFileReviews(reviewed, [{ id: 'proposal' }])
    expect(reviewed.preview).toBe(false)
    reviewed.reviewPending = false
    const thirdPath = '/workspace/graph/third.md'
    await files.openGraphDocument(document({ targetPath: thirdPath }), { preview: true })
    expect(files.openFiles).toHaveLength(2)
    expect(reviewed.path).toBe(path)
  })

  it('saves ordinary Markdown into an existing Graph destination through the native source guard', async () => {
    const files = useFileStore()
    await files.openFile(path, '')
    await files.openFile('/ordinary.md', 'Ordinary text')
    const file = files.currentFile
    files.updateContent('Exact source replacement')
    saveFileDialog.mockResolvedValue(path)
    expect(await files.saveAs(file)).toBe(true)
    expect(saveGraphSource).toHaveBeenCalledWith({ path, content: 'Exact source replacement', expectedRevision: 'r0' })
    expect(saveFile).not.toHaveBeenCalled()
    expect(files.openFiles).toHaveLength(1)
    expect(file).toMatchObject({ path, kind: 'text', content: 'Exact source replacement', graph: { sourceRevision: 'r1' } })
  })

  it('rejects Save As into a Graph destination with another unsaved draft', async () => {
    const files = useFileStore()
    await files.openGraphDocument(document())
    const graphFile = files.currentFile
    graphFile.graph.draft.body = 'Existing rich draft'
    files.graphDraftChanged(graphFile)
    await files.openFile('/ordinary.md', 'Replacement')
    saveFileDialog.mockResolvedValue(path)
    await expect(files.saveAs()).rejects.toThrow('unsaved draft in another tab')
    expect(files.currentFile.path).toBe('/ordinary.md')
    expect(graphFile.graph.draft.body).toBe('Existing rich draft')
    expect(saveFile).not.toHaveBeenCalled()
    expect(saveGraphSource).not.toHaveBeenCalled()
  })

  it.each(['before lookup', 'during lookup'])('keeps a clean Graph destination open when its review is pending %s', async phase => {
    const files = useFileStore()
    await files.openFile(path, '')
    const target = files.currentFile
    await files.openFile('/ordinary.md', 'Replacement')
    const original = files.currentFile
    saveFileDialog.mockResolvedValue(path)
    const pending = deferred()
    if (phase === 'before lookup') target.reviewPending = true
    else graphSource.mockReturnValueOnce(pending.promise)
    const saving = files.saveAs(original)
    if (phase === 'during lookup') {
      await flush()
      target.reviewPending = true
      pending.resolve(document())
    }
    await expect(saving).rejects.toThrow('Finish the review in the destination tab')
    expect(files.openFiles).toEqual([target, original])
    expect(target).toMatchObject({ path, dirty: false, reviewPending: true, graph: { sourceRevision: 'r0' } })
    expect(original.path).toBe('/ordinary.md')
    expect(saveFile).not.toHaveBeenCalled()
    expect(saveGraphSource).not.toHaveBeenCalled()
  })

  it('classifies a newly created Graph source after ordinary Save As', async () => {
    const files = useFileStore()
    const newPath = '/workspace/graph/new.md'
    await files.openFile('/ordinary.md', 'New source')
    saveFileDialog.mockResolvedValue(newPath)
    saveFile.mockImplementation(async (targetPath, content) => {
      disk.set(targetPath, { ...document({ targetPath }), content })
    })
    await files.saveAs()
    expect(saveFile).toHaveBeenCalledWith(newPath, 'New source')
    expect(files.currentFile).toMatchObject({ path: newPath, kind: 'text', content: 'New source', dirty: false, graph: { sourceRevision: 'r0' } })
  })
})
