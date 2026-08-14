import { describe, expect, it } from 'vitest'
import {
  formatFileSize,
  formatModifiedTime,
  gitLabel,
  gitMark,
  modifiedDateTime,
} from './fileLedger.js'

describe('file ledger formatting', () => {
  it('formats file sizes without noisy decimals', () => {
    expect(formatFileSize(0)).toBe('0 B')
    expect(formatFileSize(1536)).toBe('1.5 KB')
    expect(formatFileSize(12 * 1024)).toBe('12 KB')
    expect(formatFileSize(Number.NaN)).toBe('—')
  })

  it('formats recent modification times against one panel clock', () => {
    const now = Date.UTC(2026, 7, 14, 12)
    expect(formatModifiedTime(now - 30_000, now)).toBe('now')
    expect(formatModifiedTime(now - 2 * 60_000, now)).toBe('2m')
    expect(formatModifiedTime(now - 3 * 3_600_000, now)).toBe('3h')
    expect(formatModifiedTime(now - 2 * 86_400_000, now)).toBe('2d')
    expect(formatModifiedTime(0, now)).toBe('—')
  })

  it('provides exact timestamps and Git labels for accessible rows', () => {
    expect(modifiedDateTime(Date.UTC(2026, 7, 14))).toBe('2026-08-14T00:00:00.000Z')
    expect(gitMark('modified')).toBe('M')
    expect(gitLabel('modified')).toBe('Modified in Git')
  })
})
