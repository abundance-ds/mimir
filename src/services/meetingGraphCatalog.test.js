import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createGraphNode,
  openBusinessGraph,
  queryGraph,
} from './businessGraph.js'
import {
  createMeetingGraphEntity,
  loadMeetingGraphCatalog,
  preferredMeetingGraphScope,
} from './meetingGraphCatalog.js'

vi.mock('./businessGraph.js', () => ({
  createGraphNode: vi.fn(),
  openBusinessGraph: vi.fn(),
  queryGraph: vi.fn(),
}))

describe('meeting Graph catalog', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(openBusinessGraph).mockResolvedValue({
      scopes: [
        { id: 'project:work', kind: 'project' },
        { id: 'team:main', kind: 'team' },
      ],
    })
    vi.mocked(queryGraph).mockResolvedValue({
      items: [
        { id: 'project-alpha', kind: 'project', title: 'Alpha' },
        { id: 'person-ana', kind: 'person', title: 'Ana' },
        { id: 'issue-1', kind: 'issue', title: 'Not included' },
      ],
    })
  })

  it('loads Project and Person choices from every mounted scope', async () => {
    const catalog = await loadMeetingGraphCatalog('/work', '/team')
    expect(queryGraph).toHaveBeenCalledWith({
      scopeIds: ['project:work', 'team:main'],
      kinds: ['project', 'person'],
      limit: 500,
    })
    expect(catalog.projects.map(node => node.id)).toEqual(['project-alpha'])
    expect(catalog.people.map(node => node.id)).toEqual(['person-ana'])
    expect(preferredMeetingGraphScope(catalog.scopes)).toBe('team:main')
  })

  it('creates only a minimal Project or Person in the selected normal scope', async () => {
    vi.mocked(createGraphNode).mockResolvedValue({ id: 'person-new', kind: 'person' })
    await createMeetingGraphEntity({ kind: 'person', title: 'New Person', scopeId: 'team:main' })
    expect(createGraphNode).toHaveBeenCalledWith({
      kind: 'person',
      scopeId: 'team:main',
      title: 'New Person',
      summary: '',
      body: '',
      tags: [],
      relations: [],
      properties: { status: 'active', teamMember: false },
    })
  })
})
