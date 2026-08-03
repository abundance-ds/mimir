import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  beginContentSearch,
  cancelContentSearch,
  filterIndexedFiles,
  listIndexedFiles,
  openWorkspaceIndex,
  refreshWorkspaceIndex,
  searchIndexedContent,
} from '../services/fileIndex.js'
import { listWorkspaceDirectory } from '../services/workspaceFileOperations.js'
import { useFileStore } from './files.js'
import { useSettingsStore } from './settings.js'

export const useWorkspaceFilesStore = defineStore('workspaceFiles', () => {
  const workspacePath = ref('')
  const files = ref([])
  const filteredFiles = ref(null)
  const query = ref('')
  const selectionIndex = ref(0)
  const loading = ref(false)
  const error = ref('')
  const contentMatches = ref([])
  const contentSearching = ref(false)
  const contentTruncated = ref(false)
  const currentDirectory = ref('')
  const directoryEntries = ref([])
  const directoryLoading = ref(false)
  const directoryError = ref('')
  const treeChildren = ref({})
  const treeLoadingPaths = ref(new Set())
  const treeErrors = ref({})
  const expandedDirectories = ref(new Set())
  let activeSearchToken = null
  let queryGeneration = 0
  let watchUnlisten = null
  let watchStartPromise = null
  let watchApplyQueue = Promise.resolve()

  const visibleFiles = computed(() => filteredFiles.value ?? files.value)
  const selectedFile = computed(() => visibleFiles.value[selectionIndex.value] || null)
  const breadcrumbs = computed(() => {
    const crumbs = [{ label: 'workspace', path: '' }]
    const parts = currentDirectory.value.split('/').filter(Boolean)
    let path = ''
    for (const part of parts) {
      path = path ? `${path}/${part}` : part
      crumbs.push({ label: part, path })
    }
    return crumbs
  })

  async function openWorkspace(path) {
    const next = String(path || '').trim()
    if (!next) throw new Error('Workspace path must not be empty.')
    queryGeneration += 1
    loading.value = true
    error.value = ''
    try {
      files.value = await openWorkspaceIndex(next)
      workspacePath.value = next
      filteredFiles.value = null
      query.value = ''
      selectionIndex.value = 0
      currentDirectory.value = ''
      treeChildren.value = {}
      treeLoadingPaths.value = new Set()
      treeErrors.value = {}
      expandedDirectories.value = new Set()
      await loadDirectory('')
      await startWatching()
    } catch (cause) {
      error.value = errorMessage(cause)
      throw cause
    } finally {
      loading.value = false
    }
  }

  async function loadDirectory(path = currentDirectory.value) {
    const next = normalizeRelativeDirectory(path)
    directoryLoading.value = true
    directoryError.value = ''
    try {
      const entries = await listWorkspaceDirectory(next)
      directoryEntries.value = Array.isArray(entries) ? entries : []
      treeChildren.value = {
        ...treeChildren.value,
        [next]: directoryEntries.value,
      }
      currentDirectory.value = next
      selectionIndex.value = 0
      return directoryEntries.value
    } catch (cause) {
      directoryError.value = errorMessage(cause)
      throw cause
    } finally {
      directoryLoading.value = false
    }
  }

  function openDirectory(path) {
    return loadDirectory(path)
  }

  function openParentDirectory() {
    if (!currentDirectory.value) return Promise.resolve(directoryEntries.value)
    const parent = currentDirectory.value.split('/').slice(0, -1).join('/')
    return loadDirectory(parent)
  }

  async function loadTreeDirectory(path = '', { force = false } = {}) {
    const next = normalizeRelativeDirectory(path)
    if (!force && Object.prototype.hasOwnProperty.call(treeChildren.value, next)) {
      return treeChildren.value[next]
    }
    if (treeLoadingPaths.value.has(next)) return treeChildren.value[next] || []
    treeLoadingPaths.value = new Set([...treeLoadingPaths.value, next])
    const errors = { ...treeErrors.value }
    delete errors[next]
    treeErrors.value = errors
    try {
      const entries = await listWorkspaceDirectory(next)
      const normalized = Array.isArray(entries) ? entries : []
      treeChildren.value = { ...treeChildren.value, [next]: normalized }
      if (next === currentDirectory.value) directoryEntries.value = normalized
      return normalized
    } catch (cause) {
      treeErrors.value = { ...treeErrors.value, [next]: errorMessage(cause) }
      throw cause
    } finally {
      const loading = new Set(treeLoadingPaths.value)
      loading.delete(next)
      treeLoadingPaths.value = loading
    }
  }

  async function toggleDirectory(path) {
    const next = normalizeRelativeDirectory(path)
    const expanded = new Set(expandedDirectories.value)
    if (expanded.has(next)) {
      expanded.delete(next)
      expandedDirectories.value = expanded
      return false
    }
    await loadTreeDirectory(next)
    expanded.add(next)
    expandedDirectories.value = expanded
    return true
  }

  function collapseAllDirectories() {
    expandedDirectories.value = new Set()
  }

  async function revealTreePath(path) {
    const parts = normalizeRelativeDirectory(path).split('/').filter(Boolean)
    parts.pop()
    let current = ''
    const expanded = new Set(expandedDirectories.value)
    for (const part of parts) {
      current = current ? `${current}/${part}` : part
      await loadTreeDirectory(current)
      expanded.add(current)
    }
    expandedDirectories.value = expanded
  }

  async function setQuery(value) {
    const nextQuery = String(value || '')
    const generation = ++queryGeneration
    query.value = nextQuery
    selectionIndex.value = 0
    if (!nextQuery.trim()) {
      filteredFiles.value = null
      return
    }
    const hits = await filterIndexedFiles(nextQuery, 250)
    if (generation !== queryGeneration || query.value !== nextQuery) return
    filteredFiles.value = hits.map((hit) => hit.file)
  }

  function moveSelection(delta) {
    const total = visibleFiles.value.length
    if (!total) {
      selectionIndex.value = 0
      return
    }
    selectionIndex.value = (selectionIndex.value + delta + total) % total
  }

  function selectPath(path) {
    const index = visibleFiles.value.findIndex((file) => file.path === path)
    if (index >= 0) selectionIndex.value = index
  }

  async function refresh() {
    if (!workspacePath.value) return null
    try {
      const report = await refreshWorkspaceIndex()
      if (report.added || report.removed || report.changed) {
        files.value = await listIndexedFiles()
        if (query.value) await setQuery(query.value)
        selectionIndex.value = Math.min(selectionIndex.value, Math.max(visibleFiles.value.length - 1, 0))
      }
      const loadedDirectories = Object.keys(treeChildren.value)
      if (!loadedDirectories.includes(currentDirectory.value)) {
        loadedDirectories.push(currentDirectory.value)
      }
      if (!loadedDirectories.includes('')) loadedDirectories.push('')
      await Promise.allSettled(
        loadedDirectories.map((directory) => loadTreeDirectory(directory, { force: true })),
      )
      error.value = ''
      return report
    } catch (cause) {
      error.value = errorMessage(cause)
      return null
    }
  }

  async function searchContent(value) {
    const text = String(value || '').trim()
    if (activeSearchToken) await cancelContentSearch(activeSearchToken)
    if (!text) {
      activeSearchToken = null
      contentMatches.value = []
      contentTruncated.value = false
      return
    }
    const token = await beginContentSearch()
    activeSearchToken = token
    contentSearching.value = true
    try {
      const report = await searchIndexedContent(token, {
        query: text,
        pathQuery: query.value || null,
        maxResults: 200,
      })
      if (activeSearchToken !== token || report.cancelled) return
      contentMatches.value = report.matches || []
      contentTruncated.value = Boolean(report.truncated)
    } finally {
      if (activeSearchToken === token) contentSearching.value = false
    }
  }

  async function startWatching() {
    if (watchUnlisten || watchStartPromise) return watchStartPromise
    if (typeof window === 'undefined' || !window.__TAURI_INTERNALS__) return false
    watchStartPromise = import('@tauri-apps/api/event')
      .then(({ listen }) => listen('mimir://workspace-files-changed', (event) => {
        watchApplyQueue = watchApplyQueue
          .catch(() => {})
          .then(() => applyWorkspaceChange(event.payload))
      }))
      .then((unlisten) => {
        watchUnlisten = unlisten
        return true
      })
      .catch(() => false)
      .finally(() => {
        watchStartPromise = null
      })
    return watchStartPromise
  }

  // Files recognized under a new path by the native watcher — an external
  // `mv`, `git mv`, or Finder drag. Open tabs, drafts, recents, and file
  // favorites follow the file to its new path; a favorite that names a moved
  // *directory* has no index identity and stays behind as missing, exactly as
  // before. Applying a move twice is a no-op, so tool- or UI-initiated
  // mutations that already reconciled synchronously are unaffected when their
  // own watcher echo arrives.
  function applyExternalMoves(moves) {
    if (!Array.isArray(moves) || !moves.length) return
    const editorFiles = useFileStore()
    for (const move of moves) {
      if (move?.from && move?.to) editorFiles.moveWorkspacePath(move.from, move.to)
    }
    rewriteMovedFavorites(moves)
  }

  function rewriteMovedFavorites(moves) {
    const settings = useSettingsStore()
    const workspaceKey = favoritesWorkspaceKey(workspacePath.value)
    const records = settings.workbenchFileFavorites?.[workspaceKey]
    if (!Array.isArray(records) || !records.length) return
    const root = normalizeAbsolutePath(workspacePath.value)
    const pairs = moves
      .map((move) => [relativeToRoot(root, move?.from), relativeToRoot(root, move?.to)])
      .filter(([from, to]) => from && to)
    if (!pairs.length) return
    let changed = false
    const next = records.map((record) => {
      const path = favoriteRelativePath(record?.relativePath)
      const pair = pairs.find(([from]) => from === path)
      if (!pair) return record
      changed = true
      return { ...record, relativePath: pair[1] }
    })
    if (changed) {
      settings.set('workbenchFileFavorites', {
        ...(settings.workbenchFileFavorites || {}),
        [workspaceKey]: next,
      })
    }
  }

  async function applyWorkspaceChange(payload = {}) {
    if (!workspacePath.value) return
    try {
      applyExternalMoves(payload?.moves)
      const hasDelta = Array.isArray(payload?.files)
      files.value = hasDelta
        ? mergeIndexChange(files.value, payload)
        : await listIndexedFiles()
      if (query.value) await setQuery(query.value)
      const loadedDirectories = Object.keys(treeChildren.value)
      const directories = hasDelta && !payload.replaceAll
        ? affectedTreeDirectories(
            workspacePath.value,
            payload.paths,
            loadedDirectories,
          )
        : loadedDirectories
      if (!hasDelta && !directories.includes('')) directories.push('')
      await Promise.allSettled(
        directories.map((directory) => loadTreeDirectory(directory, { force: true })),
      )
      selectionIndex.value = Math.min(
        selectionIndex.value,
        Math.max(visibleFiles.value.length - 1, 0),
      )
      error.value = ''
      return payload?.report || null
    } catch (cause) {
      error.value = errorMessage(cause)
      return null
    }
  }

  async function dispose() {
    queryGeneration += 1
    if (activeSearchToken) await cancelContentSearch(activeSearchToken)
    activeSearchToken = null
    watchUnlisten?.()
    watchUnlisten = null
    await watchApplyQueue.catch(() => {})
  }

  return {
    workspacePath,
    files,
    query,
    selectionIndex,
    loading,
    error,
    contentMatches,
    contentSearching,
    contentTruncated,
    currentDirectory,
    directoryEntries,
    directoryLoading,
    directoryError,
    treeChildren,
    treeLoadingPaths,
    treeErrors,
    expandedDirectories,
    visibleFiles,
    selectedFile,
    breadcrumbs,
    openWorkspace,
    loadDirectory,
    openDirectory,
    openParentDirectory,
    loadTreeDirectory,
    toggleDirectory,
    collapseAllDirectories,
    revealTreePath,
    setQuery,
    moveSelection,
    selectPath,
    refresh,
    searchContent,
    startWatching,
    applyWorkspaceChange,
    dispose,
  }
})

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || 'File index failed.')
}

function normalizeRelativeDirectory(path) {
  const normalized = String(path || '').replaceAll('\\', '/').replace(/^\/+|\/+$/g, '')
  if (!normalized) return ''
  if (normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Directory must stay inside the workspace.')
  }
  return normalized
}

export function mergeIndexChange(currentFiles, payload = {}) {
  const incoming = Array.isArray(payload.files) ? payload.files : []
  if (payload.replaceAll) return sortIndexedFiles(incoming)

  const changedPaths = (Array.isArray(payload.paths) ? payload.paths : [])
    .map(normalizeAbsolutePath)
    .filter(Boolean)
  const retained = (Array.isArray(currentFiles) ? currentFiles : []).filter((file) => {
    const path = normalizeAbsolutePath(file?.path)
    return !changedPaths.some((changed) => path === changed || path.startsWith(`${changed}/`))
  })
  const byPath = new Map()
  for (const file of [...retained, ...incoming]) {
    if (file?.path) byPath.set(normalizeAbsolutePath(file.path), file)
  }
  return sortIndexedFiles([...byPath.values()])
}

export function affectedTreeDirectories(workspace, changedPaths, loadedDirectories) {
  const root = normalizeAbsolutePath(workspace).replace(/\/+$/, '')
  const loaded = new Set(Array.isArray(loadedDirectories) ? loadedDirectories : [])
  const affected = new Set()
  for (const rawPath of Array.isArray(changedPaths) ? changedPaths : []) {
    const path = normalizeAbsolutePath(rawPath)
    if (!root || (path !== root && !path.startsWith(`${root}/`))) continue
    const relative = path === root ? '' : path.slice(root.length + 1)
    const parts = relative.split('/').filter(Boolean)
    const parent = parts.slice(0, -1).join('/')
    if (loaded.has(parent)) affected.add(parent)
    if (loaded.has(relative)) affected.add(relative)
  }
  return [...affected]
}

function sortIndexedFiles(files) {
  return [...files].sort((left, right) => (
    Number(right?.mtime || 0) - Number(left?.mtime || 0)
    || String(left?.relativePath || left?.path || '').localeCompare(
      String(right?.relativePath || right?.path || ''),
    )
  ))
}

function normalizeAbsolutePath(path) {
  return String(path || '').replaceAll('\\', '/').replace(/\/+$/, '')
}

// Favorites persist under the same workspace key `useFileFavorites` computes;
// the two normalizations must stay identical or moved favorites silently miss.
function favoritesWorkspaceKey(path) {
  return String(path || '').replaceAll('\\', '/').replace(/\/+/g, '/').replace(/\/$/, '')
}

function favoriteRelativePath(path) {
  return String(path || '').replaceAll('\\', '/').replace(/\/+/g, '/').replace(/\/$/, '').replace(/^\/+/, '')
}

function relativeToRoot(root, path) {
  const normalized = normalizeAbsolutePath(path)
  return root && normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : ''
}
