import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  callTool,
  formatBoard,
  formatGraph,
  formatToolCatalog,
  helpText,
  terminalGraphCommand,
} from '../../bin/mimir.mjs'

describe('mimir MCP client', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('prefers structuredContent over display text', async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        jsonrpc: '2.0',
        id: 1,
        result: {
          content: [{ type: 'text', text: 'Human-readable summary' }],
          structuredContent: { value: 42 },
        },
      }),
    }))
    vi.stubGlobal('fetch', fetch)

    await expect(callTool('example', { enabled: true }))
      .resolves.toEqual({ value: 42 })
    expect(fetch).toHaveBeenCalledOnce()
    const [, request] = fetch.mock.calls[0]
    expect(JSON.parse(request.body)).toMatchObject({
      method: 'tools/call',
      params: { name: 'example', arguments: { enabled: true } },
    })
  })

  it('preserves structured tool error details', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        jsonrpc: '2.0',
        id: 1,
        result: {
          content: [{ type: 'text', text: 'Fallback error' }],
          structuredContent: {
            error: 'invalid_input',
            message: 'path is required',
            data: { path: '$.path' },
          },
          isError: true,
        },
      }),
    })))

    await expect(callTool('example', {})).rejects.toMatchObject({
      message: 'path is required',
      code: 'invalid_input',
      data: { path: '$.path' },
    })
  })

  it('falls back to legacy text results', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        jsonrpc: '2.0',
        id: 1,
        result: {
          content: [{ type: 'text', text: '{"legacy":true}' }],
        },
      }),
    })))

    await expect(callTool('legacy', {})).resolves.toEqual({ legacy: true })
  })

  it('keeps default help short and progressively discloses focused topics', () => {
    expect(helpText()).toContain('Use normal file and shell tools')
    expect(helpText()).toContain('mimir help <topic>')
    expect(helpText()).not.toContain('replace-selection')
    expect(helpText('editor')).toContain('replace-selection')
    expect(helpText('review')).toContain('mimir_propose')
    expect(helpText('docs')).toContain('docs/reference/')
  })

  it('renders compact topic-filtered catalogs and reserves schemas for JSON', () => {
    const tools = [
      {
        name: 'files_browse',
        description: 'Browse files.',
        inputSchema: { type: 'object' },
        _meta: { 'mimir/canonicalName': 'files.browse' },
      },
      {
        name: 'graph_search',
        description: 'Search the graph.',
        inputSchema: { type: 'object' },
        _meta: { 'mimir/canonicalName': 'graph.search' },
      },
    ]

    expect(formatToolCatalog(tools, { topic: 'graph' }))
      .toBe('graph_search\tSearch the graph.')
    expect(formatToolCatalog(tools, { topic: 'routines' }))
      .toBe("No tools found for topic 'routines'.")
    expect(JSON.parse(formatToolCatalog(tools, { json: true })))
      .toEqual(tools)
  })

  it('renders a compact source-aware graph catalog for terminal work', () => {
    const output = formatGraph([
      {
        id: 'project-atlas',
        kind: 'project',
        title: 'Atlas Value Evidence',
        scopeId: 'team:main',
      },
    ], 1)
    expect(output).toContain('BUSINESS GRAPH · 1 of 1')
    expect(output).toContain('PROJECT')
    expect(output).toContain('team')
    expect(output).toContain('project-atlas')
  })

  it('renders issue status, priority, project, and identity as a terminal board', () => {
    const output = formatBoard([
      {
        id: 'issue-1',
        title: 'Extract evidence',
        status: 'in-progress',
        priority: 'high',
        projectId: 'project-atlas',
      },
    ])
    expect(output).toContain('IN PROGRESS · 1')
    expect(output).toContain('! Extract evidence')
    expect(output).toContain('→ project-atlas')
  })

  it('routes terminal graph projections through the canonical native tools', async () => {
    const call = vi.fn()
      .mockResolvedValueOnce({
        items: [{
          id: 'issue-1',
          kind: 'issue',
          title: 'Extract evidence',
          status: 'plan',
          scopeId: 'project:test',
        }],
        total: 1,
      })
      .mockResolvedValueOnce({ markdown: '# Business graph context' })

    await expect(terminalGraphCommand('board', ['plan'], call))
      .resolves.toContain('PLAN · 1')
    await expect(terminalGraphCommand('context', ['issue-1'], call))
      .resolves.toBe('# Business graph context')
    expect(call).toHaveBeenNthCalledWith(1, 'graph.query', {
      kinds: ['issue'],
      status: 'plan',
      limit: 500,
    })
    expect(call).toHaveBeenNthCalledWith(2, 'graph.context', {
      focusId: 'issue-1',
      maxNodes: 16,
    })
  })
})
