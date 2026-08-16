import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { invoke } from '@tauri-apps/api/core'
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
import { detectAgents, loadLauncherConfig } from '../../services/launchers.js'
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
vi.mock('../../services/launchers.js', () => ({
  detectAgents: vi.fn(),
  loadLauncherConfig: vi.fn(),
  saveLauncherConfig: vi.fn(),
}))

function routine(overrides = {}) {
  return {
    id: 'morning',
    title: 'Morning review',
    enabled: true,
    schedule: '30 9 * * 1-5',
    timezone: 'Europe/Berlin',
    preset: 'codex-review',
    prompt: 'Review recent changes and leave a short summary.',
    overlap: 'skip',
    missed: 'run-once',
    workspace: null,
    path: `/home/me/.mimir/routines/${overrides.id || 'morning'}.toml`,
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
    directory: '/home/me/.mimir/routines',
    statePath: '/home/me/.mimir/routines-state.json',
    revision: 4,
    routines: [
      routine(),
      routine({
        id: 'nightly',
        title: 'Nightly check',
        enabled: false,
        schedule: '0 1 * * *',
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
        path: `/home/me/.mimir/routines/${definition.id}.toml`,
        sourceRevision: `rev-${definition.id}`,
      })],
    }))
    vi.mocked(updateRoutineDefinition).mockReset().mockImplementation(async (id, _revision, definition) => {
      const entries = catalog().routines
      const updated = routine({
        ...definition,
        path: `/home/me/.mimir/routines/${id}.toml`,
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
        path: `/home/me/.mimir/routines/${newId}.toml`,
        sourceRevision: `rev-${newId}`,
      })],
    }))
    vi.mocked(trashRoutineDefinition).mockReset().mockImplementation(async (id) => catalog({
      routines: catalog().routines.filter((entry) => entry.id !== id),
    }))
    vi.mocked(revealRoutineDefinition).mockReset().mockResolvedValue()
    vi.mocked(stopActivity).mockReset().mockResolvedValue()
    vi.mocked(detectAgents).mockReset().mockResolvedValue([
      { id: 'codex', installed: true, binaryPath: '/bin/codex' },
      { id: 'claude', installed: true, binaryPath: '/bin/claude' },
      { id: 'pi', installed: false, diagnostic: 'pi is not installed.' },
    ])
    vi.mocked(loadLauncherConfig).mockReset().mockResolvedValue({
      path: '/home/me/.mimir/launchers.json',
      presets: [
        { id: 'codex-review', title: 'Codex review', kind: 'agent', agentId: 'codex', enabled: true, cwd: { mode: 'workspace' } },
        { id: 'claude', title: 'Claude', kind: 'agent', agentId: 'claude', enabled: true, cwd: { mode: 'home' } },
        { id: 'pi', title: 'Pi', kind: 'agent', agentId: 'pi', enabled: true, cwd: { mode: 'workspace' } },
        { id: 'terminal', title: 'Terminal', kind: 'terminal', enabled: true, cwd: { mode: 'workspace' } },
      ],
    })
    vi.mocked(invoke).mockReset().mockImplementation((command) => {
      if (command === 'agent_list') {
        return Promise.resolve([
          {
            name: 'evidence-sweep',
            title: 'Evidence sweep',
            description: 'Review the current evidence base.',
            scope: 'project',
            path: '/work/agents/evidence-sweep',
            active: true,
          },
        ])
      }
      return Promise.resolve()
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

  it('renders human schedule rows, catalog location, and selected detail', async () => {
    const wrapper = render()
    await flushPromises()

    expect(wrapper.text()).toContain('/home/me/.mimir/routines')
    expect(wrapper.findAll('[data-routine-row]')).toHaveLength(2)
    expect(wrapper.get('[data-routine-row="morning"]').text()).toContain('Weekdays 09:30')
    expect(wrapper.get('[data-routine-row="morning"]').text()).toContain('codex-review')
    expect(wrapper.get('[data-routine-row="nightly"]').text()).toContain('Every day 01:00')
    expect(wrapper.get('[data-routine-detail="morning"]').text()).toContain('Review recent changes')
    expect(wrapper.get('[data-routine-detail="morning"]').text()).toContain('30 9 * * 1-5')
    expect(wrapper.get('[data-routine-detail="morning"]').text()).toContain('Run Once')
    expect(wrapper.get('[data-routines-summary]').text()).toContain('1 armed')
  })

  it('shows manual, paused, running, unavailable, and failed runtime states', async () => {
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
        routine({ id: 'sweep', title: 'Sweep', schedule: null, nextFire: null }),
      ],
    }))
    const wrapper = render()
    await flushPromises()

    expect(wrapper.get('[data-routine-row="paused"]').text()).toContain('Paused')
    expect(wrapper.get('[data-routine-row="running"]').text()).toContain('Running')
    expect(wrapper.get('[data-routine-row="missing"]').text()).toContain('Unavailable')
    expect(wrapper.get('[data-routine-run="missing"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-routine-row="sweep"]').text()).toContain('Manual')
    expect(wrapper.get('[data-routine-run="sweep"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.get('[data-routines-summary]').text()).toContain('1 manual')
    await wrapper.get('[data-routine-select="sweep"]').trigger('click')
    expect(wrapper.get('[data-routine-detail="sweep"]').text()).toContain('Manual — runs on demand')
    expect(wrapper.get('[data-routine-detail="sweep"]').text()).toContain('Launcher default')
    expect(wrapper.get('[data-routine-detail="sweep"]').text()).not.toContain('/work')
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
        path: '/home/me/.mimir/routines/broken.toml',
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
    expect(wrapper.get('[data-routines-empty]').text()).toContain('/home/me/.mimir/routines')
    expect(wrapper.get('[data-routines-empty]').text()).toContain('normal agent Activity')
    expect(wrapper.get('[data-routines-empty-create]').text()).toContain('Create routine')
  })

  it('creates a manual routine by default with an auto-derived id and detected agent', async () => {
    const wrapper = render()
    await flushPromises()

    await wrapper.get('[data-routines-new]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-routine-id-input]').exists()).toBe(false)
    expect(wrapper.find('[data-routine-timezone-input]').exists()).toBe(false)
    expect(wrapper.get('[data-routine-preset-option="codex-review"]').attributes('aria-checked')).toBe('true')
    expect(wrapper.get('[data-routine-preset-option="pi"]').text()).toContain('not found')
    expect(wrapper.find('[data-routine-preset-option="terminal"]').exists()).toBe(false)

    await wrapper.get('[data-routine-title-input]').setValue('Friday synthesis')
    await wrapper.get('[data-routine-prompt-input]').setValue('Synthesize the week.')
    await wrapper.get('[data-routine-preset-option="claude"]').trigger('click')
    await wrapper.get('[data-routine-form]').trigger('submit')
    await flushPromises()

    expect(createRoutineDefinition).toHaveBeenCalledWith(expect.objectContaining({
      id: 'friday-synthesis',
      title: 'Friday synthesis',
      prompt: 'Synthesize the week.',
      preset: 'claude',
      schedule: null,
      enabled: true,
      interactive: true,
      timezone: expect.any(String),
      overlap: 'skip',
      missed: 'run-once',
    }))
    expect(wrapper.get('[data-routine-row="friday-synthesis"]').text()).toContain('Manual')

    await wrapper.get('[data-routine-edit="friday-synthesis"]').trigger('click')
    await wrapper.get('[data-routine-title-input]').setValue('Friday review')
    await wrapper.get('[data-routine-form]').trigger('submit')
    await flushPromises()
    expect(updateRoutineDefinition).toHaveBeenCalledWith(
      'friday-synthesis',
      'rev-friday-synthesis',
      expect.objectContaining({ title: 'Friday review', schedule: null }),
    )

    await wrapper.get('[data-routine-open-source="friday-synthesis"]').trigger('click')
    expect(wrapper.emitted('openFile').at(-1)).toEqual([
      '/home/me/.mimir/routines/friday-synthesis.toml',
    ])
  })

  it('offers scoped agent packages and saves one without a duplicate prompt', async () => {
    const wrapper = render()
    await flushPromises()

    await wrapper.get('[data-routines-new]').trigger('click')
    await flushPromises()
    expect(wrapper.get('datalist option').attributes('value')).toBe('evidence-sweep')

    await wrapper.get('[data-routine-title-input]').setValue('Evidence sweep')
    await wrapper.get('[data-routine-agent-input]').setValue('evidence-sweep')
    await flushPromises()

    expect(wrapper.find('[data-routine-prompt-input]').exists()).toBe(false)
    expect(wrapper.find('[data-routine-preset-option]').exists()).toBe(false)
    expect(wrapper.get('[data-routine-workspace-input]').element.value).toBe('/work')
    await wrapper.get('[data-routine-form]').trigger('submit')
    await flushPromises()

    expect(createRoutineDefinition).toHaveBeenCalledWith(expect.objectContaining({
      id: 'evidence-sweep',
      agent: 'evidence-sweep',
      preset: '',
      prompt: '',
      workspace: '/work',
    }))
  })

  it('builds cron from the schedule picker without exposing cron syntax', async () => {
    const wrapper = render()
    await flushPromises()

    await wrapper.get('[data-routines-new]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-routine-title-input]').setValue('Weekly digest')
    await wrapper.get('[data-routine-prompt-input]').setValue('Digest the week.')
    await wrapper.get('[data-routine-trigger-scheduled]').trigger('click')
    await wrapper.get('[data-routine-frequency="weekly"]').trigger('click')
    await wrapper.get('[data-routine-day="fri"]').trigger('click')
    await wrapper.get('[data-routine-time-input]').setValue('18:30')

    expect(wrapper.get('[data-routine-schedule-summary]').text()).toContain('Runs Mon, Fri 18:30')
    expect(wrapper.get('[data-routine-schedule-summary]').text()).toContain('30 18 * * 1,5')

    await wrapper.get('[data-routine-form]').trigger('submit')
    await flushPromises()

    expect(createRoutineDefinition).toHaveBeenCalledWith(expect.objectContaining({
      id: 'weekly-digest',
      schedule: '30 18 * * 1,5',
      enabled: true,
    }))
  })

  it('requires and prefills a workspace when the agent preset runs in one', async () => {
    const wrapper = render()
    await flushPromises()

    await wrapper.get('[data-routines-new]').trigger('click')
    await flushPromises()

    // codex-review (workspace-mode) is preselected → field appears prefilled
    // with the workbench workspace.
    expect(wrapper.get('[data-routine-workspace-input]').element.value).toBe('/work')

    await wrapper.get('[data-routine-title-input]').setValue('Briefing')
    await wrapper.get('[data-routine-prompt-input]').setValue('Brief me.')
    await wrapper.get('[data-routine-workspace-input]').setValue('')
    await wrapper.get('[data-routine-form]').trigger('submit')
    await flushPromises()

    expect(createRoutineDefinition).not.toHaveBeenCalled()
    expect(wrapper.get('[data-routine-form-error]').text()).toContain('workspace folder')

    await wrapper.get('[data-routine-workspace-input]').setValue('/repos/briefing')
    await wrapper.get('[data-routine-form]').trigger('submit')
    await flushPromises()

    expect(createRoutineDefinition).toHaveBeenCalledWith(expect.objectContaining({
      workspace: '/repos/briefing',
      preset: 'codex-review',
    }))
  })

  it('withdraws an untouched workspace prefill when the agent ignores it, keeps typed ones', async () => {
    const wrapper = render()
    await flushPromises()

    await wrapper.get('[data-routines-new]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-routine-workspace-input]').element.value).toBe('/work')

    await wrapper.get('[data-routine-preset-option="claude"]').trigger('click')
    expect(wrapper.find('[data-routine-workspace-input]').exists()).toBe(false)

    await wrapper.get('[data-routine-preset-option="codex-review"]').trigger('click')
    expect(wrapper.get('[data-routine-workspace-input]').element.value).toBe('/work')

    await wrapper.get('[data-routine-workspace-input]').setValue('/repos/custom')
    await wrapper.get('[data-routine-preset-option="claude"]').trigger('click')
    expect(wrapper.get('[data-routine-workspace-input]').element.value).toBe('/repos/custom')
  })

  it('never hangs deriving a unique id from very long titles', async () => {
    const longId = 'a'.repeat(64)
    vi.mocked(loadRoutineCatalog).mockResolvedValue(catalog({
      routines: [routine({ id: longId, title: 'a'.repeat(70) })],
    }))
    const wrapper = render()
    await flushPromises()

    await wrapper.get(`[data-routine-row="${longId}"]`).trigger('contextmenu', { clientX: 20, clientY: 20 })
    await wrapper.get('[data-routine-action="duplicate"]').trigger('click')
    await wrapper.get('[data-routine-form]').trigger('submit')
    await flushPromises()

    expect(duplicateRoutineDefinition).toHaveBeenCalledWith(
      longId,
      `rev-${longId}`,
      `${'a'.repeat(62)}-2`,
      `${'a'.repeat(70)} copy`,
    )
  })

  it('holds the save until launcher detection resolves', async () => {
    vi.mocked(loadLauncherConfig).mockReturnValue(new Promise(() => {}))
    const wrapper = render()
    await flushPromises()

    await wrapper.get('[data-routines-new]').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Detecting installed agents…')
    expect(wrapper.get('[data-routine-form-submit]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-routine-form]').trigger('submit')
    await flushPromises()
    expect(createRoutineDefinition).not.toHaveBeenCalled()
  })

  it('preserves a hand-written enabled flag on manual routines', async () => {
    vi.mocked(loadRoutineCatalog).mockResolvedValue(catalog({
      routines: [routine({ id: 'sweep', title: 'Sweep', schedule: null, enabled: false, nextFire: null })],
    }))
    const wrapper = render()
    await flushPromises()

    await wrapper.get('[data-routine-edit="sweep"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-routine-form]').trigger('submit')
    await flushPromises()

    expect(updateRoutineDefinition).toHaveBeenCalledWith(
      'sweep',
      'rev-sweep',
      expect.objectContaining({ enabled: false, schedule: null, workspace: '/work' }),
    )
  })

  it('defaults new routines to an interactive session and saves a one-shot switch', async () => {
    const wrapper = render()
    await flushPromises()

    await wrapper.get('[data-routines-new]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-routine-session-interactive]').attributes('aria-checked')).toBe('true')
    await wrapper.get('[data-routine-title-input]').setValue('Briefing')
    await wrapper.get('[data-routine-prompt-input]').setValue('Brief me on the repo.')
    await wrapper.get('[data-routine-session-one-shot]').trigger('click')
    await wrapper.get('[data-routine-form]').trigger('submit')
    await flushPromises()

    expect(createRoutineDefinition).toHaveBeenCalledWith(expect.objectContaining({
      id: 'briefing',
      interactive: false,
    }))
  })

  it('opens hand-written headless definitions as one-shot and saves an interactive switch', async () => {
    const wrapper = render()
    await flushPromises()

    await wrapper.get('[data-routine-select="morning"]').trigger('click')
    expect(wrapper.get('[data-routine-detail="morning"]').text()).toContain('One-shot')

    await wrapper.get('[data-routine-edit="morning"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-routine-session-one-shot]').attributes('aria-checked')).toBe('true')

    await wrapper.get('[data-routine-session-interactive]').trigger('click')
    await wrapper.get('[data-routine-form]').trigger('submit')
    await flushPromises()

    expect(updateRoutineDefinition).toHaveBeenCalledWith(
      'morning',
      'rev-morning',
      expect.objectContaining({ interactive: true }),
    )
  })

  it('rejects a one-shot Gemini routine with an actionable session hint', async () => {
    vi.mocked(detectAgents).mockResolvedValue([
      { id: 'gemini', installed: true, binaryPath: '/bin/gemini' },
    ])
    vi.mocked(loadLauncherConfig).mockResolvedValue({
      path: '/home/me/.mimir/launchers.json',
      presets: [
        { id: 'gemini', title: 'Gemini', kind: 'agent', agentId: 'gemini', enabled: true, cwd: { mode: 'home' } },
      ],
    })
    const wrapper = render()
    await flushPromises()

    await wrapper.get('[data-routines-new]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-routine-title-input]').setValue('Ask Gemini')
    await wrapper.get('[data-routine-prompt-input]').setValue('Summarize the news.')
    await wrapper.get('[data-routine-session-one-shot]').trigger('click')
    await wrapper.get('[data-routine-form]').trigger('submit')
    await flushPromises()

    expect(createRoutineDefinition).not.toHaveBeenCalled()
    expect(wrapper.get('[data-routine-form-error]').text()).toContain('set Session to Interactive')

    await wrapper.get('[data-routine-session-interactive]').trigger('click')
    await wrapper.get('[data-routine-form]').trigger('submit')
    await flushPromises()
    expect(createRoutineDefinition).toHaveBeenCalledWith(expect.objectContaining({
      preset: 'gemini',
      interactive: true,
    }))
  })

  it('warns about skip-overlap holding fires only for scheduled interactive sessions', async () => {
    const wrapper = render()
    await flushPromises()

    await wrapper.get('[data-routines-new]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-routine-session-note]').exists()).toBe(false)
    await wrapper.get('[data-routine-trigger-scheduled]').trigger('click')
    expect(wrapper.get('[data-routine-session-note]').text()).toContain('stay open')

    await wrapper.get('[data-routine-session-one-shot]').trigger('click')
    expect(wrapper.find('[data-routine-session-note]').exists()).toBe(false)
  })

  it('surfaces builder validation instead of writing an incomplete schedule', async () => {
    const wrapper = render()
    await flushPromises()

    await wrapper.get('[data-routines-new]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-routine-title-input]').setValue('Broken')
    await wrapper.get('[data-routine-prompt-input]').setValue('Try.')
    await wrapper.get('[data-routine-trigger-scheduled]').trigger('click')
    await wrapper.get('[data-routine-frequency="weekly"]').trigger('click')
    await wrapper.get('[data-routine-day="mon"]').trigger('click')
    await wrapper.get('[data-routine-form]').trigger('submit')
    await flushPromises()

    expect(createRoutineDefinition).not.toHaveBeenCalled()
    expect(wrapper.get('[data-routine-form-error]').text()).toContain('at least one day')
  })

  it('keeps Tab focus inside the routine editor dialog', async () => {
    const wrapper = render()
    document.body.appendChild(wrapper.element)
    await flushPromises()

    await wrapper.get('[data-routines-new]').trigger('click')
    await flushPromises()
    const title = wrapper.get('[data-routine-title-input]')
    const submit = wrapper.get('[data-routine-form-submit]')
    expect(document.activeElement).toBe(title.element)

    await title.trigger('keydown', { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(submit.element)
    await submit.trigger('keydown', { key: 'Tab' })
    expect(document.activeElement).toBe(title.element)
    wrapper.unmount()
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
    expect(wrapper.find('[data-routine-id-input]').exists()).toBe(false)
    await wrapper.get('[data-routine-form]').trigger('submit')
    await flushPromises()
    expect(duplicateRoutineDefinition).toHaveBeenCalledWith(
      'morning',
      'rev-morning',
      'morning-review-copy',
      'Morning review copy',
    )
    expect(wrapper.get('[data-routine-row="morning-review-copy"]').text()).toContain('Paused')

    await wrapper.get('[data-routine-row="morning-review-copy"]').trigger('contextmenu', { clientX: 30, clientY: 40 })
    await wrapper.get('[data-routine-action="trash"]').trigger('click')
    expect(wrapper.get('[data-routine-trash-dialog]').text()).toContain('system Trash')
    await wrapper.get('[data-routine-confirm-trash]').trigger('click')
    await flushPromises()
    expect(trashRoutineDefinition).toHaveBeenCalledWith('morning-review-copy', 'rev-morning-review-copy')
    expect(wrapper.find('[data-routine-row="morning-review-copy"]').exists()).toBe(false)

    await wrapper.get('[data-routine-list]').trigger('contextmenu', { clientX: 12, clientY: 12 })
    expect(wrapper.get('[data-routines-context-menu]').text()).toContain('New routine')
    expect(wrapper.get('[data-routines-context-menu]').text()).toContain('Reveal definitions folder')
  })

  it('keeps Trash confirmation focus inside the dialog and accepts Return', async () => {
    const wrapper = render()
    document.body.appendChild(wrapper.element)
    await flushPromises()

    await wrapper.get('[data-routine-row="morning"]').trigger('contextmenu', { clientX: 30, clientY: 40 })
    await wrapper.get('[data-routine-action="trash"]').trigger('click')

    const confirm = wrapper.get('[data-routine-confirm-trash]')
    expect(document.activeElement).toBe(confirm.element)
    await confirm.trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(trashRoutineDefinition).toHaveBeenCalledWith('morning', 'rev-morning')
    expect(wrapper.find('[data-routine-trash-dialog]').exists()).toBe(false)
    expect(document.activeElement).toBe(wrapper.get('[data-routine-list]').element)
    wrapper.unmount()
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
    expect(wrapper.emitted('openFile').at(-1)).toEqual(['/home/me/.mimir/routines/morning.toml'])
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
