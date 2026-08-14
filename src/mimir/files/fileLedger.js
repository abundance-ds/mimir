import { relativeTime } from '../../shared/time.js'

const GIT_MARKS = Object.freeze({
  new: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
})

const GIT_LABELS = Object.freeze({
  new: 'Added in Git',
  modified: 'Modified in Git',
  deleted: 'Deleted in Git',
  renamed: 'Renamed in Git',
})

export function formatFileSize(bytes) {
  const count = Number(bytes)
  if (!Number.isFinite(count) || count < 0) return '—'
  if (count < 1024) return `${count} B`
  if (count < 1024 ** 2) return `${trimUnit(count / 1024)} KB`
  if (count < 1024 ** 3) return `${trimUnit(count / 1024 ** 2)} MB`
  return `${trimUnit(count / 1024 ** 3)} GB`
}

export function formatModifiedTime(timestamp, now = Date.now()) {
  const value = Number(timestamp)
  if (!Number.isFinite(value) || value <= 0) return '—'
  return relativeTime(value, now, { compact: true }) || '—'
}

export function modifiedDateTime(timestamp) {
  const value = Number(timestamp)
  if (!Number.isFinite(value) || value <= 0) return ''
  return new Date(value).toISOString()
}

export function gitMark(status) {
  return GIT_MARKS[status] || ''
}

export function gitLabel(status) {
  return GIT_LABELS[status] || ''
}

function trimUnit(value) {
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1)
}
