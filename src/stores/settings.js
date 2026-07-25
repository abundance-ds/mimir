import { ref, computed, watch } from 'vue'
import { defineStore } from 'pinia'
import { emit, listen } from '@tauri-apps/api/event'

const isTauri = () => typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__
const STORAGE_KEY = 'mim:editor:settings:v1'

const DARK_THEMES = ['slate', 'monokai', 'dracula', 'zenith', 'synthwave']

const DEFAULTS = {
  editorFontFamily: 'mono',
  editorFontSize: 16,
  editorTheme: 'parchment',
  editorWordWrap: true,
  editorLineWidth: 'normal',
  editorAutoSave: true,
  editorSpellCheck: false,
  editorToolbarMode: 'top',
  editorLivePreview: true,
  aiGhostSuggestions: true,
  aiGhostModel: 'auto',
  aiInlineRewrite: true,
  aiInlineModel: 'auto',
  mimTerminalFontSize: 12,
  recentAppIds: [],
  activityNavigator: {
    mode: 'manual',
    order: [],
  },
  commentGateSkip: false,
  mimWorkspaceFolder: '',
  workbenchLayout: {
    sidebar: { state: 'expanded', width: 240 },
    activity: { state: 'expanded', width: 560 },
    editor: { state: 'expanded', width: 520 },
    activeActivityId: 'files',
  },
}

export const useSettingsStore = defineStore('settings', () => {
  const settings = {}
  for (const [key, defaultVal] of Object.entries(DEFAULTS)) {
    settings[key] = ref(cloneSetting(defaultVal))
  }
  const settingsReady = ref(false)
  let loadPromise = null
  let saveQueue = Promise.resolve(true)
  let saveTimer = null
  let syncLeases = 0
  let syncUnlisten = null
  let syncInstallPromise = null

  // ── Load ──
  function load({ force = false } = {}) {
    if (loadPromise) return loadPromise
    loadPromise = (async () => {
      let saved = {}
      try {
        if (isTauri()) {
          const { loadSettings } = await import('../services/dataDir.js')
          const allSettings = await loadSettings()
          saved = allSettings.editor || {}
        } else {
          const raw = localStorage.getItem(STORAGE_KEY)
          if (raw) saved = JSON.parse(raw)
        }
      } catch { /* use defaults */ }

      for (const key of Object.keys(DEFAULTS)) {
        if (saved[key] !== undefined) {
          settings[key].value = cloneSetting(saved[key])
        }
      }
      settingsReady.value = true
    })().finally(() => {
      loadPromise = null
    })
    return loadPromise
  }

  // ── Save ──
  function snapshotSettings() {
    const snapshot = {}
    for (const key of Object.keys(DEFAULTS)) {
      snapshot[key] = cloneSetting(settings[key].value)
    }
    return snapshot
  }

  async function persistSnapshot(snapshot) {
    try {
      if (isTauri()) {
        const { saveEditorSettings } = await import('../services/dataDir.js')
        await saveEditorSettings(snapshot)
        try {
          const { invoke } = await import('@tauri-apps/api/core')
          await invoke('settings_changed')
        } catch { /* ignore */ }
      } else {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
      }
      return true
    } catch (err) {
      console.warn('[useSettings] save failed:', err)
      return false
    }
  }

  function enqueueSave(snapshot) {
    const operation = saveQueue.then(
      () => persistSnapshot(snapshot),
      () => persistSnapshot(snapshot),
    )
    saveQueue = operation.catch(() => false)
    return operation
  }

  function save() {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    return enqueueSave(snapshotSettings())
  }

  function flush() {
    return saveTimer ? save() : saveQueue
  }

  // ── Set: the only way to change a setting and persist it ──
  function set(key, value) {
    if (!(key in settings)) return
    settings[key].value = cloneSetting(value)
    if (!settingsReady.value) return
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      void enqueueSave(snapshotSettings())
    }, 300)
  }

  // ── Theme ──
  function applyTheme(theme) {
    const t = theme || 'parchment'
    document.documentElement.setAttribute('data-theme', t)
    if (isTauri()) {
      Promise.resolve(emit('mim://theme-changed', { theme: t })).catch(() => {})
    }
    try { localStorage.setItem('mim:theme', t) } catch {}
  }

  watch(settings.editorTheme, (val) => applyTheme(val))

  // ── Cross-window sync (Tauri only) ──
  function ensureSyncListener() {
    if (!isTauri() || syncUnlisten) return Promise.resolve()
    if (syncInstallPromise) return syncInstallPromise
    syncInstallPromise = Promise.resolve(
      listen('mim://settings-changed', async () => {
        // Preserve this window's latest local edit before accepting another
        // window's complete snapshot.
        await flush()
        await load({ force: true })
        applyTheme(settings.editorTheme.value)
      }),
    )
      .then((unlisten) => {
        if (syncLeases > 0) syncUnlisten = unlisten
        else unlisten?.()
      })
      .catch(() => {})
      .finally(() => {
        syncInstallPromise = null
      })
    return syncInstallPromise
  }

  function startSync() {
    syncLeases++
    void ensureSyncListener()
    let released = false
    return () => {
      if (released) return
      released = true
      syncLeases = Math.max(0, syncLeases - 1)
      if (syncLeases === 0 && syncUnlisten) {
        syncUnlisten()
        syncUnlisten = null
      }
    }
  }

  // Kick off initial load
  load().then(() => applyTheme(settings.editorTheme.value))

  const isDarkTheme = computed(() => DARK_THEMES.includes(settings.editorTheme.value))

  return {
    ...settings,
    settingsReady,
    isDarkTheme,
    load,
    save,
    flush,
    set,
    applyTheme,
    startSync,
  }
})

function cloneSetting(value) {
  if (value && typeof value === 'object') return JSON.parse(JSON.stringify(value))
  return value
}
