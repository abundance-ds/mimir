import { describe, expect, it } from 'vitest'
import { moveRangeAnchor, reportRange } from './trackerDateRange.js'

describe('tracker date ranges', () => {
  it('moves month anchors from day one so short months are never skipped', () => {
    const next = moveRangeAnchor(new Date(2026, 0, 31, 12), 'month', 1)
    const previous = moveRangeAnchor(new Date(2026, 6, 31, 12), 'month', -1)

    expect([next.getFullYear(), next.getMonth(), next.getDate()]).toEqual([2026, 1, 1])
    expect([previous.getFullYear(), previous.getMonth(), previous.getDate()]).toEqual([2026, 5, 1])
  })

  it('builds day boundaries in the renderer system timezone', () => {
    const range = reportRange('day', new Date(2026, 6, 31, 18, 30))
    const start = new Date(range.startMs)
    const end = new Date(range.endMs)

    expect([start.getHours(), start.getMinutes(), start.getSeconds()]).toEqual([0, 0, 0])
    expect(end.getTime() - start.getTime()).toBeGreaterThanOrEqual(23 * 60 * 60 * 1000)
    expect(end.getTime() - start.getTime()).toBeLessThanOrEqual(25 * 60 * 60 * 1000)
  })
})
