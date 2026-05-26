import { tool } from 'ai'
import { z } from 'zod'
import { withGate } from './gate'
import { resolveSafePath } from './textMatch'
import { checkPathAccess } from './pathPermission'

const PATH_ERROR = 'Path must be relative to the project folder. Traversal outside the project is blocked.'
const NO_PROJECT_ERROR = 'No project folder linked. Link a project first.'

export function createAnnotateDocxTool(context) {
  const workspacePath = context.projectPath || context.workspacePath || null
  const gateCtx = {
    sessionId: context.sessionId,
    policy: context.policy,
    onApprovalRequest: context.onApprovalRequest,
    projectPath: workspacePath,
    approvalMode: context.approvalMode,
  }

  function safePath(relativePath) {
    if (!workspacePath) return null
    return resolveSafePath(relativePath, workspacePath)
  }

  return {
    annotate_docx: tool({
      description: `Add review annotations to a Word manuscript (.docx). Creates a revision copy — the original is never modified.

Supports 4 operation types:
- add_comment: anchor to exact quoted text, adds a comment balloon
- reply_comment: threaded reply to an existing comment (needs commentId from read("file.docx", { docx_metadata: true }))
- tracked_insertion: insert text before/after/replacing an anchor phrase (appears as a tracked change in Word)
- tracked_deletion: delete matched text as a tracked change

Quote anchor text exactly as it appears in the document. The writer uses normalized whitespace matching as fallback, but exact matches are preferred.`,

      inputSchema: z.object({
        target: z.string().min(1).max(1000).describe('Relative path to the .docx file'),
        operations: z.array(z.object({
          type: z.enum(['add_comment', 'reply_comment', 'tracked_insertion', 'tracked_deletion']),
          anchorText: z.string().max(2000).optional(),
          commentText: z.string().max(5000).optional(),
          author: z.string().max(200).optional(),
          occurrenceIndex: z.number().int().min(0).optional(),
          parentCommentId: z.string().optional(),
          replyText: z.string().max(5000).optional(),
          commentId: z.string().optional(),
          insertionText: z.string().max(5000).optional(),
          position: z.enum(['before', 'after', 'replace']).optional(),
          deleteText: z.string().max(2000).optional(),
        })).min(1).max(100),
      }),

      execute: withGate('annotate_docx', async ({ target, operations } = {}) => {
        const resolved = safePath(target)
        if (!workspacePath) return { error: NO_PROJECT_ERROR }
        if (!resolved) return { error: PATH_ERROR }
        const denied = await checkPathAccess(resolved, 'annotate_docx', gateCtx)
        if (denied) return denied
        try {
          const { annotateDocx } = await import('../../docx/writer')
          const ops = operations.map(op => ({ author: 'Shoulders', ...op }))
          const result = await annotateDocx(resolved, ops)
          if (!result.success) return { error: result.error }
          return {
            outputPath: result.outputPath,
            summary: result.summary,
            results: result.results,
            validationErrors: result.validationErrors,
          }
        } catch (e) {
          return { error: `Annotation failed: ${e?.message || e}` }
        }
      }, gateCtx),
    }),
  }
}
