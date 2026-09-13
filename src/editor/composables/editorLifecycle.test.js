import { computed, nextTick, ref } from 'vue'
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
      getView: () => ({
        state: {
          doc: {
            lines: 3,
            line: number => [
              { from: 0, to: 5 },
              { from: 6, to: 11 },
              { from: 12, to: 17 },
            ][number - 1],
          },
        },
      }),
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

    expect(commands.mimirActive({ includeContent: true })).toMatchObject({
      path: '/w/a.md',
      content: 'hello world',
      cursor: { line: 1, column: 2 },
    })
    expect(commands.mimirReplaceSelection('hi')).toEqual({
      from: 0,
      to: 2,
      replaced: 5,
    })
    expect(commands.mimirReviewProposal({
      id: 'proposal:1',
      targetText: 'world',
      replacement: 'Mimir',
    })).toEqual({
      proposalId: 'proposal:1',
      status: 'pending_review',
    })
    expect(activateDiff).toHaveBeenCalledWith(
      'hello world',
      'hello Mimir',
      expect.objectContaining({ review: expect.any(Object) }),
    )

    await commands.mimirOpen('/w/b.md', { preview: true })
    expect(fileManager.openFile).toHaveBeenCalledWith(
      '/w/b.md',
      '# document',
      expect.objectContaining({ kind: 'text', preview: true }),
    )
    expect(emitNavigate).toHaveBeenCalledWith({ path: '/w/b.md' })

    await commands.mimirReveal({ path: '/w/a.md', line: 2, column: 3 })
    expect(fileManager.setActiveTab).toHaveBeenCalledWith(0)
    expect(editorSurfaceRef.value.scrollToPos).toHaveBeenLastCalledWith(8, { select: true })

    await commands.mimirReveal({ path: '/w/match.md', line: 3, column: 2, preview: true })
    expect(fileManager.openFile).toHaveBeenLastCalledWith('/w/match.md', '# document', expect.objectContaining({ preview: true }))
    expect(editorSurfaceRef.value.scrollToPos).toHaveBeenLastCalledWith(13, { select: true })
    await commands.mimirReveal({ path: '/w/match.md', line: 3, column: 2, preview: false })
    expect(fileManager.openFile).toHaveBeenLastCalledWith('/w/match.md', '# document', expect.objectContaining({ preview: false }))
    expect(editorSurfaceRef.value.scrollToPos).toHaveBeenLastCalledWith(13, { select: true })

    files.value.push({ id: 'svg', path: '/w/logo.svg', kind: 'text', content: '<svg/>', previewView: { scale: 2 } })
    await commands.mimirReveal({ path: '/w/logo.svg' })
    expect(currentFile.value.previewView.sourceMode).toBeUndefined()
    await commands.mimirReveal({ path: '/w/logo.svg', line: 2, column: 3 })
    expect(currentFile.value.previewView).toEqual({ scale: 2, sourceMode: true })
    expect(editorSurfaceRef.value.scrollToPos).toHaveBeenLastCalledWith(8, { select: true })
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
        replacement: 'Mimir',
      }],
    })
    expect(fileManager.setFileReviews).toHaveBeenCalled()
    expect(diffStore.activate).toHaveBeenCalledWith(expect.objectContaining({
      original: 'hello world',
      modified: 'hello Mimir',
    }))

    lifecycle.dispose()
  })

  it('reconciles reviews by proposal id instead of clearing on any path miss', () => {
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
    const p1 = { id: 'proposal:1', path: '/w/a.md', targetText: 'world', replacement: 'Mimir' }
    lifecycle.onProposalsChanged({ payload: [p1] })
    expect(file.reviews).toHaveLength(1)

    // An unrelated proposal's event keeps this file's pending review intact.
    fileManager.clearFileReviews.mockClear()
    lifecycle.onProposalsChanged({ payload: [p1, { id: 'proposal:x', path: '/w/other.md' }] })
    expect(fileManager.clearFileReviews).not.toHaveBeenCalled()
    expect(file.reviews).toHaveLength(1)

    // A new pending proposal for this file joins the review set.
    const p2 = { id: 'proposal:2', path: '/w/a.md', targetText: 'hello', replacement: 'goodbye' }
    lifecycle.onProposalsChanged({ payload: [p1, p2] })
    expect(file.reviews.map(review => review.proposalId)).toEqual(['proposal:1', 'proposal:2'])

    // Only ids that left the global pending set are dropped.
    lifecycle.onProposalsChanged({ payload: [p2] })
    expect(file.reviews.map(review => review.proposalId)).toEqual(['proposal:2'])

    // The last terminal id clears the review and closes the diff.
    lifecycle.onProposalsChanged({ payload: [] })
    expect(fileManager.clearFileReviews).toHaveBeenCalledWith(file)
    expect(diffStore.deactivate).toHaveBeenCalled()

    lifecycle.dispose()
  })

  it('keeps Graph proposals attached to Details until Source is selected in the same tab', async () => {
    const files = ref([{ path: '/graph/item.md', content: 'hello world', kind: 'graph', dirty: true }])
    const file = files.value[0]
    const fileManager = {
      get openFiles() { return files.value },
      activeFileIndex: 0,
      get currentFile() { return file },
      setFileReviews: vi.fn((target, reviews) => { target.reviews = reviews }),
      clearFileReviews: vi.fn(),
    }
    const diffStore = { active: false, activate: vi.fn(), deactivate: vi.fn() }
    const lifecycle = useEditorProposalLifecycle({
      fileManager,
      diffStore,
      openFiles: files,
      activeFileIndex: ref(0),
      currentEditorContent: () => file.content,
      flushEditorContent: vi.fn(),
      editorSurfaceRef: ref(null),
      activateDiff: vi.fn(),
      activateBatchDiff: vi.fn(),
    })
    lifecycle.onProposalsChanged({ payload: [{ id: 'p1', path: file.path, targetText: 'world', replacement: 'Mimir' }] })
    expect(file.reviews).toHaveLength(1)
    expect(diffStore.activate).not.toHaveBeenCalled()
    file.kind = 'text'
    await nextTick()
    expect(diffStore.activate).not.toHaveBeenCalled()
    await nextTick()
    expect(diffStore.activate).toHaveBeenCalledWith(expect.objectContaining({ original: 'hello world', modified: 'hello Mimir' }))
    lifecycle.dispose()
  })

  it.each(['navigation', 'dispose'])('cancels a deferred Source review after %s', async reason => {
    const files = ref([
      { path: '/graph/item.md', content: 'hello world', kind: 'graph', reviews: [{ proposalId: 'p1', targetText: 'world', replacement: 'Mimir' }] },
      { path: '/w/other.md', content: 'other document', kind: 'text' },
    ])
    const activeFileIndex = ref(0)
    const fileManager = {
      get openFiles() { return files.value },
      get activeFileIndex() { return activeFileIndex.value },
      get currentFile() { return files.value[activeFileIndex.value] },
    }
    const diffStore = { active: false, activate: vi.fn(), deactivate: vi.fn() }
    const flushEditorContent = vi.fn()
    const lifecycle = useEditorProposalLifecycle({
      fileManager, diffStore, openFiles: files, activeFileIndex,
      currentEditorContent: () => fileManager.currentFile.content,
      flushEditorContent, editorSurfaceRef: ref(null),
      activateDiff: vi.fn(), activateBatchDiff: vi.fn(),
    })
    files.value[0].kind = 'text'
    await nextTick()
    if (reason === 'navigation') activeFileIndex.value = 1
    else lifecycle.dispose()
    await nextTick()
    await nextTick()
    expect(flushEditorContent).not.toHaveBeenCalled()
    expect(diffStore.activate).not.toHaveBeenCalled()
    lifecycle.dispose()
  })
})
