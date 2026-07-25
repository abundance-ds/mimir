import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSearchTool } from './search.js'

const invoke = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

describe('search tool', () => {
  beforeEach(() => invoke.mockReset())

  it('searches active-workspace content and shortens returned paths', async () => {
    invoke.mockResolvedValue([
      { path: '/projects/myapp/src/main.js', line: 10, snippet: 'const x = 42' },
    ])
    const { search } = createSearchTool({ workspacePath: '/projects/myapp' })

    const result = await search.execute({ query: 'const x' })

    expect(invoke).toHaveBeenCalledWith('search_file_content', {
      path: '/projects/myapp',
      query: 'const x',
      file_pattern: null,
      max_results: 20,
    })
    expect(result).toMatchObject({
      query: 'const x',
      count: 1,
      matches: [{ path: 'src/main.js', line: 10, snippet: 'const x = 42' }],
    })
  })

  it('passes file filters and result limits through', async () => {
    invoke.mockResolvedValue([])
    const { search } = createSearchTool({ workspacePath: '/projects/myapp' })

    await search.execute({ query: 'TODO', file_pattern: '*.rs', limit: 7 })

    expect(invoke).toHaveBeenCalledWith('search_file_content', expect.objectContaining({
      file_pattern: '*.rs',
      max_results: 7,
    }))
  })

  it('requires a query and active workspace', async () => {
    const withWorkspace = createSearchTool({ workspacePath: '/projects/myapp' }).search
    expect((await withWorkspace.execute({})).error).toContain('Query is required')

    const withoutWorkspace = createSearchTool().search
    expect((await withoutWorkspace.execute({ query: 'test' })).error).toBe('No workspace folder is open.')
  })

  it('rejects removed search domains', async () => {
    const { search } = createSearchTool({ workspacePath: '/projects/myapp' })
    const result = await search.execute({ scope: 'references', query: 'smith' })

    expect(result.error).toBe('Unknown search scope: references')
    expect(invoke).not.toHaveBeenCalled()
  })
})
