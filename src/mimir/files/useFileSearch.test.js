import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { filterIndexedFiles } from '../../services/fileIndex.js'
import { useFileSearch } from './useFileSearch.js'

vi.mock('../../services/fileIndex.js', () => ({ filterIndexedFiles: vi.fn() }))

const hit = name => ({ file: { path: `/w/${name}`, name, relativePath: name }, score: 1 })
const scopes = []
function setup() {
  const workspacePath = ref('/w')
  const indexedFiles = ref([])
  const searchContent = vi.fn(async query => query ? { matches: [], truncated: false } : null)
  const owner = effectScope()
  scopes.push(owner)
  const search = owner.run(() => useFileSearch({ workspacePath, indexedFiles, searchContent }))
  return { search, workspacePath, indexedFiles, searchContent, owner }
}
async function type(search, value) {
  search.query.value = value
  search.schedule()
  await vi.advanceTimersByTimeAsync(130)
}

describe('file search ownership and transitions', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    filterIndexedFiles.mockReset().mockResolvedValue([])
  })
  afterEach(() => {
    scopes.splice(0).forEach(scope => scope.stop())
    vi.useRealTimers()
  })

  it('uses request results and does not depend on a preloaded index snapshot', async () => {
    const { search, indexedFiles } = setup()
    filterIndexedFiles.mockResolvedValue([hit('found.md')])
    await type(search, 'found')
    expect(indexedFiles.value).toEqual([])
    expect(search.pathResults.value).toEqual([hit('found.md').file])
    expect(search.phase.value).toBe('ready')
  })

  it('shows pending state during the debounce and never keeps old results under a new query', async () => {
    const { search } = setup()
    filterIndexedFiles.mockResolvedValue([hit('old.md')])
    await type(search, 'old')
    search.query.value = 'new'
    search.schedule()
    expect(search.phase.value).toBe('pending')
    expect(search.pathResults.value).toEqual([])
    await vi.advanceTimersByTimeAsync(129)
    expect(filterIndexedFiles).toHaveBeenCalledTimes(1)
  })

  it('ignores an older path response that arrives after a newer response', async () => {
    const { search } = setup()
    let finishOld
    filterIndexedFiles.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve }))
      .mockResolvedValueOnce([hit('new.md')])
    await type(search, 'old')
    await type(search, 'new')
    finishOld([hit('old.md')])
    await nextTick()
    expect(search.pathResults.value).toEqual([hit('new.md').file])
  })

  it('clear invalidates in-flight filename work and restores Names', async () => {
    const { search } = setup()
    let finish
    filterIndexedFiles.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    await type(search, 'old')
    search.clear()
    finish([hit('old.md')])
    await nextTick()
    expect(search.query.value).toBe('')
    expect(search.scope.value).toBe('paths')
    expect(search.phase.value).toBe('idle')
    expect(search.pathResults.value).toEqual([])
  })

  it('preserves the query on scope change and rejects the late response from the other scope', async () => {
    const { search, searchContent } = setup()
    let finish
    filterIndexedFiles.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    await type(search, 'needle')
    searchContent.mockImplementation(async query => query ? { matches: [{ excerpt: 'needle here' }] } : null)
    search.setScope('contents')
    expect(search.query.value).toBe('needle')
    await vi.advanceTimersByTimeAsync(130)
    finish([hit('needle.md')])
    await nextTick()
    expect(search.contentResults.value).toEqual([{ excerpt: 'needle here' }])
    expect(search.pathResults.value).toEqual([])
  })

  it('does not allow one presentation to cancel or replace another', async () => {
    const left = setup()
    const right = setup()
    filterIndexedFiles.mockImplementation(async query => [hit(`${query}.md`)])
    await type(left.search, 'left')
    await type(right.search, 'right')
    right.search.clear()
    expect(left.search.pathResults.value).toEqual([hit('left.md').file])
    expect(left.search.query.value).toBe('left')
    const leftOwner = left.searchContent.mock.calls[0][1].owner
    const rightOwner = right.searchContent.mock.calls[0][1].owner
    expect(leftOwner).not.toBe(rightOwner)
  })

  it('clears searches when the workspace changes and rejects responses from the old workspace', async () => {
    const { search, workspacePath } = setup()
    let finish
    filterIndexedFiles.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    await type(search, 'old')
    workspacePath.value = '/other'
    await nextTick()
    finish([hit('old.md')])
    await nextTick()
    expect(search.phase.value).toBe('idle')
    expect(search.query.value).toBe('')
    expect(search.pathResults.value).toEqual([])
  })

  it('refreshes an active query after a new index snapshot', async () => {
    const { search, indexedFiles } = setup()
    await type(search, 'new')
    expect(search.pathResults.value).toEqual([])
    filterIndexedFiles.mockResolvedValue([hit('new.md')])
    indexedFiles.value = [hit('new.md').file]
    await nextTick()
    expect(search.pending.value).toBe(true)
    await vi.advanceTimersByTimeAsync(130)
    expect(search.pathResults.value).toEqual([hit('new.md').file])
  })

  it('keeps failures distinct from empty results and supports immediate retry', async () => {
    const { search } = setup()
    filterIndexedFiles.mockRejectedValueOnce(new Error('Index unavailable'))
      .mockResolvedValueOnce([hit('found.md')])
    await type(search, 'found')
    expect(search.phase.value).toBe('error')
    expect(search.error.value).toBe('Index unavailable')
    search.schedule({ immediate: true })
    await nextTick()
    expect(search.phase.value).toBe('ready')
    expect(search.error.value).toBe('')
  })

  it('distinguishes native cancellation from a completed search with no matches', async () => {
    const { search, searchContent } = setup()
    searchContent.mockImplementation(async query => query ? null : null)
    search.setScope('contents')
    await type(search, 'needle')
    expect(search.phase.value).toBe('interrupted')
    expect(search.error.value).toContain('interrupted')
    search.clear()
    expect(search.error.value).toBe('')
  })

  it('reports path limits only when an extra result proves that results were omitted', async () => {
    const { search } = setup()
    const matches = Array.from({ length: 251 }, (_, index) => hit(`${index}.md`))
    filterIndexedFiles.mockResolvedValueOnce(matches).mockResolvedValueOnce(matches.slice(0, 250))
    await type(search, 'first')
    expect(search.pathResults.value).toHaveLength(250)
    expect(search.limited.value).toBe(true)
    await type(search, 'second')
    expect(search.limited.value).toBe(false)
  })

  it('clears a previous content limit as soon as a new search starts', async () => {
    const { search, searchContent } = setup()
    searchContent.mockImplementation(async query => query ? { matches: [], truncated: true } : null)
    search.setScope('contents')
    await type(search, 'first')
    expect(search.limited.value).toBe(true)
    search.query.value = 'second'
    search.schedule()
    expect(search.limited.value).toBe(false)
    expect(search.pending.value).toBe(true)
  })
})
