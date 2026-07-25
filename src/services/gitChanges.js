import { invoke } from '@tauri-apps/api/core'

const STATUSES = new Set(['new', 'modified', 'deleted', 'renamed'])

export async function loadGitChanges(workspacePath) {
  const path = String(workspacePath || '').trim()
  if (!path) throw new Error('Open a workspace to inspect Git changes.')
  return normalizeGitChanges(await invoke('git_status', { path }))
}

export function normalizeGitChanges(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      path: String(entry.path || '').replace(/^\.\//, ''),
      status: String(entry.status || '').toLowerCase(),
    }))
    .filter((entry) => entry.path && STATUSES.has(entry.status))
    .sort((left, right) => (
      left.path.localeCompare(right.path, undefined, { numeric: true, sensitivity: 'base' })
      || left.status.localeCompare(right.status)
    ))
}

export function absoluteWorkspacePath(workspacePath, relativePath) {
  const relative = String(relativePath || '')
  if (/^(?:\/|[a-z]:[\\/])/i.test(relative)) return relative
  const workspace = String(workspacePath || '')
  const separator = workspace.includes('\\') && !workspace.includes('/') ? '\\' : '/'
  return `${workspace.replace(/[\\/]+$/, '')}${separator}${relative.replace(/^[\\/]+/, '')}`
}
