import { invoke } from '@tauri-apps/api/core'

export async function getDataDir() {
  return invoke('ai_config_dir')
}

export async function loadSettings() {
  const result = await invoke('settings_load')
  if (result?.diagnostic) console.warn(`[settings] ${result.diagnostic}`)
  return result?.settings || {}
}

export async function saveSettings(settings) {
  await invoke('settings_save', { settings })
}

export async function saveEditorSettings(editor) {
  await invoke('settings_save_editor', { editor })
}
