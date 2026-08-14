export function relativeTime(value, now = Date.now(), options = {}) {
  const timestamp = typeof value === 'number' ? value : Date.parse(value)
  if (!Number.isFinite(timestamp)) return ''

  const elapsedSeconds = Math.max(0, Math.floor((now - timestamp) / 1000))
  if (options.compact) return compactRelativeTime(elapsedSeconds)

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

function compactRelativeTime(elapsedSeconds) {
  if (elapsedSeconds < 60) return 'now'

  const elapsedMinutes = Math.floor(elapsedSeconds / 60)
  if (elapsedMinutes < 60) return `${elapsedMinutes}m`

  const elapsedHours = Math.floor(elapsedMinutes / 60)
  if (elapsedHours < 24) return `${elapsedHours}h`

  const elapsedDays = Math.floor(elapsedHours / 24)
  if (elapsedDays < 7) return `${elapsedDays}d`
  if (elapsedDays < 30) return `${Math.floor(elapsedDays / 7)}w`

  const elapsedMonths = Math.floor(elapsedDays / 30)
  if (elapsedDays < 365) return `${elapsedMonths}mo`

  return `${Math.floor(elapsedDays / 365)}y`
}
