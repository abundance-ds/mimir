import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import {
  createRoutineDefinition,
  duplicateRoutineDefinition,
  listenToRoutineEvents,
  loadRoutineCatalog,
  normalizeRoutineCatalog,
  revealRoutineDefinition,
  reloadRoutineCatalog,
  ROUTINES_CHANGED_EVENT,
  runRoutineNow,
  trashRoutineDefinition,
  updateRoutineDefinition,
} from './routines.js'

describe('routines service', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset()
    vi.mocked(listen).mockReset()
  })

  it('normalizes, sorts, and preserves the complete runtime state', async () => {
    vi.mocked(invoke).mockResolvedValue({
      directory: '/home/me/.mimir/routines',
      statePath: '/home/me/.mimir/routines-state.json',
      revision: 7,
      routines: [
        {
          id: 'z-nightly',
          title: 'Nightly',
          enabled: false,
          schedule: '0 0 1 * * *',
          timezone: 'UTC',
          preset: 'claude',
          prompt: 'Check.',
          overlap: 'parallel',
          missed: 'skip',
          available: false,
          diagnostic: 'Preset missing.',
          runningActivityIds: ['agent:one'],
          lastError: 'Previous run failed.',
        },
        {
          id: 'a-morning',
          title: 'Morning',
          enabled: true,
          schedule: '0 0 9 * * Mon-Fri',
          timezone: 'Europe/Berlin',
          preset: 'codex',
          prompt: 'Review.',
          path: '/home/me/.mimir/routines/a-morning.toml',
          sourceRevision: 'rev-morning',
          available: true,
          nextFire: '2026-07-27T07:00:00Z',
        },
      ],
      diagnostics: [{ path: '/bad.toml', field: 'schedule', message: 'Invalid cron.' }],
      lastTick: {
        fires: [{
          routineId: 'a-morning',
          scheduledFor: '2026-07-25T07:00:00Z',
          observedAt: '2026-07-25T07:00:01Z',
          reason: 'scheduled',
        }],
        skips: [],
        nextFires: { 'a-morning': '2026-07-27T07:00:00Z' },
      },
    })

    const catalog = await loadRoutineCatalog()

    expect(invoke).toHaveBeenCalledWith('routine_catalog')
    expect(catalog.routines.map((routine) => routine.id)).toEqual(['a-morning', 'z-nightly'])
    expect(catalog.routines[1]).toMatchObject({
      available: false,
      runningActivityIds: ['agent:one'],
      lastError: 'Previous run failed.',
      overlap: 'parallel',
      missed: 'skip',
    })
    expect(catalog.routines[0]).toMatchObject({
      path: '/home/me/.mimir/routines/a-morning.toml',
      sourceRevision: 'rev-morning',
    })
    expect(catalog.lastTick.fires[0].routineId).toBe('a-morning')
    expect(catalog.diagnostics[0].field).toBe('schedule')
  })

  it('supports snake-case DTOs defensively without weakening the Rust contract', () => {
    const catalog = normalizeRoutineCatalog({
      state_path: '/tmp/state.json',
      routines: [{
        id: 'one',
        running_activity_ids: ['agent:1'],
        next_fire: '2026-08-01T00:00:00Z',
        last_error: 'bad',
      }],
      last_tick: { next_fires: { one: '2026-08-01T00:00:00Z' } },
    })

    expect(catalog.statePath).toBe('/tmp/state.json')
    expect(catalog.routines[0]).toMatchObject({
      runningActivityIds: ['agent:1'],
      nextFire: '2026-08-01T00:00:00Z',
      lastError: 'bad',
    })
    expect(catalog.lastTick.nextFires.one).toBe('2026-08-01T00:00:00Z')
  })

  it('calls reload and run-now with the exact native arguments', async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce({ routines: [] })
      .mockResolvedValueOnce({
        activity: { id: 'agent:run', kind: 'agent' },
        scheduledFor: '2026-07-25T08:00:00Z',
      })

    await reloadRoutineCatalog()
    const result = await runRoutineNow('morning')

    expect(invoke).toHaveBeenNthCalledWith(1, 'routine_reload')
    expect(invoke).toHaveBeenNthCalledWith(2, 'routine_run_now', { routineId: 'morning' })
    expect(result).toEqual({
      activity: { id: 'agent:run', kind: 'agent' },
      scheduledFor: '2026-07-25T08:00:00Z',
    })
  })

  it('routes complete source-aware CRUD and reveal commands', async () => {
    const definition = {
      id: 'review',
      title: 'Review',
      enabled: true,
      schedule: '0 9 * * 1-5',
      timezone: 'Europe/Berlin',
      preset: 'codex',
      prompt: 'Review.',
      overlap: 'skip',
      missed: 'run-once',
      workspace: '',
      available: false,
      sourceRevision: 'ignored',
    }
    vi.mocked(invoke).mockResolvedValue({ routines: [] })

    await createRoutineDefinition(definition)
    await updateRoutineDefinition('review', 'rev-1', { ...definition, title: 'Sharper' })
    await duplicateRoutineDefinition('review', 'rev-2', 'review-copy', 'Review copy')
    await trashRoutineDefinition('review-copy', 'rev-3')
    await revealRoutineDefinition('review')
    await revealRoutineDefinition()

    const serialized = {
      id: 'review',
      title: 'Review',
      enabled: true,
      schedule: '0 9 * * 1-5',
      timezone: 'Europe/Berlin',
      preset: 'codex',
      prompt: 'Review.',
      overlap: 'skip',
      missed: 'run-once',
      workspace: null,
    }
    expect(invoke).toHaveBeenNthCalledWith(1, 'routine_create', { definition: serialized })
    expect(invoke).toHaveBeenNthCalledWith(2, 'routine_update', {
      routineId: 'review',
      expectedRevision: 'rev-1',
      definition: { ...serialized, title: 'Sharper' },
    })
    expect(invoke).toHaveBeenNthCalledWith(3, 'routine_duplicate', {
      routineId: 'review',
      expectedRevision: 'rev-2',
      newId: 'review-copy',
      title: 'Review copy',
    })
    expect(invoke).toHaveBeenNthCalledWith(4, 'routine_trash', {
      routineId: 'review-copy',
      expectedRevision: 'rev-3',
    })
    expect(invoke).toHaveBeenNthCalledWith(5, 'routine_reveal', { routineId: 'review' })
    expect(invoke).toHaveBeenNthCalledWith(6, 'routine_reveal', { routineId: null })
  })

  it('normalizes native change events before delivery', async () => {
    let handler
    const unlisten = vi.fn()
    vi.mocked(listen).mockImplementation(async (_event, callback) => {
      handler = callback
      return unlisten
    })
    const onEvent = vi.fn()

    const dispose = await listenToRoutineEvents(onEvent)
    handler({
      payload: {
        catalog: {
          directory: '/routines',
          routines: [{ id: 'review', title: 'Review', runningActivityIds: [] }],
        },
        tick: { fires: [], skips: [{ routineId: 'review', reason: 'active' }] },
      },
    })

    expect(listen).toHaveBeenCalledWith(ROUTINES_CHANGED_EVENT, expect.any(Function))
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      catalog: expect.objectContaining({ directory: '/routines' }),
      tick: expect.objectContaining({
        skips: [expect.objectContaining({ routineId: 'review', reason: 'active' })],
      }),
    }))
    expect(dispose).toBe(unlisten)
  })

  it('rejects an empty manual-run id before crossing IPC', async () => {
    await expect(runRoutineNow('  ')).rejects.toThrow('Choose a routine')
    expect(invoke).not.toHaveBeenCalled()
  })
})
