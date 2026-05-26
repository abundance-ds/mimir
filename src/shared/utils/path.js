export function basename(path) {
  return String(path || '').replace(/[/\\]$/, '').split(/[/\\]/).filter(Boolean).pop() || ''
}

export function dirname(path) {
  const parts = String(path).split(/[/\\]/)
  parts.pop()
  const dir = parts.join('/')
  if (!dir) return 'Local file'
  const home =
    typeof window !== 'undefined' && window.__SHOULDERS_HOME__
      ? window.__SHOULDERS_HOME__
      : ''
  return home && dir.startsWith(home) ? `~${dir.slice(home.length)}` : dir
}
