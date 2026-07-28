import { EditorSelection, Prec } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { insertNewlineContinueMarkupCommand } from '@codemirror/lang-markdown'

// CodeMirror's markdown keymap keeps CommonMark's tight/loose list distinction
// alive while typing, which reads as a bug in a notes app: Enter on an empty
// list item pushes a blank line above it instead of leaving the list, and once
// a list has gone loose every continuation inherits the blank line. Both paths
// are neutralised here so Enter always continues a list tightly.

// Turns off the "make this tight list loose" branch: Enter on an empty item
// now drops a level of markup (leaving the list) the way every other editor
// behaves.
const continueMarkup = insertNewlineContinueMarkupCommand({ nonTightLists: false })

// The remaining loose behaviour is applied to lists that are *already* loose,
// where the continuation is inserted as linebreak + blank line + marker. Only
// that branch can produce a second line break at the head of an insertion, so
// collapsing it is enough to keep continuations tight in older documents.
const LEADING_BLANK_LINE = /^(\r?\n)[ \t>]*\r?\n/

export function insertNewlineContinueTightList(view) {
  let captured = null
  const handled = continueMarkup({
    state: view.state,
    dispatch: (transaction) => { captured = transaction },
  })
  if (!handled || !captured) return handled
  view.dispatch(tightenContinuation(view.state, captured))
  return true
}

function tightenContinuation(state, transaction) {
  // Multi-cursor continuations build one change per range; mapping the caret
  // back onto rewritten inserts is only unambiguous for a single cursor, so
  // anything else keeps CodeMirror's own transaction.
  if (state.selection.ranges.length !== 1) return transaction
  const changes = []
  let tightened = false
  transaction.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    const text = inserted.toString()
    const tight = text.replace(LEADING_BLANK_LINE, '$1')
    if (tight !== text) tightened = true
    changes.push({ from: fromA, to: toA, insert: tight })
  })
  if (!tightened) return transaction
  const changeSet = state.changes(changes)
  return state.update({
    changes: changeSet,
    selection: EditorSelection.cursor(changeSet.mapPos(state.selection.main.head, 1)),
    scrollIntoView: true,
    userEvent: 'input',
  })
}

// Beats the Prec.high keymap that `markdown()` installs for Enter.
export const markdownListKeymap = Prec.highest(keymap.of([
  { key: 'Enter', run: insertNewlineContinueTightList },
]))
