import { computed, onScopeDispose, ref, watch } from 'vue'
import { filterIndexedFiles } from '../../services/fileIndex.js'

const DEBOUNCE_MS = 130
const PATH_LIMIT = 250

// Each presentation owns a search. Publish names first; content work can then
// append results without moving the filename hits or replacing their identity.
export function useFileSearch({ workspacePath, indexedFiles, searchContent }) {
  const query = ref('')
  const phase = ref('idle')
  const pathResults = ref([])
  const contentResults = ref([])
  const limited = ref(false)
  const error = ref('')
  const owner = Symbol('file-search')
  const pending = computed(() => phase.value === 'pending' || phase.value === 'contents')
  const results = computed(() => mergeFileSearchResults(pathResults.value, contentResults.value))
  let generation = 0
  let timer = null

  function invalidate() {
    generation += 1
    clearTimeout(timer)
    timer = null
    void searchContent('', { owner, pathQuery: null }).catch(() => {})
    pathResults.value = []
    contentResults.value = []
    limited.value = false
    error.value = ''
  }
  function clear() {
    invalidate()
    query.value = ''
    phase.value = 'idle'
  }
  function schedule({ immediate = false } = {}) {
    invalidate()
    const text = query.value.trim()
    const workspace = workspacePath.value
    const requestGeneration = generation
    if (!text || !workspace) { phase.value = 'idle'; return }
    phase.value = 'pending'
    const current = () => generation === requestGeneration
      && workspacePath.value === workspace && query.value.trim() === text
    const run = async () => {
      timer = null
      try {
        const hits = await filterIndexedFiles(text, PATH_LIMIT + 1)
        if (!current()) return
        pathResults.value = hits.slice(0, PATH_LIMIT).map(hit => hit.file)
        limited.value = hits.length > PATH_LIMIT
      } catch (cause) {
        if (!current()) return
        error.value = `Filename search failed: ${message(cause)}`
      }
      if (!current()) return
      phase.value = 'contents'
      try {
        const report = await searchContent(text, { owner, pathQuery: null, maxMatchesPerFile: 1 })
        if (!current()) return
        if (!report || report.cancelled) {
          error.value = [error.value, 'Content search was interrupted. Try again.'].filter(Boolean).join(' ')
          phase.value = 'interrupted'
          return
        }
        contentResults.value = report.matches || []
        limited.value ||= Boolean(report.truncated)
        phase.value = error.value ? 'error' : 'ready'
      } catch (cause) {
        if (!current()) return
        error.value = [error.value, `Content search failed: ${message(cause)}`].filter(Boolean).join(' ')
        phase.value = 'error'
      }
    }
    if (immediate) void run()
    else timer = setTimeout(run, DEBOUNCE_MS)
  }
  watch(workspacePath, clear)
  watch(indexedFiles, () => { if (query.value.trim()) schedule() })
  onScopeDispose(invalidate)
  return { query, phase, pending, pathResults, contentResults, results, limited, error, schedule, clear }
}

export function mergeFileSearchResults(paths, contents) {
  const seen = new Set()
  const result = []
  for (const file of paths) {
    if (seen.has(file.path)) continue
    seen.add(file.path)
    result.push({ ...file, matchKind: 'name', key: file.path })
  }
  for (const match of contents) {
    if (seen.has(match.path)) continue
    seen.add(match.path)
    result.push({ ...match, matchKind: 'content', key: match.path })
  }
  return result
}

// Render text nodes and marks, never HTML from file names or file contents.
export function fileMatchParts(value, query) {
  const text = String(value || ''), needle = String(query || '').trim()
  if (!needle) return [{ text, match: false }]
  const literal = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu')
  const parts = []
  let start = 0
  for (const hit of text.matchAll(literal)) {
    const found = hit.index
    if (found > start) parts.push({ text: text.slice(start, found), match: false })
    parts.push({ text: hit[0], match: true })
    start = found + hit[0].length
  }
  if (start < text.length) parts.push({ text: text.slice(start), match: false })
  return parts
}
function message(cause) { return cause instanceof Error ? cause.message : String(cause || 'Search failed.') }
