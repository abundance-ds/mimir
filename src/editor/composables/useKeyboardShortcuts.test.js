import { defineComponent } from 'vue'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useEditorUIStore } from '../../stores/editorUI.js'
import { useSettingsStore } from '../../stores/settings.js'
import { useFileStore } from '../../stores/files.js'
import { useKeyboardShortcuts } from './useKeyboardShortcuts.js'

const mounted = []

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
})

function mountShortcuts(overrides = {}) {
  const handlers = {
    onFormat: vi.fn(),
    onSave: vi.fn(),
    onSaveAs: vi.fn(),
    onOpenDialog: vi.fn(),
    onNewFile: vi.fn(),
    onNewTab: vi.fn(),
    onCloseTab: vi.fn(),
    onRewriteSelection: vi.fn(),
    editorHasFocus: () => true,
    ...overrides,
  }
  const Host = defineComponent({
    setup() {
      useKeyboardShortcuts(handlers)
      return () => null
    },
  })
  const wrapper = mount(Host)
  mounted.push(wrapper)
  return { wrapper, handlers }
}

// Both modifier flags set so the chords hold on every platform regime of
// primaryModifierPressed (Cmd on macOS, Ctrl elsewhere).
function press(key, { shift = false, alt = false, mod = true, code = '' } = {}) {
  const event = new KeyboardEvent('keydown', {
    key,
    code,
    shiftKey: shift,
    altKey: alt,
    metaKey: mod,
    ctrlKey: mod,
    bubbles: true,
    cancelable: true,
  })
  document.dispatchEvent(event)
  return event
}

describe('useKeyboardShortcuts', () => {
  it('leaves Editor actions alone when another panel has focus', () => {
    const { handlers } = mountShortcuts({ editorHasFocus: () => false, embedded: true })
    for (const key of ['s', 'o', 'i', '/']) press(key)
    press('b', { shift: true })
    expect(handlers.onSave).not.toHaveBeenCalled()
    expect(handlers.onOpenDialog).not.toHaveBeenCalled()
    expect(handlers.onFormat).not.toHaveBeenCalled()
  })

  it('does not run global fallbacks or format unrelated text inputs inside the embedded Editor', () => {
    const { handlers } = mountShortcuts({ embedded: true })
    press('n')
    press('t')
    expect(handlers.onNewFile).not.toHaveBeenCalled()
    expect(handlers.onNewTab).not.toHaveBeenCalled()
    const input = document.createElement('input')
    document.body.append(input)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', ctrlKey: true, metaKey: true, bubbles: true }))
    expect(handlers.onFormat).not.toHaveBeenCalled()
    input.remove()
  })

  it('toggles the settings dialog on Mod+,', () => {
    mountShortcuts()
    const ui = useEditorUIStore()

    const event = press(',')
    expect(ui.settingsOpen).toBe(true)
    expect(event.defaultPrevented).toBe(true)

    press(',')
    expect(ui.settingsOpen).toBe(false)
  })

  it('toggles the toolbar between top and none on Mod+/', () => {
    mountShortcuts()
    const settings = useSettingsStore()
    expect(settings.editorToolbarMode).toBe('top')

    press('/')
    expect(settings.editorToolbarMode).toBe('none')
    press('/')
    expect(settings.editorToolbarMode).toBe('top')
  })

  it('steps interface zoom on Mod+= / Mod+- and resets on Mod+0', () => {
    const { handlers } = mountShortcuts()
    const settings = useSettingsStore()
    expect(settings.workbenchZoom).toBe(100)

    press('=', { code: 'Equal' })
    expect(settings.workbenchZoom).toBe(110)
    press('=', { code: 'Equal' })
    expect(settings.workbenchZoom).toBe(125)
    press('-', { code: 'Minus' })
    expect(settings.workbenchZoom).toBe(110)
    press('0', { code: 'Digit0' })
    expect(settings.workbenchZoom).toBe(100)

    // Zoom chords return early and never reach other handlers.
    expect(handlers.onFormat).not.toHaveBeenCalled()
    expect(handlers.onSave).not.toHaveBeenCalled()
  })

  it('dispatches formatting chords with their exact modifier shapes', () => {
    const { handlers } = mountShortcuts()

    press('b', { shift: true })
    expect(handlers.onFormat).toHaveBeenLastCalledWith('bold')

    press('i')
    expect(handlers.onFormat).toHaveBeenLastCalledWith('italic')

    press('x', { shift: true })
    expect(handlers.onFormat).toHaveBeenLastCalledWith('strikethrough')

    press('*', { shift: true, code: 'Digit8' })
    expect(handlers.onFormat).toHaveBeenLastCalledWith('bullet-list')

    press('&', { shift: true, code: 'Digit7' })
    expect(handlers.onFormat).toHaveBeenLastCalledWith('numbered-list')

    press('>', { shift: true })
    expect(handlers.onFormat).toHaveBeenLastCalledWith('blockquote')

    expect(handlers.onFormat).toHaveBeenCalledTimes(6)
  })

  it('ignores wrong-shift variants and unmodified keys', () => {
    const { handlers } = mountShortcuts()

    press('i', { shift: true }) // italic requires no shift
    press('b') // bold requires shift
    press('s', { mod: false })
    press('i', { mod: false })

    expect(handlers.onFormat).not.toHaveBeenCalled()
    expect(handlers.onSave).not.toHaveBeenCalled()
  })

  it('routes file operations to their handlers', () => {
    const { handlers } = mountShortcuts()

    press('s')
    expect(handlers.onSave).toHaveBeenCalledTimes(1)
    expect(handlers.onSaveAs).not.toHaveBeenCalled()

    press('s', { shift: true })
    expect(handlers.onSaveAs).toHaveBeenCalledTimes(1)
    expect(handlers.onSave).toHaveBeenCalledTimes(1)

    press('o')
    expect(handlers.onOpenDialog).toHaveBeenCalledTimes(1)
    press('t')
    expect(handlers.onNewTab).toHaveBeenCalledTimes(1)
    press('n')
    expect(handlers.onNewFile).toHaveBeenCalledTimes(1)
  })

  it('closes the tab on Mod+w only while the editor has focus', () => {
    let focused = false
    const { handlers } = mountShortcuts({ editorHasFocus: () => focused })

    const ignored = press('w')
    expect(handlers.onCloseTab).not.toHaveBeenCalled()
    expect(ignored.defaultPrevented).toBe(false)

    focused = true
    const handled = press('w')
    expect(handlers.onCloseTab).toHaveBeenCalledTimes(1)
    expect(handled.defaultPrevented).toBe(true)
  })

  it('cycles tabs with Mod+Alt+Arrow, wrapping and requiring editor focus', () => {
    let focused = true
    mountShortcuts({ editorHasFocus: () => focused })
    const files = useFileStore()
    files.openFiles = [{ id: 1 }, { id: 2 }, { id: 3 }]
    files.activeFileIndex = 0

    press('ArrowRight', { alt: true })
    expect(files.activeFileIndex).toBe(1)

    press('ArrowLeft', { alt: true })
    press('ArrowLeft', { alt: true })
    expect(files.activeFileIndex).toBe(2) // wrapped past the first tab

    focused = false
    press('ArrowRight', { alt: true })
    expect(files.activeFileIndex).toBe(2)
  })

  it('leaves a single tab alone when cycling', () => {
    mountShortcuts()
    const files = useFileStore()
    files.openFiles = [{ id: 1 }]
    files.activeFileIndex = 0

    press('ArrowRight', { alt: true })
    expect(files.activeFileIndex).toBe(0)
  })

  it('removes the document listener on unmount', () => {
    const { wrapper, handlers } = mountShortcuts()
    const ui = useEditorUIStore()

    wrapper.unmount()
    mounted.pop()

    press(',')
    press('s')
    expect(ui.settingsOpen).toBe(false)
    expect(handlers.onSave).not.toHaveBeenCalled()
  })
})
