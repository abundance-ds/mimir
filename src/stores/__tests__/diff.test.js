import { describe, it, expect, beforeEach } from 'vitest'
import { useDiffStore } from '../diff.js'

describe('review decision history', () => {
  let store
  beforeEach(() => {
    store = useDiffStore()
    store.activateBatch({ fileList: ['a', 'b', 'c'].map(name => ({ path: `/${name}.md`, original: 'old', modified: 'new' })) })
  })

  it.each(['accept', 'reject'])('can undo and redo a file %s decision', action => {
    store.decideRemainingChanges(action, '/a.md')
    expect(store.files[0].status).toBe(action === 'accept' ? 'accepted' : 'rejected')
    expect(store.undoReview()).toBe(true)
    expect(store.files[0].status).toBe('pending')
    expect(store.files[0].review.pending).toBe(1)
    expect(store.redoReview()).toBe(true)
    expect(store.files[0].modified).toBe(action === 'accept' ? 'new' : 'old')
  })

  it('keeps prior decisions when accepting or rejecting remaining files', () => {
    store.decideRemainingChanges('reject', '/a.md')
    store.decideRemainingChanges('accept', '/b.md')
    store.decideRemainingChanges('reject')
    expect(store.files.map(file => file.modified)).toEqual(['old', 'new', 'old'])
    expect(store.canFinish).toBe(true)
    store.undoReview()
    expect(store.files.map(file => file.status)).toEqual(['rejected', 'accepted', 'pending'])
    expect(store.canFinish).toBe(false)
  })

  it('treats a bulk decision as one Undo step across files', () => {
    store.decideRemainingChanges('accept')
    expect(store.canFinish).toBe(true)
    store.undoReview()
    expect(store.pendingChanges).toBe(3)
    store.redoReview()
    expect(store.pendingChanges).toBe(0)
  })

  it('cannot undo applied or reported files after a partial finish', () => {
    store.decideRemainingChanges('accept')
    store.files[0].applied = true
    store.files[1].lifecycleResolved = true
    store.undoReview()
    expect(store.files.map(file => file.status)).toEqual(['accepted', 'accepted', 'pending'])
    expect(store.canUndo).toBe(false)
  })

  it('invalidates redo after a new decision', () => {
    store.decideRemainingChanges('accept')
    store.undoReview()
    store.decideRemainingChanges('reject', '/a.md')
    expect(store.canRedo).toBe(false)
    expect(store.redoReview()).toBe(false)
  })

  it('ignores an obsolete view callback after a new review begins', () => {
    const session = store.files[0].review
    store.activate({ original: 'another', modified: 'proposal' })
    store.recordReviewChange(session, 'new', 'new', 'accept')
    expect(store.currentReview.result).toBe('proposal')
    expect(store.canUndo).toBe(false)
  })
})
