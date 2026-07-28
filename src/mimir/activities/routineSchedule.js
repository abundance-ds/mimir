// Bidirectional mapping between a small, human schedule model and the cron
// expressions stored in routine TOML. The builder covers the shapes people
// actually schedule (daily, weekdays, weekly, hourly, minute interval) and
// falls back to raw cron for everything else, so hand-written TOML is never
// rejected — it just opens in cron mode.

export const WEEKDAYS = [
  { key: 'mon', label: 'Mon', short: 'M', cron: 1 },
  { key: 'tue', label: 'Tue', short: 'T', cron: 2 },
  { key: 'wed', label: 'Wed', short: 'W', cron: 3 },
  { key: 'thu', label: 'Thu', short: 'T', cron: 4 },
  { key: 'fri', label: 'Fri', short: 'F', cron: 5 },
  { key: 'sat', label: 'Sat', short: 'S', cron: 6 },
  { key: 'sun', label: 'Sun', short: 'S', cron: 0 },
]

export const FREQUENCIES = [
  { id: 'daily', label: 'Every day' },
  { id: 'weekdays', label: 'Weekdays' },
  { id: 'weekly', label: 'Weekly' },
  { id: 'hourly', label: 'Hourly' },
  { id: 'interval', label: 'Minutes' },
  { id: 'cron', label: 'Cron' },
]

export const INTERVAL_CHOICES = [5, 10, 15, 30]

export function defaultScheduleState() {
  return {
    frequency: 'daily',
    time: '09:00',
    days: ['mon'],
    minute: 0,
    interval: 15,
    cron: '',
  }
}

// → { cron: string|null, error: string|null }; cron is a conventional
// five-field expression except in raw mode, where the text passes through.
export function compileSchedule(state) {
  const frequency = state?.frequency || 'daily'
  if (frequency === 'cron') {
    const cron = String(state?.cron || '').trim()
    if (!cron) return { cron: null, error: 'Enter a cron expression.' }
    const fields = cron.split(/\s+/).length
    if (fields < 5 || fields > 7) {
      return { cron: null, error: 'Cron expressions have 5, 6, or 7 fields.' }
    }
    return { cron, error: null }
  }
  if (frequency === 'interval') {
    const interval = Number(state?.interval)
    if (!Number.isInteger(interval) || interval < 1 || interval > 59) {
      return { cron: null, error: 'Repeat every 1–59 minutes.' }
    }
    return { cron: `*/${interval} * * * *`, error: null }
  }
  if (frequency === 'hourly') {
    const minute = Number(state?.minute)
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
      return { cron: null, error: 'Pick a minute between 0 and 59.' }
    }
    return { cron: `${minute} * * * *`, error: null }
  }

  const parsedTime = parseTime(state?.time)
  if (!parsedTime) return { cron: null, error: 'Pick a time of day.' }
  const { hour, minute } = parsedTime
  if (frequency === 'daily') return { cron: `${minute} ${hour} * * *`, error: null }
  if (frequency === 'weekdays') return { cron: `${minute} ${hour} * * 1-5`, error: null }
  if (frequency === 'weekly') {
    const days = WEEKDAYS.filter((day) => state?.days?.includes(day.key))
    if (!days.length) return { cron: null, error: 'Pick at least one day.' }
    return {
      cron: `${minute} ${hour} * * ${days.map((day) => day.cron).join(',')}`,
      error: null,
    }
  }
  return { cron: null, error: `Unknown frequency '${frequency}'.` }
}

// Best-effort inverse of compileSchedule. Anything it cannot express in the
// builder comes back in cron mode with the raw text preserved.
export function parseSchedule(cron) {
  const state = defaultScheduleState()
  const raw = String(cron || '').trim()
  if (!raw) return state

  const fallback = { ...state, frequency: 'cron', cron: raw }
  const fields = raw.split(/\s+/)
  if (fields.length !== 5) return fallback
  const [minuteField, hourField, dayOfMonth, month, dayOfWeek] = fields
  if (dayOfMonth !== '*' || month !== '*') return fallback

  const intervalMatch = minuteField.match(/^\*\/(\d{1,2})$/)
  if (intervalMatch && hourField === '*' && dayOfWeek === '*') {
    const interval = Number(intervalMatch[1])
    if (interval >= 1 && interval <= 59) return { ...state, frequency: 'interval', interval }
    return fallback
  }

  const minute = parseField(minuteField, 0, 59)
  if (minute == null) return fallback
  if (hourField === '*') {
    if (dayOfWeek !== '*') return fallback
    return { ...state, frequency: 'hourly', minute }
  }
  const hour = parseField(hourField, 0, 23)
  if (hour == null) return fallback

  const time = `${pad(hour)}:${pad(minute)}`
  if (dayOfWeek === '*') return { ...state, frequency: 'daily', time }
  if (dayOfWeek === '1-5') return { ...state, frequency: 'weekdays', time }

  const days = parseDayList(dayOfWeek)
  if (!days) return fallback
  return { ...state, frequency: 'weekly', time, days }
}

// One short human line for list rows and the form summary.
// null/empty cron → manual-only.
export function describeSchedule(cron) {
  const raw = String(cron || '').trim()
  if (!raw) return 'Manual'
  const state = parseSchedule(raw)
  return describeScheduleState(state)
}

export function describeScheduleState(state) {
  switch (state?.frequency) {
    case 'daily':
      return `Every day ${state.time}`
    case 'weekdays':
      return `Weekdays ${state.time}`
    case 'weekly': {
      const days = WEEKDAYS.filter((day) => state.days?.includes(day.key))
      if (!days.length) return `Weekly ${state.time}`
      return `${days.map((day) => day.label).join(', ')} ${state.time}`
    }
    case 'hourly':
      return `Hourly at :${pad(state.minute)}`
    case 'interval':
      return `Every ${state.interval} min`
    case 'cron':
      return String(state.cron || '').trim() || 'Manual'
    default:
      return 'Manual'
  }
}

function parseTime(value) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return null
  return { hour, minute }
}

function parseField(field, min, max) {
  if (!/^\d{1,2}$/.test(field)) return null
  const value = Number(field)
  if (value < min || value > max) return null
  return value
}

function parseDayList(field) {
  const numbers = field.split(',')
  const keys = []
  for (const part of numbers) {
    if (!/^\d$/.test(part)) return null
    const value = Number(part) === 7 ? 0 : Number(part)
    const day = WEEKDAYS.find((candidate) => candidate.cron === value)
    if (!day) return null
    if (!keys.includes(day.key)) keys.push(day.key)
  }
  if (!keys.length) return null
  return WEEKDAYS.filter((day) => keys.includes(day.key)).map((day) => day.key)
}

function pad(value) {
  return String(value).padStart(2, '0')
}
