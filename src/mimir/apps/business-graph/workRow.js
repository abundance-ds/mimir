// Shared row grammar for the Work projections (Board, List, Attention):
// status order, relative due-date words, assignee initials, waiting reasons,
// and the Attention grouping. The Board and List render the same facts in the
// same words so a reader learns one vocabulary.

const DAY_MS = 86_400_000
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const CLOSED_STATUSES = new Set(['done', 'cancelled'])

export const WORK_STATUSES = Object.freeze([
  { id: 'backlog', label: 'Backlog' },
  { id: 'plan', label: 'Plan' },
  { id: 'in-progress', label: 'In progress' },
  { id: 'waiting', label: 'Waiting' },
  { id: 'review', label: 'Review' },
  { id: 'done', label: 'Done' },
])

export const UNASSIGNED = '__unassigned__'

export const ATTENTION_GROUPS = Object.freeze([
  { id: 'overdue', label: 'Overdue' },
  { id: 'waiting', label: 'Waiting' },
  { id: 'urgent', label: 'Urgent' },
  { id: 'due-soon', label: 'Due this week' },
])

/**
 * Describe a due date relative to today.
 * @returns {{ state: 'none'|'overdue'|'today'|'soon'|'later', days: number|null, label: string }}
 */
export function dueInfo(value, now = new Date()) {
  const text = String(value || '')
  if (!ISO_DATE.test(text)) return { state: 'none', days: null, label: '' }
  const due = new Date(`${text}T00:00:00`)
  if (Number.isNaN(due.getTime())) return { state: 'none', days: null, label: '' }
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const days = Math.round((due.getTime() - today.getTime()) / DAY_MS)
  if (days < 0) return { state: 'overdue', days, label: `${-days}d overdue` }
  if (days === 0) return { state: 'today', days, label: 'due today' }
  if (days === 1) return { state: 'soon', days, label: 'due tomorrow' }
  if (days <= 7) return { state: 'soon', days, label: `due ${days}d` }
  const year = due.getFullYear() === today.getFullYear() ? '' : ` ${due.getFullYear()}`
  return { state: 'later', days, label: `due ${due.getDate()} ${MONTHS[due.getMonth()]}${year}` }
}

export function isOverdue(value, now = new Date()) {
  return dueInfo(value, now).state === 'overdue'
}

export function isClosed(issue) {
  return CLOSED_STATUSES.has(issue?.status || 'backlog')
}

/** Two-letter initials from a display name: first and last word, or the first two letters. */
export function initials(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean)
  if (!words.length) return ''
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return `${words[0][0]}${words[words.length - 1][0]}`.toUpperCase()
}

/**
 * Assignee token for a row. `byId` resolves person ids to nodes; a legacy
 * label that is not an id still gets initials.
 * @returns {{ label: string, name: string, self: boolean } | null}
 */
export function assigneeDisplay(issue, { byId, selfId = '' } = {}) {
  const assigneeId = String(issue?.assigneeId || '').trim()
  if (!assigneeId) return null
  const person = byId?.get?.(assigneeId)
  const name = String(person?.title || assigneeId)
  if (selfId && assigneeId === selfId) return { label: 'you', name, self: true }
  return { label: initials(name), name, self: false }
}

/** The waiting reason spelled for a row, or an empty string. */
export function waitingReason(issue) {
  const reason = String(issue?.waitingFor || '').trim()
  if (!reason) return ''
  return ['you', 'me', 'human', 'owner'].includes(reason.toLowerCase()) ? 'you' : reason
}

/** The Attention group an open issue belongs to, or an empty string. */
export function attentionGroup(issue, now = new Date()) {
  if (!issue || isClosed(issue)) return ''
  const due = dueInfo(issue.dueDate, now)
  if (due.state === 'overdue') return 'overdue'
  if (issue.status === 'waiting' || waitingReason(issue)) return 'waiting'
  if (issue.priority === 'urgent') return 'urgent'
  if (due.state === 'today' || due.state === 'soon') return 'due-soon'
  return ''
}

export function needsAttention(issue, now = new Date()) {
  return Boolean(attentionGroup(issue, now))
}

/**
 * Group rows for the Work list. Returns groups in display order; empty
 * groups are omitted. Row order inside a group follows the input order.
 * @param {Array} issues
 * @param {{ groupBy: 'status'|'project'|'attention', projects?: Array, now?: Date }} options
 */
export function groupWorkRows(issues, { groupBy = 'status', projects = [], now = new Date() } = {}) {
  let definitions
  let keyFor
  if (groupBy === 'project') {
    definitions = [
      ...projects.map(project => ({
        id: project.id,
        label: project.title || project.properties?.slug || project.slug || 'Untitled project',
      })),
      { id: UNASSIGNED, label: 'No project' },
    ]
    const known = new Set(definitions.map(group => group.id))
    keyFor = issue => (known.has(issue.projectId) ? issue.projectId : UNASSIGNED)
  } else if (groupBy === 'attention') {
    definitions = ATTENTION_GROUPS
    keyFor = issue => attentionGroup(issue, now)
  } else {
    definitions = WORK_STATUSES
    const known = new Set(definitions.map(group => group.id))
    keyFor = issue => (known.has(issue.status) ? issue.status : 'backlog')
  }
  const buckets = new Map(definitions.map(group => [group.id, []]))
  for (const issue of issues) {
    const key = keyFor(issue)
    if (buckets.has(key)) buckets.get(key).push(issue)
  }
  return definitions
    .map(group => ({ ...group, items: buckets.get(group.id) || [] }))
    .filter(group => group.items.length)
}
