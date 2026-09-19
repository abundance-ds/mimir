import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { graphSource, updateGraphNode } from '../services/businessGraph.js'

export const projectCanvas = node => typeof node?.properties?.home?.canvas === 'string' ? node.properties.home.canvas : ''
const message = error => error instanceof Error ? error.message : String(error)

// Draft identity includes the source path, not only a potentially reused id.
// Session persistence owns crash recovery; only the canvas goes to Graph.
export const useProjectHomeStore = defineStore('projectHome', () => {
  const entries = ref({})
  const timers = new Map(), writes = new Map()
  const drafts = computed(() => Object.values(entries.value).filter(entry => entry.canvas !== entry.base || (entry.pending != null && entry.canvas !== entry.pending) || entry.recovery != null)
    .map(({ id, path, base, canvas, recovery, pending }) => ({ id, path, base, canvas, recovery, pending })))

  function restore(values) {
    for (const value of Array.isArray(values) ? values : []) {
      if (!value?.path || !value.id || typeof value.canvas !== 'string' || typeof value.base !== 'string') continue
      const existing = entries.value[value.path]
      if (existing && existing.canvas !== existing.base) {
        if (existing.canvas !== value.canvas) existing.recovery = value.canvas
        continue
      }
      const entry = entries.value[value.path] = { ...value, status: 'dirty', error: '', remote: null, home: existing?.home }
      if (existing) {
        if (existing.base === value.pending) entry.base = existing.base
        entry.pending = null
        if (existing.base !== entry.base && existing.base !== value.canvas) conflict(entry, existing.base)
        else if (existing.base === value.canvas) { entry.base = value.canvas; entry.status = 'saved' }
        else schedule(entry)
      }
    }
  }
  function receive(node) {
    const path = node.provenance.sourcePath, canvas = projectCanvas(node)
    let entry = entries.value[path]
    if (!entry) entry = entries.value[path] = { id: node.id, path, canvas, base: canvas, status: 'saved', error: '', remote: null, recovery: null, home: node.properties?.home }
    if (!writes.has(path)) {
      if (entry.pending != null && canvas === entry.pending) entry.base = canvas
      entry.pending = null
      if (entry.canvas === entry.base || canvas === entry.canvas) {
        entry.canvas = entry.base = canvas
        entry.status = 'saved'; entry.error = ''; entry.remote = null
      } else if (canvas !== entry.base) conflict(entry, canvas)
      else if (entry.status === 'dirty') schedule(entry)
      entry.home = node.properties?.home
    }
    return entry
  }
  function edit(entry, value) {
    entry.canvas = value
    if (entry.remote != null) return
    entry.error = ''
    entry.status = value === entry.base ? 'saved' : 'dirty'
    schedule(entry)
  }
  function schedule(entry) {
    clearTimeout(timers.get(entry.path))
    if (entry.canvas !== entry.base && entry.remote == null) timers.set(entry.path, setTimeout(() => { void save(entry) }, 600))
  }
  function conflict(entry, remote) {
    entry.remote = remote
    entry.status = 'conflict'
    entry.error = 'The saved canvas changed. Your draft is kept here.'
  }
  async function save(entry) {
    clearTimeout(timers.get(entry.path))
    if (writes.has(entry.path)) {
      await writes.get(entry.path)
      return entry.remote == null && !entry.error ? save(entry) : false
    }
    if (entry.remote != null) return false
    if (entry.canvas === entry.base && entry.pending == null) { entry.status = 'saved'; return true }
    const canvas = entry.canvas, base = entry.base, recoveredPending = entry.pending
    entry.pending = canvas
    entry.status = 'saving'; entry.error = ''
    const operation = (async () => {
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          const source = await graphSource(entry.path), node = source?.node
          if (!node || node.kind !== 'project' || node.id !== entry.id || node.provenance.sourcePath !== entry.path) throw new Error('This Project is unavailable. Your draft is kept on this device.')
          entry.home = node.properties?.home
          const current = projectCanvas(node)
          if (current !== base && current !== canvas && current !== recoveredPending) { conflict(entry, current); return false }
          let updated = node
          if (current !== canvas) {
            try {
              updated = await updateGraphNode({ id: entry.id, expectedSourcePath: entry.path, expectedRevision: source.sourceRevision,
                setProperties: { home: { ...node.properties?.home, canvas } } })
            } catch (error) {
              if (/conflict|changed since|revision/i.test(message(error)) && attempt < 2) continue
              throw error
            }
          }
          entry.base = canvas; entry.home = updated.properties?.home
          entry.status = entry.canvas === canvas ? 'saved' : 'dirty'
          return true
        }
      } catch (error) { entry.status = 'error'; entry.error = message(error) }
      return false
    })()
    writes.set(entry.path, operation)
    const saved = await operation
    writes.delete(entry.path)
    if (saved || entry.remote != null) entry.pending = null
    if (saved && entry.canvas !== entry.base) schedule(entry)
    return saved
  }
  function resolve(entry, useSaved) {
    if (entry.remote == null) return
    if (useSaved) { entry.recovery = entry.canvas; entry.canvas = entry.remote }
    entry.base = entry.remote; entry.remote = null; entry.error = ''
    entry.status = entry.canvas === entry.base ? 'saved' : 'dirty'
    if (!useSaved) void save(entry)
  }
  function recover(entry) {
    const value = entry.recovery
    entry.recovery = null
    if (value != null) edit(entry, value)
  }
  return { entries, drafts, restore, receive, edit, save, resolve, recover }
})
