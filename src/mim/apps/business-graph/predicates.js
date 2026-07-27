export function waitingOnHuman(issue) {
  const waiting = String(issue.waitingFor || '').trim().toLowerCase()
  return Boolean(
    issue.needsDetail
    || issue.waitingOnYou
    || ['you', 'me', 'human', 'owner'].includes(waiting),
  ) && !['done', 'cancelled'].includes(issue.status || 'backlog')
}
