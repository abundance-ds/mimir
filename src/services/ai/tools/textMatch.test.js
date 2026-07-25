import { describe, it, expect } from 'vitest'
import { buildTypographicRegex, resolveSafePath, findTargetText, countMatches } from './textMatch'

describe('buildTypographicRegex', () => {
  it('matches exact ASCII text', () => {
    const re = buildTypographicRegex('Hello world')
    expect(re.test('Hello world')).toBe(true)
  })

  it('matches smart double quotes against straight quotes', () => {
    const re = buildTypographicRegex('"hello"')
    expect(re.test('“hello”')).toBe(true) // "hello"
    expect(re.test('"hello"')).toBe(true)
  })

  it('matches straight double quotes against smart quotes', () => {
    const re = buildTypographicRegex('“hello”')
    expect(re.test('"hello"')).toBe(true)
  })

  it('matches smart single quotes against straight quotes', () => {
    const re = buildTypographicRegex("it's")
    expect(re.test("it’s")).toBe(true) // it's
    expect(re.test("it's")).toBe(true)
  })

  it('matches straight single quotes against smart quotes', () => {
    const re = buildTypographicRegex("it’s")
    expect(re.test("it's")).toBe(true)
  })

  it('matches em-dash against double hyphen', () => {
    const re = buildTypographicRegex('word--word')
    expect(re.test('word—word')).toBe(true) // em-dash
    expect(re.test('word–word')).toBe(true) // en-dash
    expect(re.test('word--word')).toBe(true)
  })

  it('matches single hyphen against en/em-dash', () => {
    const re = buildTypographicRegex('a-b')
    expect(re.test('a–b')).toBe(true) // en-dash
    expect(re.test('a—b')).toBe(true) // em-dash
    expect(re.test('a-b')).toBe(true)
  })

  it('matches en-dash against hyphen', () => {
    const re = buildTypographicRegex('a–b')
    expect(re.test('a-b')).toBe(true)
  })

  it('matches em-dash against hyphen', () => {
    const re = buildTypographicRegex('a—b')
    expect(re.test('a-b')).toBe(true)
  })

  it('matches ellipsis against three dots', () => {
    const re = buildTypographicRegex('wait...')
    expect(re.test('wait…')).toBe(true) // ellipsis char
    expect(re.test('wait...')).toBe(true)
  })

  it('matches ellipsis character against three dots', () => {
    const re = buildTypographicRegex('wait…')
    expect(re.test('wait...')).toBe(true)
  })

  it('matches non-breaking space against regular space', () => {
    const re = buildTypographicRegex('a b')
    expect(re.test('a b')).toBe(true) // nbsp
  })

  it('matches nbsp against regular space', () => {
    const re = buildTypographicRegex('a b')
    expect(re.test('a b')).toBe(true)
  })

  it('escapes regex special characters', () => {
    const re = buildTypographicRegex('price: $10.00 (USD)')
    expect(re.test('price: $10.00 (USD)')).toBe(true)
  })

  it('does not match different text', () => {
    const re = buildTypographicRegex('hello')
    expect(re.test('world')).toBe(false)
  })

  it('handles empty string', () => {
    const re = buildTypographicRegex('')
    expect(re).toBeInstanceOf(RegExp)
  })

  it('matches straight quotes against guillemets in source text', () => {
    // When source text has straight quotes, guillemets in document should match
    const re = buildTypographicRegex('"hello"')
    expect(re.test('«hello»')).toBe(true)
    expect(re.test('„hello"')).toBe(true)
  })
})

describe('resolveSafePath', () => {
  const workspace = '/Users/test/projects/myproject'

  it('returns workspace path when relativePath is empty', () => {
    expect(resolveSafePath('', workspace)).toBe(workspace)
  })

  it('returns workspace path when relativePath is null/undefined', () => {
    expect(resolveSafePath(null, workspace)).toBe(workspace)
    expect(resolveSafePath(undefined, workspace)).toBe(workspace)
  })

  it('resolves a simple relative path', () => {
    expect(resolveSafePath('src/main.js', workspace))
      .toBe('/Users/test/projects/myproject/src/main.js')
  })

  it('resolves nested relative paths', () => {
    expect(resolveSafePath('src/components/App.vue', workspace))
      .toBe('/Users/test/projects/myproject/src/components/App.vue')
  })

  it('blocks traversal with ../', () => {
    expect(resolveSafePath('../../../etc/passwd', workspace)).toBeNull()
  })

  it('blocks traversal that escapes workspace', () => {
    expect(resolveSafePath('../../outside', workspace)).toBeNull()
  })

  it('allows .. that stays within workspace', () => {
    expect(resolveSafePath('src/../src/main.js', workspace))
      .toBe('/Users/test/projects/myproject/src/main.js')
  })

  it('handles absolute paths within workspace', () => {
    const abs = workspace + '/src/file.txt'
    expect(resolveSafePath(abs, workspace)).toBe(abs)
  })

  it('blocks absolute paths outside workspace', () => {
    expect(resolveSafePath('/etc/passwd', workspace)).toBeNull()
  })

  it('blocks sibling paths that merely share the workspace prefix', () => {
    expect(resolveSafePath(`${workspace}-evil/file.txt`, workspace)).toBeNull()
  })

  it('returns null when workspacePath is empty/null', () => {
    expect(resolveSafePath('file.txt', '')).toBeNull()
    expect(resolveSafePath('file.txt', null)).toBeNull()
    expect(resolveSafePath('file.txt', undefined)).toBeNull()
  })

  it('normalizes paths with multiple slashes', () => {
    expect(resolveSafePath('src///main.js', workspace))
      .toBe('/Users/test/projects/myproject/src/main.js')
  })

  it('normalizes paths with dot segments', () => {
    expect(resolveSafePath('./src/./main.js', workspace))
      .toBe('/Users/test/projects/myproject/src/main.js')
  })
})

describe('findTargetText', () => {
  it('returns correct {from, to} range for an exact match in the middle', () => {
    const doc = 'The quick brown fox jumps over the lazy dog.'
    const result = findTargetText(doc, 'brown fox')
    expect(result).toEqual({ from: 10, to: 19 })
  })

  it('returns from === 0 for an exact match at document start', () => {
    const doc = 'Hello world, goodbye world.'
    const result = findTargetText(doc, 'Hello')
    expect(result).toEqual({ from: 0, to: 5 })
  })

  it('returns to === docText.length for an exact match at document end', () => {
    const doc = 'Start of the document. The end.'
    const result = findTargetText(doc, 'The end.')
    expect(result).toEqual({ from: 23, to: doc.length })
  })

  it('returns null for null docText', () => {
    expect(findTargetText(null, 'target')).toBeNull()
  })

  it('returns null for empty docText', () => {
    expect(findTargetText('', 'target')).toBeNull()
  })

  it('returns null for null targetText', () => {
    expect(findTargetText('some document text', null)).toBeNull()
  })

  it('returns null for empty targetText', () => {
    expect(findTargetText('some document text', '')).toBeNull()
  })

  it('returns null when no match is found anywhere', () => {
    const doc = 'The quick brown fox jumps over the lazy dog.'
    expect(findTargetText(doc, 'purple elephant')).toBeNull()
  })

  it('matches smart quotes in doc against straight quotes in target', () => {
    const doc = 'She said “hello” to everyone.'
    const result = findTargetText(doc, '"hello"')
    expect(result).not.toBeNull()
    expect(doc.slice(result.from, result.to)).toBe('“hello”')
  })

  it('matches em-dash in doc against double hyphen in target', () => {
    const doc = 'word—word is a compound.'
    const result = findTargetText(doc, 'word--word')
    expect(result).not.toBeNull()
    expect(doc.slice(result.from, result.to)).toBe('word—word')
  })

  it('matches when target has extra spaces collapsed in doc', () => {
    const doc = 'a b c'
    const result = findTargetText(doc, 'a  b  c')
    expect(result).not.toBeNull()
    expect(doc.slice(result.from, result.to)).toBe('a b c')
  })

  it('matches when doc has \\r\\n but target has \\n', () => {
    const doc = 'line one\r\nline two\r\nline three'
    const result = findTargetText(doc, 'line one\nline two')
    expect(result).not.toBeNull()
    expect(doc.slice(result.from, result.to)).toBe('line one\r\nline two')
  })

  it('matches when both whitespace normalization and typographic variants are needed', () => {
    const doc = 'She  said “hello”\r\nto everyone.'
    const result = findTargetText(doc, 'She said "hello"\nto everyone.')
    expect(result).not.toBeNull()
    expect(doc.slice(result.from, result.to)).toBe('She  said “hello”\r\nto everyone.')
  })

  it('maps the range back to original text accurately when whitespace differs', () => {
    const doc = 'prefix   middle   suffix'
    const result = findTargetText(doc, 'middle')
    expect(result).not.toBeNull()
    expect(doc.slice(result.from, result.to)).toBe('middle')
  })

  it('returns the first match when multiple matches exist', () => {
    const doc = 'cat and cat and cat'
    const result = findTargetText(doc, 'cat')
    expect(result).toEqual({ from: 0, to: 3 })
  })
})

describe('countMatches', () => {
  it('returns 0 for null/empty inputs', () => {
    expect(countMatches(null, 'text')).toBe(0)
    expect(countMatches('text', null)).toBe(0)
    expect(countMatches('', 'text')).toBe(0)
    expect(countMatches('text', '')).toBe(0)
  })

  it('returns 1 for a unique exact match', () => {
    expect(countMatches('The quick brown fox', 'brown fox')).toBe(1)
  })

  it('returns count for multiple exact matches', () => {
    expect(countMatches('cat and cat and cat', 'cat')).toBe(3)
  })

  it('returns 0 when text not found', () => {
    expect(countMatches('hello world', 'xyz')).toBe(0)
  })

  it('counts typographic variants when no exact match', () => {
    // Doc has smart quotes, target has straight quotes
    expect(countMatches('She said “hello” and “goodbye”', '"hello"')).toBe(1)
  })

  it('counts multiple typographic variant matches', () => {
    expect(countMatches('word—word and word—word', 'word--word')).toBe(2)
  })

  it('prefers exact count over typographic count', () => {
    // If exact matches exist, don't fall through to typographic
    expect(countMatches('cat "cat" cat', 'cat')).toBe(3)
  })
})
