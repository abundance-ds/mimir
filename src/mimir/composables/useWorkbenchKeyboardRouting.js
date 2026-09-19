import { primaryModifierPressed } from '../../shared/platform.js'
import { useEditorUIStore } from '../../stores/editorUI.js'
import { nextTick, ref } from 'vue'
import { nextWorkbenchZoom, workbenchZoomKeyAction } from '../../shared/workbenchZoom.js'
import { closeCurrentWindow } from '../../services/window.js'
import { routeWorkbenchKey } from '../workbenchKeyboard.js'
import { shortcutForEvent } from '../../shared/shortcuts.js'

export function useWorkbenchKeyboardRouting({
  quickOpen,
  quickOpenInitialView = ref('root'),
  quickOpenPreferredTargetId = ref(''),
  settings,
  editorRef,
  editorFiles,
  workbench,
  sidebarActivities,
  sidebarSelection = ref([]),
  toggleSidebar,
  selectActivity,
  focusMain,
  closeActivity,
  closeActivities,
  closeWindow = closeCurrentWindow,
}) {
  const editorUI = useEditorUIStore()
  const lastFocus = ref({ owner: 'none', activityId: '' })

  function onKeydown(event) {
    if (event.isComposing || event.keyCode === 229) return
    const zoomAction = workbenchZoomKeyAction(event)
    const terminalChord = quickOpen.value && quickOpenInitialView.value === 'root'
      && shortcutForEvent(event, ['quick-open'])?.id === 'go-to-terminal'
    if (zoomAction && !terminalChord) {
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
      && primaryModifierPressed(event)
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
      primary: primaryModifierPressed(event),
      alt: event.altKey,
      shift: event.shiftKey,
      focusOwner: focus.owner,
      sidebarActivityId: focus.activityId,
      sidebarSelectionCount: sidebarSelection.value.length,
    })
    if (!result) return
    if (event.target?.closest?.('[data-tab-rename]') && ['close-editor', 'close-activity', 'close-focused', 'cycle-editor', 'cycle-activity'].includes(result.action)) return

    consume(event)
    if (result.action === 'new-tab') {
      openQuickOpen('tabs')
    } else if (result.action === 'new-document') {
      void newDocument()
    } else if (result.action === 'settings') {
      editorUI.settingsOpen = !editorUI.settingsOpen
    } else if (result.action === 'focus-main' || result.action === 'focus-editor') {
      void focusPanel(result.action === 'focus-main' ? 'activity' : 'editor')
    } else if (result.action === 'quick-open') {
      openQuickOpen()
    } else if (result.action === 'switch-project') {
      openQuickOpen('projects')
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
    } else if (result.action === 'close-focused') {
      closeForFocus(focus)
    } else if (result.action === 'close-selected-activities') {
      void closeActivities?.(sidebarSelection.value)
    } else if (result.action === 'close-activity') {
      closeForFocus({
        owner: 'activity',
        activityId: result.activityId || focus.activityId,
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
      return { owner: 'activity', activityId: element.closest('[data-main-tab]')?.getAttribute('data-main-tab') || '' }
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
    if (document.querySelector('[aria-modal="true"]')) return
    const current = keyboardFocus(document.activeElement)
    closeForFocus(current.owner === 'none' ? lastFocus.value : current)
  }

  function newNativeFocusedSurface() {
    if (quickOpen.value || document.querySelector('[aria-modal="true"]')) return
    void newDocument()
  }

  async function newDocument() {
    await editorRef.value?.mimirNewFile?.()
    workbench.setPaneState?.('editor', 'expanded')
    lastFocus.value = { owner: 'editor', activityId: '' }
    await nextTick()
    editorRef.value?.mimirFocus?.()
  }

  async function focusPanel(pane) {
    if (pane === 'editor') {
      const hasTabs = editorRef.value?.mimirHasOpenTabs?.() ?? Boolean((editorFiles.visibleOpenFiles || editorFiles.openFiles).length)
      if (!hasTabs) { await newDocument(); return }
    }
    workbench.setPaneState?.(pane, 'expanded')
    lastFocus.value = { owner: pane, activityId: '' }
    await nextTick()
    const target = document.querySelector(`[data-pane="${pane}"] [role="tab"][aria-selected="true"]`)
      || document.querySelector(`[data-pane="${pane}"] button:not(:disabled), [data-pane="${pane}"] [tabindex="0"]`)
    target?.focus()
    if (pane === 'editor') editorRef.value?.mimirFocus?.()
    else if (focusMain) focusMain()
    else if (workbench.activeActivityId) selectActivity(workbench.activeActivityId)
  }

  function openQuickOpen(view = 'root', preferredTargetId = '') {
    if (quickOpen.value || document.querySelector('[aria-modal="true"]')) return
    quickOpenInitialView.value = view
    quickOpenPreferredTargetId.value = preferredTargetId || ''
    quickOpen.value = true
  }

  function closeForFocus(focus) {
    const rows = sidebarActivities.value
    const visibleFiles = editorFiles.visibleOpenFiles || editorFiles.openFiles
    const hasEditorTabs = editorRef.value?.mimirHasOpenTabs?.() ?? Boolean(visibleFiles.length)
    if (focus.owner === 'editor' && hasEditorTabs) {
      void editorRef.value?.mimirCloseActiveTab?.()
      return
    }
    if (focus.owner === 'sidebar' && sidebarSelection.value.length) {
      void closeActivities?.(sidebarSelection.value)
      return
    }
    const tab = rows.find(tab => tab.id === focus.activityId)
      || rows.find(tab => tab.id === workbench.activeActivityId)
      || rows[0]
    if (tab) {
      void closeActivity(tab.id)
      return
    }
    if (hasEditorTabs) {
      void editorRef.value?.mimirCloseActiveTab?.()
      return
    }
    void closeWindow().catch(error => console.error('[workbench-close]', error))
  }

  function cycleActivity(direction, { focusSidebar = false, fromId = '' } = {}) {
    const rows = sidebarActivities.value
    if (!rows.length) return
    const index = rows.findIndex(
      activity => activity.id === (rows.some(tab => tab.id === fromId) ? fromId : workbench.activeActivityId),
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
