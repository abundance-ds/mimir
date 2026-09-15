export const statuses = Object.freeze([
  { id: 'backlog', label: 'Backlog' },
  { id: 'plan', label: 'Plan' },
  { id: 'in-progress', label: 'In progress' },
  { id: 'waiting', label: 'Waiting' },
  { id: 'review', label: 'Review' },
  { id: 'done', label: 'Done' },
  { id: 'cancelled', label: 'Cancelled' },
])
export const priorities = Object.freeze([
  { id: 'urgent', label: 'Urgent' },
  { id: 'high', label: 'High' },
  { id: 'normal', label: 'Normal' },
  { id: 'low', label: 'Low' },
])
export const projectTypes = Object.freeze([
  { id: '', label: 'Not set' },
  { id: 'client-engagement', label: 'Client engagement' },
  { id: 'product', label: 'Product' },
  { id: 'lead', label: 'Lead' },
  { id: 'grant', label: 'Grant' },
  { id: 'internal', label: 'Internal' },
])
export const projectStatuses = Object.freeze([
  { id: 'warm-lead', label: 'Warm lead' },
  { id: 'planned', label: 'Planned' },
  { id: 'active', label: 'Active' },
  { id: 'waiting', label: 'Waiting' },
  { id: 'completed', label: 'Completed' },
  { id: 'archived', label: 'Archived' },
])
export const entityStatuses = Object.freeze([
  { id: 'active', label: 'Active' },
  { id: 'former', label: 'Former' },
])
export const RELATION_DEFINITIONS = Object.freeze([
  {
    value: 'works_at',
    label: 'Works at',
    hint: 'Connect a person to a company',
    from: ['person'],
    to: ['company'],
  },
  {
    value: 'for_company',
    label: 'For company',
    hint: 'Connect a project to its client',
    from: ['project'],
    to: ['company'],
  },
  {
    value: 'has_contact',
    label: 'Has contact',
    hint: 'Connect a project to a key person',
    from: ['project'],
    to: ['person'],
  },
  {
    value: 'blocked_by',
    label: 'Blocked by',
    hint: 'Connect an issue to blocking work',
    from: ['issue'],
    to: ['issue'],
  },
  {
    value: 'depends_on',
    label: 'Depends on',
    hint: 'A work or project dependency',
    from: ['issue', 'project'],
    to: ['issue', 'project'],
  },
  {
    value: 'introduced_by',
    label: 'Introduced by',
    hint: 'Record who introduced this relationship',
    from: ['person', 'project'],
    to: ['person'],
  },
  {
    value: 'attended_by',
    label: 'Attended by',
    hint: 'Connect a meeting to a person',
    from: ['meeting'],
    to: ['person'],
  },
  {
    value: 'references',
    label: 'References',
    hint: 'Cite another graph object',
    from: ['any'],
    to: ['any'],
  },
  {
    value: 'related_to',
    label: 'Related to',
    hint: 'A general business connection',
    from: ['any'],
    to: ['any'],
  },
])
export function relationTarget(node, relation) {
  return node.relations?.find(edge => edge.relation === relation)?.target || ''
}

export function defaultRelationFor(kind) {
  if (kind === 'person') return 'works_at'
  if (kind === 'project') return 'for_company'
  if (kind === 'issue') return 'blocked_by'
  return 'related_to'
}

export function displayTitle(node) {
  return node?.title || `Untitled ${human(node?.kind || 'object')}`
}

export function labelColor(name) {
  const colors = ['gray', 'green', 'yellow', 'blue', 'purple', 'red', 'orange']
  let hash = 0
  for (const character of name.toLowerCase()) {
    hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0
  }
  return colors[Math.abs(hash) % colors.length]
}

export function normalizedLabels(labels) {
  return (Array.isArray(labels) ? labels : [])
    .map(label => (
      typeof label === 'string'
        ? { name: label, color: '' }
        : { name: label?.name || '', color: label?.color || '' }
    ))
    .filter(label => label.name)
}

export function sameValues(left, right) {
  return left.length === right.length
    && left.every((value, index) => value === right[index])
}

export function splitValues(value) {
  return String(value || '').split(',').map(item => item.trim()).filter(Boolean)
}

export function localDateTime(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value.slice(0, 16)
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

export function utcDateTime(value) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toISOString()
}

export function readableDate(value) {
  if (!value) return ''
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00`)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' }).format(date)
}

export function readableDateTime(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

export function readableDuration(value) {
  const milliseconds = Number(value) || 0
  if (milliseconds <= 0) return 'Unknown'
  const minutes = Math.max(1, Math.round(milliseconds / 60_000))
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  return remainder ? `${hours} h ${remainder} min` : `${hours} h`
}

export function isOverdue(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || '')
    && value < new Date().toISOString().slice(0, 10)
}

export function activityStatusClass(status) {
  if (['working', 'starting', 'ready'].includes(status)) return 'activity-active'
  if (status === 'needs-input') return 'activity-attention'
  if (['done', 'idle'].includes(status)) return 'activity-done'
  return ''
}

export function fileName(path) {
  return String(path || '').split(/[\\/]/).pop() || path
}

export function fileExtension(path) {
  const name = fileName(path)
  const extension = name.includes('.') ? name.split('.').pop() : 'file'
  return String(extension || 'file').slice(0, 4).toUpperCase()
}

export function human(value) {
  if (value === 'timesheet') return 'time sheet'
  return String(value || '').replaceAll('_', ' ').replaceAll('-', ' ')
}

export function titleCase(value) {
  const label = human(value)
  return label ? `${label[0].toUpperCase()}${label.slice(1)}` : ''
}
