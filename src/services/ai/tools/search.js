import { tool } from 'ai'
import { z } from 'zod'
import { withGate } from './gate'
import { limitText } from './helpers'

// Matches the legacy glob semantics this tool has always advertised: "*.ext"
// is a filename-suffix match, anything else an exact filename. The indexed
// search only narrows by fuzzy path query (a superset of these matches), so
// the exact filter is re-applied to its results here.
function matchesFilePattern(name, pattern) {
  if (!pattern) return true
  if (pattern.startsWith('*')) return name.endsWith(pattern.slice(1))
  return name === pattern
}

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
          const pattern = (file_pattern || '').trim()
          const token = await invoke('file_index_begin_search')
          const report = await invoke('file_index_search', {
            token,
            request: {
              query,
              // Fuzzy pre-narrowing; exact glob filtering happens below.
              pathQuery: pattern ? pattern.replace(/^\*+/, '') : null,
              maxResults: limit || 20,
            },
          })
          const matches = (report?.matches || [])
            .filter(match => matchesFilePattern(match.name || '', pattern))
            .map(match => ({
              path: match.relativePath || match.path,
              line: match.line,
              snippet: limitText(match.excerpt || '', 240),
            }))
          return { query, count: matches.length, matches }
        } catch (error) {
          return { error: `Search failed: ${error?.message || error}` }
        }
      }),
    }),
  }
}
