import { describe, expect, it } from 'vitest'
import { diffIsVisibleForFile, singleDiffTargetsFile } from './workspaceDiffProjection.js'

describe('workspace diff projection', () => {
  it('binds a single-file review to the exact tab id', () => {
    const diff = {
      active: true,
      isBatch: false,
      fileId: 7,
      filePath: '/tmp/global.md',
    }

    expect(singleDiffTargetsFile(diff, { id: 7, path: '/tmp/global.md' })).toBe(true)
    expect(diffIsVisibleForFile(diff, { id: 8, path: '/tmp/global.md' })).toBe(false)
  })

  it('distinguishes untitled drafts by id', () => {
    const diff = { active: true, isBatch: false, fileId: 3, filePath: '' }

    expect(diffIsVisibleForFile(diff, { id: 3, path: null })).toBe(true)
    expect(diffIsVisibleForFile(diff, { id: 4, path: null })).toBe(false)
  })

  it('supports path-bound legacy reviews only on their active file', () => {
    const diff = { active: true, isBatch: false, fileId: null, filePath: '/alpha/a.md' }
    const inScope = path => path.startsWith('/alpha/')

    expect(diffIsVisibleForFile(diff, { id: 1, path: '/alpha/a.md' }, inScope)).toBe(true)
    expect(diffIsVisibleForFile(diff, { id: 2, path: '/alpha/b.md' }, inScope)).toBe(false)
    expect(diffIsVisibleForFile(diff, { id: 1, path: '/alpha/a.md' }, () => false)).toBe(false)
  })

  it('shows a batch only in a scope that owns one of its paths', () => {
    const diff = {
      active: true,
      isBatch: true,
      files: [{ path: '/alpha/a.md' }, { path: '/alpha/b.md' }],
    }

    expect(diffIsVisibleForFile(diff, null, path => path.startsWith('/alpha/'))).toBe(true)
    expect(diffIsVisibleForFile(diff, null, path => path.startsWith('/beta/'))).toBe(false)
  })
})
