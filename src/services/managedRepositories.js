import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

export function teamRepositoryStatus() {
  return invoke('team_repository_status')
}

export function setupTeamRepository({ remoteUrl = '', teamName = '' } = {}) {
  const url = String(remoteUrl || '').trim()
  if (!url) throw new Error('GitHub repository URL is required.')
  return invoke('team_repository_setup', {
    remoteUrl: url,
    teamName: String(teamName || '').trim() || null,
  })
}

export function moveTeamRepository(remoteUrl) {
  const url = String(remoteUrl || '').trim()
  if (!url) throw new Error('GitHub repository URL is required.')
  return invoke('team_repository_move', { remoteUrl: url })
}

export function syncTeamRepository() {
  return invoke('team_repository_sync')
}

export function githubConnectionStatus() {
  return invoke('github_connection_status')
}

export function connectGithub() {
  return invoke('github_connect')
}

export function disconnectGithub() {
  return invoke('github_disconnect')
}

export function managedProjectStatus(workspace) {
  return invoke('managed_project_status', { workspace: requiredPath(workspace) })
}

export function setManagedProjectEnabled(workspace, enabled, { initialize = false } = {}) {
  return invoke('managed_project_set_enabled', {
    workspace: requiredPath(workspace),
    enabled: Boolean(enabled),
    initialize: Boolean(initialize),
  })
}

export function setManagedProjectRemote(workspace, remoteUrl) {
  return invoke('managed_project_set_remote', {
    workspace: requiredPath(workspace),
    remoteUrl: String(remoteUrl || '').trim(),
  })
}

export function syncManagedProject(workspace) {
  return invoke('managed_project_sync', { workspace: requiredPath(workspace) })
}

export function syncManagedRepositories() {
  return invoke('managed_repositories_sync')
}

export function installManagedSyncLifecycle({ onError = null } = {}) {
  if (typeof window === 'undefined' || !window.__TAURI_INTERNALS__) return () => {}
  let running = false
  let disposed = false
  let stopErrorListener = () => {}
  const sync = async () => {
    if (running) return
    running = true
    try { await syncManagedRepositories() } catch { /* the native runtime reports actionable errors */ }
    finally { running = false }
  }
  void listen('mimir://managed-git-error', ({ payload }) => {
    const message = String(payload?.message || '').trim()
    if (message && typeof onError === 'function') onError(message, payload)
  }).then((stop) => {
    if (disposed) stop()
    else {
      stopErrorListener = stop
      void sync()
    }
  }).catch(() => {})
  const activated = () => {
    if (!document.hidden) void sync()
  }
  window.addEventListener('focus', activated)
  window.addEventListener('online', sync)
  document.addEventListener('visibilitychange', activated)
  return () => {
    disposed = true
    stopErrorListener()
    window.removeEventListener('focus', activated)
    window.removeEventListener('online', sync)
    document.removeEventListener('visibilitychange', activated)
  }
}

function requiredPath(value) {
  const path = String(value || '').trim()
  if (!path) throw new Error('Workspace path is required.')
  return path
}
