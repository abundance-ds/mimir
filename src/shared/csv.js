// CSV read and write helpers shared by Graph exports and imports.

/** Quote every cell and neutralize spreadsheet formulas in authored text. */
export function csvCell(value) {
  let text = String(value ?? '')
  if (/^[\s]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`
  return `"${text.replaceAll('"', '""')}"`
}

export function toCsv(rows) {
  return rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n'
}

/**
 * Parse RFC 4180 CSV: quoted fields, doubled quotes, embedded commas and
 * line breaks, CRLF or LF rows, and an optional byte order mark.
 * Returns an array of string arrays. Blank lines are dropped.
 */
export function parseCsv(text) {
  const source = String(text ?? '').replace(/^﻿/, '')
  const rows = []
  let row = [], field = '', quoted = false, fieldStarted = false
  const endField = () => { row.push(field); field = ''; fieldStarted = false }
  const endRow = () => {
    endField()
    if (row.length > 1 || row[0] !== '') rows.push(row)
    row = []
  }
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') { field += '"'; index += 1 }
        else quoted = false
      } else field += char
      continue
    }
    if (char === '"' && !fieldStarted) { quoted = true; fieldStarted = true }
    else if (char === ',') endField()
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') index += 1
      endRow()
    } else { field += char; fieldStarted = true }
  }
  if (field !== '' || fieldStarted || row.length) endRow()
  return rows
}

/** Parse CSV with a header row into objects keyed by trimmed header text. */
export function parseCsvRecords(text, { findHeader } = {}) {
  const rows = parseCsv(text)
  // Some exports put notes above the header; let the caller find it.
  const headerIndex = findHeader ? Math.max(0, rows.findIndex(findHeader)) : 0
  const header = (rows[headerIndex] || []).map(cell => cell.trim())
  return rows.slice(headerIndex + 1).map(cells => Object.fromEntries(
    header.map((name, column) => [name, (cells[column] ?? '').trim()]),
  ))
}
