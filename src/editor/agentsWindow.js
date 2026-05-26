import { invoke } from '@tauri-apps/api/core'

function isTauriRuntime() {
  return Boolean(window.__TAURI_INTERNALS__)
}

export async function openPanelWindow() {
  try {
    if (!isTauriRuntime()) {
      if (window.opener) {
        window.opener.focus()
      } else {
        window.open('/', 'shoulders-panel')
      }
      return
    }
    await invoke('focus_main_window')
  } catch (error) {
    console.error('Could not focus panel window', error)
  }
}
