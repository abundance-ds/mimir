import { describe, it, expect } from 'vitest'
import { EDITOR_FONTS, fontFamilyForKey } from './fonts.js'

describe('fonts', () => {
  it('EDITOR_FONTS has four entries with required fields', () => {
    expect(EDITOR_FONTS).toHaveLength(4)
    for (const font of EDITOR_FONTS) {
      expect(font).toHaveProperty('key')
      expect(font).toHaveProperty('label')
      expect(font).toHaveProperty('family')
    }
  })

  it('EDITOR_FONTS keys are sans, serif, mono, slab', () => {
    const keys = EDITOR_FONTS.map(f => f.key)
    expect(keys).toEqual(['sans', 'serif', 'mono', 'slab'])
  })

  it('fontFamilyForKey returns correct family for each key', () => {
    expect(fontFamilyForKey('sans')).toContain('Inter')
    expect(fontFamilyForKey('serif')).toContain('Lora')
    expect(fontFamilyForKey('mono')).toContain('JetBrains Mono')
    expect(fontFamilyForKey('slab')).toContain('Zilla Slab')
  })

  it('fontFamilyForKey falls back to mono for unknown keys', () => {
    expect(fontFamilyForKey('unknown')).toContain('JetBrains Mono')
    expect(fontFamilyForKey('')).toContain('JetBrains Mono')
    expect(fontFamilyForKey(undefined)).toContain('JetBrains Mono')
  })
})
