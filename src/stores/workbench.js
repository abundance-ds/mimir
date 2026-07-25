import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'

export const SIDEBAR_RAIL_WIDTH = 52
export const ACTIVITY_RAIL_WIDTH = 44
export const EDITOR_RAIL_WIDTH = 44

const PANE_IDS = ['sidebar', 'activity', 'editor']
const PANE_STATES = new Set(['expanded', 'rail'])

const DEFAULT_LAYOUT = Object.freeze({
  sidebar: Object.freeze({ state: 'expanded', width: 240 }),
  activity: Object.freeze({ state: 'expanded', width: 560 }),
  editor: Object.freeze({ state: 'expanded', width: 520 }),
})

const WIDTH_RANGES = Object.freeze({
  sidebar: Object.freeze({ min: 180, max: 320 }),
  activity: Object.freeze({ min: 336 }),
  editor: Object.freeze({ min: 336 }),
})

export const useWorkbenchStore = defineStore('workbench', () => {
  const paneLayout = reactive(cloneDefaultLayout())
  const activityHistory = ref(createHistory('files'))

  const activeActivityId = computed(() => activityHistory.value.current)
  const canGoPreviousActivity = computed(() => activityHistory.value.back.length > 0)
  const canGoNextActivity = computed(() => activityHistory.value.forward.length > 0)
  const expandedPanes = computed(() =>
    PANE_IDS.filter((pane) => paneLayout[pane].state === 'expanded'),
  )

  function setPaneState(pane, state) {
    assertPane(pane)
    if (!PANE_STATES.has(state)) throw new Error(`Unknown pane state '${state}'.`)

    paneLayout[pane].state = state
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
    const next = normalizedActivityId(id)
    const history = activityHistory.value
    if (history.current === next) return
    activityHistory.value = {
      current: next,
      back: history.current ? [...history.back, history.current] : [...history.back],
      forward: [],
    }
  }

  function previousActivity() {
    const history = activityHistory.value
    if (!history.back.length) return
    const previous = history.back[history.back.length - 1]
    activityHistory.value = {
      current: previous,
      back: history.back.slice(0, -1),
      forward: history.current ? [history.current, ...history.forward] : [...history.forward],
    }
  }

  function nextActivity() {
    const history = activityHistory.value
    if (!history.forward.length) return
    const [next, ...forward] = history.forward
    activityHistory.value = {
      current: next,
      back: history.current ? [...history.back, history.current] : [...history.back],
      forward,
    }
  }

  function resetForWorkspace() {
    restoreLayout(DEFAULT_LAYOUT)
    activityHistory.value = createHistory('files')
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
    activityHistory,
    activeActivityId,
    canGoPreviousActivity,
    canGoNextActivity,
    expandedPanes,
    setPaneState,
    togglePane,
    setPaneWidth,
    restoreLayout,
    layoutSnapshot,
    openActivity,
    previousActivity,
    nextActivity,
    resetForWorkspace,
  }
})

function createHistory(current = null) {
  return { current, back: [], forward: [] }
}

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

function normalizedActivityId(id) {
  const value = String(id || '').trim()
  if (!value) throw new Error('Activity id must not be empty.')
  return value
}

function assertPane(pane) {
  if (!PANE_IDS.includes(pane)) throw new Error(`Unknown pane '${pane}'.`)
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
