import { describe, it, expect } from 'vitest'
import { stripHfu, wrapHfu } from './hfu.js'

describe('stripHfu', () => {
  it('returns text unchanged when no hfu tags', () => {
    expect(stripHfu('Hello world')).toBe('Hello world')
  })

  it('strips a single hfu block', () => {
    expect(stripHfu('<hfu>hidden</hfu> visible')).toBe('visible')
  })

  it('strips multiple hfu blocks', () => {
    expect(stripHfu('<hfu>a</hfu> between <hfu>b</hfu>')).toBe('between')
  })

  it('strips hfu with multiline content', () => {
    const input = '<hfu><attached-file name="doc.md">\nline1\nline2\n</attached-file></hfu>\n\nWhat do you think?'
    expect(stripHfu(input)).toBe('What do you think?')
  })

  it('handles empty hfu tags', () => {
    expect(stripHfu('<hfu></hfu> text')).toBe('text')
  })

  it('handles hfu wrapping entire text', () => {
    expect(stripHfu('<hfu>everything hidden</hfu>')).toBe('')
  })

  it('returns empty string for null/undefined', () => {
    expect(stripHfu(null)).toBe('')
    expect(stripHfu(undefined)).toBe('')
    expect(stripHfu('')).toBe('')
  })

  it('does not strip partial or malformed tags', () => {
    expect(stripHfu('<hfu>unclosed')).toBe('<hfu>unclosed')
    expect(stripHfu('</hfu> orphan close')).toBe('</hfu> orphan close')
  })

  it('handles nested XML inside hfu', () => {
    const input = '<hfu><comment id="c1" author="me" text="fix this">some text</comment></hfu>\n\nPlease review'
    expect(stripHfu(input)).toBe('Please review')
  })
})

describe('wrapHfu', () => {
  it('wraps content in hfu tags', () => {
    expect(wrapHfu('hello')).toBe('<hfu content-hidden-from-user>hello</hfu>')
  })

  it('wraps multiline content', () => {
    expect(wrapHfu('line1\nline2')).toBe('<hfu content-hidden-from-user>line1\nline2</hfu>')
  })
})

describe('roundtrip', () => {
  it('stripHfu removes wrapHfu output', () => {
    const hidden = wrapHfu('secret context')
    const message = `${hidden}\n\nUser question here`
    expect(stripHfu(message)).toBe('User question here')
  })
})
