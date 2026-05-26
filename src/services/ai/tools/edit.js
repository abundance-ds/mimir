import { tool } from 'ai'
import { z } from 'zod'
import { withGate } from './gate'
import { readDocument } from './helpers'
import { isAtPath, resolveAtPath } from './pathHandlers'
import { resolveSafePath, findTargetText, countMatches } from './textMatch'
import { checkPathAccess } from './pathPermission'
import { parseCommentTags, cleanToRawPos } from '../../comments/parser'

function generateProposalId() {
  return `file_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

export function matchInCleanContent(rawContent, oldText) {
  const { cleanText, offsetMap } = parseCommentTags(rawContent)
  const matchCount = countMatches(cleanText, oldText)
  if (matchCount === 0) return { error: 'not_found' }
  if (matchCount > 1) return { error: 'ambiguous', count: matchCount }
  const match = findTargetText(cleanText, oldText)
  if (!match) return { error: 'not_found' }
  return {
    from: cleanToRawPos(offsetMap, match.from),
    to: cleanToRawPos(offsetMap, match.to),
  }
}

export function createEditTool(context) {
  const workspacePath = context.workspacePath || context.projectPath || null
  const onProposal = context.onProposal || (() => {})
  const gateCtx = {
    sessionId: context.sessionId,
    policy: context.policy,
    onApprovalRequest: context.onApprovalRequest,
    projectPath: workspacePath,
    approvalMode: context.approvalMode,
  }
  const isBypass = () => (context.approvalMode || 'normal') === 'bypass'

  return {
    edit: tool({
      description:
        'Edit existing content via search-and-replace.\n' +
        '@editor → propose document edit (diff review). Project path → file edit (diff review).\n' +
        '@issues/, @knowledge/, @skills/, @apps/ → direct write. old_text must match exactly once.\n' +
        'Cannot create files, edit .docx, or read content.',
      inputSchema: z.object({
        target: z.string().min(1).max(500),
        old_text: z.string().min(1).max(50_000),
        new_text: z.string().max(50_000),
        rationale: z.string().max(2_000).optional(),
      }),
      execute: withGate('edit', async ({ target, old_text, new_text, rationale }) => {

        if (target === '@editor' || target.startsWith('@editor/')) {
          const document = await readDocument(context.getDocument || null)
          if (!document.content) return { error: 'No document open.' }
          const proposal = {
            id: `proposal_${Date.now()}_${Array.from(crypto.getRandomValues(new Uint8Array(6)), b => b.toString(36)).join('')}`,
            type: 'edit',
            targetText: old_text,
            replacement: new_text,
            rationale: rationale || '',
            createdAt: new Date().toISOString(),
            status: 'pending',
          }
          await onProposal(proposal)
          return { proposalId: proposal.id, status: 'pending_review', message: 'Edit proposed for the current document. Awaiting user review.' }
        }

        if (isAtPath(target)) {
          const resolved = await resolveAtPath(target, { projectId: context.projectId })
          if (resolved.error) return { error: resolved.error }
          const { handler, absolutePath } = resolved
          const { invoke } = await import('@tauri-apps/api/core')
          const resp = await invoke('read_text_file', { path: absolutePath })
          const fileContent = resp.content
          const matchCount = countMatches(fileContent, old_text)
          if (matchCount === 0) return { error: `Text not found in ${target}. Provide the exact text.` }
          if (matchCount > 1) return { error: `Text matches ${matchCount} locations in ${target}. Provide a longer, unique passage.` }
          const match = findTargetText(fileContent, old_text)
          if (!match) return { error: `Text not found in ${target} (match failed after count check).` }
          const modified = fileContent.slice(0, match.from) + new_text + fileContent.slice(match.to)
          if (handler.validate) {
            const validation = handler.validate(modified, target.split('/').pop())
            if (!validation.ok) return { error: validation.error }
          }
          await invoke('write_text_file', { path: absolutePath, content: modified })
          if (handler.afterWrite) await handler.afterWrite({ projectId: context.projectId })
          return { path: target, status: 'edited', characters: modified.length }
        }

        if (!workspacePath) return { error: 'No project folder linked.' }
        const safePath = resolveSafePath(target, workspacePath)
        if (!safePath) return { error: 'Path traversal blocked. Path must stay within the project folder.' }
        const denied = await checkPathAccess(safePath, 'edit', gateCtx)
        if (denied) return denied

        try {
          const { invoke } = await import('@tauri-apps/api/core')
          const resp = await invoke('read_text_file', { path: safePath })
          const fileContent = resp.content
          let from, to
          const matchCount = countMatches(fileContent, old_text)
          if (matchCount === 1) {
            const match = findTargetText(fileContent, old_text)
            if (!match) return { error: `Text not found in ${target} (match failed after count check).` }
            from = match.from
            to = match.to
          } else if (matchCount === 0) {
            const clean = matchInCleanContent(fileContent, old_text)
            if (clean.error === 'not_found') return { error: `Text not found in ${target}. Verify the exact content you want to replace.` }
            if (clean.error === 'ambiguous') return { error: `Text matches ${clean.count} locations in ${target}. Provide a longer, unique passage.` }
            from = clean.from
            to = clean.to
          } else {
            return { error: `Text matches ${matchCount} locations in ${target}. Provide a longer, unique passage.` }
          }
          const modified = fileContent.slice(0, from) + new_text + fileContent.slice(to)
          const proposalId = generateProposalId()

          if (isBypass()) {
            await invoke('write_text_file', { path: safePath, content: modified })
            onProposal({ id: proposalId, type: 'edit', path: target, targetText: old_text, replacement: new_text, status: 'accepted' })
            return { path: target, status: 'edited', characters: modified.length }
          }

          onProposal({ id: proposalId, type: 'edit', path: target, absolutePath: safePath, targetText: old_text, replacement: new_text, status: 'pending' })
          return { proposalId, path: target, status: 'pending_review', message: 'Edit proposed. Awaiting user review.' }
        } catch (e) {
          return { error: `Failed to edit file: ${e?.message || e}` }
        }
      }, gateCtx),
    }),
  }
}
