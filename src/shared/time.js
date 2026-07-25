export function relativeTime(value, now = Date.now()) {
  const timestamp = typeof value === 'number' ? value : Date.parse(value)
  if (!Number.isFinite(timestamp)) return ''

  const elapsedSeconds = Math.max(0, Math.floor((now - timestamp) / 1000))
  if (elapsedSeconds < 5) return 'just now'
  if (elapsedSeconds < 60) return `${elapsedSeconds}s ago`

  const elapsedMinutes = Math.floor(elapsedSeconds / 60)
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`

  const elapsedHours = Math.floor(elapsedMinutes / 60)
  if (elapsedHours < 24) return `${elapsedHours}h ago`

  const elapsedDays = Math.floor(elapsedHours / 24)
  if (elapsedDays < 30) return `${elapsedDays}d ago`

  const elapsedMonths = Math.floor(elapsedDays / 30)
  if (elapsedMonths < 12) return `${elapsedMonths}mo ago`

  return `${Math.floor(elapsedMonths / 12)}y ago`
}
