import { describe, it, expect } from 'vitest'
import { formatCommentsMessage, snapshotSession } from './persistence.js'
import { stripHfu } from '../../shared/hfu.js'

describe('formatCommentsMessage', () => {
  const twoComments = [{}, {}]
  const oneComment = [{}]

  it('wraps document content in hfu tags', () => {
    const msg = formatCommentsMessage(twoComments, 'paper.md', 'doc with <comment>tags</comment>')
    expect(msg).toContain('<hfu content-hidden-from-user>')
    expect(msg).toContain('</hfu>')
    expect(msg).toContain('doc with <comment>tags</comment>')
  })

  it('visible portion is just the instruction sentence', () => {
    const msg = formatCommentsMessage(twoComments, 'paper.md', 'full document here')
    const visible = stripHfu(msg)
    expect(visible).toBe('Please address the 2 review comments on "paper.md". The document with inline comments follows:')
    expect(visible).not.toContain('full document here')
  })

  it('singular comment when count is 1', () => {
    const msg = formatCommentsMessage(oneComment, 'notes.md', 'content')
    expect(stripHfu(msg)).toContain('1 review comment on')
    expect(stripHfu(msg)).not.toContain('review comments')
  })

  it('without document content, suggests read tool with show_comments', () => {
    const msg = formatCommentsMessage(twoComments, 'paper.md', null)
    expect(msg).not.toContain('<hfu>')
    expect(msg).toContain('read("@editor"')
    expect(msg).toContain('show_comments')
  })
})

describe('snapshotSession', () => {
  function makeSession(overrides = {}) {
    return {
      id: 'snap-test',
      projectId: 'general',
      label: 'Test',
      modelId: 'auto',
      controlId: '',
      proposals: [],
      usage: {},
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
      lastViewedAt: '2025-01-01T00:00:00.000Z',
      archived: false,
      pinned: false,
      projectLocked: false,
      lastError: '',
      _savedMessages: [],
      type: 'chat',
      lastInputTokens: 0,
      ...overrides,
    }
  }

  it('preserves linkedEntries', () => {
    const session = makeSession({ linkedEntries: ['e1', 'e2'] })
    const snap = snapshotSession(session)
    expect(snap.linkedEntries).toEqual(['e1', 'e2'])
  })

  it('defaults linkedEntries to empty array when missing', () => {
    const session = makeSession()
    delete session.linkedEntries
    const snap = snapshotSession(session)
    expect(snap.linkedEntries).toEqual([])
  })

  it('defaults linkedEntries to empty array when not an array', () => {
    const session = makeSession({ linkedEntries: 'not-an-array' })
    const snap = snapshotSession(session)
    expect(snap.linkedEntries).toEqual([])
  })
})
