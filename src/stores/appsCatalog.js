import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  createAppActivity,
  loadAppsCatalog,
  resolveAppLaunch,
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
      directory.value = catalog.directory
      apps.value = catalog.apps
      diagnostics.value = catalog.diagnostics
      loaded.value = true
      if (!apps.value.some((app) => app.id === selectedId.value)) {
        selectedId.value = apps.value[0]?.id || ''
      }
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
    prepareActivity,
    select,
  }
})

function message(error) {
  return error instanceof Error ? error.message : String(error || 'App catalog could not be loaded.')
}
