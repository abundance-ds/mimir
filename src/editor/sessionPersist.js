import { computed, watch } from 'vue'

export function createSessionPersist(state, save) {
  let timer = null

  const snapshot = computed(() => ({
    openFiles: state.openFiles.value
      .filter(f => f.path || f.content)
      .map(f => f.path ? { path: f.path } : { path: null, content: f.content }),
    recentFiles: [...state.recentFiles.value],
    activeFileIndex: state.activeFileIndex.value,
    zoomLevel: state.zoomLevel.value,
  }))

  const stop = watch(snapshot, (snap) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      save(snap)
      timer = null
    }, 1000)
  })

  return () => {
    stop()
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }
}
