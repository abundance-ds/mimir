import { invoke } from '@tauri-apps/api/core'
import { open, save } from '@tauri-apps/plugin-dialog'
import { fallbackOpenEntry } from '../shared/utils/filePreview.js'
import { inspectWorkspaceEntry } from './workspaceFileOperations.js'

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

export async function openFileDialog(defaultPath) {
  if (!isTauri()) return null
  const selected = await open({
    multiple: false,
    ...(defaultPath ? { defaultPath } : {}),
    filters: [
      { name: 'Code and Text', extensions: CODE_TEXT_EXTENSIONS },
      { name: 'Images and PDF', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg', 'pdf'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  })
  if (!selected) return null
  const path = typeof selected === 'string' ? selected : selected.path
  let meta
  try { meta = await inspectWorkspaceEntry(path) } catch { /* Outside the workspace. */ }
  meta ||= fallbackOpenEntry(path)
  const kind = meta.openBehavior
  const content = kind === 'text' ? await readFile(path) : ''
  return { path, content, kind, meta }
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

export async function openHtmlInBrowser(path) {
  if (!isTauri()) {
    throw new Error('Open in browser is available in the desktop app.')
  }
  return invoke('open_html_in_browser', { path })
}

export async function readBinaryFile(path, { maxBytes } = {}) {
  if (!isTauri()) return new Uint8Array()
  const result = await invoke('read_binary_file', { path, ...(maxBytes == null ? {} : { maxBytes }) })
  if (result instanceof ArrayBuffer) return new Uint8Array(result)
  if (ArrayBuffer.isView(result)) {
    return new Uint8Array(result.buffer, result.byteOffset, result.byteLength)
  }
  if (Array.isArray(result)) return Uint8Array.from(result)
  if (typeof result === 'string') return decodeBase64(result)
  throw new Error(`Could not read binary data from ${path}.`)
}

function decodeBase64(value) {
  const decoded = atob(value)
  const bytes = new Uint8Array(decoded.length)
  for (let index = 0; index < decoded.length; index++) bytes[index] = decoded.charCodeAt(index)
  return bytes
}

export function openPreviewInDefaultApp(path) {
  return invoke('open_preview_in_default_app', { path })
}
