function strip(html) {
  return html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#xa0;/g, ' ').trim()
}

export function htmlToReadable(html, commentMap = {}) {
  let text = html

  // Inject inline comment markers before stripping HTML
  for (const [id, { author, text: cText }] of Object.entries(commentMap)) {
    const pattern = new RegExp(
      `<sup><a href="#comment-${id}" id="comment-ref-${id}">\\[\\d+\\]</a></sup>`,
      'g',
    )
    text = text.replace(pattern, `«[Comment #${id} by ${author}: "${cText}"]»`)
  }

  // Strip trailing <dl>...</dl> comment block
  text = text.replace(/<dl>[\s\S]*?<\/dl>\s*$/gi, '')

  text = text.replace(/<h1[^>]*>(.*?)<\/h1>/gi, (_, t) => `\n# ${strip(t)}\n`)
  text = text.replace(/<h2[^>]*>(.*?)<\/h2>/gi, (_, t) => `\n## ${strip(t)}\n`)
  text = text.replace(/<h3[^>]*>(.*?)<\/h3>/gi, (_, t) => `\n### ${strip(t)}\n`)
  text = text.replace(/<h4[^>]*>(.*?)<\/h4>/gi, (_, t) => `\n#### ${strip(t)}\n`)
  text = text.replace(/<h5[^>]*>(.*?)<\/h5>/gi, (_, t) => `\n##### ${strip(t)}\n`)
  text = text.replace(/<h6[^>]*>(.*?)<\/h6>/gi, (_, t) => `\n###### ${strip(t)}\n`)
  text = text.replace(/<table[^>]*>/gi, '\n')
  text = text.replace(/<\/table>/gi, '\n')
  text = text.replace(/<tr[^>]*>/gi, '| ')
  text = text.replace(/<\/tr>/gi, '\n')
  text = text.replace(/<t[dh][^>]*>/gi, '')
  text = text.replace(/<\/t[dh]>/gi, ' | ')
  text = text.replace(/<ul[^>]*>/gi, '\n')
  text = text.replace(/<\/ul>/gi, '\n')
  text = text.replace(/<ol[^>]*>/gi, '\n')
  text = text.replace(/<\/ol>/gi, '\n')
  text = text.replace(/<li[^>]*>(.*?)<\/li>/gi, (_, t) => `- ${strip(t)}\n`)
  text = text.replace(/<p[^>]*>(.*?)<\/p>/gi, (_, t) => `${strip(t)}\n\n`)
  text = text.replace(/<br\s*\/?>/gi, '\n')
  text = text.replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, '[Image: $1]')
  text = text.replace(/<img[^>]*>/gi, '[Image]')
  text = text.replace(/<figure[^>]*>/gi, '\n')
  text = text.replace(/<\/figure>/gi, '\n')
  text = text.replace(/<figcaption[^>]*>(.*?)<\/figcaption>/gi, (_, t) => `Caption: ${strip(t)}\n`)
  text = text.replace(/<strong[^>]*>(.*?)<\/strong>/gi, '**$1**')
  text = text.replace(/<em[^>]*>(.*?)<\/em>/gi, '*$1*')
  text = text.replace(/<[^>]+>/g, '')
  text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#xa0;/g, ' ').replace(/&nbsp;/g, ' ')
  text = text.replace(/\n{3,}/g, '\n\n')
  return text.trim()
}

export function extractCommentsFromHtml(html) {
  const commentMap = {}
  const dlMatch = html.match(/<dl>([\s\S]*?)<\/dl>\s*$/i)
  if (!dlMatch) return commentMap

  const entryPattern = /<dt><a id="comment-(\d+)">[^<]*<\/a><\/dt>\s*<dd>([\s\S]*?)<\/dd>/gi
  let m
  while ((m = entryPattern.exec(dlMatch[1])) !== null) {
    const id = m[1]
    const text = strip(m[2])
    commentMap[id] = { author: 'Reviewer', text }
  }
  return commentMap
}

export async function readDocxAsText(filePath) {
  const { invoke } = await import('@tauri-apps/api/core')
  const base64 = await invoke('read_binary_file', { path: filePath })

  const binaryString = atob(base64)
  const bytes = new Uint8Array(binaryString.length)
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i)
  }
  const buffer = bytes.buffer

  const mammoth = await import('mammoth')
  const convert = mammoth.default?.convertToHtml || mammoth.convertToHtml
  const result = await convert(
    { arrayBuffer: buffer },
    { styleMap: ['comment-reference => sup'] },
  )

  const commentMap = extractCommentsFromHtml(result.value)
  return htmlToReadable(result.value, commentMap)
}
