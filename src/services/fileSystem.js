import { invoke } from '@tauri-apps/api/core'
import { open, save } from '@tauri-apps/plugin-dialog'

const isTauri = () => !!window.__TAURI_INTERNALS__

const CODE_TEXT_EXTENSIONS = [
  'md', 'markdown', 'txt',
  'js', 'jsx', 'mjs', 'cjs',
  'ts', 'tsx', 'mts', 'cts',
  'json', 'jsonc',
  'css', 'html', 'htm',
  'py', 'r', 'R', 'rs',
  'sql', 'yaml', 'yml', 'xml', 'svg',
  'sh', 'bash', 'zsh', 'fish',
  'toml', 'dockerfile',
  'bib',
]

// --- File dialogs ---

export async function openFileDialog() {
  if (!isTauri()) return null
  const selected = await open({
    multiple: false,
    filters: [
      { name: 'Code and Text', extensions: CODE_TEXT_EXTENSIONS },
      { name: 'All Files', extensions: ['*'] },
    ],
  })
  if (!selected) return null
  const path = typeof selected === 'string' ? selected : selected.path
  const result = await invoke('read_text_file', { path })
  return { path: result.path, content: result.content }
}

export async function openMultipleFilesDialog() {
  if (!isTauri()) return []
  const selected = await open({
    multiple: true,
    filters: [
      { name: 'Code and Text', extensions: CODE_TEXT_EXTENSIONS },
      { name: 'All Files', extensions: ['*'] },
    ],
  })
  if (!selected) return []
  const paths = Array.isArray(selected)
    ? selected.map((s) => (typeof s === 'string' ? s : s.path))
    : [typeof selected === 'string' ? selected : selected.path]
  const results = await Promise.all(
    paths.map((path) => invoke('read_text_file', { path }))
  )
  return results.map((r) => ({ path: r.path, content: r.content }))
}

export async function saveFileDialog(defaultPath) {
  if (!isTauri()) return null
  const path = await save({
    defaultPath,
    filters: [
      { name: 'Code and Text', extensions: CODE_TEXT_EXTENSIONS },
      { name: 'All Files', extensions: ['*'] },
    ],
  })
  return path || null
}

export async function saveExportDialog(defaultPath, filters) {
  if (!isTauri()) return null
  const path = await save({ defaultPath, filters })
  return path || null
}

export async function writeBinaryFile(path, base64Data) {
  if (!isTauri()) return
  await invoke('write_binary_file', { path, dataBase64: base64Data })
}

// --- File I/O ---

export async function saveFile(path, content) {
  if (!isTauri()) {
    console.log('[fileSystem] saveFile (no Tauri):', path)
    return
  }
  await invoke('write_text_file', { path, content })
}

export async function readFile(path) {
  if (!isTauri()) return ''
  const result = await invoke('read_text_file', { path })
  return result.content
}

export async function pathExists(path) {
  if (!isTauri()) return false
  return invoke('path_exists', { path })
}
