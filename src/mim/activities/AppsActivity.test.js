import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import {
  loadAppsCatalog,
  resolveAppLaunch,
} from '../../services/appsCatalog.js'
import AppsActivity from './AppsActivity.vue'

vi.mock('../../services/appsCatalog.js', async (importOriginal) => ({
  ...(await importOriginal()),
  loadAppsCatalog: vi.fn(),
  resolveAppLaunch: vi.fn(),
}))

const catalog = {
  directory: '/home/me/.mim/apps',
  diagnostics: [],
  apps: [
    {
      id: 'changes',
      title: 'Changes',
      description: 'Review Git changes.',
      mode: 'rust-helper',
      helper: 'git-changes',
      builtin: true,
      tools: [],
    },
    {
      id: 'scratch',
      title: 'Scratch',
      description: 'Think quickly.',
      mode: 'embedded',
      entry: 'mim://builtin/scratch',
      builtin: true,
      tools: [{ name: 'read' }],
    },
  ],
}

describe('AppsActivity', () => {
  let pinia

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    vi.mocked(loadAppsCatalog).mockReset().mockResolvedValue(catalog)
    vi.mocked(resolveAppLaunch).mockReset().mockResolvedValue({
      mode: 'embedded',
      appId: 'scratch',
      url: 'mim://builtin/scratch',
    })
  })

  function render() {
    return mount(AppsActivity, {
      global: { plugins: [pinia] },
      props: {
        activity: { id: 'apps', workspacePath: '/work' },
        active: true,
      },
    })
  }

  it('shows built-ins as dense launch rows with tool metadata', async () => {
    const wrapper = render()
    await flushPromises()

    expect(wrapper.findAll('[data-app-row]')).toHaveLength(2)
    expect(wrapper.get('[data-app-row="scratch"]').text()).toContain('1 tool')
    expect(wrapper.get('[data-apps-local-empty]').text()).toContain('app.toml')
  })

  it('supports keyboard selection and emits a fully resolved Activity', async () => {
    const wrapper = render()
    await flushPromises()

    await wrapper.get('[data-apps-activity]').trigger('keydown', { key: 'ArrowDown' })
    await wrapper.get('[data-apps-activity]').trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(resolveAppLaunch).toHaveBeenCalledWith('scratch', '/work')
    expect(wrapper.emitted('launchApp')[0][0]).toMatchObject({
      app: { id: 'scratch' },
      activity: { id: 'app:scratch', workspacePath: '/work' },
    })
  })

  it('keeps invalid local definitions visible as diagnostics', async () => {
    vi.mocked(loadAppsCatalog).mockResolvedValue({
      ...catalog,
      diagnostics: [{
        path: '/home/me/.mim/apps/bad/app.toml',
        field: 'entry',
        message: 'Entry does not exist.',
      }],
    })
    const wrapper = render()
    await flushPromises()

    expect(wrapper.get('[data-app-diagnostics]').text()).toContain('Entry does not exist.')
  })
})
