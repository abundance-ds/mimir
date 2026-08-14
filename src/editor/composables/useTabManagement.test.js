import { computed, nextTick, reactive, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { useTabManagement } from './useTabManagement.js'

function setup({
  files = [{ id: 1, path: '/a.md', dirty: true }],
  embedded = false,
  saveResult = true,
  visibleIds = null,
  activeIndex = 0,
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
    moveTab: vi.fn(),
    newFile: vi.fn(),
  }
  const diffStore = reactive({
    active: false,
    isBatch: false,
    deactivate: vi.fn(),
    clearBatchFocus: vi.fn(),
    focusBatchFile: vi.fn(),
  })
  const requestWindowClose = vi.fn(async () => true)
  const onEmpty = vi.fn()
  const saveCurrentFile = vi.fn(async () => saveResult)
  const manager = useTabManagement({
    fileManager,
    diffStore,
    displayTabs: computed(() => openFiles
      .map((file, fileIndex) => ({ file, fileIndex }))
      .filter(({ file }) => !visibleIds || visibleIds.includes(file.id))
      .map(({ file, fileIndex }) => ({
        id: file.id,
        fileIndex,
        type: 'file',
      }))),
    reviewTabActive: ref(false),
    inlineAIState: ref(null),
    activeFileIndex,
    flushEditorContent: vi.fn(),
    saveCurrentFile,
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
})
