import { describe, expect, it } from 'vitest'
import { parentPath } from './path.js'

describe('parentPath', () => {
  it.each([
    ['/workspace/docs/readme.md', '/workspace/docs'],
    ['/readme.md', '/'],
    ['C:\\workspace\\docs\\readme.md', 'C:\\workspace\\docs'],
    ['C:\\readme.md', 'C:\\'],
    ['readme.md', null],
    ['', null],
    [null, null],
  ])('returns the lexical parent of %s', (path, expected) => {
    expect(parentPath(path)).toBe(expected)
  })
})
