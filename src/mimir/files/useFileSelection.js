import { nextTick, ref, watch } from 'vue'
import { cssEscape, normalizeRelative, parentDirectory } from './filePaths.js'

export function useFileSelection({
  visibleRows,
  listRef,
  activateRow,
  closeContextMenu,
}) {
  const selectedPaths = ref(new Set())
  const focusedIndex = ref(0)
  const anchorIndex = ref(0)

  watch(visibleRows, (rows) => {
    focusedIndex.value = Math.min(focusedIndex.value, Math.max(rows.length - 1, 0))
    const visible = new Set(rows.map(row => row.entry.path))
    selectedPaths.value = new Set(
      [...selectedPaths.value].filter(path => visible.has(path)),
    )
  })

  function resetSelection() {
    selectedPaths.value = new Set()
    focusedIndex.value = 0
    anchorIndex.value = 0
  }

  function clearSelection() {
    selectedPaths.value = new Set()
    closeContextMenu?.()
  }

  function focusList(delta) {
    listRef.value?.focus()
    moveFocus(delta)
  }

  function moveFocus(delta, extend = false) {
    const rows = visibleRows.value
    if (!rows.length) return
    focusedIndex.value = (focusedIndex.value + delta + rows.length) % rows.length
    const path = rows[focusedIndex.value].entry.path
    if (extend) {
      const start = Math.min(anchorIndex.value, focusedIndex.value)
      const end = Math.max(anchorIndex.value, focusedIndex.value)
      selectedPaths.value = new Set(
        rows.slice(start, end + 1).map(row => row.entry.path),
      )
    } else {
      anchorIndex.value = focusedIndex.value
      selectedPaths.value = new Set([path])
    }
    scrollRowIntoView(path)
  }

  function selectRow(row, index, event) {
    focusedIndex.value = index
    if (event?.shiftKey) {
      const start = Math.min(anchorIndex.value, index)
      const end = Math.max(anchorIndex.value, index)
      selectedPaths.value = new Set(
        visibleRows.value.slice(start, end + 1).map(item => item.entry.path),
      )
    } else if (event?.metaKey || event?.ctrlKey) {
      const next = new Set(selectedPaths.value)
      if (next.has(row.entry.path)) next.delete(row.entry.path)
      else next.add(row.entry.path)
      selectedPaths.value = next
      anchorIndex.value = index
    } else {
      selectedPaths.value = new Set([row.entry.path])
      anchorIndex.value = index
    }
    activateRow(row, true)
  }

  function focusParent(row) {
    const parent = parentDirectory(row.entry.relativePath)
    const index = visibleRows.value.findIndex(
      item => normalizeRelative(item.entry.relativePath) === parent,
    )
    if (index < 0) return
    focusedIndex.value = index
    selectedPaths.value = new Set([visibleRows.value[index].entry.path])
    scrollRowIntoView(visibleRows.value[index].entry.path)
  }

  function scrollRowIntoView(path) {
    nextTick(() => {
      const row = listRef.value?.querySelector(`[data-file-row="${cssEscape(path)}"]`)
      row?.scrollIntoView?.({ block: 'nearest' })
      row?.querySelector?.('button')?.focus?.({ preventScroll: true })
    })
  }

  function selectedEntries() {
    if (!selectedPaths.value.size) {
      const row = visibleRows.value[focusedIndex.value]
      return row ? [row.entry] : []
    }
    return visibleRows.value
      .filter(row => selectedPaths.value.has(row.entry.path) && !row.missing)
      .map(row => row.entry)
  }

  function selectedDirectory() {
    const row = visibleRows.value[focusedIndex.value]
    if (!row || !selectedPaths.value.has(row.entry.path)) return ''
    return row.entry.isDirectory
      ? normalizeRelative(row.entry.relativePath)
      : parentDirectory(row.entry.relativePath)
  }

  return {
    anchorIndex,
    clearSelection,
    focusList,
    focusParent,
    focusedIndex,
    moveFocus,
    resetSelection,
    scrollRowIntoView,
    selectedDirectory,
    selectedEntries,
    selectedPaths,
    selectRow,
  }
}
