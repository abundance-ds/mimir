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
