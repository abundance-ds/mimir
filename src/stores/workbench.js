import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'

export const SIDEBAR_RAIL_WIDTH = 52
export const ACTIVITY_RAIL_WIDTH = 44
export const EDITOR_RAIL_WIDTH = 44

const PANE_IDS = ['sidebar', 'activity', 'editor']
const PANE_STATES = new Set(['expanded', 'rail'])

const DEFAULT_LAYOUT = Object.freeze({
  sidebar: Object.freeze({ state: 'expanded', width: 280 }),
  activity: Object.freeze({ state: 'expanded', width: 560 }),
  editor: Object.freeze({ state: 'expanded', width: 520 }),
})

const WIDTH_RANGES = Object.freeze({
  sidebar: Object.freeze({ min: 240, max: 400 }),
  activity: Object.freeze({ min: 336 }),
  editor: Object.freeze({ min: 336 }),
})

export const useWorkbenchStore = defineStore('workbench', () => {
  const paneLayout = reactive(cloneDefaultLayout())
  const activeActivityId = ref('')
  const openTabIds = ref([])
  const singlePaneMode = ref(false)

  const expandedPanes = computed(() =>
    PANE_IDS.filter((pane) => paneLayout[pane].state === 'expanded'),
  )

  function setPaneState(pane, state) {
    assertPane(pane)
    if (!PANE_STATES.has(state)) throw new Error(`Unknown pane state '${state}'.`)

    paneLayout[pane].state = state
    if (state === 'expanded' && singlePaneMode.value && pane === 'activity') {
      paneLayout.editor.state = 'rail'
    }
    if (state === 'expanded' && singlePaneMode.value && pane === 'editor') {
      paneLayout.activity.state = 'rail'
    }
    if (state === 'rail' && pane === 'activity' && paneLayout.editor.state === 'rail') {
      paneLayout.editor.state = 'expanded'
    }
    if (state === 'rail' && pane === 'editor' && paneLayout.activity.state === 'rail') {
      paneLayout.activity.state = 'expanded'
    }
    normalizeLayout()
  }

  function togglePane(pane) {
    assertPane(pane)
    setPaneState(pane, paneLayout[pane].state === 'expanded' ? 'rail' : 'expanded')
  }

  function setPaneWidth(pane, width) {
    assertPane(pane)
    paneLayout[pane].width = clampPaneWidth(pane, width)
  }

  function setSinglePaneMode(enabled) {
    singlePaneMode.value = Boolean(enabled)
    if (
      singlePaneMode.value
      && paneLayout.activity.state === 'expanded'
      && paneLayout.editor.state === 'expanded'
    ) {
      paneLayout.activity.state = 'rail'
    }
  }

  function setActivityExpanded(expanded) {
    paneLayout.activity.state = 'expanded'
    paneLayout.editor.state = (expanded || singlePaneMode.value) ? 'rail' : 'expanded'
    normalizeLayout()
  }

  function setEditorExpanded(expanded) {
    paneLayout.editor.state = 'expanded'
    paneLayout.activity.state = (expanded || singlePaneMode.value) ? 'rail' : 'expanded'
    normalizeLayout()
  }

  function restoreLayout(value) {
    for (const pane of PANE_IDS) {
      const source = isRecord(value?.[pane]) ? value[pane] : null
      const fallback = DEFAULT_LAYOUT[pane]
      paneLayout[pane].state = PANE_STATES.has(source?.state) ? source.state : fallback.state
      paneLayout[pane].width = clampPaneWidth(
        pane,
        Number.isFinite(source?.width) ? source.width : fallback.width,
      )
    }
    normalizeLayout()
  }

  function layoutSnapshot() {
    return {
      sidebar: { ...paneLayout.sidebar },
      activity: { ...paneLayout.activity },
      editor: { ...paneLayout.editor },
    }
  }

  function openActivity(id) {
    const next = String(id || '').trim()
    if (next && !openTabIds.value.includes(next)) openTabIds.value.push(next)
    activeActivityId.value = next
  }

  function closeTab(id, visibleIds = openTabIds.value) {
    const index = visibleIds.indexOf(id)
    openTabIds.value = openTabIds.value.filter(tab => tab !== id)
    if (activeActivityId.value === id) {
      const remaining = visibleIds.filter(tab => tab !== id)
      activeActivityId.value = remaining[Math.min(Math.max(index, 0), remaining.length - 1)] || ''
    }
  }

  function restoreTabs(ids) {
    openTabIds.value = [...new Set((Array.isArray(ids) ? ids : []).filter(id => typeof id === 'string' && id))]
  }

  function reorderTabs(ids) {
    const visible = new Set(ids)
    let index = 0
    openTabIds.value = openTabIds.value.map(id => visible.has(id) ? ids[index++] : id)
  }

  function selectWorkspaceActivity(current = '') {
    openActivity(current)
  }

  function resetForWorkspace() {
    restoreLayout(DEFAULT_LAYOUT)
    selectWorkspaceActivity()
  }

  function normalizeLayout() {
    // Activity and Editor are the two content panes. Presenting both as rails
    // creates a shell with no working surface, even when Sidebar is expanded.
    if (paneLayout.activity.state === 'rail' && paneLayout.editor.state === 'rail') {
      paneLayout.activity.state = 'expanded'
    }

    if (expandedPanes.value.length === 0) {
      paneLayout.activity.state = 'expanded'
    }
  }

  return {
    paneLayout,
    openTabIds,
    closeTab,
    restoreTabs,
    reorderTabs,
    activeActivityId,
    expandedPanes,
    singlePaneMode,
    setPaneState,
    togglePane,
    setPaneWidth,
    setSinglePaneMode,
    setActivityExpanded,
    setEditorExpanded,
    restoreLayout,
    layoutSnapshot,
    openActivity,
    selectWorkspaceActivity,
    resetForWorkspace,
  }
})

function cloneDefaultLayout() {
  return {
    sidebar: { ...DEFAULT_LAYOUT.sidebar },
    activity: { ...DEFAULT_LAYOUT.activity },
    editor: { ...DEFAULT_LAYOUT.editor },
  }
}

function clampPaneWidth(pane, value) {
  const fallback = DEFAULT_LAYOUT[pane].width
  const range = WIDTH_RANGES[pane]
  const width = Number.isFinite(value) ? value : fallback
  const lower = Math.max(range.min, width)
  return Number.isFinite(range.max) ? Math.min(range.max, lower) : lower
}

function assertPane(pane) {
  if (!PANE_IDS.includes(pane)) throw new Error(`Unknown pane '${pane}'.`)
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
