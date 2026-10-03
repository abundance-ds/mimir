import { Compartment, Text, EditorState } from '@codemirror/state'
import { EditorView, ViewPlugin, lineNumbers, keymap } from '@codemirror/view'
import { unifiedMergeView, MergeView, getChunks, getOriginalDoc, updateOriginalDoc } from '@codemirror/merge'
import { history, historyKeymap, undo, redo, invertedEffects } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { syntaxHighlighting } from '@codemirror/language'
import { Strikethrough } from '@lezer/markdown'
import { editorTheme, editorHighlightStyle, wrapCompartment } from './core.js'
import { stripCommentTags } from '../../services/comments/parser.js'

const mergeViewCompartment = new Compartment()
const diffConfig = { scanLimit: 5000 }

function changeButton(action, run) {
  const button = document.createElement('button')
  button.type = 'button'
  button.name = action
  button.className = `cm-review-action cm-review-${action}`
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  icon.setAttribute('viewBox', '0 0 24 24')
  icon.setAttribute('width', '12')
  icon.setAttribute('height', '12')
  icon.setAttribute('fill', 'none')
  icon.setAttribute('stroke', 'currentColor')
  icon.setAttribute('stroke-width', '2')
  icon.setAttribute('stroke-linecap', 'round')
  icon.setAttribute('stroke-linejoin', 'round')
  icon.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', action === 'accept' ? 'M5 12l4 4L19 6' : 'M6 6l12 12M6 18L18 6')
  icon.appendChild(path)
  button.appendChild(icon)
  button.title = action === 'accept' ? 'Accept change' : 'Reject change'
  button.setAttribute('aria-label', button.title)
  // The library delegates mousedown in split view. Both actions use click so
  // keyboard and pointer activation have the same path.
  button.addEventListener('mousedown', event => { event.preventDefault(); event.stopPropagation() })
  button.addEventListener('click', event => {
    event.preventDefault()
    event.stopPropagation()
    const focused = document.activeElement === button
    const root = button.closest('.cm-mergeView') || button.closest('.cm-editor')
    const index = root ? [...root.querySelectorAll(`button[name="${action}"]`)].indexOf(button) : 0
    run(event)
    if (focused) requestAnimationFrame(() => {
      if (!root?.isConnected) return
      const remaining = root.querySelectorAll(`button[name="${action}"]`)
      const next = remaining[Math.min(index, remaining.length - 1)] || root.querySelector('.cm-content')
      next?.focus()
    })
  })
  return button
}

function reviewAction(update) {
  if (update.transactions.some(tr => tr.isUserEvent('accept'))) return 'accept'
  if (update.transactions.some(tr => tr.isUserEvent('revert'))) return 'reject'
  return 'edit'
}

export function resolvedDiffContent(doc, modified, original = '') {
  const lineEnding = modified.match(/\r\n?|\n/)?.[0] || original.match(/\r\n?|\n/)?.[0] || '\n'
  return doc.sliceString(0, doc.length, lineEnding)
}

const sharedDiffExtensions = [
  editorTheme,
  syntaxHighlighting(editorHighlightStyle),
  markdown({ base: markdownLanguage, extensions: [Strikethrough] }),
  lineNumbers(),
  wrapCompartment.of(EditorView.lineWrapping),
  history(),
  keymap.of(historyKeymap),
]

function chunkWatcherPlugin(onAllResolved, onChunkCountChange) {
  let hadChunks = false

  return ViewPlugin.define((view) => {
    let resolveTimer = null
    const info = getChunks(view.state)
    const initial = info ? info.chunks.length : 0
    hadChunks = initial > 0
    onChunkCountChange?.(initial)

    return {
      update(update) {
        const wasResolving = resolveTimer !== null
        clearTimeout(resolveTimer)
        resolveTimer = null
        const info = getChunks(update.state)
        const count = info ? info.chunks.length : 0
        onChunkCountChange?.(count)

        if ((hadChunks || wasResolving) && count === 0) {
          hadChunks = false
          resolveTimer = setTimeout(() => {
            resolveTimer = null
            onAllResolved?.()
          }, 0)
        } else {
          hadChunks = count > 0
        }
      },
      destroy() { clearTimeout(resolveTimer) },
    }
  })
}

export function createUnifiedDiffView({
  parent,
  originalContent,
  modifiedContent,
  collapse = false,
  editable = true,
  mergeControls = true,
  onAllResolved,
  onChunkCountChange,
  onChange,
  onReviewChange,
  extensions = [],
}) {
  originalContent = stripCommentTags(originalContent)
  modifiedContent = stripCommentTags(modifiedContent)
  const state = EditorState.create({
    doc: modifiedContent,
    extensions: [
      ...sharedDiffExtensions,
      ...extensions,
      EditorView.updateListener.of(update => {
        if (update.docChanged) onChange?.(resolvedDiffContent(update.state.doc, modifiedContent, originalContent))
        if (update.docChanged || getOriginalDoc(update.startState) !== getOriginalDoc(update.state)) {
          onReviewChange?.(
            resolvedDiffContent(getOriginalDoc(update.state), modifiedContent, originalContent),
            resolvedDiffContent(update.state.doc, modifiedContent, originalContent),
            reviewAction(update),
          )
        }
      }),
      EditorView.editorAttributes.of({ class: mergeControls ? 'cm-review-unified' : '' }),
      ...(editable ? [] : [EditorView.editable.of(false)]),
      mergeViewCompartment.of([
        unifiedMergeView({
          original: Text.of(originalContent.split(/\r\n?|\n/)),
          gutter: true,
          highlightChanges: true,
          syntaxHighlightDeletions: false,
          mergeControls: mergeControls ? changeButton : false,
          diffConfig,
          ...(collapse ? { collapseUnchanged: { margin: 3, minSize: 4 } } : {}),
        }),
        invertedEffects.of(tr => {
          const effects = []
          for (const e of tr.effects) {
            if (e.is(updateOriginalDoc)) {
              const prevOriginal = getOriginalDoc(tr.startState)
              effects.push(updateOriginalDoc.of({
                doc: prevOriginal,
                changes: e.value.changes.invert(prevOriginal),
              }))
            }
          }
          return effects
        }),
        chunkWatcherPlugin(onAllResolved, onChunkCountChange),
      ]),
    ],
  })

  return new EditorView({ state, parent })
}

export function getUnifiedChunks(view) {
  const info = getChunks(view.state)
  return info ? info.chunks : []
}

export function createSplitDiffView({
  parent,
  originalContent,
  modifiedContent,
  collapse = false,
  editable = true,
  mergeControls = true,
  onAllResolved,
  onChunkCountChange,
  onChange,
  onReviewChange,
  originalExtensions = [],
  modifiedExtensions = [],
}) {
  originalContent = stripCommentTags(originalContent)
  modifiedContent = stripCommentTags(modifiedContent)
  let mv

  function report(update, side) {
    if (!update.docChanged || !mv) return
    onReviewChange?.(
      resolvedDiffContent(side === 'a' ? update.state.doc : mv.a.state.doc, modifiedContent, originalContent),
      resolvedDiffContent(side === 'b' ? update.state.doc : mv.b.state.doc, modifiedContent, originalContent),
      reviewAction(update),
    )
  }

  function decide(index, action) {
    const chunk = mv?.chunks[index]
    if (!chunk) return
    const accepting = action === 'accept'
    const source = accepting ? mv.b : mv.a
    const target = accepting ? mv.a : mv.b
    const from = accepting ? chunk.fromB : chunk.fromA
    const to = accepting ? chunk.toB : chunk.toA
    const targetFrom = accepting ? chunk.fromA : chunk.fromB
    const targetTo = accepting ? chunk.toA : chunk.toB
    let insert = source.state.sliceDoc(from, Math.max(from, to - 1))
    if (from !== to && targetTo <= target.state.doc.length) insert += source.state.lineBreak
    target.dispatch({
      changes: { from: targetFrom, to: Math.min(target.state.doc.length, targetTo), insert },
      userEvent: accepting ? 'accept' : 'revert',
    })
  }

  mv = new MergeView({
    a: {
      doc: originalContent,
      extensions: [
        ...sharedDiffExtensions,
        ...originalExtensions,
        EditorView.editable.of(false),
        EditorView.updateListener.of(update => report(update, 'a')),
      ],
    },
    b: {
      doc: modifiedContent,
      extensions: [
        ...sharedDiffExtensions,
        ...modifiedExtensions,
        EditorView.updateListener.of(update => {
          if (update.docChanged) onChange?.(resolvedDiffContent(update.state.doc, modifiedContent, originalContent))
          report(update, 'b')
        }),
        ...(editable ? [] : [EditorView.editable.of(false)]),
        chunkWatcherPlugin(onAllResolved, onChunkCountChange),
      ],
    },
    parent,
    orientation: 'a-b',
    revertControls: mergeControls ? 'a-to-b' : undefined,
    renderRevertControl: mergeControls ? () => {
      const wrap = document.createElement('div')
      wrap.className = 'cm-merge-chunk-buttons'

      for (const action of ['accept', 'reject']) {
        wrap.appendChild(changeButton(action, () => decide(Number(wrap.dataset.chunk), action)))
      }
      return wrap
    } : undefined,
    highlightChanges: true,
    gutter: true,
    diffConfig,
    ...(collapse ? { collapseUnchanged: { margin: 3, minSize: 4 } } : {}),
  })

  mv.dom.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
      e.preventDefault()
      if (e.shiftKey) {
        redo(mv.b) || redo(mv.a)
      } else {
        undo(mv.b) || undo(mv.a)
      }
    }
  })
  mv.dom.tabIndex = -1

  return mv
}

export function getSplitChunks(mv) {
  return mv.chunks || []
}

export function createReadOnlyView({ parent, content, extensions = [] }) {
  const state = EditorState.create({
    doc: stripCommentTags(content),
    extensions: [
      ...sharedDiffExtensions,
      ...extensions,
      EditorView.editable.of(false),
      EditorView.theme({
        '&': { cursor: 'default' },
        '.cm-cursor': { display: 'none !important' },
      }),
    ],
  })

  return new EditorView({ state, parent })
}
