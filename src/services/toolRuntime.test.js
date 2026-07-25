import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke, listeners, createMimTools } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map(),
  createMimTools: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (event, callback) => {
    listeners.set(event, callback)
    return () => listeners.delete(event)
  }),
}))
vi.mock('./ai/tools/index.js', () => ({
  createMimTools,
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
    createMimTools.mockReset()
    createMimTools.mockImplementation(() => ({
      read: { execute: vi.fn(async input => ({ read: input.target })) },
    }))
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

  it('routes resolve, reopen, and delete through the active editor comment model', async () => {
    const editor = {
      mimCommentAction: vi.fn(() => ({ ok: true })),
    }

    await expect(executeToolRequest({
      tool: 'comments.resolve',
      input: { comment_id: 'c1' },
    }, { editor })).resolves.toEqual({ comment_id: 'c1', status: 'resolved' })
    await expect(executeToolRequest({
      tool: 'comments.reopen',
      input: { comment_id: 'c1' },
    }, { editor })).resolves.toEqual({ comment_id: 'c1', status: 'active' })
    await expect(executeToolRequest({
      tool: 'comments.delete',
      input: { comment_id: 'c1' },
    }, { editor })).resolves.toEqual({ comment_id: 'c1', status: 'deleted' })

    expect(editor.mimCommentAction.mock.calls).toEqual([
      ['resolve', 'c1'],
      ['reopen', 'c1'],
      ['delete', 'c1'],
    ])
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

  it('exposes the complete durable Activity lifecycle', async () => {
    const stopActivity = vi.fn(async id => ({ id, status: 'stopping' }))
    const renameActivity = vi.fn(async (id, title) => ({ id, title }))
    const archiveActivity = vi.fn(async (id, archived) => ({ id, archived }))
    const clearActivity = vi.fn(async id => ({ id, status: 'cleared' }))
    const options = { stopActivity, renameActivity, archiveActivity, clearActivity }

    await expect(executeToolRequest({
      tool: 'activities.stop',
      input: { activity_id: 'agent:one' },
    }, options)).resolves.toEqual({ id: 'agent:one', status: 'stopping' })
    await expect(executeToolRequest({
      tool: 'activities.rename',
      input: { activity_id: 'agent:one', title: 'Review' },
    }, options)).resolves.toEqual({ id: 'agent:one', title: 'Review' })
    await expect(executeToolRequest({
      tool: 'activities.archive',
      input: { activity_id: 'agent:one', archived: true },
    }, options)).resolves.toEqual({ id: 'agent:one', archived: true })
    await expect(executeToolRequest({
      tool: 'activities.clear',
      input: { activity_id: 'agent:one' },
    }, options)).resolves.toEqual({ id: 'agent:one', status: 'cleared' })
  })

  it('executes catalogued workspace tools under their canonical names', async () => {
    const result = await executeToolRequest({
      tool: 'files.read',
      input: { target: 'README.md' },
      context: { cwd: '/work' },
    })
    expect(result).toEqual({ read: 'README.md' })
  })

  it('opens MCP editor edits as real reviews and registers their lifecycle', async () => {
    const editor = {
      mimActive: vi.fn(() => ({ path: '/work/a.md', dirty: true })),
      mimReviewProposal: vi.fn(async proposal => ({ proposalId: proposal.id })),
    }
    createMimTools.mockImplementation(context => ({
      edit: {
        execute: vi.fn(async () => {
          const proposal = {
            id: 'proposal-1',
            status: 'pending',
            type: 'edit',
            targetText: 'old',
            replacement: 'new',
          }
          await context.onProposal(proposal)
          return { status: 'pending_review' }
        }),
      },
    }))
    invoke.mockResolvedValue(undefined)

    const result = await executeToolRequest({
      tool: 'files.edit',
      input: { target: '@editor', old_text: 'old', new_text: 'new' },
      context: { activityId: 'agent-1' },
    }, { editor })

    expect(result).toEqual({ status: 'pending_review' })
    expect(editor.mimReviewProposal).toHaveBeenCalledWith(expect.objectContaining({
      id: 'proposal-1',
      path: '/work/a.md',
      sessionId: 'agent-1',
    }))
    expect(invoke).toHaveBeenCalledWith('proposal_create', {
      proposal: expect.objectContaining({
        id: 'proposal-1',
        absolutePath: '/work/a.md',
        threadId: 'agent-1',
      }),
    })
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

  it('rejects setting values that would corrupt the live editor configuration', async () => {
    const settings = {
      editorFontSize: 16,
      editorWordWrap: true,
      set: vi.fn(),
      save: vi.fn(),
    }

    await expect(executeToolRequest({
      tool: 'settings.update',
      input: { values: { editorFontSize: 'huge' } },
    }, { settings })).rejects.toMatchObject({
      code: 'invalid_input',
      message: expect.stringContaining('incompatible value type'),
    })
    expect(settings.set).not.toHaveBeenCalled()
  })
})
