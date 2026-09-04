import { EditorView, Decoration, ViewPlugin } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import { RangeSetBuilder } from '@codemirror/state'

const codeLineDeco = Decoration.line({ class: 'cm-md-code-line' })

const codeBlockTheme = EditorView.baseTheme({
  '.cm-md-code-line': {
    backgroundColor: 'var(--code-block-bg)',
  },
})

// Line decorations for every line inside a FencedCode or CodeBlock node.
const codeBlockPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = buildCodeLineDecos(view)
    }
    update(update) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        syntaxTree(update.state) !== syntaxTree(update.startState)
      ) {
        this.decorations = buildCodeLineDecos(update.view)
      }
    }
  },
  { decorations: (v) => v.decorations },
)

function buildCodeLineDecos(view) {
  const { state } = view
  const margin = 500
  const { from: vpFrom, to: vpTo } = view.viewport
  const start = Math.max(0, vpFrom - margin)
  const end = Math.min(state.doc.length, vpTo + margin)

  const lineStarts = new Set()

  syntaxTree(state).iterate({
    from: start,
    to: end,
    enter(node) {
      const name = node.type.name
      if (name === 'FencedCode' || name === 'CodeBlock') {
        const fromLine = state.doc.lineAt(node.from).number
        const toLine = state.doc.lineAt(node.to).number
        for (let l = fromLine; l <= toLine; l++) {
          lineStarts.add(state.doc.line(l).from)
        }
        return false
      }
    },
  })

  const sorted = [...lineStarts].sort((a, b) => a - b)
  const builder = new RangeSetBuilder()
  for (const pos of sorted) {
    builder.add(pos, pos, codeLineDeco)
  }
  return builder.finish()
}

export function markdownCodeBlocks() {
  return [codeBlockPlugin, codeBlockTheme]
}
