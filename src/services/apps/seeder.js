import { invoke } from '@tauri-apps/api/core'
import { getDataDir } from '../dataDir'

async function exists(path) {
  return invoke('path_exists', { path })
}

function parseVersion(v) {
  if (!v) return [0, 0, 0]
  return v.split('.').map(Number).concat([0, 0, 0]).slice(0, 3)
}

function isNewer(bundled, installed) {
  const b = parseVersion(bundled)
  const i = parseVersion(installed)
  for (let k = 0; k < 3; k++) {
    if (b[k] > i[k]) return true
    if (b[k] < i[k]) return false
  }
  return false
}

export async function seedAppFromResource({ id, manifest, files }) {
  const dataDir = await getDataDir()
  const appDir = `${dataDir}/apps/${id}`
  const appsRoot = `${dataDir}/apps`

  let bundledVersion = null
  try { bundledVersion = JSON.parse(manifest).version || null } catch {}

  if (await exists(appDir)) {
    if (!bundledVersion) return
    const manifestPath = `${appDir}/manifest.json`
    try {
      const { content } = await invoke('read_text_file', { path: manifestPath })
      const installedVersion = JSON.parse(content).version || null
      if (!isNewer(bundledVersion, installedVersion)) return
    } catch {}
  }

  await invoke('create_dir', { path: appsRoot })
  await invoke('create_dir', { path: appDir })
  await invoke('write_text_file', {
    path: `${appDir}/manifest.json`,
    content: manifest,
  })
  for (const file of files) {
    const filePath = `${appDir}/${file.path}`
    const dir = filePath.substring(0, filePath.lastIndexOf('/'))
    if (dir !== appDir) await invoke('create_dir', { path: dir })
    await invoke('write_text_file', { path: filePath, content: file.content })
  }
}
