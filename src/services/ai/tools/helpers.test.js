import { describe, it, expect } from 'vitest'
import { limitText } from './index'

describe('limitText', () => {
  it('returns text unchanged when under limit', () => {
    const text = 'Hello, world!'
    expect(limitText(text, 100)).toBe(text)
  })

  it('returns text unchanged when exactly at limit', () => {
    const text = 'a'.repeat(100)
    expect(limitText(text, 100)).toBe(text)
  })

  it('truncates text over the limit', () => {
    const text = 'a'.repeat(200)
    const result = limitText(text, 100)
    expect(result.length).toBeLessThan(200)
    expect(result).toContain('a'.repeat(100))
  })

  it('adds truncation marker when truncated', () => {
    const text = 'a'.repeat(200)
    const result = limitText(text, 100)
    expect(result).toContain('[Truncated at 100 characters.]')
  })

  it('includes the limit value in the truncation marker', () => {
    const text = 'a'.repeat(500)
    const result = limitText(text, 250)
    expect(result).toContain('[Truncated at 250 characters.]')
  })

  it('uses default limit of 24000 characters', () => {
    const text = 'x'.repeat(30000)
    const result = limitText(text)
    expect(result).toContain('[Truncated at 24000 characters.]')
    expect(result.startsWith('x'.repeat(24000))).toBe(true)
  })

  it('returns empty string for null input', () => {
    expect(limitText(null)).toBe('')
  })

  it('returns empty string for undefined input', () => {
    expect(limitText(undefined)).toBe('')
  })

  it('returns empty string for empty string input', () => {
    expect(limitText('')).toBe('')
  })

  it('does not truncate text shorter than default limit', () => {
    const text = 'Short text'
    expect(limitText(text)).toBe('Short text')
  })
})
