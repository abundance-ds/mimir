import { ref, computed, watch, onUnmounted } from 'vue'
import { usePanelUIStore } from '../../stores/panel/ui.js'

const isTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__

const MIN_QUERY_LENGTH = 3
const DEBOUNCE_MS = 300

export function useSessionSearch() {
  const panelUI = usePanelUIStore()
  const results = ref([])
  const isSearching = ref(false)
  let debounceTimer = null
  let abortGeneration = 0 // monotonic counter to discard stale results

  const searchActive = computed(() => {
    return panelUI.searchQuery.trim().length >= MIN_QUERY_LENGTH
  })

  const resultsByProject = computed(() => {
    const grouped = {}
    for (const result of results.value) {
      const pid = result.project_id
      if (!grouped[pid]) grouped[pid] = []
      grouped[pid].push(result)
    }
    return grouped
  })

  async function executeSearch(query) {
    const generation = ++abortGeneration
    isSearching.value = true
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const data = await invoke('search_sessions', { query })
      if (generation === abortGeneration) {
        results.value = data
      }
    } catch (err) {
      console.warn('[search] search_sessions failed:', err)
      if (generation === abortGeneration) {
        results.value = []
      }
    } finally {
      if (generation === abortGeneration) {
        isSearching.value = false
      }
    }
  }

  const stopWatch = watch(
    () => panelUI.searchQuery,
    (query) => {
      if (debounceTimer) clearTimeout(debounceTimer)

      const trimmed = query.trim()
      if (trimmed.length < MIN_QUERY_LENGTH) {
        results.value = []
        isSearching.value = false
        abortGeneration++
        return
      }

      debounceTimer = setTimeout(() => {
        executeSearch(trimmed)
      }, DEBOUNCE_MS)
    },
  )

  // In a component context, clean up on unmount
  try {
    onUnmounted(() => {
      stopWatch()
      if (debounceTimer) clearTimeout(debounceTimer)
    })
  } catch {
    // Called outside component — caller is responsible for cleanup
  }

  return {
    results,
    isSearching,
    searchActive,
    resultsByProject,
  }
}
