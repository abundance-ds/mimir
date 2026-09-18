import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('./businessGraph.js', () => ({ queryGraph: vi.fn() }))
import { queryGraph } from './businessGraph.js'
import { projectIssues } from './businessGraphProject.js'

const issue = id => ({ id, title: id, kind: 'issue', projectId: 'atlas' })
beforeEach(() => vi.resetAllMocks())
describe('complete Project work', () => {
  it('loads past the first page and keeps only explicit Project membership', async () => {
    const first = Array.from({ length: 500 }, (_, i) => issue(`task-${i}`))
    queryGraph.mockResolvedValueOnce({ items: first, total: 502, graphRevision: 1 })
      .mockResolvedValueOnce({ items: [issue('late-task'), { ...issue('mention'), projectId: 'other' }], total: 502, graphRevision: 1 })
    const result = await projectIssues('atlas', ['team'])
    expect(result.items).toHaveLength(501)
    expect(result.items.at(-1).id).toBe('late-task')
    expect(queryGraph).toHaveBeenNthCalledWith(2, expect.objectContaining({ projectIds: ['atlas'], kinds: ['issue'], scopeIds: ['team'], offset: 500 }))
  })
  it('restarts when revisions change between pages and stops after repeated changes', async () => {
    const page = Array.from({ length: 500 }, (_, i) => issue(`task-${i}`))
    queryGraph.mockResolvedValueOnce({ items: page, total: 501, graphRevision: 1 })
      .mockResolvedValueOnce({ items: [issue('old')], total: 501, graphRevision: 2 })
      .mockResolvedValueOnce({ items: [issue('new')], total: 1, graphRevision: 2 })
    expect((await projectIssues('atlas', ['team'])).items.map(item => item.id)).toEqual(['new'])
    expect(queryGraph.mock.calls.map(([query]) => query.offset)).toEqual([0, 500, 0])
    let revision = 0
    queryGraph.mockImplementation(async () => ({ items: page, total: 501, graphRevision: ++revision }))
    await expect(projectIssues('atlas', ['team'])).rejects.toThrow('changed while loading')
  })
  it('discards a request when the Project or scope changed during the query', async () => {
    let current = true, finish
    queryGraph.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const request = projectIssues('atlas', ['team'], () => current)
    current = false
    finish({ items: [issue('old')], total: 1, graphRevision: 1 })
    expect(await request).toBeNull()
    expect(queryGraph).toHaveBeenCalledOnce()
  })
})
