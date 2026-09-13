import { Prec, StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap } from '@codemirror/view'
import { autocompletion, closeCompletion, completionStatus, startCompletion } from '@codemirror/autocomplete'
import { graphLinkMarkdown, graphMentionAt, graphReferencesIn } from './graphLinkSyntax.js'
import { graphCompletionMetadata, graphCompletionPopup } from './graphCompletionPopup.js'

export function createGraphCompletionSource({ lookup, scopeIds = () => [], bodyStart = () => 0, onError = () => {} }) {
  let generation = 0
  const source = async context => {
    const current = ++generation
    if (context.view?.composing || context.state.readOnly) return null
    const mention = graphMentionAt(context.state, context.pos)
    if (!mention || mention.from < bodyStart(context.state)) return null
    const scopes = scopeIds()
    context.addEventListener('abort', () => {}, { onDocChange: true })
    try {
      const nodes = await lookup(mention.query, { scopeIds: scopes, limit: 12 })
      if (context.aborted || current !== generation || context.view?.composing) return null
      if (scopeIds().join('\0') !== scopes.join('\0')) return null
      onError('')
      return {
        from: mention.from,
        to: mention.to,
        filter: false,
        options: (Array.isArray(nodes) ? nodes : []).map(node => ({
          label: node.title,
          graphKind: node.kind,
          graphScope: scopeName(node.scopeId),
          detail: `${node.kind} · ${scopeName(node.scopeId)}`,
          apply(view, _completion, from, to) {
            const insert = graphLinkMarkdown(node)
            view.dispatch({
              changes: { from, to, insert },
              selection: { anchor: from + insert.length },
              userEvent: 'input.complete',
            })
          },
        })),
      }
    } catch {
      if (!context.aborted && current === generation) onError('Link lookup failed. Try again.')
      return null
    }
  }
  source.cancel = () => { generation += 1 }
  return source
}

function scopeName(id) {
  const kind = String(id || '').split(':')[0]
  return kind === 'project' ? 'Workspace' : kind ? kind[0].toUpperCase() + kind.slice(1) : ''
}

class GraphLinkWidget extends WidgetType {
  constructor(reference, target, open, enabled) {
    super()
    this.reference = reference
    this.title = target?.title || reference.label
    this.status = target?.status || 'pending'
    this.open = open
    this.enabled = enabled
  }
  eq(other) {
    return this.reference.targetId === other.reference.targetId
      && this.title === other.title && this.status === other.status && this.enabled === other.enabled
  }
  toDOM() {
    const element = document.createElement(this.enabled && this.status === 'resolved' ? 'button' : 'span')
    if (element.tagName === 'BUTTON') element.type = 'button'
    element.className = `cm-graph-reference${this.status === 'unavailable' ? ' cm-graph-reference-unavailable' : ''}`
    element.textContent = `${this.title}${this.status === 'unavailable' ? ' (Unavailable)' : ''}`
    element.dataset.graphTarget = this.reference.targetId
    element.title = !this.enabled ? 'Save this entry to open links.' : this.status === 'unavailable' ? 'Entry unavailable' : 'Open entry · Alt-click to edit link'
    element.addEventListener('mousedown', event => {
      if (!event.altKey && !event.shiftKey) event.preventDefault()
    })
    element.addEventListener('click', event => {
      if (event.altKey || event.shiftKey) return
      event.preventDefault()
      event.stopPropagation()
      if (this.enabled && this.status === 'resolved') this.open(this.reference.targetId)
    })
    return element
  }
  ignoreEvent(event) { return !event.altKey && !event.shiftKey }
}

export function graphLinks({ lookup, resolve, scopeIds = () => [], bodyStart = () => 0, open = () => {}, enabled = () => true, onError = () => {} }) {
  const targetsEffect = StateEffect.define()
  const bodyReferences = state => graphReferencesIn(state).filter(reference => reference.from >= bodyStart(state))
  const references = StateField.define({
    create: bodyReferences,
    update: (value, transaction) => transaction.docChanged ? bodyReferences(transaction.state) : value,
  })
  const targets = StateField.define({
    create: () => new Map(),
    update(value, transaction) {
      for (const effect of transaction.effects) if (effect.is(targetsEffect)) return effect.value
      return value
    },
  })
  const source = createGraphCompletionSource({ lookup, scopeIds, bodyStart, onError })
  let currentView = null
  let generation = 0
  let lastIds = ''
  let lastScopes = scopeIds().join('\0')
  let destroyed = false

  function resolveCurrent(view, force = false) {
    const ids = [...new Set(view.state.field(references).map(reference => reference.targetId))].sort()
    const key = JSON.stringify([scopeIds(), ids])
    if (!force && key === lastIds) return
    lastIds = key
    const current = ++generation
    // A microtask keeps dispatch outside CodeMirror's current view update.
    void Promise.resolve().then(async () => {
      if (destroyed || current !== generation) return
      try {
        const resolved = []
        for (let offset = 0; offset < ids.length; offset += 200) {
          if (destroyed || current !== generation) return
          const batch = await resolve(ids.slice(offset, offset + 200), { scopeIds: scopeIds() })
          if (Array.isArray(batch)) resolved.push(...batch)
        }
        if (destroyed || current !== generation) return
        onError('')
        view.dispatch({ effects: targetsEffect.of(new Map(resolved.map(target => [target.id, target]))) })
      } catch {
        if (!destroyed && current === generation) onError('Links could not be checked. Try again.')
      }
    })
  }

  const plugin = ViewPlugin.fromClass(class {
    constructor(view) {
      currentView = view
      this.decorations = this.build(view)
      resolveCurrent(view)
    }
    update(update) {
      if (update.docChanged) resolveCurrent(update.view)
      if (update.docChanged || update.selectionSet || update.focusChanged
        || update.transactions.some(transaction => transaction.effects.some(effect => effect.is(targetsEffect)))) {
        this.decorations = this.build(update.view)
      }
    }
    build(view) {
      const resolved = view.state.field(targets)
      const ranges = []
      for (const reference of view.state.field(references)) {
        const atCaret = view.hasFocus && view.state.selection.ranges.some(range => range.from <= reference.to && range.to >= reference.from)
        if (atCaret) continue
        // Keep authored line breaks in place. View decorations hide the source
        // on each line and put the current title at the beginning of the link.
        let from = reference.from
        while (from < reference.to) {
          const to = Math.min(view.state.doc.lineAt(from).to, reference.to)
          if (to > from) ranges.push(Decoration.replace({
            widget: from === reference.from
              ? new GraphLinkWidget(reference, resolved.get(reference.targetId), open, enabled())
              : undefined,
          }).range(from, to))
          from = to + 1
        }
      }
      return Decoration.set(ranges, true)
    }
    destroy() {
      destroyed = true
      generation += 1
      source.cancel()
      currentView = null
    }
  }, {
    decorations: value => value.decorations,
    provide: extension => EditorView.atomicRanges.of(view => view.plugin(extension)?.decorations || Decoration.none),
  })

  return {
    extension: [
      references, targets, plugin,
      graphCompletionPopup(),
      autocompletion({
        override: [source],
        activateOnTypingDelay: 0,
        interactionDelay: 0,
        icons: false,
        tooltipClass: () => 'cm-graph-completions',
        optionClass: () => 'cm-graph-completion-option',
        addToOptions: [{ render: graphCompletionMetadata, position: 80 }],
      }),
      Prec.highest(keymap.of([{
        key: 'Escape',
        run(view) {
          if (!completionStatus(view.state)) return false
          source.cancel()
          closeCompletion(view)
          return true
        },
        stopPropagation: true,
      }])),
      EditorView.domEventHandlers({
        compositionstart(_event, view) {
          source.cancel()
          closeCompletion(view)
          return false
        },
      }),
      graphLinkTheme,
    ],
    references(state) {
      return state.field(references, false) || []
    },
    openTarget(id) {
      if (!currentView || !enabled()) return
      const target = currentView.state.field(targets).get(id)
      if (target?.status === 'resolved') open(id)
      else onError(target?.status === 'unavailable' ? 'Entry unavailable.' : 'Checking link…')
    },
    refresh() {
      if (currentView) {
        const scopes = scopeIds().join('\0')
        if (scopes !== lastScopes) {
          source.cancel()
          closeCompletion(currentView)
          lastScopes = scopes
          currentView.dispatch({ effects: targetsEffect.of(new Map()) })
        }
        resolveCurrent(currentView, true)
      }
    },
    insert(view) {
      if (!view || view.composing || view.state.readOnly) return false
      const { from, to } = view.state.selection.main
      if (from < bodyStart(view.state)) return false
      const prefix = from && !/[\s([{>"']/.test(view.state.sliceDoc(from - 1, from)) ? ' ' : ''
      const transaction = view.state.update({ changes: { from, to, insert: `${prefix}@` }, selection: { anchor: from + prefix.length + 1 } })
      if (!graphMentionAt(transaction.state, transaction.state.selection.main.head)) {
        onError('Insert links in note text, outside code and existing links.')
        return false
      }
      view.dispatch(transaction)
      view.focus()
      startCompletion(view)
      return true
    },
  }
}

const graphLinkTheme = EditorView.baseTheme({
  '.cm-graph-reference': {
    color: 'var(--color-accent)', fontFamily: 'inherit', fontSize: 'inherit',
    textDecoration: 'underline', textUnderlineOffset: '2px', cursor: 'pointer',
    border: '0', padding: '0', background: 'transparent',
  },
  '.cm-graph-reference:focus-visible': { outline: '2px solid var(--color-accent)', outlineOffset: '2px' },
  '.cm-graph-reference-unavailable': { color: 'var(--color-ink-3)', textDecorationStyle: 'dotted' },
  '.cm-tooltip.cm-tooltip-autocomplete.cm-graph-completions': {
    boxSizing: 'border-box',
    width: 'min(320px, var(--graph-completion-width, calc(100vw - 16px)))',
    maxWidth: 'calc(100vw - 16px)',
    overflow: 'hidden',
    border: '1px solid var(--color-rule)',
    borderRadius: '3px',
    background: 'var(--color-surface)',
    color: 'var(--color-ink)',
    boxShadow: '0 10px 30px color-mix(in srgb, var(--color-ink) 16%, transparent)',
    fontFamily: 'var(--font-sans)',
    fontSize: '12px',
  },
  '.cm-tooltip.cm-tooltip-autocomplete.cm-graph-completions > ul': {
    boxSizing: 'border-box',
    width: '100%',
    minWidth: '0',
    maxWidth: '100%',
    maxHeight: 'min(248px, var(--graph-completion-max-height, calc(100vh - 16px)))',
    padding: '3px',
    overflow: 'hidden auto',
    overscrollBehavior: 'contain',
    fontFamily: 'var(--font-sans)',
    fontSize: '12px',
    whiteSpace: 'normal',
  },
  '.cm-tooltip.cm-tooltip-autocomplete.cm-graph-completions > ul > li': {
    boxSizing: 'border-box',
    minWidth: '0',
    padding: '4px 7px',
    lineHeight: '16px',
    color: 'var(--color-ink)',
    borderRadius: '2px',
  },
  '.cm-tooltip.cm-tooltip-autocomplete.cm-graph-completions > ul > li:hover': {
    background: 'var(--color-chrome-high)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete.cm-graph-completions > ul > li[aria-selected]': {
    background: 'var(--color-accent-soft)',
    color: 'var(--color-ink)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete.cm-graph-completions .cm-completionLabel': {
    display: 'block',
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
    fontFamily: 'var(--font-sans)',
    fontSize: '12px',
    fontWeight: '500',
    lineHeight: '16px',
  },
  '.cm-tooltip.cm-tooltip-autocomplete.cm-graph-completions .cm-completionDetail': { display: 'none' },
  '.cm-tooltip.cm-tooltip-autocomplete.cm-graph-completions .cm-graph-completion-meta': {
    display: 'flex',
    justifyContent: 'space-between',
    gap: '12px',
    fontSize: '10px',
    lineHeight: '13px',
    color: 'var(--color-ink-3)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete.cm-graph-completions .cm-graph-completion-kind': {
    minWidth: '0',
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
  },
  '.cm-tooltip.cm-tooltip-autocomplete.cm-graph-completions .cm-graph-completion-scope': {
    flexShrink: '0',
  },
})
