import { describe, it, expect } from 'vitest'
import { readDocxAsText } from './reader'

describe('Bug A: readDocxAsText must extract comment metadata', () => {
  it('readDocxAsText source must pass commentMap to htmlToReadable', () => {
    const src = readDocxAsText.toString()
    // The function must NOT just call htmlToReadable(result.value) — that drops comments.
    // It must extract comments from mammoth and pass them as a second argument.
    expect(src).not.toMatch(/htmlToReadable\(\s*result\.value\s*\)/)
  })
})
