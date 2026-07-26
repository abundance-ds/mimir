import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSearchTool } from './search.js'

const invoke = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

describe('search tool', () => {
  beforeEach(() => invoke.mockReset())

  it('searches indexed workspace content and returns relative paths', async () => {
    const token = { requestGeneration: 3, workspaceGeneration: 1 }
    invoke
      .mockResolvedValueOnce(token)
      .mockResolvedValueOnce({
        matches: [{
          path: '/projects/myapp/src/main.js',
          name: 'main.js',
          relativePath: 'src/main.js',
          line: 10,
          column: 7,
          excerpt: 'const x = 42',
        }],
        scannedFiles: 1,
        skippedFiles: 0,
        bytesScanned: 12,
        cancelled: false,
        truncated: false,
      })
    const { search } = createSearchTool({ workspacePath: '/projects/myapp' })

    const result = await search.execute({ query: 'const x' })

    expect(invoke).toHaveBeenCalledWith('file_index_begin_search')
    expect(invoke).toHaveBeenCalledWith('file_index_search', {
      token,
      request: { query: 'const x', pathQuery: null, maxResults: 20 },
    })
    expect(result).toMatchObject({
      query: 'const x',
      count: 1,
      matches: [{ path: 'src/main.js', line: 10, snippet: 'const x = 42' }],
    })
  })

  it('passes file filters and result limits through, keeping exact glob semantics', async () => {
    invoke
      .mockResolvedValueOnce({ requestGeneration: 1, workspaceGeneration: 1 })
      .mockResolvedValueOnce({
        matches: [
          // The fuzzy pathQuery pre-filter can let near-misses through; the
          // tool must re-apply the exact "*.rs" suffix rule.
          { path: '/projects/myapp/src/main.rs', name: 'main.rs', relativePath: 'src/main.rs', line: 1, column: 1, excerpt: 'TODO' },
          { path: '/projects/myapp/notes.rst', name: 'notes.rst', relativePath: 'notes.rst', line: 2, column: 1, excerpt: 'TODO' },
        ],
        scannedFiles: 2,
        skippedFiles: 0,
        bytesScanned: 9,
        cancelled: false,
        truncated: false,
      })
    const { search } = createSearchTool({ workspacePath: '/projects/myapp' })

    const result = await search.execute({ query: 'TODO', file_pattern: '*.rs', limit: 7 })

    expect(invoke).toHaveBeenCalledWith('file_index_search', expect.objectContaining({
      request: expect.objectContaining({ pathQuery: '.rs', maxResults: 7 }),
    }))
    expect(result.matches).toEqual([
      { path: 'src/main.rs', line: 1, snippet: 'TODO' },
    ])
  })

  it('shares the 50-result ceiling advertised by the canonical MCP catalog', () => {
    const { search } = createSearchTool({ workspacePath: '/projects/myapp' })
    expect(search.inputSchema.safeParse({
      scope: 'project',
      query: 'result',
      limit: 50,
    }).success).toBe(true)
    expect(search.inputSchema.safeParse({
      scope: 'project',
      query: 'result',
      limit: 51,
    }).success).toBe(false)
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
