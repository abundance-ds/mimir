import { invoke } from '@tauri-apps/api/core'
import { toRaw } from 'vue'

const queues = new Map()
const versions = new Map()
const timers = new Map()
const owners = new Map()
const native = () => typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__)

export function reviewKey(file) {
  return file?.path || (file?.draftId ? `draft:${file.draftId}` : null)
}

export async function loadReview(key) {
  if (!key || !native()) return null
  if (owners.has(key)) return owners.get(key)
  await queues.get(key)?.catch(() => {})
  const record = await invoke('document_review_read', { key })
  versions.set(key, record?.revision || 0)
  const session = record?.session
  if (!session || session.version !== 1 || typeof session.result !== 'string' || !session.references) return null
  session.key = key
  owners.set(key, toRaw(session))
  return session
}

export function persistReview(session) {
  const key = session?.key
  if (!key || !native()) return Promise.resolve()
  clearTimeout(timers.get(key))
  timers.delete(key)
  const owner = toRaw(session)
  owners.set(key, owner)
  const snapshot = JSON.parse(JSON.stringify(session))
  delete snapshot.saveError
  const previous = queues.get(key) || Promise.resolve()
  const operation = previous.catch(() => {}).then(async () => {
    if (!versions.has(key)) {
      const record = await invoke('document_review_read', { key })
      versions.set(key, record?.revision || 0)
    }
    const revision = await invoke('document_review_save', { key, session: snapshot, expectedRevision: versions.get(key) })
    versions.set(key, revision)
    session.saveError = ''
  }).catch(error => {
    session.saveError = error?.message || String(error)
    throw error
  })
  queues.set(key, operation)
  return operation
}

export function scheduleReviewSave(session) {
  if (!session?.key || !native()) return
  owners.set(session.key, toRaw(session))
  clearTimeout(timers.get(session.key))
  timers.set(session.key, setTimeout(() => { void persistReview(session).catch(() => {}) }, 150))
}

export async function flushReviews() {
  const pending = [...timers.keys()].map(key => persistReview(owners.get(key)))
  await Promise.all([...queues.values(), ...pending])
}
