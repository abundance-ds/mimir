import { tool } from 'ai'
import { z } from 'zod'
import { withGate } from './gate'
import { resolveSafePath } from './textMatch'

function globPattern(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i')
}

export function createListTool(context = {}) {
  const workspacePath = context.workspacePath || context.projectPath || null

  return {
    list: tool({
      description: 'List files in a directory inside the active workspace.',
      inputSchema: z.object({
        target: z.string().max(500).default('.'),
        pattern: z.string().max(100).optional().describe('Optional glob filter such as "*.md".'),
      }),
      execute: withGate('list', async ({ target = '.', pattern } = {}) => {
        if (!workspacePath) return { error: 'No workspace folder is open.' }
        if (target.startsWith('@')) return { error: `Unknown workbench target: ${target}` }

        const safePath = resolveSafePath(target, workspacePath)
        if (!safePath) return { error: 'Directory must stay inside the active workspace.' }

        try {
          const { invoke } = await import('@tauri-apps/api/core')
          const files = await invoke('list_dir', { path: safePath })
          const filter = pattern ? globPattern(pattern) : null
          const entries = (files || [])
            .map(file => ({
              name: file.name,
              is_dir: file.is_dir,
              size: file.size || 0,
            }))
            .filter(entry => !filter || entry.is_dir || filter.test(entry.name))
            .slice(0, 200)
          return { directory: target, count: entries.length, entries }
        } catch (error) {
          return { error: `Failed to list directory: ${error?.message || error}` }
        }
      }),
    }),
  }
}
