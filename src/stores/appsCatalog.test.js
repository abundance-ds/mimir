import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  createLocalApp,
  duplicateLocalApp,
  loadAppsCatalog,
  reloadAppsCatalog,
  resolveAppLaunch,
  trashLocalApp,
  updateLocalAppTitle,
} from '../services/appsCatalog.js'
import { useAppsCatalogStore } from './appsCatalog.js'

vi.mock('../services/appsCatalog.js', async (importOriginal) => ({
  ...(await importOriginal()),
  createLocalApp: vi.fn(),
  duplicateLocalApp: vi.fn(),
  loadAppsCatalog: vi.fn(),
  reloadAppsCatalog: vi.fn(),
  resolveAppLaunch: vi.fn(),
  trashLocalApp: vi.fn(),
  updateLocalAppTitle: vi.fn(),
}))

const apps = [
  {
    id: 'changes',
    title: 'Changes',
    mode: 'rust-helper',
    helper: 'git-changes',
    builtin: true,
    tools: [],
  },
  {
    id: 'ledger',
    title: 'Ledger',
    mode: 'embedded',
    entry: 'index.html',
    builtin: false,
    tools: [],
  },
]

describe('appsCatalog store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(loadAppsCatalog).mockReset().mockResolvedValue({
      directory: '/home/me/.mim/apps',
      apps,
      diagnostics: [],
    })
    vi.mocked(resolveAppLaunch).mockReset().mockResolvedValue({
      mode: 'embedded',
      appId: 'ledger',
      url: 'file:///apps/ledger/index.html',
    })
    for (const operation of [
      reloadAppsCatalog,
      createLocalApp,
      duplicateLocalApp,
      updateLocalAppTitle,
      trashLocalApp,
    ]) {
      vi.mocked(operation).mockReset().mockResolvedValue({
        directory: '/home/me/.mim/apps',
        apps,
        diagnostics: [],
      })
    }
  })

  it('loads once, groups built-ins, and preserves user selection on refresh', async () => {
    const store = useAppsCatalogStore()
    await store.load()
    store.select('ledger')
    await store.load()

    expect(loadAppsCatalog).toHaveBeenCalledTimes(1)
    expect(store.builtins.map((app) => app.id)).toEqual(['changes'])
    expect(store.localApps.map((app) => app.id)).toEqual(['ledger'])
    expect(store.selectedApp.id).toBe('ledger')
  })

  it('resolves a launch and creates one durable app Activity', async () => {
    const store = useAppsCatalogStore()
    await store.load()

    const payload = await store.prepareActivity(apps[1], '/work')

    expect(resolveAppLaunch).toHaveBeenCalledWith('ledger', '/work')
    expect(payload.activity).toMatchObject({
      id: 'app:ledger',
      kind: 'app',
      retention: 'durable',
      workspacePath: '/work',
    })
  })

  it('surfaces catalog failures without claiming it loaded', async () => {
    vi.mocked(loadAppsCatalog).mockRejectedValue(new Error('catalog unreadable'))
    const store = useAppsCatalogStore()

    await expect(store.load()).rejects.toThrow('catalog unreadable')
    expect(store.loaded).toBe(false)
    expect(store.error).toBe('catalog unreadable')
  })

  it('applies mutation catalogs immediately so the Sidebar sees local app changes live', async () => {
    const store = useAppsCatalogStore()
    await store.load()
    const created = {
      ...apps[1],
      id: 'field-notes',
      title: 'Field Notes',
    }
    vi.mocked(createLocalApp).mockResolvedValue({
      directory: '/home/me/.mim/apps',
      apps: [...apps, created],
      diagnostics: [],
    })

    await store.create({ id: 'field-notes', title: 'Field Notes' })

    expect(store.apps.map(app => app.id)).toContain('field-notes')
    expect(store.selectedId).toBe('field-notes')
  })
})
