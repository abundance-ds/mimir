import { describe, expect, it } from 'vitest'
import {
  buildQuickOpenResults,
  historyDisplayTitle,
  parseQuickOpenQuery,
} from './quickOpenResults.js'

const tool = { id: 'core:files', title: 'Files', icon: 'files' }
const launcher = { id: 'preset:review', title: 'Review with Codex', icon: 'codex' }
const archived = {
  id: 'agent:closed',
  kind: 'agent',
  title: 'Codex',
  status: 'done',
  workspacePath: '/work/mimir',
  createdAt: '2026-07-25T10:00:00Z',
  updatedAt: '2026-07-25T11:00:00Z',
  archivedAt: '2026-07-25T12:00:00Z',
  source: { presetId: 'codex' },
}
const files = Array.from({ length: 10 }, (_, index) => ({
  path: `/work/mimir/${index}.md`,
  name: `${index}.md`,
  relativePath: `${index}.md`,
}))

describe('quick open results', () => {
  it('parses optional scopes without requiring them', () => {
    expect(parseQuickOpenQuery('review')).toEqual({ scope: 'all', term: 'review' })
    expect(parseQuickOpenQuery('/ README')).toEqual({ scope: 'files', term: 'README' })
    expect(parseQuickOpenQuery('@ closed')).toEqual({ scope: 'history', term: 'closed' })
    expect(parseQuickOpenQuery('+ codex')).toEqual({ scope: 'new-activity', term: 'codex' })
  })

  it('keeps navigation compact and preserves eight recent files in the default view', () => {
    const results = buildQuickOpenResults({
      tools: [tool],
      newActivity: [launcher],
      history: [archived],
      files,
    })

    expect(results.map(result => result.type)).toEqual([
      'new-activity-enter',
      'tool',
      ...Array(8).fill('file'),
      'history',
    ])
    expect(results.find(result => result.type === 'history').title).toBe('Reopen last closed activity')
  })

  it('enters a focused new activity result set without other navigation rows', () => {
    const results = buildQuickOpenResults({
      tools: [tool],
      newActivity: [launcher],
      history: [archived],
      files,
      newActivityView: true,
    })

    expect(results.map(result => result.type)).toEqual(['new-activity'])
    expect(results[0].verb).toBe('Start')
  })

  it('uses workspace and time instead of a provider-only history title', () => {
    expect(historyDisplayTitle(archived)).toMatch(/^mimir · /)
    const result = buildQuickOpenResults({
      query: '@',
      history: [archived],
      historySnippets: new Map([['agent:closed', 'Finished the sidebar ordering review.']]),
    })[0]
    expect(result).toMatchObject({
      detail: '/work/mimir',
      snippet: 'Finished the sidebar ordering review.',
      verb: 'Restore transcript',
    })
    expect(result.searchText).toContain('agent:closed')
  })

  it('offers Resume only when History has an exact provider session id', () => {
    const exact = {
      ...archived,
      session: { cliSessionId: '11111111-1111-4111-8111-111111111111' },
    }
    expect(buildQuickOpenResults({ query: '@', history: [exact] })[0].verb).toBe('Resume')
    expect(buildQuickOpenResults({
      query: '@',
      history: [{ ...exact, resumeAvailable: false }],
    })[0].verb).toBe('Restore transcript')
  })

  it('limits symbol scopes to the requested result family', () => {
    const common = {
      tools: [tool],
      newActivity: [launcher],
      history: [archived],
      files,
    }
    expect(buildQuickOpenResults({ ...common, query: '+ codex' }).map(result => result.type))
      .toEqual(['new-activity'])
    expect(buildQuickOpenResults({ ...common, query: '/ 1' }).map(result => result.type))
      .toEqual(['file'])
    expect(buildQuickOpenResults({ ...common, query: '@ mimir' }).map(result => result.type))
      .toEqual(['history'])
  })

  it('browses only current-project history but searches every project', () => {
    const local = { ...archived, id: 'agent:local' }
    const other = {
      ...archived,
      id: 'agent:other',
      title: 'Scribe review',
      workspacePath: '/work/scribe',
      inCurrentWorkspace: false,
    }

    expect(buildQuickOpenResults({ query: '@', history: [other, local] })
      .map(result => result.key)).toEqual(['history:agent:local'])

    expect(buildQuickOpenResults({ query: '@ work', history: [other, local] })
      .map(result => result.key))
      .toEqual(['history:agent:local', 'history:agent:other'])
  })

  it('keeps @ browsing empty when only other projects have history', () => {
    const other = { ...archived, inCurrentWorkspace: false }
    expect(buildQuickOpenResults({ query: '@', history: [other] })).toEqual([])
    expect(buildQuickOpenResults({ query: '@ mimir', history: [other] })
      .map(result => result.key)).toEqual(['history:agent:closed'])
  })

  it('marks other-project sessions with a project chip instead of meta text', () => {
    const other = {
      ...archived,
      workspacePath: '/work/scribe',
      inCurrentWorkspace: false,
    }
    const [row] = buildQuickOpenResults({ query: '@ scribe', history: [other] })
    expect(row).toMatchObject({ project: 'scribe', verb: 'Restore transcript' })
    expect(row.title).not.toContain('scribe')
    expect(row.meta).not.toContain('scribe')

    const [local] = buildQuickOpenResults({ query: '@', history: [archived] })
    expect(local.project).toBe('')
    expect(local.meta).not.toContain('mimir')
  })

  it('reopens the last closed activity from the current project only', () => {
    const local = { ...archived, id: 'agent:local' }
    const other = { ...archived, id: 'agent:other', inCurrentWorkspace: false }

    const reopen = buildQuickOpenResults({ history: [other, local] })
      .find(result => result.type === 'history')
    expect(reopen).toMatchObject({ activityId: 'agent:local' })

    expect(buildQuickOpenResults({ history: [other] })
      .some(result => result.type === 'history')).toBe(false)
  })

  it('finds channels and direct messages without crowding the default view', () => {
    const chats = [
      { id: '#product', kind: 'channel', title: 'product', topic: 'Product decisions' },
      { id: 'anna', kind: 'direct', title: 'Anna Example', topic: '' },
    ]

    expect(buildQuickOpenResults({ chats }).some(result => result.type === 'chat')).toBe(false)
    expect(buildQuickOpenResults({ query: 'product', chats })).toContainEqual(
      expect.objectContaining({
        type: 'chat',
        target: '#product',
        group: 'Chats',
        verb: 'Open',
      }),
    )
    expect(buildQuickOpenResults({ query: 'anna', chats })[0]).toEqual(
      expect.objectContaining({
        type: 'chat',
        target: 'anna',
        title: 'Anna Example',
      }),
    )
  })
})
