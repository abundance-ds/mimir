import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke, listeners } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (event, callback) => {
    listeners.set(event, callback)
    return () => listeners.delete(event)
  }),
}))
vi.mock('./ai/tools/index.js', () => ({
  createMimTools: vi.fn(() => ({
    read: { execute: vi.fn(async input => ({ read: input.target })) },
  })),
}))

import {
  createToolRuntime,
  executeToolRequest,
  normalizeToolError,
} from './toolRuntime.js'

describe('canonical renderer tool runtime', () => {
  beforeEach(() => {
    invoke.mockReset()
    listeners.clear()
  })

  it('installs request and cancellation listeners before starting MCP', async () => {
    invoke.mockImplementation(async command => {
      if (command === 'tool_server_start') {
        expect(listeners.has('mim://tool-relay-request')).toBe(true)
        expect(listeners.has('mim://tool-relay-cancel')).toBe(true)
      }
    })
    const runtime = createToolRuntime()
    await runtime.start()
    expect(runtime.started).toBe(true)
  })

  it('routes editor calls without replacing or hiding dirty editor state', async () => {
    const editor = {
      mimActive: vi.fn(() => ({ path: '/work/a.md', dirty: true, content: 'draft' })),
    }
    const result = await executeToolRequest({
      tool: 'editor.content',
      input: {},
    }, { editor })
    expect(result).toEqual({ path: '/work/a.md', dirty: true, content: 'draft' })
    expect(editor.mimActive).toHaveBeenCalledWith({ includeContent: true })
  })

  it('routes native activity, app, and routine domains through one request shape', async () => {
    const listActivities = vi.fn(async () => ['activity'])
    const listApps = vi.fn(async () => ['app'])
    const runRoutine = vi.fn(async id => ({ id }))
    expect(await executeToolRequest({ tool: 'activities.list' }, { listActivities }))
      .toEqual(['activity'])
    expect(await executeToolRequest({ tool: 'apps.list' }, { listApps }))
      .toEqual(['app'])
    expect(await executeToolRequest(
      { tool: 'routines.run', input: { routine_id: 'review' } },
      { runRoutine },
    )).toEqual({ id: 'review' })
  })

  it('executes catalogued workspace tools under their canonical names', async () => {
    const result = await executeToolRequest({
      tool: 'files.read',
      input: { target: 'README.md' },
      context: { cwd: '/work' },
    })
    expect(result).toEqual({ read: 'README.md' })
  })

  it('returns structured errors and cancels pending calls without replying late', async () => {
    expect(normalizeToolError(Object.assign(new Error('missing'), { code: 'not_found' })))
      .toEqual({ code: 'not_found', message: 'missing', data: undefined })

    let resolve
    const runtime = createToolRuntime({
      listActivities: () => new Promise(done => { resolve = done }),
    })
    await runtime.start()
    invoke.mockClear()
    const pending = runtime.handle({ id: 'call-1', tool: 'activities.list' })
    await Promise.resolve()
    listeners.get('mim://tool-relay-cancel')?.({ payload: { id: 'call-1' } })
    resolve(['late'])
    await pending
    expect(invoke).not.toHaveBeenCalledWith('tool_relay_response', expect.anything())
  })
})
