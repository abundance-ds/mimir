import { SAVE_STATE } from '../shared/saveState.js'
import { basename } from '../shared/utils/path.js'

function status(label, tone, action = null, title = '', detail = '', detailTone = '') {
  const next = { label, tone, action, title }
  if (detail) {
    next.detail = detail
    next.detailTone = detailTone
  }
  return next
}

export function fileDisplayName(file, { untitledIndex } = {}) {
  if (!file) return ''
  if (file.meta?.scratchpad) return 'Scratchpad'
  if (file.graph?.node) return (file.dirty && file.kind === 'graph'
    ? file.graph.draft?.title : file.graph.node.title) || 'Untitled entry'
  if (file.path) return basename(file.path)
  const n = untitledIndex ?? 1
  return n === 1 ? 'Untitled.md' : `Untitled-${n}.md`
}

export function tabSaveTone(file, { autoSaveEnabled = true } = {}) {
  if (!file) return 'clean'
  if (file.saveState === SAVE_STATE.failed) return 'failed'
  if (!file.dirty) return 'clean'
  if (!file.path) return 'dirty'
  return autoSaveEnabled ? 'clean' : 'dirty'
}

export function tabFromFile(file, options = {}) {
  const saveTone = tabSaveTone(file, options)
  return {
    id: file.id,
    name: fileDisplayName(file, options),
    path: file.path || '',
    dirty: saveTone !== 'clean',
    saveTone,
    preview: Boolean(file.preview),
    kind: file.kind || 'text',
  }
}

export function footerSaveStatus({
  file,
  autoSaveEnabled = true,
  savingVisible = false,
  savedVisible = false,
  savedLabel = '',
} = {}) {
  if (!file) return status('', 'quiet')

  if (file.saveState === SAVE_STATE.failed) {
    return status('Save failed', 'failed', 'retry', 'Retry save')
  }

  if (file.saveState === SAVE_STATE.saving) {
    if (autoSaveEnabled && file.path) {
      return savingVisible
        ? status('Auto-save on', 'auto', 'settings', 'Auto-save settings', 'Saving...', 'saving')
        : status('Auto-save on', 'auto', 'settings', 'Auto-save settings')
    }

    return savingVisible
      ? status('Saving...', 'saving')
      : status('Saving...', 'saving')
  }

  if (file.saveState === SAVE_STATE.saved && savedVisible) {
    if (autoSaveEnabled && file.path) {
      return status('Auto-save on', 'auto', 'settings', 'Auto-save settings', savedLabel || 'Saved', 'confirmed')
    }

    return status(savedLabel || 'Saved', 'confirmed')
  }

  if (file.dirty && !file.path) {
    return status('Unsaved draft', 'dirty', 'saveAs', 'Save draft')
  }

  if (file.dirty && !autoSaveEnabled) {
    return status('Unsaved changes', 'dirty', 'save', 'Save now')
  }

  if (file.dirty && autoSaveEnabled) {
    return status('Auto-save on', 'auto', 'settings', 'Auto-save settings')
  }

  if (file.path && autoSaveEnabled) {
    return status('Auto-save on', 'auto', 'settings', 'Auto-save settings')
  }

  if (file.path) {
    return status('Saved', 'saved')
  }

  return status('', 'quiet')
}
