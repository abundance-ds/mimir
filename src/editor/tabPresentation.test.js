import { describe, expect, it } from 'vitest'
import { splitTabName, tabIdealWidth } from './tabPresentation.js'

describe('editor tab presentation', () => {
  it('keeps a long start and a short semantic end', () => {
    expect(splitTabName('datei mit ein paar charts und nummer 1.md')).toEqual({
      leading: 'datei mit ein paar charts und nummer ',
      trailing: '1.md',
    })
  })

  it('keeps the extension visible when the last word is long', () => {
    const parts = splitTabName('quarterly-performance-final.md')
    expect(parts.leading + parts.trailing).toBe('quarterly-performance-final.md')
    expect(parts.trailing).toBe('inal.md')
  })

  it('reserves the extension when a compact tab must shrink', () => {
    expect(splitTabName('README.md')).toEqual({ leading: 'README', trailing: '.md' })
    expect(splitTabName('working.md')).toEqual({ leading: 'working', trailing: '.md' })
  })

  it('keeps very short names whole', () => {
    expect(splitTabName('doc.md')).toEqual({ leading: 'doc.md', trailing: '' })
  })

  it('keeps both ends of compact extensionless names', () => {
    expect(splitTabName('.gitignore')).toEqual({ leading: '.gitign', trailing: 'ore' })
  })

  it('keeps ideal widths within the restrained range', () => {
    expect(tabIdealWidth('a.md')).toBe(112)
    expect(tabIdealWidth('a-very-long-document-name-that-keeps-going.md')).toBe(188)
    expect(tabIdealWidth('working-notes.md')).toBeGreaterThan(112)
    expect(tabIdealWidth('working-notes.md')).toBeLessThan(188)
  })
})
