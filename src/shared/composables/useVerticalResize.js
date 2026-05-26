import { ref, onMounted, onUnmounted } from 'vue'

export function useVerticalResize(initialHeight = 220, { min = 100, max = 600 } = {}) {
  const height = ref(initialHeight)
  const dragging = ref(false)

  let startY = 0
  let startHeight = 0

  function onPointerDown(e) {
    dragging.value = true
    startY = e.clientY
    startHeight = height.value
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    e.currentTarget?.setPointerCapture?.(e.pointerId)
    e.preventDefault()
  }

  function onPointerMove(e) {
    if (!dragging.value) return
    const delta = startY - e.clientY // up = bigger
    height.value = Math.max(min, Math.min(max, startHeight + delta))
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

  return { height, dragging, onPointerDown }
}
