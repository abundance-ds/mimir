import { invoke } from '@tauri-apps/api/core'
import { isTauriRuntime } from '../shared/platform.js'

export async function applySmartQuotes(enabled) {
  if (!isTauriRuntime()) return
  await invoke('set_smart_quotes', { enabled: enabled === true })
}
