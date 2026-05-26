import { describe, it, expect, vi } from 'vitest'
import { groupIntoEpisodes, relativeTime, getTimeGroup } from './audit.js'

function makeEvent(overrides = {}) {
  return {
    id: overrides.id || 'evt-1',
    timestamp: overrides.timestamp || '2026-05-18T10:00:00Z',
    event_type: overrides.event_type || 'session.create',
    session_id: overrides.session_id || 'sess-1',
    payload: overrides.payload || null,
  }
}

describe('groupIntoEpisodes', () => {
  it('returns empty array for empty events', () => {
    expect(groupIntoEpisodes([])).toEqual([])
  })

  it('creates standalone episode for non-AI event', () => {
    const events = [makeEvent({ event_type: 'session.create' })]
    const episodes = groupIntoEpisodes(events)
    expect(episodes).toHaveLength(1)
    expect(episodes[0].events).toHaveLength(1)
    expect(episodes[0].summary).toBe('Session created')
  })

  it('groups AI request + tool calls within 60s into one episode', () => {
    const events = [
      makeEvent({ id: 'e1', event_type: 'ai.request', timestamp: '2026-05-18T10:00:00Z' }),
      makeEvent({ id: 'e2', event_type: 'tool.execute', timestamp: '2026-05-18T10:00:20Z', payload: '{"toolName":"search"}' }),
      makeEvent({ id: 'e3', event_type: 'ai.response', timestamp: '2026-05-18T10:00:45Z' }),
    ]
    const episodes = groupIntoEpisodes(events)
    expect(episodes).toHaveLength(1)
    expect(episodes[0].events).toHaveLength(3)
    expect(episodes[0].id).toBe('e1')
  })

  it('splits events more than 60s apart into separate episodes', () => {
    const events = [
      makeEvent({ id: 'e1', event_type: 'ai.request', timestamp: '2026-05-18T10:00:00Z' }),
      makeEvent({ id: 'e2', event_type: 'ai.request', timestamp: '2026-05-18T10:02:01Z' }),
    ]
    const episodes = groupIntoEpisodes(events)
    expect(episodes).toHaveLength(2)
  })

  it('splits events with different session_ids into separate episodes', () => {
    const events = [
      makeEvent({ id: 'e1', event_type: 'ai.request', session_id: 'sess-1', timestamp: '2026-05-18T10:00:00Z' }),
      makeEvent({ id: 'e2', event_type: 'tool.execute', session_id: 'sess-2', timestamp: '2026-05-18T10:00:10Z' }),
    ]
    const episodes = groupIntoEpisodes(events)
    expect(episodes).toHaveLength(2)
  })

  it('episode summary includes tool names', () => {
    const events = [
      makeEvent({ id: 'e1', event_type: 'ai.request', timestamp: '2026-05-18T10:00:00Z' }),
      makeEvent({ id: 'e2', event_type: 'tool.execute', timestamp: '2026-05-18T10:00:10Z', payload: '{"toolName":"search"}' }),
      makeEvent({ id: 'e3', event_type: 'tool.execute', timestamp: '2026-05-18T10:00:20Z', payload: '{"toolName":"readFile"}' }),
    ]
    const episodes = groupIntoEpisodes(events)
    expect(episodes[0].summary).toBe('AI used search, readFile')
  })

  it('episode summary includes approval info', () => {
    const events = [
      makeEvent({ id: 'e1', event_type: 'ai.request', timestamp: '2026-05-18T10:00:00Z' }),
      makeEvent({ id: 'e2', event_type: 'tool.execute', timestamp: '2026-05-18T10:00:10Z', payload: '{"toolName":"shell","approvalDecision":"user_approved"}' }),
    ]
    const episodes = groupIntoEpisodes(events)
    expect(episodes[0].summary).toContain('(user-approved)')
  })

  it('session lifecycle events get correct summaries', () => {
    const cases = [
      { event_type: 'session.create', expected: 'Session created' },
      { event_type: 'session.archive', expected: 'Session archived' },
      { event_type: 'session.delete', expected: 'Session deleted' },
      { event_type: 'project.create', expected: 'Project created' },
      { event_type: 'project.remove', expected: 'Project removed' },
    ]
    for (const { event_type, expected } of cases) {
      const episodes = groupIntoEpisodes([makeEvent({ event_type })])
      expect(episodes[0].summary).toBe(expected)
    }
  })

  it('export events include format in summary', () => {
    const events = [makeEvent({ event_type: 'export.run', payload: '{"format":"pdf"}' })]
    const episodes = groupIntoEpisodes(events)
    expect(episodes[0].summary).toBe('Exported as pdf')
  })
})

describe('relativeTime', () => {
  it('returns "just now" for recent timestamps', () => {
    const now = new Date().toISOString()
    expect(relativeTime(now)).toBe('just now')
  })

  it('returns "Xm ago" for minutes-old timestamps', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60000).toISOString()
    expect(relativeTime(fiveMinAgo)).toBe('5m ago')
  })

  it('returns "Xh ago" for hours-old timestamps', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600000).toISOString()
    expect(relativeTime(twoHoursAgo)).toBe('2h ago')
  })

  it('returns "yesterday" for timestamps from yesterday', () => {
    const yesterday = new Date(Date.now() - 30 * 3600000).toISOString()
    expect(relativeTime(yesterday)).toBe('yesterday')
  })
})

describe('getTimeGroup', () => {
  it('returns "Today" for today\'s timestamps', () => {
    const now = new Date()
    const todayNoon = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0)
    expect(getTimeGroup(todayNoon.toISOString())).toBe('Today')
  })

  it('returns "Yesterday" for yesterday\'s timestamps', () => {
    const now = new Date()
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12, 0, 0)
    expect(getTimeGroup(yesterday.toISOString())).toBe('Yesterday')
  })

  it('returns "This Week" for timestamps within the last 7 days', () => {
    const now = new Date()
    const threeDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 3, 12, 0, 0)
    expect(getTimeGroup(threeDaysAgo.toISOString())).toBe('This Week')
  })

  it('returns "Earlier" for old timestamps', () => {
    expect(getTimeGroup('2025-01-01T12:00:00Z')).toBe('Earlier')
  })
})
