import { watch } from 'vue'
import {
  setActiveComment as setActiveCommentEffect,
  setResolvedCommentsVisible as setResolvedCommentsVisibleEffect,
} from '../codemirror/comments.js'
import { commentNavigationTarget } from '../commentNavigation.js'

export function useCommentPresentation(editorSurfaceRef, commentManager) {
  function getView() {
    return editorSurfaceRef.value?.getView?.() || null
  }

  function syncView() {
    const view = getView()
    if (!view) return
    view.dispatch({
      effects: [
        setActiveCommentEffect.of(commentManager.activeCommentId),
        setResolvedCommentsVisibleEffect.of(commentManager.resolvedCommentsVisible),
      ],
    })
  }

  watch(
    [
      () => commentManager.activeCommentId,
      () => commentManager.resolvedCommentsVisible,
      () => editorSurfaceRef.value,
    ],
    syncView,
    { immediate: true, flush: 'sync' },
  )

  function navigateComment(direction) {
    const view = getView()
    const target = commentNavigationTarget(commentManager.visibleComments, {
      activeId: commentManager.activeCommentId,
      cursorPos: view?.state.selection.main.head ?? 0,
      direction,
    })
    if (!target) return false

    commentManager.setActiveComment(target.id)
    editorSurfaceRef.value?.scrollToPos?.(target.contentFrom)
    editorSurfaceRef.value?.focus?.()
    return true
  }

  return {
    navigateComment,
    reset: () => commentManager.resetPresentation(),
    hideResolvedComments: () => commentManager.setResolvedCommentsVisible(false),
    toggleResolvedComments: () => commentManager.toggleResolvedComments(),
  }
}
