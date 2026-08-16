import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import * as service from '../services/gitReview.js'
import { useGitReviewStore } from './gitReview.js'

vi.mock('../services/gitReview.js', async importOriginal => ({
  ...(await importOriginal()),
  loadGitReviewChanges: vi.fn(),
  loadGitFileDiff: vi.fn(),
  stageGitFile: vi.fn(),
  unstageGitFile: vi.fn(),
}))

const changes = [
  { path: 'both.md', status: 'modified', staged: true, unstaged: true, conflicted: false },
  { path: 'work.md', status: 'new', staged: false, unstaged: true, conflicted: false },
]

describe('gitReview store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    service.loadGitReviewChanges.mockResolvedValue(changes)
    service.loadGitFileDiff.mockImplementation(async (_workspace, path, scope) => ({
      ...changes.find(change => change.path === path),
      scope,
      snapshot: `${path}:${scope}`,
      original: 'before',
      modified: 'after',
      patch: 'patch',
      added: 1,
      removed: 1,
    }))
    service.stageGitFile.mockResolvedValue(undefined)
    service.unstageGitFile.mockResolvedValue(undefined)
  })

  it('filters one authoritative change list by Git scope', async () => {
    const store = useGitReviewStore()
    await store.openWorkspace('/work')
    expect(store.visibleChanges.map(change => change.path)).toEqual(['both.md', 'work.md'])
    await store.setScope('staged')
    expect(store.visibleChanges.map(change => change.path)).toEqual(['both.md'])
    expect(store.stagedCount).toBe(1)
    expect(store.unstagedCount).toBe(2)
  })

  it('does not mutate proposal state while it reviews a Git file', async () => {
    const store = useGitReviewStore()
    await store.openWorkspace('/work')
    await store.reviewFile('both.md')
    expect(store.active).toBe(true)
    expect(store.review).toEqual(expect.objectContaining({ path: 'both.md', scope: 'all' }))
  })

  it('binds stage to the loaded snapshot and reloads the review', async () => {
    const store = useGitReviewStore()
    await store.openWorkspace('/work')
    await store.reviewFile('both.md')
    await store.stageCurrent()
    expect(service.stageGitFile).toHaveBeenCalledWith({
      workspacePath: '/work', file: 'both.md', scope: 'all', expectedSnapshot: 'both.md:all',
    })
    expect(service.loadGitFileDiff).toHaveBeenCalledTimes(2)
    expect(store.notice).toBe('Staged. This file is ready for your next commit.')
  })

  it('projects a non-Git folder as a quiet repository state', async () => {
    service.loadGitReviewChanges.mockRejectedValue(new Error(
      'Could not find a Git repository from /work; class=Repository (6)',
    ))
    const store = useGitReviewStore()
    await store.openWorkspace('/work')
    expect(store.repositoryState).toBe('not-repository')
    expect(store.changesError).toBe('')
  })

  it('keeps the current review visible when a slower request finishes late', async () => {
    const store = useGitReviewStore()
    await store.openWorkspace('/work')
    let finishFirst
    service.loadGitFileDiff
      .mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve }))
      .mockResolvedValueOnce({ ...changes[1], path: 'work.md', scope: 'all', snapshot: 'new' })
    const first = store.reviewFile('both.md')
    await store.reviewFile('work.md')
    finishFirst({ ...changes[0], path: 'both.md', scope: 'all', snapshot: 'old' })
    await first
    expect(store.review.path).toBe('work.md')
  })
})
