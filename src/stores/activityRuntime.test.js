import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

let eventCallback = null
vi.mock('../services/activities.js', () => ({
  clearActivity: vi.fn(),
  closeActivity: vi.fn(),
  listActivities: vi.fn(),
  renameActivity: vi.fn(),
  resolveLauncher: vi.fn(),
  respawnActivity: vi.fn(),
  setActivityArchived: vi.fn(),
  spawnActivity: vi.fn(),
  stopActivity: vi.fn(),
  writeActivity: vi.fn(),
  listenToActivityEvents: vi.fn(async (callback) => {
    eventCallback = callback
    return vi.fn()
  }),
}))

import * as api from '../services/activities.js'
import { useActivitiesStore } from './activities.js'
import { exactResumeArguments, useActivityRuntimeStore } from './activityRuntime.js'
import { useWorkbenchStore } from './workbench.js'

const backendRecord = {
  id: 'agent:one',
  kind: 'agent',
  title: 'Codex',
  workspacePath: '/w',
  status: 'working',
  createdAt: '2026-07-25T10:00:00Z',
  updatedAt: '2026-07-25T10:00:01Z',
  retention: 'durable',
  source: { launcherId: 'codex', presetId: 'review' },
  host: { type: 'pty', resumeStrategy: 'codex' },
  launch: { command: '/bin/codex', args: ['review'], cwd: '/w', env: {} },
}

describe('activity runtime store', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.resetAllMocks()
    eventCallback = null
    api.listActivities.mockResolvedValue([backendRecord])
    api.resolveLauncher.mockResolvedValue({
      presetId: 'review',
      title: 'Review',
      kind: 'agent',
      agentId: 'codex',
      resumeStrategy: 'codex',
      command: '/bin/codex',
      args: ['review'],
      cwd: '/w',
      env: {},
    })
    api.spawnActivity.mockImplementation(async (record, _size, cliSessionId) => ({
      record: {
        ...record,
        status: 'idle',
        ...(cliSessionId ? { session: { runId: 'run-1', cliSessionId } } : {}),
      },
      scrollback: { chunks: [] },
      live: true,
    }))
    api.respawnActivity.mockImplementation(async (record, _size, cliSessionId) => ({
      record: { ...record, status: 'idle', session: { runId: 'run-2', cliSessionId } },
      scrollback: { chunks: [] },
      live: true,
    }))
    api.stopActivity.mockResolvedValue()
  })

  it('hydrates authoritative records and subscribes before use', async () => {
    const runtime = useActivityRuntimeStore()
    await runtime.initialize()

    expect(useActivitiesStore().byId('agent:one')).toMatchObject({ status: 'working' })
    expect(api.listenToActivityEvents).toHaveBeenCalledTimes(1)
  })

  it('launches exact resolved argv as a durable agent Activity', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValueOnce('new-id')
    const runtime = useActivityRuntimeStore()
    await runtime.initialize()

    const record = await runtime.launchPreset({
      id: 'review',
      title: 'Review',
      kind: 'agent',
      agentId: 'codex',
      args: ['review'],
      env: {},
      cwd: { mode: 'workspace' },
    }, '/w', {
      env: { APP_CHANNEL: 'review', MIMIR_ACTIVITY_ID: 'must-not-win' },
    })

    expect(api.spawnActivity).toHaveBeenCalledWith(expect.objectContaining({
      id: 'agent:new-id',
      titleSource: 'launcher',
      workspacePath: '/w',
      source: expect.objectContaining({ workspaceScope: 'workspace' }),
      retention: 'durable',
      launch: expect.objectContaining({
        command: '/bin/codex',
        args: ['review'],
        cwd: '/w',
        env: expect.objectContaining({
          APP_CHANNEL: 'review',
          MIMIR_ACTIVITY_ID: 'agent:new-id',
        }),
      }),
    }), {}, null)
    expect(record.status).toBe('idle')
    expect(useWorkbenchStore().activeActivityId).toBe('agent:new-id')
  })

  it('records project scope separately from the resolved process cwd', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValueOnce('home-id')
    api.resolveLauncher.mockResolvedValueOnce({
      presetId: 'home-agent',
      title: 'Home agent',
      kind: 'agent',
      agentId: 'codex',
      resumeStrategy: 'codex',
      command: '/bin/codex',
      args: [],
      cwd: '/Users/me',
      env: {},
    })
    const runtime = useActivityRuntimeStore()

    await runtime.launchPreset({ id: 'home-agent', cwd: { mode: 'home' } }, '/w')

    expect(api.spawnActivity).toHaveBeenCalledWith(expect.objectContaining({
      workspacePath: '',
      source: expect.objectContaining({ workspaceScope: 'global' }),
      launch: expect.objectContaining({ cwd: '/Users/me' }),
    }), {}, null)
  })

  it('protects an explicit launch title from automatic replacement', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValueOnce('explicit-id')
    const runtime = useActivityRuntimeStore()

    await runtime.launchPreset({ id: 'review' }, '/w', {
      title: 'Review · #general',
    })

    expect(api.spawnActivity).toHaveBeenCalledWith(expect.objectContaining({
      id: 'agent:explicit-id',
      title: 'Review · #general',
      titleSource: 'manual',
    }), {}, null)
  })

  it('seeds editable agent input without appending Enter or argv instructions', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValueOnce('seeded-id')
    const runtime = useActivityRuntimeStore()

    await runtime.launchPreset({ id: 'review' }, '/w', {
      seedInput: 'Read #general.\nTask: ',
    })

    expect(api.spawnActivity).toHaveBeenCalledWith(expect.objectContaining({
      id: 'agent:seeded-id',
      launch: expect.objectContaining({ args: ['review'] }),
    }), {}, null)
    expect(api.writeActivity).toHaveBeenCalledWith(
      'agent:seeded-id',
      'Read #general. Task: ',
    )
  })

  it('instruments native resolve and spawn latency as separate launch stages', async () => {
    const clock = vi.spyOn(performance, 'now')
    clock
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(112)
      .mockReturnValueOnce(155)
      .mockReturnValue(155)
    const runtime = useActivityRuntimeStore()

    await runtime.launchPreset({ id: 'review' }, '/w')

    expect(runtime.lastLaunchMetrics).toMatchObject({
      presetId: 'review',
      kind: 'agent',
      resolveMs: 12,
      spawnMs: 43,
      totalMs: 55,
    })
  })

  it.each([
    ['codex', ['review', '--yolo', '-c', 'mcp_servers.mimir_workbench.url="http://127.0.0.1:17532/mcp"'], ['resume', '11111111-1111-4111-8111-111111111111', '--yolo', '-c', 'mcp_servers.mimir_workbench.url="http://127.0.0.1:17532/mcp"']],
    ['claude', ['--session-id', '22222222-2222-4222-8222-222222222222', '--dangerously-skip-permissions', '--mcp-config', '{}'], ['--resume', '11111111-1111-4111-8111-111111111111', '--dangerously-skip-permissions', '--mcp-config', '{}']],
    ['pi', ['--session-id=22222222-2222-4222-8222-222222222222', '--no-approve', '--extension', '/tmp/mimir-tools.ts'], ['--session', '11111111-1111-4111-8111-111111111111', '--no-approve', '--extension', '/tmp/mimir-tools.ts']],
    ['gemini', ['--session-id', '22222222-2222-4222-8222-222222222222', '--yolo', '--model', 'gemini-2.5-pro'], ['--resume', '11111111-1111-4111-8111-111111111111', '--yolo', '--model', 'gemini-2.5-pro']],
  ])('builds exact %s resume argv', (strategy, args, expected) => {
    expect(exactResumeArguments(
      args,
      strategy,
      '11111111-1111-4111-8111-111111111111',
    )).toEqual(expected)
  })

  it('never falls back to an implicit or latest provider session', () => {
    expect(() => exactResumeArguments([], 'codex')).toThrow(/exact provider session id/i)
    expect(() => exactResumeArguments([], 'none', 'session-a')).toThrow(/does not support/i)
    for (const strategy of ['codex', 'claude', 'pi', 'gemini']) {
      const args = exactResumeArguments([], strategy, 'session-a')
      expect(args).toContain('session-a')
      expect(args).not.toContain('latest')
      expect(args).not.toContain('--last')
      expect(args).not.toContain('--continue')
    }
  })

  it('resumes an ended agent with its recorded launch policy and refreshed integration', async () => {
    api.resolveLauncher.mockResolvedValueOnce({
      presetId: 'codex',
      title: 'Codex',
      kind: 'agent',
      agentId: 'codex',
      resumeStrategy: 'codex',
      command: '/bin/codex',
      args: ['--sandbox', 'read-only', '--model', 'gpt-5'],
      cwd: '/w',
      env: {},
    })
    const runtime = useActivityRuntimeStore()
    const ended = {
      ...backendRecord,
      status: 'interrupted',
      launch: {
        command: '/bin/codex',
        args: [
          '--yolo',
          '--model',
          'gpt-5.4',
          '-c',
          'mcp_servers.mimir_workbench.url="http://127.0.0.1:17532/mcp?activityId=agent%3Aone&agentId=codex"',
        ],
        cwd: '/w',
        env: {
          MIMIR_MCP_URL: 'http://127.0.0.1:17532/mcp?activityId=agent%3Aone&agentId=codex',
        },
      },
      session: {
        runId: 'run-1',
        cliSessionId: '11111111-1111-4111-8111-111111111111',
        exit: { reason: 'interrupted' },
      },
    }

    const record = await runtime.resumePreset({ id: 'codex' }, ended)

    expect(api.spawnActivity).not.toHaveBeenCalled()
    expect(api.respawnActivity).toHaveBeenCalledWith(expect.objectContaining({
      id: 'agent:one',
      status: 'ready',
      host: { type: 'pty', resumeStrategy: 'codex' },
      launch: expect.objectContaining({
        command: '/bin/codex',
        args: [
          'resume',
          '11111111-1111-4111-8111-111111111111',
          '--yolo',
          '--model',
          'gpt-5.4',
          '-c',
          'mcp_servers.mimir_workbench.url="http://127.0.0.1:17532/mcp?activityId=agent%3Aone&agentId=codex"',
        ],
        env: expect.objectContaining({
          MIMIR_ACTIVITY_ID: 'agent:one',
          MIMIR_AGENT_ID: 'codex',
          MIMIR_MCP_URL: 'http://127.0.0.1:17532/mcp?activityId=agent%3Aone&agentId=codex',
        }),
      }),
    }), {}, '11111111-1111-4111-8111-111111111111')
    expect(record.session.runId).toBe('run-2')
    expect(useActivitiesStore().byId('agent:one')).toMatchObject({ status: 'idle' })
    expect(useWorkbenchStore().activeActivityId).toBe('agent:one')
  })

  it('refuses an exact id when the launcher now points at another provider', async () => {
    api.resolveLauncher.mockResolvedValueOnce({
      presetId: 'review',
      title: 'Review',
      kind: 'agent',
      agentId: 'claude',
      resumeStrategy: 'claude',
      command: '/bin/claude',
      args: [],
      cwd: '/w',
      env: {},
    })
    const runtime = useActivityRuntimeStore()
    const ended = {
      ...backendRecord,
      status: 'interrupted',
      session: {
        agentId: 'codex',
        cliSessionId: '11111111-1111-4111-8111-111111111111',
      },
    }

    await expect(runtime.resumePreset({ id: 'review' }, ended))
      .rejects.toThrow(/belongs to codex.*resolves to claude/i)
    expect(api.respawnActivity).not.toHaveBeenCalled()
    expect(useActivitiesStore().byId(ended.id).error)
      .toMatch(/Resume failed:.*belongs to codex.*resolves to claude/i)
  })

  it('coalesces duplicate Resume clicks for the same Activity', async () => {
    const runtime = useActivityRuntimeStore()
    const ended = {
      ...backendRecord,
      status: 'interrupted',
      session: {
        cliSessionId: '11111111-1111-4111-8111-111111111111',
      },
    }

    const first = runtime.resumePreset({ id: 'review' }, ended)
    const second = runtime.resumePreset({ id: 'review' }, ended)

    await Promise.all([first, second])
    expect(api.respawnActivity).toHaveBeenCalledTimes(1)
  })

  it('resumes the selected exact session when two Activities share a workspace', async () => {
    const runtime = useActivityRuntimeStore()
    const makeEnded = (id, cliSessionId) => ({
      ...backendRecord,
      id,
      status: 'interrupted',
      session: { cliSessionId },
    })
    const firstId = '11111111-1111-4111-8111-111111111111'
    const secondId = '22222222-2222-4222-8222-222222222222'

    await runtime.resumePreset({ id: 'review' }, makeEnded('agent:first', firstId))
    await runtime.resumePreset({ id: 'review' }, makeEnded('agent:second', secondId))

    expect(api.respawnActivity.mock.calls.map(([record, , cliSessionId]) => ({
      activityId: record.id,
      argv: record.launch.args.slice(0, 2),
      cliSessionId,
    }))).toEqual([
      { activityId: 'agent:first', argv: ['resume', firstId], cliSessionId: firstId },
      { activityId: 'agent:second', argv: ['resume', secondId], cliSessionId: secondId },
    ])
  })

  it('reconciles status and exit events from process truth', async () => {
    const runtime = useActivityRuntimeStore()
    await runtime.initialize()
    eventCallback({
      type: 'status',
      activityId: 'agent:one',
      status: 'needs-input',
      needsInputIsBlocking: true,
    })
    expect(useActivitiesStore().byId('agent:one').status).toBe('needs-input')
    expect(runtime.blockingInputActivityIds.has('agent:one')).toBe(true)

    eventCallback({
      type: 'status',
      activityId: 'agent:one',
      status: 'needs-input',
      needsInputIsBlocking: false,
    })
    expect(runtime.blockingInputActivityIds.has('agent:one')).toBe(false)

    eventCallback({
      type: 'exit',
      activityId: 'agent:one',
      record: { ...backendRecord, status: 'done', updatedAt: '2026-07-25T11:00:00Z' },
      exit: { reason: 'completed', code: 0 },
    })
    expect(useActivitiesStore().byId('agent:one').status).toBe('done')
    expect(runtime.blockingInputActivityIds.has('agent:one')).toBe(false)
  })

  it('marks real output unread only while an agent row is inactive', async () => {
    const runtime = useActivityRuntimeStore()
    const store = useActivitiesStore()
    const workbench = useWorkbenchStore()
    await runtime.initialize()

    eventCallback({ type: 'output', activityId: 'agent:one', sequence: 1, bytes: [65] })
    expect(store.byId('agent:one')).toMatchObject({ unread: true })

    store.upsert({ ...store.byId('agent:one'), unread: false })
    workbench.openActivity('agent:one')
    eventCallback({ type: 'output', activityId: 'agent:one', sequence: 2, bytes: [66] })
    expect(store.byId('agent:one').unread).toBe(false)

    eventCallback({ type: 'output', activityId: 'agent:one', sequence: 3, bytes: [] })
    expect(store.byId('agent:one').unread).toBe(false)
  })

  it('resumes automatically without stealing focus and records a failed cause', async () => {
    const runtime = useActivityRuntimeStore()
    const store = useActivitiesStore()
    await runtime.initialize()
    const interrupted = store.upsert({
      ...backendRecord,
      status: 'interrupted',
      session: { cliSessionId: '11111111-1111-4111-8111-111111111111' },
    })
    api.respawnActivity.mockRejectedValueOnce(new Error('provider session unavailable'))

    const resume = runtime.resumePreset({ id: 'review' }, interrupted, {
      automatic: true,
      open: false,
    })
    expect(runtime.resumingActivityIds.has(interrupted.id)).toBe(true)
    await expect(resume).rejects.toThrow('provider session unavailable')

    expect(runtime.resumingActivityIds.has(interrupted.id)).toBe(false)
    expect(useWorkbenchStore().activeActivityId).toBe('files')
    expect(store.byId(interrupted.id)).toMatchObject({
      status: 'interrupted',
      error: 'Automatic resume failed: provider session unavailable',
    })
  })

  it('keeps automatic restoration silent until the next user turn', async () => {
    const runtime = useActivityRuntimeStore()
    const store = useActivitiesStore()
    await runtime.initialize()
    const interrupted = store.upsert({
      ...backendRecord,
      status: 'interrupted',
      unread: true,
      session: { cliSessionId: '11111111-1111-4111-8111-111111111111' },
    })

    const resume = runtime.resumePreset({ id: 'review' }, interrupted, {
      automatic: true,
      open: false,
    })
    await vi.waitFor(() => {
      expect(store.byId(interrupted.id).status).toBe('idle')
    })

    expect(useWorkbenchStore().activeActivityId).toBe('files')
    expect(store.byId(interrupted.id)).toMatchObject({
      status: 'idle',
      unread: false,
      updatedAt: interrupted.updatedAt,
    })
    expect(runtime.resumingActivityIds.has(interrupted.id)).toBe(true)

    eventCallback({
      type: 'status',
      activityId: interrupted.id,
      status: 'working',
    })
    expect(store.byId(interrupted.id).updatedAt).toBe(interrupted.updatedAt)

    eventCallback({
      type: 'output',
      activityId: interrupted.id,
      sequence: 1,
      bytes: [65],
    })
    await resume
    expect(runtime.resumingActivityIds.has(interrupted.id)).toBe(false)
    expect(store.byId(interrupted.id)).toMatchObject({
      unread: false,
      updatedAt: interrupted.updatedAt,
    })

    eventCallback({
      type: 'output',
      activityId: interrupted.id,
      sequence: 2,
      bytes: [66],
    })
    expect(store.byId(interrupted.id).unread).toBe(false)

    runtime.markActivityInteraction(interrupted.id)
    expect(store.byId(interrupted.id).updatedAt).not.toBe(interrupted.updatedAt)
    eventCallback({
      type: 'output',
      activityId: interrupted.id,
      sequence: 3,
      bytes: [67],
    })
    expect(store.byId(interrupted.id).unread).toBe(true)
  })

  it('turns a silent automatic restore into a visible error instead of loading forever', async () => {
    vi.useFakeTimers()
    const runtime = useActivityRuntimeStore()
    const store = useActivitiesStore()
    await runtime.initialize()
    const interrupted = store.upsert({
      ...backendRecord,
      status: 'interrupted',
      session: { cliSessionId: '11111111-1111-4111-8111-111111111111' },
    })

    const resume = runtime.resumePreset({ id: 'review' }, interrupted, {
      automatic: true,
      open: false,
    })
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(45_000)
    await resume

    expect(runtime.resumingActivityIds.has(interrupted.id)).toBe(false)
    expect(store.byId(interrupted.id).error)
      .toBe('Automatic resume failed: The session started but did not produce terminal output.')
  })

  it('stops through the supervisor and waits for authoritative exit', async () => {
    const runtime = useActivityRuntimeStore()
    await runtime.initialize()
    await runtime.stop('agent:one')

    expect(api.stopActivity).toHaveBeenCalledWith('agent:one')
    expect(useActivitiesStore().byId('agent:one').status).toBe('working')
  })

  it('does not let a late archive response overwrite a newer restore', async () => {
    const runtime = useActivityRuntimeStore()
    const store = useActivitiesStore()
    await runtime.initialize()
    store.upsert({
      ...backendRecord,
      status: 'done',
      updatedAt: '2026-07-25T11:00:00Z',
    })

    let resolveArchive
    let resolveRestore
    api.setActivityArchived
      .mockReturnValueOnce(new Promise((resolve) => {
        resolveArchive = resolve
      }))
      .mockReturnValueOnce(new Promise((resolve) => {
        resolveRestore = resolve
      }))

    const archive = runtime.setArchived('agent:one', true)
    eventCallback({
      type: 'upsert',
      record: {
        ...store.byId('agent:one'),
        archivedAt: '2026-07-25T12:00:00Z',
        updatedAt: '2026-07-25T12:00:00Z',
      },
    })
    const restore = runtime.setArchived('agent:one', false)
    const restoredRecord = {
      ...store.byId('agent:one'),
      archivedAt: null,
      updatedAt: '2026-07-25T12:00:01Z',
    }
    eventCallback({ type: 'upsert', record: restoredRecord })
    resolveRestore(restoredRecord)
    await restore

    resolveArchive({
      ...restoredRecord,
      archivedAt: '2026-07-25T12:00:00Z',
      updatedAt: '2026-07-25T12:00:00Z',
    })
    await archive

    expect(store.byId('agent:one').archivedAt).toBeNull()
  })

  it('treats an omitted archivedAt in an authoritative restore as null', async () => {
    const runtime = useActivityRuntimeStore()
    const store = useActivitiesStore()
    await runtime.initialize()
    store.upsert({
      ...backendRecord,
      status: 'done',
      archivedAt: '2026-07-25T12:00:00Z',
      updatedAt: '2026-07-25T12:00:00Z',
    })
    const { archivedAt: _archivedAt, ...restoredRecord } = store.byId('agent:one')
    api.setActivityArchived.mockResolvedValueOnce({
      ...restoredRecord,
      updatedAt: '2026-07-25T12:00:01Z',
    })

    const restored = await runtime.setArchived('agent:one', false)

    expect(restored.archivedAt).toBeNull()
    expect(store.byId('agent:one').archivedAt).toBeNull()
    expect(store.visibleActivities.map(activity => activity.id)).toContain('agent:one')
  })

  it('renames, archives, and deletes renderer-hosted app Activities without fake PTY calls', async () => {
    const runtime = useActivityRuntimeStore()
    const store = useActivitiesStore()
    store.upsert({
      id: 'app:ledger',
      kind: 'app',
      title: 'Ledger',
      workspacePath: '/w',
      status: 'ready',
      createdAt: '2026-07-25T10:00:00Z',
      updatedAt: '2026-07-25T10:00:00Z',
      retention: 'durable',
      source: { appId: 'ledger' },
      host: { type: 'app', mode: 'embedded' },
      launch: {},
    })

    await runtime.rename('app:ledger', 'Project ledger')
    await runtime.setArchived('app:ledger', true)
    expect(store.byId('app:ledger')).toMatchObject({
      title: 'Project ledger',
      archivedAt: expect.any(String),
    })
    await runtime.clear('app:ledger')

    expect(store.byId('app:ledger')).toBeNull()
    expect(api.renameActivity).not.toHaveBeenCalled()
    expect(api.setActivityArchived).not.toHaveBeenCalled()
    expect(api.clearActivity).not.toHaveBeenCalled()
  })
})
