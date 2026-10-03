import { invoke } from '@tauri-apps/api/core'
import { isTauriRuntime } from '../shared/platform.js'

let checking = Promise.resolve()

export async function checkSpelling(text, { signal } = {}) {
  if (!isTauriRuntime() || !text.trim()) return []
  // Share one bounded request across editors; skip superseded queued work.
  const request = checking.then(() => signal?.aborted ? [] : invoke('spell_check', { text }))
  checking = request.catch(() => {})
  const ranges = await request
  if (!Array.isArray(ranges)) throw new Error('Invalid spelling response.')
  return ranges.filter(range => Number.isInteger(range.from) && Number.isInteger(range.to)
    && range.from >= 0 && range.to > range.from && range.to <= text.length)
}

export async function spellingSuggestions(word) {
  if (!isTauriRuntime() || !word) return []
  const result = await invoke('spell_suggest', { word })
  return Array.isArray(result) ? result.filter(value => typeof value === 'string') : []
}
