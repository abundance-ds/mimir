import { parseBibtex } from '../../bibtexParser'

export const MAX_TOOL_OUTPUT_CHARS = 24_000

export async function readDocument(contextGetDocument) {
  let content = null
  let path = null
  if (contextGetDocument) {
    const ctx = contextGetDocument()
    if (ctx && ctx.content) { content = ctx.content; path = ctx.path || null }
  }
  if (!content) {
    content = localStorage.getItem('shoulders:doc')
    path = localStorage.getItem('shoulders:doc:path') || null
  }
  if (content) {
    return {
      documentId: path ? path.replace(/[^a-zA-Z0-9._/-]+/g, '-') : 'local-document',
      title: firstHeading(content) || (path ? path.split('/').pop() : 'Current document'),
      path,
      content,
    }
  }
  return { documentId: 'empty', title: 'No document open', path: null, content: '' }
}

export async function readReferences() {
  if (window.__TAURI_INTERNALS__) {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      return await invoke('ref_list')
    } catch (e) {
      console.warn('[tools] ref_list failed, falling back to localStorage:', e)
    }
  }
  try {
    const raw = localStorage.getItem('shoulders:refs')
    if (raw) return JSON.parse(raw)
  } catch (e) {
    console.warn('[tools] corrupt reference data in localStorage:', e)
  }
  return []
}

export function limitText(text, maxCharacters = MAX_TOOL_OUTPUT_CHARS) {
  if (!text || text.length <= maxCharacters) return text || ''
  return `${text.slice(0, maxCharacters)}\n\n[Truncated at ${maxCharacters} characters.]`
}

export function referenceHaystack(ref) {
  const authors = Array.isArray(ref.author)
    ? ref.author.map(a => `${a.family || ''} ${a.given || ''}`).join(' ')
    : ref.author || ''
  return [ref._key, ref.key, authors, ref.issued?.raw, ref.title, ref.source, ref['container-title']]
    .filter(Boolean).join(' ').toLowerCase()
}

export function firstHeading(markdown) {
  return markdown.split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('# '))
    ?.replace(/^#\s+/, '')
}

export function crossrefTypeToCsl(crType) {
  const map = {
    'journal-article': 'article-journal',
    'proceedings-article': 'paper-conference',
    'book-chapter': 'chapter',
    'book': 'book',
    'monograph': 'book',
    'report': 'report',
    'dataset': 'dataset',
    'posted-content': 'article',
    'dissertation': 'thesis',
  }
  return map[crType] || 'article'
}

export function reconstructAbstract(invertedIndex) {
  if (!invertedIndex || typeof invertedIndex !== 'object') return null
  const words = []
  for (const [word, positions] of Object.entries(invertedIndex)) {
    for (const pos of positions) {
      words[pos] = word
    }
  }
  return words.join(' ')
}

export { parseBibtex }
