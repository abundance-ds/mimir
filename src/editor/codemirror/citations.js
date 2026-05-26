import { Prec } from '@codemirror/state'
import { acceptCompletion, autocompletion, completionStatus, startCompletion } from '@codemirror/autocomplete'
import { EditorView, Decoration, ViewPlugin, hoverTooltip, keymap } from '@codemirror/view'

export function citationExtensions(getReferences, getDiagnostics) {
  return [
    autocompletion({
      override: [citationCompletionSource(getReferences)],
      activateOnTyping: true,
      defaultKeymap: true,
    }),
    citationCompletionKeymap(),
    citationCompletionTrigger(getReferences),
    citationDecorations(getReferences, getDiagnostics),
    citationHover(getReferences),
  ]
}

function citationCompletionKeymap() {
  return Prec.highest(keymap.of([
    {
      key: 'Enter',
      run(view) {
        if (completionStatus(view.state) !== 'active') return false
        return acceptCompletion(view)
      },
    },
    {
      key: 'Tab',
      run(view) {
        if (completionStatus(view.state) !== 'active') return false
        return acceptCompletion(view)
      },
    },
  ]))
}

function citationCompletionTrigger(getReferences) {
  return Prec.highest(EditorView.domEventHandlers({
    keydown(event, view) {
      if ((event.key === 'Enter' || event.key === 'Tab') && applyVisibleCitationCompletion(view, getReferences)) {
        event.preventDefault()
        return true
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return false
      if (!/^[\w@:\[\]-]$/.test(event.key)) return false
      requestAnimationFrame(() => maybeStartCitationCompletion(view))
      return false
    },
  }))
}

function maybeStartCitationCompletion(view) {
  const head = view.state.selection.main.head
  const line = view.state.doc.lineAt(head)
  const beforeCursor = line.text.slice(0, head - line.from)
  if (/@[\w:-]*$/.test(beforeCursor) || /\[@[\w:-]*$/.test(beforeCursor)) {
    startCompletion(view)
  }
}

function applyVisibleCitationCompletion(view, getReferences) {
  const head = view.state.selection.main.head
  const line = view.state.doc.lineAt(head)
  const beforeCursor = line.text.slice(0, head - line.from)
  const match = beforeCursor.match(/(\[@|@)([\w:-]*)$/)
  if (!match) return false
  const [, trigger, query] = match
  if (!query) return false
  const ref = getReferences().find((item) => referenceHaystack(item).includes(query.toLowerCase()))
  if (!ref) return false
  const insert = trigger === '[@' ? `${ref.key}]` : ref.key
  const from = head - query.length
  view.dispatch({
    changes: { from, to: head, insert },
    selection: { anchor: from + insert.length },
  })
  return true
}

function referenceHaystack(ref) {
  return [
    ref.key,
    ref.author,
    ref.year,
    ref.title,
    ref.venue,
    ref.journal,
    ref.booktitle,
    ref.doi,
    ref.source,
  ].filter(Boolean).join(' ').toLowerCase()
}

function citationCompletionSource(getReferences) {
  return (context) => {
    const before = context.matchBefore(/@[\w:-]*$/)
    const bracketed = context.matchBefore(/\[@[\w:-]*$/)
    const match = before || bracketed
    if (!match || (match.from === match.to && !context.explicit)) return null

    const query = match.text.replace(/^\[/, '').replace(/^@/, '').toLowerCase()
    const bracketedCitation = match.text.startsWith('[@')
    const refs = getReferences()
    const options = refs
      .filter((ref) => {
        const haystack = [
          ref.key,
          ref.author,
          ref.year,
          ref.title,
          ref.venue,
          ref.journal,
          ref.booktitle,
          ref.doi,
          ref.source,
        ].filter(Boolean).join(' ').toLowerCase()
        return !query || haystack.includes(query)
      })
      .slice(0, 40)
      .map((ref) => ({
        label: ref.key,
        type: 'reference',
        displayLabel: `@${ref.key}`,
        detail: `${ref.author} · ${ref.year}`,
        info: ref.title,
        apply(view, completion, from, to) {
          const insert = bracketedCitation ? `${completion.label}]` : completion.label
          view.dispatch({
            changes: { from, to, insert },
            selection: { anchor: from + insert.length },
          })
        },
      }))

    return {
      from: bracketedCitation ? match.from + 2 : match.from + 1,
      options,
      validFor: /^[\w:-]*$/,
    }
  }
}

function citationDecorations(getReferences, getDiagnostics) {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = this.build(view)
      }

      update(update) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = this.build(update.view)
        }
      }

      build(view) {
        const refs = new Set(getReferences().map((ref) => ref.key))
        const diagnostics = getDiagnostics()
        const duplicateKeys = new Set((diagnostics.duplicateKeys || []).map((item) => item.key))
        const decorations = []
        const { from, to } = view.viewport
        const start = Math.max(0, from - 300)
        const end = Math.min(view.state.doc.length, to + 300)
        const text = view.state.doc.sliceString(start, end)
        const re = /@([a-zA-Z][\w:-]*)/g
        let match

        while ((match = re.exec(text)) !== null) {
          const key = match[1]
          const fromPos = start + match.index
          const toPos = fromPos + match[0].length
          let cls = 'cm-citation'
          if (!refs.has(key)) cls = 'cm-citation cm-citation-missing'
          else if (duplicateKeys.has(key)) cls = 'cm-citation cm-citation-duplicate'
          decorations.push(Decoration.mark({ class: cls }).range(fromPos, toPos))
        }

        return Decoration.set(decorations.sort((a, b) => a.from - b.from))
      }
    },
    { decorations: (v) => v.decorations }
  )
}

function citationHover(getReferences) {
  return hoverTooltip((view, pos) => {
    const line = view.state.doc.lineAt(pos)
    const re = /@([a-zA-Z][\w:-]*)/g
    let match

    while ((match = re.exec(line.text)) !== null) {
      const from = line.from + match.index
      const to = from + match[0].length
      if (pos < from || pos > to) continue
      const key = match[1]
      const ref = getReferences().find((item) => item.key === key)
      return {
        pos: from,
        end: to,
        create() {
          const dom = document.createElement('div')
          dom.className = 'citation-tooltip'
          if (!ref) {
            dom.innerHTML = `<strong>Missing reference</strong><span>@${key}</span>`
          } else {
            dom.innerHTML = `<strong>${escapeHtml(ref.title)}</strong><span>${escapeHtml(ref.author)} · ${escapeHtml(ref.year)}</span><small>${escapeHtml(ref.source || '')}</small>`
          }
          return { dom }
        },
      }
    }
    return null
  })
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
