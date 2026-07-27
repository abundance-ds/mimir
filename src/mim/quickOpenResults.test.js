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
  workspacePath: '/work/mim',
  createdAt: '2026-07-25T10:00:00Z',
  updatedAt: '2026-07-25T11:00:00Z',
  archivedAt: '2026-07-25T12:00:00Z',
  source: { presetId: 'codex' },
}
const files = Array.from({ length: 10 }, (_, index) => ({
  path: `/work/mim/${index}.md`,
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
      'tool',
      'new-activity-toggle',
      ...Array(8).fill('file'),
      'history',
    ])
    expect(results.find(result => result.type === 'history').title).toBe('Reopen last closed activity')
  })

  it('expands new activity choices without adding current activity rows', () => {
    const results = buildQuickOpenResults({
      tools: [tool],
      newActivity: [launcher],
      history: [archived],
      files,
      newActivityExpanded: true,
    })

    expect(results.map(result => result.type)).not.toContain('activity')
    expect(results.find(result => result.type === 'new-activity-toggle').verb).toBe('Collapse')
    expect(results.find(result => result.type === 'new-activity').verb).toBe('Start')
    expect(results.find(result => result.type === 'history').verb).toBe('Restore & open')
    expect(results.find(result => result.type === 'file').verb).toBe('Open in Editor')
  })

  it('uses workspace and time instead of a provider-only history title', () => {
    expect(historyDisplayTitle(archived)).toMatch(/^mim · /)
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
    expect(buildQuickOpenResults({ ...common, query: '@ mim' }).map(result => result.type))
      .toEqual(['history'])
  })
})
