import { describe, expect, it } from 'vitest'
import {
  compareFileEntries,
  compareFileRows,
  fileKind,
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

  it('formats modification times as stable local calendar values', () => {
    const timestamp = new Date(2026, 7, 14, 12, 34, 56).getTime()
    expect(formatModifiedTime(timestamp)).toBe('2026-08-14 12:34')
    expect(formatModifiedTime(0)).toBe('—')
  })

  it('uses useful file kinds instead of repeating extensions', () => {
    expect(fileKind({ name: 'src', isDirectory: true })).toBe('Folder')
    expect(fileKind({ name: 'README.md' })).toBe('Markdown')
    expect(fileKind({ name: 'Workbench.vue' })).toBe('Vue component')
    expect(fileKind({ name: 'archive.bin', textReadable: false })).toBe('BIN file')
  })

  it('sorts naturally, keeps folders first, and leaves missing metadata last', () => {
    const entries = [
      { name: 'file10.md', mtime: 10, size: 10 },
      { name: 'file2.md', mtime: 20, size: 20 },
      { name: 'unknown.md' },
      { name: 'src', isDirectory: true },
    ]

    expect([...entries].sort((left, right) => compareFileEntries(left, right, { by: 'name' }))
      .map(entry => entry.name)).toEqual(['src', 'file2.md', 'file10.md', 'unknown.md'])
    expect([...entries].sort((left, right) => compareFileEntries(left, right, { by: 'modified', direction: 'desc' }))
      .map(entry => entry.name)).toEqual(['src', 'file2.md', 'file10.md', 'unknown.md'])
  })

  it('sorts Git and favorite row metadata without moving folders below files', () => {
    const rows = [
      { entry: { name: 'plain.md' }, gitStatus: '', favorite: false },
      { entry: { name: 'changed.md' }, gitStatus: 'modified', favorite: false },
      { entry: { name: 'saved.md' }, gitStatus: '', favorite: true },
      { entry: { name: 'src', isDirectory: true }, gitCount: 2, favorite: false },
    ]

    expect([...rows].sort((left, right) => compareFileRows(left, right, { by: 'git', direction: 'desc' }))
      .map(row => row.entry.name)).toEqual(['src', 'changed.md', 'plain.md', 'saved.md'])
    expect([...rows].sort((left, right) => compareFileRows(left, right, { by: 'favorite', direction: 'desc' }))
      .map(row => row.entry.name)).toEqual(['src', 'saved.md', 'changed.md', 'plain.md'])
  })

  it('provides exact timestamps and Git labels for accessible rows', () => {
    expect(modifiedDateTime(Date.UTC(2026, 7, 14))).toBe('2026-08-14T00:00:00.000Z')
    expect(gitMark('modified')).toBe('M')
    expect(gitLabel('modified')).toBe('Modified in Git')
  })
})
