import { watch, onUnmounted, nextTick } from 'vue'

function scrollPreviewToLine(previewEl, sourceLine) {
  const anchors = previewEl.querySelectorAll('[data-source-line]')
  if (!anchors.length) return

  let before = null, after = null
  for (const el of anchors) {
    const line = parseInt(el.dataset.sourceLine, 10)
    if (line <= sourceLine) before = { el, line }
    if (line >= sourceLine && !after) after = { el, line }
  }

  if (!before && !after) return
  if (!before) before = after
  if (!after) after = before

  let targetTop
  if (before.line === after.line) {
    targetTop = before.el.offsetTop
  } else {
    const frac = (sourceLine - before.line) / (after.line - before.line)
    targetTop = before.el.offsetTop + frac * (after.el.offsetTop - before.el.offsetTop)
  }

  previewEl.scrollTop = targetTop
}

export function useScrollSync(editorSurfaceRef, previewRef, enabled) {
  let rafId = null
  let suppressUntil = 0
  let currentListener = null
  let currentScrollDOM = null

  function onEditorScroll() {
    if (Date.now() < suppressUntil) return
    if (rafId) cancelAnimationFrame(rafId)
    rafId = requestAnimationFrame(() => {
      rafId = null
      const preview = previewRef.value
      const surface = editorSurfaceRef.value
      if (!preview || !surface) return

      const view = surface.getView()
      if (!view) return

      const { scrollDOM } = view
      const atBottom = scrollDOM.scrollTop + scrollDOM.clientHeight >= scrollDOM.scrollHeight - 1

      if (atBottom) {
        suppressUntil = Date.now() + 50
        preview.scrollTop = preview.scrollHeight
        return
      }

      const block = view.lineBlockAtHeight(scrollDOM.scrollTop)
      const lineNumber = view.state.doc.lineAt(block.from).number - 1

      suppressUntil = Date.now() + 50
      scrollPreviewToLine(preview, lineNumber)
    })
  }

  function attach() {
    const surface = editorSurfaceRef.value
    if (!surface) return
    const view = surface.getView()
    if (!view) return

    currentScrollDOM = view.scrollDOM
    currentListener = onEditorScroll
    currentScrollDOM.addEventListener('scroll', currentListener)
  }

  function detach() {
    if (rafId) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
    if (currentScrollDOM && currentListener) {
      currentScrollDOM.removeEventListener('scroll', currentListener)
      currentScrollDOM = null
      currentListener = null
    }
  }

  watch(enabled, (active) => {
    detach()
    if (active) {
      nextTick(() => attach())
    }
  }, { immediate: true })

  onUnmounted(() => detach())
}
