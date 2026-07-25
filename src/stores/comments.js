import { ref, computed, shallowRef } from 'vue'
import { defineStore } from 'pinia'

export const useCommentsStore = defineStore('comments', () => {
  const comments = shallowRef([])
  const activeCommentId = ref(null)

  const activeComment = computed(() => {
    if (!activeCommentId.value) return null
    return comments.value.find(c => c.id === activeCommentId.value) || null
  })

  function updateCommentsFromState(parsedComments) {
    comments.value = parsedComments
  }

  function commentsForFile(filePath) {
    return comments.value
      .filter(c => !filePath || true)
      .sort((a, b) => (a.contentFrom ?? 0) - (b.contentFrom ?? 0))
  }

  function setActiveComment(id) {
    activeCommentId.value = id
  }

  function findActiveByRange(filePath, from, to) {
    return comments.value.find(c =>
      c.contentFrom === from &&
      c.contentTo === to
    ) || null
  }

  function commentAdded() {
  }

  return {
    comments,
    activeCommentId,
    activeComment,
    updateCommentsFromState,
    commentsForFile,
    setActiveComment,
    findActiveByRange,
    commentAdded,
  }
})
