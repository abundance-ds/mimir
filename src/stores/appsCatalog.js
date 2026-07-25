import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  createLocalApp,
  createAppActivity,
  duplicateLocalApp,
  loadAppsCatalog,
  reloadAppsCatalog,
  resolveAppLaunch,
  trashLocalApp,
  updateLocalAppTitle,
} from '../services/appsCatalog.js'

export const useAppsCatalogStore = defineStore('appsCatalog', () => {
  const directory = ref('')
  const apps = ref([])
  const diagnostics = ref([])
  const loading = ref(false)
  const loaded = ref(false)
  const error = ref('')
  const selectedId = ref('')

  const builtins = computed(() => apps.value.filter((app) => app.builtin))
  const localApps = computed(() => apps.value.filter((app) => !app.builtin))
  const selectedApp = computed(() => (
    apps.value.find((app) => app.id === selectedId.value) || apps.value[0] || null
  ))

  async function load({ force = false } = {}) {
    if (loading.value) return
    if (loaded.value && !force) return
    loading.value = true
    error.value = ''
    try {
      const catalog = await loadAppsCatalog()
      applyCatalog(catalog)
    } catch (cause) {
      error.value = message(cause)
      throw cause
    } finally {
      loading.value = false
    }
  }

  async function prepareActivity(app, workspacePath = '') {
    if (!app?.id) throw new Error('Choose an app before launching.')
    const launch = await resolveAppLaunch(app.id, workspacePath)
    return {
      app,
      launch,
      activity: createAppActivity(app, launch, workspacePath),
    }
  }

  function select(id) {
    if (apps.value.some((app) => app.id === id)) selectedId.value = id
  }

  async function reload() {
    return mutate(() => reloadAppsCatalog())
  }

  async function create(input) {
    const catalog = await mutate(() => createLocalApp(input))
    select(input.id)
    return catalog
  }

  async function duplicate(appId, input) {
    const catalog = await mutate(() => duplicateLocalApp(appId, input))
    select(input.id)
    return catalog
  }

  async function updateTitle(appId, title) {
    const catalog = await mutate(() => updateLocalAppTitle(appId, title))
    select(appId)
    return catalog
  }

  async function trash(appId) {
    return mutate(() => trashLocalApp(appId))
  }

  async function mutate(operation) {
    loading.value = true
    error.value = ''
    try {
      const catalog = await operation()
      applyCatalog(catalog)
      return catalog
    } catch (cause) {
      error.value = message(cause)
      throw cause
    } finally {
      loading.value = false
    }
  }

  function applyCatalog(catalog) {
    directory.value = catalog.directory
    apps.value = catalog.apps
    diagnostics.value = catalog.diagnostics
    loaded.value = true
    if (!apps.value.some((app) => app.id === selectedId.value)) {
      selectedId.value = apps.value[0]?.id || ''
    }
  }

  return {
    directory,
    apps,
    diagnostics,
    loading,
    loaded,
    error,
    selectedId,
    builtins,
    localApps,
    selectedApp,
    load,
    reload,
    create,
    duplicate,
    updateTitle,
    trash,
    prepareActivity,
    select,
  }
})

function message(error) {
  return error instanceof Error ? error.message : String(error || 'App catalog could not be loaded.')
}
