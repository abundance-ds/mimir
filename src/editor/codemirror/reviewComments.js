import { StateEffect, StateField, RangeSet } from '@codemirror/state'
import { Decoration, EditorView, GutterMarker, gutter, keymap } from '@codemirror/view'

export const updateReviewComments = StateEffect.define()

export function reviewCommentMarkers(initial, onOpen, onAdd, onSelection) {
  const field = StateField.define({
    create: () => initial,
    update(value, transaction) {
      for (const effect of transaction.effects) if (effect.is(updateReviewComments)) return effect.value
      if (!transaction.docChanged) return value
      return value.map(comment => ({ ...comment,
        from: transaction.changes.mapPos(comment.from, 1),
        to: transaction.changes.mapPos(comment.to, -1),
      }))
    },
  })
  class Marker extends GutterMarker {
    constructor(comments) { super(); this.comments = comments }
    eq(other) { return this.comments.map(item => item.id).join() === other.comments.map(item => item.id).join() }
    toDOM() {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'cm-review-comment-marker'
      button.textContent = '◇'
      button.title = `${this.comments.length} ${this.comments.length === 1 ? 'discussion' : 'discussions'}`
      button.setAttribute('aria-label', `Open ${button.title}`)
      button.addEventListener('mousedown', event => event.preventDefault())
      button.addEventListener('click', event => { event.preventDefault(); onOpen?.(this.comments[0].id) })
      return button
    }
  }
  return [field,
    EditorView.decorations.compute([field], state => Decoration.set(state.field(field)
      .filter(comment => !comment.detached && comment.from < comment.to && comment.to <= state.doc.length)
      .map(comment => Decoration.mark({ class: 'cm-comment-range', attributes: { 'data-review-comment': comment.id } }).range(comment.from, comment.to)), true)),
    gutter({
      class: 'cm-review-comment-gutter',
      markers(view) {
        const lines = new Map()
        for (const comment of view.state.field(field)) {
          const line = view.state.doc.lineAt(Math.min(view.state.doc.length, Math.max(0, comment.from))).from
          if (!lines.has(line)) lines.set(line, [])
          lines.get(line).push(comment)
        }
        return RangeSet.of([...lines].map(([from, comments]) => new Marker(comments).range(from)), true)
      },
    }),
    EditorView.updateListener.of(update => { if (update.selectionSet || update.focusChanged) onSelection?.(update.view) }),
    keymap.of([{ key: 'Mod-Shift-m', run: view => { if (view.state.selection.main.empty || !onAdd) return false; onAdd(view); return true } }]),
  ]
}
