import { invoke } from '@tauri-apps/api/core'

export function listWorkspaceDirectory(directory = '') {
  return invoke('workspace_file_list_directory', { directory })
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

export function duplicateWorkspaceEntry(path) {
  return invoke('workspace_file_duplicate', { path })
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
