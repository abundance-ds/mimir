import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getGraphNode, updateGraphNode } from './businessGraph.js'
import { loadFiledMeeting, resolveMeetingSummary } from './filedMeeting.js'

vi.mock('./businessGraph.js', () => ({ getGraphNode: vi.fn(), updateGraphNode: vi.fn() }))

const meeting = { id: 'scribe-1', graphNodeId: 'graph-1' }
const node = {
  id: 'graph-1', kind: 'meeting', body: 'Reviewed summary.',
  properties: { sourceMeetingId: 'scribe-1' },
  provenance: { sourceRevision: 'reviewed-revision' },
}

describe('filed meeting summary', () => {
  beforeEach(() => vi.clearAllMocks())

  it.each([
    null,
    { ...node, kind: 'note' },
    { ...node, properties: { sourceMeetingId: 'another-meeting' } },
  ])('rejects a missing or unrelated Graph record', async record => {
    vi.mocked(getGraphNode).mockResolvedValue(record)
    await expect(loadFiledMeeting(meeting)).rejects.toThrow()
    expect(updateGraphNode).not.toHaveBeenCalled()
  })

  it('requires the reviewed revision before replacing a Graph summary', async () => {
    await expect(resolveMeetingSummary({ ...node, provenance: {} }, 'Replacement.', true))
      .rejects.toThrow('Reload the Graph summary')
    expect(updateGraphNode).not.toHaveBeenCalled()
  })
})
