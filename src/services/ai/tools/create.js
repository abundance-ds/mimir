import { tool } from 'ai'
import { z } from 'zod'
import { withGate } from './gate'
import { resolveSafePath } from './textMatch'

function generateProposalId() {
  return `file_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

export function createCreateTool(context = {}) {
  const workspacePath = context.workspacePath || context.projectPath || null
  const onProposal = context.onProposal || (() => {})

  return {
    create: tool({
      description:
        'Create a new text file inside the active workspace. ' +
        'The target is a workspace-relative path and existing files are never overwritten.',
      inputSchema: z.object({
        target: z.string().min(1).max(500),
        content: z.string().min(1).max(100_000),
      }),
      execute: withGate('create', async ({ target, content }) => {
        if (!workspacePath) return { error: 'No workspace folder is open.' }
        if (target.startsWith('@')) return { error: `Unknown workbench target: ${target}` }
        const safePath = resolveSafePath(target, workspacePath)
        if (!safePath) return { error: 'Path must stay inside the active workspace.' }

        try {
          const { invoke } = await import('@tauri-apps/api/core')
          const exists = await invoke('path_exists', { path: safePath })
          if (exists) return { error: `File already exists: ${target}. Use edit to modify it.` }

          await invoke('write_text_file', { path: safePath, content })
          onProposal({
            id: generateProposalId(),
            type: 'create',
            path: target,
            targetText: '',
            replacement: content,
            status: 'accepted',
          })
          return { path: target, characters: content.length, status: 'created' }
        } catch (error) {
          return { error: `Failed to create file: ${error?.message || error}` }
        }
      }),
    }),
  }
}
