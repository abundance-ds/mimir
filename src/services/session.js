import { invoke } from '@tauri-apps/api/core'
import { getAiConfigDir } from './ai/client.js'

const isTauri = () => !!window.__TAURI_INTERNALS__

let configDir = null

async function getSessionPath() {
  if (!isTauri()) return null
  if (!configDir) configDir = await getAiConfigDir()
  return `${configDir}/session.json`
}

/**
 * Save editor session state to disk.
 *
 * Shape:
 * {
 *   openFiles: string[],
 *   activeFileIndex: number,
 *   zoomLevel: number,
 * }
 */
export async function saveSession(state) {
  const path = await getSessionPath()
  if (!path) return
  const json = JSON.stringify(state, null, 2)
  await invoke('write_text_file', { path, content: json })
}

/**
 * Load the last saved session state. Returns null if no session exists.
 */
export async function loadSession() {
  const path = await getSessionPath()
  if (!path) return null
  try {
    const exists = await invoke('path_exists', { path })
    if (!exists) return null
    const result = await invoke('read_text_file', { path })
    return JSON.parse(result.content)
  } catch {
    return null
  }
}
