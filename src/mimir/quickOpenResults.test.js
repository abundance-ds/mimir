import { describe, expect, it } from 'vitest'
import {
  buildQuickOpenResults,
  historyDisplayTitle,
  parseQuickOpenQuery,
} from './quickOpenResults.js'

const tool = { id: 'core:files', title: 'Files', icon: 'files' }
const launcher = { id: 'preset:review', title: 'Review with Codex', icon: 'codex' }
const projects = [
  { name: 'mimir', path: '/work/mimir', current: true },
  { name: 'scribe', path: '/work/scribe' },
]
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
const unavailableActivity = {
  id: 'agent:orphaned',
  kind: 'agent',
  title: 'Recover release notes',
  status: 'interrupted',
  workspacePath: '/work/removed',
  source: { presetId: 'codex' },
}
const files = Array.from({ length: 10 }, (_, index) => ({
  path: `/work/mimir/${index}.md`,
  name: `${index}.md`,
  relativePath: `${index}.md`,
}))

describe('quick open results', () => {
  it('lists all open tabs first in navigation order, with the current tab last', () => {
    const activities = Array.from({ length: 8 }, (_, i) => ({ id: `agent:${i}`, title: `Work ${i}`, openTab: true, kind: 'agent' }))
    const documents = [{ id: 'draft', name: 'Untitled', path: null }, { id: 'saved', name: 'a.md', path: '/w/a.md' }]
    const results = buildQuickOpenResults({ activities, documents, recentTabKeys: ['activity:agent:0', 'document:draft', 'activity:agent:4'], currentTabKey: 'activity:agent:0', newActivity: [launcher], files: [{ name: 'a.md', path: '/w/a.md' }] })
    expect(results.slice(0, 3).map(row => row.key)).toEqual(['document:draft', 'activity:agent:4', 'activity:agent:1'])
    expect(results.filter(row => row.group === 'Open tabs')).toHaveLength(10)
    expect(results[9].key).toBe('activity:agent:0')
    expect(results.some(row => row.type === 'file' && row.path === '/w/a.md')).toBe(false)
  })

  it('keeps every search source and prefix reachable after prioritising open tabs', () => {
    const input = {
      activities: [{ id: 'agent:open', title: 'Match session', openTab: true }],
      documents: [{ id: 'draft', name: 'Match document' }],
      tools: [{ id: 'core:match', title: 'Match tool' }],
      newActivity: [{ id: 'launch', title: 'Match launcher' }],
      projects: [{ name: 'Match project', path: '/match' }],
      files: [{ name: 'Match file', path: '/match/file.md' }],
      chats: [{ id: 'match-room', title: 'Match room', kind: 'direct' }],
      history: [{ ...archived, title: 'Match history' }],
    }
    expect(buildQuickOpenResults({ ...input, query: 'match' }).map(row => row.type)).toEqual(['activity', 'document', 'new-activity', 'tool', 'project', 'file', 'chat', 'history'])
    for (const [prefix, type] of [['a:', 'activity'], ['n:', 'new-activity'], ['t:', 'tool'], ['p:', 'project'], ['f:', 'file'], ['c:', 'chat'], ['h:', 'history']]) {
      expect(buildQuickOpenResults({ ...input, query: `${prefix}match` }).some(row => row.type === type)).toBe(true)
    }
    expect(buildQuickOpenResults({ ...input, query: 'f:document' })[0]).toMatchObject({ type: 'document', documentId: 'draft', verb: 'Switch' })
  })

  it('parses optional scopes without requiring them', () => {
    expect(parseQuickOpenQuery('review')).toEqual({ scope: 'all', term: 'review' })
    expect(parseQuickOpenQuery('a:release')).toEqual({ scope: 'activities', term: 'release' })
    expect(parseQuickOpenQuery('p:mimir')).toEqual({ scope: 'projects', term: 'mimir' })
    expect(parseQuickOpenQuery('f:README')).toEqual({ scope: 'files', term: 'README' })
    expect(parseQuickOpenQuery('h:closed')).toEqual({ scope: 'history', term: 'closed' })
    expect(parseQuickOpenQuery('n:codex')).toEqual({ scope: 'new-activity', term: 'codex' })
    expect(parseQuickOpenQuery('t:files')).toEqual({ scope: 'tools', term: 'files' })
    expect(parseQuickOpenQuery('c:product')).toEqual({ scope: 'chats', term: 'product' })
    expect(parseQuickOpenQuery('.env')).toEqual({ scope: 'all', term: '.env' })
  })

  it('keeps every useful default group compact', () => {
    const results = buildQuickOpenResults({
      tools: [tool],
      projects,
      currentProjectPath: '/work/mimir',
      newActivity: [launcher],
      history: [archived],
      files,
    })

    expect(results.map(result => result.type)).toEqual([
      'new-activity-enter',
      'tool',
      'project',
      ...Array(5).fill('file'),
      'history',
    ])
    expect(results.find(result => result.type === 'project')).toMatchObject({
      title: 'scribe',
      meta: '/work',
    })
    expect(results.find(result => result.type === 'history').title).toBe('Reopen last closed activity')
  })

  it('retains matching groups and ranks exact titles inside each group', () => {
    const results = buildQuickOpenResults({
      query: 'codex',
      tools: [{ id: 'app:notes', title: 'Codex notes', icon: 'apps' }],
      projects: [{ name: 'codex', path: '/work/codex' }],
      newActivity: [launcher, { id: 'preset:codex', title: 'Codex', icon: 'codex' }],
      history: [archived],
      files: [{ path: '/work/codex.md', name: 'codex.md', relativePath: 'codex.md' }],
    })

    expect(results.map(result => result.group)).toEqual([
      'New activity',
      'New activity',
      'Tools',
      'Projects',
      'Files',
      'History',
    ])
    expect(results[0].title).toBe('Codex')
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

  it('keeps Activities from unavailable workspaces searchable without adding projects', () => {
    const [result] = buildQuickOpenResults({
      query: 'a:release',
      activities: [unavailableActivity],
      projects,
    })

    expect(result).toMatchObject({
      key: 'activity:agent:orphaned',
      type: 'activity',
      group: 'Activities',
      title: 'Recover release notes',
      project: 'removed',
      detail: '/work/removed',
      verb: 'Open',
    })
    expect(result.meta).toContain('workspace not found')
    expect(buildQuickOpenResults({
      query: 'p:',
      activities: [unavailableActivity],
      projects,
    }).map(row => row.type)).not.toContain('activity')
  })

  it('uses workspace and time instead of a provider-only history title', () => {
    expect(historyDisplayTitle(archived)).toMatch(/^mimir · /)
    const result = buildQuickOpenResults({
      query: 'h:',
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
    expect(buildQuickOpenResults({ query: 'h:', history: [exact] })[0].verb).toBe('Resume')
    expect(buildQuickOpenResults({
      query: 'h:',
      history: [{ ...exact, resumeAvailable: false }],
    })[0].verb).toBe('Restore transcript')
  })

  it('limits typed scopes to the requested result family', () => {
    const common = {
      tools: [tool],
      projects,
      newActivity: [launcher],
      activities: [unavailableActivity],
      history: [archived],
      files,
    }
    expect(buildQuickOpenResults({ ...common, query: 'n:codex' }).map(result => result.type))
      .toEqual(['new-activity'])
    expect(buildQuickOpenResults({ ...common, query: 'a:release' }).map(result => result.type))
      .toEqual(['activity'])
    expect(buildQuickOpenResults({ ...common, query: 'f:1' }).map(result => result.type))
      .toEqual(['file'])
    expect(buildQuickOpenResults({ ...common, query: 'h:mimir' }).map(result => result.type))
      .toEqual(['history'])
    expect(buildQuickOpenResults({ ...common, query: 't:files' }).map(result => result.type))
      .toEqual(['tool'])
    expect(buildQuickOpenResults({ ...common, query: 'p:' }).map(result => result.type))
      .toEqual(['project', 'project-open', 'project-create'])
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

    expect(buildQuickOpenResults({ query: 'h:', history: [other, local] })
      .map(result => result.key)).toEqual(['history:agent:local'])

    expect(buildQuickOpenResults({ query: 'h:work', history: [other, local] })
      .map(result => result.key))
      .toEqual(['history:agent:local', 'history:agent:other'])
  })

  it('keeps empty h: browsing local when only other projects have history', () => {
    const other = { ...archived, inCurrentWorkspace: false }
    expect(buildQuickOpenResults({ query: 'h:', history: [other] })).toEqual([])
    expect(buildQuickOpenResults({ query: 'h:mimir', history: [other] })
      .map(result => result.key)).toEqual(['history:agent:closed'])
  })

  it('marks other-project sessions with a project chip instead of meta text', () => {
    const other = {
      ...archived,
      workspacePath: '/work/scribe',
      inCurrentWorkspace: false,
    }
    const [row] = buildQuickOpenResults({ query: 'h:scribe', history: [other] })
    expect(row).toMatchObject({ project: 'scribe', verb: 'Restore transcript' })
    expect(row.title).not.toContain('scribe')
    expect(row.meta).not.toContain('scribe')

    const [local] = buildQuickOpenResults({ query: 'h:', history: [archived] })
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
    expect(buildQuickOpenResults({ query: 'c:', chats }).map(result => result.type))
      .toEqual(['chat', 'chat'])
  })
})
