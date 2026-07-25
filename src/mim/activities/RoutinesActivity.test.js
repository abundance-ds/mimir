import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
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
} from '../../services/routines.js'
import { stopActivity } from '../../services/activities.js'
import RoutinesActivity from './RoutinesActivity.vue'

vi.mock('../../services/routines.js', () => ({
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
vi.mock('../../services/activities.js', () => ({ stopActivity: vi.fn() }))

function routine(overrides = {}) {
  return {
    id: 'morning',
    title: 'Morning review',
    enabled: true,
    schedule: '0 0 9 * * Mon-Fri',
    timezone: 'Europe/Berlin',
    preset: 'codex-review',
    prompt: 'Review recent changes and leave a short summary.',
    overlap: 'skip',
    missed: 'run-once',
    workspace: null,
    path: `/home/me/.mim/routines/${overrides.id || 'morning'}.toml`,
    sourceRevision: `rev-${overrides.id || 'morning'}`,
    available: true,
    nextFire: new Date(Date.now() + 30 * 60_000).toISOString(),
    diagnostic: null,
    runningActivityIds: [],
    lastError: null,
    ...overrides,
  }
}

function catalog(overrides = {}) {
  return {
    directory: '/home/me/.mim/routines',
    statePath: '/home/me/.mim/routines-state.json',
    revision: 4,
    routines: [
      routine(),
      routine({
        id: 'nightly',
        title: 'Nightly check',
        enabled: false,
        schedule: '0 0 1 * * *',
        timezone: 'UTC',
        preset: 'claude',
        prompt: 'Check the build.',
        nextFire: null,
      }),
    ],
    diagnostics: [],
    lastTick: null,
    ...overrides,
  }
}

describe('RoutinesActivity', () => {
  let pinia

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    vi.mocked(listenToRoutineEvents).mockReset().mockResolvedValue(vi.fn())
    vi.mocked(loadRoutineCatalog).mockReset().mockResolvedValue(catalog())
    vi.mocked(reloadRoutineCatalog).mockReset().mockResolvedValue(catalog({ revision: 5 }))
    vi.mocked(runRoutineNow).mockReset().mockResolvedValue({
      activity: {
        id: 'routine:manual',
        kind: 'routine',
        title: 'Morning review',
        status: 'working',
        workspacePath: '/work',
        retention: 'durable',
        source: { routineId: 'morning', presetId: 'codex-review' },
        host: { type: 'pty' },
        launch: { command: '/bin/codex', args: [], cwd: '/work', env: {} },
      },
      scheduledFor: new Date().toISOString(),
    })
    vi.mocked(createRoutineDefinition).mockReset().mockImplementation(async (definition) => catalog({
      routines: [...catalog().routines, routine({
        ...definition,
        path: `/home/me/.mim/routines/${definition.id}.toml`,
        sourceRevision: `rev-${definition.id}`,
      })],
    }))
    vi.mocked(updateRoutineDefinition).mockReset().mockImplementation(async (id, _revision, definition) => {
      const entries = catalog().routines
      const updated = routine({
        ...definition,
        path: `/home/me/.mim/routines/${id}.toml`,
        sourceRevision: `rev-${id}-updated`,
      })
      return catalog({
        routines: entries.some((entry) => entry.id === id)
          ? entries.map((entry) => entry.id === id ? updated : entry)
          : [...entries, updated],
      })
    })
    vi.mocked(duplicateRoutineDefinition).mockReset().mockImplementation(async (_id, _revision, newId, title) => catalog({
      routines: [...catalog().routines, routine({
        id: newId,
        title,
        enabled: false,
        path: `/home/me/.mim/routines/${newId}.toml`,
        sourceRevision: `rev-${newId}`,
      })],
    }))
    vi.mocked(trashRoutineDefinition).mockReset().mockImplementation(async (id) => catalog({
      routines: catalog().routines.filter((entry) => entry.id !== id),
    }))
    vi.mocked(revealRoutineDefinition).mockReset().mockResolvedValue()
    vi.mocked(stopActivity).mockReset().mockResolvedValue()
  })

  function render(props = {}) {
    return mount(RoutinesActivity, {
      global: { plugins: [pinia] },
      props: {
        activity: { id: 'routines', kind: 'routine', workspacePath: '/work' },
        active: true,
        ...props,
      },
    })
  }

  it('renders dense schedule rows, catalog location, and selected detail', async () => {
    const wrapper = render()
    await flushPromises()

    expect(wrapper.text()).toContain('/home/me/.mim/routines')
    expect(wrapper.findAll('[data-routine-row]')).toHaveLength(2)
    expect(wrapper.get('[data-routine-row="morning"]').text()).toContain('Europe/Berlin')
    expect(wrapper.get('[data-routine-row="morning"]').text()).toContain('codex-review')
    expect(wrapper.get('[data-routine-detail="morning"]').text()).toContain('Review recent changes')
    expect(wrapper.get('[data-routine-detail="morning"]').text()).toContain('Run Once')
    expect(wrapper.get('[data-routines-summary]').text()).toContain('1 armed')
  })

  it('shows paused, running, unavailable, and failed runtime states', async () => {
    vi.mocked(loadRoutineCatalog).mockResolvedValue(catalog({
      routines: [
        routine({ id: 'paused', title: 'Paused', enabled: false, nextFire: null }),
        routine({ id: 'running', title: 'Running', runningActivityIds: ['agent:1'] }),
        routine({
          id: 'missing',
          title: 'Missing',
          available: false,
          diagnostic: "Preset 'pi' was not found.",
        }),
        routine({ id: 'failed', title: 'Failed', lastError: 'Exit status 2.' }),
      ],
    }))
    const wrapper = render()
    await flushPromises()

    expect(wrapper.get('[data-routine-row="paused"]').text()).toContain('Paused')
    expect(wrapper.get('[data-routine-row="running"]').text()).toContain('Running')
    expect(wrapper.get('[data-routine-row="missing"]').text()).toContain('Unavailable')
    expect(wrapper.get('[data-routine-run="missing"]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-routine-select="failed"]').trigger('click')
    expect(wrapper.get('[data-routine-problem="failed"]').text()).toContain('Exit status 2.')
  })

  it('supports arrows, Home, End, and Return to run the selected routine', async () => {
    const wrapper = render()
    await flushPromises()
    const list = wrapper.get('[data-routine-list]')

    await list.trigger('keydown', { key: 'ArrowDown' })
    expect(wrapper.get('[data-routine-row="nightly"]').attributes('aria-selected')).toBe('true')
    await list.trigger('keydown', { key: 'Home' })
    expect(wrapper.get('[data-routine-row="morning"]').attributes('aria-selected')).toBe('true')
    await list.trigger('keydown', { key: 'End' })
    expect(wrapper.get('[data-routine-row="nightly"]').attributes('aria-selected')).toBe('true')
    await list.trigger('keydown', { key: 'Home' })
    await list.trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(runRoutineNow).toHaveBeenCalledWith('morning')
    expect(wrapper.emitted('openActivity')[0][0]).toMatchObject({
      id: 'routine:manual',
      kind: 'routine',
      host: { type: 'pty' },
    })
    expect(wrapper.get('[data-routine-notice]').text()).toContain('Morning review started')
    expect(wrapper.get('[data-routine-running="morning"]').text()).toContain('Activity tray')
  })

  it('runs directly from the row and reports launch failures in place and upward', async () => {
    vi.mocked(runRoutineNow).mockRejectedValue(new Error('codex exited before startup'))
    const wrapper = render()
    await flushPromises()

    await wrapper.get('[data-routine-run="morning"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-routine-problem="morning"]').text()).toContain('codex exited before startup')
    expect(wrapper.emitted('diagnostic')[0][0]).toContain('Morning review did not start')
  })

  it('reloads TOML definitions and displays native parse diagnostics', async () => {
    vi.mocked(reloadRoutineCatalog).mockResolvedValue(catalog({
      revision: 6,
      diagnostics: [{
        path: '/home/me/.mim/routines/broken.toml',
        field: 'schedule',
        message: 'Invalid cron expression.',
      }],
    }))
    const wrapper = render()
    await flushPromises()

    await wrapper.get('[data-routines-reload]').trigger('click')
    await flushPromises()

    expect(reloadRoutineCatalog).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-routine-diagnostics]').text()).toContain('broken.toml')
    expect(wrapper.get('[data-routine-diagnostics]').text()).toContain('Invalid cron expression.')
    expect(wrapper.get('[data-routine-notice]').text()).toBe('Definitions reloaded')
  })

  it('uses native events continuously and performs one explicit refresh when reopened', async () => {
    const wrapper = render({ active: false })
    await flushPromises()
    expect(reloadRoutineCatalog).not.toHaveBeenCalled()

    await wrapper.setProps({ active: true })
    await flushPromises()

    expect(reloadRoutineCatalog).toHaveBeenCalledTimes(1)
  })

  it('teaches the exact disk-first model when the catalog is empty', async () => {
    vi.mocked(loadRoutineCatalog).mockResolvedValue(catalog({ routines: [] }))
    const wrapper = render()
    await flushPromises()

    expect(wrapper.get('[data-routines-empty]').text()).toContain('.toml')
    expect(wrapper.get('[data-routines-empty]').text()).toContain('/home/me/.mim/routines')
    expect(wrapper.get('[data-routines-empty]').text()).toContain('normal agent Activity')
    expect(wrapper.get('[data-routines-empty-create]').text()).toContain('Create routine')
  })

  it('creates and edits complete canonical definitions without hiding the TOML escape hatch', async () => {
    const wrapper = render()
    await flushPromises()

    await wrapper.get('[data-routines-new]').trigger('click')
    await wrapper.get('[data-routine-title-input]').setValue('Friday synthesis')
    expect(wrapper.get('[data-routine-id-input]').element.value).toBe('friday-synthesis')
    await wrapper.get('[data-routine-prompt-input]').setValue('Synthesize the week.')
    await wrapper.get('[data-routine-form]').trigger('submit')
    await flushPromises()

    expect(createRoutineDefinition).toHaveBeenCalledWith(expect.objectContaining({
      id: 'friday-synthesis',
      title: 'Friday synthesis',
      prompt: 'Synthesize the week.',
      timezone: expect.any(String),
      overlap: 'skip',
      missed: 'run-once',
    }))
    expect(wrapper.get('[data-routine-row="friday-synthesis"]').text()).toContain('Armed')

    await wrapper.get('[data-routine-edit="friday-synthesis"]').trigger('click')
    await wrapper.get('[data-routine-title-input]').setValue('Friday review')
    await wrapper.get('[data-routine-form]').trigger('submit')
    await flushPromises()
    expect(updateRoutineDefinition).toHaveBeenCalledWith(
      'friday-synthesis',
      'rev-friday-synthesis',
      expect.objectContaining({ title: 'Friday review' }),
    )

    await wrapper.get('[data-routine-open-source="friday-synthesis"]').trigger('click')
    expect(wrapper.emitted('openFile').at(-1)).toEqual([
      '/home/me/.mim/routines/friday-synthesis.toml',
    ])
  })

  it('keeps a hand-picked stable id while the create title is refined', async () => {
    const wrapper = render()
    await flushPromises()

    await wrapper.get('[data-routines-new]').trigger('click')
    await wrapper.get('[data-routine-id-input]').setValue('weekly-focus')
    await wrapper.get('[data-routine-title-input]').setValue('Weekly focus review')

    expect(wrapper.get('[data-routine-id-input]').element.value).toBe('weekly-focus')
  })

  it('offers row and surface context menus, paused duplication, and recoverable Trash confirmation', async () => {
    const wrapper = render()
    await flushPromises()

    await wrapper.get('[data-routine-row="morning"]').trigger('contextmenu', { clientX: 30, clientY: 40 })
    const menu = wrapper.get('[data-routines-context-menu]')
    expect(menu.text()).toContain('Open TOML')
    expect(menu.text()).toContain('Duplicate')
    expect(menu.text()).toContain('Move to Trash')

    await menu.get('[data-routine-action="duplicate"]').trigger('click')
    await wrapper.get('[data-routine-form]').trigger('submit')
    await flushPromises()
    expect(duplicateRoutineDefinition).toHaveBeenCalledWith(
      'morning',
      'rev-morning',
      'morning-copy',
      'Morning review copy',
    )
    expect(wrapper.get('[data-routine-row="morning-copy"]').text()).toContain('Paused')

    await wrapper.get('[data-routine-row="morning-copy"]').trigger('contextmenu', { clientX: 30, clientY: 40 })
    await wrapper.get('[data-routine-action="trash"]').trigger('click')
    expect(wrapper.get('[data-routine-trash-dialog]').text()).toContain('system Trash')
    await wrapper.get('[data-routine-confirm-trash]').trigger('click')
    await flushPromises()
    expect(trashRoutineDefinition).toHaveBeenCalledWith('morning-copy', 'rev-morning-copy')
    expect(wrapper.find('[data-routine-row="morning-copy"]').exists()).toBe(false)

    await wrapper.get('[data-routine-list]').trigger('contextmenu', { clientX: 12, clientY: 12 })
    expect(wrapper.get('[data-routines-context-menu]').text()).toContain('New routine')
    expect(wrapper.get('[data-routines-context-menu]').text()).toContain('Reveal definitions folder')
  })

  it('stops all focused routine runs and supports keyboard-first edit, open, menu, and Trash', async () => {
    vi.mocked(loadRoutineCatalog).mockResolvedValue(catalog({
      routines: [routine({ runningActivityIds: ['agent:one', 'agent:two'] })],
    }))
    const wrapper = render()
    await flushPromises()
    const list = wrapper.get('[data-routine-list]')

    await wrapper.get('[data-routine-stop="morning"]').trigger('click')
    await flushPromises()
    expect(stopActivity).toHaveBeenCalledWith('agent:one')
    expect(stopActivity).toHaveBeenCalledWith('agent:two')

    await list.trigger('keydown', { key: 'F2' })
    expect(wrapper.get('[data-routine-form]').exists()).toBe(true)
    await wrapper.get('[data-routine-form]').trigger('keydown', { key: 'Escape' })
    await list.trigger('keydown', { key: 'o', metaKey: true })
    expect(wrapper.emitted('openFile').at(-1)).toEqual(['/home/me/.mim/routines/morning.toml'])
    await list.trigger('keydown', { key: 'F10', shiftKey: true })
    expect(wrapper.get('[data-routines-context-menu]').exists()).toBe(true)
  })

  it('distinguishes a hard runtime failure from a loaded-catalog refresh failure', async () => {
    vi.mocked(loadRoutineCatalog).mockRejectedValue(new Error('runtime state unreadable'))
    const wrapper = render()
    await flushPromises()

    expect(wrapper.get('[data-routines-error]').text()).toContain('runtime state unreadable')

    const nextPinia = createPinia()
    setActivePinia(nextPinia)
    vi.mocked(loadRoutineCatalog).mockResolvedValue(catalog())
    vi.mocked(reloadRoutineCatalog).mockRejectedValue(new Error('reload failed'))
    const loaded = mount(RoutinesActivity, {
      global: { plugins: [nextPinia] },
      props: { activity: { id: 'routines' }, active: true },
    })
    await flushPromises()
    await loaded.get('[data-routines-reload]').trigger('click')
    await flushPromises()

    expect(loaded.get('[data-routines-inline-error]').text()).toContain('reload failed')
    expect(loaded.find('[data-routine-list]').exists()).toBe(true)
  })
})
