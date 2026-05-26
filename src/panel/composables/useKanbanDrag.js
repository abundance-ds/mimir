import { reactive, onUnmounted } from 'vue'

export function useKanbanDrag({ onDrop }) {
  const THRESHOLD = 5

  const dragState = reactive({
    active: false,
    entryId: '',
    fromStatus: '',
    ghostX: 0,
    ghostY: 0,
    dropStatus: '',
    dropIndex: -1,
  })

  let startX = 0
  let startY = 0

  function startDrag(entryId, fromStatus, e) {
    if (e.button !== 0) return
    dragState.entryId = entryId
    dragState.fromStatus = fromStatus
    dragState.active = false
    dragState.dropStatus = ''
    dragState.dropIndex = -1
    startX = e.clientX
    startY = e.clientY

    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
    document.addEventListener('keydown', onKey)
  }

  function onMove(e) {
    const dx = e.clientX - startX
    const dy = e.clientY - startY

    if (!dragState.active) {
      if (Math.abs(dx) < THRESHOLD && Math.abs(dy) < THRESHOLD) return
      dragState.active = true
      document.body.classList.add('select-none')
    }

    dragState.ghostX = e.clientX
    dragState.ghostY = e.clientY

    const cols = document.querySelectorAll('[data-kanban-column]')
    let targetStatus = ''
    let targetIndex = -1

    for (const col of cols) {
      const rect = col.getBoundingClientRect()
      if (e.clientX >= rect.left && e.clientX <= rect.right &&
          e.clientY >= rect.top && e.clientY <= rect.bottom) {
        targetStatus = col.dataset.kanbanColumn

        const cards = col.querySelectorAll('[data-kanban-card]')
        targetIndex = cards.length
        for (let i = 0; i < cards.length; i++) {
          const cardRect = cards[i].getBoundingClientRect()
          const mid = cardRect.top + cardRect.height / 2
          if (e.clientY < mid) {
            targetIndex = i
            break
          }
        }
        break
      }
    }

    dragState.dropStatus = targetStatus
    dragState.dropIndex = targetIndex
  }

  function onUp() {
    if (dragState.active && dragState.dropStatus) {
      onDrop(dragState.entryId, dragState.dropStatus)
    }
    cleanup()
  }

  function onKey(e) {
    if (e.key === 'Escape') cleanup()
  }

  function cleanup() {
    dragState.active = false
    dragState.entryId = ''
    dragState.fromStatus = ''
    dragState.dropStatus = ''
    dragState.dropIndex = -1
    document.body.classList.remove('select-none')
    document.removeEventListener('pointermove', onMove)
    document.removeEventListener('pointerup', onUp)
    document.removeEventListener('keydown', onKey)
  }

  function isDragging(entryId) {
    return dragState.active && dragState.entryId === entryId
  }

  function isDropTarget(status, index) {
    return dragState.active && dragState.dropStatus === status && dragState.dropIndex === index
  }

  onUnmounted(cleanup)

  return { dragState, startDrag, isDragging, isDropTarget }
}
