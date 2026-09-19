import { describe, it, expect, vi } from 'vitest'
import { SHORTCUTS, matchShortcut, shortcutForEvent, shortcutKeys, shortcutSequenceKeys } from './shortcuts.js'

describe('shared shortcut registry', () => {
  it('resolves each documented binding to exactly one action', () => {
    expect(new Set(SHORTCUTS.map(row => row.id)).size).toBe(SHORTCUTS.length)
    for (const row of SHORTCUTS) {
      expect(row.label).toBeTruthy()
      expect(matchShortcut({ key: row.key, code: row.code, primary: true, shift: Boolean(row.shift), alt: Boolean(row.alt) }, [row.scope])?.id).toBe(row.id)
    }
  })
  it('keeps Go to second steps out of global and Editor matching', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
    expect(matchShortcut({ key: 'g', primary: true })).toBeNull()
    expect(matchShortcut({ key: 's', primary: true })?.id).toBe('save')
    expect(matchShortcut({ key: 'p', primary: true })?.id).toBe('quick-open')
    expect(matchShortcut({ key: 'g', primary: true }, ['quick-open'])?.targetId).toBe('app:business-graph')
    expect(matchShortcut({ key: 'p', primary: true }, ['quick-open'])?.queryPrefix).toBe('p: ')
    expect(shortcutSequenceKeys(SHORTCUTS.find(row => row.id === 'go-to-graph'))).toEqual(['⌘', 'P', '→', '⌘', 'G'])
    vi.restoreAllMocks()
  })
  it('uses Command on macOS without consuming terminal Control chords', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
    expect(shortcutForEvent({ key: 'p', ctrlKey: true })).toBeNull()
    expect(shortcutForEvent({ key: 'p', metaKey: true })?.id).toBe('quick-open')
    expect(shortcutForEvent({ key: 'P', metaKey: true, shiftKey: true })?.id).toBe('switch-project')
    expect(shortcutForEvent({ key: 'P', ctrlKey: true, shiftKey: true })).toBeNull()
    expect(shortcutKeys(SHORTCUTS.find(row => row.id === 'switch-project'))).toEqual(['⇧', '⌘', 'P'])
    expect(shortcutKeys(SHORTCUTS[0])).toEqual(['⌘', 'P'])
    vi.restoreAllMocks()
  })
  it('uses Control and matching labels on other platforms', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32')
    expect(shortcutForEvent({ key: 't', ctrlKey: true })?.id).toBe('new-tab')
    expect(shortcutKeys(SHORTCUTS.find(row => row.id === 'new-tab'))).toEqual(['Ctrl', 'T'])
    expect(shortcutForEvent({ key: 'P', ctrlKey: true, shiftKey: true })?.id).toBe('switch-project')
    expect(shortcutKeys(SHORTCUTS.find(row => row.id === 'switch-project'))).toEqual(['Shift', 'Ctrl', 'P'])
    vi.restoreAllMocks()
  })
})
