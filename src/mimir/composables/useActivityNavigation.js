import { computed, nextTick, ref, watch } from 'vue'
import { usePointerReorder } from './usePointerReorder.js'

// Shared labels keep every close control on the same lifecycle action.
export function activityCloseLabel(tab) {
  const live = ['starting', 'working', 'needs-input', 'idle'].includes(tab.status)
    && tab.host?.type === 'pty'
  return live ? 'Stop and archive' : tab.unique ? 'Close' : 'Archive'
}

export const activityNavigationStatus = (tab, props) =>
    tab.status === 'error' || tab.error
      ? 'Error'
      : props.blockingIds.has(tab.id) || tab.status === 'needs-input'
        ? 'Needs input'
        : tab.unread
          ? 'Unread'
          : props.restoringIds.has(tab.id)
            ? 'Resuming'
            : ({ starting: 'Starting', working: 'Working', idle: 'Idle', done: 'Done', interrupted: 'Interrupted' }[tab.status] || '')

export function useActivityRename(emit, { canRename, focus }) {
  const renaming = ref(''), draft = ref(''), renameInput = ref(null)
  async function beginRename(tab) {
    if (!tab || tab.unique || !canRename()) return
    renaming.value = tab.id
    draft.value = tab.title
    await nextTick()
    const field = Array.isArray(renameInput.value)
      ? renameInput.value[0]
      : renameInput.value
    field?.focus()
    field?.select()
  }
  function cancelRename() {
    renaming.value = ''
  }
  function renameKey(event) {
    event.stopPropagation()
    if (event.isComposing || event.keyCode === 229) return
    if (event.key === 'Escape') {
      event.preventDefault()
      const id = renaming.value
      cancelRename()
      focus(id)
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const title = draft.value.trim(), id = renaming.value
      if (!title) return
      cancelRename()
      emit('rename', { id, title })
      focus(id)
    }
  }
  return { renaming, draft, renameInput, beginRename, cancelRename, renameKey }
}

// Main tabs and Sidebar rows send the same actions to the Workbench authority.
// Only keyboard direction, geometry, and transient edit/menu state differ.
export function useActivityNavigation(props, emit, {
  root,
  axis = 'x',
  rowSelector = '[data-main-tab]',
  keyAttribute = 'data-main-tab',
  buttonSelector = '[role="tab"]',
  hidden = () => false,
}) {
  const context = ref(null), contextId = ref('')
  const { renaming, draft, renameInput, beginRename, cancelRename, renameKey } = useActivityRename(emit, {
    canRename: () => !hidden() && !props.rail,
    focus: focusTab,
  })
  const contextTab = computed(() => props.tabs.find(tab => tab.id === contextId.value))
  const closeLabel = activityCloseLabel
  const status = (tab) => activityNavigationStatus(tab, props)
  const needsAttention = (tab) => ['Error', 'Needs input', 'Unread'].includes(status(tab))
  const tabTitle = (tab) =>
    `${tab.title}${status(tab) ? ` — ${status(tab)}` : ''}`
  const contextItems = computed(() =>
    contextTab.value
      ? [
          ...(!contextTab.value.unique && !props.rail
            ? [{ id: 'rename', label: 'Rename…', detail: 'F2' }]
            : []),
          { id: 'close', label: closeLabel(contextTab.value), detail: '⌘W' },
          {
            id: 'left',
            label: axis === 'x' ? 'Move tab left' : 'Move up',
            disabled: props.tabs[0]?.id === contextTab.value.id,
          },
          {
            id: 'right',
            label: axis === 'x' ? 'Move tab right' : 'Move down',
            disabled: props.tabs.at(-1)?.id === contextTab.value.id,
          },
        ]
      : [],
  )
  const reorder = usePointerReorder({
    root,
    axis,
    rowSelector,
    keyAttribute,
    keys: () => props.tabs.map((tab) => tab.id),
    onReorder: (ids) => emit('reorder', ids),
  })
  function select(id) {
    if (!reorder.suppressClick.value) emit('select', id)
  }
  function rowFor(id) {
    return [...(root.value?.querySelectorAll(rowSelector) || [])]
      .find(el => el.getAttribute(keyAttribute) === id)
  }
  function focusTab(id) {
    nextTick(() => rowFor(id)?.querySelector(buttonSelector)?.focus())
  }
  function showContext(tab, event) {
    contextId.value = tab.id
    context.value?.show(event)
  }
  function contextAction(action) {
    const tab = props.tabs.find(tab => tab.id === contextTab.value?.id)
    if (!tab) return
    if (action === 'rename') {
      void nextTick(() => beginRename(tab))
      return
    }
    if (action === 'close') {
      emit('close', tab.id)
      return
    }
    const ids = props.tabs.map((t) => t.id),
      from = ids.indexOf(tab.id),
      to = from + (action === 'left' ? -1 : 1)
    if (to >= 0 && to < ids.length) {
      ;[ids[from], ids[to]] = [ids[to], ids[from]]
      emit('reorder', ids)
    }
  }
  function onKeydown(event) {
    if (
      event.isComposing ||
      event.target?.closest('input') ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey
    )
      return
    const tabButton = event.target?.closest(buttonSelector)
    if (!tabButton) return
    const tab = props.tabs.find((t) => t.id === tabButton.closest(rowSelector)?.getAttribute(keyAttribute))
    if (!tab) return
    if (event.key === 'F2') {
      event.preventDefault()
      beginRename(tab)
      return
    }
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault()
      const r = event.target.getBoundingClientRect()
      showContext(tab, { clientX: r.left, clientY: r.bottom, currentTarget: tabButton.closest(rowSelector) })
      return
    }
    const previous = axis === 'x' ? 'ArrowLeft' : 'ArrowUp'
    const following = axis === 'x' ? 'ArrowRight' : 'ArrowDown'
    if (event.shiftKey || ![previous, following, 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const i = props.tabs.indexOf(tab),
      n = props.tabs.length
    const next =
      props.tabs[
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? n - 1
            : (i + (event.key === following ? 1 : -1) + n) % n
      ]
    if (axis === 'x') emit('select', next.id)
    focusTab(next.id)
  }
  watch(
    () => [props.activeId, hidden()],
    async ([id, isHidden]) => {
      cancelRename()
      context.value?.close()
      if (isHidden) return
      await nextTick()
      rowFor(id)?.scrollIntoView?.({ behavior: 'auto', block: 'nearest', inline: 'nearest' })
    },
  )
  watch(() => props.rail, () => {
    cancelRename()
    context.value?.close()
  })
  watch(() => props.tabs.map(tab => tab.id), ids => {
    if (renaming.value && !ids.includes(renaming.value)) cancelRename()
    if (contextId.value && !ids.includes(contextId.value)) context.value?.close()
  })
  return {
    context, renaming, draft, renameInput, closeLabel, status, needsAttention,
    tabTitle, contextItems, reorder, select, beginRename, cancelRename,
    renameKey, showContext, contextAction, onKeydown,
  }
}
