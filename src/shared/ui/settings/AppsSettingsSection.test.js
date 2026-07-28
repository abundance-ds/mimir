import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia } from 'pinia'
import {
  createLocalApp,
  loadAppsCatalog,
  reloadAppsCatalog,
  resolveAppLaunch,
} from '../../../services/appsCatalog.js'
import AppsSettingsSection from './AppsSettingsSection.vue'

vi.mock('../../../services/appsCatalog.js', async (importOriginal) => ({
  ...(await importOriginal()),
  createLocalApp: vi.fn(),
  duplicateLocalApp: vi.fn(),
  loadAppsCatalog: vi.fn(),
  reloadAppsCatalog: vi.fn(),
  resolveAppLaunch: vi.fn(),
  revealAppDefinition: vi.fn(),
  revealAppsDirectory: vi.fn(),
  trashLocalApp: vi.fn(),
  updateLocalAppTitle: vi.fn(),
}))

const builtIn = {
  id: 'scratch',
  title: 'Today',
  description: 'Keep one top priority in view',
  mode: 'embedded',
  builtin: true,
  manifestPath: 'builtin:scratch',
  tools: [],
}
const local = {
  id: 'ledger',
  title: 'Ledger',
  description: 'Project numbers',
  mode: 'embedded',
  builtin: false,
  manifestPath: '/home/me/.mimir/apps/ledger/app.toml',
  tools: [{ name: 'total', mcpAlias: 'ledger_total' }],
}

function catalog(apps = [builtIn, local]) {
  return {
    directory: '/home/me/.mimir/apps',
    apps,
    diagnostics: [{
      path: '/home/me/.mimir/apps/bad/app.toml',
      field: 'entry',
      message: 'Entry does not exist.',
    }],
  }
}

describe('AppsSettingsSection', () => {
  beforeEach(() => {
    vi.mocked(loadAppsCatalog).mockReset().mockResolvedValue(catalog())
    vi.mocked(reloadAppsCatalog).mockReset().mockResolvedValue(catalog())
    vi.mocked(createLocalApp).mockReset().mockResolvedValue(catalog())
    vi.mocked(resolveAppLaunch).mockReset().mockResolvedValue({
      mode: 'embedded',
      appId: 'ledger',
      url: 'file:///apps/ledger/index.html',
    })
  })

  function render() {
    return mount(AppsSettingsSection, {
      attachTo: document.body,
      global: { plugins: [createPinia()] },
    })
  }

  it('is a searchable keyboard catalog with built-in/local boundaries and diagnostics', async () => {
    const wrapper = render()
    await flushPromises()

    expect(wrapper.get('[data-app-settings-group="built-in"]').text()).toContain('Today')
    expect(wrapper.get('[data-app-settings-group="local"]').text()).toContain('Ledger')
    expect(wrapper.get('[data-app-diagnostics]').text()).toContain('Entry does not exist')

    await wrapper.get('[data-app-search]').setValue('ledger_total')
    expect(wrapper.find('[data-app-settings-row="scratch"]').exists()).toBe(false)
    expect(wrapper.get('[data-app-settings-row="ledger"]').exists()).toBe(true)

    await wrapper.get('[data-app-settings-row="ledger"]').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(wrapper.emitted('launchApp')).toHaveLength(1)
    expect(wrapper.emitted('launchApp')[0][0]).toMatchObject({
      app: { id: 'ledger' },
      activity: { id: 'app:ledger' },
    })
    wrapper.unmount()
  })

  it('lets the first Escape cancel an inline operation without closing Settings', async () => {
    const wrapper = render()
    await flushPromises()
    const bubbled = vi.fn()
    document.addEventListener('keydown', bubbled)

    await wrapper.get('[data-app-new]').trigger('click')
    await wrapper.get('[data-app-title-input]').trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('[data-app-operation]').exists()).toBe(false)
    expect(bubbled).not.toHaveBeenCalled()

    await wrapper.get('[data-app-search]').trigger('keydown', { key: 'Escape' })
    expect(bubbled).toHaveBeenCalledTimes(1)
    document.removeEventListener('keydown', bubbled)
    wrapper.unmount()
  })

  it('does not hijack Enter from the inspector Open button', async () => {
    const wrapper = render()
    await flushPromises()
    await wrapper.get('[data-app-settings-row="ledger"]').trigger('click')
    const open = wrapper.get('[data-app-launch]')

    await open.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(wrapper.emitted('launchApp')).toBeUndefined()

    await open.trigger('click')
    await flushPromises()
    expect(wrapper.emitted('launchApp')).toHaveLength(1)
    wrapper.unmount()
  })

  it('exposes rich local actions while keeping built-ins immutable', async () => {
    const wrapper = render()
    await flushPromises()

    expect(wrapper.get('[data-app-inspector]').text()).toContain('Built-ins are host code')
    await wrapper.get('[data-app-settings-row="ledger"]').trigger('click')

    expect(wrapper.get('[data-app-open-definition]').exists()).toBe(true)
    expect(wrapper.get('[data-app-duplicate]').exists()).toBe(true)
    expect(wrapper.get('[data-app-rename]').exists()).toBe(true)
    expect(wrapper.get('[data-app-trash]').exists()).toBe(true)

    await wrapper.get('[data-app-open-definition]').trigger('click')
    expect(wrapper.emitted('openDefinition')).toEqual([
      ['/home/me/.mimir/apps/ledger/app.toml'],
    ])
    wrapper.unmount()
  })

  it('creates a usable scaffold and applies the returned catalog live', async () => {
    const created = {
      ...local,
      id: 'local-instrument',
      title: 'Local Instrument',
      manifestPath: '/home/me/.mimir/apps/local-instrument/app.toml',
    }
    vi.mocked(createLocalApp).mockResolvedValue(catalog([builtIn, local, created]))
    const wrapper = render()
    await flushPromises()

    await wrapper.get('[data-app-new]').trigger('click')
    await wrapper.get('[data-app-operation-confirm]').trigger('submit')
    await flushPromises()

    expect(createLocalApp).toHaveBeenCalledWith({
      id: 'local-instrument',
      title: 'Local Instrument',
      description: '',
    })
    expect(wrapper.get('[data-app-settings-row="local-instrument"]').exists()).toBe(true)
    expect(wrapper.get('[data-apps-notice]').text()).toContain('is ready')
    wrapper.unmount()
  })
})
