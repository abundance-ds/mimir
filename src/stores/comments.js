import { ref, computed, shallowRef } from 'vue'
import { defineStore } from 'pinia'

export const useCommentsStore = defineStore('comments', () => {
  const comments = shallowRef([])
  const activeCommentId = ref(null)
  const resolvedCommentsVisible = ref(false)

  const activeComment = computed(() => {
    if (!activeCommentId.value) return null
    return comments.value.find(c => c.id === activeCommentId.value) || null
  })

  const resolvedCommentCount = computed(() => (
    comments.value.filter(comment => comment.status === 'resolved').length
  ))

  const visibleComments = computed(() => comments.value
    .filter(comment => resolvedCommentsVisible.value || comment.status !== 'resolved')
    .slice()
    .sort((a, b) => (a.contentFrom ?? 0) - (b.contentFrom ?? 0)))

  function updateCommentsFromState(parsedComments) {
    comments.value = parsedComments
    const active = parsedComments.find(comment => comment.id === activeCommentId.value)
    if (activeCommentId.value && (!active || (!resolvedCommentsVisible.value && active.status === 'resolved'))) {
      activeCommentId.value = null
    }
    if (!parsedComments.some(comment => comment.status === 'resolved')) {
      resolvedCommentsVisible.value = false
    }
  }

  function commentsForFile() {
    return comments.value
      .slice()
      .sort((a, b) => (a.contentFrom ?? 0) - (b.contentFrom ?? 0))
  }

  function setActiveComment(id) {
    activeCommentId.value = id
  }

  function setResolvedCommentsVisible(visible) {
    resolvedCommentsVisible.value = Boolean(visible)
    if (!resolvedCommentsVisible.value && activeComment.value?.status === 'resolved') {
      activeCommentId.value = null
    }
  }

  function toggleResolvedComments() {
    setResolvedCommentsVisible(!resolvedCommentsVisible.value)
  }

  function resetPresentation() {
    activeCommentId.value = null
    resolvedCommentsVisible.value = false
  }

  function findActiveByRange(from, to) {
    return comments.value.find(c =>
      c.contentFrom === from &&
      c.contentTo === to
    ) || null
  }

  return {
    comments,
    activeCommentId,
    activeComment,
    resolvedCommentsVisible,
    resolvedCommentCount,
    visibleComments,
    updateCommentsFromState,
    commentsForFile,
    setActiveComment,
    setResolvedCommentsVisible,
    toggleResolvedComments,
    resetPresentation,
    findActiveByRange,
  }
})
