import { dueInfo, isClosedIssue, waitingReason } from './workRow.js'

export function projectAttention(issues, now = new Date()) {
  return issues.flatMap(issue => {
    if (isClosedIssue(issue)) return []
    const snooze = String(issue.snoozeUntil || '')
    if (snooze && new Date(snooze.length === 10 ? `${snooze}T00:00:00` : snooze) > now) return []
    const date = new Date(`${issue.dueDate}T00:00:00`)
    const validDate = !Number.isNaN(date.getTime()) && `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` === issue.dueDate
    const due = dueInfo(validDate ? issue.dueDate : '', now)
    const waiting = issue.status === 'waiting' || Boolean(issue.waitingFor)
    const review = issue.status === 'review'
    if (!waiting && !review && !['overdue', 'today'].includes(due.state)) return []
    const reason = waiting ? (waitingReason(issue) ? `Waiting for ${waitingReason(issue)}` : 'Waiting') : review ? 'In review' : ''
    return [{ ...issue, reason, due,
      urgency: due.state === 'overdue' ? 0 : waiting ? 1 : due.state === 'today' ? 2 : 3 }]
  }).sort((a, b) => a.urgency - b.urgency
    || (a.dueDate || '9999').localeCompare(b.dueDate || '9999')
    || ({ urgent: 0, high: 1, normal: 2, low: 3 }[a.priority] ?? 2) - ({ urgent: 0, high: 1, normal: 2, low: 3 }[b.priority] ?? 2)
    || a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
}
