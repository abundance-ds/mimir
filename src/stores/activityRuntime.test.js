import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

let eventCallback = null
vi.mock('../services/activities.js', () => ({
  clearActivity: vi.fn(),
  listActivities: vi.fn(),
  renameActivity: vi.fn(),
  resolveLauncher: vi.fn(),
  respawnActivity: vi.fn(),
  setActivityArchived: vi.fn(),
  spawnActivity: vi.fn(),
  stopActivity: vi.fn(),
  listenToActivityEvents: vi.fn(async (callback) => {
    eventCallback = callback
    return vi.fn()
  }),
}))

import * as api from '../services/activities.js'
import { useActivitiesStore } from './activities.js'
import { resumeArguments, useActivityRuntimeStore } from './activityRuntime.js'
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
    api.spawnActivity.mockImplementation(async (record) => ({ record: { ...record, status: 'idle' }, scrollback: { chunks: [] }, live: true }))
    api.respawnActivity.mockImplementation(async (record) => ({
      record: { ...record, status: 'idle', session: { runId: 'run-2' } },
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
      env: { APP_CHANNEL: 'review', MIM_ACTIVITY_ID: 'must-not-win' },
    })

    expect(api.spawnActivity).toHaveBeenCalledWith(expect.objectContaining({
      id: 'agent:new-id',
      retention: 'durable',
      launch: expect.objectContaining({
        command: '/bin/codex',
        args: ['review'],
        cwd: '/w',
        env: expect.objectContaining({
          APP_CHANNEL: 'review',
          MIM_ACTIVITY_ID: 'agent:new-id',
        }),
      }),
    }))
    expect(record.status).toBe('idle')
    expect(useWorkbenchStore().activeActivityId).toBe('agent:new-id')
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
    ['codex', ['-c', 'mcp_servers.mim_workbench.url="http://127.0.0.1:17532/mcp"'], ['resume', '--last', '-c', 'mcp_servers.mim_workbench.url="http://127.0.0.1:17532/mcp"']],
    ['claude', ['--mcp-config', '{}'], ['--continue', '--mcp-config', '{}']],
    ['pi', ['--extension', '/tmp/mim-tools.ts'], ['--continue', '--extension', '/tmp/mim-tools.ts']],
    ['none', ['--flag'], ['--flag']],
  ])('builds exact %s resume argv', (strategy, args, expected) => {
    expect(resumeArguments(args, strategy)).toEqual(expected)
  })

  it('resumes an ended agent inside its existing Activity identity', async () => {
    api.resolveLauncher.mockResolvedValueOnce({
      presetId: 'codex',
      title: 'Codex',
      kind: 'agent',
      agentId: 'codex',
      resumeStrategy: 'codex',
      command: '/bin/codex',
      args: ['--model', 'gpt-5', '-c', 'mcp_servers.mim_workbench.url="http://127.0.0.1:17532/mcp"'],
      cwd: '/w',
      env: {},
    })
    const runtime = useActivityRuntimeStore()
    const ended = {
      ...backendRecord,
      status: 'interrupted',
      session: { runId: 'run-1', exit: { reason: 'interrupted' } },
    }

    const record = await runtime.resumePreset({ id: 'codex' }, ended)

    expect(api.spawnActivity).not.toHaveBeenCalled()
    expect(api.respawnActivity).toHaveBeenCalledWith(expect.objectContaining({
      id: 'agent:one',
      status: 'ready',
      host: { type: 'pty', resumeStrategy: 'codex' },
      launch: expect.objectContaining({
        command: '/bin/codex',
        args: ['resume', '--last', '--model', 'gpt-5', '-c', 'mcp_servers.mim_workbench.url="http://127.0.0.1:17532/mcp"'],
        env: expect.objectContaining({ MIM_ACTIVITY_ID: 'agent:one' }),
      }),
    }))
    expect(record.session.runId).toBe('run-2')
    expect(useActivitiesStore().byId('agent:one')).toMatchObject({ status: 'idle' })
    expect(useWorkbenchStore().activeActivityId).toBe('agent:one')
  })

  it('reconciles status and exit events from process truth', async () => {
    const runtime = useActivityRuntimeStore()
    await runtime.initialize()
    eventCallback({ type: 'status', activityId: 'agent:one', status: 'needs-input' })
    expect(useActivitiesStore().byId('agent:one').status).toBe('needs-input')

    eventCallback({
      type: 'exit',
      activityId: 'agent:one',
      record: { ...backendRecord, status: 'done', updatedAt: '2026-07-25T11:00:00Z' },
      exit: { reason: 'completed', code: 0 },
    })
    expect(useActivitiesStore().byId('agent:one').status).toBe('done')
  })

  it('stops through the supervisor and waits for authoritative exit', async () => {
    const runtime = useActivityRuntimeStore()
    await runtime.initialize()
    await runtime.stop('agent:one')

    expect(api.stopActivity).toHaveBeenCalledWith('agent:one')
    expect(useActivitiesStore().byId('agent:one').status).toBe('working')
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
