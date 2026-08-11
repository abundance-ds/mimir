import { getVersion } from '@tauri-apps/api/app'
import { relaunch } from '@tauri-apps/plugin-process'
import { check } from '@tauri-apps/plugin-updater'
import packageMetadata from '../../package.json'
import { isTauriRuntime } from '../shared/platform.js'

export function appUpdatesSupported() {
  return isTauriRuntime() && !import.meta.env.DEV
}

export async function installedAppVersion() {
  if (!isTauriRuntime()) return packageMetadata.version
  try {
    return await getVersion()
  } catch {
    return packageMetadata.version
  }
}

export async function checkForAppUpdate() {
  return check()
}

export async function downloadAndInstallAppUpdate(update, onEvent) {
  if (!update) throw new Error('No update is available to install.')
  await update.downloadAndInstall(onEvent)
}

export async function relaunchUpdatedApp() {
  await relaunch()
}
