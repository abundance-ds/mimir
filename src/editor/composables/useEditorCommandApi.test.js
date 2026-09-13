import { computed, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { useEditorCommandApi } from './useEditorCommandApi.js'

vi.mock('../../services/fileSystem.js', () => ({ readFile: vi.fn(async () => 'saved source') }))

function graphCommands() {
  const openFiles = ref([{ id: 1, path: '/graph/item.md', kind: 'graph', content: 'saved source', dirty: true, graph: { draft: { title: 'Unsaved title' } } }])
  const currentFile = computed(() => openFiles.value[0])
  const surface = {
    getContent: vi.fn(() => 'stale hidden editor'),
    getCursor: vi.fn(() => ({ line: 99 })),
    getSelection: vi.fn(() => ({ from: 0, to: 1 })),
    getView: vi.fn(),
    replaceRange: vi.fn(),
    scrollToPos: vi.fn(),
  }
  const fileManager = {
    get currentFile() { return currentFile.value },
    openFile: vi.fn(async () => currentFile.value),
    setGraphView: vi.fn(async file => { file.kind = 'text'; return true }),
    setActiveTab: vi.fn(),
    setFileReviews: vi.fn(),
  }
  const commands = useEditorCommandApi({
    fileManager,
    currentFile,
    openFiles,
    activeFileIndex: ref(0),
    editorTabs: ref([{ name: 'Entry' }]),
    editorSurfaceRef: ref(surface),
    editorShellRef: ref(null),
    commentMutations: { resolve: vi.fn() },
    flushEditorContent: vi.fn(),
    emitNavigate: vi.fn(),
    restoreEditorFocus: vi.fn(),
    activateDiff: vi.fn(),
    saveCurrentFile: vi.fn(),
    dismissEditorSurface: vi.fn(),
    closeEditorTab: vi.fn(),
    openSettings: vi.fn(),
    commentPrompt: vi.fn(),
  })
  return { commands, currentFile, fileManager, surface }
}

describe('Graph Editor command boundaries', () => {
  it('reports Graph Details without reading the hidden source selection or comments', () => {
    const { commands, surface, currentFile } = graphCommands()
    const active = commands.mimirActive({ includeContent: true })
    expect(active).toMatchObject({ kind: 'graph', content: 'saved source', contentSource: 'saved', graphDraft: { title: 'Unsaved title' }, cursor: null })
    active.graphDraft.title = 'Caller mutation'
    expect(currentFile.value.graph.draft.title).toBe('Unsaved title')
    expect(commands.mimirActive().graphDraft).toBeUndefined()
    expect(commands.mimirSelection()).toBeNull()
    expect(commands.mimirState().visibleRange).toBeNull()
    expect(commands.mimirComments()).toMatchObject({ comments: [], prompt: '' })
    for (const method of ['getContent', 'getCursor', 'getSelection', 'getView']) expect(surface[method]).not.toHaveBeenCalled()
  })

  it('refuses raw mutation commands while a rich Graph draft is active', () => {
    const { commands, currentFile, surface } = graphCommands()
    expect(() => commands.mimirSetContent('replacement')).toThrow('Open Source')
    expect(() => commands.mimirReplaceSelection('replacement')).toThrow('Open Source')
    expect(() => commands.mimirCommentAction('resolve', 'c1')).toThrow('Open Source')
    expect(() => commands.mimirReviewProposal({ id: 'p1', targetText: 'saved' })).toThrow('Open Source')
    expect(surface.replaceRange).not.toHaveBeenCalled()
    expect(currentFile.value.graph.draft.title).toBe('Unsaved title')
  })

  it('keeps ordinary opens in Details and enters Source only when requested', async () => {
    const { commands, fileManager, currentFile } = graphCommands()
    const entry = { openBehavior: 'text' }
    await commands.mimirOpen(currentFile.value.path, { entry })
    expect(fileManager.setGraphView).not.toHaveBeenCalled()
    expect(currentFile.value.kind).toBe('graph')
    await commands.mimirOpen(currentFile.value.path, { entry, source: true })
    expect(fileManager.setGraphView).toHaveBeenCalledWith(currentFile.value, 'source')
    expect(currentFile.value.kind).toBe('text')
  })

  it('rejects a delayed review from another source even if the text matches', () => {
    const { commands, currentFile, fileManager } = graphCommands()
    currentFile.value.kind = 'text'
    expect(() => commands.mimirReviewProposal({ id: 'late', path: '/graph/other.md', targetText: 'saved', replacement: 'changed' }))
      .toThrow('another document')
    expect(fileManager.setFileReviews).not.toHaveBeenCalled()
    expect(currentFile.value.content).toBe('saved source')
  })

  it('settles a rich draft before revealing a source offset', async () => {
    const { commands, fileManager, surface } = graphCommands()
    await commands.mimirReveal({ offset: 17 })
    expect(fileManager.setGraphView).toHaveBeenCalled()
    expect(surface.scrollToPos).toHaveBeenCalledWith(17, { select: true })
  })

  it('does not reveal stale source if a Graph draft cannot be saved', async () => {
    const { commands, fileManager, surface, currentFile } = graphCommands()
    fileManager.setGraphView.mockResolvedValue(false)
    await expect(commands.mimirReveal({ offset: 17 })).rejects.toThrow('Save the Graph draft')
    expect(surface.scrollToPos).not.toHaveBeenCalled()
    expect(currentFile.value.kind).toBe('graph')
  })
})
