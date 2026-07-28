export function basename(path) {
  return String(path || '').replace(/[/\\]$/, '').split(/[/\\]/).filter(Boolean).pop() || ''
}

export function dirname(path) {
  const parts = String(path).split(/[/\\]/)
  parts.pop()
  const dir = parts.join('/')
  if (!dir) return 'Local file'
  const home =
    typeof window !== 'undefined' && window.__MIMIR_HOME__
      ? window.__MIMIR_HOME__
      : ''
  return home && dir.startsWith(home) ? `~${dir.slice(home.length)}` : dir
}

export function parentPath(path) {
  const value = String(path || '')
  if (!value) return null
  const slash = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'))
  if (slash < 0) return null
  if (slash === 0) return value[0]
  // Preserve a Windows drive root (`C:\file.md` → `C:\`).
  if (slash === 2 && /^[A-Za-z]:[\\/]$/.test(value.slice(0, 3))) {
    return value.slice(0, 3)
  }
  return value.slice(0, slash)
}
