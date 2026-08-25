import { invoke } from '@tauri-apps/api/core'

export const WORKSPACE_GRAPH_SCOPES = Object.freeze(['team', 'workspace'])
const workspaceConfigCache = new Map()

export async function loadWorkspaceConfig(workspace) {
  const path = requiredWorkspace(workspace)
  const config = await invoke('workspace_config_load', { workspace: path })
  workspaceConfigCache.set(path, config || null)
  return config
}

export async function saveWorkspaceConfig(workspace, config = {}) {
  const path = requiredWorkspace(workspace)
  const saved = await invoke('workspace_config_save', {
    workspace: path,
    config: normalizeWorkspaceConfig(config),
  })
  workspaceConfigCache.set(path, saved)
  return saved
}

export function cachedWorkspaceConfig(workspace) {
  return workspaceConfigCache.get(String(workspace || '').trim()) || null
}

export function projectWorkspacePaths(projectId) {
  const value = String(projectId || '').trim()
  if (!value) return Promise.resolve([])
  return invoke('workspace_project_paths', { projectId: value })
}

// Resolves a graph-authored relative file path: Project-linked local
// workspaces first, the open workspace as fallback. Returns an absolute path
// or null when no candidate root contains the file.
export function resolveProjectFile({ projectId = '', relativePath = '', fallbackWorkspace = '' } = {}) {
  const value = String(relativePath || '').trim()
  if (!value) return Promise.resolve(null)
  return invoke('workspace_project_file_resolve', {
    projectId: String(projectId || '').trim() || null,
    relativePath: value,
    fallbackWorkspace: String(fallbackWorkspace || '').trim() || null,
  })
}

export function normalizeWorkspaceConfig(config = {}) {
  const graphScope = WORKSPACE_GRAPH_SCOPES.includes(config.graphScope)
    ? config.graphScope
    : 'team'
  const id = String(config.id || '').trim()
  const project = String(config.project || config.projectId || '').trim()
  return {
    ...(id ? { id } : {}),
    ...(project ? { project } : {}),
    graphScope,
  }
}

function requiredWorkspace(value) {
  const workspace = String(value || '').trim()
  if (!workspace) throw new Error('Workspace path is required.')
  return workspace
}
