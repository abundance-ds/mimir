import { invoke } from '@tauri-apps/api/core'

export function listWorkspaceDirectory(directory = '') {
  return invoke('workspace_file_list_directory', { directory })
}

export function inspectWorkspaceEntry(path) {
  return invoke('workspace_file_inspect', { path })
}

export function createWorkspaceFile(relativePath) {
  return invoke('workspace_file_create', { relativePath, directory: false })
}

export function createWorkspaceFolder(relativePath) {
  return invoke('workspace_file_create', { relativePath, directory: true })
}

export function renameWorkspaceEntry(path, newName) {
  return invoke('workspace_file_rename', { path, newName })
}

// Move an existing entry into `destination` ('' = workspace root), keeping
// its name. Resolves to the moved WorkspaceEntry.
export function moveWorkspaceEntry(path, destination) {
  return invoke('workspace_file_move', { path, destination })
}

export function duplicateWorkspaceEntry(path) {
  return invoke('workspace_file_duplicate', { path })
}

// Copy files/folders dropped from outside into `destination` ('' = workspace
// root). Resolves to { entries, skippedLinks }.
export function importWorkspaceEntries(destination, sources) {
  return invoke('workspace_file_import', { destination, sources })
}

export function trashWorkspaceEntries(paths) {
  return invoke('workspace_file_trash', { paths })
}

export function openWorkspaceEntryNative(path) {
  return invoke('workspace_file_open_native', { path })
}

export function revealWorkspaceEntry(path) {
  return invoke('workspace_file_reveal', { path })
}
