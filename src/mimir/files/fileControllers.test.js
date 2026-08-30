import { computed, effectScope, reactive, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const operations = vi.hoisted(() => ({
  createWorkspaceFile: vi.fn(),
  createWorkspaceFolder: vi.fn(),
  duplicateWorkspaceEntry: vi.fn(),
  moveWorkspaceEntry: vi.fn(),
  openWorkspaceEntryNative: vi.fn(),
  renameWorkspaceEntry: vi.fn(),
  revealWorkspaceEntry: vi.fn(),
  trashWorkspaceEntries: vi.fn(),
}))

vi.mock('../../services/workspaceFileOperations.js', () => operations)

import {
  inferOpenBehavior,
  joinRelative,
  normalizePath,
  normalizeRelative,
  parentDirectory,
} from './filePaths.js'
import { useFileContextMenu } from './useFileContextMenu.js'
import { useFileFavorites } from './useFileFavorites.js'
import { useFileMutations } from './useFileMutations.js'
import { useFileSelection } from './useFileSelection.js'

describe('Files controllers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    operations.createWorkspaceFile.mockResolvedValue({
      path: '/w/docs/brief.md',
      relativePath: 'docs/brief.md',
      name: 'brief.md',
    })
  })

  it('centralizes cross-platform paths and conservative preview behavior', () => {
    expect(normalizePath('C:\\work\\docs\\')).toBe('C:/work/docs')
    expect(normalizeRelative('/docs/guide.md')).toBe('docs/guide.md')
    expect(parentDirectory('docs/guide.md')).toBe('docs')
    expect(joinRelative('docs', 'guide.md')).toBe('docs/guide.md')
    expect(inferOpenBehavior('report.pdf')).toBe('pdf')
    expect(inferOpenBehavior('photo.png')).toBe('external')
    expect(inferOpenBehavior('unknown.custom')).toBe('text')
  })

  it('owns favorite identity and rewrites nested favorites after folder moves', () => {
    const settings = reactive({
      workbenchFileFavorites: {},
      set(key, value) {
        this[key] = value
      },
    })
    const workspacePath = ref('/w')
    const controller = useFileFavorites({ settings, workspacePath })

    controller.toggleFavorite({
      relativePath: 'docs',
      isDirectory: true,
    })
    controller.toggleFavorite({
      relativePath: 'docs/guide.md',
      isDirectory: false,
    })
    controller.updateFavoritePaths('docs', 'writing')

    expect(controller.favorites.value).toEqual([
      { relativePath: 'writing', isDirectory: true },
      { relativePath: 'writing/guide.md', isDirectory: false },
    ])
    expect(controller.isFavorite({ relativePath: 'writing/guide.md' })).toBe(true)
  })

  it('owns range selection, focus movement, and directory targeting', async () => {
    const scope = effectScope()
    const rows = ref([
      { entry: { path: '/w/docs', relativePath: 'docs', isDirectory: true } },
      { entry: { path: '/w/docs/a.md', relativePath: 'docs/a.md', isDirectory: false } },
      { entry: { path: '/w/b.md', relativePath: 'b.md', isDirectory: false } },
    ])
    const activateRow = vi.fn()
    const listRef = ref(document.createElement('div'))
    listRef.value.innerHTML = rows.value
      .map(row => `<div data-file-row="${row.entry.path}"><button></button></div>`)
      .join('')

    const selection = scope.run(() => useFileSelection({
      visibleRows: computed(() => rows.value),
      listRef,
      activateRow,
      closeContextMenu: vi.fn(),
    }))
    selection.selectRow(rows.value[0], 0, {})
    selection.moveFocus(2, true)

    expect([...selection.selectedPaths.value]).toEqual([
      '/w/docs',
      '/w/docs/a.md',
      '/w/b.md',
    ])
    expect(selection.selectedDirectory()).toBe('')
    expect(activateRow).toHaveBeenCalledWith(rows.value[0], true)

    rows.value = rows.value.slice(0, 2)
    await Promise.resolve()
    expect(selection.focusedIndex.value).toBe(1)
    scope.stop()
  })

  it('owns context positioning, keyboard navigation, and outside dismissal', async () => {
    const rows = ref([{
      entry: { path: '/w/a.md', relativePath: 'a.md', isDirectory: false },
    }])
    const selectedPaths = ref(new Set())
    const focusedIndex = ref(0)
    const listRef = ref(document.createElement('div'))
    listRef.value.innerHTML = '<div data-file-row="/w/a.md"><button></button></div>'
    const contextMenuRef = ref(document.createElement('div'))
    contextMenuRef.value.innerHTML = `
      <button role="menuitem" data-first>First</button>
      <button role="menuitem" data-second>Second</button>
    `
    document.body.appendChild(contextMenuRef.value)
    const context = useFileContextMenu({
      visibleRows: computed(() => rows.value),
      focusedIndex,
      selectedPaths,
      listRef,
      contextMenuRef,
    })

    context.openContextMenu(rows.value[0], { clientX: 24, clientY: 30 })
    await Promise.resolve()
    const first = contextMenuRef.value.querySelector('[data-first]')
    first.focus()
    context.onContextMenuKeydown(new KeyboardEvent('keydown', { key: 'ArrowDown' }))

    expect(context.contextEntry.value.path).toBe('/w/a.md')
    expect(document.activeElement).toBe(contextMenuRef.value.querySelector('[data-second]'))
    context.onDocumentPointerDown({ target: document.body })
    expect(context.contextEntry.value).toBeNull()
    contextMenuRef.value.remove()
  })

  it('performs mutations through one controller and reconciles only the parent', async () => {
    const input = document.createElement('input')
    const files = reactive({
      workspacePath: '/w',
      expandedDirectories: new Set(),
      error: '',
      loadTreeDirectory: vi.fn(async () => []),
      refresh: vi.fn(async () => ({ added: 0, changed: 0, removed: 0 })),
    })
    const editorFiles = {
      waitForWorkspacePaths: vi.fn(async () => {}),
      moveWorkspacePath: vi.fn(),
      handleWorkspaceTrash: vi.fn(),
    }
    const controller = useFileMutations({
      files,
      editorFiles,
      listRef: ref({ querySelector: () => input }),
      contextEntry: ref(null),
      selectedDirectory: () => 'docs',
      closeContextMenu: vi.fn(),
      clearSelection: vi.fn(),
      updateFavoritePaths: vi.fn(),
      refreshGit: vi.fn(async () => {}),
      emitOpenFile: vi.fn(),
    })

    await controller.promptNew('file')
    controller.nameDraft.value = 'brief.md'
    await controller.commitNameAction()

    expect(operations.createWorkspaceFile).toHaveBeenCalledWith('docs/brief.md')
    expect(files.loadTreeDirectory).toHaveBeenLastCalledWith('docs', { force: true })
    expect(files.refresh).not.toHaveBeenCalled()
  })

  it('owns optimistic Trash state and rolls it back after a native failure', async () => {
    const files = reactive({
      workspacePath: '/w',
      expandedDirectories: new Set(),
      error: '',
      loadTreeDirectory: vi.fn(async () => []),
      refresh: vi.fn(async () => null),
    })
    const editorFiles = {
      waitForWorkspacePaths: vi.fn(async () => {}),
      moveWorkspacePath: vi.fn(),
      handleWorkspaceTrash: vi.fn(),
    }
    let rejectTrash
    operations.trashWorkspaceEntries.mockImplementationOnce(() => new Promise((_, reject) => {
      rejectTrash = reject
    }))
    const clearSelection = vi.fn()
    const controller = useFileMutations({
      files,
      editorFiles,
      listRef: ref(null),
      contextEntry: ref(null),
      selectedDirectory: () => '',
      closeContextMenu: vi.fn(),
      clearSelection,
      updateFavoritePaths: vi.fn(),
      refreshGit: vi.fn(async () => {}),
      emitOpenFile: vi.fn(),
    })
    const entry = { path: '/w/notes.md', relativePath: 'notes.md', name: 'notes.md' }

    controller.promptDelete([entry])
    const operation = controller.confirmDelete()

    expect(controller.deleteEntries.value).toEqual([])
    expect([...controller.pendingTrashPaths.value]).toEqual(['/w/notes.md'])
    expect(clearSelection).toHaveBeenCalledTimes(1)

    await Promise.resolve()
    rejectTrash(new Error('permission denied'))
    await operation

    expect(controller.pendingTrashPaths.value.size).toBe(0)
    expect(controller.operationError.value).toContain('permission denied')
    expect(files.loadTreeDirectory).toHaveBeenCalledWith('', { force: true })
    expect(editorFiles.handleWorkspaceTrash).not.toHaveBeenCalled()
  })

  it('moves only what a drop would change and reconciles editor, favorites, and tree', async () => {
    const files = reactive({
      workspacePath: '/w',
      expandedDirectories: new Set(),
      error: '',
      loadTreeDirectory: vi.fn(async () => []),
      refresh: vi.fn(async () => null),
    })
    const editorFiles = {
      waitForWorkspacePaths: vi.fn(async () => {}),
      moveWorkspacePath: vi.fn(),
      handleWorkspaceTrash: vi.fn(),
    }
    const updateFavoritePaths = vi.fn()
    const refreshGit = vi.fn(async () => {})
    const controller = useFileMutations({
      files,
      editorFiles,
      listRef: ref(null),
      contextEntry: ref(null),
      selectedDirectory: () => '',
      closeContextMenu: vi.fn(),
      clearSelection: vi.fn(),
      updateFavoritePaths,
      refreshGit,
      emitOpenFile: vi.fn(),
    })
    operations.moveWorkspaceEntry.mockResolvedValue({
      path: '/w/docs/notes.md',
      relativePath: 'docs/notes.md',
      name: 'notes.md',
    })

    const notes = { path: '/w/notes.md', relativePath: 'notes.md', name: 'notes.md' }
    const moved = await controller.moveEntries([
      notes,
      // Already lives in the destination: a no-op, not a native call.
      { path: '/w/docs/kept.md', relativePath: 'docs/kept.md', name: 'kept.md' },
      // Travels with its dragged parent below, so it must not move twice.
      { path: '/w/pack/inner.md', relativePath: 'pack/inner.md', name: 'inner.md' },
      { path: '/w/pack', relativePath: 'pack', name: 'pack', isDirectory: true },
    ], 'docs')

    expect(operations.moveWorkspaceEntry.mock.calls).toEqual([
      ['/w/notes.md', 'docs'],
      ['/w/pack', 'docs'],
    ])
    expect(editorFiles.waitForWorkspacePaths).toHaveBeenCalledWith(['/w/notes.md', '/w/pack'])
    expect(editorFiles.moveWorkspacePath).toHaveBeenCalledWith('/w/notes.md', '/w/docs/notes.md')
    expect(updateFavoritePaths).toHaveBeenCalledWith('notes.md', 'docs/notes.md')
    expect(files.loadTreeDirectory).toHaveBeenCalledWith('', { force: true })
    expect(files.loadTreeDirectory).toHaveBeenCalledWith('docs', { force: true })
    expect(moved).toHaveLength(2)

    // A folder cannot land inside itself, and a refused item reports itself
    // without failing the batch.
    const rejected = await controller.moveEntries([
      { path: '/w/docs', relativePath: 'docs', name: 'docs', isDirectory: true },
    ], 'docs/deep')
    expect(rejected).toEqual([])

    operations.moveWorkspaceEntry.mockRejectedValueOnce(new Error('busy'))
    const partial = await controller.moveEntries([notes], 'docs')
    expect(partial).toEqual([])
    expect(controller.operationError.value).toContain('busy')
  })
})
