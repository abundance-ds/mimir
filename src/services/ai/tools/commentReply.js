import { tool } from 'ai'
import { z } from 'zod'
import { withGate } from './gate'
import { parseCommentTags, escapeAttr } from '../../comments/parser'
import { resolveSafePath } from './textMatch'

export function createCommentReplyTool(context = {}) {
  const workspacePath = context.workspacePath || context.projectPath || null

  return {
    comment_reply: tool({
      description: 'Reply to an existing comment thread.',
      inputSchema: z.object({
        target: z.string().min(1).max(500).describe('File path or @editor'),
        comment_id: z.string().min(1),
        text: z.string().min(1).max(4000),
      }),
      execute: withGate('comment_reply', async ({ target, comment_id, text }) => {
        try {
          const { readDocument } = await import('./helpers.js')
          const { invoke } = await import('@tauri-apps/api/core')
          const { emit } = await import('@tauri-apps/api/event')

          let resolvedPath = target
          let rawContent

          if (target === '@editor') {
            const doc = await readDocument(context.getDocument || null)
            resolvedPath = doc.path
            rawContent = doc.content
          } else {
            resolvedPath = resolveSafePath(target, workspacePath)
            if (!resolvedPath) return { error: 'Path must stay inside the active workspace.' }
            rawContent = (await invoke('read_text_file', { path: resolvedPath })).content
          }

          if (!rawContent) return { error: 'Document is empty.' }

          const { comments } = parseCommentTags(rawContent)
          const comment = comments.find(c => c.id === comment_id)
          if (!comment) return { error: `Comment "${comment_id}" not found.` }

          const replyId = Math.random().toString(36).slice(2, 5)
          const replyTag = `<reply id="${escapeAttr(replyId)}" author="ai" text="${escapeAttr(text)}" ts="${new Date().toISOString()}"/>`

          const insertPos = comment.tagTo - '</comment>'.length
          const modified = rawContent.slice(0, insertPos) + replyTag + rawContent.slice(insertPos)

          if (target === '@editor' && context.setDocument) {
            await context.setDocument(modified)
          } else {
            if (!resolvedPath) return { error: 'No file path available. Open a document or provide a path.' }
            await invoke('write_text_file', { path: resolvedPath, content: modified })
            await emit('mimir://file-updated', { path: resolvedPath, content: modified })
          }

          return { reply_id: replyId, comment_id, status: 'replied' }
        } catch (err) {
          return { error: err?.message || err }
        }
      }),
    }),
  }
}
