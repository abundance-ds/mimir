import { ref, watch, onUnmounted } from 'vue'

export function useCommentPositions({ comments, activeCommentId, editorSurfaceRef }) {
  const positions = ref({})
  const cardHeights = {}  // plain object, not reactive — commentId → measured height (px)
  const cardObservers = new Map()  // commentId → ResizeObserver
  const GAP = 12
  const FALLBACK_HEIGHT = 80

  function registerCardRef(el, id) {
    // Clean up old observer for this id
    if (cardObservers.has(id)) {
      cardObservers.get(id).disconnect()
      cardObservers.delete(id)
    }
    if (!el) return

    // Measure initial height
    cardHeights[id] = el.offsetHeight || FALLBACK_HEIGHT

    // Watch for height changes (expanding/collapsing)
    const observer = new ResizeObserver((entries) => {
      const h = entries[0]?.target.offsetHeight
      if (h && cardHeights[id] !== h) {
        cardHeights[id] = h
        requestAnimationFrame(recalculate)
      }
    })
    observer.observe(el)
    cardObservers.set(id, observer)
  }

  function recalculate() {
    const surface = editorSurfaceRef.value
    if (!surface) return

    const view = surface.getView()
    if (!view) return

    const commentList = comments.value || []
    if (commentList.length === 0) {
      positions.value = {}
      return
    }

    // Prune stale cardHeights entries
    const currentIds = new Set(commentList.map(c => c.id))
    for (const id of Object.keys(cardHeights)) {
      if (!currentIds.has(id)) delete cardHeights[id]
    }

    // Build layout items with idealTop from lineBlockAt (document-relative, always available)
    const layoutItems = []
    for (const c of commentList) {
      const posFrom = c.contentFrom ?? c.range?.from
      if (posFrom == null) continue
      const safePos = Math.min(posFrom, view.state.doc.length)
      const block = view.lineBlockAt(safePos)
      const idealTop = block.top

      layoutItems.push({
        id: c.id,
        idealTop,
        height: cardHeights[c.id] || FALLBACK_HEIGHT,
        finalTop: idealTop,
      })
    }

    // Sort by document position (idealTop)
    layoutItems.sort((a, b) => a.idealTop - b.idealTop)

    if (layoutItems.length === 0) {
      positions.value = {}
      return
    }

    // Find active comment index
    const activeId = activeCommentId.value
    let activeIndex = -1
    if (activeId) {
      activeIndex = layoutItems.findIndex(item => item.id === activeId)
    }

    if (activeIndex !== -1) {
      // Active-First Gravity: active card pins to its anchor
      layoutItems[activeIndex].finalTop = layoutItems[activeIndex].idealTop

      // Push predecessors upward
      for (let i = activeIndex - 1; i >= 0; i--) {
        const current = layoutItems[i]
        const next = layoutItems[i + 1]
        current.finalTop = current.idealTop
        if (current.finalTop + current.height + GAP > next.finalTop) {
          current.finalTop = next.finalTop - current.height - GAP
        }
      }

      // Push successors downward
      for (let i = activeIndex + 1; i < layoutItems.length; i++) {
        const current = layoutItems[i]
        const prev = layoutItems[i - 1]
        current.finalTop = current.idealTop
        if (current.finalTop < prev.finalTop + prev.height + GAP) {
          current.finalTop = prev.finalTop + prev.height + GAP
        }
      }
    } else {
      // Simple waterfall (no active comment)
      for (let i = 0; i < layoutItems.length; i++) {
        layoutItems[i].finalTop = layoutItems[i].idealTop
        if (i > 0) {
          const prev = layoutItems[i - 1]
          if (layoutItems[i].finalTop < prev.finalTop + prev.height + GAP) {
            layoutItems[i].finalTop = prev.finalTop + prev.height + GAP
          }
        }
      }
    }

    // Clamp: no card above document start
    for (const item of layoutItems) {
      if (item.finalTop < 0) item.finalTop = 0
    }

    // Update positions ref
    const newPositions = {}
    for (const item of layoutItems) {
      newPositions[item.id] = item.finalTop
    }
    positions.value = newPositions
  }

  // Watch for changes that require recalculation
  watch(comments, () => requestAnimationFrame(recalculate), { deep: true })
  watch(activeCommentId, () => requestAnimationFrame(recalculate))

  // Cleanup ResizeObservers
  onUnmounted(() => {
    for (const observer of cardObservers.values()) {
      observer.disconnect()
    }
    cardObservers.clear()
  })

  return { positions, registerCardRef, recalculate }
}
