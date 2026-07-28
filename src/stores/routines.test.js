import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  createRoutineDefinition,
  duplicateRoutineDefinition,
  listenToRoutineEvents,
  loadRoutineCatalog,
  revealRoutineDefinition,
  reloadRoutineCatalog,
  runRoutineNow,
  trashRoutineDefinition,
  updateRoutineDefinition,
} from '../services/routines.js'
import { stopActivity } from '../services/activities.js'
import { useRoutinesStore } from './routines.js'

vi.mock('../services/routines.js', () => ({
  createRoutineDefinition: vi.fn(),
  duplicateRoutineDefinition: vi.fn(),
  listenToRoutineEvents: vi.fn(),
  loadRoutineCatalog: vi.fn(),
  revealRoutineDefinition: vi.fn(),
  reloadRoutineCatalog: vi.fn(),
  runRoutineNow: vi.fn(),
  trashRoutineDefinition: vi.fn(),
  updateRoutineDefinition: vi.fn(),
}))
vi.mock('../services/activities.js', () => ({ stopActivity: vi.fn() }))

const baseCatalog = {
  directory: '/home/me/.mimir/routines',
  statePath: '/home/me/.mimir/routines-state.json',
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
      path: '/home/me/.mimir/routines/morning.toml',
      sourceRevision: 'rev-morning',
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
      path: '/home/me/.mimir/routines/nightly.toml',
      sourceRevision: 'rev-nightly',
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
    vi.mocked(createRoutineDefinition).mockReset().mockResolvedValue(structuredClone(baseCatalog))
    vi.mocked(updateRoutineDefinition).mockReset().mockResolvedValue(structuredClone(baseCatalog))
    vi.mocked(duplicateRoutineDefinition).mockReset().mockResolvedValue(structuredClone(baseCatalog))
    vi.mocked(trashRoutineDefinition).mockReset().mockResolvedValue(structuredClone(baseCatalog))
    vi.mocked(revealRoutineDefinition).mockReset().mockResolvedValue()
    vi.mocked(stopActivity).mockReset().mockResolvedValue()
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
    expect(store.manualCount).toBe(0)
    expect(store.runningCount).toBe(0)
  })

  it('counts manual routines separately from armed schedules', async () => {
    const catalog = structuredClone(baseCatalog)
    catalog.routines.push({
      ...catalog.routines[0],
      id: 'sweep',
      title: 'Manual sweep',
      schedule: null,
      nextFire: null,
    })
    vi.mocked(loadRoutineCatalog).mockResolvedValue(catalog)
    const store = useRoutinesStore()

    await store.initialize()

    expect(store.enabledCount).toBe(1)
    expect(store.manualCount).toBe(1)
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

  it('routes source-aware create, update, duplicate, trash, reveal, and run cancellation', async () => {
    const store = useRoutinesStore()
    await store.initialize()
    vi.mocked(createRoutineDefinition).mockResolvedValue({
      ...structuredClone(baseCatalog),
      routines: [...structuredClone(baseCatalog.routines), {
        ...structuredClone(baseCatalog.routines[0]),
        id: 'created',
        title: 'Created',
        sourceRevision: 'rev-created',
      }],
    })
    await store.create({ ...baseCatalog.routines[0], id: 'created', title: 'Created' })
    expect(createRoutineDefinition).toHaveBeenCalledWith(expect.objectContaining({ id: 'created' }))
    expect(store.selectedId).toBe('created')

    store.select('morning')
    await store.update('morning', { ...baseCatalog.routines[0], title: 'Sharper' })
    expect(updateRoutineDefinition).toHaveBeenCalledWith(
      'morning',
      'rev-morning',
      expect.objectContaining({ title: 'Sharper' }),
    )
    await store.duplicate('morning', 'morning-copy', 'Morning copy')
    expect(duplicateRoutineDefinition).toHaveBeenCalledWith(
      'morning',
      'rev-morning',
      'morning-copy',
      'Morning copy',
    )
    await store.trash('morning')
    expect(trashRoutineDefinition).toHaveBeenCalledWith('morning', 'rev-morning')
    await store.reveal('nightly')
    await store.reveal()
    expect(revealRoutineDefinition).toHaveBeenNthCalledWith(1, 'nightly')
    expect(revealRoutineDefinition).toHaveBeenNthCalledWith(2, null)

    store.applyCatalog({
      ...structuredClone(baseCatalog),
      routines: [{ ...baseCatalog.routines[0], runningActivityIds: ['agent:one', 'agent:two'] }],
    })
    await expect(store.stopRuns('morning')).resolves.toBe(2)
    expect(stopActivity).toHaveBeenCalledWith('agent:one')
    expect(stopActivity).toHaveBeenCalledWith('agent:two')
    expect(store.routines[0].runningActivityIds).toEqual([])
  })
})
