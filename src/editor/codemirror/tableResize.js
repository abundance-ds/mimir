// DOM-only resize controls. Widths belong to the document's CodeMirror state.
const controllers = new WeakMap()
const MIN_WIDTH = 64

export function tableResizeController(dom) { return controllers.get(dom) }

export function addTableResizeControls(wrapper, table, view, widths, commit) {
  // Do not let the table's intrinsic width expand CodeMirror's flex content.
  wrapper.style.contain = 'inline-size'
  const headers = [...table.querySelectorAll('th')]
  const group = document.createElement('colgroup')
  const cols = headers.map(() => group.appendChild(document.createElement('col')))
  table.prepend(group)
  const controls = document.createElement('div')
  controls.className = 'cm-lp-table-controls'
  const reset = document.createElement('button')
  reset.type = 'button'
  reset.textContent = 'Reset column widths'
  controls.append(reset)
  wrapper.prepend(controls)
  let saved = widths
  let drag = null
  let frame = null
  let onCommit = commit
  const handles = []

  function apply(value) {
    table.style.tableLayout = 'fixed'
    table.style.width = '100%'
    table.classList.add('cm-lp-table-sized')
    const total = value?.reduce((sum, width) => sum + width, 0)
    cols.forEach((col, i) => { col.style.width = value ? `${value[i] / total * 100}%` : '' })
    handles.forEach((handle, i) => {
      if (value) handle.setAttribute('aria-valuenow', Math.round(value[i] / total * 100))
      else handle.removeAttribute('aria-valuenow')
    })
    reset.style.visibility = value ? 'visible' : 'hidden'
    view.requestMeasure()
  }
  function measure() {
    return headers.map(header => header.getBoundingClientRect().width)
  }
  function transfer(values, index, delta) {
    const next = [...values]
    const pair = values[index] + values[index + 1]
    // In a narrow pane, fitting the table takes priority over the usual minimum.
    const minimum = Math.min(MIN_WIDTH, pair / 2)
    next[index] = Math.max(minimum, Math.min(pair - minimum, values[index] + delta))
    next[index + 1] = pair - next[index]
    return next
  }
  function stop(event) { event.preventDefault(); event.stopPropagation() }
  function finish(accept) {
    if (!drag) return
    const current = drag
    drag = null
    if (frame !== null) cancelAnimationFrame(frame)
    frame = null
    window.removeEventListener('blur', cancel)
    window.removeEventListener('keydown', escape, true)
    if (current.handle.hasPointerCapture?.(current.id)) current.handle.releasePointerCapture(current.id)
    wrapper.classList.remove('cm-lp-table-resizing')
    apply(accept ? current.widths : saved)
    if (accept) onCommit(current.widths)
  }
  function cancel() { finish(false) }
  function escape(event) {
    if (event.key === 'Escape') { stop(event); cancel() }
  }
  reset.addEventListener('mousedown', stop)
  reset.addEventListener('click', event => { stop(event); onCommit(null) })

  headers.slice(0, -1).forEach((header, index) => {
    const handle = document.createElement('span')
    handle.className = 'cm-lp-column-resize'
    handle.tabIndex = 0
    handle.setAttribute('role', 'separator')
    handle.setAttribute('aria-orientation', 'vertical')
    handle.setAttribute('aria-valuemin', '0')
    handle.setAttribute('aria-valuemax', '100')
    handle.setAttribute('aria-label', `Resize column ${index + 1}${header.textContent ? `: ${header.textContent}` : ''}`)
    handle.title = 'Drag to resize. Arrow keys change width.'
    handle.addEventListener('mousedown', stop)
    handle.addEventListener('click', stop)
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0 || drag) return
      stop(event)
      const values = measure()
      drag = { handle, id: event.pointerId, x: event.clientX, start: values, widths: values }
      handle.setPointerCapture(event.pointerId)
      wrapper.classList.add('cm-lp-table-resizing')
      window.addEventListener('blur', cancel)
      window.addEventListener('keydown', escape, true)
    })
    handle.addEventListener('pointermove', event => {
      if (!drag || drag.id !== event.pointerId) return
      drag.widths = transfer(drag.start, index, event.clientX - drag.x)
      if (frame === null) frame = requestAnimationFrame(() => {
        frame = null
        if (drag) apply(drag.widths)
      })
    })
    handle.addEventListener('pointerup', event => {
      if (drag?.id === event.pointerId) { stop(event); finish(true) }
    })
    handle.addEventListener('pointercancel', cancel)
    handle.addEventListener('lostpointercapture', cancel)
    handle.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return
      stop(event)
      const values = measure()
      onCommit(transfer(values, index, (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 32 : 8)))
    })
    handles.push(handle)
    header.append(handle)
  })
  const controller = {
    cancel,
    update(value, commit) { cancel(); saved = value; onCommit = commit; apply(saved) },
    destroy() { cancel(); controllers.delete(wrapper) },
  }
  controllers.set(wrapper, controller)
  apply(saved)
}
