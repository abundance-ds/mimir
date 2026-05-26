import { tool } from 'ai'
import { z } from 'zod'
import { withGate } from './gate'
import { readDocument, readReferences, referenceHaystack, limitText } from './helpers'

export function createSearchTool(context) {
  const workspacePath = context.workspacePath || context.projectPath || null
  const getDocument = () => readDocument(context.getDocument || null)
  const gateCtx = {
    sessionId: context.sessionId,
    policy: context.policy,
    onApprovalRequest: context.onApprovalRequest,
    projectPath: workspacePath,
    approvalMode: context.approvalMode,
  }

  return {
    search: tool({
      description:
        'Search content by scope. "project" = grep files, "references" = search library, ' +
        '"citations" = check citation coverage vs library.\n' +
        'Cannot write, fetch URLs, or read full file content (use read after finding matches).',
      inputSchema: z.object({
        scope: z.enum(['project', 'references', 'citations']),
        query: z.string().max(500).optional().describe('Search query (required for project and references)'),
        file_pattern: z.string().max(100).optional().describe('File extension filter for project search, e.g. "*.md"'),
        limit: z.number().int().min(1).max(20).optional(),
        include_unused: z.boolean().optional().describe('For citations: also list library references not cited'),
      }),
      execute: withGate('search', async ({ scope, query, file_pattern, limit, include_unused = false } = {}) => {

        if (scope === 'project') {
          if (!workspacePath) return { error: 'No project folder linked.' }
          if (!query) return { error: 'Query is required for project search.' }
          try {
            const { invoke } = await import('@tauri-apps/api/core')
            const results = await invoke('search_file_content', {
              path: workspacePath,
              query,
              file_pattern: file_pattern || null,
              max_results: limit || 10,
            })
            return {
              query,
              count: (results || []).length,
              matches: (results || []).map(r => ({
                path: r.path?.replace(workspacePath + '/', '') || r.path,
                line: r.line,
                snippet: limitText(r.snippet || '', 200),
              })),
            }
          } catch (e) {
            return { error: `Search failed: ${e?.message || e}` }
          }
        }

        if (scope === 'references') {
          if (!query) return { error: 'Query is required for reference search.' }
          const references = await readReferences()
          const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
          if (!terms.length) return { query, count: 0, references: [] }
          const scored = references
            .map(ref => {
              const hay = referenceHaystack(ref)
              const hits = terms.filter(t => hay.includes(t)).length
              return { ref, score: hits }
            })
            .filter(r => r.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, limit || 8)
          return { query, count: scored.length, references: scored.map(r => r.ref) }
        }

        if (scope === 'citations') {
          const document = await getDocument()
          const references = await readReferences()
          const citationRegex = /\[@([^\]]+)\]/g
          const cited = new Set()
          let match
          while ((match = citationRegex.exec(document.content)) !== null) {
            const keys = match[1].split(';').map(k => k.trim().replace(/^@/, ''))
            keys.forEach(k => cited.add(k))
          }
          const refKeys = new Set(references.map(r => r._key || r.key || r.id).filter(Boolean))
          const found = []
          const missing = []
          for (const key of cited) {
            if (refKeys.has(key)) found.push(key)
            else missing.push(key)
          }
          const result = { citationsInDocument: cited.size, matched: found, missing }
          if (include_unused) {
            result.unusedReferences = [...refKeys].filter(k => !cited.has(k))
          }
          return result
        }

        return { error: `Unknown scope: ${scope}` }
      }, gateCtx),
    }),
  }
}
