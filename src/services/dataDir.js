import { invoke } from '@tauri-apps/api/core'

let dataDir = null

export async function getDataDir() {
  if (dataDir) return dataDir
  dataDir = await invoke('ai_config_dir')
  return dataDir
}

export async function loadSettings() {
  const path = `${await getDataDir()}/settings.json`
  try {
    if (!await invoke('path_exists', { path })) return {}
    const { content } = await invoke('read_text_file', { path })
    return JSON.parse(content)
  } catch {
    return {}
  }
}

export async function saveSettings(settings) {
  const path = `${await getDataDir()}/settings.json`
  await invoke('write_text_file', {
    path,
    content: JSON.stringify(settings, null, 2),
  })
}
