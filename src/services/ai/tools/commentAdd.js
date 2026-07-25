import { tool } from 'ai'
import { z } from 'zod'
import { withGate } from './gate'
import { parseCommentTags, cleanToRawPos, buildCommentTag } from '../../comments/parser'
import { resolveSafePath } from './textMatch'

export function createCommentAddTool(context = {}) {
  const workspacePath = context.workspacePath || context.projectPath || null

  return {
    comment_add: tool({
      description: 'Add a review comment anchored to a text passage. Use read("@editor", { show_comments: true }) to see existing comments.',
      inputSchema: z.object({
        target: z.string().min(1).max(500).describe('File path or @editor'),
        anchor_text: z.string().min(1).max(2000),
        text: z.string().min(1).max(4000),
      }),
      execute: withGate('comment_add', async ({ target, anchor_text, text }) => {
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

          const { comments, cleanText, offsetMap } = parseCommentTags(rawContent)
          const idx = cleanText.indexOf(anchor_text)
          if (idx === -1) return { error: 'Could not find anchor_text in the document. Ensure it matches exactly.' }
          if (cleanText.indexOf(anchor_text, idx + anchor_text.length) !== -1) {
            return { error: 'anchor_text matches more than one passage. Provide a longer, unique anchor.' }
          }

          const rawFrom = cleanToRawPos(offsetMap, idx)
          const rawTo = cleanToRawPos(offsetMap, idx + anchor_text.length)

          const overlaps = comments.some(c => rawFrom < c.tagTo && rawTo > c.tagFrom)
          if (overlaps) return { error: 'Anchor text overlaps with an existing comment. Choose a non-overlapping passage.' }

          const id = Math.random().toString(36).slice(2, 6)
          const tag = buildCommentTag({ id, author: 'ai', text, created: new Date().toISOString(), anchorText: anchor_text })
          const modified = rawContent.slice(0, rawFrom) + tag + rawContent.slice(rawTo)

          if (target === '@editor' && context.setDocument) {
            await context.setDocument(modified)
          } else {
            if (!resolvedPath) return { error: 'No file path available. Open a document or provide a path.' }
            await invoke('write_text_file', { path: resolvedPath, content: modified })
            await emit('mim://file-updated', { path: resolvedPath, content: modified })
          }

          return { comment_id: id, status: 'created', anchor: anchor_text.slice(0, 80) }
        } catch (err) {
          return { error: err?.message || err }
        }
      }),
    }),
  }
}
