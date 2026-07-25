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
  let activeSearchToken = null
  let refreshTimer = null

  const visibleFiles = computed(() => filteredFiles.value ?? files.value)
  const selectedFile = computed(() => visibleFiles.value[selectionIndex.value] || null)

  async function openWorkspace(path) {
    const next = String(path || '').trim()
    if (!next) throw new Error('Workspace path must not be empty.')
    loading.value = true
    error.value = ''
    try {
      files.value = await openWorkspaceIndex(next)
      workspacePath.value = next
      filteredFiles.value = null
      query.value = ''
      selectionIndex.value = 0
    } catch (cause) {
      error.value = errorMessage(cause)
      throw cause
    } finally {
      loading.value = false
    }
  }

  async function setQuery(value) {
    query.value = String(value || '')
    selectionIndex.value = 0
    if (!query.value.trim()) {
      filteredFiles.value = null
      return
    }
    const hits = await filterIndexedFiles(query.value, 250)
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
      error.value = ''
      return report
    } catch (cause) {
      error.value = errorMessage(cause)
      return null
    }
  }

  function startAutoRefresh(intervalMs = 1200) {
    stopAutoRefresh()
    refreshTimer = setInterval(refresh, intervalMs)
  }

  function stopAutoRefresh() {
    if (refreshTimer) clearInterval(refreshTimer)
    refreshTimer = null
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
    stopAutoRefresh()
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
    visibleFiles,
    selectedFile,
    openWorkspace,
    setQuery,
    moveSelection,
    selectPath,
    refresh,
    startAutoRefresh,
    stopAutoRefresh,
    searchContent,
    dispose,
  }
})

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || 'File index failed.')
}
