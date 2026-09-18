import { computed, nextTick, ref, watch } from 'vue'
import { useScratchpadStore } from '../../stores/scratchpad.js'

export function useScratchpadEditor({ fileManager, currentFile, flush, sync, open, save, ownsFocus, reviewing, reveal, reportError }) {
  const store = useScratchpadStore()
  const selected = ref(null)
  const changes = ref(false)
  const pending = ref(false)
  const busy = ref(false)
  const active = computed(() => Boolean(store.path && currentFile.value?.path === store.path && !reviewing()))
  const conflict = computed(() => active.value && currentFile.value.dirty
    && currentFile.value.scratchpadBase !== store.content && currentFile.value.content !== store.content)
  let stopListener
  let disposed = false

  async function start() {
    if (!window.__TAURI_INTERNALS__) return
    try {
      const stop = await store.listenForChanges()
      if (disposed) stop()
      else stopListener = stop
    } catch (cause) { reportError(cause) }
  }

  function reconcile() {
    const file = fileManager.openFiles.find(file => file.path === store.path)
    if (!file) return
    file.meta = { ...file.meta, scratchpad: true }
    if (!file.dirty) {
      fileManager.replaceCleanContent(file, store.content)
      file.scratchpadBase = store.content
      if (file === currentFile.value) sync()
    }
  }

  const stopContent = watch(() => store.content, () => {
    flush({ bridge: 'flush' })
    reconcile()
  })
  const stopExternal = watch(() => store.externalChange, async () => {
    await nextTick()
    // Flush the active CodeMirror transaction before checking dirty state.
    flush({ bridge: 'flush' })
    reconcile()
    if (disposed) return
    if (selected.value || changes.value || reviewing() || (!active.value && ownsFocus())) {
      pending.value = true
      return
    }
    try { await show({ focus: false }) } catch (cause) { reportError(cause) }
  })
  const stopActive = watch(active, value => { if (value) pending.value = false })

  async function show({ focus = true } = {}) {
    await store.refresh()
    if (!store.path || disposed) return
    if (focus) { selected.value = null; changes.value = false }
    await open(store.path, { focus })
    reconcile()
    pending.value = false
    reveal({ focus })
  }

  async function run(action) {
    if (busy.value) return
    busy.value = true
    try { await action() } catch (cause) { reportError(cause) }
    finally { busy.value = false }
  }

  async function browse(value) {
    await run(async () => {
      flush({ bridge: 'flush' })
      if (currentFile.value?.dirty && !await save({ file: currentFile.value })) return
      selected.value = value ? { ...value } : null
      changes.value = false
      if (!value) pending.value = false
    })
  }

  async function replace(text, { useLatest = false } = {}) {
    await run(async () => {
      flush({ bridge: 'flush' })
      const file = currentFile.value
      if (!active.value) return
      const originalContent = file.content
      // Retain unsaved user text before explicitly choosing either side.
      // This uses the same timeline; there is no separate conflict document.
      if (conflict.value) {
        await store.save(file.content, store.content)
        file.scratchpadBase = file.content
      } else if (file.dirty && !await save({ file })) {
        return
      }
      if (useLatest) text = text ?? store.content
      await store.save(text, store.content)
      await nextTick()
      if (currentFile.value === file) flush({ bridge: 'flush' })
      // Typing can continue while IPC is in flight. Keep any newer input as
      // a dirty buffer instead of replacing it with the restored text.
      if (file.dirty && file.content !== originalContent) return
      fileManager.replaceSavedContent(file, text, { origin: 'edit' })
      sync()
      selected.value = null
      changes.value = false
    })
  }

  async function toggleChanges(value) {
    await run(async () => {
      flush({ bridge: 'flush' })
      if (currentFile.value?.dirty && !await save({ file: currentFile.value })) return
      if (value && !selected.value) selected.value = { ...store.history.at(-1) }
      changes.value = value
    })
  }

  function dispose() {
    disposed = true
    stopListener?.()
    stopContent(); stopExternal(); stopActive()
  }

  return { store, active, selected, changes, pending, conflict, busy, start, reconcile, show, browse, replace, toggleChanges, dispose }
}
