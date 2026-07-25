import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  listenToRoutineEvents,
  loadRoutineCatalog,
  reloadRoutineCatalog,
  runRoutineNow,
} from '../services/routines.js'
import { useRoutinesStore } from './routines.js'

vi.mock('../services/routines.js', () => ({
  listenToRoutineEvents: vi.fn(),
  loadRoutineCatalog: vi.fn(),
  reloadRoutineCatalog: vi.fn(),
  runRoutineNow: vi.fn(),
}))

const baseCatalog = {
  directory: '/home/me/.mim/routines',
  statePath: '/home/me/.mim/routines-state.json',
  revision: 2,
  routines: [
    {
      id: 'morning',
      title: 'Morning review',
      enabled: true,
      schedule: '0 0 9 * * Mon-Fri',
      timezone: 'Europe/Berlin',
      preset: 'codex',
      prompt: 'Review changes.',
      overlap: 'skip',
      missed: 'run-once',
      workspace: null,
      available: true,
      nextFire: '2026-07-27T07:00:00Z',
      diagnostic: null,
      runningActivityIds: [],
      lastError: null,
    },
    {
      id: 'nightly',
      title: 'Nightly',
      enabled: false,
      schedule: '0 0 1 * * *',
      timezone: 'UTC',
      preset: 'claude',
      prompt: 'Inspect.',
      overlap: 'parallel',
      missed: 'skip',
      workspace: '/work',
      available: true,
      nextFire: null,
      diagnostic: null,
      runningActivityIds: [],
      lastError: null,
    },
  ],
  diagnostics: [],
  lastTick: null,
}

describe('routines store', () => {
  let eventHandler

  beforeEach(() => {
    setActivePinia(createPinia())
    eventHandler = null
    vi.mocked(listenToRoutineEvents).mockReset().mockImplementation(async (handler) => {
      eventHandler = handler
      return vi.fn()
    })
    vi.mocked(loadRoutineCatalog).mockReset().mockResolvedValue(structuredClone(baseCatalog))
    vi.mocked(reloadRoutineCatalog).mockReset().mockResolvedValue({
      ...structuredClone(baseCatalog),
      revision: 3,
    })
    vi.mocked(runRoutineNow).mockReset().mockResolvedValue({
      activity: { id: 'agent:manual', title: 'Morning review' },
      scheduledFor: '2026-07-25T08:00:00Z',
    })
  })

  it('subscribes before loading and exposes catalog summaries', async () => {
    const order = []
    vi.mocked(listenToRoutineEvents).mockImplementation(async (handler) => {
      order.push('listen')
      eventHandler = handler
      return vi.fn()
    })
    vi.mocked(loadRoutineCatalog).mockImplementation(async () => {
      order.push('load')
      return structuredClone(baseCatalog)
    })
    const store = useRoutinesStore()

    await store.initialize()

    expect(order).toEqual(['listen', 'load'])
    expect(store.loaded).toBe(true)
    expect(store.selectedRoutine.id).toBe('morning')
    expect(store.enabledCount).toBe(1)
    expect(store.runningCount).toBe(0)
  })

  it('reconciles authoritative scheduler events and preserves selection', async () => {
    const store = useRoutinesStore()
    await store.initialize()
    store.select('nightly')

    eventHandler({
      catalog: {
        ...structuredClone(baseCatalog),
        revision: 5,
        routines: baseCatalog.routines.map((routine) => (
          routine.id === 'nightly'
            ? { ...routine, runningActivityIds: ['agent:scheduled'] }
            : routine
        )),
      },
      tick: {
        fires: [{ routineId: 'nightly', reason: 'scheduled' }],
        skips: [],
        nextFires: {},
      },
    })

    expect(store.revision).toBe(5)
    expect(store.selectedRoutine.id).toBe('nightly')
    expect(store.runningCount).toBe(1)
    expect(store.lastTick.fires[0].routineId).toBe('nightly')
  })

  it('wraps keyboard selection across the catalog', async () => {
    const store = useRoutinesStore()
    await store.initialize()

    store.moveSelection(-1)
    expect(store.selectedId).toBe('nightly')
    store.moveSelection(1)
    expect(store.selectedId).toBe('morning')
    store.selectEdge('end')
    expect(store.selectedId).toBe('nightly')
  })

  it('optimistically marks a manual run while native events catch up', async () => {
    const store = useRoutinesStore()
    await store.initialize()

    const result = await store.runNow('morning')

    expect(runRoutineNow).toHaveBeenCalledWith('morning')
    expect(result.activity.id).toBe('agent:manual')
    expect(store.routines[0].runningActivityIds).toEqual(['agent:manual'])
    expect(store.pendingRuns.morning).toBeUndefined()
  })

  it('keeps a precise local run error attached to its routine', async () => {
    vi.mocked(runRoutineNow).mockRejectedValue(new Error('Agent binary disappeared.'))
    const store = useRoutinesStore()
    await store.initialize()

    await expect(store.runNow('morning')).rejects.toThrow('Agent binary disappeared.')

    expect(store.runErrors.morning).toBe('Agent binary disappeared.')
    expect(store.pendingRuns.morning).toBeUndefined()
  })

  it('refuses an unavailable routine without invoking native runtime', async () => {
    const store = useRoutinesStore()
    await store.initialize()
    store.routines[0] = {
      ...store.routines[0],
      available: false,
      diagnostic: "Preset 'codex' is missing.",
    }

    await expect(store.runNow('morning')).rejects.toThrow("Preset 'codex' is missing.")
    expect(runRoutineNow).not.toHaveBeenCalled()
  })

  it('reloads definitions through the explicit native command', async () => {
    const store = useRoutinesStore()
    await store.initialize()

    await store.reload()

    expect(reloadRoutineCatalog).toHaveBeenCalledTimes(1)
    expect(store.revision).toBe(3)
  })
})
