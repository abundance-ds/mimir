import { describe, it, expect } from 'vitest'
import { EDITOR_FONTS, fontFamilyForKey } from './fonts.js'

describe('fonts', () => {
  it('EDITOR_FONTS has three entries with required fields', () => {
    expect(EDITOR_FONTS).toHaveLength(3)
    for (const font of EDITOR_FONTS) {
      expect(font).toHaveProperty('key')
      expect(font).toHaveProperty('label')
      expect(font).toHaveProperty('family')
    }
  })

  it('EDITOR_FONTS keys are sans, serif, mono', () => {
    const keys = EDITOR_FONTS.map(f => f.key)
    expect(keys).toEqual(['sans', 'serif', 'mono'])
  })

  it('fontFamilyForKey returns correct family for each key', () => {
    expect(fontFamilyForKey('sans')).toContain('IBM Plex Sans')
    expect(fontFamilyForKey('serif')).toContain('IBM Plex Serif')
    expect(fontFamilyForKey('mono')).toContain('IBM Plex Mono')
  })

  it('fontFamilyForKey falls back to mono for unknown keys', () => {
    expect(fontFamilyForKey('unknown')).toContain('IBM Plex Mono')
    expect(fontFamilyForKey('')).toContain('IBM Plex Mono')
    expect(fontFamilyForKey(undefined)).toContain('IBM Plex Mono')
  })
})
