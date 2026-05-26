import { ref, onMounted, onUnmounted } from 'vue'

export function useSidebarResize(initialWidth = 240, { min = 180, max = 450, side = 'left' } = {}) {
  const width = ref(initialWidth)
  const dragging = ref(false)

  let startX = 0
  let startWidth = 0

  function onPointerDown(e) {
    dragging.value = true
    startX = e.clientX
    startWidth = width.value
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    e.currentTarget?.setPointerCapture?.(e.pointerId)
    e.preventDefault()
  }

  function onPointerMove(e) {
    if (!dragging.value) return
    const dx = e.clientX - startX
    const delta = side === 'right' ? -dx : dx
    width.value = Math.max(min, Math.min(max, startWidth + delta))
  }

  function onPointerUp() {
    if (!dragging.value) return
    dragging.value = false
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }

  onMounted(() => {
    document.addEventListener('pointermove', onPointerMove)
    document.addEventListener('pointerup', onPointerUp)
    document.addEventListener('pointercancel', onPointerUp)
  })

  onUnmounted(() => {
    document.removeEventListener('pointermove', onPointerMove)
    document.removeEventListener('pointerup', onPointerUp)
    document.removeEventListener('pointercancel', onPointerUp)
  })

  return { width, dragging, onPointerDown }
}
