import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { createReviewSession, decideRemaining } from './reviewSession.js'
import { mutateReviewComment, reviewComments } from './reviewComments.js'

let persistence, records
const clone = value => JSON.parse(JSON.stringify(value))
beforeEach(async () => {
  vi.resetModules()
  window.__TAURI_INTERNALS__ = true
  persistence = await import('./reviewPersistence.js')
  records = new Map()
  invoke.mockReset().mockImplementation(async (command, args) => {
    if (command === 'document_review_read') return records.has(args.key) ? clone(records.get(args.key)) : null
    if (command === 'document_review_save') {
      const revision = records.get(args.key)?.revision || 0
      if (revision !== args.expectedRevision) throw new Error('The review changed in another window.')
      records.set(args.key, { revision: revision + 1, session: clone(args.session) })
      return revision + 1
    }
    throw new Error(command)
  })
})
afterEach(() => { delete window.__TAURI_INTERNALS__; vi.useRealTimers() })

const review = () => Object.assign(createReviewSession('Original.', 'Proposed.'), { key: '/X/note.md' })

describe('durable review state', () => {
  it('serializes rapid saves and restores decisions, replies, and drafts after restart', async () => {
    const session = review()
    const first = persistence.persistReview(session)
    const comment = mutateReviewComment(session, 'add', { anchor_text: 'Proposed.', text: 'Question' })
    const second = persistence.persistReview(session)
    mutateReviewComment(session, 'reply', { comment_id: comment.comment_id, text: 'Answer' })
    decideRemaining(session, 'reject')
    session.commentUI.drafts[comment.comment_id] = 'Unsent draft'
    persistence.scheduleReviewSave(session)
    await persistence.flushReviews()
    await Promise.all([first, second])
    vi.resetModules()
    const restored = await (await import('./reviewPersistence.js')).loadReview(session.key)
    expect(restored.pending).toBe(0)
    expect(restored.commentUI.drafts[comment.comment_id]).toBe('Unsent draft')
    expect(reviewComments(restored)[0]).toMatchObject({ detached: 'rejected', replies: [{ text: 'Answer' }] })
    expect(records.get(session.key).revision).toBe(3)
  })

  it('keeps changes in memory after a failed write and allows an explicit retry', async () => {
    const session = review()
    await persistence.persistReview(session)
    mutateReviewComment(session, 'add', { anchor_text: 'Proposed.', text: 'Keep this' })
    invoke.mockRejectedValueOnce(new Error('Disk full'))
    await expect(persistence.persistReview(session)).rejects.toThrow('Disk full')
    expect(session.saveError).toBe('Disk full')
    expect(session.comments).toHaveLength(1)
    await persistence.persistReview(session)
    expect(session.saveError).toBe('')
    expect(records.get(session.key).session.comments).toHaveLength(1)
  })

  it('refuses a stale writer without overwriting the newer record', async () => {
    const session = review()
    await persistence.persistReview(session)
    records.get(session.key).revision++
    records.get(session.key).session.result = 'Other window'
    await expect(persistence.persistReview(session)).rejects.toThrow('another window')
    expect(records.get(session.key).session.result).toBe('Other window')
    expect(session.result).toBe('Proposed.')
  })

  it('moves a review with its file and prevents the old path from restoring it', async () => {
    const session = review()
    await persistence.persistReview(session)
    await persistence.moveReview(session, '/X/renamed.md')
    expect((await persistence.loadReview('/X/note.md')).completed).toBe(true)
    expect((await persistence.loadReview('/X/renamed.md')).id).toBe(session.id)
    expect((await persistence.loadReview('/Y/note.md'))).toBeNull()
  })

  it('serializes two quick renames without leaving a live review at an old path', async () => {
    const session = review()
    await persistence.persistReview(session)
    await Promise.all([persistence.moveReview(session, '/X/second.md'), persistence.moveReview(session, '/X/third.md')])
    await persistence.flushReviews()
    expect(session.key).toBe('/X/third.md')
    expect(records.get('/X/note.md').session.completed).toBe(true)
    expect(records.get('/X/second.md').session.completed).toBe(true)
    expect(records.get('/X/third.md').session.completed).not.toBe(true)
    expect(records.get('/X/third.md').session.previousKey).toBeUndefined()
  })
})
