import { computed, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const services = vi.hoisted(() => ({
  inspectWorkspaceEntry: vi.fn(),
  loadSession: vi.fn(),
  readFile: vi.fn(),
  saveSession: vi.fn(),
}))
const persistence = vi.hoisted(() => ({
  dispose: vi.fn(),
  flush: vi.fn(async () => {}),
}))

vi.mock('../../services/fileSystem.js', () => ({
  readFile: services.readFile,
}))
vi.mock('../../services/workspaceFileOperations.js', () => ({
  inspectWorkspaceEntry: services.inspectWorkspaceEntry,
}))
vi.mock('../../services/session.js', () => ({
  loadSession: services.loadSession,
  saveSession: services.saveSession,
}))
vi.mock('../sessionPersist.js', () => ({
  createSessionPersist: vi.fn(() => {
    persistence.dispose.flush = persistence.flush
    return persistence.dispose
  }),
  createSessionSnapshot: vi.fn((state) => ({
    openFiles: state.openFiles.value,
    activeFileIndex: state.activeFileIndex.value,
  })),
}))

import { useEditorCommandApi } from './useEditorCommandApi.js'
import { useEditorProposalLifecycle } from './useEditorProposalLifecycle.js'
import { useEditorSessionLifecycle } from './useEditorSessionLifecycle.js'

describe('Editor lifecycle controllers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    services.loadSession.mockResolvedValue(null)
    services.saveSession.mockResolvedValue()
    services.readFile.mockResolvedValue('# document')
    services.inspectWorkspaceEntry.mockResolvedValue({
      openBehavior: 'text',
      textReadable: true,
    })
  })

  it('owns the exposed editor command contract and proposal review activation', async () => {
    const files = ref([{
      id: 'file:1',
      path: '/w/a.md',
      content: 'hello world',
      dirty: false,
      kind: 'text',
    }])
    const activeFileIndex = ref(0)
    const currentFile = computed(() => files.value[activeFileIndex.value] || null)
    const replaceRange = vi.fn()
    const activateDiff = vi.fn()
    const emitNavigate = vi.fn()
    const fileManager = {
      get currentFile() {
        return currentFile.value
      },
      openFile: vi.fn(async (path, content, meta) => {
        files.value.push({ id: path, path, content, dirty: false, ...meta })
        activeFileIndex.value = files.value.length - 1
      }),
      setActiveTab: vi.fn(index => {
        activeFileIndex.value = index
      }),
      setFileReviews: vi.fn((file, reviews) => {
        file.reviews = reviews
      }),
    }
    const editorSurfaceRef = ref({
      getContent: () => currentFile.value.content,
      getCursor: () => ({ line: 1, column: 2 }),
      getSelection: () => ({ from: 0, to: 5, text: 'hello' }),
      replaceRange,
      scrollToPos: vi.fn(),
    })
    const commands = useEditorCommandApi({
      fileManager,
      currentFile,
      openFiles: files,
      activeFileIndex,
      editorTabs: computed(() => files.value.map(file => ({ name: file.path.split('/').at(-1) }))),
      editorSurfaceRef,
      editorShellRef: ref(document.createElement('div')),
      commentMutations: {},
      flushEditorContent: vi.fn(),
      emitNavigate,
      restoreEditorFocus: vi.fn(),
      activateDiff,
      saveCurrentFile: vi.fn(async () => true),
      dismissEditorSurface: vi.fn(async () => false),
      closeEditorTab: vi.fn(async () => true),
      openSettings: vi.fn(),
      commentPrompt: vi.fn(),
    })

    expect(commands.mimActive({ includeContent: true })).toMatchObject({
      path: '/w/a.md',
      content: 'hello world',
      cursor: { line: 1, column: 2 },
    })
    expect(commands.mimReplaceSelection('hi')).toEqual({
      from: 0,
      to: 2,
      replaced: 5,
    })
    expect(commands.mimReviewProposal({
      id: 'proposal:1',
      targetText: 'world',
      replacement: 'Mim',
    })).toEqual({
      proposalId: 'proposal:1',
      status: 'pending_review',
    })
    expect(activateDiff).toHaveBeenCalledWith(
      'hello world',
      'hello Mim',
      expect.objectContaining({ review: expect.any(Object) }),
    )

    await commands.mimOpen('/w/b.md', { preview: true })
    expect(fileManager.openFile).toHaveBeenCalledWith(
      '/w/b.md',
      '# document',
      expect.objectContaining({ kind: 'text', preview: true }),
    )
    expect(emitNavigate).toHaveBeenCalledWith({ path: '/w/b.md' })
  })

  it('hydrates once, creates the fallback inside the transaction, and owns persistence', async () => {
    const openFiles = ref([])
    const activeFileIndex = ref(0)
    const fileManager = {
      recentFiles: [],
      hasOpenFiles: false,
      hydrateSession: vi.fn(async callback => callback()),
      setRecentFiles: vi.fn(),
      newFile: vi.fn(() => {
        openFiles.value.push({ id: 'draft:1', path: '', content: '', dirty: false })
        fileManager.hasOpenFiles = true
      }),
      restorePath: vi.fn(),
      restoreDraft: vi.fn(),
      activateSessionEntry: vi.fn(),
    }
    const flushEditorContent = vi.fn()
    const lifecycle = useEditorSessionLifecycle({
      fileManager,
      openFiles,
      activeFileIndex,
      readFile: services.readFile,
      getZoomLevel: () => 1,
      setZoomLevel: vi.fn(),
      flushEditorContent,
      onError: vi.fn(),
    })

    lifecycle.beginMount()
    await lifecycle.hydrate()
    lifecycle.startPersistence()
    lifecycle.beforeUnload()
    await Promise.resolve()

    expect(fileManager.hydrateSession).toHaveBeenCalledTimes(1)
    expect(fileManager.newFile).toHaveBeenCalledTimes(1)
    expect(flushEditorContent).toHaveBeenCalledWith({ bridge: 'flush' })
    expect(persistence.flush).toHaveBeenCalledTimes(1)
    lifecycle.dispose()
    expect(persistence.dispose).toHaveBeenCalledTimes(1)
  })

  it('owns proposal event reconciliation and disposes its watchers', () => {
    const file = {
      path: '/w/a.md',
      content: 'hello world',
      dirty: true,
    }
    const fileManager = {
      openFiles: [file],
      activeFileIndex: 0,
      currentFile: file,
      setFileReviews: vi.fn((target, reviews) => {
        target.reviews = reviews
      }),
      clearFileReviews: vi.fn((target) => {
        delete target.reviews
      }),
      openFile: vi.fn(),
    }
    const diffStore = {
      active: false,
      reviewMeta: null,
      activate: vi.fn(() => {
        diffStore.active = true
      }),
      deactivate: vi.fn(() => {
        diffStore.active = false
      }),
    }
    const lifecycle = useEditorProposalLifecycle({
      fileManager,
      diffStore,
      openFiles: ref([file]),
      activeFileIndex: ref(0),
      currentEditorContent: () => file.content,
      flushEditorContent: vi.fn(),
      editorSurfaceRef: ref(null),
      activateDiff: vi.fn(),
      activateBatchDiff: vi.fn(),
    })

    lifecycle.onProposalsChanged({
      payload: [{
        id: 'proposal:1',
        path: '/w/a.md',
        targetText: 'world',
        replacement: 'Mim',
      }],
    })
    expect(fileManager.setFileReviews).toHaveBeenCalled()
    expect(diffStore.activate).toHaveBeenCalledWith(expect.objectContaining({
      original: 'hello world',
      modified: 'hello Mim',
    }))

    lifecycle.dispose()
  })
})
