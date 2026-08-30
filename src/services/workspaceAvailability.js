import { invoke } from '@tauri-apps/api/core'

export function workspacePathStatuses(paths) {
  const unique = []
  const seen = new Set()
  for (const candidate of Array.isArray(paths) ? paths : []) {
    const path = String(candidate || '').trim()
    if (!path || seen.has(path)) continue
    seen.add(path)
    unique.push(path)
  }
  if (!unique.length) return Promise.resolve([])
  return invoke('workspace_paths_status', { paths: unique })
}
