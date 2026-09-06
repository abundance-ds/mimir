import { nextTick, onUnmounted, ref, watch } from 'vue'

export function useGraphSearch({ graph, projectionNodes, focusResults, focusInput }) {
  const searchDraft = ref('')
  const searchPending = ref(false)
  const searchResultFocusIntent = ref('')
  let timer = null
  let generation = 0

  watch(() => graph.section, () => {
    clearTimeout(timer)
    timer = null
    generation += 1
    searchPending.value = false
    searchResultFocusIntent.value = ''
  })

  watch(
    () => graph.searchQuery,
    query => {
      if (query === searchDraft.value) return
      clearTimeout(timer)
      timer = null
      generation += 1
      searchPending.value = false
      searchDraft.value = query
    },
    { immediate: true },
  )

  watch(
    [searchPending, () => graph.searching, () => projectionNodes.value.length],
    ([pending, searching, resultCount]) => {
      if (!searchResultFocusIntent.value || pending || searching) return
      if (!resultCount) {
        searchResultFocusIntent.value = ''
        return
      }
      void applySearchResultFocus()
    },
  )

  function onSearchInput(value) {
    const requestGeneration = ++generation
    searchDraft.value = value
    clearTimeout(timer)
    timer = null
    graph.prepareSearch(value)
    if (!value.trim() || graph.section === 'work') {
      searchPending.value = false
      return
    }
    searchPending.value = true
    timer = setTimeout(() => runSearch(value, requestGeneration), 100)
  }

  function focusSearchResults(edge) {
    searchResultFocusIntent.value = edge
    if (!searchPending.value && !graph.searching) void applySearchResultFocus()
  }

  async function applySearchResultFocus() {
    const edge = searchResultFocusIntent.value
    if (!edge || searchPending.value || graph.searching || !projectionNodes.value.length) return
    searchResultFocusIntent.value = ''
    await nextTick()
    focusResults(edge)
  }

  function flushSearch() {
    const value = searchDraft.value
    clearTimeout(timer)
    timer = null
    const requestGeneration = ++generation
    if (!value.trim()) {
      clearSearch()
      return
    }
    runSearch(value, requestGeneration)
  }

  function runSearch(value, requestGeneration) {
    if (requestGeneration !== generation || value !== searchDraft.value) return
    timer = null
    searchPending.value = false
    void graph.search(value)
  }

  function clearSearch() {
    clearTimeout(timer)
    timer = null
    generation += 1
    searchPending.value = false
    searchResultFocusIntent.value = ''
    searchDraft.value = ''
    graph.clearSearch()
    focusInput()
  }

  function onSearchEscape(event) {
    if (
      !searchDraft.value
      && !graph.searchQuery
      && !searchPending.value
      && !graph.searching
    ) return
    event.preventDefault()
    event.stopPropagation()
    clearSearch()
  }

  onUnmounted(() => {
    clearTimeout(timer)
    if (searchPending.value) graph.clearSearch()
  })

  return {
    clearSearch,
    flushSearch,
    focusSearchResults,
    onSearchEscape,
    onSearchInput,
    searchDraft,
    searchPending,
  }
}
