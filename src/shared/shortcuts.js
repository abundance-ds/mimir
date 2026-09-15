import { primaryModifierPressed, platformKind } from './platform.js'

// Binding, scope and user-facing label have one owner. 'panel' actions resolve
// their target in the Workbench; 'editor' actions require Editor focus.
export const SHORTCUTS = [
  { id: 'quick-open', scope: 'global', label: 'Go to', key: 'p' },
  { id: 'switch-project', scope: 'global', label: 'Switch project', key: 'p', shift: true },
  { id: 'new-tab', scope: 'global', label: 'New Main tab', key: 't' },
  { id: 'new-document', scope: 'global', label: 'New Editor document', key: 'n' },
  { id: 'toggle-sidebar', scope: 'global', label: 'Expand/collapse Sidebar', key: 'b' },
  { id: 'settings', scope: 'global', label: 'Settings', key: ',' },
  { id: 'focus-main', scope: 'global', label: 'Focus Main', key: '1' },
  { id: 'focus-editor', scope: 'global', label: 'Focus Editor', key: '2' },
  { id: 'zoom-in', scope: 'global', label: 'Zoom interface in', key: '+', aliases: ['='], codes: ['Equal', 'NumpadAdd'], shift: null },
  { id: 'zoom-out', scope: 'global', label: 'Zoom interface out', key: '-', aliases: ['_'], codes: ['Minus', 'NumpadSubtract'], shift: null },
  { id: 'zoom-reset', scope: 'global', label: 'Reset interface zoom', key: '0', codes: ['Digit0', 'Numpad0'], shift: null },
  { id: 'close', scope: 'panel', label: 'Close tab in focused panel', key: 'w' },
  { id: 'cycle-previous', scope: 'panel', label: 'Previous tab in focused panel', key: 'ArrowLeft', alt: true, direction: -1 },
  { id: 'cycle-next', scope: 'panel', label: 'Next tab in focused panel', key: 'ArrowRight', alt: true, direction: 1 },
  { id: 'inline-ai', scope: 'editor', label: 'Inline AI', key: 'k' },
  { id: 'toolbar', scope: 'editor', label: 'Show/hide Editor toolbar', key: '/' },
  { id: 'bold', scope: 'editor', label: 'Bold', key: 'b', shift: true, format: 'bold' },
  { id: 'italic', scope: 'editor', label: 'Italic', key: 'i', format: 'italic' },
  { id: 'strikethrough', scope: 'editor', label: 'Strikethrough', key: 'x', shift: true, format: 'strikethrough' },
  { id: 'bullet-list', scope: 'editor', label: 'Bullet list', key: '8', code: 'Digit8', shift: true, format: 'bullet-list' },
  { id: 'numbered-list', scope: 'editor', label: 'Numbered list', key: '7', code: 'Digit7', shift: true, format: 'numbered-list' },
  { id: 'blockquote', scope: 'editor', label: 'Blockquote', key: '>', shift: true, format: 'blockquote' },
  { id: 'open-file', scope: 'editor', label: 'Open file', key: 'o' },
  { id: 'save', scope: 'editor', label: 'Save', key: 's' },
  { id: 'save-as', scope: 'editor', label: 'Save as', key: 's', shift: true },
]

export function matchShortcut({ key = '', code = '', primary = false, alt = false, shift = false }, scopes = ['global', 'panel', 'editor']) {
  if (!primary) return null
  return SHORTCUTS.find(binding => scopes.includes(binding.scope)
    && Boolean(binding.alt) === Boolean(alt)
    && (binding.shift === null || Boolean(binding.shift) === Boolean(shift))
    && (binding.code ? binding.code === code : (
      [binding.key, ...(binding.aliases || [])].some(value => value.toLowerCase() === key.toLowerCase())
      || binding.codes?.includes(code)
    ))) || null
}

export function shortcutForEvent(event, scopes) {
  if (event.isComposing || event.keyCode === 229) return null
  return matchShortcut({ key: event.key, code: event.code, primary: primaryModifierPressed(event), alt: event.altKey, shift: event.shiftKey }, scopes)
}

export function shortcutKeys(binding) {
  const mac = platformKind() === 'macos'
  const displayKey = { ArrowLeft: '←', ArrowRight: '→' }[binding.key] || binding.key.toUpperCase()
  return [...(binding.alt ? [mac ? '⌥' : 'Alt'] : []), ...(binding.shift ? [mac ? '⇧' : 'Shift'] : []), mac ? '⌘' : 'Ctrl', displayKey]
}

export function editorKeyBinding(id) {
  const binding = SHORTCUTS.find(item => item.id === id)
  return `${binding.alt ? 'Alt-' : ''}${binding.shift ? 'Shift-' : ''}Mod-${binding.key}`
}
