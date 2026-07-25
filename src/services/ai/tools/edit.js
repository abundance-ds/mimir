import { tool } from 'ai'
import { z } from 'zod'
import { withGate } from './gate'
import { readDocument } from './helpers'
import { resolveSafePath, findTargetText, countMatches } from './textMatch'
import { parseCommentTags, cleanToRawPos } from '../../comments/parser'

function generateProposalId(prefix = 'file') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
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

function findUniqueRange(fileContent, oldText) {
  const matchCount = countMatches(fileContent, oldText)
  if (matchCount === 1) return findTargetText(fileContent, oldText)
  if (matchCount > 1) return { error: 'ambiguous', count: matchCount }
  return matchInCleanContent(fileContent, oldText)
}

export function createEditTool(context = {}) {
  const workspacePath = context.workspacePath || context.projectPath || null
  const onProposal = context.onProposal || (() => {})

  return {
    edit: tool({
      description:
        'Edit existing content with a unique search-and-replace. ' +
        '@editor creates an inline diff proposal for review; workspace paths are written directly. ' +
        'Canonical comment tags are preserved when matching visible document text.',
      inputSchema: z.object({
        target: z.string().min(1).max(500),
        old_text: z.string().min(1).max(50_000),
        new_text: z.string().max(50_000),
        rationale: z.string().max(2_000).optional(),
      }),
      execute: withGate('edit', async ({ target, old_text, new_text, rationale }) => {
        if (target === '@editor') {
          const document = await readDocument(context.getDocument || null)
          if (!document.content) return { error: 'No document is open.' }
          const proposal = {
            id: generateProposalId('proposal'),
            type: 'edit',
            targetText: old_text,
            replacement: new_text,
            rationale: rationale || '',
            createdAt: new Date().toISOString(),
            status: 'pending',
          }
          await onProposal(proposal)
          return {
            proposalId: proposal.id,
            status: 'pending_review',
            message: 'Edit proposed in the editor for review.',
          }
        }

        if (!workspacePath) return { error: 'No workspace folder is open.' }
        if (target.startsWith('@')) return { error: `Unknown workbench target: ${target}` }
        const safePath = resolveSafePath(target, workspacePath)
        if (!safePath) return { error: 'Path must stay inside the active workspace.' }

        try {
          const { invoke } = await import('@tauri-apps/api/core')
          const response = await invoke('read_text_file', { path: safePath })
          const range = findUniqueRange(response.content, old_text)
          if (!range || range.error === 'not_found') {
            return { error: `Text not found in ${target}. Verify the exact content.` }
          }
          if (range.error === 'ambiguous') {
            return { error: `Text matches ${range.count} locations in ${target}. Provide a longer, unique passage.` }
          }

          const modified = response.content.slice(0, range.from) + new_text + response.content.slice(range.to)
          await invoke('write_text_file', { path: safePath, content: modified })
          onProposal({
            id: generateProposalId(),
            type: 'edit',
            path: target,
            targetText: old_text,
            replacement: new_text,
            status: 'accepted',
          })
          return { path: target, status: 'edited', characters: modified.length }
        } catch (error) {
          return { error: `Failed to edit file: ${error?.message || error}` }
        }
      }),
    }),
  }
}
