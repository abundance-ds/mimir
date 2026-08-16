import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import {
  loadGitFileDiff,
  describeGitReviewError,
  normalizeGitFileDiff,
  normalizeGitReviewChanges,
  stageGitFile,
  unstageGitFile,
} from './gitReview.js'

describe('gitReview service', () => {
  beforeEach(() => vi.mocked(invoke).mockReset().mockResolvedValue(undefined))

  it('keeps the index and worktree states separate', () => {
    expect(normalizeGitReviewChanges([
      { path: 'both.md', status: 'modified', staged: true, unstaged: true },
      { path: 'conflict.md', status: 'conflicted', conflicted: true },
      { path: 'clean.md', status: 'modified' },
    ])).toEqual([
      {
        path: 'conflict.md', oldPath: '', status: 'conflicted',
        staged: false, unstaged: false, conflicted: true,
      },
      {
        path: 'both.md', oldPath: '', status: 'modified',
        staged: true, unstaged: true, conflicted: false,
      },
    ])
  })

  it('loads one normalized review snapshot', async () => {
    vi.mocked(invoke).mockResolvedValue({
      path: 'doc.md', status: 'modified', scope: 'all', snapshot: 'abc',
      original: 'before', modified: 'after', patch: 'patch', added: 2, removed: 1,
      staged: false, unstaged: true,
    })

    await expect(loadGitFileDiff('/work', 'doc.md', 'all')).resolves.toEqual(expect.objectContaining({
      path: 'doc.md', original: 'before', modified: 'after', snapshot: 'abc',
    }))
    expect(invoke).toHaveBeenCalledWith('git_file_diff', {
      path: '/work', file: 'doc.md', scope: 'all',
    })
  })

  it('rejects an incomplete diff payload', () => {
    expect(() => normalizeGitFileDiff({ path: 'doc.md', status: 'modified', scope: 'all' }))
      .toThrow('incomplete')
  })

  it('sends snapshot-bound stage and unstage actions', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined)
    const request = {
      workspacePath: '/work', file: 'doc.md', scope: 'all', expectedSnapshot: 'snap',
    }
    await stageGitFile(request)
    await unstageGitFile(request)
    expect(invoke).toHaveBeenNthCalledWith(1, 'git_stage_file', {
      path: '/work', file: 'doc.md', scope: 'all', expectedSnapshot: 'snap',
    })
    expect(invoke).toHaveBeenNthCalledWith(2, 'git_unstage_file', {
      path: '/work', file: 'doc.md', scope: 'all', expectedSnapshot: 'snap',
    })
  })

  it('turns libgit2 repository discovery output into a product state', () => {
    expect(describeGitReviewError(new Error(
      "Could not find a Git repository from /work: could not find repository at '/work'; class=Repository (6); code=NotFound (-3)",
    ))).toEqual({
      kind: 'not-repository',
      message: 'This folder is not tracked with Git.',
    })
    expect(describeGitReviewError('Could not read Git status: index locked; class=Index (10)'))
      .toEqual({ kind: 'error', message: 'Could not read Git status: index locked' })
  })
})
