import { ref, computed, watch } from 'vue'
import { defineStore } from 'pinia'

const isTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__
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

  // ── Load ──
  async function load() {
    let saved = {}
    try {
      if (isTauri) {
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
  }

  // ── Save ──
  async function save() {
    const snapshot = {}
    for (const key of Object.keys(DEFAULTS)) {
      snapshot[key] = settings[key].value
    }
    try {
      if (isTauri) {
        const { loadSettings, saveSettings } = await import('../services/dataDir.js')
        const existing = await loadSettings()
        existing.editor = snapshot
        await saveSettings(existing)
        try {
          const { invoke } = await import('@tauri-apps/api/core')
          invoke('settings_changed').catch(() => {})
        } catch { /* ignore */ }
      } else {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
      }
    } catch (err) {
      console.warn('[useSettings] save failed:', err)
    }
  }

  // ── Set: the only way to change a setting and persist it ──
  let saveTimer = null
  function set(key, value) {
    if (!(key in settings)) return
    settings[key].value = cloneSetting(value)
    if (!settingsReady.value) return
    clearTimeout(saveTimer)
    saveTimer = setTimeout(save, 300)
  }

  // ── Theme ──
  function applyTheme(theme) {
    const t = theme || 'parchment'
    document.documentElement.setAttribute('data-theme', t)
    if (isTauri) {
      import('@tauri-apps/api/event').then(({ emit }) => {
        emit('mim://theme-changed', { theme: t })
      }).catch(() => {})
    }
    try { localStorage.setItem('mim:theme', t) } catch {}
  }

  watch(settings.editorTheme, (val) => applyTheme(val))

  // ── Cross-window sync (Tauri only) ──
  if (isTauri) {
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen('mim://settings-changed', async () => {
        await load()
        applyTheme(settings.editorTheme.value)
      })
    }).catch(() => {})
  }

  // Kick off initial load
  load().then(() => applyTheme(settings.editorTheme.value))

  const isDarkTheme = computed(() => DARK_THEMES.includes(settings.editorTheme.value))

  return { ...settings, settingsReady, isDarkTheme, load, save, set, applyTheme }
})

function cloneSetting(value) {
  if (value && typeof value === 'object') return structuredClone(value)
  return value
}
