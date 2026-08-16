import { Compartment, Text, EditorState } from '@codemirror/state'
import { EditorView, ViewPlugin, lineNumbers, keymap } from '@codemirror/view'
import { unifiedMergeView, MergeView, getChunks, getOriginalDoc, updateOriginalDoc, mergeViewSiblings } from '@codemirror/merge'
import { history, historyKeymap, undo, redo, invertedEffects } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { syntaxHighlighting } from '@codemirror/language'
import { Strikethrough } from '@lezer/markdown'
import { editorTheme, editorHighlightStyle, wrapCompartment } from './core.js'

const mergeViewCompartment = new Compartment()
const diffConfig = { scanLimit: 5000 }

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
    const info = getChunks(view.state)
    const initial = info ? info.chunks.length : 0
    hadChunks = initial > 0
    onChunkCountChange?.(initial)

    return {
      update(update) {
        const info = getChunks(update.state)
        const count = info ? info.chunks.length : 0
        onChunkCountChange?.(count)

        if (hadChunks && count === 0) {
          hadChunks = false
          setTimeout(() => onAllResolved?.(), 0)
        } else {
          hadChunks = count > 0
        }
      },
    }
  })
}

function sideBySideChunkWatcher(onAllResolved, onChunkCountChange) {
  let hadChunks = false

  return ViewPlugin.define((view) => {
    const info = mergeViewSiblings(view)
    const initial = info ? info.chunks.length : 0
    hadChunks = initial > 0
    onChunkCountChange?.(initial)

    return {
      update(update) {
        const info = mergeViewSiblings(update.view)
        const count = info ? info.chunks.length : 0
        onChunkCountChange?.(count)

        if (hadChunks && count === 0) {
          hadChunks = false
          setTimeout(() => onAllResolved?.(), 0)
        } else {
          hadChunks = count > 0
        }
      },
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
}) {
  const state = EditorState.create({
    doc: modifiedContent,
    extensions: [
      ...sharedDiffExtensions,
      ...(editable ? [] : [EditorView.editable.of(false)]),
      mergeViewCompartment.of([
        unifiedMergeView({
          original: Text.of(originalContent.split('\n')),
          gutter: true,
          highlightChanges: true,
          syntaxHighlightDeletions: false,
          mergeControls,
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
}) {
  let mv

  mv = new MergeView({
    a: {
      doc: originalContent,
      extensions: [
        ...sharedDiffExtensions,
        EditorView.editable.of(false),
      ],
    },
    b: {
      doc: modifiedContent,
      extensions: [
        ...sharedDiffExtensions,
        ...(editable ? [] : [EditorView.editable.of(false)]),
        sideBySideChunkWatcher(onAllResolved, onChunkCountChange),
      ],
    },
    parent,
    orientation: 'a-b',
    revertControls: mergeControls ? 'a-to-b' : undefined,
    renderRevertControl: mergeControls ? () => {
      const wrap = document.createElement('div')
      wrap.className = 'cm-merge-chunk-buttons'

      const acceptBtn = document.createElement('button')
      acceptBtn.className = 'cm-merge-accept-btn'
      acceptBtn.textContent = '✓'
      acceptBtn.title = 'Accept this change'
      acceptBtn.addEventListener('mousedown', (e) => {
        e.preventDefault()
        e.stopPropagation()
        const chunkIdx = parseInt(wrap.dataset.chunk)
        if (isNaN(chunkIdx) || !mv) return
        const chunk = mv.chunks[chunkIdx]
        if (!chunk) return
        let insert = mv.b.state.sliceDoc(chunk.fromB, Math.max(chunk.fromB, chunk.toB - 1))
        if (chunk.fromB !== chunk.toB && chunk.toA <= mv.a.state.doc.length)
          insert += mv.b.state.lineBreak
        mv.a.dispatch({
          changes: { from: chunk.fromA, to: Math.min(mv.a.state.doc.length, chunk.toA), insert },
        })
        requestAnimationFrame(() => {
          if (mv && mv.chunks.length === 0) {
            setTimeout(() => onAllResolved?.(), 0)
          }
        })
      })

      const revertBtn = document.createElement('button')
      revertBtn.className = 'cm-merge-revert-btn'
      revertBtn.textContent = '✗'
      revertBtn.title = 'Reject this change'
      revertBtn.addEventListener('mousedown', () => {
        requestAnimationFrame(() => {
          if (mv && mv.chunks.length === 0) {
            setTimeout(() => onAllResolved?.(), 0)
          }
        })
      })

      wrap.appendChild(acceptBtn)
      wrap.appendChild(revertBtn)
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

export function createReadOnlyView({ parent, content }) {
  const state = EditorState.create({
    doc: content,
    extensions: [
      ...sharedDiffExtensions,
      EditorView.editable.of(false),
      EditorView.theme({
        '&': { cursor: 'default' },
        '.cm-cursor': { display: 'none !important' },
      }),
    ],
  })

  return new EditorView({ state, parent })
}
