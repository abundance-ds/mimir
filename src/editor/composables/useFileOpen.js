import { onUnmounted } from 'vue'
import { useFileStore } from '../../stores/files.js'
import { readFile } from '../../services/fileSystem.js'

const isTauri = () => typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__

export function useFileOpen() {
  const fileStore = useFileStore()
  let unlistenOpenFile = null

  async function openPaths(paths) {
    for (const path of paths) {
      try {
        const content = await readFile(path)
        await fileStore.openFile(path, content)
      } catch {
        // skip files that can't be read
      }
    }
  }

  async function setup() {
    if (!isTauri()) return

    const { invoke } = await import('@tauri-apps/api/core')
    const { getCurrentWindow } = await import('@tauri-apps/api/window')

    const pending = await invoke('take_pending_files')
    if (pending.length) await openPaths(pending)

    unlistenOpenFile = await getCurrentWindow().listen('shoulders://open-file', (event) => {
      const paths = Array.isArray(event.payload) ? event.payload : [event.payload]
      openPaths(paths)
    })
  }

  setup()

  onUnmounted(() => {
    if (unlistenOpenFile) unlistenOpenFile()
  })
}
