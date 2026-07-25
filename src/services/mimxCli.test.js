import { afterEach, describe, expect, it, vi } from 'vitest'

import { callTool } from '../../bin/mimx.mjs'

describe('mimx MCP client', () => {
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
})
