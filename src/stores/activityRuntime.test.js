import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

let eventCallback = null
vi.mock('../services/activities.js', () => ({
  clearActivity: vi.fn(),
  listActivities: vi.fn(),
  renameActivity: vi.fn(),
  resolveLauncher: vi.fn(),
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
    }, '/w')

    expect(api.spawnActivity).toHaveBeenCalledWith(expect.objectContaining({
      id: 'agent:new-id',
      retention: 'durable',
      launch: expect.objectContaining({
        command: '/bin/codex',
        args: ['review'],
        cwd: '/w',
      }),
    }))
    expect(record.status).toBe('idle')
    expect(useWorkbenchStore().activeActivityId).toBe('agent:new-id')
  })

  it.each([
    ['codex', ['-c', 'mcp_servers.mim.url="http://127.0.0.1:17532/mcp"'], ['resume', '--last', '-c', 'mcp_servers.mim.url="http://127.0.0.1:17532/mcp"']],
    ['claude', ['--mcp-config', '{}'], ['--continue', '--mcp-config', '{}']],
    ['pi', ['--extension', '/tmp/mim-tools.ts'], ['--continue', '--extension', '/tmp/mim-tools.ts']],
    ['none', ['--flag'], ['--flag']],
  ])('builds exact %s resume argv', (strategy, args, expected) => {
    expect(resumeArguments(args, strategy)).toEqual(expected)
  })

  it('launches a resumable agent session without losing configured flags', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValueOnce('resume-id')
    api.resolveLauncher.mockResolvedValueOnce({
      presetId: 'codex',
      title: 'Codex',
      kind: 'agent',
      agentId: 'codex',
      resumeStrategy: 'codex',
      command: '/bin/codex',
      args: ['--model', 'gpt-5', '-c', 'mcp_servers.mim.url="http://127.0.0.1:17532/mcp"'],
      cwd: '/w',
      env: {},
    })
    const runtime = useActivityRuntimeStore()
    await runtime.launchPreset({ id: 'codex' }, '/w', {
      resume: true,
      resumeStrategy: 'codex',
    })

    expect(api.spawnActivity).toHaveBeenCalledWith(expect.objectContaining({
      id: 'agent:resume-id',
      launch: expect.objectContaining({
        args: ['resume', '--last', '--model', 'gpt-5', '-c', 'mcp_servers.mim.url="http://127.0.0.1:17532/mcp"'],
      }),
    }))
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
})
