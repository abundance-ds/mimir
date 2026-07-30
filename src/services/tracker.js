import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

export const TRACKER_CHANGED_EVENT = 'mimir://tracker-changed'
export const TRACKER_OPEN_EVENT = 'mimir://tracker-open'

export function trackerStatus() {
  return invoke('tracker_status')
}

export function updateTrackerConfig(config) {
  return invoke('tracker_config_update', { config })
}

export function setTrackerEnabled(enabled) {
  return invoke('tracker_set_enabled', { enabled })
}

export function setTrackerArmed(armed) {
  return invoke('tracker_set_armed', { armed })
}

export function startTrackerBreak(minutes) {
  return invoke('tracker_start_break', { minutes })
}

export function endTrackerBreak() {
  return invoke('tracker_end_break')
}

export function trackerReport({ startMs, endMs, timezone = null }) {
  return invoke('tracker_report', { startMs, endMs, timezone })
}

export function trackerQuery(query) {
  return invoke('tracker_query', { query })
}

export function trackerClassifications() {
  return invoke('tracker_classifications')
}

export function updateTrackerClassification(update) {
  return invoke('tracker_classification_update', { update })
}

export function previewArgusImport(request = {}) {
  return invoke('tracker_import_preview', { request: normalizeImportRequest(request) })
}

export function importArgus(request = {}) {
  return invoke('tracker_import_argus', { request: normalizeImportRequest(request) })
}

export function requestTrackerAccessibility() {
  return invoke('tracker_accessibility_request')
}

export function updateTrackerContext(context = null) {
  return invoke('tracker_context_update', { context })
}

export function listenToTrackerChanges(callback) {
  return listen(TRACKER_CHANGED_EVENT, event => callback(event.payload))
}

export function listenToTrackerOpen(callback) {
  return listen(TRACKER_OPEN_EVENT, () => callback())
}

function normalizeImportRequest(request) {
  return {
    sourceDirectory: request.sourceDirectory || null,
    timezone: request.timezone || null,
  }
}
