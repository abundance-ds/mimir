import { computed, nextTick, reactive, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { useTabManagement } from './useTabManagement.js'

function setup({
  files = [{ id: 1, path: '/a.md', dirty: true }],
  embedded = false,
  saveResult = true,
  visibleIds = null,
  activeIndex = 0,
  gitActive = false,
  diffActive = false,
  discardMode = file => file?.path ? 'trash' : 'draft',
  trashError = null,
} = {}) {
  const openFiles = reactive(files)
  const activeFileIndex = ref(activeIndex)
  const fileManager = {
    openFiles,
    setActiveTab: vi.fn(index => {
      activeFileIndex.value = index
    }),
    closeFile: vi.fn((index) => {
      openFiles.splice(index, 1)
    }),
    discardFile: vi.fn((file) => {
      const index = openFiles.indexOf(file)
      if (index < 0) return false
      openFiles.splice(index, 1)
      return true
    }),
    waitForWorkspacePaths: vi.fn(async () => {}),
    pauseGraphSave: vi.fn(),
    resumeGraphSave: vi.fn(),
    moveTab: vi.fn(),
    newFile: vi.fn(),
  }
  const diffStore = reactive({
    active: diffActive,
    isBatch: false,
    fileId: files[0]?.id ?? null,
    filePath: files[0]?.path || '',
    deactivate: vi.fn(),
    clearBatchFocus: vi.fn(),
    focusBatchFile: vi.fn(),
  })
  const requestWindowClose = vi.fn(async () => true)
  const onEmpty = vi.fn()
  const saveCurrentFile = vi.fn(async () => saveResult)
  const trashWorkspaceEntries = vi.fn(async () => {
    if (trashError) throw trashError
  })
  const cancelAutoSave = vi.fn(() => true)
  const resumeAutoSave = vi.fn()
  const flushSession = vi.fn(async () => {})
  const flushEditorContent = vi.fn()
  const gitReviewStore = reactive({ active: gitActive, deactivate: vi.fn() })
  const gitReviewTabActive = ref(false)
  const reviewTabActive = ref(false)
  const displayTabs = computed(() => {
    const tabs = openFiles
      .map((file, fileIndex) => ({ file, fileIndex }))
      .filter(({ file }) => !visibleIds || visibleIds.includes(file.id))
      .map(({ file, fileIndex }) => ({
        id: file.id,
        fileIndex,
        type: 'file',
      }))
    if (gitReviewStore.active) tabs.push({ id: '__git__', type: 'git-review' })
    return tabs
  })
  const manager = useTabManagement({
    fileManager,
    diffStore,
    displayTabs,
    reviewTabActive,
    gitReviewStore,
    gitReviewTabActive,
    inlineAIState: ref(null),
    activeFileIndex,
    flushEditorContent,
    saveCurrentFile,
    trashWorkspaceEntries,
    discardModeForFile: discardMode,
    cancelAutoSave,
    resumeAutoSave,
    flushSession,
    requestWindowClose,
    embedded,
    onEmpty,
  })
  return {
    manager,
    fileManager,
    requestWindowClose,
    saveCurrentFile,
    onEmpty,
    activeFileIndex,
    diffStore,
    gitReviewStore,
    gitReviewTabActive,
    displayTabs,
    trashWorkspaceEntries,
    cancelAutoSave,
    resumeAutoSave,
    flushSession,
    flushEditorContent,
  }
}

async function choose(manager, action) {
  await nextTick()
  manager.onCloseConfirm(action)
}

describe('useTabManagement close safety', () => {
  it('saves a dirty path-backed last tab once before requesting standalone window close', async () => {
    const h = setup()
    const closing = h.manager.onCloseTab(0)
    await choose(h.manager, 'save')
    await expect(closing).resolves.toBe(true)

    expect(h.saveCurrentFile).toHaveBeenCalledWith({ source: 'manual' })
    expect(h.requestWindowClose).toHaveBeenCalledWith({
      confirmedFiles: [h.fileManager.openFiles[0]],
      discardedFiles: [],
    })
    expect(h.fileManager.closeFile).not.toHaveBeenCalled()
  })

  it('passes an explicit discard into the final crash-session snapshot', async () => {
    const h = setup()
    const file = h.fileManager.openFiles[0]
    const closing = h.manager.onCloseTab(0)
    await choose(h.manager, 'discard')
    await closing

    expect(h.requestWindowClose).toHaveBeenCalledWith({
      confirmedFiles: [file],
      discardedFiles: [file],
    })
    expect(h.saveCurrentFile).not.toHaveBeenCalled()
  })

  it('pauses Graph autosave for close confirmation and resumes it on Cancel', async () => {
    const h = setup({ files: [{ id: 1, path: '/graph/entry.md', kind: 'graph', graph: {}, dirty: true }] })
    const file = h.fileManager.openFiles[0]
    const closing = h.manager.confirmFileClose(file)
    await nextTick()
    expect(h.fileManager.pauseGraphSave).toHaveBeenCalledWith(file)
    expect(h.fileManager.resumeGraphSave).not.toHaveBeenCalled()
    await choose(h.manager, 'cancel')
    expect(await closing).toBe('cancel')
    expect(h.fileManager.resumeGraphSave).toHaveBeenCalledWith(file)
  })

  it('keeps a Graph tab open until its review decision finishes', async () => {
    const h = setup({ files: [{ id: 1, path: '/graph/entry.md', graph: {}, dirty: false, reviewPending: true }] })
    expect(await h.manager.confirmFileClose(h.fileManager.openFiles[0])).toBe('cancel')
    expect(h.manager.closeConfirmFile.value).toBeNull()
    expect(h.fileManager.closeFile).not.toHaveBeenCalled()
  })

  it('cancels close when the dialog is cancelled or a manual save fails', async () => {
    const cancelled = setup()
    const first = cancelled.manager.onCloseTab(0)
    await choose(cancelled.manager, 'cancel')
    await expect(first).resolves.toBe(false)
    expect(cancelled.requestWindowClose).not.toHaveBeenCalled()

    const failed = setup({ saveResult: false })
    const second = failed.manager.onCloseTab(0)
    await choose(failed.manager, 'save')
    await expect(second).resolves.toBe(false)
    expect(failed.requestWindowClose).not.toHaveBeenCalled()
  })

  it('closes the last embedded tab without fabricating a replacement and emits empty', async () => {
    const h = setup({
      files: [{ id: 1, path: '/clean.md', dirty: false }],
      embedded: true,
    })

    await expect(h.manager.onCloseTab(0)).resolves.toBe(true)

    expect(h.fileManager.closeFile).toHaveBeenCalledWith(0, { ensureOne: false })
    expect(h.requestWindowClose).not.toHaveBeenCalled()
    expect(h.onEmpty).toHaveBeenCalledTimes(1)
  })

  it('closes the visible project tab while retaining hidden workspace tabs', async () => {
    const hidden = { id: 1, path: '/alpha/hidden.md', dirty: false }
    const visible = { id: 2, path: '/beta/visible.md', dirty: false }
    const h = setup({
      files: [hidden, visible],
      embedded: true,
      visibleIds: [2],
      activeIndex: 1,
    })

    await expect(h.manager.onCloseTab(0)).resolves.toBe(true)

    expect(h.fileManager.closeFile).toHaveBeenCalledWith(1, { ensureOne: false })
    expect(h.fileManager.openFiles).toEqual([hidden])
    expect(h.onEmpty).toHaveBeenCalledTimes(1)
  })

  it('maps visible reorder positions around retained hidden tabs', () => {
    const h = setup({
      files: [
        { id: 1, path: '/beta/one.md', dirty: false },
        { id: 2, path: '/alpha/hidden.md', dirty: false },
        { id: 3, path: '/beta/two.md', dirty: false },
      ],
      embedded: true,
      visibleIds: [1, 3],
    })

    h.manager.onReorderTab(0, 1)

    expect(h.fileManager.moveTab).toHaveBeenCalledWith(0, 2)
  })

  it('keeps a single-file proposal intact while Git review opens and returns', () => {
    const h = setup({ gitActive: true, diffActive: true })
    h.manager.onSelectTab(1)
    expect(h.gitReviewTabActive.value).toBe(true)
    expect(h.diffStore.deactivate).not.toHaveBeenCalled()

    h.manager.onSelectTab(0)
    expect(h.gitReviewTabActive.value).toBe(false)
    expect(h.diffStore.deactivate).not.toHaveBeenCalled()
    expect(h.fileManager.setActiveTab).toHaveBeenCalledWith(0)
  })

  it('closes Git review without resolving proposal state', async () => {
    const h = setup({ gitActive: true, diffActive: true })
    await h.manager.onCloseTab(1)
    expect(h.gitReviewStore.deactivate).toHaveBeenCalledTimes(1)
    expect(h.diffStore.deactivate).not.toHaveBeenCalled()
  })

  it('moves a confirmed named file to Trash and removes its dirty buffer', async () => {
    const file = { id: 1, path: '/work/temp-note.md', dirty: true }
    const h = setup({ files: [file], embedded: true })

    expect(h.manager.requestDiscardTab(0)).toBe(true)
    expect(h.manager.discardConfirm.value).toEqual({ file, mode: 'trash' })
    await expect(h.manager.confirmDiscard()).resolves.toBe(true)

    expect(h.cancelAutoSave).toHaveBeenCalledWith(file)
    expect(h.flushEditorContent).toHaveBeenCalledWith({ bridge: 'flush' })
    expect(h.fileManager.waitForWorkspacePaths).toHaveBeenCalledWith([file.path])
    expect(h.trashWorkspaceEntries).toHaveBeenCalledWith([file.path])
    expect(h.fileManager.discardFile).toHaveBeenCalledWith(file, { ensureOne: false })
    expect(h.fileManager.openFiles).toEqual([])
    expect(h.onEmpty).toHaveBeenCalledTimes(1)
    expect(h.flushSession).toHaveBeenCalledTimes(1)
  })

  it('discards an untitled draft without calling the native Trash operation', async () => {
    const file = { id: 1, path: null, dirty: true }
    const h = setup({ files: [file], embedded: true })

    expect(h.manager.requestDiscardFile(file)).toBe(true)
    expect(h.manager.discardConfirmMode.value).toBe('draft')
    await expect(h.manager.confirmDiscard()).resolves.toBe(true)

    expect(h.fileManager.waitForWorkspacePaths).not.toHaveBeenCalled()
    expect(h.trashWorkspaceEntries).not.toHaveBeenCalled()
    expect(h.fileManager.openFiles).toEqual([])
  })

  it('keeps the file and resumes its autosave timer when Trash fails', async () => {
    const file = { id: 1, path: '/work/temp-note.md', dirty: true }
    const error = new Error('Trash is unavailable')
    const h = setup({ files: [file], embedded: true, trashError: error })

    h.manager.requestDiscardFile(file)
    await expect(h.manager.confirmDiscard()).resolves.toBe(false)

    expect(h.fileManager.openFiles).toEqual([file])
    expect(h.fileManager.discardFile).not.toHaveBeenCalled()
    expect(h.manager.discardError.value).toBe('Trash is unavailable')
    expect(h.resumeAutoSave).toHaveBeenCalledWith(file)
    expect(h.flushSession).not.toHaveBeenCalled()
  })

  it('does not open a discard dialog when the file lifecycle is blocked', () => {
    const h = setup({ discardMode: () => '' })

    expect(h.manager.requestDiscardTab(0)).toBe(false)
    expect(h.manager.discardConfirm.value).toBeNull()
  })
})
