import { describe, expect, it } from 'vitest'
import {
  buildGraphSummaryPrompt,
  MAX_GRAPH_SUMMARY_PROMPT_BYTES,
} from './graphSummaryContext.js'

function event(index, overrides = {}) {
  return {
    id: `event-${index}`,
    timestamp: `2026-07-29T10:${String(index).padStart(2, '0')}:00Z`,
    eventType: 'status-changed',
    action: 'graph.update',
    graphRevision: index,
    nodeId: `issue-${index}`,
    nodeKind: 'issue',
    title: `Issue ${index}`,
    scopeId: 'project:alpha',
    sourcePath: `/alpha/graph/issue-${index}.md`,
    summary: `Updated Issue ${index}`,
    actor: { kind: 'human', id: 'local-human', label: 'You' },
    changes: [{ field: 'status', before: 'plan', after: 'in-progress' }],
    data: {},
    ...overrides,
  }
}

describe('graph summary context', () => {
  it('renders a human ledger without transport identifiers or repeated schema noise', () => {
    const result = buildGraphSummaryPrompt({
      events: [
        event(1),
        event(2, {
          eventType: 'created',
          action: 'knowledge.create',
          nodeKind: 'note',
          title: 'Evidence strategy',
          actor: { kind: 'external', id: 'external', label: 'External edit' },
          changes: [],
        }),
      ],
      since: '2026-07-20',
      total: 2,
      instructions: 'Focus on delivery risk.',
    })

    expect(result.includedCount).toBe(2)
    expect(result.shortened).toBe(false)
    expect(result.prompt).toContain('Summarise Business Graph changes since 20 July 2026.')
    expect(result.prompt).toContain('You updated issue “Issue 1” — status: Plan → In Progress.')
    expect(result.prompt).toContain('External edit created note “Evidence strategy”.')
    expect(result.prompt).toContain('Focus on delivery risk.')
    expect(result.prompt).not.toContain('event-1')
    expect(result.prompt).not.toContain('issue-1')
    expect(result.prompt).not.toContain('project:alpha')
    expect(result.prompt).not.toContain('graphRevision')
    expect(result.prompt).not.toContain('graph.update')
    expect(result.prompt).not.toContain('ndjson')
    expect(result.bytes).toBeLessThan(MAX_GRAPH_SUMMARY_PROMPT_BYTES)
  })

  it('does not hide a rapid external reversal in the prompt layer', () => {
    const authored = event(1, {
      timestamp: '2026-07-29T10:00:00.000Z',
      changes: [{ field: 'tags', before: [], after: ['funding'] }],
    })
    const watcherEcho = event(2, {
      timestamp: '2026-07-29T10:00:00.180Z',
      action: 'external.file-change',
      actor: { kind: 'external', id: 'external', label: 'External edit' },
      nodeId: authored.nodeId,
      title: authored.title,
      changes: [{ field: 'tags', before: ['funding'], after: [] }],
    })

    const result = buildGraphSummaryPrompt({
      events: [watcherEcho, authored],
      since: '2026-07-20',
      total: 2,
    })

    expect(result.includedCount).toBe(2)
    expect(result.prompt.match(/Issue 1/g)).toHaveLength(2)
    expect(result.prompt).toContain('External edit changed')
  })

  it('abbreviates oversized values and shows an explicit shortening note', () => {
    const result = buildGraphSummaryPrompt({
      events: Array.from({ length: 20 }, (_, index) => event(index, {
        changes: [{ field: 'summary', before: 'Before', after: 'x'.repeat(20_000) }],
      })),
      since: '2026-07-01',
      total: 20,
      maxBytes: 8_000,
    })

    expect(result.shortened).toBe(true)
    expect(result.abbreviatedValueCount).toBeGreaterThan(0)
    expect(result.prompt).toContain('SHORTENING NOTE:')
    expect(result.prompt).toContain('100,000-token ceiling')
    expect(result.bytes).toBeLessThanOrEqual(8_000)
  })
})
