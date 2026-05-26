import { ref, computed } from 'vue'
import { defineStore } from 'pinia'

const VALID_PANELS = new Set(['outline', 'notes', 'refs', 'history'])
const NARROW_EDITOR_QUERY = '(max-width: 760px)'

function isNarrowEditor() {
  return Boolean(
    typeof window !== 'undefined'
    && window.matchMedia
    && window.matchMedia(NARROW_EDITOR_QUERY).matches,
  )
}

export const useEditorUIStore = defineStore('editorUI', () => {
  const activePanel = ref('outline')
  const panelOpen = ref(false)
  const sidebarVisible = ref(true)
  const viewMode = ref('source')
  const activeTab = ref(0)
  const zoomLevel = ref(100)
  const settingsOpen = ref(false)
  const settingsTab = ref('editor')
  const historyAvailable = ref(false)

  const panelShown = computed(() =>
    panelOpen.value && sidebarVisible.value,
  )

  function selectPanel(panel) {
    if (panel === 'settings') {
      settingsOpen.value = true
      return
    }
    if (!VALID_PANELS.has(panel)) return
    if (activePanel.value === panel && panelOpen.value && sidebarVisible.value) {
      panelOpen.value = false
    } else {
      activePanel.value = panel
      panelOpen.value = true
      sidebarVisible.value = true
    }
  }

  function openPanel(panel) {
    if (!VALID_PANELS.has(panel)) return
    activePanel.value = panel
    panelOpen.value = true
    sidebarVisible.value = true
  }

  function toggleSidebar() {
    panelOpen.value = !panelOpen.value
    sidebarVisible.value = true
  }

  function closePanel() {
    panelOpen.value = false
    sidebarVisible.value = true
  }

  function closePanelOnNarrow() {
    if (isNarrowEditor()) closePanel()
  }

  function setViewMode(mode) {
    viewMode.value = mode
  }

  function setActiveTab(idx) {
    activeTab.value = idx
  }

  function zoomIn() {
    zoomLevel.value = Math.min(200, zoomLevel.value + 5)
  }

  function zoomOut() {
    zoomLevel.value = Math.max(25, zoomLevel.value - 5)
  }

  function setZoomLevel(level) {
    zoomLevel.value = level
  }

  return {
    activePanel,
    panelOpen,
    sidebarVisible,
    viewMode,
    activeTab,
    zoomLevel,
    settingsOpen,
    settingsTab,
    historyAvailable,
    panelShown,
    selectPanel,
    openPanel,
    toggleSidebar,
    closePanel,
    closePanelOnNarrow,
    setViewMode,
    setActiveTab,
    zoomIn,
    zoomOut,
    setZoomLevel,
  }
})
