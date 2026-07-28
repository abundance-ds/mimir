import { computed, nextTick, ref } from 'vue'
import { cssEscape } from './filePaths.js'

export function useFileContextMenu({
  visibleRows,
  focusedIndex,
  selectedPaths,
  listRef,
  contextMenuRef,
}) {
  const contextEntry = ref(null)
  const emptyContext = ref(false)
  const contextPosition = ref({ x: 12, y: 12 })
  const contextStyle = computed(() => ({
    left: `${contextPosition.value.x}px`,
    top: `${contextPosition.value.y}px`,
  }))

  function openContextMenu(row, event) {
    contextEntry.value = row.entry
    emptyContext.value = false
    const index = visibleRows.value.findIndex(item => item.entry.path === row.entry.path)
    if (index >= 0) focusedIndex.value = index
    if (!selectedPaths.value.has(row.entry.path)) {
      selectedPaths.value = new Set([row.entry.path])
    }
    placeContextMenu(event.clientX, event.clientY)
  }

  function openKeyboardContextMenu() {
    const row = visibleRows.value[focusedIndex.value]
    if (!row) {
      emptyContext.value = true
      placeContextMenu(16, 72)
      return
    }
    contextEntry.value = row.entry
    selectedPaths.value = selectedPaths.value.has(row.entry.path)
      ? selectedPaths.value
      : new Set([row.entry.path])
    const element = listRef.value?.querySelector(
      `[data-file-row="${cssEscape(row.entry.path)}"]`,
    )
    const rect = element?.getBoundingClientRect?.()
    placeContextMenu(rect?.left || 16, rect?.bottom || 72)
  }

  function openEmptyContextMenu(event) {
    if (event.target?.closest?.('[data-file-row]')) return
    event.preventDefault()
    contextEntry.value = null
    emptyContext.value = true
    placeContextMenu(event.clientX, event.clientY)
  }

  function placeContextMenu(x, y) {
    contextPosition.value = {
      x: Math.max(8, Math.min(Number(x) || 8, window.innerWidth - 230)),
      y: Math.max(8, Math.min(Number(y) || 8, window.innerHeight - 320)),
    }
    nextTick(() => contextMenuRef.value?.querySelector('[role="menuitem"]')?.focus())
  }

  function closeContextMenu() {
    contextEntry.value = null
    emptyContext.value = false
  }

  function onContextMenuKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeContextMenu()
      nextTick(() => listRef.value?.focus())
      return
    }
    const items = [...(contextMenuRef.value?.querySelectorAll('[role="menuitem"]') || [])]
    if (!items.length) return
    const current = Math.max(0, items.indexOf(document.activeElement))
    let next = null
    if (event.key === 'ArrowDown') next = (current + 1) % items.length
    else if (event.key === 'ArrowUp') next = (current - 1 + items.length) % items.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = items.length - 1
    else if (
      (event.key === 'Enter' || event.key === ' ')
      && document.activeElement?.matches?.('[role="menuitem"]')
    ) {
      event.preventDefault()
      document.activeElement.click()
      return
    }
    if (next !== null) {
      event.preventDefault()
      items[next].focus()
    }
  }

  function onDocumentPointerDown(event) {
    if (!contextEntry.value && !emptyContext.value) return
    if (contextMenuRef.value?.contains(event.target)) return
    closeContextMenu()
  }

  return {
    closeContextMenu,
    contextEntry,
    contextPosition,
    contextStyle,
    emptyContext,
    onContextMenuKeydown,
    onDocumentPointerDown,
    openContextMenu,
    openEmptyContextMenu,
    openKeyboardContextMenu,
    placeContextMenu,
  }
}
