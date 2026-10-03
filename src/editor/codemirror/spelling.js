import { StateEffect, Transaction } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin } from '@codemirror/view'
import { ensureSyntaxTree, language, syntaxTree } from '@codemirror/language'
import { checkSpelling } from '../../services/spelling.js'
import { manualTextInputAttributes } from '../../shared/textInputPolicy.js'

const spellingResults = StateEffect.define()
const misspelling = Decoration.mark({ class: 'cm-misspelled', attributes: { 'data-spelling-error': 'true' } })
const excludedNodes = new Set(['FencedCode', 'CodeBlock', 'InlineCode', 'URL', 'Autolink',
  'HTMLTag', 'HTMLBlock', 'LinkReference'])
const CHUNK_SIZE = 8192

// Preserve UTF-16 offsets, including surrogate pairs, while withholding code,
// URLs, and hidden comment metadata from the spelling engine.
export function spellingChunks(state, visibleRanges) {
  const name = state.facet(language)?.name
  if (name && name !== 'markdown') return []
  const areas = []
  for (const range of visibleRanges) {
    const from = state.doc.lineAt(range.from).from
    const to = state.doc.lineAt(range.to).to
    if (areas.length && from <= areas.at(-1).to) areas.at(-1).to = Math.max(to, areas.at(-1).to)
    else areas.push({ from, to })
  }
  const tree = ensureSyntaxTree(state, areas.at(-1)?.to ?? 0, 20) || syntaxTree(state)
  const chunks = []
  for (const area of areas) {
    for (let from = area.from; from < area.to;) {
      let to = Math.min(from + CHUNK_SIZE, area.to)
      if (to < area.to) {
        const tail = state.sliceDoc(Math.max(from, to - 256), to)
        const boundary = /\s\S*$/.exec(tail)
        if (boundary) to -= tail.length - boundary.index - 1
        // Never split a surrogate pair. Pathological unbroken tokens are masked below.
        if (/^[\uDC00-\uDFFF]$/.test(state.sliceDoc(to, to + 1))) to--
      }
      let text = state.sliceDoc(from, to)
      const masked = []
      tree.iterate({ from, to, enter(node) {
        if (excludedNodes.has(node.name)) {
          masked.push([Math.max(from, node.from) - from, Math.min(to, node.to) - from])
          return false
        }
      } })
      for (const match of text.matchAll(/(?:https?:\/\/|www\.)\S+|[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}|\S{256,}/gu)) {
        masked.push([match.index, match.index + match[0].length])
      }
      for (const [start, end] of masked) text = text.slice(0, start) + text.slice(start, end).replace(/[^\n]/g, ' ') + text.slice(end)
      if (/\p{L}/u.test(text)) chunks.push({ from, text })
      from = to
    }
  }
  return chunks
}

export function spellingExtension({ check = checkSpelling, delay = 350 } = {}) {
  const plugin = ViewPlugin.fromClass(class {
    decorations = Decoration.none
    generation = 0
    cache = new Map()
    destroyed = false

    constructor(view) {
      this.view = view
      this.schedule()
    }

    update(update) {
      for (const tr of update.transactions) {
        for (const effect of tr.effects) {
          if (effect.is(spellingResults) && effect.value.owner === this && effect.value.generation === this.generation) {
            this.decorations = Decoration.set(effect.value.ranges.map(({ from, to }) => misspelling.range(from, to)), true)
          }
        }
      }
      if (update.docChanged) {
        // Remove marks touched by an edit; map the others while the new check runs.
        this.decorations = this.decorations.update({ filter: (from, to) => {
          let keep = true
          update.changes.iterChangedRanges((a, b) => { if (a <= to && b >= from) keep = false })
          return keep
        } }).map(update.changes)
      }
      if (update.docChanged || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)
        || update.startState.readOnly !== update.state.readOnly) this.schedule()
    }

    schedule() {
      clearTimeout(this.timer)
      this.controller?.abort()
      this.controller = new AbortController()
      const generation = ++this.generation
      this.timer = setTimeout(() => this.run(generation, this.controller.signal), delay)
    }

    async run(generation, signal) {
      if (this.destroyed || signal.aborted) return
      if (this.view.composing) { this.schedule(); return }
      const state = this.view.state
      const ranges = []
      try {
        const chunks = state.readOnly ? [] : spellingChunks(state, this.view.visibleRanges)
        for (const chunk of chunks) {
          if (signal.aborted) return
          let result = this.cache.get(chunk.text)
          if (!result) {
            result = await check(chunk.text, { signal })
            if (signal.aborted) return
            this.cache.set(chunk.text, result)
            if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value)
          }
          for (const range of result) {
            if (Number.isInteger(range.from) && Number.isInteger(range.to) && range.from >= 0
              && range.to > range.from && range.to <= chunk.text.length) {
              ranges.push({ from: chunk.from + range.from, to: chunk.from + range.to })
            }
          }
        }
      } catch {
        // Keep typing available when the system checker fails. A later edit retries.
        return
      }
      if (this.destroyed || signal.aborted || this.view.state.doc !== state.doc || this.view.composing) return
      this.view.dispatch({ effects: spellingResults.of({ owner: this, generation, ranges }),
        annotations: Transaction.addToHistory.of(false) })
    }

    destroy() {
      this.destroyed = true
      clearTimeout(this.timer)
      this.controller.abort()
      this.cache.clear()
    }
  }, {
    decorations: instance => instance.decorations,
    eventHandlers: {
      compositionstart() { this.schedule() },
      compositionend() { this.schedule() },
    },
  })
  return [
    EditorView.contentAttributes.of(manualTextInputAttributes),
    EditorView.baseTheme({ '.cm-misspelled': {
      textDecorationLine: 'underline', textDecorationStyle: 'wavy',
      textDecorationColor: 'var(--color-rem)', textDecorationThickness: '1px', textUnderlineOffset: '3px',
    } }),
    plugin,
  ]
}

export function spellingWordAt(state, pos) {
  const line = state.doc.lineAt(pos)
  const offset = pos - line.from
  for (const match of line.text.matchAll(/[\p{L}\p{M}]+(?:['’\-][\p{L}\p{M}]+)*/gu)) {
    if (match.index <= offset && offset <= match.index + match[0].length) {
      return { from: line.from + match.index, to: line.from + match.index + match[0].length, text: match[0] }
    }
  }
  return null
}
