import { tool } from 'ai'
import { z } from 'zod'
import { withGate } from './gate'
import { readDocument, limitText, MAX_TOOL_OUTPUT_CHARS } from './helpers'
import { isAtPath, resolveAtPath } from './pathHandlers'
import { resolveSafePath } from './textMatch'
import { checkPathAccess } from './pathPermission'
import { stripCommentTags, parseCommentTags } from '../../comments/parser.js'

export function createReadTool(context) {
  const workspacePath = context.workspacePath || context.projectPath || null
  const gateCtx = {
    sessionId: context.sessionId,
    policy: context.policy,
    onApprovalRequest: context.onApprovalRequest,
    projectPath: workspacePath,
    approvalMode: context.approvalMode,
  }
  const readHistory = context._readHistory || new Set()

  return {
    read: tool({
      description: `Read content from a target path.
@editor → current document. @library.json → reference library.
path.docx → Word text (or use docx_metadata for comment/tracked-change metadata).
Any other path → project text file. Cannot write, search, or fetch URLs.`,
      inputSchema: z.object({
        target: z.string().min(1).max(500),
        show_comments: z.boolean().optional(),
        docx_metadata: z.boolean().optional(),
        max_chars: z.number().int().min(500).max(60_000).optional(),
      }),
      execute: withGate('read', async ({ target, show_comments = false, docx_metadata = false, max_chars = MAX_TOOL_OUTPUT_CHARS } = {}) => {
        // --- @-paths ---
        if (isAtPath(target)) {
          const resolved = await resolveAtPath(target, { projectId: context.projectId })
          if (!resolved) return { error: `Cannot resolve path: ${target}` }
          if (resolved.error) return { error: resolved.error }

          // @editor (virtual, empty subpath)
          if (resolved.virtual && resolved.subpath !== undefined) {
            const document = await readDocument(context.getDocument || null)
            let rawContent = document.content
            let commentCount = 0

            if (show_comments) {
              const { comments } = parseCommentTags(rawContent)
              commentCount = comments.filter(c => c.status === 'active').length
            } else {
              rawContent = stripCommentTags(rawContent)
            }

            const content = limitText(rawContent, max_chars)
            const docId = document.documentId
            const isReread = readHistory.has(docId)
            readHistory.add(docId)
            const result = {
              documentId: docId,
              title: document.title,
              path: document.path || null,
              truncated: content.length < rawContent.length,
              characters: document.content.length,
              content,
            }
            if (show_comments && commentCount > 0) {
              result.note_comments = `${commentCount} comment(s) injected as <comment> tags. These are review annotations — do not include them in proposed edits.`
            }
            if (isReread) {
              result.note = 'This is an updated read. Previous reads of this document in this conversation are now stale.'
            }
            return result
          }

          // Other @-paths (@issues/, @knowledge/, @skills/, @apps/, @library.json) — file read via absolutePath
          if (resolved.absolutePath) {
            try {
              const { invoke } = await import('@tauri-apps/api/core')
              const resp = await invoke('read_text_file', { path: resolved.absolutePath })
              const content = limitText(resp.content, max_chars)
              return { path: target, characters: resp.content.length, truncated: resp.content.length > max_chars, content }
            } catch (err) {
              return { error: `Failed to read ${target}: ${err?.message || err}` }
            }
          }

          return { error: `Unsupported @-path: ${target}` }
        }

        // --- DOCX files ---
        if (/\.docx$/i.test(target)) {
          const safePath = resolveSafePath(target, workspacePath)
          if (!safePath) return { error: 'Invalid path. Must be relative to the project folder.' }
          const denied = await checkPathAccess(safePath, 'read', gateCtx)
          if (denied) return denied

          try {
            if (docx_metadata) {
              const { getDocxComments } = await import('../../docx/writer')
              const result = await getDocxComments(safePath)
              if (!result.success) return { error: result.error }
              return { path: target, comments: result.comments, trackedChanges: result.trackedChanges, metadata: result.metadata }
            }
            const { readDocxAsText } = await import('../../docx/reader')
            const text = await readDocxAsText(safePath)
            return { path: target, resolvedPath: safePath, text: limitText(text, max_chars) }
          } catch (e) {
            return { error: `Failed to read .docx: ${e?.message || e}` }
          }
        }

        // --- Default: text file ---
        const safePath = resolveSafePath(target, workspacePath)
        if (!safePath) return { error: 'Path traversal blocked. Path must stay within the project folder.' }
        const denied = await checkPathAccess(safePath, 'read', gateCtx)
        if (denied) return denied

        try {
          const { invoke } = await import('@tauri-apps/api/core')
          const resp = await invoke('read_text_file', { path: safePath })
          const cleaned = stripCommentTags(resp.content)
          const content = limitText(cleaned, max_chars)
          return { path: target, characters: cleaned.length, truncated: cleaned.length > max_chars, content }
        } catch (e) {
          return { error: `Failed to read file: ${e?.message || e}` }
        }
      }, gateCtx),
    }),
  }
}
