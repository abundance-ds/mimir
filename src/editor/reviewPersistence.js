import { invoke } from '@tauri-apps/api/core'
import { toRaw } from 'vue'

const queues = new Map()
const versions = new Map()
const timers = new Map()
const owners = new Map()
const loads = new Map()
const moves = new Map()
const native = () => typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__)

export function reviewKey(file) {
  return file?.path || (file?.draftId ? `draft:${file.draftId}` : null)
}

export async function loadReview(key) {
  if (!key || !native()) return null
  if (owners.has(key)) return owners.get(key)
  if (!loads.has(key)) {
    loads.set(key, (async () => {
      await queues.get(key)?.catch(() => {})
      const record = await invoke('document_review_read', { key })
      // A local review can be created while the read is pending.
      if (owners.has(key)) return owners.get(key)
      versions.set(key, record?.revision || 0)
      const session = record?.session
      if (!session || session.version !== 1 || typeof session.result !== 'string' || !session.references) return null
      session.key = key
      session.savedCommentRevision = session.commentRevision
      owners.set(key, toRaw(session))
      return session
    })().finally(() => loads.delete(key)))
  }
  return loads.get(key)
}

export function persistReview(session) {
  const key = session?.key
  if (!key || !native()) return Promise.resolve(false)
  clearTimeout(timers.get(key))
  timers.delete(key)
  const owner = toRaw(session)
  owners.set(key, owner)
  const snapshot = JSON.parse(JSON.stringify(session))
  delete snapshot.saveError
  delete snapshot.savedCommentRevision
  delete snapshot.applying
  const previous = queues.get(key) || Promise.resolve()
  const operation = previous.catch(() => {}).then(async () => {
    if (!versions.has(key)) {
      const record = await invoke('document_review_read', { key })
      versions.set(key, record?.revision || 0)
    }
    const revision = await invoke('document_review_save', { key, session: snapshot, expectedRevision: versions.get(key) })
    versions.set(key, revision)
    session.savedCommentRevision = snapshot.commentRevision
    session.saveError = ''
    return true
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
  await Promise.all([...moves.values()])
  for (const key of [...timers.keys()]) void persistReview(owners.get(key)).catch(() => {})
  await Promise.all([...queues.values()])
}

// The document owner calls this after a path change. Keep the old record until
// the new one is durable, then leave a tombstone so the old path cannot revive it.
export function moveReview(session, key) {
  if (!session || !key) return Promise.resolve()
  const operation = (moves.get(session.id) || Promise.resolve()).catch(() => {}).then(async () => {
    const previousKey = session.previousKey || session.key
    if (previousKey === key) return
    clearTimeout(timers.get(previousKey))
    timers.delete(previousKey)
    await queues.get(previousKey)?.catch(() => {})
    session.previousKey = previousKey
    session.key = key
    try {
      await persistReview(session)
      if (previousKey) await persistReview({ ...session, previousKey: null, key: previousKey, completed: true, movedTo: key })
      delete session.previousKey
      await persistReview(session)
    } catch (error) {
      session.saveError = error?.message || String(error)
      throw error
    }
  })
  moves.set(session.id, operation)
  return operation
}

export function retryReviewSave(session) {
  return session.previousKey ? moveReview(session, session.key) : persistReview(session)
}
