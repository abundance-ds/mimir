export function normalizePath(value) {
  return String(value || '').replaceAll('\\', '/').replace(/\/+/g, '/').replace(/\/$/, '')
}

export function normalizeRelative(value) {
  return normalizePath(value).replace(/^\/+/, '')
}

export function parentDirectory(path) {
  const parts = normalizeRelative(path).split('/').filter(Boolean)
  parts.pop()
  return parts.join('/')
}

export function joinRelative(parent, name) {
  const directory = normalizeRelative(parent)
  return directory ? `${directory}/${name}` : name
}

export function inferOpenBehavior(path) {
  const extension = String(path || '').split('.').at(-1)?.toLowerCase()
  if (extension === 'pdf') return 'pdf'
  if (BINARY_EXTENSIONS.has(extension)) return 'external'
  return 'text'
}

export function describeFileError(error, fallback) {
  const message = error instanceof Error ? error.message : String(error || '')
  return message ? `${fallback}: ${message}` : fallback
}

export function cssEscape(value) {
  return typeof CSS !== 'undefined' && CSS.escape
    ? CSS.escape(String(value || ''))
    : String(value || '').replaceAll('"', '\\"')
}

const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'zip', 'gz', 'mp3', 'mp4',
])
