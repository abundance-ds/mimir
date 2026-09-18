<script>
import { defineComponent, h } from 'vue'
import { markdownChildren, markdownText } from './projectHomeMarkdown.js'

// Vue text nodes escape authored content. Raw HTML and unsafe link schemes
// never become active DOM, and files use the same opening path as the Editor.
export default defineComponent({
  props: { document: { type: Object, required: true }, section: { type: String, default: 'brief' } },
  emits: ['open'],
  setup(props, { emit }) {
    return () => {
      const doc = props.document
      const text = node => doc.source.slice(node.from, node.to)
      function inline(node, from = node.from, to = node.to) {
        const output = []
        let cursor = from
        for (const child of markdownChildren(node)) {
          if (child.from < from || child.to > to) continue
          if (child.from > cursor) output.push(doc.source.slice(cursor, child.from))
          output.push(render(child))
          cursor = child.to
        }
        if (cursor < to) output.push(doc.source.slice(cursor, to))
        return output
      }
      function link(node, resource = false) {
        const { destination, from, to, raw } = doc.link(node)
        const label = node.name === 'Autolink' ? [raw] : inline(node, from, to)
        if (!destination) return h('span', label)
        let detail = destination.kind === 'graph' ? 'Graph' : destination.kind === 'url' ? new URL(destination.target).hostname : 'File'
        const resourcePath = destination.kind === 'url' ? new URL(destination.target).pathname : destination.target
        const extension = /\.([a-z\d]{2,5})(?:[?#]|$)/i.exec(resourcePath)?.[1]
        if (extension && destination.kind !== 'graph') detail = extension.toUpperCase()
        return h('button', {
          type: 'button', class: resource ? 'project-resource-link' : 'project-inline-link',
          'data-graph-control': `project-link-${node.from}`,
          title: destination.kind === 'graph' ? undefined : destination.target,
          onClick: () => emit('open', destination),
        }, resource ? [h('span', { class: 'project-resource-label' }, label), h('small', detail), h('span', { class: 'project-resource-arrow', 'aria-hidden': 'true' }, '↗')] : label)
      }
      function render(node) {
        const name = node.name
        if (/Mark$/.test(name) || ['URL', 'LinkTitle', 'LinkLabel', 'TableDelimiter'].includes(name)) return null
        if (name === 'Entity') return markdownText(text(node))
        if (name === 'Escape') return text(node).slice(1)
        if (name === 'HardBreak') return h('br')
        if (['Link', 'Autolink', 'Image'].includes(name)) return link(node)
        if (name === 'InlineCode') {
          const marks = node.getChildren('CodeMark')
          return h('code', doc.source.slice(marks[0].to, marks[1].from).replace(/\n/g, ' '))
        }
        if (['FencedCode', 'CodeBlock'].includes(name)) return h('pre', h('code', node.getChildren('CodeText').map(text).join('\n') || text(node)))
        if (['HTMLBlock', 'HTMLTag', 'Comment'].includes(name)) return text(node)
        const level = Number(/(?:ATX|Setext)Heading(\d)/.exec(name)?.[1])
        if (level) return h(`h${Math.min(6, level + 1)}`, inline(node))
        const inlineTags = { StrongEmphasis: 'strong', Emphasis: 'em', Strikethrough: 's', Paragraph: 'p', Task: 'p', TableCell: node.parent?.name === 'TableHeader' ? 'th' : 'td' }
        if (name === 'Paragraph' && props.section === 'resources') {
          const links = markdownChildren(node)
          if (links.length === 1 && ['Link', 'Autolink'].includes(links[0].name) && text(node).trim() === text(links[0]).trim()) return link(links[0], true)
        }
        if (inlineTags[name]) return h(inlineTags[name], inline(node))
        if (name === 'HorizontalRule') return h('hr')
        if (name === 'Table') return h('div', { class: 'project-markdown-table' }, h('table', h('tbody', markdownChildren(node).map(render))))
        const blockTags = { BulletList: 'ul', OrderedList: 'ol', ListItem: 'li', Blockquote: 'blockquote', TableHeader: 'tr', TableRow: 'tr', Task: 'p' }
        if (blockTags[name]) {
          const attrs = name === 'OrderedList' ? { start: Number(/^\d+/.exec(text(node))?.[0]) || 1 } : {}
          return h(blockTags[name], attrs, markdownChildren(node).filter(child => !/Mark$/.test(child.name)).map(render))
        }
        if (name === 'TaskMarker') return h('span', { 'aria-label': /x/i.test(text(node)) ? 'Complete' : 'Incomplete' }, /x/i.test(text(node)) ? '☑ ' : '☐ ')
        return inline(node)
      }
      return h('div', { class: ['project-markdown', { 'project-resource-markdown': props.section === 'resources' }] }, doc[props.section].map(render))
    }
  },
})
</script>

<style scoped>
.project-markdown { color: var(--color-ink-2); font-size: 13px; line-height: 1.65; overflow-wrap: anywhere; user-select: text; }
.project-markdown :deep(p) { margin: 0 0 12px; }
.project-markdown :deep(h2), .project-markdown :deep(h3), .project-markdown :deep(h4) { margin: 20px 0 8px; color: var(--color-ink); font-size: 14px; font-weight: 650; }
.project-markdown :deep(:first-child) { margin-top: 0; }
.project-markdown :deep(ul), .project-markdown :deep(ol) { margin: 6px 0 14px; padding-left: 20px; list-style: revert; }
.project-markdown :deep(li) { margin: 4px 0; }
.project-markdown :deep(li p) { margin-bottom: 4px; }
.project-markdown :deep(blockquote) { margin: 12px 0; padding: 6px 12px; background: var(--color-chrome-high); }
.project-markdown :deep(code) { font-family: var(--font-mono); font-size: 11px; background: var(--color-chrome-high); }
.project-markdown :deep(pre) { margin: 12px 0; padding: 10px; overflow: auto; background: var(--color-chrome-high); }
.project-markdown :deep(strong) { color: var(--color-ink); font-weight: 650; }
.project-markdown :deep(.project-inline-link) { display: inline; color: var(--color-accent); text-align: inherit; text-decoration: underline; text-underline-offset: 2px; }
.project-markdown :deep(button:focus-visible) { outline: 2px solid var(--color-accent); outline-offset: 2px; }
.project-markdown :deep(.project-markdown-table) { overflow: auto; margin-bottom: 12px; }
.project-markdown :deep(table) { width: 100%; border-collapse: collapse; font-size: 12px; }
.project-markdown :deep(th), .project-markdown :deep(td) { padding: 5px 8px; border-bottom: 1px solid var(--color-rule-light); text-align: left; }
.project-resource-markdown :deep(ul) { padding: 0; list-style: none; }
.project-resource-markdown :deep(li) { margin: 2px 0; }
.project-markdown :deep(.project-resource-link) { display: grid; grid-template-columns: minmax(0, 1fr) auto 14px; width: 100%; min-height: 36px; align-items: center; gap: 10px; padding: 6px 8px; text-align: left; }
.project-markdown :deep(.project-resource-link:hover) { background: var(--color-chrome-mid); }
.project-markdown :deep(.project-resource-label) { color: var(--color-accent); font-size: 13px; font-weight: 550; }
.project-markdown :deep(.project-resource-link small) { max-width: 100px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-ink-3); font-size: 10px; }
.project-markdown :deep(.project-resource-arrow) { color: var(--color-ink-3); }
</style>
