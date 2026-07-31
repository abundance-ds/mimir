export function moveRangeAnchor(value, tab, direction) {
  const date = new Date(value)
  if (tab === 'day') date.setDate(date.getDate() + direction)
  else if (tab === 'week') date.setDate(date.getDate() + direction * 7)
  else if (tab === 'month') {
    date.setDate(1)
    date.setMonth(date.getMonth() + direction)
  }
  return date
}

export function reportRange(tab, value, now = new Date()) {
  const anchor = new Date(value)
  if (tab === 'all') {
    const tomorrow = startOfDay(now)
    tomorrow.setDate(tomorrow.getDate() + 1)
    return {
      startMs: new Date(2000, 0, 1).getTime(),
      endMs: tomorrow.getTime(),
    }
  }
  let start
  let end
  if (tab === 'month') {
    start = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
    end = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1)
  } else if (tab === 'week') {
    start = startOfDay(anchor)
    const weekday = (start.getDay() + 6) % 7
    start.setDate(start.getDate() - weekday)
    end = new Date(start)
    end.setDate(end.getDate() + 7)
  } else {
    start = startOfDay(anchor)
    end = new Date(start)
    end.setDate(end.getDate() + 1)
  }
  return { startMs: start.getTime(), endMs: end.getTime() }
}

function startOfDay(value) {
  const date = new Date(value)
  date.setHours(0, 0, 0, 0)
  return date
}
