import { describe, expect, it } from 'vitest'
import { relativeTime } from './time.js'

describe('relativeTime', () => {
  const now = Date.parse('2026-08-14T12:00:00Z')

  it.each([
    [0, 'now'],
    [59_999, 'now'],
    [60_000, '1m'],
    [4 * 60_000, '4m'],
    [2 * 60 * 60_000, '2h'],
    [3 * 24 * 60 * 60_000, '3d'],
    [14 * 24 * 60 * 60_000, '2w'],
    [60 * 24 * 60 * 60_000, '2mo'],
    [364 * 24 * 60 * 60_000, '12mo'],
    [730 * 24 * 60 * 60_000, '2y'],
  ])('formats %i ms compactly as %s', (elapsed, expected) => {
    expect(relativeTime(now - elapsed, now, { compact: true })).toBe(expected)
  })

  it('keeps the existing long format unchanged', () => {
    expect(relativeTime(now - 45_000, now)).toBe('45s ago')
  })
})
