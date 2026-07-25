import { tool } from 'ai'
import { z } from 'zod'
import { withGate } from './gate'
import { readDocument, limitText, MAX_TOOL_OUTPUT_CHARS } from './helpers'
import { resolveSafePath } from './textMatch'
import { stripCommentTags, parseCommentTags } from '../../comments/parser.js'

export function createReadTool(context = {}) {
  const workspacePath = context.workspacePath || context.projectPath || null
  const readHistory = context._readHistory || new Set()

  return {
    read: tool({
      description: `Read content from the workbench.
@editor reads the current document. Any other target reads a text file inside the active workspace.
Set show_comments to include the canonical inline review annotations.`,
      inputSchema: z.object({
        target: z.string().min(1).max(500),
        show_comments: z.boolean().optional(),
        max_chars: z.number().int().min(500).max(60_000).optional(),
      }),
      execute: withGate('read', async ({
        target,
        show_comments = false,
        max_chars = MAX_TOOL_OUTPUT_CHARS,
      } = {}) => {
        if (target === '@editor') {
          const document = await readDocument(context.getDocument || null)
          let rawContent = document.content
          let commentCount = 0
          if (show_comments) {
            const { comments } = parseCommentTags(rawContent)
            commentCount = comments.filter(comment => comment.status === 'active').length
          } else {
            rawContent = stripCommentTags(rawContent)
          }

          const content = limitText(rawContent, max_chars)
          const isReread = readHistory.has(document.documentId)
          readHistory.add(document.documentId)
          return {
            documentId: document.documentId,
            title: document.title,
            path: document.path || null,
            truncated: content.length < rawContent.length,
            characters: document.content.length,
            content,
            ...(commentCount > 0 ? {
              note_comments: `${commentCount} active comment(s) are represented as <comment> tags. Preserve them unless explicitly asked to change review annotations.`,
            } : {}),
            ...(isReread ? {
              note: 'This is an updated read. Previous reads of this document in this conversation are stale.',
            } : {}),
          }
        }

        if (target.startsWith('@')) return { error: `Unknown workbench target: ${target}` }
        const safePath = resolveSafePath(target, workspacePath)
        if (!safePath) {
          return { error: 'Path traversal blocked. Path must stay within the active workspace.' }
        }

        try {
          const { invoke } = await import('@tauri-apps/api/core')
          const response = await invoke('read_text_file', { path: safePath })
          const rawContent = show_comments ? response.content : stripCommentTags(response.content)
          const content = limitText(rawContent, max_chars)
          return {
            path: target,
            characters: rawContent.length,
            truncated: rawContent.length > max_chars,
            content,
          }
        } catch (error) {
          return { error: `Failed to read file: ${error?.message || error}` }
        }
      }),
    }),
  }
}
