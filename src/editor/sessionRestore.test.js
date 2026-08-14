import { describe, expect, it, vi } from 'vitest'
import { loadSessionEntries, normalizeSessionEntries } from './sessionRestore.js'

describe('session restore normalization', () => {
  it('collapses legacy exact duplicate drafts and retains the active occurrence', () => {
    const ids = ['draft-a', 'draft-b']
    const createId = vi.fn(() => ids.shift())
    const result = normalizeSessionEntries([
      { path: null, content: 'same draft' },
      { path: '/w/README.md' },
      { path: null, content: 'same draft' },
      { path: null, content: 'different' },
    ], 2, createId)

    expect(result.entries).toEqual([
      { path: null, content: 'same draft', draftId: 'draft-a' },
      { path: '/w/README.md' },
      { path: null, content: 'different', draftId: 'draft-b' },
    ])
    expect(result.activeEntry).toEqual(result.entries[0])
    expect(result.activeIndex).toBe(0)
    expect(result.changed).toBe(true)
  })

  it('preserves intentional same-content drafts with distinct stable ids', () => {
    const result = normalizeSessionEntries([
      { path: null, content: 'same', draftId: 'draft-one' },
      { path: null, content: 'same', draftId: 'draft-two' },
    ], 1)

    expect(result.entries).toHaveLength(2)
    expect(result.activeEntry.draftId).toBe('draft-two')
    expect(result.changed).toBe(false)
  })

  it('preserves dirty path-backed recovery content while normalizing clean paths', () => {
    const result = normalizeSessionEntries([
      { path: '/clean.md', content: 'stale but clean', dirty: false },
      { path: '/dirty.md', content: 'unsaved', dirty: true },
    ], 1)

    expect(result.entries).toEqual([
      { path: '/clean.md' },
      { path: '/dirty.md', content: 'unsaved', dirty: true },
    ])
    expect(result.activeEntry).toEqual(result.entries[1])
    expect(result.changed).toBe(true)
  })

  it('retains project ownership on clean and dirty path entries', () => {
    const result = normalizeSessionEntries([
      { path: '/alpha/clean.md', workspacePath: '/alpha' },
      {
        path: '/beta/dirty.md',
        workspacePath: '/beta',
        content: 'unsaved',
        dirty: true,
      },
    ], 1)

    expect(result.entries).toEqual([
      { path: '/alpha/clean.md', workspacePath: '/alpha' },
      {
        path: '/beta/dirty.md',
        content: 'unsaved',
        dirty: true,
        workspacePath: '/beta',
      },
    ])
    expect(result.changed).toBe(false)
  })

  it('loads saved paths concurrently while preserving exact tab order and failures', async () => {
    const pending = new Map()
    const calls = []
    const read = path => new Promise((resolve, reject) => {
      calls.push(path)
      pending.set(path, { resolve, reject })
    })
    const loading = loadSessionEntries([
      { path: '/a.md' },
      { path: null, content: 'draft', draftId: 'draft-1' },
      { path: '/b.md' },
      { path: '/missing.md' },
    ], read, 2)

    await Promise.resolve()
    expect(calls).toEqual(['/a.md', '/b.md'])
    pending.get('/b.md').resolve('B')
    await Promise.resolve()
    pending.get('/a.md').resolve('A')
    await Promise.resolve()
    expect(calls).toEqual(['/a.md', '/b.md', '/missing.md'])
    pending.get('/missing.md').reject(new Error('missing'))

    const results = await loading
    expect(results.map(result => result.entry.path || result.entry.draftId)).toEqual([
      '/a.md',
      'draft-1',
      '/b.md',
      '/missing.md',
    ])
    expect(results.map(result => result.content)).toEqual(['A', 'draft', 'B', null])
    expect(results[3].error).toBeInstanceOf(Error)
  })
})
