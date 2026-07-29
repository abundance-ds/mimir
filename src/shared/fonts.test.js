import { describe, it, expect } from 'vitest'
import {
  EDITOR_FONTS,
  SYSTEM_MONO_FONT_STACK,
  SYSTEM_SANS_FONT_STACK,
  fontFamilyForKey,
} from './fonts.js'

describe('fonts', () => {
  it('offers only system sans and system mono', () => {
    expect(EDITOR_FONTS).toHaveLength(2)
    for (const font of EDITOR_FONTS) {
      expect(font).toHaveProperty('key')
      expect(font).toHaveProperty('label')
      expect(font).toHaveProperty('family')
    }
    expect(EDITOR_FONTS.map(font => font.key)).toEqual(['sans', 'mono'])
    expect(SYSTEM_SANS_FONT_STACK).toContain('-apple-system')
    expect(SYSTEM_MONO_FONT_STACK).toContain('ui-monospace')
    expect(JSON.stringify(EDITOR_FONTS)).not.toContain('Serif')
    expect(JSON.stringify(EDITOR_FONTS)).not.toContain('IBM Plex')
  })

  it('fontFamilyForKey returns correct family for each key', () => {
    expect(fontFamilyForKey('sans')).toBe(SYSTEM_SANS_FONT_STACK)
    expect(fontFamilyForKey('mono')).toBe(SYSTEM_MONO_FONT_STACK)
    expect(fontFamilyForKey('serif')).toBe(SYSTEM_SANS_FONT_STACK)
  })

  it('fontFamilyForKey falls back to mono for unknown keys', () => {
    expect(fontFamilyForKey('unknown')).toBe(SYSTEM_MONO_FONT_STACK)
    expect(fontFamilyForKey('')).toBe(SYSTEM_MONO_FONT_STACK)
    expect(fontFamilyForKey(undefined)).toBe(SYSTEM_MONO_FONT_STACK)
  })
})
