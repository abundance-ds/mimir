import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useCommentsStore } from './comments.js'

function makeComment(overrides = {}) {
  return {
    id: 'c-test1',
    author: 'user',
    text: 'Fix this',
    created: '2026-01-01T00:00:00Z',
    replies: [],
    tagFrom: 10,
    tagTo: 80,
    contentFrom: 50,
    contentTo: 60,
    anchorText: 'some text',
    ...overrides,
  }
}

describe('comments store (thin reactive mirror)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('starts with empty comments and null activeCommentId', () => {
    const store = useCommentsStore()
    expect(store.comments).toEqual([])
    expect(store.activeCommentId).toBe(null)
  })

  it('updateCommentsFromState replaces comments', () => {
    const store = useCommentsStore()
    const parsed = [makeComment({ id: 'c1' }), makeComment({ id: 'c2' })]
    store.updateCommentsFromState(parsed)
    expect(store.comments).toHaveLength(2)
    expect(store.comments[0].id).toBe('c1')
    expect(store.comments[1].id).toBe('c2')
  })

  it('updateCommentsFromState replaces previous state entirely', () => {
    const store = useCommentsStore()
    store.updateCommentsFromState([makeComment({ id: 'old' })])
    store.updateCommentsFromState([makeComment({ id: 'new' })])
    expect(store.comments).toHaveLength(1)
    expect(store.comments[0].id).toBe('new')
  })

  it('setActiveComment sets and clears activeCommentId', () => {
    const store = useCommentsStore()
    store.setActiveComment('c1')
    expect(store.activeCommentId).toBe('c1')
    store.setActiveComment(null)
    expect(store.activeCommentId).toBe(null)
  })

  it('activeComment computed returns matching comment', () => {
    const store = useCommentsStore()
    expect(store.activeComment).toBe(null)

    store.updateCommentsFromState([makeComment({ id: 'c1' })])
    store.setActiveComment('c1')
    expect(store.activeComment).toBeTruthy()
    expect(store.activeComment.id).toBe('c1')

    store.setActiveComment(null)
    expect(store.activeComment).toBe(null)
  })

  it('activeComment returns null for non-existent id', () => {
    const store = useCommentsStore()
    store.updateCommentsFromState([makeComment({ id: 'c1' })])
    store.setActiveComment('nonexistent')
    expect(store.activeComment).toBe(null)
  })

  it('commentsForFile returns all comments sorted by contentFrom', () => {
    const store = useCommentsStore()
    store.updateCommentsFromState([
      makeComment({ id: 'c2', contentFrom: 30 }),
      makeComment({ id: 'c1', contentFrom: 10 }),
      makeComment({ id: 'c3', contentFrom: 50 }),
    ])
    const result = store.commentsForFile('/test.md')
    expect(result.map(c => c.id)).toEqual(['c1', 'c2', 'c3'])
  })

  it('findActiveByRange finds matching comment by contentFrom/contentTo', () => {
    const store = useCommentsStore()
    store.updateCommentsFromState([
      makeComment({ id: 'c1', contentFrom: 10, contentTo: 20 }),
    ])
    const found = store.findActiveByRange('/test.md', 10, 20)
    expect(found).toBeTruthy()
    expect(found.id).toBe('c1')
  })

  it('findActiveByRange returns null when no match', () => {
    const store = useCommentsStore()
    store.updateCommentsFromState([
      makeComment({ id: 'c1', contentFrom: 10, contentTo: 20 }),
    ])
    expect(store.findActiveByRange('/test.md', 10, 25)).toBe(null)
    expect(store.findActiveByRange('/test.md', 15, 20)).toBe(null)
  })
})
