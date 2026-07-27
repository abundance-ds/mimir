const DAY_MS = 86_400_000

export function todayValue() {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return dateValue(today)
}

export function dateValue(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function isOpen(issue) {
  return !['done', 'cancelled'].includes(issue.status || 'backlog')
}

function hasValidDue(issue) {
  return /^\d{4}-\d{2}-\d{2}$/.test(issue.dueDate || '')
}

export function waitingOnHuman(issue) {
  const waiting = String(issue.waitingFor || '').trim().toLowerCase()
  return Boolean(
    issue.needsDetail
    || issue.waitingOnYou
    || ['you', 'me', 'human', 'owner'].includes(waiting),
  )
}

function isOverdue(issue, today) {
  return isOpen(issue) && hasValidDue(issue) && issue.dueDate < today
}

function isDueSoon(issue, today) {
  if (!isOpen(issue) || !hasValidDue(issue) || issue.dueDate < today) return false
  const due = new Date(`${issue.dueDate}T00:00:00`)
  const days = (due.getTime() - new Date(`${today}T00:00:00`).getTime()) / DAY_MS
  return days >= 0 && days <= 7
}

function isWaiting(issue) {
  return isOpen(issue) && Boolean(issue.status === 'waiting' || issue.waitingFor)
}

export const RAIL_ISSUE_READOUTS = Object.freeze([
  {
    id: 'on-you',
    label: 'waiting on you',
    short: 'on you',
    matches: issue => isOpen(issue) && waitingOnHuman(issue),
  },
  {
    id: 'overdue',
    label: 'overdue',
    short: 'overdue',
    matches: issue => isOverdue(issue, todayValue()),
  },
  {
    id: 'waiting',
    label: 'waiting',
    short: 'waiting',
    matches: isWaiting,
  },
  {
    id: 'due-7d',
    label: 'due within 7 days',
    short: 'due 7d',
    matches: issue => isDueSoon(issue, todayValue()),
  },
])

export const AGENT_LIVE_STATUSES = Object.freeze(['starting', 'working', 'needs-input'])

export function activeAgentActivities(activities) {
  return (activities || []).filter(activity => (
    activity.kind === 'agent' && AGENT_LIVE_STATUSES.includes(activity.status)
  ))
}
