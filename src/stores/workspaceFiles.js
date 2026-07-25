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
  let activeSearchToken = null
  let queryGeneration = 0

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
      await loadDirectory('')
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
      await loadDirectory(currentDirectory.value)
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

  async function dispose() {
    queryGeneration += 1
    if (activeSearchToken) await cancelContentSearch(activeSearchToken)
    activeSearchToken = null
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
    visibleFiles,
    selectedFile,
    breadcrumbs,
    openWorkspace,
    loadDirectory,
    openDirectory,
    openParentDirectory,
    setQuery,
    moveSelection,
    selectPath,
    refresh,
    searchContent,
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
