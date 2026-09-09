import { onMounted, onUnmounted } from 'vue'
import { useEditorUIStore } from '../../stores/editorUI.js'
import { useSettingsStore } from '../../stores/settings.js'
import { useFileStore } from '../../stores/files.js'
import { shortcutForEvent } from '../../shared/shortcuts.js'
import { workbenchZoomKeyAction, nextWorkbenchZoom } from '../../shared/workbenchZoom.js'

export function useKeyboardShortcuts({
  embedded = false,
  onFormat,
  onSave,
  onSaveAs,
  onOpenDialog,
  onNewFile,
  onNewTab,
  onCloseTab,
  onRewriteSelection,
  editorHasFocus,
}) {
  const ui = useEditorUIStore()
  const settings = useSettingsStore()
  const files = useFileStore()

  function onKeydown(e) {
    if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return
    // The Workbench capture handler consumes global bindings. This also
    // supplies those commands when the Editor runs in its standalone window.
    const zoomAction = workbenchZoomKeyAction(e)
    if (zoomAction) {
      e.preventDefault()
      settings.set('workbenchZoom', nextWorkbenchZoom(settings.workbenchZoom, zoomAction))
      return
    }
    const binding = shortcutForEvent(e)
    if (!binding) return
    if (embedded && binding.scope === 'global') return
    if (binding.id === 'settings') {
      e.preventDefault()
      ui.settingsOpen = !ui.settingsOpen
      return
    }
    if (document.querySelector('[aria-modal="true"]')) return
    if (binding.id === 'new-document' || binding.id === 'new-tab') {
      e.preventDefault()
      if (binding.id === 'new-document') onNewFile()
      else onNewTab()
      return
    }
    if (!editorHasFocus()) return
    const input = e.target?.closest?.('input, textarea, [contenteditable="true"]')
    if (input && !input.closest('.cm-editor')) return
    if (binding.id === 'inline-ai') return // CodeMirror owns its selection command.
    if (binding.format) { e.preventDefault(); onFormat(binding.format); return }
    if (binding.id === 'toolbar') {
      e.preventDefault()
      settings.set('editorToolbarMode', settings.editorToolbarMode === 'none' ? 'top' : 'none')
      return
    }
    if (binding.id.startsWith('cycle-')) {
      e.preventDefault()
      const len = files.visibleOpenFiles.length
      if (len > 1) files.setActiveVisibleTab((files.activeVisibleFileIndex + binding.direction + len) % len)
      return
    }
    const actions = { 'open-file': onOpenDialog, save: onSave, 'save-as': onSaveAs, close: onCloseTab }
    if (actions[binding.id]) { e.preventDefault(); actions[binding.id]() }
  }

  onMounted(() => document.addEventListener('keydown', onKeydown))
  onUnmounted(() => document.removeEventListener('keydown', onKeydown))
}
