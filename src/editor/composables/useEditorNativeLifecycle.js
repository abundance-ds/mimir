import { watch } from 'vue'
import { completeNativeQuit } from '../appQuit.js'
import {
  installNativeEditorMenu,
  shouldInstallNativeEditorMenu,
} from '../nativeMenu.js'
import { isTauriRuntime } from '../../shared/platform.js'

export function useEditorNativeLifecycle({
  fileManager,
  editorSettings,
  windowCloseGuard,
  getActions,
  onError,
}) {
  let menuTimer = null
  let unlistenFocus = null
  let unlistenQuitRequested = null
  let disposed = false

  const stopRecentWatch = watch(
    () => fileManager.recentFiles.slice(),
    scheduleMenuSync,
  )

  async function start() {
    disposed = false
    await syncMenu()
    if (disposed) return
    await bindMenuFocusSync()
    if (disposed) return
    await bindQuitGuard()
  }

  async function syncMenu() {
    await installNativeEditorMenu({
      recentFiles: fileManager.recentFiles,
      actions: getActions(),
    })
  }

  function scheduleMenuSync() {
    if (!shouldInstallNativeEditorMenu() || disposed) return
    clearTimeout(menuTimer)
    menuTimer = setTimeout(() => {
      syncMenu().catch(error => {
        console.error('[nativeMenu] sync failed', error)
      })
    }, 80)
  }

  async function bindMenuFocusSync() {
    if (!shouldInstallNativeEditorMenu()) return
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      const stop = await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
        if (focused) void syncMenu()
      })
      if (disposed) stop()
      else unlistenFocus = stop
    } catch (error) {
      console.error('[nativeMenu] focus binding failed', error)
    }
  }

  async function requestAppQuit() {
    if (!isTauriRuntime()) return requestEditorWindowClose()
    return completeNativeQuit({
      requestClose: options => windowCloseGuard.requestClose(options),
      flushSettings: () => editorSettings.flush(),
      confirmQuit: async () => {
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke('app_quit_confirmed')
      },
    })
  }

  async function requestEditorWindowClose() {
    const guarded = await windowCloseGuard.requestClose()
    if (guarded !== null) return guarded
    window.close()
    return true
  }

  async function bindQuitGuard() {
    if (!isTauriRuntime()) return
    try {
      const { listen } = await import('@tauri-apps/api/event')
      const stop = await listen('mimir://quit-requested', () => {
        void requestAppQuit().catch(onError)
      })
      if (disposed) stop()
      else unlistenQuitRequested = stop
    } catch (error) {
      onError(error)
    }
  }

  function dispose() {
    disposed = true
    stopRecentWatch()
    clearTimeout(menuTimer)
    unlistenFocus?.()
    unlistenFocus = null
    unlistenQuitRequested?.()
    unlistenQuitRequested = null
  }

  return {
    dispose,
    requestAppQuit,
    scheduleMenuSync,
    start,
    syncMenu,
  }
}
