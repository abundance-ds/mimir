import { invoke } from '@tauri-apps/api/core'

const isTauri = () => !!window.__TAURI_INTERNALS__

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
  if (!isTauri()) return
  await invoke('session_save', { session: state })
}

/**
 * Load the last saved session state. Returns null if no session exists.
 */
export async function loadSession() {
  if (!isTauri()) return null
  const result = await invoke('session_load')
  if (result?.diagnostic) console.warn(`[session] ${result.diagnostic}`)
  return result?.session ?? null
}
