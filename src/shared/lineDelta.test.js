import { describe, it, expect } from 'vitest'
import { computeLineDelta, disambiguateFilenames } from './lineDelta.js'

describe('computeLineDelta', () => {
  it('identical strings → { added: 0, removed: 0 }', () => {
    expect(computeLineDelta('a\nb\nc', 'a\nb\nc')).toEqual({ added: 0, removed: 0 })
  })

  it('pure insertion (empty original, multi-line modified)', () => {
    expect(computeLineDelta('', 'a\nb\nc')).toEqual({ added: 3, removed: 0 })
  })

  it('pure deletion (multi-line original, empty modified)', () => {
    expect(computeLineDelta('a\nb\nc', '')).toEqual({ added: 0, removed: 3 })
  })

  it('mixed: lines added and removed', () => {
    expect(computeLineDelta('a\nb\nc', 'a\nd\nc\ne')).toEqual({ added: 2, removed: 1 })
  })

  it('single line changed → { added: 1, removed: 1 }', () => {
    expect(computeLineDelta('hello', 'world')).toEqual({ added: 1, removed: 1 })
  })

  it('both empty → { added: 0, removed: 0 }', () => {
    expect(computeLineDelta('', '')).toEqual({ added: 0, removed: 0 })
  })
})

describe('disambiguateFilenames', () => {
  it('all unique basenames → returns basenames', () => {
    expect(disambiguateFilenames([
      'src/foo.js',
      'src/bar.js',
      'lib/baz.js',
    ])).toEqual(['foo.js', 'bar.js', 'baz.js'])
  })

  it('duplicate basenames → returns shortest unique suffixes', () => {
    expect(disambiguateFilenames([
      'src/utils/index.js',
      'src/components/index.js',
    ])).toEqual(['utils/index.js', 'components/index.js'])
  })

  it('single path → returns basename', () => {
    expect(disambiguateFilenames(['src/deep/nested/file.js'])).toEqual(['file.js'])
  })
})
