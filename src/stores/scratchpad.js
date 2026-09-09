import { defineStore } from 'pinia'
import { ref } from 'vue'
import { scratchpadSnapshot, saveScratchpad } from '../services/scratchpad.js'

export const useScratchpadStore = defineStore('scratchpad', () => {
  const path = ref('')
  const content = ref('')
  const history = ref([])
  const externalChange = ref(0)
  const error = ref('')
  let requests = Promise.resolve()

  function apply(snapshot) {
    if (!snapshot?.path) return
    path.value = snapshot.path
    content.value = snapshot.content
    history.value = snapshot.history
    error.value = ''
  }

  function refresh() {
    const request = requests.catch(() => {}).then(async () => {
      const snapshot = await scratchpadSnapshot()
      apply(snapshot)
      return snapshot
    })
    requests = request
    return request
  }

  async function save(text, expected) {
    const request = requests.catch(() => {}).then(async () => {
      const snapshot = await saveScratchpad(text, expected)
      apply(snapshot)
      return snapshot
    })
    requests = request
    try {
      return await request
    } catch (cause) {
      await refresh().catch(() => {})
      error.value = String(cause)
      throw cause
    }
  }

  async function listenForChanges() {
    const { listen } = await import('@tauri-apps/api/event')
    const stop = await listen('mimir://scratchpad-changed', () => {
      void refresh().then(() => { externalChange.value++ }).catch(cause => { error.value = String(cause) })
    })
    try { await refresh() } catch (cause) { stop(); throw cause }
    return stop
  }

  return { path, content, history, externalChange, error, refresh, save, listenForChanges }
})
