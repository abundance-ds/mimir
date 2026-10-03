import { reactive } from 'vue'

export function useSpellingContextMenu(getView) {
  const menu = reactive({ show: false, x: 0, y: 0, hasSelection: false, position: null })
  function open(event, keyboard = false) {
    // Comment inputs and other editor widgets retain their own text actions.
    if (event.target?.closest?.('input, textarea, button, [contenteditable="false"]')) return
    const view = getView()
    if (!view || view.state.readOnly || view.composing) return
    event.preventDefault()
    const selection = view.state.selection.main
    const position = keyboard ? selection.head : view.posAtCoords({ x: event.clientX, y: event.clientY })
    const coords = keyboard ? view.coordsAtPos(position) : null
    Object.assign(menu, { show: true, position, hasSelection: !selection.empty,
      x: coords?.left ?? event.clientX, y: coords?.bottom ?? event.clientY })
  }
  function keydown(event) {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) open(event, true)
  }
  return { menu, open, keydown }
}
