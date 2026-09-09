import { getCurrentWindow } from '@tauri-apps/api/window'
import { isTauriRuntime } from '../shared/platform.js'

export async function closeCurrentWindow() {
  if (isTauriRuntime()) await getCurrentWindow().close()
  else window.close()
}
