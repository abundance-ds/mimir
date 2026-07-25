export const MAX_TOOL_OUTPUT_CHARS = 24_000

export async function readDocument(contextGetDocument) {
  let content = null
  let path = null
  if (contextGetDocument) {
    const ctx = contextGetDocument()
    if (ctx && typeof ctx.content === 'string') {
      content = ctx.content
      path = ctx.path || null
    }
  }
  if (content == null) {
    content = localStorage.getItem('mim:doc')
    path = localStorage.getItem('mim:doc:path') || null
  }
  if (content != null) {
    return {
      documentId: path ? path.replace(/[^a-zA-Z0-9._/-]+/g, '-') : 'local-document',
      title: firstHeading(content) || (path ? path.split('/').pop() : 'Current document'),
      path,
      content,
    }
  }
  return { documentId: 'empty', title: 'No document open', path: null, content: '' }
}

export function limitText(text, maxCharacters = MAX_TOOL_OUTPUT_CHARS) {
  if (!text || text.length <= maxCharacters) return text || ''
  return `${text.slice(0, maxCharacters)}\n\n[Truncated at ${maxCharacters} characters.]`
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
