import { afterEach, describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { history, undo } from '@codemirror/commands'
import { spellingSuggestions } from '../../../services/spelling.js'
import EditorContextMenu from './EditorContextMenu.vue'

vi.mock('../../../services/spelling.js', () => ({ spellingSuggestions: vi.fn(async () => []) }))

function mountMenu(props = {}) {
  return mount(EditorContextMenu, {
    props: { visible: true, x: 100, y: 100, ...props },
    global: { stubs: { Teleport: true } },
  })
}

function items(wrapper) {
  return wrapper.findAll('button.ctx-item')
}

function itemLabels(wrapper) {
  return items(wrapper).map(b => b.text().replace(/\s+/g, ' ').trim())
}

describe('EditorContextMenu', () => {
  // --- Selection-dependent items ---

  it('shows Cut/Copy/Paste + Comment + Ask AI when text is selected', () => {
    const w = mountMenu({ hasSelection: true })
    const labels = itemLabels(w)
    expect(labels).toContain('Cut ⌘X')
    expect(labels).toContain('Copy ⌘C')
    expect(labels).toContain('Add Comment ⇧⌘M')
    expect(labels).toContain('Ask AI ⌘K')
  })

  it('shows only Paste + Select All when no selection', () => {
    const w = mountMenu({ hasSelection: false })
    const labels = itemLabels(w)
    expect(labels).toEqual(['Paste ⌘V', 'Select All ⌘A'])
  })

  it('does not show Comment or Ask AI when no selection', () => {
    const w = mountMenu({ hasSelection: false })
    const labels = itemLabels(w)
    expect(labels).not.toContain('Add Comment ⇧⌘M')
    expect(labels).not.toContain('Ask AI ⌘K')
  })

  it('hides Ask AI when inline AI is disabled without removing comments', () => {
    const w = mountMenu({ hasSelection: true, aiEnabled: false })
    const labels = itemLabels(w)
    expect(labels).toContain('Add Comment ⇧⌘M')
    expect(labels).not.toContain('Ask AI ⌘K')
  })

  // --- Emit behavior ---

  it('emits comment then close when Add Comment clicked', async () => {
    const w = mountMenu({ hasSelection: true })
    const btn = items(w).find(b => b.text().includes('Add Comment'))
    await btn.trigger('click')
    expect(w.emitted('comment')).toHaveLength(1)
    expect(w.emitted('close')).toHaveLength(1)
  })

  it('emits ask-agent then close when Ask AI clicked', async () => {
    const w = mountMenu({ hasSelection: true })
    const btn = items(w).find(b => b.text().includes('Ask AI'))
    await btn.trigger('click')
    expect(w.emitted('ask-agent')).toHaveLength(1)
    expect(w.emitted('close')).toHaveLength(1)
  })

  // --- Ask AI accent styling ---

  it('Ask AI button has accent styling', () => {
    const w = mountMenu({ hasSelection: true })
    const btn = items(w).find(b => b.text().includes('Ask AI'))
    expect(btn.classes()).toContain('ctx-ai')
  })

  // --- Visibility ---

  it('renders nothing when not visible', () => {
    const w = mount(EditorContextMenu, {
      props: { visible: false, x: 0, y: 0 },
      global: { stubs: { Teleport: true } },
    })
    expect(w.find('.ctx-menu').exists()).toBe(false)
  })

  // --- Overlay closes on click ---

  it('emits close when overlay is clicked', async () => {
    const w = mountMenu({ hasSelection: false })
    await w.find('.ctx-overlay').trigger('click')
    expect(w.emitted('close')).toHaveLength(1)
  })
})

describe('spelling menu', () => {
  let view, wrapper
  afterEach(() => { wrapper?.unmount(); view?.destroy(); vi.mocked(spellingSuggestions).mockReset() })
  async function open() {
    view = new EditorView({ parent: document.body, state: EditorState.create({ doc: '😀 mispelled', extensions: [history()] }) })
    wrapper = mountMenu({ view, position: 12, spellcheckEnabled: true })
    await flushPromises()
  }

  it('keeps explicit corrections available with native spellcheck off and supports undo', async () => {
    vi.mocked(spellingSuggestions).mockResolvedValue(['misspelled'])
    await open()
    expect(view.contentDOM.getAttribute('spellcheck')).toBe('false')
    expect(spellingSuggestions).toHaveBeenCalledWith('mispelled')
    await wrapper.get('.spell-item').trigger('click')
    expect(view.state.doc.toString()).toBe('😀 misspelled')
    expect(undo(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('😀 mispelled')
  })

  it('does not offer stale suggestions after a document edit', async () => {
    let resolve
    vi.mocked(spellingSuggestions).mockImplementation(() => new Promise(done => { resolve = done }))
    await open()
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'new document' } })
    resolve(['misspelled'])
    await flushPromises()
    expect(wrapper.find('.spell-item').exists()).toBe(false)
  })

  it('does not apply a displayed suggestion to changed text', async () => {
    vi.mocked(spellingSuggestions).mockResolvedValue(['misspelled'])
    await open()
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'new document' } })
    await wrapper.get('.spell-item').trigger('click')
    expect(view.state.doc.toString()).toBe('new document')
  })

  it('supports keyboard navigation and closes on Escape', async () => {
    vi.mocked(spellingSuggestions).mockResolvedValue(['misspelled'])
    await open()
    await wrapper.get('.ctx-menu').trigger('keydown', { key: 'Home' })
    // The menu can be traversed without moving the editor selection.
    expect(view.state.selection.main.head).toBe(0)
    await wrapper.get('.ctx-menu').trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})
