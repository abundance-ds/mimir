import { tool } from 'ai'
import { z } from 'zod'
import { withGate } from './gate'
import { isAtPath, resolveAtPath } from './pathHandlers'
import { resolveSafePath } from './textMatch'
import { checkPathAccess } from './pathPermission'

function generateProposalId() {
  return `file_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

export function createCreateTool(context) {
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
    create: tool({
      description:
        'Create a new file at target path. Fails if file exists (use edit).\n' +
        '@issues/, @knowledge/, @apps/, @skills/ → direct write. Project path → diff review.\n' +
        'Cannot overwrite existing files or create binary files.',
      inputSchema: z.object({
        target: z.string().min(1).max(500),
        content: z.string().min(1).max(100_000),
      }),
      execute: withGate('create', async ({ target, content }) => {

        if (isAtPath(target)) {
          const resolved = await resolveAtPath(target, { projectId: context.projectId })
          if (resolved.error) return { error: resolved.error }
          const { handler, absolutePath } = resolved
          if (handler.validate) {
            const validation = handler.validate(content, target.split('/').pop())
            if (!validation.ok) return { error: validation.error }
          }
          if (handler.ensureDir) await handler.ensureDir({ projectId: context.projectId })
          const { invoke } = await import('@tauri-apps/api/core')
          const exists = await invoke('path_exists', { path: absolutePath })
          if (exists) return { error: `File already exists at ${target}. Use edit to modify.` }
          await invoke('write_text_file', { path: absolutePath, content })
          if (handler.afterWrite) await handler.afterWrite({ projectId: context.projectId })
          if ((target.startsWith('@issues/') || target.startsWith('@knowledge/')) && context.sessionId) {
            const entryId = absolutePath.split('/').pop().replace(/\.md$/, '')
            if (context.linkEntry) context.linkEntry(entryId)
          }
          return { path: target, characters: content.length, status: 'created' }
        }

        if (!workspacePath) return { error: 'No project folder linked.' }
        const safePath = resolveSafePath(target, workspacePath)
        if (!safePath) return { error: 'Path traversal blocked. Path must stay within the project folder.' }
        const denied = await checkPathAccess(safePath, 'create', gateCtx)
        if (denied) return denied

        try {
          const { invoke } = await import('@tauri-apps/api/core')
          const exists = await invoke('path_exists', { path: safePath })
          if (exists) return { error: `File already exists: ${target}. Use edit to modify it.` }
          const proposalId = generateProposalId()

          if (isBypass()) {
            await invoke('write_text_file', { path: safePath, content })
            onProposal({ id: proposalId, type: 'create', path: target, targetText: '', replacement: content, status: 'accepted' })
            return { path: target, characters: content.length, status: 'created' }
          }

          onProposal({ id: proposalId, type: 'create', path: target, absolutePath: safePath, targetText: '', replacement: content, status: 'pending' })
          return { proposalId, path: target, status: 'pending_review', message: 'File creation proposed. Awaiting user review.' }
        } catch (e) {
          return { error: `Failed to create file: ${e?.message || e}` }
        }
      }, gateCtx),
    }),
  }
}
