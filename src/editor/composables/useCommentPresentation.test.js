import { describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope, shallowRef } from 'vue'
import { useCommentsStore } from '../../stores/comments.js'
import { useCommentPresentation } from './useCommentPresentation.js'

function comment(id, contentFrom, status = 'active') {
  return { id, contentFrom, contentTo: contentFrom + 5, status }
}

function setup() {
  setActivePinia(createPinia())
  const dispatches = []
  const view = {
    state: { selection: { main: { head: 25 } } },
    dispatch(spec) {
      dispatches.push(spec)
    },
  }
  const surface = {
    getView: () => view,
    scrollToPos: vi.fn(),
    focus: vi.fn(),
  }
  const editorSurfaceRef = shallowRef(surface)
  const commentManager = useCommentsStore()
  const scope = effectScope()
  const presentation = scope.run(() => useCommentPresentation(editorSurfaceRef, commentManager))
  return { commentManager, dispatches, presentation, scope, surface }
}

describe('useCommentPresentation', () => {
  it('projects store presentation state into CodeMirror', () => {
    const { commentManager, dispatches, scope } = setup()
    dispatches.length = 0

    commentManager.updateCommentsFromState([comment('r1', 10, 'resolved')])
    commentManager.setResolvedCommentsVisible(true)

    expect(dispatches).toHaveLength(1)
    expect(dispatches[0].effects.map(effect => effect.value)).toEqual([null, true])
    scope.stop()
  })

  it('navigates the store-visible comments and restores editor focus', () => {
    const { commentManager, presentation, scope, surface } = setup()
    commentManager.updateCommentsFromState([
      comment('a1', 10),
      comment('r1', 30, 'resolved'),
      comment('a2', 50),
    ])

    expect(presentation.navigateComment('next')).toBe(true)
    expect(commentManager.activeCommentId).toBe('a2')
    expect(surface.scrollToPos).toHaveBeenCalledWith(50)
    expect(surface.focus).toHaveBeenCalledOnce()

    commentManager.setResolvedCommentsVisible(true)
    commentManager.setActiveComment('a1')
    presentation.navigateComment('next')
    expect(commentManager.activeCommentId).toBe('r1')
    scope.stop()
  })

  it('resets active and resolved presentation state together', () => {
    const { commentManager, presentation, scope } = setup()
    commentManager.updateCommentsFromState([comment('r1', 10, 'resolved')])
    commentManager.setResolvedCommentsVisible(true)
    commentManager.setActiveComment('r1')

    presentation.reset()
    expect(commentManager.activeCommentId).toBe(null)
    expect(commentManager.resolvedCommentsVisible).toBe(false)
    scope.stop()
  })
})
