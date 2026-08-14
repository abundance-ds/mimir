import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))

async function freshModule() {
  vi.resetModules()
  return import('./activities.js')
}

describe('activity spawn sizing', () => {
  beforeEach(() => {
    invoke.mockReset()
    invoke.mockResolvedValue({})
  })

  it('spawns at a conservative size before any pane has fitted', async () => {
    const api = await freshModule()

    await api.spawnActivity({ id: 'terminal:one' })

    // Undershooting the real pane is invisible; overshooting leaves the
    // shell's padded partial-line mark as a stray wrapped line.
    expect(invoke).toHaveBeenCalledWith('activity_spawn', {
      record: { id: 'terminal:one' },
      cols: 64,
      rows: 20,
      cliSessionId: null,
    })
  })

  it('spawns and respawns at the last pane-fitted size', async () => {
    const api = await freshModule()

    await api.resizeActivity('terminal:one', 87, 38)
    await api.spawnActivity({ id: 'terminal:two' })
    await api.respawnActivity({ id: 'terminal:one' })

    expect(invoke).toHaveBeenCalledWith('activity_spawn', {
      record: { id: 'terminal:two' },
      cols: 87,
      rows: 38,
      cliSessionId: null,
    })
    expect(invoke).toHaveBeenCalledWith('activity_respawn', {
      record: { id: 'terminal:one' },
      cols: 87,
      rows: 38,
      cliSessionId: null,
    })
  })

  it('prefers an explicit caller size and ignores degenerate resizes', async () => {
    const api = await freshModule()

    await api.resizeActivity('terminal:one', 90, 40)
    await api.resizeActivity('terminal:one', 0, 40)
    await api.spawnActivity({ id: 'terminal:two' }, { cols: 120, rows: 50 })
    await api.spawnActivity({ id: 'terminal:three' })

    expect(invoke).toHaveBeenCalledWith('activity_spawn', {
      record: { id: 'terminal:two' },
      cols: 120,
      rows: 50,
      cliSessionId: null,
    })
    expect(invoke).toHaveBeenCalledWith('activity_spawn', {
      record: { id: 'terminal:three' },
      cols: 90,
      rows: 40,
      cliSessionId: null,
    })
  })

  it('searches closed Activity transcripts with a bounded native command', async () => {
    const api = await freshModule()

    await api.searchActivityHistory('sidebar ordering', 12)

    expect(invoke).toHaveBeenCalledWith('activity_search_history', {
      query: 'sidebar ordering',
      limit: 12,
    })
  })

  it('passes terminal lease and checkpoint revisions without reshaping them', async () => {
    const api = await freshModule()
    const checkpoint = {
      activityId: 'agent:one',
      runId: 'run-1',
      ownerId: 'webview-1',
      leaseGeneration: 2,
      baseRevision: 3,
      throughSequence: 40,
      cols: 100,
      rows: 30,
      formatVersion: 1,
      engineVersion: '6.0.0',
      unicodeVersion: '11',
      data: 'state',
      searchText: 'visible',
    }

    await api.attachTerminalActivity('agent:one', 'webview-1')
    await api.checkpointTerminalActivity(checkpoint)
    await api.releaseTerminalActivity('agent:one', 'webview-1', 2)

    expect(invoke).toHaveBeenNthCalledWith(1, 'activity_terminal_attach', {
      activityId: 'agent:one',
      ownerId: 'webview-1',
    })
    expect(invoke).toHaveBeenNthCalledWith(2, 'activity_terminal_checkpoint', checkpoint)
    expect(invoke).toHaveBeenNthCalledWith(3, 'activity_terminal_release', {
      activityId: 'agent:one',
      ownerId: 'webview-1',
      leaseGeneration: 2,
    })
  })
})
