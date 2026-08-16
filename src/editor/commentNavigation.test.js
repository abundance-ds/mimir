import { describe, expect, it } from 'vitest'
import { commentNavigationTarget } from './commentNavigation.js'

const comments = [
  { id: 'c3', contentFrom: 90 },
  { id: 'c1', contentFrom: 10 },
  { id: 'c2', contentFrom: 40 },
]

describe('commentNavigationTarget', () => {
  it('moves in document order from the active comment', () => {
    expect(commentNavigationTarget(comments, { activeId: 'c1', direction: 'next' }).id).toBe('c2')
    expect(commentNavigationTarget(comments, { activeId: 'c3', direction: 'previous' }).id).toBe('c2')
  })

  it('wraps at both ends', () => {
    expect(commentNavigationTarget(comments, { activeId: 'c3', direction: 'next' }).id).toBe('c1')
    expect(commentNavigationTarget(comments, { activeId: 'c1', direction: 'previous' }).id).toBe('c3')
  })

  it('starts from the cursor when no comment is active', () => {
    expect(commentNavigationTarget(comments, { cursorPos: 30, direction: 'next' }).id).toBe('c2')
    expect(commentNavigationTarget(comments, { cursorPos: 70, direction: 'previous' }).id).toBe('c2')
  })

  it('returns null when there are no visible comments', () => {
    expect(commentNavigationTarget([], { direction: 'next' })).toBeNull()
  })
})
