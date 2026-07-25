import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

const encoder = new TextEncoder()

export function listActivities() {
  return invoke('activity_list')
}

export function resolveLauncher(preset, workspacePath) {
  return invoke('launcher_resolve', {
    preset,
    workspacePath: workspacePath || null,
  })
}

export function spawnActivity(record, { cols = 100, rows = 30 } = {}) {
  return invoke('activity_spawn', { record, cols, rows })
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
