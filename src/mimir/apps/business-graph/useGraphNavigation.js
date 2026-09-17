import { nextTick, watch } from 'vue'
import { graphErrorMessage } from './graphErrors.js'

// Graph owns its projections. The workbench opens entries as Editor documents.
export function useGraphNavigation({ graph, root, workspaceSurface, appHeader, diagnostic, openGraphNode }) {
  let lastOpenedId = ''
  let entryFocusPending = false

  function openNode(request) {
    const target = typeof request === 'string' ? { id: request } : request
    if (!target?.id) return
    lastOpenedId = target.id
    openGraphNode(target)
  }

  function restoreGraphFocus(preferredNodeId = lastOpenedId, { allowFirst = true } = {}) {
    if (preferredNodeId && workspaceSurface.value?.focusNode?.(preferredNodeId)) return
    const candidates = [...(root.value?.querySelectorAll(
      '[data-board-card], [data-graph-node]',
    ) || [])]
    const target = candidates.find(candidate => (
      candidate.dataset.boardCard === preferredNodeId
      || candidate.dataset.graphNode === preferredNodeId
    ))
    if (target instanceof HTMLElement) {
      target.focus()
      return
    }
    if (!allowFirst || workspaceSurface.value?.focusListEdge?.('first')) return
    if (candidates[0] instanceof HTMLElement) candidates[0].focus()
    else appHeader.value?.focusSearch()
  }

  function focusEntry() {
    if (root.value?.contains(document.activeElement)) return
    if (graph.loading) {
      entryFocusPending = true
      root.value?.focus()
      return
    }
    restoreGraphFocus()
  }

  watch(() => graph.loading, async loading => {
    if (loading || !entryFocusPending) return
    entryFocusPending = false
    await nextTick()
    if (document.activeElement === root.value) restoreGraphFocus()
  })

  function setSection(section) {
    graph.setSection(section)
  }

  function setView(view) {
    graph.setView(view)
  }

  function toggleScope(scopeId) {
    void graph.toggleScope(scopeId).catch(cause => diagnostic(graphErrorMessage(cause)))
  }

  function refresh() {
    void graph.refresh({ reconcile: true }).catch(cause => diagnostic(graphErrorMessage(cause)))
  }

  return { focusEntry, openNode, refresh, restoreGraphFocus, setSection, setView, toggleScope }
}
