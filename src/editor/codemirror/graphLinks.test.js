import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { Strikethrough } from '@lezer/markdown'
import { CompletionContext, completionStatus, currentCompletions, startCompletion } from '@codemirror/autocomplete'
import { history, undo, redo } from '@codemirror/commands'
import { afterEach, describe, expect, it, vi } from 'vitest'
import corpus from '../../../src-tauri/tests/fixtures/graph_links.json'
import { graphLinkId, graphLinkMarkdown, graphMentionAt, graphReferencesIn, referenceSelection } from './graphLinkSyntax.js'
import { createGraphCompletionSource, graphLinks } from './graphLinks.js'

const views = []
function stateFor(doc, extensions = []) {
  return EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage, extensions: [Strikethrough] }), ...extensions] })
}
function makeView(doc, options = {}) {
  const links = graphLinks({ lookup: vi.fn(async () => []), resolve: vi.fn(async () => []), ...options })
  const view = new EditorView({ state: stateFor(doc, [history(), links.extension]), parent: document.body })
  views.push(view)
  return { view, links }
}
const settle = () => new Promise(resolve => setTimeout(resolve, 50))
afterEach(() => { views.splice(0).forEach(view => view.destroy()); vi.restoreAllMocks(); document.documentElement.style.removeProperty('--font-sans') })

describe('graph Markdown syntax shared with Rust', () => {
  it.each(corpus)('$name', ({ body, references }) => {
    expect(graphReferencesIn(stateFor(body))).toEqual(references)
  })
  it('escapes authored titles and retains identity without title rewrites', () => {
    const doc = graphLinkMarkdown({ id: 'jon', title: 'Jon [Team] *A* \\ Notes &amp; ~~Later~~' })
    expect(graphReferencesIn(stateFor(doc))).toEqual([{ targetId: 'jon', label: 'Jon [Team] *A* \\ Notes &amp; ~~Later~~', from: 0, to: doc.length }])
  })
  it.each(['mimir://graph/Upper', 'mimir://graph/jon-', 'mimir://graph/jon?x', 'mimir://graph/%6aon'])('rejects %s', target => {
    expect(graphLinkId(target)).toBeNull()
  })
})

describe('graph reference ownership', () => {
  it('exposes current body reference bounds and accepts states without the extension', () => {
    const doc = '---\nsummary: "[Hidden](mimir://graph/hidden)"\n---\n\n[Jon](mimir://graph/jon)'
    const { view, links } = makeView(doc, { bodyStart: state => state.doc.toString().indexOf('[Jon]') })
    expect(links.references(view.state)).toEqual([{ targetId: 'jon', label: 'Jon', from: doc.indexOf('[Jon]'), to: doc.length }])
    view.dispatch({ changes: { from: doc.length, insert: ' [Jo](mimir://graph/jo)' } })
    expect(links.references(view.state).map(reference => reference.targetId)).toEqual(['jon', 'jo'])
    expect(links.references(stateFor(doc))).toEqual([])
  })
})

describe('graph mention completion', () => {
  it.each(['@jo', 'Ask @jo', '(@jo', '> @jo', '@Jón Min'])('finds prose context: %s', doc => {
    expect(graphMentionAt(stateFor(doc), doc.length)).toMatchObject({ query: doc.split('@').at(-1) })
  })
  it.each(['a@jo', '\\@jo', '`@jo`', '```md\n@jo\n```', '    @jo', '[x @jo](mimir://graph/jon)', '<!-- @jo -->'])('rejects context: %s', doc => {
    const position = doc.indexOf('@jo') + 3
    expect(graphMentionAt(stateFor(doc), position)).toBeNull()
  })
  it('allows registered source tabs to exclude frontmatter from lookup and toolbar insertion', async () => {
    const doc = '---\nsummary: "@hidden"\n---\n\nAsk @jo'
    const bodyStart = state => state.doc.toString().indexOf('Ask')
    const lookup = vi.fn(async () => [{ id: 'jon', title: 'Jon', kind: 'person' }])
    const source = createGraphCompletionSource({ lookup, bodyStart })
    expect(await source(new CompletionContext(stateFor(doc), doc.indexOf('@hidden') + 7, false))).toBeNull()
    expect(lookup).not.toHaveBeenCalled()
    expect(await source(new CompletionContext(stateFor(doc), doc.length, false))).toMatchObject({ from: doc.indexOf('@jo') })
    const { view, links } = makeView(doc, { lookup, bodyStart })
    expect(links.insert(view)).toBe(false)
    expect(view.state.doc.toString()).toBe(doc)
  })

  it('portals a compact menu outside clipping ancestors while retaining CodeMirror theme and keyboard behavior', async () => {
    document.documentElement.style.setProperty('--font-sans', 'system-ui')
    const title = 'Jon Minton with a long title that must stay on one predictable line'
    const { view } = makeView('@jo', { lookup: async () => [{ id: 'jon', title, kind: 'person', scopeId: 'team:main' }] })
    view.dispatch({ selection: { anchor: 3 } })
    view.focus()
    startCompletion(view)
    await settle()
    const menu = document.querySelector('.cm-tooltip.cm-graph-completions')
    expect(menu).not.toBeNull()
    expect(view.dom.contains(menu)).toBe(false)
    const portal = menu.closest('[data-graph-completion-portal]')
    expect(portal.parentElement).toBe(document.body)
    expect(portal.hasAttribute('data-modal-portal')).toBe(true)
    expect(portal.style.zIndex).toBe('500')
    for (const name of view.themeClasses.split(' ').filter(Boolean)) expect(menu.parentElement.classList.contains(name)).toBe(true)
    expect(menu.style.position).toBe('fixed')
    const row = menu.querySelector('[role="option"]')
    expect(row.querySelector('.cm-completionLabel').textContent).toBe(title)
    expect(row.querySelector('.cm-graph-completion-kind').textContent).toBe('person')
    expect(row.querySelector('.cm-graph-completion-scope').textContent).toBe('Team')
    const labelStyle = getComputedStyle(row.querySelector('.cm-completionLabel'))
    const listStyle = getComputedStyle(menu.querySelector('ul'))
    // DOM style contracts verify specificity; they are not visual layout proof.
    expect(listStyle.fontFamily).toBe('system-ui')
    expect(Number.parseFloat(listStyle.minWidth)).toBe(0)
    expect(labelStyle.whiteSpace).toBe('nowrap')
    expect(labelStyle.textOverflow).toBe('ellipsis')
    expect(labelStyle.fontSize).toBe('12px')
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(graphReferencesIn(view.state)[0].targetId).toBe('jon')
    expect(document.querySelector('.cm-graph-completions')).toBeNull()
    view.destroy()
    views.splice(views.indexOf(view), 1)
    expect(portal.isConnected).toBe(false)
  })

  it('keeps native ordering, kind and scope, and sends the title query to Rust', async () => {
    const lookup = vi.fn(async () => [{ id: 'jolo', title: 'Jolo', kind: 'company', scopeId: 'team:main' }, { id: 'jon', title: 'Jon', kind: 'person', scopeId: 'project:atlas' }])
    const source = createGraphCompletionSource({ lookup, scopeIds: () => ['team:main'] })
    const result = await source(new CompletionContext(stateFor('@jo'), 3, false))
    expect(lookup).toHaveBeenCalledWith('jo', { scopeIds: ['team:main'], limit: 12 })
    expect(result.filter).toBe(false)
    expect(result.options.map(option => option.label)).toEqual(['Jolo', 'Jon'])
    expect(result.options[1].detail).toBe('person · Workspace')
  })
  it('rejects stale, cancelled and composition-time lookup results', async () => {
    const pending = []
    const lookup = vi.fn(() => new Promise(resolve => pending.push(resolve)))
    const source = createGraphCompletionSource({ lookup })
    const first = source(new CompletionContext(stateFor('@j'), 2, false))
    const second = source(new CompletionContext(stateFor('@jo'), 3, false))
    pending[1]([{ id: 'jon', title: 'Jon' }])
    expect((await second).options).toHaveLength(1)
    pending[0]([{ id: 'jolo', title: 'Jolo' }])
    expect(await first).toBeNull()
    const third = source(new CompletionContext(stateFor('@jo'), 3, false))
    source.cancel()
    pending[2]([{ id: 'jon', title: 'Jon' }])
    expect(await third).toBeNull()
    expect(await source(new CompletionContext(stateFor('@jo'), 3, false, { composing: true }))).toBeNull()
  })
  it('inserts one undoable link and preserves derived references through undo and redo', async () => {
    const { view } = makeView('Ask @jo')
    const source = createGraphCompletionSource({ lookup: async () => [{ id: 'jon', title: 'Jon [Team]', kind: 'person' }] })
    const result = await source(new CompletionContext(view.state, 7, false))
    result.options[0].apply(view, result.options[0], result.from, result.to)
    expect(graphReferencesIn(view.state).map(reference => reference.targetId)).toEqual(['jon'])
    expect(undo(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('Ask @jo')
    expect(redo(view)).toBe(true)
    expect(graphReferencesIn(view.state)).toHaveLength(1)
    view.dispatch({ changes: { from: 4, to: view.state.doc.length, insert: '' } })
    expect(graphReferencesIn(view.state)).toHaveLength(0)
  })
  it('toolbar preserves selection and starts bounded empty lookup', async () => {
    const lookup = vi.fn(async () => [{ id: 'jon', title: 'Jon', kind: 'person', scopeId: 'team:main' }])
    const { view, links } = makeView('Before replace after', { lookup })
    view.dispatch({ selection: { anchor: 7, head: 14 } })
    expect(links.insert(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('Before @ after')
    await settle()
    expect(lookup).toHaveBeenCalledWith('', { scopeIds: [], limit: 12 })
    expect(currentCompletions(view.state)[0]?.label).toBe('Jon')
  })
  it('arrow keys and Enter select a native result without adding a newline', async () => {
    const lookup = vi.fn(async () => [
      { id: 'jolo', title: 'Jolo', kind: 'company', scopeId: 'team:main' },
      { id: 'jon', title: 'Jon', kind: 'person', scopeId: 'team:main' },
    ])
    const { view } = makeView('@jo', { lookup })
    view.dispatch({ selection: { anchor: 3 } })
    view.focus()
    startCompletion(view)
    await settle()
    for (const key of ['ArrowDown', 'Enter']) {
      view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    }
    expect(view.state.doc.toString()).toBe('[Jon](mimir://graph/jon)')
    expect(completionStatus(view.state)).toBeNull()
  })

  it('keeps the menu open when an autosave changes the graph revision', async () => {
    const { view, links } = makeView('@jo', { lookup: async () => [{ id: 'jon', title: 'Jon', kind: 'person' }] })
    view.dispatch({ selection: { anchor: 3 } })
    view.focus()
    startCompletion(view)
    await settle()
    expect(currentCompletions(view.state)).toHaveLength(1)
    links.refresh()
    await settle()
    expect(currentCompletions(view.state)).toHaveLength(1)
  })

  it('Escape cancels a pending menu and consumes the key before inspector handlers', async () => {
    let finish
    const lookup = vi.fn(() => new Promise(resolve => { finish = resolve }))
    const { view } = makeView('@jo', { lookup })
    view.dispatch({ selection: { anchor: 3 } })
    view.focus()
    startCompletion(view)
    await settle()
    const listener = vi.fn()
    document.body.addEventListener('keydown', listener)
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(listener).not.toHaveBeenCalled()
    finish([{ id: 'jon', title: 'Jon', kind: 'person' }])
    await settle()
    expect(completionStatus(view.state)).toBeNull()
    document.body.removeEventListener('keydown', listener)
  })
})

describe('graph link rendering and source navigation', () => {
  it('leaves source frontmatter links visible and resolves only body links', async () => {
    const doc = '---\nsummary: "[Hidden](mimir://graph/hidden)"\n---\n\n[Visible](mimir://graph/visible)'
    const resolve = vi.fn(async () => [{ id: 'visible', status: 'resolved', title: 'Current title' }])
    const { view } = makeView(doc, { resolve, bodyStart: state => state.doc.toString().indexOf('[Visible]') })
    await settle()
    expect(resolve).toHaveBeenCalledWith(['visible'], { scopeIds: [] })
    expect(view.dom.querySelector('[data-graph-target="hidden"]')).toBeNull()
    expect(view.dom.textContent).toContain('mimir://graph/hidden')
    expect(view.dom.querySelector('[data-graph-target="visible"]').textContent).toBe('Current title')
  })

  it('resolves only document IDs, shows current names and unavailable links, and opens resolved targets', async () => {
    const resolve = vi.fn(async () => [{ id: 'jon', status: 'resolved', title: 'Jonathan' }, { id: 'gone', status: 'unavailable' }])
    const open = vi.fn()
    const { view } = makeView('Text [Jon](mimir://graph/jon) [Old](mimir://graph/gone)', { resolve, open })
    await settle()
    expect(resolve).toHaveBeenCalledWith(['gone', 'jon'], { scopeIds: [] })
    expect(view.dom.textContent).toContain('Jonathan')
    expect(view.dom.textContent).toContain('Old (Unavailable)')
    view.dom.querySelector('[data-graph-target="jon"]').click()
    expect(open).toHaveBeenCalledWith('jon')
    expect(view.state.doc.toString()).toContain('[Jon]')
  })
  it('does not navigate in Create and does not repeat resolution for ordinary typing', async () => {
    const resolve = vi.fn(async () => [{ id: 'jon', status: 'resolved', title: 'Jon' }])
    const open = vi.fn()
    const { view } = makeView('[Jon](mimir://graph/jon) text', { resolve, open, enabled: () => false })
    await settle()
    view.dom.querySelector('[data-graph-target="jon"]').click()
    expect(open).not.toHaveBeenCalled()
    view.dispatch({ changes: { from: view.state.doc.length, insert: ' more' } })
    await settle()
    expect(resolve).toHaveBeenCalledTimes(1)
  })
  it('ignores stale target resolutions after a scope switch and blocks hidden source links', async () => {
    const pending = []
    let scopes = ['team:main']
    const open = vi.fn()
    const resolve = vi.fn(() => new Promise(finish => pending.push(finish)))
    const { view, links } = makeView('[Jon](mimir://graph/jon)', { resolve, open, scopeIds: () => scopes })
    await Promise.resolve()
    scopes = ['private:local']
    links.refresh()
    await Promise.resolve()
    pending[1]([{ id: 'jon', status: 'unavailable' }])
    await settle()
    pending[0]([{ id: 'jon', status: 'resolved', title: 'Hidden title' }])
    await settle()
    expect(view.dom.textContent).not.toContain('Hidden title')
    expect(view.dom.textContent).toContain('Unavailable')
    links.openTarget('jon')
    expect(open).not.toHaveBeenCalled()
  })
  it('resolves document links in bounded batches and replaces current labels after renaming', async () => {
    const doc = Array.from({ length: 201 }, (_, index) => `[Entry](mimir://graph/node-${index})`).join('\n')
    const resolve = vi.fn(async ids => ids.map(id => ({ id, status: 'resolved', title: 'Current name' })))
    const { view, links } = makeView(doc, { resolve })
    await settle()
    expect(resolve.mock.calls.map(call => call[0].length)).toEqual([200, 1])
    expect(view.dom.textContent).toContain('Current name')
    resolve.mockImplementation(async ids => ids.map(id => ({ id, status: 'resolved', title: 'Renamed' })))
    links.refresh()
    await settle()
    expect(view.dom.textContent).toContain('Renamed')
    expect(view.state.doc.toString()).toBe(doc)
  })
  it('reveals source at the caret and restores the rendered link when it leaves', async () => {
    const doc = 'See [Jon](mimir://graph/jon) here.'
    const { view } = makeView(doc, { resolve: async () => [{ id: 'jon', status: 'resolved', title: 'Jonathan' }] })
    await settle()
    view.focus()
    view.dispatch({ selection: { anchor: 10 } })
    expect(view.dom.querySelector('[data-graph-target="jon"]')).toBeNull()
    expect(view.dom.textContent).toContain('mimir://graph/jon')
    view.dispatch({ selection: { anchor: doc.length } })
    expect(view.dom.querySelector('[data-graph-target="jon"]').textContent).toBe('Jonathan')
  })

  it('reveals the exact repeated CRLF occurrence in a Graph source body', () => {
    const metadata = '---\ntitle: [Jon](mimir://graph/jon)\n---\n'
    const body = '🌙 [Jon](mimir://graph/jon)\r\nAgain [Jon](mimir://graph/jon)'
    const state = stateFor(metadata + body)
    const from = body.lastIndexOf('[Jon]')
    const request = { targetId: 'jon', sourceRevision: 'r1', from, to: body.length }
    expect(referenceSelection(state, request, 'r1', { bodyFrom: metadata.length, sourceBody: body }))
      .toEqual({ anchor: metadata.length + from - 1, head: state.doc.length })
    const changed = stateFor(metadata + 'Reference removed')
    expect(referenceSelection(changed, request, 'r2', { bodyFrom: metadata.length }))
      .toEqual({ anchor: metadata.length })
  })

  it('uses current reference bounds when the source revision changed', () => {
    const state = stateFor('🌙 New text [Jon](mimir://graph/jon)')
    const request = { targetId: 'jon', sourceRevision: 'old', from: 0, to: 24 }
    expect(referenceSelection(state, request, 'new')).toEqual({ anchor: 12, head: state.doc.length })
    expect(referenceSelection(stateFor('Reference removed'), request, 'new')).toEqual({ anchor: 0 })
  })
})
