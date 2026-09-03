import { describe, it, expect } from 'vitest'
import {
  COMMIT_MONO_FONT_STACK,
  EDITOR_DARK_FONT_WEIGHT,
  EDITOR_FONTS,
  EDITOR_LIGHT_FONT_WEIGHT,
  EDITOR_LINE_HEIGHT_RATIO,
  SYSTEM_MONO_FONT_STACK,
  SYSTEM_SANS_FONT_STACK,
  editorTypographyVars,
  fontFamilyForKey,
} from './fonts.js'

describe('fonts', () => {
  it('offers Commit Mono with system fallbacks', () => {
    expect(EDITOR_FONTS).toHaveLength(3)
    for (const font of EDITOR_FONTS) {
      expect(font).toHaveProperty('key')
      expect(font).toHaveProperty('label')
      expect(font).toHaveProperty('family')
    }
    expect(EDITOR_FONTS.map(font => font.key)).toEqual(['mono', 'system-mono', 'sans'])
    expect(COMMIT_MONO_FONT_STACK).toContain('"Commit Mono"')
    expect(COMMIT_MONO_FONT_STACK).toContain('ui-monospace')
    expect(SYSTEM_SANS_FONT_STACK).toContain('-apple-system')
    expect(SYSTEM_MONO_FONT_STACK).toContain('ui-monospace')
    expect(JSON.stringify(EDITOR_FONTS)).not.toContain('Serif')
    expect(JSON.stringify(EDITOR_FONTS)).not.toContain('IBM Plex')
  })

  it('fontFamilyForKey returns correct family for each key', () => {
    expect(fontFamilyForKey('sans')).toBe(SYSTEM_SANS_FONT_STACK)
    expect(fontFamilyForKey('mono')).toBe(COMMIT_MONO_FONT_STACK)
    expect(fontFamilyForKey('system-mono')).toBe(SYSTEM_MONO_FONT_STACK)
    expect(fontFamilyForKey('serif')).toBe(SYSTEM_SANS_FONT_STACK)
  })

  it('fontFamilyForKey falls back to Commit Mono for unknown keys', () => {
    expect(fontFamilyForKey('unknown')).toBe(COMMIT_MONO_FONT_STACK)
    expect(fontFamilyForKey('')).toBe(COMMIT_MONO_FONT_STACK)
    expect(fontFamilyForKey(undefined)).toBe(COMMIT_MONO_FONT_STACK)
  })

  it('builds one typography scale for editor and diff surfaces', () => {
    expect(EDITOR_LINE_HEIGHT_RATIO).toBe(1.45)
    expect(editorTypographyVars({
      fontSize: 14,
      zoom: 1.25,
      fontKey: 'mono',
      dark: false,
    })).toEqual({
      '--editor-size': '17.5px',
      '--editor-line-height': '25.375px',
      '--editor-font-weight': String(EDITOR_LIGHT_FONT_WEIGHT),
      '--font-mono': COMMIT_MONO_FONT_STACK,
    })

    expect(editorTypographyVars({
      fontSize: 16,
      fontKey: 'mono',
      dark: true,
    })['--editor-font-weight']).toBe(String(EDITOR_DARK_FONT_WEIGHT))
    expect(editorTypographyVars({
      fontSize: 16,
      fontKey: 'system-mono',
      dark: false,
    })['--editor-font-weight']).toBe(String(EDITOR_DARK_FONT_WEIGHT))
  })
})
