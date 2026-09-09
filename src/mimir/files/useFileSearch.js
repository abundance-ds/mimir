import { computed, onScopeDispose, ref, watch } from 'vue'
import { filterIndexedFiles } from '../../services/fileIndex.js'

const DEBOUNCE_MS = 130
const PATH_LIMIT = 250

// A presentation owns its query and results. The shared index is data, not
// search state: Quick Open, the sidebar, and File Manager can search at once.
export function useFileSearch({ workspacePath, indexedFiles, searchContent }) {
  const query = ref('')
  const scope = ref('paths')
  const phase = ref('idle')
  const pathResults = ref([])
  const contentResults = ref([])
  const limited = ref(false)
  const error = ref('')
  const owner = Symbol('file-search')
  const pending = computed(() => phase.value === 'pending')
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
    scope.value = 'paths'
    phase.value = 'idle'
  }

  function schedule({ immediate = false } = {}) {
    invalidate()
    const text = query.value.trim()
    const workspace = workspacePath.value
    const requestScope = scope.value
    const requestGeneration = generation
    if (!text || !workspace) {
      phase.value = 'idle'
      return
    }
    phase.value = 'pending'
    const current = () => generation === requestGeneration
      && workspacePath.value === workspace
      && query.value.trim() === text && scope.value === requestScope
    const run = async () => {
      timer = null
      try {
        if (requestScope === 'contents') {
          const report = await searchContent(text, { owner, pathQuery: null })
          if (!current()) return
          if (!report || report.cancelled) {
            phase.value = 'interrupted'
            error.value = 'Search was interrupted. Try again.'
            return
          }
          contentResults.value = report.matches || []
          limited.value = Boolean(report.truncated)
        } else {
          // Ask for one extra hit so the result limit has a truthful signal.
          const hits = await filterIndexedFiles(text, PATH_LIMIT + 1)
          if (!current()) return
          pathResults.value = hits.slice(0, PATH_LIMIT).map(hit => hit.file)
          limited.value = hits.length > PATH_LIMIT
        }
        phase.value = 'ready'
      } catch (cause) {
        if (!current()) return
        phase.value = 'error'
        error.value = cause instanceof Error ? cause.message : String(cause || 'Search failed.')
      }
    }
    if (immediate) void run()
    else timer = setTimeout(run, DEBOUNCE_MS)
  }

  function setScope(value) {
    if (!['paths', 'contents'].includes(value) || scope.value === value) return
    scope.value = value
    schedule()
  }

  watch(workspacePath, clear)
  // A new index snapshot can add/remove a matching file and cancels native
  // content work. Refresh the current query without changing its owner.
  watch(indexedFiles, () => { if (query.value.trim()) schedule() })
  onScopeDispose(invalidate)

  return { query, scope, phase, pending, pathResults, contentResults, limited, error, schedule, setScope, clear }
}
