export function parseBibtexEntries(text, source = 'references.bib') {
  const entries = []
  const errors = []
  const entryRe = /@(\w+)\s*\{\s*([^,\s]+)\s*,([\s\S]*?)(?=\n@\w+\s*\{|$)/g
  let match

  while ((match = entryRe.exec(text)) !== null) {
    const [, type, key, body] = match
    try {
      entries.push({
        type,
        key,
        source,
        author: readBibField(body, 'author') || 'Unknown author',
        year: readBibField(body, 'year') || 'n.d.',
        title: readBibField(body, 'title') || key,
        doi: readBibField(body, 'doi') || '',
      })
    } catch (error) {
      errors.push({
        source,
        message: `Could not parse BibTeX entry "${key}": ${error.message}`,
      })
    }
  }

  if (text.trim() && entries.length === 0) {
    errors.push({ source, message: 'No valid BibTeX entries found.' })
  }

  return { entries, errors }
}

function readBibField(body, field) {
  const re = new RegExp(`${field}\\s*=\\s*(\\{([^{}]*(?:\\{[^{}]*\\}[^{}]*)*)\\}|\"([^\"]*)\")`, 'i')
  const match = body.match(re)
  if (!match) return ''
  return cleanupBibValue(match[2] || match[3] || '')
}

function cleanupBibValue(value) {
  return value
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function referenceDiagnostics(text, references) {
  const byKey = new Map()
  const duplicateKeys = new Set()

  for (const ref of references) {
    if (byKey.has(ref.key)) duplicateKeys.add(ref.key)
    const arr = byKey.get(ref.key) || []
    arr.push(ref)
    byKey.set(ref.key, arr)
  }

  const cited = new Set()
  const missing = []
  const citationRe = /@([a-zA-Z][\w:-]*)/g
  let match

  while ((match = citationRe.exec(text)) !== null) {
    const key = match[1]
    cited.add(key)
    if (!byKey.has(key)) {
      missing.push({
        key,
        from: match.index,
        to: match.index + match[0].length,
        message: `Missing reference: @${key}`,
      })
    }
  }

  const unused = references.filter((ref) => !cited.has(ref.key))

  return {
    missing,
    duplicateKeys: [...duplicateKeys].map((key) => ({
      key,
      message: `Duplicate citation key: @${key}`,
      entries: byKey.get(key) || [],
    })),
    unused,
  }
}

export function formatReference(ref) {
  if (!ref) return ''
  return `${ref.author} (${ref.year}). ${ref.title}.`
}
