import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  loadGitFileDiff,
  loadGitReviewChanges,
  describeGitReviewError,
  normalizeGitScope,
  stageGitFile,
  unstageGitFile,
} from '../services/gitReview.js'

export const useGitReviewStore = defineStore('gitReview', () => {
  const workspacePath = ref('')
  const changes = ref([])
  const scope = ref('all')
  const changesLoading = ref(false)
  const changesError = ref('')
  const repositoryState = ref('idle')
  const active = ref(false)
  const loading = ref(false)
  const actionBusy = ref(false)
  const error = ref('')
  const notice = ref('')
  const review = ref(null)
  const requestedFile = ref('')
  let changesRequest = 0
  let reviewRequest = 0

  const visibleChanges = computed(() => changes.value.filter(change => (
    scope.value === 'all'
      || (scope.value === 'staged' ? change.staged : change.unstaged)
  )))
  const stagedCount = computed(() => changes.value.filter(change => change.staged).length)
  const unstagedCount = computed(() => changes.value.filter(change => change.unstaged).length)
  const conflictCount = computed(() => changes.value.filter(change => change.conflicted).length)
  const currentChange = computed(() => {
    const path = review.value?.path || requestedFile.value
    return path ? changes.value.find(change => change.path === path) || null : null
  })

  async function openWorkspace(path, { force = false } = {}) {
    const next = String(path || '').trim()
    if (!next) {
      clearWorkspace()
      return []
    }
    if (workspacePath.value !== next) {
      workspacePath.value = next
      changes.value = []
      scope.value = 'all'
      repositoryState.value = 'idle'
      deactivate()
    } else if (!force && changes.value.length) {
      return changes.value
    }
    return refreshChanges()
  }

  async function refreshChanges() {
    const path = workspacePath.value
    if (!path) return []
    const request = ++changesRequest
    changesLoading.value = true
    changesError.value = ''
    repositoryState.value = 'loading'
    try {
      const result = await loadGitReviewChanges(path)
      if (request !== changesRequest || path !== workspacePath.value) return changes.value
      changes.value = result
      repositoryState.value = 'ready'
      if (review.value && !result.some(change => change.path === review.value.path)) {
        deactivate()
      }
      return result
    } catch (cause) {
      if (request === changesRequest && path === workspacePath.value) {
        const failure = describeGitReviewError(cause)
        changes.value = []
        repositoryState.value = failure.kind
        changesError.value = failure.kind === 'error' ? failure.message : ''
      }
      return []
    } finally {
      if (request === changesRequest) changesLoading.value = false
    }
  }

  async function setScope(next) {
    scope.value = normalizeGitScope(next)
    if (!review.value) return
    const change = changes.value.find(candidate => candidate.path === review.value.path)
    const visible = change && (
      scope.value === 'all'
      || (scope.value === 'staged' ? change.staged : change.unstaged)
    )
    if (visible) await reviewFile(change.path, { scope: scope.value })
    else deactivate()
  }

  async function reviewFile(file, options = {}) {
    const path = String(options.workspacePath || workspacePath.value || '').trim()
    const nextScope = normalizeGitScope(options.scope || scope.value)
    if (path && workspacePath.value !== path) await openWorkspace(path, { force: true })
    const request = ++reviewRequest
    requestedFile.value = String(file || '')
    active.value = true
    loading.value = true
    error.value = ''
    notice.value = ''
    try {
      const value = await loadGitFileDiff(workspacePath.value, file, nextScope)
      if (request !== reviewRequest) return null
      review.value = value
      scope.value = nextScope
      return value
    } catch (cause) {
      if (request === reviewRequest) {
        review.value = null
        error.value = message(cause)
      }
      return null
    } finally {
      if (request === reviewRequest) loading.value = false
    }
  }

  async function stageCurrent() {
    return mutateCurrent('stage')
  }

  async function unstageCurrent() {
    return mutateCurrent('unstage')
  }

  async function mutateCurrent(action) {
    const current = review.value
    if (!current || actionBusy.value) return false
    actionBusy.value = true
    error.value = ''
    notice.value = ''
    try {
      const mutation = {
        workspacePath: workspacePath.value,
        file: current.path,
        scope: current.scope,
        expectedSnapshot: current.snapshot,
      }
      if (action === 'stage') await stageGitFile(mutation)
      else await unstageGitFile(mutation)
      await refreshChanges()
      const changed = changes.value.find(candidate => candidate.path === current.path)
      const staysVisible = changed && (
        scope.value === 'all'
        || (scope.value === 'staged' ? changed.staged : changed.unstaged)
      )
      if (staysVisible) await reviewFile(current.path, { scope: scope.value })
      else deactivate({ keepNotice: true })
      notice.value = action === 'stage'
        ? 'Staged. This file is ready for your next commit.'
        : 'Unstaged. The working file did not change.'
      return true
    } catch (cause) {
      error.value = message(cause)
      return false
    } finally {
      actionBusy.value = false
    }
  }

  function deactivate({ keepNotice = false } = {}) {
    reviewRequest += 1
    active.value = false
    loading.value = false
    error.value = ''
    review.value = null
    requestedFile.value = ''
    if (!keepNotice) notice.value = ''
  }

  function clearWorkspace() {
    changesRequest += 1
    workspacePath.value = ''
    changes.value = []
    changesLoading.value = false
    changesError.value = ''
    repositoryState.value = 'idle'
    scope.value = 'all'
    deactivate()
  }

  return {
    workspacePath,
    changes,
    scope,
    changesLoading,
    changesError,
    repositoryState,
    active,
    loading,
    actionBusy,
    error,
    notice,
    review,
    requestedFile,
    visibleChanges,
    stagedCount,
    unstagedCount,
    conflictCount,
    currentChange,
    openWorkspace,
    refreshChanges,
    setScope,
    reviewFile,
    stageCurrent,
    unstageCurrent,
    deactivate,
    clearWorkspace,
  }
})

function message(error) {
  return error instanceof Error ? error.message : String(error || 'Git review failed.')
}
