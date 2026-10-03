import { describe, expect, it } from 'vitest'
import { createReviewSession, decideRemaining, moveReviewHistory, reviewStatus } from './reviewSession.js'
import { mutateReviewComment, reviewComments, reviewContent } from './reviewComments.js'
import { parseCommentTags, stripCommentTags } from '../services/comments/parser.js'

const tagged = '<comment id="a" author="user" text="Check this" status="active">Claim here</comment>'

describe('discussions during review', () => {
  it('compares prose separately from proposed discussion changes', () => {
    const session = createReviewSession('Claim here', tagged)
    expect(session.base).toBe(session.result)
    expect(session.pending).toBe(1)
    expect(reviewComments(session)[0]).toMatchObject({ change: 'Comment added', text: 'Check this' })
    decideRemaining(session, 'accept')
    expect(session.pending).toBe(0)
    expect(reviewStatus(session)).toBe('accepted')
    expect(parseCommentTags(reviewContent(session)).comments).toHaveLength(1)
  })

  it('keeps new replies when text decisions are undone and redone', () => {
    const session = createReviewSession(tagged + ' old.', tagged + ' new.')
    decideRemaining(session, 'accept')
    mutateReviewComment(session, 'reply', { comment_id: 'a', text: 'See docs/spec.md' })
    moveReviewHistory(session, 'undo')
    expect(reviewComments(session)[0].replies[0].text).toBe('See docs/spec.md')
    moveReviewHistory(session, 'redo')
    expect(reviewComments(session)[0].replies).toHaveLength(1)
    expect(session.pending).toBe(0)
  })

  it('accepts a simple comment call on proposed new text', () => {
    const session = createReviewSession('Old passage.', 'New passage.')
    const receipt = mutateReviewComment(session, 'add', { anchor_text: 'New passage.', text: 'Verify this.' })
    expect(receipt.status).toBe('created')
    expect(session.pending).toBe(1)
    decideRemaining(session, 'reject')
    const saved = reviewContent(session)
    expect(stripCommentTags(saved)).toBe('Old passage.')
    expect(parseCommentTags(saved).comments[0]).toMatchObject({ text: 'Verify this.', quote: 'New passage.', anchorText: '' })
    moveReviewHistory(session, 'undo')
    expect(reviewComments(session)[0].detached).toBeNull()
  })

  it('preserves a removed existing discussion instead of proposing its deletion', () => {
    const session = createReviewSession(tagged + '\n\nKeep.', 'Keep.')
    expect(session.pending).toBe(1)
    decideRemaining(session, 'accept')
    expect(parseCommentTags(reviewContent(session)).comments[0]).toMatchObject({ id: 'a', detached: 'removed', quote: 'Claim here' })
  })

  it('never lets multiline wrapper halves become independent text decisions', () => {
    const body = Array.from({ length: 25 }, (_, index) => `Line ${index}`).join('\n')
    const session = createReviewSession(body, `<comment id="a" author="user" text="Check">${body}</comment>`)
    expect(session.pending).toBe(1)
    expect(session.base).toBe(session.result)
    decideRemaining(session, 'reject')
    expect(reviewContent(session)).toBe(body)
    expect(session.pending).toBe(0)
  })

  it('retains discussions and decisions in a JSON round trip', () => {
    const session = createReviewSession(tagged + ' old', tagged + ' new')
    mutateReviewComment(session, 'reply', { comment_id: 'a', text: 'Keep this reply.' })
    decideRemaining(session, 'accept')
    const restored = JSON.parse(JSON.stringify(session))
    moveReviewHistory(restored, 'undo')
    expect(reviewComments(restored)[0].replies[0].text).toBe('Keep this reply.')
    expect(restored.pending).toBe(1)
  })
})
