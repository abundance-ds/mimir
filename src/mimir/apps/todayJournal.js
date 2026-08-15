import {
  createGraphNode,
  getGraphNode,
  updateGraphNode,
} from '../../services/businessGraph.js'
import {
  journalDay,
  journalNodeId,
  journalTitle,
  upsertJournalDay,
} from './todayModel.js'

const PRIVATE_SCOPE_ID = 'private:local'
const MAX_WRITE_ATTEMPTS = 2

export async function archiveTodayEntry({ date, text, timeZone = localTimeZone() }) {
  const content = String(text || '')
  if (!content.trim()) return null

  const id = journalNodeId(date)
  let lastError = null

  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
    const existing = await getGraphNode(id)
    if (!existing) {
      try {
        return await createGraphNode({
          id,
          scopeId: PRIVATE_SCOPE_ID,
          kind: 'journal',
          title: journalTitle(date),
          body: upsertJournalDay('', date, content),
          tags: ['today'],
          properties: {
            artifactType: 'today-journal',
            sourceAppId: 'scratch',
            timeZone,
          },
        })
      } catch (cause) {
        lastError = cause
        continue
      }
    }

    if (existing.kind && existing.kind !== 'journal') {
      throw new Error(`Graph id ${id} belongs to a ${existing.kind}, not a journal.`)
    }

    const body = upsertJournalDay(existing.body, date, content)
    if (body === existing.body) return existing
    try {
      return await updateGraphNode({
        id,
        expectedRevision: existing.provenance?.sourceRevision || existing.sourceRevision,
        body,
        tags: [...new Set([...(existing.tags || []), 'today'])],
        setProperties: {
          artifactType: 'today-journal',
          sourceAppId: 'scratch',
          timeZone,
        },
      })
    } catch (cause) {
      lastError = cause
    }
  }

  throw lastError || new Error(`Journal entry could not be archived: ${date}`)
}

export async function loadTodayEntry(date) {
  const node = await getGraphNode(journalNodeId(date))
  return node ? journalDay(node.body, date) : null
}

function localTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'
}
