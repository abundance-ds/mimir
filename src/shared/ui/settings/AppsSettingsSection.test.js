import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia } from 'pinia'
import {
  createLocalApp,
  duplicateLocalApp,
  loadAppsCatalog,
  reloadAppsCatalog,
  resolveAppLaunch,
  trashLocalApp,
  updateLocalAppTitle,
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

const today = {
  id: 'scratch',
  title: 'Today',
  mode: 'embedded',
  builtin: true,
  manifestPath: 'builtin:scratch',
  tools: [],
}
const tracker = {
  id: 'tracker',
  title: 'Tracker',
  mode: 'rust-helper',
  helper: 'tracker',
  builtin: true,
  manifestPath: 'builtin:tracker',
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

function catalog(apps = [today, tracker, local], diagnostics = [{
  path: '/home/me/.mimir/apps/bad/app.toml',
  field: 'entry',
  message: 'Entry does not exist.',
}]) {
  return { directory: '/home/me/.mimir/apps', apps, diagnostics }
}

describe('AppsSettingsSection', () => {
  beforeEach(() => {
    vi.mocked(loadAppsCatalog).mockReset().mockResolvedValue(catalog())
    vi.mocked(reloadAppsCatalog).mockReset().mockResolvedValue(catalog())
    vi.mocked(createLocalApp).mockReset().mockResolvedValue(catalog())
    vi.mocked(duplicateLocalApp).mockReset().mockResolvedValue(catalog())
    vi.mocked(resolveAppLaunch).mockReset().mockResolvedValue({
      mode: 'embedded',
      appId: 'ledger',
      url: 'file:///apps/ledger/index.html',
    })
    vi.mocked(trashLocalApp).mockReset().mockResolvedValue(catalog())
    vi.mocked(updateLocalAppTitle).mockReset().mockResolvedValue(catalog())
  })

  function render() {
    return mount(AppsSettingsSection, {
      attachTo: document.body,
      global: { plugins: [createPinia()] },
    })
  }

  it('shows only local apps and gives broken definitions direct recovery actions', async () => {
    const wrapper = render()
    await flushPromises()

    expect(wrapper.get('[data-app-settings-row="ledger"]').text()).toContain('Ledger')
    expect(wrapper.find('[data-app-settings-row="scratch"]').exists()).toBe(false)
    expect(wrapper.find('[data-app-settings-row="tracker"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Today')
    expect(wrapper.get('[data-app-diagnostic-row]').text()).toContain('Entry does not exist.')

    await wrapper.get('[data-app-diagnostic-open]').trigger('click')
    expect(wrapper.emitted('openDefinition')).toEqual([
      ['/home/me/.mimir/apps/bad/app.toml'],
    ])
    wrapper.unmount()
  })

  it('shows an honest empty state when the catalog has no local apps', async () => {
    vi.mocked(loadAppsCatalog).mockResolvedValue(catalog([today, tracker], []))
    const wrapper = render()
    await flushPromises()

    expect(wrapper.text()).toContain('No local apps.')
    expect(wrapper.find('[data-app-settings-row]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('gives a failed catalog load one recovery action', async () => {
    vi.mocked(loadAppsCatalog).mockRejectedValueOnce(new Error('Apps directory is unavailable.'))
    const wrapper = render()
    await flushPromises()

    expect(wrapper.text()).toContain('Apps directory is unavailable.')

    vi.mocked(loadAppsCatalog).mockResolvedValueOnce(catalog())
    await wrapper.get('[data-app-load-retry]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-app-settings-row="ledger"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('cancels the inline form on Escape without closing Settings', async () => {
    const wrapper = render()
    await flushPromises()
    const bubbled = vi.fn()
    document.addEventListener('keydown', bubbled)

    await wrapper.get('[data-app-new]').trigger('click')
    await wrapper.get('[data-app-title-input]').trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('[data-app-operation]').exists()).toBe(false)
    expect(bubbled).not.toHaveBeenCalled()

    await wrapper.get('[data-app-new]').trigger('keydown', { key: 'Escape' })
    expect(bubbled).toHaveBeenCalledTimes(1)
    document.removeEventListener('keydown', bubbled)
    wrapper.unmount()
  })

  it('opens a local app only from its explicit Open action', async () => {
    const wrapper = render()
    await flushPromises()

    expect(wrapper.emitted('launchApp')).toBeUndefined()
    await wrapper.get('[data-app-launch]').trigger('click')
    await flushPromises()

    expect(resolveAppLaunch).toHaveBeenCalledWith('ledger', '')
    expect(wrapper.emitted('launchApp')).toHaveLength(1)
    wrapper.unmount()
  })

  it('keeps edit visible and secondary package actions in one menu', async () => {
    const wrapper = render()
    await flushPromises()
    const row = wrapper.get('[data-app-settings-row="ledger"]')

    expect(row.text()).not.toContain('Project numbers')
    expect(row.text()).not.toContain('ledger_total')
    await row.get('[data-app-open-definition]').trigger('click')
    expect(wrapper.emitted('openDefinition')).toEqual([[local.manifestPath]])

    await row.get('[data-app-more]').trigger('click')
    expect(row.get('[data-app-rename]').exists()).toBe(true)
    expect(row.get('[data-app-duplicate]').exists()).toBe(true)
    expect(row.get('[data-app-trash]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('creates a starter app in one compact form', async () => {
    const created = {
      ...local,
      id: 'focus-notes',
      title: 'Focus Notes',
      manifestPath: '/home/me/.mimir/apps/focus-notes/app.toml',
    }
    vi.mocked(createLocalApp).mockResolvedValue(catalog([today, tracker, local, created]))
    const wrapper = render()
    await flushPromises()

    await wrapper.get('[data-app-new]').trigger('click')
    await wrapper.get('[data-app-title-input]').setValue('Focus Notes')
    await wrapper.get('[data-app-operation]').trigger('submit')
    await flushPromises()

    expect(createLocalApp).toHaveBeenCalledWith({
      id: 'focus-notes',
      title: 'Focus Notes',
      description: '',
    })
    expect(wrapper.get('[data-app-settings-row="focus-notes"]').exists()).toBe(true)
    expect(wrapper.find('[data-app-operation]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('duplicates, renames, and trashes from the row menu', async () => {
    const copy = { ...local, id: 'ledger-copy', title: 'Ledger Copy' }
    vi.mocked(duplicateLocalApp).mockResolvedValue(catalog([today, tracker, local, copy]))
    const wrapper = render()
    await flushPromises()

    await wrapper.get('[data-app-settings-row="ledger"]').get('[data-app-more]').trigger('click')
    await wrapper.get('[data-app-duplicate]').trigger('click')
    await flushPromises()
    expect(duplicateLocalApp).toHaveBeenCalledWith('ledger', {
      id: 'ledger-copy',
      title: 'Ledger Copy',
    })

    const renamed = { ...local, title: 'Accounts' }
    vi.mocked(updateLocalAppTitle).mockResolvedValue(catalog([today, tracker, renamed, copy]))
    await wrapper.get('[data-app-settings-row="ledger"]').get('[data-app-more]').trigger('click')
    await wrapper.get('[data-app-rename]').trigger('click')
    await wrapper.get('[data-app-title-input]').setValue('Accounts')
    await wrapper.get('[data-app-operation]').trigger('submit')
    await flushPromises()
    expect(updateLocalAppTitle).toHaveBeenCalledWith('ledger', 'Accounts')

    vi.mocked(trashLocalApp).mockResolvedValue(catalog([today, tracker, copy]))
    await wrapper.get('[data-app-settings-row="ledger"]').get('[data-app-more]').trigger('click')
    await wrapper.get('[data-app-trash]').trigger('click')
    await flushPromises()
    expect(trashLocalApp).toHaveBeenCalledWith('ledger')
    expect(wrapper.find('[data-app-settings-row="ledger"]').exists()).toBe(false)
    wrapper.unmount()
  })
})
