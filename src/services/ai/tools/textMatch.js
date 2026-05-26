/**
 * Builds a regex that matches both ASCII and Unicode typographic variants.
 * LLMs normalize characters when generating tool arguments (curly quotes → straight,
 * em-dash → hyphen, ellipsis → dots). This prevents edit failures from those substitutions.
 */
export function buildTypographicRegex(str) {
  let pattern = ''
  let i = 0
  while (i < str.length) {
    if (str[i] === '.' && str[i + 1] === '.' && str[i + 2] === '.') {
      pattern += '(?:\\.\\.\\.|…)'
      i += 3
      continue
    }
    if (str[i] === '-' && str[i + 1] === '-') {
      pattern += '(?:--|[–—])'
      i += 2
      continue
    }
    const c = str[i]
    switch (c) {
      case '"': pattern += '[“”„«»"]'; break
      case "'": pattern += '[‘’‚‹›\']'; break
      case '‘': case '’': pattern += '[‘’‚‹›\']'; break
      case '“': case '”': pattern += '[“”„«»"]'; break
      case '-': pattern += '[-–—]'; break
      case '–': case '—': pattern += '[-–—]'; break
      case '…': pattern += '(?:\\.\\.\\.|…)'; break
      case ' ': pattern += '[  ]'; break
      case ' ': pattern += '[  ]'; break
      default: pattern += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
    i++
  }
  return new RegExp(pattern)
}

export function resolveSafePath(relativePath, workspacePath) {
  if (!workspacePath) return null
  if (!relativePath) return workspacePath
  const resolved = relativePath.startsWith('/') ? relativePath : workspacePath + '/' + relativePath
  const parts = resolved.split('/')
  const normalized = []
  for (const part of parts) {
    if (part === '..') normalized.pop()
    else if (part !== '.' && part !== '') normalized.push(part)
  }
  const canonicalized = '/' + normalized.join('/')
  if (!canonicalized.startsWith(workspacePath)) return null
  return canonicalized
}

/**
 * Normalize whitespace for more tolerant matching:
 * - Collapse multiple spaces to single space
 * - Normalize \r\n to \n
 * - Trim trailing whitespace per line
 */
function normalizeWhitespace(text) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/[ \t]{2,}/g, ' ')
}

export function findTargetText(docText, targetText) {
  if (!docText || !targetText) return null

  // 1. Exact match (fastest)
  const idx = docText.indexOf(targetText)
  if (idx !== -1) return { from: idx, to: idx + targetText.length }

  // 2. Typographic variant match
  const regex = buildTypographicRegex(targetText)
  const match = regex.exec(docText)
  if (match) return { from: match.index, to: match.index + match[0].length }

  // 3. Whitespace-normalized match
  const normDoc = normalizeWhitespace(docText)
  const normTarget = normalizeWhitespace(targetText)
  if (normTarget !== targetText || normDoc !== docText) {
    // Try exact match on normalized text
    const normIdx = normDoc.indexOf(normTarget)
    if (normIdx !== -1) {
      const mappedRange = mapNormalizedRange(docText, normDoc, normIdx, normTarget.length)
      if (mappedRange) return mappedRange
    }
    // Try typographic match on normalized text
    const normRegex = buildTypographicRegex(normTarget)
    const normMatch = normRegex.exec(normDoc)
    if (normMatch) {
      const mappedRange = mapNormalizedRange(docText, normDoc, normMatch.index, normMatch[0].length)
      if (mappedRange) return mappedRange
    }
  }

  return null
}

export function countMatches(docText, targetText) {
  if (!docText || !targetText) return 0

  // Stage 1: count exact indexOf matches
  let count = 0
  let pos = 0
  while ((pos = docText.indexOf(targetText, pos)) !== -1) {
    count++
    pos += targetText.length
  }
  if (count > 0) return count

  // Stage 2: typographic regex matches
  const regex = buildTypographicRegex(targetText)
  const globalRegex = new RegExp(regex.source, 'g')
  const matches = docText.match(globalRegex)
  return matches ? matches.length : 0
}

/**
 * Map a range in normalized text back to the original text.
 * Both texts have the same logical structure, but may differ in whitespace.
 */
function mapNormalizedRange(original, normalized, normFrom, normLength) {
  const map = new Array(normalized.length)
  let oi = 0
  let ni = 0
  while (ni < normalized.length && oi < original.length) {
    if (normalized[ni] === original[oi]) {
      map[ni] = oi
      ni++
      oi++
    } else {
      oi++
    }
  }
  const from = map[normFrom]
  const lastNormIdx = normFrom + normLength - 1
  const toBase = map[lastNormIdx]
  if (from == null || toBase == null) return null
  return { from, to: toBase + 1 }
}
