import { getGraphNode, updateGraphNode } from './businessGraph.js'

export async function summaryHash(summary) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(summary || ''))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function loadFiledMeeting(meeting) {
  const node = await getGraphNode(meeting.graphNodeId)
  if (!node) throw new Error('This meeting is not available in Graph.')
  if (node.kind !== 'meeting' || node.properties?.sourceMeetingId !== meeting.id) {
    throw new Error('This Graph record does not belong to the meeting.')
  }
  return node
}

export async function resolveMeetingSummary(node, summary, replace) {
  const expectedRevision = node.provenance?.sourceRevision
  if (!expectedRevision) throw new Error('Reload the Graph summary before updating it.')
  const patch = {
    id: node.id,
    expectedRevision,
    setProperties: { sourceSummaryHash: await summaryHash(summary) },
  }
  if (replace) {
    patch.body = summary
    patch.summary = Array.from((summary.split('\n').map(line => line.trim())
      .find(line => line && !line.startsWith('#')) || 'Meeting brief')
      .replace(/^[-*• ]+/, '').trim()).slice(0, 280).join('')
  }
  return updateGraphNode(patch)
}
