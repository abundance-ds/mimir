/** Build once per graph snapshot; keystrokes only scan normalized strings. */
export function workSearchIndex(nodes) {
  const byId = new Map(nodes.map(node => [node.id, node]))
  return new Map(nodes.filter(node => node.kind === 'issue').map(issue => [
    issue.id,
    normalize([
      issue.id, issue.title, issue.summary, issue.status, issue.priority,
      issue.waitingFor, issue.dueDate, issue.projectId, issue.assigneeId,
      byId.get(issue.projectId)?.title, byId.get(issue.assigneeId)?.title,
      ...(issue.tags || []),
    ].filter(Boolean).join(' ')),
  ]))
}

export function filterWork(issues, index, query) {
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean)
  return terms.length
    ? issues.filter(issue => terms.every(term => index.get(issue.id)?.includes(term)))
    : issues
}

function normalize(value) {
  return String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
}
