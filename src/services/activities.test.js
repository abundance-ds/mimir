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
    })
    expect(invoke).toHaveBeenCalledWith('activity_respawn', {
      record: { id: 'terminal:one' },
      cols: 87,
      rows: 38,
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
    })
    expect(invoke).toHaveBeenCalledWith('activity_spawn', {
      record: { id: 'terminal:three' },
      cols: 90,
      rows: 40,
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
})
