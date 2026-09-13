export function useGraphKeyboard({
  sections,
  appHeader,
  workspaceSurface,
  dispatchBar,
  createOpen,
  openCreate,
  setSection,
}) {
  function onKeydown(event) {
    if (event.isComposing || event.keyCode === 229) return
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
      if (createOpen.value) createOpen.value = false
      return
    }
    if (editing || event.metaKey || event.ctrlKey || event.altKey) return
    if (event.key.toLowerCase() === 'n') {
      event.preventDefault()
      openCreate()
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
