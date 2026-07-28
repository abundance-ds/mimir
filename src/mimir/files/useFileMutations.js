import { nextTick, ref } from 'vue'
import {
  createWorkspaceFile,
  createWorkspaceFolder,
  duplicateWorkspaceEntry,
  openWorkspaceEntryNative,
  renameWorkspaceEntry,
  revealWorkspaceEntry,
  trashWorkspaceEntries,
} from '../../services/workspaceFileOperations.js'
import {
  describeFileError,
  joinRelative,
  normalizePath,
  normalizeRelative,
  parentDirectory,
} from './filePaths.js'

export function useFileMutations({
  files,
  editorFiles,
  listRef,
  contextEntry,
  selectedDirectory,
  closeContextMenu,
  clearSelection,
  updateFavoritePaths,
  refreshGit,
  emitOpenFile,
}) {
  const nameAction = ref(null)
  const nameDraft = ref('')
  const operationBusy = ref(false)
  const operationError = ref('')
  // Transient message for a mutation that succeeded but has something to say
  // (skipped links, say). Separate from operationError so a success is never
  // dressed up as a failure.
  const operationNotice = ref('')
  const deleteEntries = ref([])
  const deleteError = ref('')
  const refreshing = ref(false)

  async function promptNew(kind, parent = selectedDirectory()) {
    closeContextMenu()
    const normalizedParent = normalizeRelative(parent)
    try {
      if (normalizedParent) {
        await files.loadTreeDirectory(normalizedParent)
        const expanded = new Set(files.expandedDirectories)
        expanded.add(normalizedParent)
        files.expandedDirectories = expanded
      }
      nameAction.value = { kind, parent: normalizedParent }
      nameDraft.value = ''
      await focusInlineInput()
    } catch (error) {
      operationError.value = describeFileError(
        error,
        'Destination folder could not be opened',
      )
    }
  }

  function promptNewInside(kind) {
    const entry = contextEntry.value
    if (entry?.isDirectory) void promptNew(kind, entry.relativePath)
  }

  function promptRename(entry) {
    if (!entry || entry.missing) return
    closeContextMenu()
    nameAction.value = {
      kind: entry.isDirectory ? 'folder' : 'file',
      parent: parentDirectory(entry.relativePath),
      renamePath: entry.path,
      relativePath: entry.relativePath,
    }
    nameDraft.value = entry.name
    void focusInlineInput({ selectStem: !entry.isDirectory })
  }

  function promptRenameContext() {
    promptRename(contextEntry.value)
  }

  async function focusInlineInput({ selectStem = false } = {}) {
    await nextTick()
    const input = listRef.value?.querySelector('[data-files-inline-name]')
    input?.focus()
    if (!input) return
    if (selectStem) {
      const dot = input.value.lastIndexOf('.')
      input.setSelectionRange(0, dot > 0 ? dot : input.value.length)
    } else {
      input.select()
    }
  }

  function isEditing(row) {
    if (!nameAction.value) return false
    if (!nameAction.value.renamePath) return row.editing
    return normalizePath(row.entry.path) === normalizePath(nameAction.value.renamePath)
  }

  function cancelNameAction() {
    if (operationBusy.value) return
    nameAction.value = null
    nameDraft.value = ''
  }

  async function commitNameAction() {
    const action = nameAction.value
    if (!action || operationBusy.value) return
    const name = nameDraft.value.trim()
    if (!name) {
      cancelNameAction()
      return
    }
    if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
      operationError.value = 'Use a name without folder separators.'
      await focusInlineInput()
      return
    }
    operationBusy.value = true
    try {
      if (action.renamePath) {
        await editorFiles.waitForWorkspacePaths([action.renamePath])
        const result = await renameWorkspaceEntry(action.renamePath, name)
        editorFiles.moveWorkspacePath(action.renamePath, result.path)
        updateFavoritePaths(action.relativePath, result.relativePath)
      } else {
        const relativePath = joinRelative(action.parent, name)
        if (action.kind === 'folder') {
          await createWorkspaceFolder(relativePath)
        } else {
          const result = await createWorkspaceFile(relativePath)
          emitOpenFile({ path: result.path, preview: false, entry: result })
        }
      }
      nameAction.value = null
      nameDraft.value = ''
      await reconcileMutationDirectories([action.parent])
    } catch (error) {
      operationError.value = describeFileError(
        error,
        action.renamePath ? 'Rename failed' : 'Creation failed',
      )
      await focusInlineInput()
    } finally {
      operationBusy.value = false
    }
  }

  async function refresh({ quiet = false } = {}) {
    if (refreshing.value || !files.workspacePath) return
    refreshing.value = true
    if (!quiet) operationError.value = ''
    try {
      const [report] = await Promise.all([files.refresh(), refreshGit()])
      if (report === null && files.error) operationError.value = files.error
    } catch (error) {
      operationError.value = describeFileError(error, 'Files could not be refreshed')
    } finally {
      refreshing.value = false
    }
  }

  async function runOperation(operation, fallback) {
    operationError.value = ''
    try {
      return await operation()
    } catch (error) {
      operationError.value = describeFileError(error, fallback)
      return null
    }
  }

  function openContextNative() {
    const entry = contextEntry.value
    closeContextMenu()
    if (entry) {
      void runOperation(
        () => openWorkspaceEntryNative(entry.path),
        `Could not open ${entry.name}`,
      )
    }
  }

  async function duplicateContext() {
    const entry = contextEntry.value
    closeContextMenu()
    if (!entry) return
    await runOperation(async () => {
      await duplicateWorkspaceEntry(entry.path)
      await reconcileMutationDirectories([parentDirectory(entry.relativePath)])
    }, `Could not duplicate ${entry.name}`)
  }

  async function revealContext() {
    const entry = contextEntry.value
    closeContextMenu()
    if (entry) {
      await runOperation(
        () => revealWorkspaceEntry(entry.path),
        `Could not reveal ${entry.name}`,
      )
    }
  }

  function copyContextPath(relative) {
    const entry = contextEntry.value
    closeContextMenu()
    if (entry) void copyText(relative ? entry.relativePath : entry.path)
  }

  async function copyText(text) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable.')
      await navigator.clipboard.writeText(text)
    } catch (error) {
      operationError.value = describeFileError(error, 'Path could not be copied')
    }
  }

  function promptDelete(entries) {
    closeContextMenu()
    const unique = new Map(entries.filter(Boolean).map(entry => [entry.path, entry]))
    deleteEntries.value = [...unique.values()]
    deleteError.value = ''
  }

  function closeDeleteDialog() {
    if (operationBusy.value) return
    deleteEntries.value = []
    deleteError.value = ''
  }

  async function confirmDelete() {
    if (!deleteEntries.value.length || operationBusy.value) return
    operationBusy.value = true
    deleteError.value = ''
    const paths = deleteEntries.value.map(entry => entry.path)
    const parentDirectories = deleteEntries.value.map(
      entry => parentDirectory(entry.relativePath),
    )
    try {
      await editorFiles.waitForWorkspacePaths(paths)
      await trashWorkspaceEntries(paths)
      editorFiles.handleWorkspaceTrash(paths)
      deleteEntries.value = []
      clearSelection()
      await reconcileMutationDirectories(parentDirectories)
    } catch (error) {
      deleteError.value = describeFileError(
        error,
        'Could not move the selection to the Trash',
      )
    } finally {
      operationBusy.value = false
    }
  }

  async function reconcileMutationDirectories(directories) {
    const uniqueDirectories = [...new Set(directories.map(normalizeRelative))]
    await Promise.allSettled([
      ...uniqueDirectories.map(
        directory => files.loadTreeDirectory(directory, { force: true }),
      ),
      refreshGit(),
    ])
  }

  return {
    cancelNameAction,
    closeDeleteDialog,
    commitNameAction,
    confirmDelete,
    copyContextPath,
    deleteEntries,
    deleteError,
    duplicateContext,
    focusInlineInput,
    isEditing,
    nameAction,
    nameDraft,
    openContextNative,
    operationBusy,
    operationError,
    operationNotice,
    promptDelete,
    promptNew,
    promptNewInside,
    promptRename,
    promptRenameContext,
    reconcileMutationDirectories,
    refresh,
    refreshing,
    revealContext,
    runOperation,
  }
}
