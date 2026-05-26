import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { useSettingsStore } from '../settings.js'

const isTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__

export const useAppStore = defineStore('panelApps', () => {
  const apps = ref([])    // all discovered app manifests

  async function discover() {
    if (!isTauri) { apps.value = []; return }
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      apps.value = await invoke('app_discover')
    } catch (e) {
      console.error('[apps] discover failed:', e)
      apps.value = []
    }
  }

  // MRU tracking — stored in settings
  const recentAppIds = computed(() => {
    const settings = useSettingsStore()
    return settings.recentAppIds || []
  })

  const recentApps = computed(() => {
    const ids = recentAppIds.value
    const all = apps.value
    // Return apps in MRU order, only those that still exist
    const byId = new Map(all.map(a => [a.id, a]))
    const recent = ids.map(id => byId.get(id)).filter(Boolean)
    // Append any apps not in MRU list
    const seen = new Set(ids)
    const rest = all.filter(a => !seen.has(a.id))
    return [...recent, ...rest]
  })

  function trackUsage(appId) {
    const settings = useSettingsStore()
    const current = [...(settings.recentAppIds || [])]
    const idx = current.indexOf(appId)
    if (idx !== -1) current.splice(idx, 1)
    current.unshift(appId)
    // Keep max 20
    settings.set('recentAppIds', current.slice(0, 20))
  }

  function getApp(appId) {
    return apps.value.find(a => a.id === appId) || null
  }

  async function deleteApp(appId) {
    if (!isTauri) return
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('app_delete', { appId })
      await discover()
    } catch (e) {
      console.error('[apps] delete failed:', e)
    }
  }

  return { apps, recentApps, recentAppIds, discover, trackUsage, getApp, deleteApp }
})
