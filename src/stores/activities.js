import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

export const ACTIVITY_KINDS = Object.freeze([
  'terminal',
  'agent',
  'files',
  'app',
  'routine',
])

export const ACTIVITY_STATUSES = Object.freeze([
  'ready',
  'starting',
  'working',
  'needs-input',
  'idle',
  'done',
  'error',
  'stopped',
  'interrupted',
])

const RETENTIONS = new Set(['ephemeral', 'durable'])
const LIVE_STATUSES = new Set(['ready', 'starting', 'working', 'needs-input', 'idle'])
const KNOWN_FIELDS = new Set([
  'id',
  'kind',
  'title',
  'workspacePath',
  'status',
  'createdAt',
  'updatedAt',
  'lastViewedAt',
  'archivedAt',
  'retention',
  'source',
  'host',
  'launch',
  'session',
  'error',
  'exit',
  'message',
  'unread',
])

const TRANSITIONS = Object.freeze({
  ready: new Set(['starting', 'stopped', 'error']),
  starting: new Set(['working', 'needs-input', 'idle', 'done', 'error', 'stopped', 'interrupted']),
  working: new Set(['needs-input', 'idle', 'done', 'error', 'stopped', 'interrupted']),
  'needs-input': new Set(['working', 'idle', 'done', 'error', 'stopped', 'interrupted']),
  idle: new Set(['working', 'needs-input', 'done', 'error', 'stopped', 'interrupted']),
  done: new Set(['starting']),
  error: new Set(['starting']),
  stopped: new Set(['starting']),
  interrupted: new Set(['starting', 'stopped']),
})

export const useActivitiesStore = defineStore('activities', () => {
  const records = ref([])

  const activities = computed(() => sorted(records.value))
  const visibleActivities = computed(() => activities.value.filter((item) => !item.archivedAt))
  const archivedActivities = computed(() => activities.value.filter((item) => Boolean(item.archivedAt)))

  function byId(id) {
    return records.value.find((item) => item.id === id) || null
  }

  function upsert(value) {
    assertKnownFields(value)
    const existingIndex = records.value.findIndex((item) => item.id === value?.id)
    const existing = existingIndex >= 0 ? records.value[existingIndex] : null
    const next = normalizeRecord(existing ? { ...existing, ...serializableClone(value) } : value)

    if (existingIndex >= 0) records.value.splice(existingIndex, 1, next)
    else records.value.push(next)
    return next
  }

  function transition(id, status, updatedAt = new Date().toISOString()) {
    const activity = requireActivity(id)
    assertStatus(status)
    if (activity.status === status) return activity
    if (!TRANSITIONS[activity.status]?.has(status)) {
      throw new Error(`Activity cannot transition from ${activity.status} to ${status}.`)
    }
    return replaceRecord(activity, { status, updatedAt })
  }

  function reconcileStatus(id, status, updatedAt = new Date().toISOString()) {
    const activity = requireActivity(id)
    assertStatus(status)
    return replaceRecord(activity, { status, updatedAt })
  }

  function setArchived(id, archived, at = new Date().toISOString()) {
    const activity = requireActivity(id)
    if (activity.retention !== 'durable') {
      throw new Error('Ephemeral activities cannot be archived.')
    }
    return replaceRecord(activity, {
      archivedAt: archived ? at : null,
      updatedAt: at,
    })
  }

  function remove(id) {
    const activity = requireActivity(id)
    if (LIVE_STATUSES.has(activity.status)) {
      throw new Error(`Cannot remove live Activity '${id}'. Stop it first.`)
    }
    records.value = records.value.filter((item) => item.id !== id)
  }

  function durableSnapshot() {
    return activities.value
      .filter((item) => item.retention === 'durable')
      .map((item) => serializableClone(item))
  }

  function hydrate(values) {
    if (!Array.isArray(values)) throw new Error('Activity snapshot must be an array.')
    const hydrated = []
    for (const value of values) {
      assertKnownFields(value)
      const record = normalizeRecord(value)
      if (record.retention !== 'durable') continue
      if (LIVE_STATUSES.has(record.status)) {
        record.status = 'interrupted'
      }
      hydrated.push(record)
    }
    records.value = hydrated
  }

  function replaceRecord(activity, patch) {
    const index = records.value.findIndex((item) => item.id === activity.id)
    const next = normalizeRecord({ ...activity, ...serializableClone(patch) })
    records.value.splice(index, 1, next)
    return next
  }

  function requireActivity(id) {
    const activity = byId(id)
    if (!activity) throw new Error(`Activity '${id}' was not found.`)
    return activity
  }

  return {
    records,
    activities,
    visibleActivities,
    archivedActivities,
    byId,
    upsert,
    transition,
    reconcileStatus,
    setArchived,
    remove,
    durableSnapshot,
    hydrate,
  }
})

function normalizeRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Activity must be an object.')
  }

  const id = nonEmptyString(value.id, 'Activity id')
  const kind = String(value.kind || '')
  if (!ACTIVITY_KINDS.includes(kind)) throw new Error(`Unknown Activity kind '${kind}'.`)
  const status = String(value.status || '')
  assertStatus(status)
  const retention = String(value.retention || '')
  if (!RETENTIONS.has(retention)) throw new Error(`Unknown Activity retention '${retention}'.`)

  const createdAt = nonEmptyString(value.createdAt, 'Activity createdAt')
  const updatedAt = nonEmptyString(value.updatedAt, 'Activity updatedAt')

  return {
    id,
    kind,
    title: nonEmptyString(value.title, 'Activity title'),
    workspacePath: typeof value.workspacePath === 'string' ? value.workspacePath : '',
    status,
    createdAt,
    updatedAt,
    lastViewedAt: nullableString(value.lastViewedAt),
    archivedAt: nullableString(value.archivedAt),
    retention,
    source: plainRecord(value.source),
    host: plainRecord(value.host),
    launch: plainRecord(value.launch),
    ...(value.session === undefined ? {} : { session: plainRecord(value.session) }),
    ...(value.error === undefined ? {} : { error: nullableString(value.error) }),
    ...(value.exit === undefined ? {} : { exit: plainRecord(value.exit) }),
    ...(value.message === undefined ? {} : { message: String(value.message) }),
    ...(value.unread === undefined ? {} : { unread: Boolean(value.unread) }),
  }
}

function assertKnownFields(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  for (const field of Object.keys(value)) {
    if (!KNOWN_FIELDS.has(field)) throw new Error(`Unknown Activity field '${field}'.`)
  }
}

function assertStatus(status) {
  if (!ACTIVITY_STATUSES.includes(status)) throw new Error(`Unknown Activity status '${status}'.`)
}

function nonEmptyString(value, label) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw new Error(`${label} must not be empty.`)
  return text
}

function nullableString(value) {
  if (value === null || value === undefined || value === '') return null
  return String(value)
}

function plainRecord(value) {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Activity metadata must be an object.')
  }
  const clone = serializableClone(value)
  if (!clone || typeof clone !== 'object' || Array.isArray(clone)) {
    throw new Error('Activity metadata must be serializable.')
  }
  return clone
}

function serializableClone(value) {
  try {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) throw new Error('not serializable')
    return JSON.parse(encoded)
  } catch {
    throw new Error('Activity data must be serializable.')
  }
}

function sorted(values) {
  return [...values].sort((a, b) => {
    const time = Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
    return time || a.id.localeCompare(b.id)
  })
}
