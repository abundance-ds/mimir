import { ref, onUnmounted } from 'vue'
import { findTargetText } from '../../services/ai/tools/textMatch.js'
import { PROPOSAL_APPLY_EVENT, DIFF_OPEN_EVENT } from '../../shared/proposalEvents.js'

const isTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__

export function computeDiffFromReview(review, fileContent) {
  if (!review?.targetText) return null
  const match = findTargetText(fileContent, review.targetText)
  if (!match) return null
  return {
    original: fileContent,
    modified: fileContent.slice(0, match.from) + review.replacement + fileContent.slice(match.to),
  }
}

export function computeCompoundDiff(reviews, fileContent) {
  if (!reviews?.length || !fileContent && fileContent !== '') return null
  const positioned = []
  for (const r of reviews) {
    if (!r.targetText) continue
    const match = findTargetText(fileContent, r.targetText)
    if (!match) continue
    positioned.push({ replacement: r.replacement || '', from: match.from, to: match.to })
  }
  if (positioned.length === 0) return null
  positioned.sort((a, b) => b.from - a.from)
  for (let i = 0; i < positioned.length - 1; i++) {
    if (positioned[i + 1].to > positioned[i].from) return null
  }
  let modified = fileContent
  for (const p of positioned) {
    modified = modified.slice(0, p.from) + p.replacement + modified.slice(p.to)
  }
  return { original: fileContent, modified }
}

export function useProposalBridge({ getDocContent, applyChange, getDocPath, activateDiff, activateBatchDiff, openFileForDiff, stashFileReviews }) {
  const pendingProposal = ref(null)
  let unlistenApply = null
  let unlistenDiff = null

  async function setup() {
    if (!isTauri) return
    const { listen } = await import('@tauri-apps/api/event')
    const { invoke } = await import('@tauri-apps/api/core')

    unlistenApply = await listen(PROPOSAL_APPLY_EVENT, (event) => {
      const payload = event.payload
      const docContent = getDocContent()
      const match = findTargetText(docContent, payload.targetText)

      if (match) {
        applyChange(match.from, match.to, payload.replacement)
        invoke('proposal_respond', {
          result: {
            id: payload.id,
            sessionId: payload.sessionId || payload.threadId,
            status: 'applied',
            detail: 'Change applied successfully',
          },
        }).catch(() => {})
      } else {
        invoke('proposal_respond', {
          result: {
            id: payload.id,
            sessionId: payload.sessionId || payload.threadId,
            status: 'not-found',
            detail: 'Target text not found in the current document',
          },
        }).catch(() => {})
      }
    })

    unlistenDiff = await listen(DIFF_OPEN_EVENT, async (event) => {
      const payload = event.payload

      // Batch mode: payload has a `files` array
      if (payload.batch && payload.files && activateBatchDiff) {
        const docContent = getDocContent()
        const fileList = payload.files.map(f => {
          if (f.original != null && f.modified != null) {
            return { path: f.path || getDocPath(), original: f.original, modified: f.modified, proposalId: f.id }
          }
          const original = docContent
          let modified = docContent
          if (f.targetText && f.replacement != null) {
            const match = findTargetText(docContent, f.targetText)
            if (match) {
              modified = docContent.slice(0, match.from) + f.replacement + docContent.slice(match.to)
            }
          }
          return { path: f.path || getDocPath(), original, modified, proposalId: f.id }
        })
        activateBatchDiff(fileList, { sessionId: payload.sessionId })
        return
      }

      // File-edit review: has proposal data (targetText + replacement)
      if (payload.id && (payload.targetText || payload.proposalType === 'create')) {
        if (openFileForDiff) {
          await openFileForDiff(payload.path, payload.original || payload.replacement || '')
        }

        const review = {
          proposalId: payload.id,
          sessionId: payload.sessionId,
          targetText: payload.targetText || '',
          replacement: payload.replacement || '',
          path: payload.path,
          type: payload.proposalType || 'edit',
        }

        if (stashFileReviews) stashFileReviews(review)

        const fileContent = getDocContent()
        const diff = computeDiffFromReview(review, fileContent)
        if (diff) {
          activateDiff(diff.original, diff.modified, { review: { ids: [payload.id], sessionId: payload.sessionId, path: payload.path } })
        } else if (payload.original != null && payload.modified != null) {
          activateDiff(payload.original, payload.modified, { review: { ids: [payload.id], sessionId: payload.sessionId, path: payload.path } })
        }
        return
      }

      // Legacy fallback: pre-computed original/modified
      if (payload.original != null && payload.modified != null && payload.id) {
        if (openFileForDiff) {
          await openFileForDiff(payload.path, payload.original)
        }
        activateDiff(payload.original, payload.modified, { review: { ids: [payload.id], sessionId: payload.sessionId, path: payload.path } })
        return
      }

      // Single-file mode (computes diff from targetText/replacement on current doc)
      if (!activateDiff) return
      const docContent = getDocContent()
      const original = docContent
      let modified = docContent

      if (payload.targetText && payload.replacement != null) {
        const match = findTargetText(docContent, payload.targetText)
        if (match) {
          modified = docContent.slice(0, match.from) + payload.replacement + docContent.slice(match.to)
        }
      } else if (payload.modifiedContent) {
        modified = payload.modifiedContent
      }

      if (original !== modified) {
        activateDiff(original, modified)
      }
    })
  }

  function cleanup() {
    if (unlistenApply) { unlistenApply(); unlistenApply = null }
    if (unlistenDiff) { unlistenDiff(); unlistenDiff = null }
  }

  setup()

  onUnmounted(cleanup)

  return { pendingProposal, cleanup }
}
