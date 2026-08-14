export function normalizeSessionEntries(
  values,
  activeFileIndex = 0,
  createDraftId = defaultDraftId,
) {
  const entries = []
  const keyIndex = new Map()
  const sourceToEntry = new Map()

  for (const [sourceIndex, raw] of (Array.isArray(values) ? values : []).entries()) {
    const entry = normalizeEntry(raw)
    if (!entry) continue
    let key
    let legacyDraft = false
    if (entry.path) {
      key = `path:${entry.path}`
    } else if (entry.draftId) {
      key = `draft:${entry.draftId}`
    } else {
      // Content equality is only a legacy migration rule. Newly persisted
      // drafts always carry stable ids, so intentional equal drafts survive.
      key = `legacy:${entry.content}`
      legacyDraft = true
    }

    const existingIndex = keyIndex.get(key)
    if (existingIndex === undefined) {
      if (legacyDraft) entry.draftId = createDraftId()
      keyIndex.set(key, entries.length)
      sourceToEntry.set(sourceIndex, entries.length)
      entries.push(entry)
      continue
    }
    sourceToEntry.set(sourceIndex, existingIndex)
    if (sourceIndex === activeFileIndex) {
      entries[existingIndex] = {
        ...entry,
        draftId: entries[existingIndex].draftId || entry.draftId,
      }
    }
  }

  const normalizedActiveIndex = sourceToEntry.get(activeFileIndex)
    ?? Math.min(Math.max(Number(activeFileIndex) || 0, 0), Math.max(entries.length - 1, 0))

  return {
    entries,
    activeEntry: entries[normalizedActiveIndex] || null,
    activeIndex: normalizedActiveIndex,
    changed: JSON.stringify(Array.isArray(values) ? values : []) !== JSON.stringify(entries)
      || normalizedActiveIndex !== Number(activeFileIndex || 0),
  }
}

export async function loadSessionEntries(entries, read, concurrency = 8) {
  const values = Array.isArray(entries) ? entries : []
  const results = new Array(values.length)
  let cursor = 0

  async function worker() {
    while (cursor < values.length) {
      const index = cursor++
      const entry = values[index]
      if (!entry?.path) {
        results[index] = { entry, content: entry?.content ?? '', error: null }
        continue
      }
      try {
        results[index] = {
          entry,
          content: await read(entry.path),
          error: null,
        }
      } catch (error) {
        results[index] = { entry, content: null, error }
      }
    }
  }

  const workerCount = Math.min(
    Math.max(1, Number(concurrency) || 1),
    Math.max(values.length, 1),
  )
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}

function normalizeEntry(raw) {
  if (typeof raw === 'string') {
    const path = raw.trim()
    return path ? { path } : null
  }
  if (!raw || typeof raw !== 'object') return null
  const path = typeof raw.path === 'string' ? raw.path.trim() : ''
  if (path) {
    const workspacePath = typeof raw.workspacePath === 'string'
      ? raw.workspacePath.trim()
      : ''
    const ownership = workspacePath ? { workspacePath } : {}
    if (raw.dirty === true && typeof raw.content === 'string') {
      return { path, ...ownership, content: raw.content, dirty: true }
    }
    return { path, ...ownership }
  }
  const content = typeof raw.content === 'string' ? raw.content : ''
  if (!content) return null
  const draftId = typeof raw.draftId === 'string' ? raw.draftId.trim() : ''
  return {
    path: null,
    content,
    ...(draftId ? { draftId } : {}),
  }
}

let fallbackDraftId = 1
function defaultDraftId() {
  return globalThis.crypto?.randomUUID?.() || `restored-draft-${fallbackDraftId++}`
}
