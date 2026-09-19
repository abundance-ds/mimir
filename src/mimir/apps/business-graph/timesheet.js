// Time rows are plain Graph properties. View state and totals never enter YAML.
export const MAX_TIME_ROWS = 10000
const clone = value => JSON.parse(JSON.stringify(value))
export const isTimeRow = row => row !== null && typeof row === 'object' && !Array.isArray(row)

export function localTimeDate(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

export function validTimeDate(value) {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T12:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

export function formatMinutes(value) {
  if (!Number.isInteger(value) || value < 0) return ''
  const hours = Math.floor(value / 60), minutes = value % 60
  return hours ? `${hours}h${minutes ? ` ${minutes}m` : ''}` : `${minutes}m`
}

export function parseDuration(value) {
  const text = String(value ?? '').trim().toLowerCase()
  let minutes
  if (/^\d+$/.test(text)) minutes = Number(text)
  else if (/^\d+:\d{2}$/.test(text)) {
    const [hours, part] = text.split(':').map(Number)
    if (part >= 60) return null
    minutes = hours * 60 + part
  } else {
    const match = text.match(/^(?:(\d+)\s*h\s*)?(?:(\d+)\s*m)?$/)
    if (!match || (!match[1] && !match[2])) return null
    minutes = Number(match[1] || 0) * 60 + Number(match[2] || 0)
  }
  return Number.isInteger(minutes) && minutes > 0 && minutes <= 1440 ? minutes : null
}

export function hydrateTimeRows(entries) {
  if (!Array.isArray(entries)) return entries === undefined ? [] : clone(entries)
  return entries.map(entry => ({
    entry: clone(entry),
    duration: isTimeRow(entry) && Number.isInteger(entry.minutes)
      ? formatMinutes(entry.minutes) : String(entry?.minutes ?? ''),
    editedDuration: false,
  }))
}

export function timeEntries(rows, { preserveInvalidDuration = false } = {}) {
  if (!Array.isArray(rows)) return rows
  return rows.map(row => row.editedDuration && isTimeRow(row.entry)
    ? { ...clone(row.entry), minutes: parseDuration(row.duration) ?? (preserveInvalidDuration ? row.duration : null) }
    : clone(row.entry))
}

export function timeProblems(entries) {
  const problems = []
  const add = (row, field, message) => problems.push({ row, field, message })
  if (!Array.isArray(entries)) {
    add(null, 'entries', 'Time entries must be a list. Repair the list in Source.')
    return problems
  }
  if (entries.length > MAX_TIME_ROWS) add(null, 'entries', 'A time sheet can contain at most 10,000 rows.')
  const ids = new Set()
  entries.forEach((entry, index) => {
    if (!isTimeRow(entry)) { add(index, 'entry', 'Repair this row in Source.'); return }
    if (typeof entry.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(entry.id)) {
      add(index, 'id', 'Each row needs a permanent ID. Repair it in Source.')
    } else if (ids.has(entry.id)) add(index, 'id', 'Row IDs must be unique. Repair this ID in Source.')
    ids.add(entry.id)
    if (!validTimeDate(entry.date)) add(index, 'date', 'Choose a valid date.')
    if (!Number.isInteger(entry.minutes) || entry.minutes < 1 || entry.minutes > 1440) {
      add(index, 'minutes', 'Enter a duration from 1m to 24h.')
    }
    if (typeof entry.description !== 'string' || !entry.description.trim()) add(index, 'description', 'Describe the work.')
    if ('invoice' in entry && (typeof entry.invoice !== 'string' || !entry.invoice.trim())) {
      add(index, 'invoice', 'Enter an invoice reference, or clear it to mark the row Open.')
    }
  })
  return problems
}

export function timeTotals(entries, problems = []) {
  const invalid = new Set(problems.filter(problem => problem.row !== null).map(problem => problem.row))
  let open = 0, invoiced = 0
  if (Array.isArray(entries)) entries.forEach((entry, index) => {
    if (invalid.has(index) || !isTimeRow(entry) || !Number.isInteger(entry.minutes)) return
    if (entry.invoice) invoiced += entry.minutes
    else open += entry.minutes
  })
  return { open, invoiced, total: open + invoiced, incomplete: problems.length > 0 }
}

export function buildTimeProperties(draft, { validate = true } = {}) {
  const entries = timeEntries(draft.timeRows, { preserveInvalidDuration: !validate })
  const problems = timeProblems(entries)
  if (validate && problems.length) {
    const first = problems[0]
    throw new Error(`${first.row === null ? '' : `Row ${first.row + 1}: `}${first.message}`)
  }
  return { entries }
}

export function timesheetCsv({ title, project, person, entries }) {
  const problems = timeProblems(entries)
  if (problems.length) throw new Error('Correct the time sheet before exporting it.')
  // Quote every cell and neutralize spreadsheet formulas in authored text.
  const cell = value => {
    let text = String(value ?? '')
    if (/^[\s]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`
    return `"${text.replaceAll('"', '""')}"`
  }
  const rows = [
    ['Time sheet', 'Project', 'Person', 'Date', 'Work', 'Minutes', 'Duration', 'Invoice'],
    ...entries.map(entry => [title, project, person, entry.date, entry.description,
      entry.minutes, formatMinutes(entry.minutes), entry.invoice || '']),
    ['', '', '', '', 'Total', entries.reduce((sum, entry) => sum + entry.minutes, 0),
      formatMinutes(entries.reduce((sum, entry) => sum + entry.minutes, 0)), ''],
  ]
  return rows.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n'
}
