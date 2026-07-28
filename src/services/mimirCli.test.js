import { afterEach, describe, expect, it, vi } from 'vitest'
import { Readable, Writable } from 'node:stream'

import {
  callTool,
  discoverTool,
  formatDoctor,
  formatToolCatalog,
  formatPublicTools,
  formatToolHelp,
  findTools,
  helpText,
  request,
  runMcpProxy,
  skillsCommand,
} from '../../bin/mimir.mjs'

describe('mimir MCP client', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('prefers structuredContent over display text', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          result: { protocolVersion: '2025-11-25' },
        }),
      })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: 2,
          result: {
            content: [{ type: 'text', text: 'Human-readable summary' }],
            structuredContent: { value: 42 },
          },
        }),
      })
    vi.stubGlobal('fetch', fetch)

    await expect(callTool('example', { enabled: true }))
      .resolves.toEqual({ value: 42 })
    expect(fetch).toHaveBeenCalledTimes(3)
    const [, request] = fetch.mock.calls[2]
    expect(JSON.parse(request.body)).toMatchObject({
      method: 'tools/call',
      params: { name: 'example', arguments: { enabled: true } },
    })
    expect(request.headers).toMatchObject({
      'mcp-protocol-version': '2025-11-25',
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
    expect(helpText()).toContain('mimir tool <name>')
    expect(helpText()).toContain('mimir skill <query>')
    expect(helpText()).toContain('mimir doctor')
    expect(helpText()).not.toContain('replace-selection')
    expect(helpText('review')).toContain('mimir_propose')
    expect(helpText('docs')).toContain('docs/reference/')
  })

  it('rejects unknown skills subcommands instead of silently listing', async () => {
    await expect(skillsCommand(['nonsense']))
      .rejects.toThrow('Usage: mimir skills [list] [--json]')
  })

  it('renders one concise grouped public catalog without schemas', () => {
    const tools = [
      {
        name: 'mimir_state',
        description: 'Read workbench state.',
        inputSchema: { type: 'object' },
        _meta: { 'mimir/group': 'workbench', 'mimir/effect': 'read' },
      },
      {
        name: 'graph_find',
        description: 'Find graph nodes.',
        inputSchema: { type: 'object' },
        _meta: { 'mimir/group': 'graph', 'mimir/effect': 'read' },
      },
    ]

    const output = formatPublicTools(tools)
    expect(output).toContain('WORKBENCH\n\nmimir_state')
    expect(output).toContain('[read]  Read workbench state.')
    expect(output).toContain('GRAPH\n\ngraph_find')
    expect(output).not.toContain('inputSchema')
  })

  it('finds the one public name and renders focused tool input', async () => {
    const tools = [{
      name: 'graph_create',
      description: 'Create a graph node.',
      inputSchema: {
        type: 'object',
        required: ['title'],
        properties: {
          title: { type: 'string' },
          scopeId: {
            type: 'string',
            description: 'Destination graph scope.',
          },
          redactFromContext: {
            type: 'boolean',
            default: false,
            description: 'Excluded from automatic context; direct reads still return it.',
          },
          source: {
            type: 'object',
            required: ['url'],
            properties: {
              url: { type: 'string', minLength: 1 },
              labels: {
                type: 'array',
                minItems: 1,
                items: { type: 'string' },
              },
            },
          },
        },
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    }]

    await expect(discoverTool('graph_create', tools)).resolves.toBe(tools[0])
    await expect(discoverTool('create', tools)).resolves.toBe(tools[0])
    const output = formatToolHelp(tools[0])
    expect(output).toContain('Required:\n  title: string')
    expect(output).toContain('redactFromContext: boolean (default false)')
    expect(output).toContain('url: string (required; min 1 chars)')
    expect(output).toContain('labels: array<string> (min 1 items)')
    expect(output).toContain('Behavior: mutating')
    expect(output).toContain('mimir call graph_create \'{"title":"..."}\'')
  })

  it('returns a short ranked list when discovery is ambiguous', async () => {
    const tools = [
      { name: 'gmail_read', description: 'Read Gmail.' },
      { name: 'drive_read', description: 'Read Drive.' },
      { name: 'slack_read', description: 'Read Slack.' },
      { name: 'graph_get', description: 'Read a graph node.' },
      { name: 'comments_list', description: 'Read comments.' },
      { name: 'mimir_state', description: 'Read workbench state.' },
    ]

    const result = await findTools('read', tools)
    expect(result.matches).toHaveLength(5)
    expect(result.matches.map(tool => tool.name)).toContain('gmail_read')
  })

  it('preserves connection causes without exposing endpoint query metadata', async () => {
    vi.stubEnv(
      'MIMIR_MCP_URL',
      'http://127.0.0.1:65534/mcp?activityId=secret&agentId=also-secret',
    )
    const cause = Object.assign(new Error('fetch failed'), {
      cause: { code: 'ECONNREFUSED' },
    })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(cause))

    await expect(request('ping', {})).rejects.toThrow(
      'mimir could not reach http://127.0.0.1:65534/mcp: connection refused',
    )
    await expect(request('ping', {})).rejects.not.toThrow('secret')
  })

  it('labels connection registrations honestly and surfaces local credential errors', () => {
    const output = formatDoctor({
      ok: false,
      verbose: false,
      endpoint: 'http://127.0.0.1:17532/mcp',
      context: 'attached',
      scopes: ['private'],
      tools: 5,
      connections: { gmail: true, slack: false },
      connectionDiagnostics: {
        remoteChecked: false,
        google: { status: 'configured' },
        slack: { status: 'error', detail: 'keychain unavailable' },
      },
    })

    expect(output).toContain('Mimir degraded')
    expect(output).toContain('Connection tools gmail')
    expect(output).toContain('Connection errors slack: keychain unavailable')
    expect(output).not.toContain('connected')
  })

  it('bridges stdio MCP messages to the activity-scoped HTTP endpoint', async () => {
    const messages = [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {} },
      },
      { jsonrpc: '2.0', id: 2, method: 'ping', params: {} },
    ]
    const input = Readable.from(messages.map(message => `${JSON.stringify(message)}\n`))
    let stdout = ''
    const output = new Writable({
      write(chunk, _encoding, done) {
        stdout += chunk.toString()
        done()
      },
    })
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          result: { protocolVersion: '2025-11-25' },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({ jsonrpc: '2.0', id: 2, result: {} }),
      })

    await runMcpProxy({
      input,
      output,
      endpoint: 'http://127.0.0.1:17532/mcp?activityId=agent%3A1',
      fetchImpl,
    })

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl.mock.calls[1][1].headers).toMatchObject({
      'mcp-protocol-version': '2025-11-25',
    })
    expect(stdout.trim().split('\n').map(JSON.parse)).toEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        result: { protocolVersion: '2025-11-25' },
      },
      { jsonrpc: '2.0', id: 2, result: {} },
    ])
  })

})
