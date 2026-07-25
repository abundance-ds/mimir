import { invoke } from '@tauri-apps/api/core'

let _dataDir = null

export async function getDataDir() {
  if (_dataDir) return _dataDir
  _dataDir = await invoke('ai_config_dir')
  return _dataDir
}

async function readJson(path) {
  const { content } = await invoke('read_text_file', { path })
  return JSON.parse(content)
}

async function writeJson(path, data) {
  await invoke('write_text_file', { path, content: JSON.stringify(data, null, 2) })
}

async function exists(path) {
  return invoke('path_exists', { path })
}

async function ensureDir(path) {
  return invoke('create_dir', { path })
}

async function listDir(path) {
  if (!await exists(path)) return []
  return invoke('list_dir', { path })
}

async function remove(path) {
  return invoke('delete_path', { path })
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

async function projectsDir() {
  return `${await getDataDir()}/projects`
}

export async function projectDir(projectId) {
  return `${await projectsDir()}/${projectId}`
}

export async function ensureProject(projectId) {
  const dir = await projectDir(projectId)
  await ensureDir(`${dir}/sessions`)
  return dir
}

export async function saveProjectMeta(project) {
  const dir = await ensureProject(project.id)
  await writeJson(`${dir}/meta.json`, {
    id: project.id,
    name: project.name,
    workspacePath: project.workspacePath || null,
    path: project.path || '',
    system: project.system || false,
    createdAt: project.createdAt,
  })
}

export async function listProjects() {
  const dir = await projectsDir()
  const entries = await listDir(dir)
  const projects = []
  for (const entry of entries) {
    if (!entry.is_dir) continue
    try {
      const meta = await readJson(`${entry.path}/meta.json`)
      projects.push(meta)
    } catch { /* skip dirs without meta */ }
  }
  return projects
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export async function saveSession(projectId, session) {
  const dir = await ensureProject(projectId)
  await writeJson(`${dir}/sessions/${session.id}.json`, session)
}

export async function loadSession(projectId, sessionId) {
  const dir = await projectDir(projectId)
  return readJson(`${dir}/sessions/${sessionId}.json`)
}

export async function listSessionMetas(projectId) {
  const dir = await projectDir(projectId)
  const sessionsDir = `${dir}/sessions`
  const entries = await listDir(sessionsDir)
  const metas = []
  for (const entry of entries) {
    if (entry.is_dir || !entry.name.endsWith('.json')) continue
    try {
      const data = await readJson(entry.path)
      metas.push({
        id: data.id,
        projectId: data.projectId || projectId,
        label: data.label || 'Untitled',
        modelId: data.modelId,
        updatedAt: data.updatedAt || data.createdAt,
        messageCount: data.messages?.length || 0,
        archived: data.archived || false,
      })
    } catch { /* skip malformed files */ }
  }
  metas.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
  return metas
}

export async function deleteSession(projectId, sessionId) {
  const dir = await projectDir(projectId)
  return remove(`${dir}/sessions/${sessionId}.json`)
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function loadSettings() {
  const path = `${await getDataDir()}/settings.json`
  if (!await exists(path)) return {}
  try { return await readJson(path) } catch { return {} }
}

export async function saveSettings(settings) {
  const path = `${await getDataDir()}/settings.json`
  await writeJson(path, settings)
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

export async function bootstrapDataDir() {
  const dir = await getDataDir()
  await ensureDir(`${dir}/projects`)

  const generalDir = `${dir}/projects/general`
  if (!await exists(`${generalDir}/meta.json`)) {
    await ensureDir(`${generalDir}/sessions`)
    await writeJson(`${generalDir}/meta.json`, {
      id: 'general',
      name: 'Personal',
      path: 'Panel-wide chats',
      system: true,
      createdAt: new Date().toISOString(),
    })
  }

  return dir
}

// ---------------------------------------------------------------------------
// Shoulder markers (.mim.json)
// ---------------------------------------------------------------------------

export async function writeShoulderMarker(folderPath, data) {
  await writeJson(`${folderPath}/.mim.json`, data)
}

export async function readShoulderMarker(folderPath) {
  const markerPath = `${folderPath}/.mim.json`
  if (!await exists(markerPath)) return null
  try { return await readJson(markerPath) } catch { return null }
}

export async function deleteShoulderMarker(folderPath) {
  const markerPath = `${folderPath}/.mim.json`
  if (await exists(markerPath)) await remove(markerPath)
}

export async function deleteProjectDir(projectId) {
  const dir = await projectDir(projectId)
  await remove(dir)
}

// ---------------------------------------------------------------------------
// Project file indexing
// ---------------------------------------------------------------------------

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.output', 'dist', 'build', '.next', '.nuxt',
  '__pycache__', '.venv', 'venv', 'target', '.turbo', '.cache',
])
const IGNORE_FILES = new Set(['.DS_Store', '.mim.json', 'Thumbs.db'])
const IGNORE_EXTS = new Set(['.pyc'])

export async function indexProjectFiles(folderPath, maxFiles = 500) {
  const files = []
  async function walk(dir, prefix) {
    if (files.length >= maxFiles) return
    const entries = await listDir(dir)
    for (const entry of entries) {
      if (files.length >= maxFiles) break
      if (IGNORE_FILES.has(entry.name)) continue
      if (entry.is_dir) {
        if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
        await walk(entry.path, prefix ? `${prefix}/${entry.name}` : entry.name)
      } else {
        const ext = entry.name.includes('.') ? '.' + entry.name.split('.').pop() : ''
        if (IGNORE_EXTS.has(ext)) continue
        files.push(prefix ? `${prefix}/${entry.name}` : entry.name)
      }
    }
  }
  await walk(folderPath, '')
  return files.sort()
}
