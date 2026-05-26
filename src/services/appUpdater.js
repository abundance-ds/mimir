import { check } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'

export async function checkForUpdate() {
  try {
    const update = await check()
    if (update?.available) {
      return {
        version: update.version,
        body: update.body,
        date: update.date,
        download: async () => {
          await update.downloadAndInstall()
          await relaunch()
        },
      }
    }
    return null
  } catch (err) {
    console.warn('[updater] Check failed:', err)
    return null
  }
}
