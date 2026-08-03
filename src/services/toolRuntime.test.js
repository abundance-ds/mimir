import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke, listeners, createMimirTools } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map(),
  createMimirTools: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (event, callback) => {
    listeners.set(event, callback)
    return () => listeners.delete(event)
  }),
}))
vi.mock('./ai/tools/index.js', () => ({
  createMimirTools,
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
    createMimirTools.mockReset()
    createMimirTools.mockImplementation(() => ({
      read: { execute: vi.fn(async input => ({ read: input.target })) },
    }))
  })

  it('installs request and cancellation listeners before starting MCP', async () => {
    invoke.mockImplementation(async command => {
      if (command === 'tool_server_start') {
        expect(listeners.has('mimir://tool-relay-request')).toBe(true)
        expect(listeners.has('mimir://tool-relay-cancel')).toBe(true)
      }
    })
    const runtime = createToolRuntime()
    await runtime.start()
    expect(runtime.started).toBe(true)
  })

  it('keeps relay listeners installed until the native MCP server stops', async () => {
    let startedClientId
    invoke.mockImplementation(async command => {
      if (command === 'tool_server_start') {
        startedClientId = invoke.mock.calls.at(-1)[1].clientId
      }
      if (command === 'tool_server_stop') {
        expect(listeners.has('mimir://tool-relay-request')).toBe(true)
        expect(listeners.has('mimir://tool-relay-cancel')).toBe(true)
        expect(invoke.mock.calls.at(-1)[1].clientId).toBe(startedClientId)
      }
    })
    const runtime = createToolRuntime()
    await runtime.start()
    await runtime.stop()

    expect(runtime.started).toBe(false)
    expect(listeners.has('mimir://tool-relay-request')).toBe(false)
    expect(listeners.has('mimir://tool-relay-cancel')).toBe(false)
  })

  it('routes editor calls without replacing or hiding dirty editor state', async () => {
    const editor = {
      mimirActive: vi.fn(() => ({ path: '/work/a.md', dirty: true, content: 'draft' })),
    }
    const result = await executeToolRequest({
      tool: 'editor.content',
      input: {},
    }, { editor })
    expect(result).toEqual({ path: '/work/a.md', dirty: true, content: 'draft' })
    expect(editor.mimirActive).toHaveBeenCalledWith({ includeContent: true })
  })

  it('returns the composed lean editor state in one call', async () => {
    const state = {
      active: { path: '/work/a.md', dirty: true },
      tabs: [{ path: '/work/a.md', active: true }],
      selection: { from: 2, to: 7, text: 'draft' },
      visibleRange: { fromLine: 1, toLine: 20 },
      comments: { total: 2, unresolved: 1, resolved: 1 },
    }
    const editor = {
      mimirState: vi.fn(() => state),
    }
    const getToday = vi.fn(async () => ({
      text: 'Ship the focused review flow',
      updatedAt: '2026-07-25T10:00:00.000Z',
    }))

    await expect(executeToolRequest({
      tool: 'editor.state',
      input: { include_content: true },
    }, { editor, getToday })).resolves.toEqual({
      ...state,
      today: {
        text: 'Ship the focused review flow',
        updatedAt: '2026-07-25T10:00:00.000Z',
      },
    })
    expect(editor.mimirState).toHaveBeenCalledWith({ includeContent: true })
    expect(getToday).toHaveBeenCalledTimes(1)
  })

  it('routes resolve, reopen, and delete through the active editor comment model', async () => {
    const editor = {
      mimirCommentAction: vi.fn(() => ({ ok: true })),
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

    expect(editor.mimirCommentAction.mock.calls).toEqual([
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

  it('exposes local app definition operations through the canonical MCP runtime', async () => {
    const reloadApps = vi.fn(async () => ({ apps: ['notes'] }))
    const createApp = vi.fn(async input => ({ created: input.id }))
    const duplicateApp = vi.fn(async (id, input) => ({ from: id, to: input.id }))
    const updateApp = vi.fn(async (id, title) => ({ id, title }))
    const trashApp = vi.fn(async id => ({ trashed: id }))
    const options = { reloadApps, createApp, duplicateApp, updateApp, trashApp }

    await expect(executeToolRequest({ tool: 'apps.reload', input: {} }, options))
      .resolves.toEqual({ apps: ['notes'] })
    await expect(executeToolRequest({
      tool: 'apps.create',
      input: { id: 'notes', title: 'Notes', description: 'A note.' },
    }, options)).resolves.toEqual({ created: 'notes' })
    await expect(executeToolRequest({
      tool: 'apps.duplicate',
      input: { app_id: 'notes', new_id: 'notes-copy', title: 'Notes Copy' },
    }, options)).resolves.toEqual({ from: 'notes', to: 'notes-copy' })
    await expect(executeToolRequest({
      tool: 'apps.update',
      input: { app_id: 'notes', title: 'Field Notes' },
    }, options)).resolves.toEqual({ id: 'notes', title: 'Field Notes' })
    await expect(executeToolRequest({
      tool: 'apps.trash',
      input: { app_id: 'notes-copy' },
    }, options)).resolves.toEqual({ trashed: 'notes-copy' })
  })

  it('routes source-aware routine definition mutations through the native runtime', async () => {
    invoke.mockResolvedValue({ revision: 9, routines: [] })
    const definition = {
      id: 'review',
      title: 'Review',
      schedule: '0 9 * * 1-5',
      timezone: 'Europe/Berlin',
      preset: 'codex',
      prompt: 'Review the tree.',
    }

    await executeToolRequest({ tool: 'routines.create', input: { definition } })
    await executeToolRequest({
      tool: 'routines.update',
      input: {
        routine_id: 'review',
        expected_revision: 'sha-1',
        definition: { ...definition, title: 'Sharper review' },
      },
    })
    await executeToolRequest({
      tool: 'routines.duplicate',
      input: {
        routine_id: 'review',
        expected_revision: 'sha-2',
        new_id: 'review-copy',
      },
    })
    await executeToolRequest({
      tool: 'routines.trash',
      input: { routine_id: 'review-copy', expected_revision: 'sha-3' },
    })

    expect(invoke).toHaveBeenNthCalledWith(1, 'routine_create', {
      definition: {
        ...definition,
        enabled: true,
        overlap: 'skip',
        missed: 'run-once',
        workspace: null,
        interactive: false,
      },
    })
    expect(invoke).toHaveBeenNthCalledWith(2, 'routine_update', {
      routineId: 'review',
      expectedRevision: 'sha-1',
      definition: expect.objectContaining({ id: 'review', title: 'Sharper review' }),
    })
    expect(invoke).toHaveBeenNthCalledWith(3, 'routine_duplicate', {
      routineId: 'review',
      expectedRevision: 'sha-2',
      newId: 'review-copy',
      title: null,
    })
    expect(invoke).toHaveBeenNthCalledWith(4, 'routine_trash', {
      routineId: 'review-copy',
      expectedRevision: 'sha-3',
    })

    await expect(executeToolRequest({
      tool: 'routines.update',
      input: {
        routine_id: 'review',
        expected_revision: 'sha-4',
        definition: { ...definition, id: 'different-id' },
      },
    })).rejects.toMatchObject({
      code: 'invalid_input',
      message: expect.stringContaining('must match'),
    })
    expect(invoke).toHaveBeenCalledTimes(4)
  })

  it('routes workspace-safe Files manager operations and preserves structured path errors', async () => {
    invoke
      .mockResolvedValueOnce([{ relativePath: 'docs', isDirectory: true }])
      .mockResolvedValueOnce({ relativePath: 'notes', isDirectory: true })
      .mockResolvedValueOnce({ relativePath: 'renamed.md' })
      .mockResolvedValueOnce({ relativePath: 'renamed copy.md' })
      .mockResolvedValueOnce(['renamed copy.md'])

    await expect(executeToolRequest({
      tool: 'files.browse',
      input: { directory: 'docs' },
    })).resolves.toEqual({
      directory: 'docs',
      entries: [{ relativePath: 'docs', isDirectory: true }],
    })
    await expect(executeToolRequest({
      tool: 'files.create_folder',
      input: { path: 'notes' },
    })).resolves.toEqual({ entry: { relativePath: 'notes', isDirectory: true } })
    await executeToolRequest({
      tool: 'files.rename',
      input: { path: 'draft.md', new_name: 'renamed.md' },
    })
    await executeToolRequest({
      tool: 'files.duplicate',
      input: { path: 'renamed.md' },
    })
    await expect(executeToolRequest({
      tool: 'files.trash',
      input: { paths: ['renamed copy.md'] },
    })).resolves.toEqual({ trashedPaths: ['renamed copy.md'] })

    expect(invoke.mock.calls).toEqual([
      ['workspace_file_list_directory', { directory: 'docs' }],
      ['workspace_file_create', { relativePath: 'notes', directory: true }],
      ['workspace_file_rename', { path: 'draft.md', newName: 'renamed.md' }],
      ['workspace_file_duplicate', { path: 'renamed.md' }],
      ['workspace_file_trash', { paths: ['renamed copy.md'] }],
    ])

    invoke.mockRejectedValueOnce('The path must stay inside the open workspace.')
    await expect(executeToolRequest({
      tool: 'files.rename',
      input: { path: '../escape.md', new_name: 'oops.md' },
    })).rejects.toMatchObject({
      code: 'invalid_input',
      message: expect.stringContaining('inside the open workspace'),
    })
  })

  it('reconciles open editor state around agent renames and trashes', async () => {
    invoke
      .mockResolvedValueOnce({ path: '/w/docs/renamed.md', relativePath: 'docs/renamed.md' })
      .mockResolvedValueOnce(['docs/renamed.md'])
    const calls = []
    const options = {
      getWorkspacePath: () => '/w',
      awaitWorkspaceWrites: async paths => calls.push(['await', paths]),
      moveWorkspacePath: (from, to) => calls.push(['move', from, to]),
      reconcileWorkspaceTrash: paths => calls.push(['trash', paths]),
    }

    await executeToolRequest({
      tool: 'files.rename',
      input: { path: 'docs/draft.md', new_name: 'renamed.md' },
    }, options)
    await executeToolRequest({
      tool: 'files.trash',
      input: { paths: ['docs/renamed.md'] },
    }, options)

    // Pending writes settle before each mutation; tabs repoint or release
    // after, using absolute paths even though the agent named relative ones.
    expect(calls).toEqual([
      ['await', ['/w/docs/draft.md']],
      ['move', '/w/docs/draft.md', '/w/docs/renamed.md'],
      ['await', ['/w/docs/renamed.md']],
      ['trash', ['/w/docs/renamed.md']],
    ])
  })

  it('exposes the complete durable Activity lifecycle', async () => {
    const autoTitleActivity = vi.fn(async (id, title) => ({ id, title }))
    const stopActivity = vi.fn(async id => ({ id, status: 'stopping' }))
    const renameActivity = vi.fn(async (id, title) => ({ id, title }))
    const archiveActivity = vi.fn(async (id, archived) => ({ id, archived }))
    const clearActivity = vi.fn(async id => ({ id, status: 'cleared' }))
    const options = {
      autoTitleActivity,
      stopActivity,
      renameActivity,
      archiveActivity,
      clearActivity,
    }

    await expect(executeToolRequest({
      tool: 'activities.auto-title',
      input: { title: 'Restore Activity titles' },
      context: { metadata: { activityId: 'agent:one' } },
    }, options)).resolves.toEqual({
      id: 'agent:one',
      title: 'Restore Activity titles',
    })
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

  it('rejects automatic title calls outside a scoped Activity', async () => {
    await expect(executeToolRequest({
      tool: 'activities.auto-title',
      input: { title: 'Unscoped title' },
      context: { metadata: {} },
    })).rejects.toMatchObject({
      code: 'invalid_input',
      message: expect.stringContaining('scoped Activity'),
    })
    expect(invoke).not.toHaveBeenCalledWith('activity_auto_title', expect.anything())
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
      mimirActive: vi.fn(() => ({ path: '/work/a.md', dirty: true })),
      mimirReviewProposal: vi.fn(async proposal => ({ proposalId: proposal.id })),
    }
    createMimirTools.mockImplementation(context => ({
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
    expect(editor.mimirReviewProposal).toHaveBeenCalledWith(expect.objectContaining({
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

  it('opens an optional path and routes lean proposals through review', async () => {
    const editor = {
      mimirOpen: vi.fn(async () => ({ path: '/work/a.md' })),
      mimirActive: vi.fn(() => ({ path: '/work/a.md', dirty: false })),
      mimirReviewProposal: vi.fn(async proposal => ({ proposalId: proposal.id })),
    }
    createMimirTools.mockImplementation(context => ({
      edit: {
        execute: vi.fn(async (input) => {
          expect(input.target).toBe('@editor')
          const proposal = {
            id: 'proposal-lean',
            status: 'pending',
            type: 'edit',
            targetText: input.old_text,
            replacement: input.new_text,
          }
          await context.onProposal(proposal)
          return { proposalId: proposal.id, status: 'pending_review' }
        }),
      },
    }))
    invoke.mockResolvedValue(undefined)

    await expect(executeToolRequest({
      tool: 'editor.propose',
      input: {
        path: '/work/a.md',
        old_text: 'before',
        new_text: 'after',
        rationale: 'Clarify.',
      },
      context: { activityId: 'agent-lean' },
    }, { editor })).resolves.toEqual({
      proposalId: 'proposal-lean',
      status: 'pending_review',
    })

    expect(editor.mimirOpen).toHaveBeenCalledWith('/work/a.md')
    expect(editor.mimirReviewProposal).toHaveBeenCalledWith(expect.objectContaining({
      id: 'proposal-lean',
      path: '/work/a.md',
      sessionId: 'agent-lean',
    }))
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
    listeners.get('mimir://tool-relay-cancel')?.({ payload: { id: 'call-1' } })
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
