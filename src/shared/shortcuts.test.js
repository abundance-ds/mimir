import { describe, it, expect, vi } from 'vitest'
import { SHORTCUTS, matchShortcut, shortcutForEvent, shortcutKeys } from './shortcuts.js'

describe('shared shortcut registry', () => {
  it('resolves each documented binding to exactly one action', () => {
    expect(new Set(SHORTCUTS.map(row => row.id)).size).toBe(SHORTCUTS.length)
    for (const row of SHORTCUTS) {
      expect(row.label).toBeTruthy()
      expect(matchShortcut({ key: row.key, code: row.code, primary: true, shift: Boolean(row.shift), alt: Boolean(row.alt) })?.id).toBe(row.id)
    }
  })
  it('uses Command on macOS without consuming terminal Control chords', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
    expect(shortcutForEvent({ key: 'p', ctrlKey: true })).toBeNull()
    expect(shortcutForEvent({ key: 'p', metaKey: true })?.id).toBe('quick-open')
    expect(shortcutKeys(SHORTCUTS[0])).toEqual(['⌘', 'P'])
    vi.restoreAllMocks()
  })
  it('uses Control and matching labels on other platforms', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32')
    expect(shortcutForEvent({ key: 't', ctrlKey: true })?.id).toBe('new-tab')
    expect(shortcutKeys(SHORTCUTS[1])).toEqual(['Ctrl', 'T'])
    vi.restoreAllMocks()
  })
})
