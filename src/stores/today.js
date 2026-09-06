import { ref, onScopeDispose } from 'vue'
import { defineStore } from 'pinia'
import { loadAppData, saveAppData } from '../services/appsCatalog.js'
import { archiveTodayEntry } from '../mimir/apps/todayJournal.js'
import {
  appendMarkdownBelow, carrySource, localDateKey, parseTodayStorage,
  serializeTodayStorage, uncheckedTaskBlocks,
} from '../mimir/apps/todayModel.js'

export const useTodayStore = defineStore('today', () => {
  const text = ref('')
  const documentDate = ref(localDateKey())
  const updatedAt = ref(null)
  const previous = ref(null)
  const archiveQueue = ref([])
  const tomorrow = ref(null)
  const loading = ref(true)
  const saving = ref(false)
  const dirty = ref(false)
  const todayDirty = ref(false)
  const tomorrowDirty = ref(false)
  const savedOnce = ref(false)
  const savedDate = ref('')
  const error = ref('')
  const errorAction = ref('')
  const journalIssue = ref('')
  const archiving = ref(false)
  let loaded = false
  let restorePromise = null
  let saveTimer = null
  let savedTimer = null
  let activeSave = null
  let editRevision = 0
  let appendQueue = Promise.resolve()
  const editors = new Set()

  async function restore() {
    if (loaded) return
    if (restorePromise) return restorePromise
    loading.value = true
    restorePromise = (async () => {
      try {
        const saved = parseTodayStorage(await loadAppData('scratch', 'scratch'), localDateKey())
        documentDate.value = saved.date
        text.value = saved.text
        updatedAt.value = saved.updatedAt
        previous.value = saved.previous
        archiveQueue.value = saved.archiveQueue
        tomorrow.value = saved.tomorrow
        loaded = true
        error.value = ''
        errorAction.value = ''
      } catch (cause) {
        reportError(`Today could not be restored: ${errorMessage(cause)}`, 'restore')
        throw cause
      } finally {
        loading.value = false
        restorePromise = null
      }
    })()
    return restorePromise
  }

  function attachEditor(onAppend) {
    editors.add(onAppend)
    return () => editors.delete(onAppend)
  }

  async function read() {
    await restore()
    await ensureCurrentDay()
    void archivePendingEntries()
    return snapshot()
  }

  function snapshot() {
    return {
      artifactType: 'today', date: documentDate.value, mediaType: 'text/markdown',
      content: text.value, updatedAt: updatedAt.value, loading: loading.value,
      dirty: todayDirty.value, live: editors.size > 0,
    }
  }

  function append(addition, { signal } = {}) {
    if (typeof addition !== 'string' || !addition.trim() || Array.from(addition).length > 50000) {
      return Promise.reject(Object.assign(new Error('text must contain 1–50000 characters of Markdown.'), { code: 'invalid_input' }))
    }
    const operation = appendQueue.then(async () => {
      await restore()
      await ensureCurrentDay()
      if (signal?.aborted) throw Object.assign(new Error('Cancelled before append.'), { code: 'cancelled' })
      const before = text.value
      // Insert only: retain existing whitespace and the caller's Markdown indentation.
      const separator = !before || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n'
      const insert = separator + addition
      const date = documentDate.value
      text.value = before + insert
      todayDirty.value = true
      markDirty({ schedule: false })
      for (const onAppend of editors) onAppend({ date, from: before.length, insert })
      if (!await flushSave()) {
        throw Object.assign(new Error('Append is in memory but could not be saved. Read TODAY before retrying.'), {
          code: 'handler', data: { applied: true, saved: false, date },
        })
      }
      const receipt = {
        date,
        updatedAt: updatedAt.value,
        contextBefore: before.replace(/\n+$/, '').split('\n').slice(-2).join('\n'),
        appended: insert,
      }
      void archivePendingEntries()
      return receipt
    })
    appendQueue = operation.catch(() => {})
    return operation
  }

  async function ensureCurrentDay() {
    const today = localDateKey()
    if (documentDate.value >= today) return

    const oldDate = documentDate.value
    const oldText = text.value
    const scheduled = tomorrow.value
    if (previous.value?.archivePending && previous.value.text.trim()) {
      archiveQueue.value = mergeArchiveQueue(archiveQueue.value, previous.value)
    }

    const missedTomorrow = scheduled?.date < today ? scheduled : null
    if (missedTomorrow?.text.trim()) {
      archiveQueue.value = mergeArchiveQueue(archiveQueue.value, missedTomorrow)
    }

    const carrySources = []
    if (previous.value?.carryPending) {
      const sourceText = carrySource(previous.value)
      if (uncheckedTaskBlocks(sourceText).length) {
        carrySources.push({
          dates: previous.value.carryDates || [previous.value.date],
          text: sourceText,
        })
      }
    }
    if (uncheckedTaskBlocks(oldText).length) {
      carrySources.push({ dates: [oldDate], text: oldText })
    }
    if (missedTomorrow && uncheckedTaskBlocks(missedTomorrow.text).length) {
      carrySources.push({ dates: [missedTomorrow.date], text: missedTomorrow.text })
    }
    const carryText = carrySources.map(source => source.text).join('\n\n')
    const carryDates = carrySources.flatMap(source => source.dates)
    const candidates = uncheckedTaskBlocks(carryText)
    previous.value = {
      date: oldDate,
      text: oldText,
      carryText,
      carryDates: [...new Set(carryDates)].sort(),
      archivePending: Boolean(oldText.trim()),
      carryPending: candidates.length > 0,
    }
    documentDate.value = today
    const promotedTomorrow = scheduled?.date === today ? scheduled : null
    text.value = promotedTomorrow?.text || ''
    updatedAt.value = promotedTomorrow?.updatedAt || null
    todayDirty.value = true
    tomorrow.value = scheduled?.date > today ? scheduled : null
    settlePrevious()
    markDirty({ schedule: false })
    await flushSave()
  }

  function mergeArchiveQueue(queue, entry) {
    const entries = new Map(queue.map(item => [item.date, item]))
    const existing = entries.get(entry.date)
    entries.set(entry.date, {
      date: entry.date,
      text: existing ? appendMarkdownBelow(existing.text, entry.text) : entry.text,
    })
    return [...entries.values()].sort((left, right) => left.date.localeCompare(right.date))
  }

  function settlePrevious() {
    if (previous.value && !previous.value.archivePending && !previous.value.carryPending) {
      previous.value = null
    }
  }

  async function archivePendingEntries() {
    if (archiving.value) return []
    const entries = [...archiveQueue.value]
    if (previous.value?.archivePending && previous.value.text.trim()) entries.push(previous.value)
    const pending = [...new Map(entries.map(entry => [entry.date, entry])).values()]
      .sort((left, right) => left.date.localeCompare(right.date))
    if (!pending.length) return []
    archiving.value = true
    const dates = []
    try {
      for (const entry of pending) {
        await archiveTodayEntry(entry)
        dates.push(entry.date)
        archiveQueue.value = archiveQueue.value.filter(item => item.date !== entry.date)
        if (previous.value?.date === entry.date) {
          previous.value = { ...previous.value, archivePending: false }
        }
      }
      journalIssue.value = ''
    } catch (cause) {
      journalIssue.value = `Journal archive is waiting: ${errorMessage(cause)}`
    } finally {
      archiving.value = false
      if (dates.length) {
        settlePrevious()
        markDirty({ schedule: false })
        await flushSave()
      }
    }
    return dates
  }

  function markDirty({ schedule = true } = {}) {
    editRevision += 1
    dirty.value = true
    savedOnce.value = false
    if (errorAction.value === 'save') {
      error.value = ''
      errorAction.value = ''
    }
    clearTimeout(saveTimer)
    if (schedule) saveTimer = setTimeout(() => void flushSave(), 350)
  }

  function saveNow() {
    clearTimeout(saveTimer)
    return flushSave()
  }

  async function flushSave() {
    clearTimeout(saveTimer)
    while (dirty.value) {
      const saved = await persist()
      if (!saved) return false
    }
    return true
  }

  function persist() {
    if (activeSave) return activeSave
    if (!dirty.value) return Promise.resolve(true)

    const revision = editRevision
    const savedAt = new Date().toISOString()
    const savedViewDate = todayDirty.value ? documentDate.value : tomorrow.value?.date || documentDate.value
    const todaySavedAt = todayDirty.value ? savedAt : updatedAt.value
    const raw = serializeTodayStorage({
      date: documentDate.value,
      text: text.value,
      updatedAt: todaySavedAt,
      previous: previous.value,
      archiveQueue: archiveQueue.value,
      tomorrow: tomorrow.value,
    })
    saving.value = true
    activeSave = (async () => {
      try {
        await saveAppData('scratch', 'scratch', raw)
        error.value = ''
        errorAction.value = ''
        if (editRevision === revision) {
          updatedAt.value = todaySavedAt
          todayDirty.value = false
          tomorrowDirty.value = false
          dirty.value = false
          savedOnce.value = true
          savedDate.value = savedViewDate
          clearTimeout(savedTimer)
          savedTimer = setTimeout(() => { savedOnce.value = false }, 1_500)
        }
        return true
      } catch (cause) {
        reportError(`Today could not be saved: ${errorMessage(cause)}`, 'save')
        return false
      } finally {
        saving.value = false
        activeSave = null
      }
    })()
    return activeSave
  }

  function reportError(message, action = '') {
    error.value = message
    errorAction.value = action
  }

  function errorMessage(cause) {
    return cause instanceof Error ? cause.message : String(cause || 'Unknown failure')
  }

  onScopeDispose(() => {
    clearTimeout(saveTimer)
    clearTimeout(savedTimer)
    editors.clear()
  })

  return {
    text, documentDate, updatedAt, previous, archiveQueue, tomorrow,
    loading, saving, dirty, todayDirty, tomorrowDirty, savedOnce, savedDate,
    error, errorAction, journalIssue, archiving,
    restore, read, snapshot, append, attachEditor, ensureCurrentDay,
    markDirty, saveNow, flushSave, settlePrevious, archivePendingEntries,
  }
})
