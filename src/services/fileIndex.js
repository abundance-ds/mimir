import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

function desktopOnly() {
  if (!window.__TAURI_INTERNALS__) {
    throw new Error('Workspace indexing is available in the desktop app.')
  }
}

export async function openWorkspaceIndex(workspace) {
  desktopOnly()
  return invoke('file_index_open', { workspace })
}

export async function listIndexedFiles() {
  desktopOnly()
  return invoke('file_index_files')
}

export async function filterIndexedFiles(query, maxResults = 250) {
  desktopOnly()
  return invoke('file_index_filter', { query, maxResults })
}

export async function refreshWorkspaceIndex() {
  desktopOnly()
  return invoke('file_index_refresh')
}

export async function beginContentSearch() {
  desktopOnly()
  return invoke('file_index_begin_search')
}

export async function cancelContentSearch(token) {
  if (!window.__TAURI_INTERNALS__ || !token) return false
  return invoke('file_index_cancel_search', { token })
}

export async function searchIndexedContent(token, request) {
  desktopOnly()
  return invoke('file_index_search', { token, request })
}

export function listenForWorkspaceFileChanges(callback) {
  return listen('mimir://workspace-files-changed', (event) => callback(event.payload))
}
