import { parser, GFM } from '@lezer/markdown'
import { markdownLinkDestination } from '../../../editor/codemirror/markdownLinks.js'

const markdown = parser.configure(GFM)
const children = node => {
  const result = []
  for (let child = node.firstChild; child; child = child.nextSibling) result.push(child)
  return result
}
export { children as markdownChildren }

export function markdownText(value) {
  const text = String(value).replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, '$1')
  return text.replace(/&(?:#[xX][\da-fA-F]+|#\d+|[A-Za-z][A-Za-z\d]+);/g, entity => {
    const element = document.createElement('textarea')
    element.innerHTML = entity
    return element.value
  })
}
const referenceKey = value => markdownText(value).trim().replace(/\s+/g, ' ').toUpperCase()

// Ordinary Markdown owns the page. The Resources section is only a display
// convention; parsing never rewrites or discards source text.
export function projectHomeMarkdown(value) {
  const source = String(value || '')
  const nodes = children(markdown.parse(source).topNode)
  const definitions = new Map()
  for (const node of nodes) {
    if (node.name !== 'LinkReference') continue
    const label = node.getChild('LinkLabel'), url = node.getChild('URL')
    if (label && url) {
      const key = referenceKey(source.slice(label.from + 1, label.to - 1))
      if (!definitions.has(key)) definitions.set(key, source.slice(url.from, url.to))
    }
  }
  const brief = [], resources = []
  let resourceLevel = 0
  for (const node of nodes) {
    const level = Number(/(?:ATX|Setext)Heading(\d)/.exec(node.name)?.[1])
    const heading = source.slice(node.from, node.to).replace(/^#+\s*|\s*#+$|\n[=-]+$/g, '').trim().toLowerCase()
    if (level && (!resourceLevel || level <= resourceLevel)) {
      resourceLevel = ['resources', 'key resources'].includes(heading) ? level : 0
      if (resourceLevel) continue
    }
    if (node.name !== 'LinkReference') (resourceLevel ? resources : brief).push(node)
  }
  function link(node) {
    const url = node.getChild('URL'), marks = node.getChildren('LinkMark')
    const from = marks[0]?.to ?? node.from, to = marks[1]?.from ?? node.to
    const reference = node.getChild('LinkLabel')
    const key = referenceKey(reference && reference.to - reference.from > 2
      ? source.slice(reference.from + 1, reference.to - 1) : source.slice(from, to))
    const raw = markdownText(url ? source.slice(url.from, url.to) : definitions.get(key) || '')
    return { from, to, destination: markdownLinkDestination(raw), raw }
  }
  return { source, brief, resources, link }
}
