import { onMounted, onUnmounted } from 'vue'
import { useEditorUIStore } from '../../stores/editorUI.js'
import { useSettingsStore } from '../../stores/settings.js'
import { useFileStore } from '../../stores/files.js'
import { primaryModifierPressed } from '../../shared/platform.js'
import { workbenchZoomKeyAction, nextWorkbenchZoom } from '../../shared/workbenchZoom.js'

export function useKeyboardShortcuts({
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
    const mod = primaryModifierPressed(e)
    const key = e.key.toLowerCase()

    // Interface zoom for the standalone editor window. Inside the workbench
    // this never fires: WorkbenchApp handles zoom chords at capture phase and
    // stops propagation. Editor content zoom stays on the footer controls.
    const zoomAction = workbenchZoomKeyAction(e)
    if (zoomAction) {
      e.preventDefault()
      settings.set('workbenchZoom', nextWorkbenchZoom(settings.workbenchZoom, zoomAction))
      return
    }

    if (mod && e.key === ',') {
      e.preventDefault()
      ui.settingsOpen = !ui.settingsOpen
      return
    }
    if (mod && e.key === '/') {
      e.preventDefault()
      settings.set(
        'editorToolbarMode',
        settings.editorToolbarMode === 'none' ? 'top' : 'none',
      )
    }
    if (mod && e.shiftKey && key === 'b') {
      e.preventDefault()
      onFormat('bold')
    }
    if (mod && !e.shiftKey && key === 'i') {
      e.preventDefault()
      onFormat('italic')
    }
    // Strikethrough
    if (mod && e.shiftKey && key === 'x') {
      e.preventDefault()
      onFormat('strikethrough')
    }
    // Bullet list
    if (mod && e.shiftKey && e.code === 'Digit8') {
      e.preventDefault()
      onFormat('bullet-list')
    }
    // Numbered list
    if (mod && e.shiftKey && e.code === 'Digit7') {
      e.preventDefault()
      onFormat('numbered-list')
    }
    // Blockquote
    if (mod && e.shiftKey && e.key === '>') {
      e.preventDefault()
      onFormat('blockquote')
    }
    if (mod && e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      if (!editorHasFocus()) return
      e.preventDefault()
      const len = files.openFiles.length
      if (len > 1) {
        const cur = files.activeFileIndex
        const next = e.key === 'ArrowLeft'
          ? (cur - 1 + len) % len
          : (cur + 1) % len
        files.setActiveTab(next)
      }
      return
    }
    // File operations
    if (mod && !e.shiftKey && key === 'o') {
      e.preventDefault()
      onOpenDialog()
    }
    if (mod && !e.shiftKey && key === 's') {
      e.preventDefault()
      onSave()
    }
    if (mod && e.shiftKey && key === 's') {
      e.preventDefault()
      onSaveAs()
    }
    if (mod && !e.shiftKey && key === 't') {
      e.preventDefault()
      onNewTab()
    }
    if (mod && !e.shiftKey && key === 'n') {
      e.preventDefault()
      onNewFile()
    }
    if (mod && !e.shiftKey && key === 'w') {
      if (!editorHasFocus()) return
      e.preventDefault()
      onCloseTab()
    }
  }

  onMounted(() => document.addEventListener('keydown', onKeydown))
  onUnmounted(() => document.removeEventListener('keydown', onKeydown))
}
