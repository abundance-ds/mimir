const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const TASK_PATTERN = /^([ \t]*)([-+*]|\d+[.)])([ \t]+)\[([ xX])\](?:[ \t]+(.*))?$/
const JOURNAL_HEADING_PATTERN = /^## (\d{4}-\d{2}-\d{2})[ \t]*$/gm

export function localDateKey(date = new Date()) {
  const value = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(value.getTime())) return ''
  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function shiftDateKey(dateKey, days) {
  const date = dateFromKey(dateKey)
  if (!date) return ''
  date.setDate(date.getDate() + Number(days || 0))
  return localDateKey(date)
}

export function journalNodeId(dateKey) {
  return `journal-${String(dateKey || '').slice(0, 7)}`
}

export function journalTitle(dateKey, locale) {
  const date = dateFromKey(dateKey)
  if (!date) return ''
  return new Intl.DateTimeFormat(locale, {
    month: 'long',
    year: 'numeric',
  }).format(date)
}

export function parseTodayStorage(raw, fallbackDate = localDateKey()) {
  let saved = raw
  if (typeof raw === 'string') {
    try {
      saved = JSON.parse(raw)
    } catch {
      saved = raw
    }
  }

  if (typeof saved === 'string') {
    return todayState({ date: fallbackDate, text: saved })
  }

  if (!saved || typeof saved !== 'object') {
    return todayState({ date: fallbackDate })
  }

  const updatedAt = validTimestamp(saved.updatedAt)
  const savedDate = validDateKey(saved.date)
    ? saved.date
    : localDateKey(updatedAt || fallbackDate) || fallbackDate

  return todayState({
    date: savedDate,
    text: saved.text,
    updatedAt: updatedAt ? updatedAt.toISOString() : null,
    previous: normalizePrevious(saved.previous),
    archiveQueue: normalizeArchiveQueue(saved.archiveQueue),
    tomorrow: normalizeTomorrow(saved.tomorrow),
  })
}

export function serializeTodayStorage(state) {
  return JSON.stringify({
    version: 3,
    date: validDateKey(state?.date) ? state.date : localDateKey(),
    text: String(state?.text || ''),
    updatedAt: state?.updatedAt || new Date().toISOString(),
    previous: normalizePrevious(state?.previous),
    archiveQueue: normalizeArchiveQueue(state?.archiveQueue),
    tomorrow: normalizeTomorrow(state?.tomorrow),
  })
}

export function appendMarkdownBelow(base, addition) {
  const before = normalizeNewlines(base).trimEnd()
  const after = normalizeNewlines(addition).trim()
  if (!before) return after
  if (!after) return before
  return `${before}\n\n${after}`
}

export function uncheckedTaskBlocks(markdown) {
  const lines = normalizeNewlines(markdown).split('\n')
  const tasks = []

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(TASK_PATTERN)
    if (!match) continue
    const indent = indentColumns(match[1])
    let end = index + 1
    while (end < lines.length) {
      if (!lines[end].trim()) {
        end += 1
        continue
      }
      const nextIndent = indentColumns(lines[end].match(/^[ \t]*/)?.[0] || '')
      if (nextIndent <= indent) break
      end += 1
    }
    tasks.push({
      start: index,
      end,
      indent,
      checked: match[4].toLowerCase() === 'x',
      label: String(match[5] || '').trim() || 'Untitled task',
    })
  }

  return tasks
    .filter(task => !task.checked)
    .filter(task => !tasks.some(parent => (
      !parent.checked
      && parent.start < task.start
      && parent.end > task.start
      && parent.indent < task.indent
    )))
    .map(task => ({
      id: `${task.start + 1}:${task.end}`,
      label: task.label,
      markdown: lines
        .slice(task.start, task.end)
        .map(line => removeIndent(line, task.indent))
        .join('\n')
        .trimEnd(),
    }))
}

export function carrySource(previous) {
  return String(previous?.carryText ?? previous?.text ?? '')
}

export function journalDay(body, dateKey) {
  const normalized = normalizeNewlines(body)
  const bounds = journalSectionBounds(normalized, dateKey)
  if (!bounds) return null
  return normalized
    .slice(bounds.contentStart, bounds.end)
    .replace(/^\n+/, '')
    .trimEnd()
}

export function upsertJournalDay(body, dateKey, markdown) {
  const normalized = normalizeNewlines(body).trimEnd()
  const content = normalizeNewlines(markdown).trimEnd()
  const section = `## ${dateKey}\n\n${content}`.trimEnd()
  const bounds = journalSectionBounds(normalized, dateKey)

  if (!bounds) {
    return `${normalized ? `${normalized}\n\n` : ''}${section}\n`
  }

  const before = normalized.slice(0, bounds.start).trimEnd()
  const after = normalized.slice(bounds.end).replace(/^\n+/, '').trimEnd()
  return [before, section, after].filter(Boolean).join('\n\n') + '\n'
}

function todayState({
  date,
  text = '',
  updatedAt = null,
  previous = null,
  archiveQueue = [],
  tomorrow = null,
}) {
  return {
    version: 3,
    date: validDateKey(date) ? date : localDateKey(),
    text: String(text || ''),
    updatedAt: updatedAt || null,
    previous: normalizePrevious(previous),
    archiveQueue: normalizeArchiveQueue(archiveQueue),
    tomorrow: normalizeTomorrow(tomorrow),
  }
}

function normalizePrevious(previous) {
  if (!previous || typeof previous !== 'object' || !validDateKey(previous.date)) return null
  const carryDates = [...new Set((Array.isArray(previous.carryDates)
    ? previous.carryDates
    : [previous.date]).filter(validDateKey))].sort()
  return {
    date: previous.date,
    text: String(previous.text || ''),
    carryText: String(previous.carryText ?? previous.text ?? ''),
    carryDates: carryDates.length ? carryDates : [previous.date],
    archivePending: previous.archivePending !== false,
    carryPending: previous.carryPending !== false,
  }
}

function normalizeArchiveQueue(queue) {
  if (!Array.isArray(queue)) return []
  const byDate = new Map()
  for (const entry of queue) {
    if (!entry || !validDateKey(entry.date) || !String(entry.text || '').trim()) continue
    byDate.set(entry.date, {
      date: entry.date,
      text: String(entry.text),
    })
  }
  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date))
}

function normalizeTomorrow(tomorrow) {
  if (!tomorrow || typeof tomorrow !== 'object' || !validDateKey(tomorrow.date)) return null
  return {
    date: tomorrow.date,
    text: String(tomorrow.text || ''),
    updatedAt: validTimestamp(tomorrow.updatedAt)?.toISOString() || null,
  }
}

function journalSectionBounds(body, dateKey) {
  if (!validDateKey(dateKey)) return null
  const headings = []
  const pattern = new RegExp(JOURNAL_HEADING_PATTERN.source, 'gm')
  for (const match of body.matchAll(pattern)) {
    headings.push({
      date: match[1],
      start: match.index,
      contentStart: match.index + match[0].length,
    })
  }
  const index = headings.findIndex(heading => heading.date === dateKey)
  if (index < 0) return null
  return {
    ...headings[index],
    end: headings[index + 1]?.start ?? body.length,
  }
}

function dateFromKey(dateKey) {
  if (!validDateKey(dateKey)) return null
  const [year, month, day] = dateKey.split('-').map(Number)
  const value = new Date(year, month - 1, day, 12)
  return localDateKey(value) === dateKey ? value : null
}

function validDateKey(value) {
  return DATE_KEY_PATTERN.test(String(value || '')) && Boolean(dateFromKeyUnchecked(value))
}

function dateFromKeyUnchecked(dateKey) {
  const [year, month, day] = String(dateKey).split('-').map(Number)
  const value = new Date(year, month - 1, day, 12)
  return value.getFullYear() === year
    && value.getMonth() === month - 1
    && value.getDate() === day
}

function validTimestamp(value) {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function normalizeNewlines(value) {
  return String(value || '').replace(/\r\n?/g, '\n')
}

function indentColumns(value) {
  let columns = 0
  for (const character of value) {
    columns += character === '\t' ? 4 - (columns % 4) : 1
  }
  return columns
}

function removeIndent(line, columns) {
  let removed = 0
  let index = 0
  while (index < line.length && removed < columns) {
    if (line[index] === ' ') {
      removed += 1
      index += 1
    } else if (line[index] === '\t') {
      removed += 4 - (removed % 4)
      index += 1
    } else {
      break
    }
  }
  return line.slice(index)
}
