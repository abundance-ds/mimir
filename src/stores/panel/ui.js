import { ref, computed } from 'vue'
import { defineStore } from 'pinia'

const NARROW_PANEL_QUERY = '(max-width: 640px)'

function isNarrowPanel() {
  return Boolean(
    typeof window !== 'undefined'
    && window.matchMedia
    && window.matchMedia(NARROW_PANEL_QUERY).matches,
  )
}

export const usePanelUIStore = defineStore('panelUI', () => {
  const sidebarOpen = ref(true)
  const sidebarDragging = ref(false)
  const terminalOpen = ref(false)
  const mobileChatOpen = ref(false)
  const showAddProjectDialog = ref(false)
  const projectDialogMode = ref('new')
  const showSettingsDialog = ref(false)
  const searchQuery = ref('')
  const newChatStartMode = ref('chat')
  const storageReady = ref(false)
  const statusFilter = ref('')
  const projectHomeId = ref('')
  const undoToast = ref(null) // { message: string, snapshots: Array<{sessionId}>, timer: number } | null

  // Navigation history (browser-style back/forward)
  // Session entries: { type: 'session', id }
  // Project entries: { type: 'project', id, viewMode, entryId }
  const navHistory = ref([])
  const historyIndex = ref(-1)
  let _navigatingHistory = false
  const canGoBack = computed(() => historyIndex.value > 0)
  const canGoForward = computed(() => historyIndex.value < navHistory.value.length - 1)

  function toggleStatusFilter(kind) {
    statusFilter.value = statusFilter.value === kind ? '' : kind
  }

  function showProjectHome(id, viewMode = 'chat') {
    projectHomeId.value = id
    pushNavEntry({ type: 'project', id, viewMode, entryId: null })
    closeSidebarOnNarrow()
  }

  function closeProjectHome() {
    projectHomeId.value = ''
  }

  function setUndoToast(message, snapshots) {
    if (undoToast.value?.timer) clearTimeout(undoToast.value.timer)
    const timer = setTimeout(() => { undoToast.value = null }, 4000)
    undoToast.value = { message, snapshots, timer }
  }

  function clearUndoToast() {
    if (undoToast.value?.timer) clearTimeout(undoToast.value.timer)
    undoToast.value = null
  }

  function openSidebar() {
    sidebarOpen.value = true
  }

  function closeSidebar() {
    sidebarOpen.value = false
  }

  function toggleSidebar() {
    sidebarOpen.value = !sidebarOpen.value
  }

  function closeSidebarOnNarrow() {
    if (isNarrowPanel()) closeSidebar()
  }

  function openProjectDialog(mode = 'new') {
    projectDialogMode.value = mode === 'clone' ? 'clone' : 'new'
    showAddProjectDialog.value = true
  }

  function closeProjectDialog() {
    showAddProjectDialog.value = false
  }

  function pushNavEntry(entry) {
    if (_navigatingHistory) return
    const current = navHistory.value[historyIndex.value]
    if (current && current.type === entry.type && current.id === entry.id
      && current.viewMode === entry.viewMode && current.entryId === entry.entryId) return
    navHistory.value = navHistory.value.slice(0, historyIndex.value + 1)
    navHistory.value.push(entry)
    historyIndex.value = navHistory.value.length - 1
    if (navHistory.value.length > 100) {
      const excess = navHistory.value.length - 100
      navHistory.value.splice(0, excess)
      historyIndex.value -= excess
    }
  }

  function pushProjectNav(viewMode, entryId) {
    if (!projectHomeId.value) return
    pushNavEntry({ type: 'project', id: projectHomeId.value, viewMode, entryId: entryId || null })
  }

  function pushHistory(sessionId) {
    pushNavEntry({ type: 'session', id: sessionId })
  }

  function goBack() {
    if (!canGoBack.value) return null
    historyIndex.value--
    return navHistory.value[historyIndex.value]
  }

  function goForward() {
    if (!canGoForward.value) return null
    historyIndex.value++
    return navHistory.value[historyIndex.value]
  }

  function setNavigatingHistory(value) {
    _navigatingHistory = value
  }

  function isNavigatingHistory() {
    return _navigatingHistory
  }

  function normalizedQuery() {
    return searchQuery.value.trim().toLowerCase()
  }

  function toggleTerminal() { terminalOpen.value = !terminalOpen.value }
  function openTerminal() { terminalOpen.value = true }
  function closeTerminal() { terminalOpen.value = false }

  return {
    sidebarOpen,
    sidebarDragging,
    terminalOpen,
    toggleTerminal,
    openTerminal,
    closeTerminal,
    mobileChatOpen,
    showAddProjectDialog,
    projectDialogMode,
    showSettingsDialog,
    searchQuery,
    newChatStartMode,
    storageReady,
    statusFilter,
    projectHomeId,
    toggleStatusFilter,
    openSidebar,
    closeSidebar,
    toggleSidebar,
    closeSidebarOnNarrow,
    openProjectDialog,
    closeProjectDialog,
    showProjectHome,
    closeProjectHome,
    undoToast,
    setUndoToast,
    clearUndoToast,
    normalizedQuery,
    navHistory,
    historyIndex,
    canGoBack,
    canGoForward,
    pushHistory,
    pushProjectNav,
    goBack,
    goForward,
    setNavigatingHistory,
    isNavigatingHistory,
  }
})
