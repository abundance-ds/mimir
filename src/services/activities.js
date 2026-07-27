import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

const encoder = new TextEncoder()

export function listActivities() {
  return invoke('activity_list')
}

export function searchActivityHistory(query, limit = 30) {
  return invoke('activity_search_history', { query, limit })
}

export function resolveLauncher(preset, workspacePath) {
  return invoke('launcher_resolve', {
    preset,
    workspacePath: workspacePath || null,
  })
}

// The shell prints its first prompt before the terminal surface mounts and
// reports its fitted size. zsh pads its partial-line mark to the PTY width, so
// a spawn wider than the eventual pane leaves a stray wrapped "%" line in
// scrollback. Spawning at (or under) the last fitted size keeps that padding
// on the prompt line, and the first fit corrects any undershoot invisibly.
let fittedSize = null

export function spawnActivity(record, size = {}) {
  return invoke('activity_spawn', { record, ...spawnSize(size) })
}

export function respawnActivity(record, size = {}) {
  return invoke('activity_respawn', { record, ...spawnSize(size) })
}

function spawnSize({ cols, rows } = {}) {
  if (cols > 0 && rows > 0) return { cols, rows }
  return fittedSize || { cols: 64, rows: 20 }
}

export function activitySnapshot(activityId, afterSequence = null) {
  return invoke('activity_snapshot', { activityId, afterSequence })
}

export function writeActivity(activityId, value) {
  const bytes = typeof value === 'string'
    ? Array.from(encoder.encode(value))
    : Array.from(value || [])
  return invoke('activity_write', { activityId, bytes })
}

export function resizeActivity(activityId, cols, rows) {
  if (cols > 0 && rows > 0) fittedSize = { cols, rows }
  return invoke('activity_resize', { activityId, cols, rows })
}

export function stopActivity(activityId) {
  return invoke('activity_stop', { activityId })
}

export function renameActivity(activityId, title) {
  return invoke('activity_rename', { activityId, title })
}

export function setActivityArchived(activityId, archived) {
  return invoke('activity_set_archived', { activityId, archived })
}

export function clearActivity(activityId) {
  return invoke('activity_clear', { activityId })
}

export function listenToActivityEvents(callback) {
  return listen('mim://activity-event', (event) => callback(event.payload))
}
