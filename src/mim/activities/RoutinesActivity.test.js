import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import {
  listenToRoutineEvents,
  loadRoutineCatalog,
  reloadRoutineCatalog,
  runRoutineNow,
} from '../../services/routines.js'
import RoutinesActivity from './RoutinesActivity.vue'

vi.mock('../../services/routines.js', () => ({
  listenToRoutineEvents: vi.fn(),
  loadRoutineCatalog: vi.fn(),
  reloadRoutineCatalog: vi.fn(),
  runRoutineNow: vi.fn(),
}))

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
      activity: { id: 'agent:manual', title: 'Morning review' },
      scheduledFor: new Date().toISOString(),
    })
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

  it('teaches the exact disk-first model when the catalog is empty', async () => {
    vi.mocked(loadRoutineCatalog).mockResolvedValue(catalog({ routines: [] }))
    const wrapper = render()
    await flushPromises()

    expect(wrapper.get('[data-routines-empty]').text()).toContain('.toml')
    expect(wrapper.get('[data-routines-empty]').text()).toContain('/home/me/.mim/routines')
    expect(wrapper.get('[data-routines-empty]').text()).toContain('normal agent Activity')
    expect(wrapper.get('[data-routines-empty] code').text()).toContain('timezone = "Europe/Berlin"')
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
