import { onMounted, onUnmounted } from 'vue'
import { useEditorUIStore } from '../../stores/editorUI.js'
import { useSettingsStore } from '../../stores/settings.js'
import { useFileStore } from '../../stores/files.js'
import { primaryModifierPressed } from '../../shared/platform.js'

function hasZoomModifier(e) {
  return (e.metaKey || e.ctrlKey) && !e.altKey
}

function isZoomInKey(e) {
  return e.key === '+' || e.key === '=' || e.code === 'Equal' || e.code === 'NumpadAdd'
}

function isZoomOutKey(e) {
  return e.key === '-' || e.key === '_' || e.code === 'Minus' || e.code === 'NumpadSubtract'
}

export function useKeyboardShortcuts({
  onFormat,
  onSave,
  onSaveAs,
  onOpenDialog,
  onNewFile,
  onNewTab,
  onCloseTab,
  onRewriteSelection,
  cycleViewMode,
  editorHasFocus,
}) {
  const ui = useEditorUIStore()
  const settings = useSettingsStore()
  const files = useFileStore()

  function onKeydown(e) {
    const mod = primaryModifierPressed(e)
    const key = e.key.toLowerCase()

    if (editorHasFocus() && hasZoomModifier(e)) {
      if (isZoomInKey(e)) {
        e.preventDefault()
        ui.zoomIn()
        return
      }
      if (isZoomOutKey(e)) {
        e.preventDefault()
        ui.zoomOut()
        return
      }
    }

    if (mod && e.key === ',') {
      e.preventDefault()
      ui.settingsOpen = !ui.settingsOpen
      return
    }
    if (mod && e.key === '\\') {
      e.preventDefault()
      ui.toggleSidebar()
    }
    if (mod && e.key === '/') {
      e.preventDefault()
      settings.editorToolbarMode = settings.editorToolbarMode === 'none' ? 'top' : 'none'
    }
    if (mod && !e.shiftKey && key === 'b') {
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
    if (mod && e.shiftKey && key === 'c') {
      e.preventDefault()
      onFormat('cite')
    }
    if (mod && !e.shiftKey && key === 'e') {
      e.preventDefault()
      cycleViewMode()
    }
    if (mod && e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
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
      e.preventDefault()
      onCloseTab()
    }
  }

  onMounted(() => document.addEventListener('keydown', onKeydown))
  onUnmounted(() => document.removeEventListener('keydown', onKeydown))
}
