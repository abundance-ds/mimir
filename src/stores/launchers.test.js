import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../services/launchers.js', () => ({
  detectAgents: vi.fn(),
  loadLauncherConfig: vi.fn(),
  saveLauncherConfig: vi.fn(),
}))

import {
  detectAgents,
  loadLauncherConfig,
  saveLauncherConfig,
} from '../services/launchers.js'
import { useLaunchersStore } from './launchers.js'

describe('launchers store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.resetAllMocks()
    detectAgents.mockResolvedValue([
      { id: 'codex', title: 'Codex', installed: true, binaryPath: '/bin/codex' },
      { id: 'claude', title: 'Claude', installed: false, diagnostic: 'not found' },
    ])
    loadLauncherConfig.mockResolvedValue({
      path: '/home/me/.mim/launchers.json',
      diagnostic: null,
      presets: [
        { id: 'review', title: 'Review', kind: 'agent', agentId: 'codex', args: ['review'] },
        { id: 'claude', title: 'Claude', kind: 'agent', agentId: 'claude', args: [] },
        { id: 'terminal', title: 'Terminal', kind: 'terminal', args: [] },
      ],
    })
  })

  it('loads detection and hackable presets concurrently', async () => {
    const store = useLaunchersStore()
    await store.load()

    expect(store.ready).toBe(true)
    expect(store.configPath).toBe('/home/me/.mim/launchers.json')
    expect(store.availablePresets.map((preset) => preset.id)).toEqual(['review', 'terminal'])
    expect(store.unavailablePresets[0]).toMatchObject({
      id: 'claude',
      unavailableReason: 'not found',
    })
  })

  it('retains diagnostics without hiding working launchers', async () => {
    loadLauncherConfig.mockResolvedValueOnce({
      path: '/config',
      diagnostic: 'Invalid config was quarantined.',
      presets: [{ id: 'terminal', title: 'Terminal', kind: 'terminal' }],
    })
    const store = useLaunchersStore()

    await store.load()

    expect(store.diagnostic).toContain('quarantined')
    expect(store.availablePresets).toHaveLength(1)
  })

  it('reports load errors as a recoverable state', async () => {
    detectAgents.mockRejectedValueOnce(new Error('probe crashed'))
    const store = useLaunchersStore()

    await store.load()

    expect(store.ready).toBe(true)
    expect(store.error).toBe('probe crashed')
    expect(store.presets).toEqual([])
  })

  it('saves exact argv arrays and updates in-memory config', async () => {
    const store = useLaunchersStore()
    await store.load()
    const next = [{
      id: 'review',
      title: 'Review',
      kind: 'agent',
      agentId: 'codex',
      args: ['--model', 'gpt 5'],
    }]

    await store.save(next)

    expect(saveLauncherConfig).toHaveBeenCalledWith(next)
    expect(store.presets[0].args).toEqual(['--model', 'gpt 5'])
  })
})
