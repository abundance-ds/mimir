import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import {
  absoluteWorkspacePath,
  loadGitChanges,
  normalizeGitChanges,
} from './gitChanges.js'

describe('gitChanges', () => {
  beforeEach(() => vi.mocked(invoke).mockClear())

  it('loads and normalizes the workspace status ledger', async () => {
    vi.mocked(invoke).mockResolvedValue([
      { path: 'src/z.js', status: 'modified' },
      { path: 'README.md', status: 'new' },
      { path: 'gone.md', status: 'deleted' },
    ])

    await expect(loadGitChanges('/work')).resolves.toEqual([
      { path: 'gone.md', status: 'deleted' },
      { path: 'README.md', status: 'new' },
      { path: 'src/z.js', status: 'modified' },
    ])
    expect(invoke).toHaveBeenCalledWith('git_status', { path: '/work' })
  })

  it('drops malformed and unsupported status entries', () => {
    expect(normalizeGitChanges([
      null,
      { path: '', status: 'new' },
      { path: 'ok.md', status: 'NEW' },
      { path: 'ignored.md', status: 'conflicted' },
    ])).toEqual([{ path: 'ok.md', status: 'new' }])
  })

  it('resolves both Unix and Windows workspace paths without Node APIs', () => {
    expect(absoluteWorkspacePath('/work/repo/', 'src/main.rs')).toBe('/work/repo/src/main.rs')
    expect(absoluteWorkspacePath('C:\\work\\repo', 'src\\main.rs')).toBe('C:\\work\\repo\\src\\main.rs')
    expect(absoluteWorkspacePath('/work/repo', '/already/absolute.md')).toBe('/already/absolute.md')
  })

  it('rejects a missing workspace before invoking Rust', async () => {
    await expect(loadGitChanges('')).rejects.toThrow('Open a workspace')
    expect(invoke).not.toHaveBeenCalled()
  })
})
