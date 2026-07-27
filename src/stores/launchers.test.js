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
import { loadIpcFixture } from '../test/ipcFixtures.js'
import { useLaunchersStore } from './launchers.js'

// Golden Rust payloads: codex installed, claude missing with a diagnostic;
// presets review (codex), claude, terminal.
const detectedAgents = loadIpcFixture('launcher_detect_agents')
const launcherConfig = loadIpcFixture('launcher_load_config')

describe('launchers store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.resetAllMocks()
    detectAgents.mockResolvedValue(detectedAgents)
    loadLauncherConfig.mockResolvedValue(launcherConfig)
  })

  it('loads detection and hackable presets concurrently', async () => {
    const store = useLaunchersStore()
    await store.load()

    expect(store.ready).toBe(true)
    expect(store.configPath).toBe(launcherConfig.path)
    expect(store.availablePresets.map((preset) => preset.id)).toEqual(['review', 'terminal'])
    expect(store.unavailablePresets[0]).toMatchObject({
      id: 'claude',
      unavailableReason: detectedAgents[1].diagnostic,
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

  it('keeps an exact binary override launchable without built-in detection', async () => {
    loadLauncherConfig.mockResolvedValueOnce({
      path: '/config',
      diagnostic: null,
      presets: [{
        id: 'local-reviewer',
        title: 'Local reviewer',
        kind: 'agent',
        agentId: 'custom',
        binary: '/opt/mim/bin/reviewer',
        args: ['--fast'],
      }],
    })
    const store = useLaunchersStore()

    await store.load()

    expect(store.availablePresets).toHaveLength(1)
    expect(store.availablePresets[0]).toMatchObject({
      id: 'local-reviewer',
      binary: '/opt/mim/bin/reviewer',
      available: true,
      unavailableReason: '',
    })
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
