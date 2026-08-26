const TEXT_FILE_EXTENSIONS = new Set([
  'bash', 'bib', 'c', 'cc', 'cfg', 'conf', 'cpp', 'css', 'csv', 'fish', 'go',
  'h', 'hpp', 'htm', 'html', 'ini', 'java', 'js', 'json', 'jsonc', 'jsx',
  'kt', 'kts', 'less', 'lua', 'm', 'markdown', 'md', 'mdown', 'mkd', 'mm',
  'mjs', 'mts', 'php', 'pl', 'properties', 'py', 'r', 'rb', 'rs', 'scss',
  'sh', 'sql', 'svg', 'swift', 'toml', 'ts', 'tsx', 'txt', 'vue', 'xml',
  'yaml', 'yml', 'zsh',
])

const SPECIAL_FILE_NAMES = new Set([
  'AGENTS.md', 'Cargo.lock', 'Cargo.toml', 'Dockerfile', 'Makefile',
  'README', 'README.md',
])

// Keep the same conservative URL boundary as @xterm/addon-web-links. The
// custom provider uses it only for a URL that continues after a hard newline;
// ordinary web links stay owned by the upstream addon.
const STRICT_WEB_URL_RE = /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\\^<>`]*[^\s"':,.!?{}|\\\^~\[\]`()<>]/g
const TOKEN_RE = /[^\s"'`<>]+/g
const MARKDOWN_TARGET_RE = /\]\(([^)\s]+)\)/g

export function findTerminalFileReferences(text) {
  const value = String(text || '')
  const found = []
  const occupied = []

  for (const match of value.matchAll(MARKDOWN_TARGET_RE)) {
    const target = match[1]
    const start = match.index + match[0].indexOf(target)
    const reference = parseFileReference(target, start)
    if (!reference) continue
    found.push(reference)
    occupied.push([reference.start, reference.end])
  }

  for (const match of value.matchAll(TOKEN_RE)) {
    if (match[0].includes('](')) continue
    const trimmed = trimToken(match[0], match.index)
    if (!trimmed.text || occupied.some(([start, end]) => (
      trimmed.start >= start && trimmed.end <= end
    ))) continue
    const reference = parseFileReference(trimmed.text, trimmed.start)
    if (reference) found.push(reference)
  }

  return dedupeReferences(found)
}

export function resolveTerminalFileReference(reference, baseDirectory, homeDirectory = '') {
  let path = String(reference?.path || '').trim()
  if (!path) return ''

  if (/^file:\/\//i.test(path)) {
    try {
      const url = new URL(path)
      if (url.protocol !== 'file:') return ''
      path = decodeURIComponent(url.pathname)
    } catch {
      return ''
    }
  }

  if (path === '~' || path.startsWith('~/')) {
    if (!homeDirectory) return ''
    path = `${String(homeDirectory).replace(/\/$/, '')}${path.slice(1)}`
  }

  if (isAbsolutePath(path)) return normalizePath(path)
  const base = String(baseDirectory || '').trim()
  if (!base) return ''
  return normalizePath(`${base.replace(/[\\/]$/, '')}/${path}`)
}

export function createTerminalLinkProvider(terminal, {
  baseDirectory = '',
  homeDirectory = '',
  onOpenFile = () => {},
  onOpenUrl = () => {},
} = {}) {
  return {
    provideLinks(bufferLineNumber, callback) {
      const lineIndex = Number(bufferLineNumber) - 1
      if (!Number.isInteger(lineIndex) || lineIndex < 0) {
        callback(undefined)
        return
      }

      const groups = wrappedGroupsNear(terminal, lineIndex, 2)
      const candidates = continuationCandidates(groups)
      const links = []

      // Full continuation candidates have priority over a shorter reference
      // that happens to be valid on one physical line.
      for (const candidate of candidates) {
        for (const reference of findTerminalWebReferences(candidate.text)) {
          addReferenceLinks(links, terminal, bufferLineNumber, candidate, reference, () => {
            onOpenUrl(reference.url)
          })
        }
        for (const reference of findTerminalFileReferences(candidate.text)) {
          addReferenceLinks(links, terminal, bufferLineNumber, candidate, reference, () => {
            const path = resolveTerminalFileReference(
              reference,
              currentValue(baseDirectory),
              currentValue(homeDirectory),
            )
            if (path) onOpenFile({ ...reference, path })
          })
        }
      }

      for (const group of groups) {
        const candidate = candidateFromGroup(group)
        for (const reference of findTerminalFileReferences(candidate.text)) {
          addReferenceLinks(links, terminal, bufferLineNumber, candidate, reference, () => {
            const path = resolveTerminalFileReference(
              reference,
              currentValue(baseDirectory),
              currentValue(homeDirectory),
            )
            if (path) onOpenFile({ ...reference, path })
          })
        }
      }

      callback(links.length ? links : undefined)
    },
  }
}

function parseFileReference(text, start) {
  let raw = String(text || '')
  if (!raw || /^https?:\/\//i.test(raw) || raw.includes('://') && !/^file:\/\//i.test(raw)) {
    return null
  }

  let line = null
  let column = null
  let path = raw
  const hashLocation = path.match(/#L(\d+)(?:C(\d+))?$/i)
  const colonLocation = path.match(/:(\d+)(?::(\d+))?$/)
  const location = hashLocation || colonLocation
  if (location) {
    line = Number(location[1])
    column = location[2] ? Number(location[2]) : null
    path = path.slice(0, -location[0].length)
  }

  if (!looksLikeFilePath(path)) return null
  return {
    kind: 'file',
    text: raw,
    path,
    line,
    column,
    start,
    end: start + raw.length,
  }
}

function findTerminalWebReferences(text) {
  const found = []
  for (const match of String(text || '').matchAll(STRICT_WEB_URL_RE)) {
    try {
      const url = new URL(match[0])
      if (!['http:', 'https:'].includes(url.protocol)) continue
      found.push({
        kind: 'url',
        text: match[0],
        url: url.href,
        start: match.index,
        end: match.index + match[0].length,
      })
    } catch {
      // An incomplete URL is not a link.
    }
  }
  return found
}

function trimToken(text, start) {
  let value = text
  let offset = 0
  while (value && '([{'.includes(value[0])) {
    value = value.slice(1)
    offset++
  }
  while (value && ')]},.;!?:'.includes(value.at(-1))) value = value.slice(0, -1)
  return {
    text: value,
    start: start + offset,
    end: start + offset + value.length,
  }
}

function looksLikeFilePath(path) {
  if (!path || path === '/' || path.endsWith('/') || path.startsWith('--')) return false
  if (/^file:\/\/\//i.test(path)) return true
  if (/^(?:\/|\.\.?\/|~\/)/.test(path)) return true

  const normalized = path.replace(/\\/g, '/')
  const name = normalized.split('/').at(-1)
  if (!name) return false
  if (SPECIAL_FILE_NAMES.has(name)) return true
  const extension = name.includes('.') ? name.split('.').at(-1).toLowerCase() : ''
  if (!TEXT_FILE_EXTENSIONS.has(extension)) return false
  return normalized.includes('/') || /^[A-Za-z0-9_@+.-]+$/.test(normalized)
}

function dedupeReferences(references) {
  const seen = new Set()
  return references
    .sort((left, right) => left.start - right.start || right.end - left.end)
    .filter((reference) => {
      const key = `${reference.start}:${reference.end}:${reference.path}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

function wrappedGroupsNear(terminal, lineIndex, radius) {
  const buffer = terminal?.buffer?.active
  if (!buffer?.getLine) return []
  const center = wrappedGroupAt(buffer, lineIndex)
  if (!center) return []
  const groups = [center]

  let previousStart = center.start - 1
  for (let count = 0; count < radius && previousStart >= 0; count++) {
    const group = wrappedGroupAt(buffer, previousStart)
    if (!group) break
    groups.unshift(group)
    previousStart = group.start - 1
  }

  let nextStart = center.end + 1
  for (let count = 0; count < radius; count++) {
    const group = wrappedGroupAt(buffer, nextStart)
    if (!group) break
    groups.push(group)
    nextStart = group.end + 1
  }
  return groups
}

function wrappedGroupAt(buffer, lineIndex) {
  if (!buffer.getLine(lineIndex)) return null
  let start = lineIndex
  while (start > 0 && buffer.getLine(start)?.isWrapped) start--
  let end = start
  while (buffer.getLine(end + 1)?.isWrapped) end++
  const text = []
  for (let index = start; index <= end; index++) {
    text.push(buffer.getLine(index).translateToString(true))
  }
  return { start, end, text: text.join('') }
}

function continuationCandidates(groups) {
  const candidates = []
  for (let start = 0; start < groups.length - 1; start++) {
    const pieces = [pieceForGroup(groups[start], 0)]
    let text = groups[start].text.trimEnd()
    if (!text.endsWith('/')) continue

    for (let index = start + 1; index < groups.length && pieces.length < 3; index++) {
      const group = groups[index]
      const indent = group.text.match(/^\s+/)?.[0].length || 0
      if (!indent || indent === group.text.length) break
      const continuation = group.text.slice(indent).trimEnd()
      if (!continuation) break
      const joinedStart = text.length
      pieces.push(pieceForGroup(group, joinedStart, indent, continuation.length))
      text += continuation
      if (!text.endsWith('/')) break
    }

    if (pieces.length > 1) candidates.push({ text, pieces })
  }
  return candidates
}

function candidateFromGroup(group) {
  return { text: group.text, pieces: [pieceForGroup(group, 0)] }
}

function pieceForGroup(group, joinedStart, sourceStart = 0, length = null) {
  const size = length ?? group.text.length
  return {
    group,
    joinedStart,
    joinedEnd: joinedStart + size,
    sourceStart,
  }
}

function addReferenceLinks(links, terminal, requestedLine, candidate, reference, activate) {
  for (const piece of candidate.pieces) {
    const start = Math.max(reference.start, piece.joinedStart)
    const end = Math.min(reference.end, piece.joinedEnd)
    if (start >= end) continue

    const sourceStart = piece.sourceStart + start - piece.joinedStart
    const sourceLength = end - start
    const range = rangeForString(terminal, piece.group.start, sourceStart, sourceLength)
    if (!range || requestedLine < range.start.y || requestedLine > range.end.y) continue
    if (links.some(link => rangesOverlap(link.range, range, terminal.cols))) continue

    links.push({
      range,
      text: reference.text,
      activate,
    })
  }
}

function rangeForString(terminal, startLine, stringStart, stringLength) {
  const [startY, startX] = mapStringIndex(terminal, startLine, 0, stringStart)
  const [endY, endX] = mapStringIndex(terminal, startY, startX, stringLength)
  if ([startY, startX, endY, endX].some(value => value < 0)) return null
  return {
    start: { x: startX + 1, y: startY + 1 },
    end: { x: endX, y: endY + 1 },
  }
}

// This mirrors xterm's string-to-cell mapping. A JavaScript character does not
// always occupy one terminal cell, and a wide character can wrap early.
function mapStringIndex(terminal, lineIndex, rowIndex, stringIndex) {
  const buffer = terminal.buffer.active
  const cell = buffer.getNullCell()
  let start = rowIndex
  while (stringIndex) {
    const line = buffer.getLine(lineIndex)
    if (!line) return [-1, -1]
    for (let index = start; index < line.length; index++) {
      line.getCell(index, cell)
      const chars = cell.getChars()
      if (cell.getWidth()) {
        stringIndex -= chars.length || 1
        if (index === line.length - 1 && chars === '') {
          const next = buffer.getLine(lineIndex + 1)
          if (next?.isWrapped) {
            next.getCell(0, cell)
            if (cell.getWidth() === 2) stringIndex++
          }
        }
      }
      if (stringIndex < 0) return [lineIndex, index]
    }
    lineIndex++
    start = 0
  }
  return [lineIndex, start]
}

function rangesOverlap(left, right, columns) {
  const leftStart = left.start.y * columns + left.start.x
  const leftEnd = left.end.y * columns + left.end.x
  const rightStart = right.start.y * columns + right.start.x
  const rightEnd = right.end.y * columns + right.end.x
  return leftStart <= rightEnd && rightStart <= leftEnd
}

function currentValue(value) {
  return typeof value === 'function' ? value() : value
}

function isAbsolutePath(path) {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)
}

function normalizePath(path) {
  if (/^[A-Za-z]:[\\/]/.test(path)) {
    const drive = path.slice(0, 2)
    return `${drive}/${normalizeSegments(path.slice(2).replace(/\\/g, '/'))}`
  }
  return `/${normalizeSegments(path)}`
}

function normalizeSegments(path) {
  const parts = []
  for (const part of String(path).replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return parts.join('/')
}
