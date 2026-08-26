import { EditorView, Decoration, ViewPlugin, WidgetType } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import { RangeSetBuilder } from '@codemirror/state'

// Matches "[ ] label", "[x] label", "- [ ] label", "* [x] label", etc.
const CHECKBOX_LINE_RE = /^(\s*(?:[-*+]\s+)?)\[([ xX])\](?:[ \t]+(.*))?$/

class TaskCheckboxWidget extends WidgetType {
  constructor(checked, statePos) {
    super()
    this.checked = checked
    this.statePos = statePos
  }

  eq(other) {
    return other.checked === this.checked && other.statePos === this.statePos
  }

  ignoreEvent() {
    return true
  }

  toDOM(view) {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'cm-lp-task-checkbox'
    box.checked = this.checked
    box.setAttribute('aria-label', this.checked ? 'Mark task as not done' : 'Mark task as done')
    box.addEventListener('mousedown', (event) => event.preventDefault())
    box.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      view.dispatch({
        changes: { from: this.statePos, to: this.statePos + 1, insert: this.checked ? ' ' : 'x' },
      })
    })
    return box
  }
}

function collectCodeRanges(state, from, to) {
  const ranges = []
  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      if (node.type.name === 'FencedCode' || node.type.name === 'CodeBlock') {
        ranges.push([node.from, node.to])
        return false
      }
    },
  })
  return ranges
}

function inCodeRange(pos, ranges) {
  return ranges.some(([from, to]) => pos >= from && pos < to)
}

function buildCheckboxDecorations(view, isEnabled) {
  if (!isEnabled()) return Decoration.none

  const { state } = view
  const { from: vpFrom, to: vpTo } = view.viewport
  const start = Math.max(0, vpFrom - 500)
  const end = Math.min(state.doc.length, vpTo + 500)

  const cursorLines = new Set()
  for (const range of state.selection.ranges) {
    const headLine = state.doc.lineAt(range.head).number
    const anchorLine = state.doc.lineAt(range.anchor).number
    for (let l = Math.min(headLine, anchorLine); l <= Math.max(headLine, anchorLine); l++) {
      cursorLines.add(l)
    }
  }

  const codeRanges = collectCodeRanges(state, start, end)
  const startLine = state.doc.lineAt(start).number
  const endLine = state.doc.lineAt(end).number

  const decos = []
  for (let ln = startLine; ln <= endLine; ln++) {
    const line = state.doc.line(ln)
    if (inCodeRange(line.from, codeRanges)) continue

    const match = CHECKBOX_LINE_RE.exec(line.text)
    if (!match) continue

    const prefixLen = match[1].length
    const bracketStart = line.from + prefixLen
    const statePos = bracketStart + 1
    const checked = match[2].toLowerCase() === 'x'
    const labelStart = bracketStart + 3

    if (!cursorLines.has(ln)) {
      decos.push(
        Decoration.replace({ widget: new TaskCheckboxWidget(checked, statePos) }).range(bracketStart, labelStart)
      )
    }

    if (checked && labelStart < line.to) {
      decos.push(Decoration.mark({ class: 'cm-lp-task-done' }).range(labelStart, line.to))
    }
  }

  decos.sort((a, b) => a.from - b.from || a.startSide - b.startSide)

  const builder = new RangeSetBuilder()
  for (const d of decos) {
    builder.add(d.from, d.to, d.value)
  }
  return builder.finish()
}

const taskCheckboxTheme = EditorView.baseTheme({
  '.cm-lp-task-checkbox': {
    appearance: 'none',
    WebkitAppearance: 'none',
    MozAppearance: 'none',
    boxSizing: 'border-box',
    position: 'relative',
    width: '14px',
    height: '14px',
    margin: '0 6px 0 0',
    verticalAlign: 'middle',
    border: '1.5px solid var(--color-ink-4)',
    borderRadius: '3px',
    background: 'var(--color-surface)',
    cursor: 'pointer',
  },
  '.cm-lp-task-checkbox:hover': {
    borderColor: 'var(--color-accent)',
  },
  '.cm-lp-task-checkbox:focus-visible': {
    outline: '1px solid var(--color-accent)',
    outlineOffset: '1px',
  },
  '.cm-lp-task-checkbox:checked': {
    background: 'var(--color-accent)',
    borderColor: 'var(--color-accent)',
  },
  '.cm-lp-task-checkbox:checked::after': {
    content: '""',
    position: 'absolute',
    left: '3px',
    top: '0px',
    width: '4px',
    height: '8px',
    border: 'solid var(--color-accent-ink, white)',
    borderWidth: '0 1.5px 1.5px 0',
    transform: 'rotate(45deg)',
  },
  '.cm-lp-task-done': {
    textDecoration: 'line-through',
    color: 'var(--color-ink-4)',
  },
})

export function taskCheckboxExtension(isEnabled) {
  const plugin = ViewPlugin.fromClass(
    class {
      constructor(view) {
        this._enabled = isEnabled()
        this.decorations = buildCheckboxDecorations(view, isEnabled)
      }

      update(update) {
        const nowEnabled = isEnabled()
        if (
          nowEnabled !== this._enabled ||
          update.docChanged ||
          update.viewportChanged ||
          update.selectionSet ||
          syntaxTree(update.state) !== syntaxTree(update.startState)
        ) {
          this._enabled = nowEnabled
          this.decorations = buildCheckboxDecorations(update.view, isEnabled)
        }
      }
    },
    { decorations: (v) => v.decorations }
  )

  return [plugin, taskCheckboxTheme]
}

export { buildCheckboxDecorations as _buildCheckboxDecorations }
