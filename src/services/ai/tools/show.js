import { tool } from 'ai'
import { z } from 'zod'
import { withGate } from './gate'
import { limitText } from './helpers'

export function createShowTool(context) {
  const projectId = context.projectId
  const gateCtx = {
    sessionId: context.sessionId,
    policy: context.policy,
    onApprovalRequest: context.onApprovalRequest,
    approvalMode: context.approvalMode,
  }

  if (!projectId) return {}

  return {
    show: tool({
      description: 'Show a board entry as an interactive card in the chat. Use list("@issues/") or list("@knowledge/") to find IDs.',
      inputSchema: z.object({
        target: z.string().min(1).max(500).describe('Entry path, e.g. @issues/ISSUE-1 or @knowledge/my-note'),
      }),
      execute: withGate('show', async ({ target }) => {
        let entryId, dirFn
        if (target.startsWith('@issues/')) {
          entryId = target.slice('@issues/'.length).replace(/\.md$/, '')
          dirFn = 'issuesDir'
        } else if (target.startsWith('@knowledge/')) {
          entryId = target.slice('@knowledge/'.length).replace(/\.md$/, '')
          dirFn = 'knowledgeDir'
        } else {
          return { error: 'show supports @issues/ and @knowledge/ paths.' }
        }

        try {
          const loader = await import('../../board/loader.js')
          const entry = await loader.readEntry(projectId, entryId)
          const dir = await loader[dirFn](projectId)

          const doneCount = (entry.body || '').match(/- \[x\]/gi)?.length || 0
          const undoneCount = (entry.body || '').match(/- \[ \]/g)?.length || 0
          const total = doneCount + undoneCount

          return {
            _render: 'issue_card',
            id: entry.id,
            title: entry.meta.title,
            type: entry.meta.type,
            status: entry.meta.status,
            priority: entry.meta.priority,
            tags: entry.meta.tags || [],
            body: limitText(entry.body || '', 500),
            boardFilePath: `${dir}/${entryId}.md`,
            taskProgress: total > 0 ? { done: doneCount, total } : null,
            created: entry.meta.created,
            updated: entry.meta.updated,
          }
        } catch (err) {
          return { error: err?.message || err }
        }
      }, gateCtx),
    }),
  }
}
