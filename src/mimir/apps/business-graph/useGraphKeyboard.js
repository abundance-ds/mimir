export function useGraphKeyboard({
  graph,
  sections,
  appHeader,
  workspaceSurface,
  dispatchBar,
  deleteOpen,
  createOpen,
  focusMode,
  closeDeleteDialog,
  closeObject,
  enterFocus,
  navigateObjectHistory,
  openCreate,
  setSection,
}) {
  function onKeydown(event) {
    const editing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target?.tagName)
      || event.target?.isContentEditable
      || event.target?.closest?.('.cm-editor')
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault()
      dispatchBar.value?.focusInput()
      return
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault()
      appHeader.value?.focusSearch({ select: true })
      return
    }
    if (event.key === '/' && !editing && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault()
      dispatchBar.value?.focusInput()
      return
    }
    if (event.key === 'Escape') {
      if (appHeader.value?.closeMenus({ restoreFocus: true })) return
      if (workspaceSurface.value?.closeMenus({ restoreFocus: true })) return
      if (deleteOpen.value) closeDeleteDialog()
      else if (createOpen.value) createOpen.value = false
      else if (graph.selectedNode && workspaceSurface.value?.requestBack && focusMode.value) {
        workspaceSurface.value.requestBack()
      } else if (graph.selectedNode) closeObject()
      return
    }
    const historyBack = graph.selectedNode
      && (((event.metaKey || event.ctrlKey) && event.key === '[')
        || (event.altKey && event.key === 'ArrowLeft'))
    const historyForward = graph.selectedNode
      && (((event.metaKey || event.ctrlKey) && event.key === ']')
        || (event.altKey && event.key === 'ArrowRight'))
    if (historyBack || historyForward) {
      event.preventDefault()
      navigateObjectHistory(historyBack ? -1 : 1)
      return
    }
    if (editing || event.metaKey || event.ctrlKey || event.altKey) return
    if (event.key.toLowerCase() === 'n') {
      event.preventDefault()
      openCreate()
      return
    }
    if (event.key.toLowerCase() === 'f' && graph.selectedNode && !focusMode.value) {
      event.preventDefault()
      void enterFocus()
      return
    }
    const index = Number(event.key) - 1
    if (index >= 0 && index < sections.length) {
      event.preventDefault()
      setSection(sections[index].id)
    }
  }

  return { onKeydown }
}
