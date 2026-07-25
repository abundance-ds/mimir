import { tool } from 'ai'
import { z } from 'zod'
import { withGate } from './gate'
import { limitText } from './helpers'

export function createSearchTool(context = {}) {
  const workspacePath = context.workspacePath || context.projectPath || null

  return {
    search: tool({
      description: 'Search text files in the active workspace. Returns paths, line numbers, and compact snippets.',
      inputSchema: z.object({
        scope: z.literal('project').default('project'),
        query: z.string().min(1).max(500),
        file_pattern: z.string().max(100).optional().describe('Optional file filter such as "*.md".'),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      execute: withGate('search', async ({ scope = 'project', query, file_pattern, limit } = {}) => {
        if (scope !== 'project') return { error: `Unknown search scope: ${scope}` }
        if (!query) return { error: 'Query is required for workspace search.' }
        if (!workspacePath) return { error: 'No workspace folder is open.' }

        try {
          const { invoke } = await import('@tauri-apps/api/core')
          const results = await invoke('search_file_content', {
            path: workspacePath,
            query,
            file_pattern: file_pattern || null,
            max_results: limit || 20,
          })
          return {
            query,
            count: (results || []).length,
            matches: (results || []).map(result => ({
              path: result.path?.replace(`${workspacePath}/`, '') || result.path,
              line: result.line,
              snippet: limitText(result.snippet || '', 240),
            })),
          }
        } catch (error) {
          return { error: `Search failed: ${error?.message || error}` }
        }
      }),
    }),
  }
}
