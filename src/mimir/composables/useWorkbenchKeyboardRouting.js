import { nextTick, ref } from 'vue'
import { nextWorkbenchZoom, workbenchZoomKeyAction } from '../../shared/workbenchZoom.js'
import { routeWorkbenchKey } from '../workbenchKeyboard.js'

export function useWorkbenchKeyboardRouting({
  quickOpen,
  quickOpenInitialView = ref('root'),
  quickOpenPreferredTargetId = ref(''),
  activityNewTargetId = ref(null),
  settings,
  editorRef,
  editorFiles,
  workbench,
  sidebarActivities,
  sidebarSelection = ref([]),
  toggleSidebar,
  selectActivity,
  closeActivity,
  closeActivities,
  collapseEmptyEditor,
}) {
  const lastFocus = ref({ owner: 'none', activityId: '' })

  function onKeydown(event) {
    const zoomAction = workbenchZoomKeyAction(event)
    if (zoomAction) {
      consume(event)
      settings.set(
        'workbenchZoom',
        nextWorkbenchZoom(settings.workbenchZoom, zoomAction),
      )
      return
    }
    // Escape belongs to the mounted Go to dialog so a nested view can consume
    // it as Back before the root view closes. This router runs in capture phase,
    // so handling Escape here would always skip the dialog's hierarchy.
    if (quickOpen.value && event.key === 'Escape') return
    if (
      quickOpen.value
      && (event.metaKey || event.ctrlKey)
      && event.key.toLowerCase() === 'w'
    ) {
      consume(event)
      quickOpen.value = false
      return
    }
    if (quickOpen.value) return
    if (document.querySelector('[aria-modal="true"]')) {
      // A modal that is still moving focus must never leak keystrokes into
      // CodeMirror or xterm behind it. Zoom was handled above and remains the
      // one deliberate global chord while a dialog is open. Popovers that are
      // teleported to body remain part of the modal interaction.
      if (!event.target?.closest?.('[aria-modal="true"], [data-modal-portal]')) consume(event)
      return
    }

    // WebKit never focuses buttons on click, so after a Sidebar click the
    // keydown target is <body>. Route by the last remembered pane instead of
    // dropping the shortcut.
    const direct = keyboardFocus(event.target)
    const focus = direct.owner === 'none' ? lastFocus.value : direct
    const result = routeWorkbenchKey({
      key: event.key,
      primary: event.metaKey || event.ctrlKey,
      alt: event.altKey,
      shift: event.shiftKey,
      focusOwner: focus.owner,
      sidebarActivityId: focus.activityId,
      sidebarSelectionCount: sidebarSelection.value.length,
      activityNewTargetId: activityNewTargetId.value,
    })
    if (!result) return

    consume(event)
    if (result.action === 'quick-open') {
      openQuickOpen()
    } else if (result.action === 'quick-open-new-activity') {
      openQuickOpen('new-activity', result.targetId)
    } else if (result.action === 'toggle-sidebar') {
      void toggleSidebar()
    } else if (result.action === 'cycle-editor') {
      editorRef.value?.mimirCycleTab?.(result.direction)
    } else if (result.action === 'cycle-activity') {
      cycleActivity(result.direction, {
        focusSidebar: focus.owner === 'sidebar',
        fromId: focus.activityId,
      })
    } else if (result.action === 'close-editor') {
      closeForFocus({ owner: 'editor', activityId: '' })
    } else if (result.action === 'close-selected-activities') {
      void closeActivities?.(sidebarSelection.value)
    } else if (result.action === 'close-activity') {
      closeForFocus({
        owner: result.activityId ? 'sidebar' : 'activity',
        activityId: result.activityId,
      })
    }
  }

  function keyboardFocus(target) {
    const element = typeof target?.closest === 'function'
      ? target
      : document.activeElement
    if (!element) return { owner: 'none', activityId: '' }
    if (element.closest('[data-pane="editor"]')) {
      return { owner: 'editor', activityId: '' }
    }
    if (element.closest('[data-pane="activity"]')) {
      return { owner: 'activity', activityId: '' }
    }
    if (element.closest('[data-pane="sidebar"]')) {
      const row = element.closest('[data-sidebar-row^="activity:"]')
      const value = row?.getAttribute('data-sidebar-row') || ''
      return {
        owner: 'sidebar',
        activityId: value.startsWith('activity:') ? value.slice('activity:'.length) : '',
      }
    }
    return { owner: 'none', activityId: '' }
  }

  function rememberWorkbenchFocus(event) {
    const focus = keyboardFocus(event.target)
    if (focus.owner !== 'none') lastFocus.value = focus
  }

  function closeNativeFocusedSurface() {
    if (quickOpen.value) {
      quickOpen.value = false
      return
    }
    const current = keyboardFocus(document.activeElement)
    closeForFocus(current.owner === 'none' ? lastFocus.value : current)
  }

  function newNativeFocusedSurface() {
    if (quickOpen.value || document.querySelector('[aria-modal="true"]')) return
    const current = keyboardFocus(document.activeElement)
    const focus = current.owner === 'none' ? lastFocus.value : current
    if (focus.owner === 'activity' && activityNewTargetId.value !== null) {
      openQuickOpen('new-activity', activityNewTargetId.value)
      return
    }
    editorRef.value?.mimirNewFile?.()
  }

  function openQuickOpen(view = 'root', preferredTargetId = '') {
    if (quickOpen.value || document.querySelector('[aria-modal="true"]')) return
    quickOpenInitialView.value = view
    quickOpenPreferredTargetId.value = preferredTargetId || ''
    quickOpen.value = true
  }

  function closeForFocus(focus) {
    if (focus.owner === 'editor') {
      const visibleFiles = editorFiles.visibleOpenFiles || editorFiles.openFiles
      if (!visibleFiles.length) collapseEmptyEditor()
      else void editorRef.value?.mimirCloseActiveTab?.()
      return
    }
    if (focus.owner === 'activity') {
      void closeActivity(workbench.activeActivityId)
      return
    }
    if (focus.owner === 'sidebar') {
      if (sidebarSelection.value.length) {
        void closeActivities?.(sidebarSelection.value)
        return
      }
      if (focus.activityId) void closeActivity(focus.activityId)
    }
  }

  function cycleActivity(direction, { focusSidebar = false, fromId = '' } = {}) {
    const rows = sidebarActivities.value
    if (!rows.length) return
    const index = rows.findIndex(
      activity => activity.id === (fromId || workbench.activeActivityId),
    )
    const start = index < 0 ? (direction > 0 ? -1 : 0) : index
    const next = (start + direction + rows.length) % rows.length
    const nextId = rows[next].id
    selectActivity(nextId)
    if (focusSidebar) {
      void nextTick(() => {
        const row = [...document.querySelectorAll('[data-sidebar-row]')]
          .find(element => (
            element.getAttribute('data-sidebar-row') === `activity:${nextId}`
          ))
        row?.querySelector('button')?.focus()
      })
    }
  }

  return {
    closeForFocus,
    closeNativeFocusedSurface,
    cycleActivity,
    keyboardFocus,
    lastFocus,
    newNativeFocusedSurface,
    onKeydown,
    openQuickOpen,
    rememberWorkbenchFocus,
  }
}

function consume(event) {
  event.preventDefault()
  event.stopImmediatePropagation()
}
