import { normalizePath } from './files/filePaths.js'

const LEGACY_WORKSPACE_KINDS = new Set(['agent', 'terminal', 'routine'])

/**
 * Returns the project path an Activity belongs to, or an empty string for a
 * global Activity. ActivityRecord.workspacePath predates project-scoped rows
 * and can also be a home/custom cwd, so launcher policy disambiguates it.
 */
export function activityWorkspacePath(activity, findPreset = () => null) {
  const path = normalizedWorkspacePath(activity?.workspacePath)
  const recordedScope = activity?.source?.workspaceScope
  if (recordedScope === 'workspace') return path
  if (recordedScope === 'global') return ''
  if (!path) return ''

  const presetId = activity?.source?.presetId || activity?.source?.launcherId
  const mode = presetId ? findPreset(presetId)?.cwd?.mode : ''
  if (mode === 'workspace') return path
  if (mode === 'home' || mode === 'custom') return ''

  // Direct process Apps are not necessarily rooted in the open project.
  if (activity?.source?.appId) return ''

  // Older launcher-backed records did not retain cwd mode. Their documented
  // workspacePath remains the least surprising grouping fallback.
  return LEGACY_WORKSPACE_KINDS.has(activity?.kind) ? path : ''
}

export function activityIsVisibleInWorkspace(activity, workspacePath, findPreset) {
  const activityPath = activityWorkspacePath(activity, findPreset)
  return !activityPath || activityPath === normalizedWorkspacePath(workspacePath)
}

export function normalizedWorkspacePath(value) {
  return normalizePath(String(value || '').trim())
}
