import { tool } from 'ai'
import { z } from 'zod'
import { withGate } from './gate'
import { isAtPath, resolveAtPath } from './pathHandlers'
import { resolveSafePath } from './textMatch'
import { checkPathAccess } from './pathPermission'

export function createListTool(context) {
  const workspacePath = context.workspacePath || context.projectPath || null
  const gateCtx = {
    sessionId: context.sessionId,
    policy: context.policy,
    onApprovalRequest: context.onApprovalRequest,
    projectPath: workspacePath,
    approvalMode: context.approvalMode,
  }

  return {
    list: tool({
      description: `List files in a directory or entries at a virtual path.\n@issues/ → issues. @knowledge/ → knowledge. @apps/ → apps. @skills/ → skills. Project path → files.`,
      inputSchema: z.object({
        target: z.string().min(1).max(500),
        pattern: z.string().max(100).optional().describe('Glob filter, e.g. "*.md"'),
      }),
      execute: withGate('list', async ({ target, pattern }) => {
        // --- @-paths ---
        if (isAtPath(target)) {
          const resolved = await resolveAtPath(target, { projectId: context.projectId })
          if (!resolved) return { error: `Cannot resolve path: ${target}` }
          if (resolved.error) return { error: resolved.error }

          if (!resolved.absolutePath) return { error: `Unsupported @-path for listing: ${target}` }

          try {
            const { invoke } = await import('@tauri-apps/api/core')
            const files = await invoke('list_dir', { path: resolved.absolutePath })
            let entries = (files || []).map(f => ({ name: f.name, is_dir: f.is_dir, size: f.size || 0 }))
            if (pattern) {
              const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i')
              entries = entries.filter(e => e.is_dir || regex.test(e.name))
            }
            return { directory: target, count: entries.length, entries: entries.slice(0, 100) }
          } catch (err) {
            return { error: `Failed to list ${target}: ${err?.message || err}` }
          }
        }

        // --- Project directory ---
        if (!workspacePath) return { error: 'No project folder linked.' }

        const safePath = resolveSafePath(target, workspacePath)
        if (!safePath) return { error: 'Invalid directory path.' }

        const denied = await checkPathAccess(safePath, 'read', gateCtx)
        if (denied) return denied

        try {
          const { invoke } = await import('@tauri-apps/api/core')
          const files = await invoke('list_dir', { path: safePath })
          let entries = (files || []).map(f => ({ name: f.name, is_dir: f.is_dir, size: f.size || 0 }))
          if (pattern) {
            const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i')
            entries = entries.filter(e => e.is_dir || regex.test(e.name))
          }
          return { directory: target, count: entries.length, entries: entries.slice(0, 100) }
        } catch (e) {
          return { error: `Failed to list directory: ${e?.message || e}` }
        }
      }, gateCtx),
    }),
  }
}
