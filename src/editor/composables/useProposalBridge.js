import { ref, onUnmounted } from 'vue'
import { findTargetText } from '../../services/ai/tools/textMatch.js'
import { matchInCleanContent } from '../../services/ai/tools/edit.js'
import { PROPOSAL_APPLY_EVENT, DIFF_OPEN_EVENT } from '../../shared/proposalEvents.js'

const SOURCE_REQUIRED = 'Open Source before applying a Markdown proposal to this Graph entry.'

export function computeDiffFromReview(review, fileContent) {
  if (!review?.targetText) return null
  const direct = findTargetText(fileContent, review.targetText)
  const match = direct || matchInCleanContent(fileContent, review.targetText)
  if (!match || match.error) return null
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
    const direct = findTargetText(fileContent, r.targetText)
    const match = direct || matchInCleanContent(fileContent, r.targetText)
    if (!match || match.error) continue
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

export function useProposalBridge({ getDocContent, applyChange, getDocPath, activateDiff, activateBatchDiff, openFileForDiff, stashFileReviews, canApply = () => true }) {
  const pendingProposal = ref(null)
  let unlistenApply = null
  let unlistenDiff = null
  let disposed = false

  async function setup() {
    if (typeof window === 'undefined' || !window.__TAURI_INTERNALS__) return
    const { listen } = await import('@tauri-apps/api/event')
    const { invoke } = await import('@tauri-apps/api/core')
    if (disposed) return

    function report(payload, status, detail) {
      return invoke('proposal_respond', {
        result: { id: payload.id, sessionId: payload.sessionId || payload.threadId, status, detail },
      }).catch(() => {})
    }

    function requireSource() {
      if (!canApply()) throw new Error(SOURCE_REQUIRED)
    }

    const stopApply = await listen(PROPOSAL_APPLY_EVENT, async (event) => {
      if (disposed) return
      const payload = event.payload
      try {
        requireSource()
        const targetPath = payload.absolutePath || payload.path
        if (!targetPath || targetPath !== getDocPath()) {
          throw new Error('This proposal belongs to another document. Open its Source tab before applying it.')
        }
        const docContent = getDocContent()
        const match = findTargetText(docContent, payload.targetText)
        if (!match) return report(payload, 'not-found', 'Target text not found in the current document')
        applyChange(match.from, match.to, payload.replacement)
        return report(payload, 'applied', 'Change applied successfully')
      } catch (error) {
        return report(payload, 'conflict', error?.message || String(error))
      }
    })
    if (disposed) { stopApply(); return }
    unlistenApply = stopApply

    const stopDiff = await listen(DIFF_OPEN_EVENT, async ({ payload }) => {
      if (disposed) return
      try {
        await openDiff(payload)
      } catch (error) {
        const proposals = payload.batch ? payload.files || [] : [payload]
        await Promise.all(proposals.filter(proposal => proposal.id).map(proposal => (
          report({ ...proposal, sessionId: proposal.sessionId || payload.sessionId }, 'conflict', error?.message || String(error))
        )))
      }
    })
    if (disposed) stopDiff()
    else unlistenDiff = stopDiff

    async function openDiff(payload) {
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
        await activateBatchDiff(fileList, { sessionId: payload.sessionId })
        return
      }

      // File-edit review: has proposal data (targetText + replacement)
      if (payload.id && (payload.targetText || payload.proposalType === 'create')) {
        if (openFileForDiff) {
          await openFileForDiff(payload.path, payload.original || payload.replacement || '')
        }
        if (disposed) return
        requireSource()

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
        if (disposed) return
        requireSource()
        activateDiff(payload.original, payload.modified, { review: { ids: [payload.id], sessionId: payload.sessionId, path: payload.path } })
        return
      }

      // Single-file mode (computes diff from targetText/replacement on current doc)
      if (!activateDiff) return
      requireSource()
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
    }
  }

  function cleanup() {
    disposed = true
    if (unlistenApply) { unlistenApply(); unlistenApply = null }
    if (unlistenDiff) { unlistenDiff(); unlistenDiff = null }
  }

  setup()

  onUnmounted(cleanup)

  return { pendingProposal, cleanup }
}
