import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

export const ROUTINES_CHANGED_EVENT = 'mimir://routines-changed'

export async function loadRoutineCatalog() {
  return normalizeRoutineCatalog(await invoke('routine_catalog'))
}

export async function reloadRoutineCatalog() {
  return normalizeRoutineCatalog(await invoke('routine_reload'))
}

export async function runRoutineNow(routineId) {
  const id = String(routineId || '').trim()
  if (!id) throw new Error('Choose a routine before running it.')
  return normalizeRunResult(await invoke('routine_run_now', { routineId: id }))
}

export async function createRoutineDefinition(definition) {
  return normalizeRoutineCatalog(await invoke('routine_create', {
    definition: serializeDefinition(definition),
  }))
}

export async function updateRoutineDefinition(routineId, expectedRevision, definition) {
  const id = requiredId(routineId)
  return normalizeRoutineCatalog(await invoke('routine_update', {
    routineId: id,
    expectedRevision: requiredRevision(expectedRevision),
    definition: serializeDefinition({ ...definition, id }),
  }))
}

export async function duplicateRoutineDefinition(routineId, expectedRevision, newId, title) {
  const normalizedTitle = title == null ? null : String(title).trim() || null
  return normalizeRoutineCatalog(await invoke('routine_duplicate', {
    routineId: requiredId(routineId),
    expectedRevision: requiredRevision(expectedRevision),
    newId: requiredId(newId),
    title: normalizedTitle,
  }))
}

export async function trashRoutineDefinition(routineId, expectedRevision) {
  return normalizeRoutineCatalog(await invoke('routine_trash', {
    routineId: requiredId(routineId),
    expectedRevision: requiredRevision(expectedRevision),
  }))
}

export function revealRoutineDefinition(routineId = null) {
  const normalized = routineId == null ? null : requiredId(routineId)
  return invoke('routine_reveal', { routineId: normalized })
}

export async function listenToRoutineEvents(onEvent) {
  if (typeof onEvent !== 'function') throw new Error('A routine event handler is required.')
  return listen(ROUTINES_CHANGED_EVENT, (event) => {
    onEvent(normalizeRoutineChangedEvent(event?.payload))
  })
}

export function normalizeRoutineCatalog(value) {
  const catalog = isPlainObject(value) ? value : {}
  return {
    directory: String(catalog.directory || ''),
    statePath: String(catalog.statePath || catalog.state_path || ''),
    revision: finiteNumber(catalog.revision),
    routines: (Array.isArray(catalog.routines) ? catalog.routines : [])
      .filter(isPlainObject)
      .map(normalizeRoutine)
      .sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id)),
    diagnostics: (Array.isArray(catalog.diagnostics) ? catalog.diagnostics : [])
      .filter(isPlainObject)
      .map(normalizeDiagnostic),
    lastTick: catalog.lastTick || catalog.last_tick
      ? normalizeTick(catalog.lastTick || catalog.last_tick)
      : null,
  }
}

export function normalizeRoutineChangedEvent(value) {
  const event = isPlainObject(value) ? value : {}
  return {
    catalog: normalizeRoutineCatalog(event.catalog),
    tick: event.tick ? normalizeTick(event.tick) : null,
  }
}

function normalizeRoutine(value) {
  const routine = isPlainObject(value) ? value : {}
  return {
    id: String(routine.id || ''),
    title: String(routine.title || routine.id || 'Untitled routine'),
    enabled: routine.enabled !== false,
    schedule: optionalString(routine.schedule),
    timezone: String(routine.timezone || 'local'),
    preset: String(routine.preset || ''),
    prompt: String(routine.prompt || ''),
    overlap: String(routine.overlap || 'skip'),
    missed: String(routine.missed || 'run-once'),
    workspace: routine.workspace == null ? null : String(routine.workspace),
    path: String(routine.path || ''),
    sourceRevision: String(routine.sourceRevision || routine.source_revision || ''),
    available: routine.available !== false,
    nextFire: optionalString(routine.nextFire ?? routine.next_fire),
    diagnostic: optionalString(routine.diagnostic),
    runningActivityIds: (
      Array.isArray(routine.runningActivityIds)
        ? routine.runningActivityIds
        : Array.isArray(routine.running_activity_ids)
          ? routine.running_activity_ids
          : []
    ).map(String),
    lastError: optionalString(routine.lastError ?? routine.last_error),
  }
}

function serializeDefinition(value) {
  const definition = isPlainObject(value) ? value : {}
  const workspace = definition.workspace == null ? '' : String(definition.workspace).trim()
  return {
    id: requiredId(definition.id),
    title: String(definition.title || '').trim(),
    enabled: definition.enabled !== false,
    // No schedule means manual-only: the routine runs exclusively on demand.
    schedule: String(definition.schedule || '').trim() || null,
    timezone: String(definition.timezone || '').trim() || 'local',
    preset: String(definition.preset || '').trim(),
    prompt: String(definition.prompt || ''),
    overlap: String(definition.overlap || 'skip'),
    missed: String(definition.missed || 'run-once'),
    workspace: workspace || null,
  }
}

function requiredId(value) {
  const id = String(value || '').trim()
  if (!id) throw new Error('A routine id is required.')
  return id
}

function requiredRevision(value) {
  const revision = String(value || '').trim()
  if (!revision) throw new Error('Reload this routine before changing it.')
  return revision
}

function normalizeDiagnostic(value) {
  return {
    path: String(value.path || ''),
    field: value.field == null ? null : String(value.field),
    message: String(value.message || 'Invalid routine definition.'),
  }
}

function normalizeTick(value) {
  const tick = isPlainObject(value) ? value : {}
  return {
    fires: (Array.isArray(tick.fires) ? tick.fires : [])
      .filter(isPlainObject)
      .map((fire) => ({
        routineId: String(fire.routineId || fire.routine_id || ''),
        scheduledFor: String(fire.scheduledFor || fire.scheduled_for || ''),
        observedAt: String(fire.observedAt || fire.observed_at || ''),
        reason: String(fire.reason || 'scheduled'),
      })),
    skips: (Array.isArray(tick.skips) ? tick.skips : [])
      .filter(isPlainObject)
      .map((skip) => ({
        routineId: String(skip.routineId || skip.routine_id || ''),
        scheduledFor: String(skip.scheduledFor || skip.scheduled_for || ''),
        reason: String(skip.reason || ''),
      })),
    nextFires: stringRecord(tick.nextFires || tick.next_fires),
  }
}

function normalizeRunResult(value) {
  const result = isPlainObject(value) ? value : {}
  return {
    activity: isPlainObject(result.activity) ? result.activity : null,
    scheduledFor: String(result.scheduledFor || result.scheduled_for || ''),
  }
}

function stringRecord(value) {
  if (!isPlainObject(value)) return {}
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [String(key), String(entry)]),
  )
}

function optionalString(value) {
  return value == null ? null : String(value)
}

function finiteNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
