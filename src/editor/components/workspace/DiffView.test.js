import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import { acceptChunk, rejectChunk } from '@codemirror/merge'
import { useDiffStore } from '../../../stores/diff.js'
import DiffView from './DiffView.vue'

describe('DiffView', () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => vi.useRealTimers())

  function mountActive({ original = 'before\nsame', modified = 'after\nsame', ...rest } = {}) {
    const diff = useDiffStore()
    diff.activate({ original, modified, ...rest })
    const wrapper = mount(DiffView)
    return { diff, wrapper }
  }

  it('builds a unified diff, reports chunks to the store, and resolves content', () => {
    const { diff, wrapper } = mountActive()

    expect(wrapper.find('.cm-editor').exists()).toBe(true)
    expect(diff.chunkCount).toBeGreaterThan(0)
    expect(wrapper.vm.getResolvedContent()).toBe('after\nsame')

    // Chunk navigation on the live view must not throw, even out of range.
    expect(() => wrapper.vm.scrollToChunk(0)).not.toThrow()
    expect(() => wrapper.vm.scrollToChunk(99)).not.toThrow()

    wrapper.unmount()
  })

  it('leaves completion to the review owner', async () => {
    const { wrapper } = mountActive()
    const view = EditorView.findFromDOM(wrapper.element.querySelector('.cm-editor'))
    expect(view).toBeTruthy()

    vi.useFakeTimers()
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: 'before\nsame' },
    })
    await vi.runAllTimersAsync()

    expect(wrapper.emitted('accept')).toBeUndefined()
    expect(wrapper.vm.getResolvedContent()).toBe('before\nsame')
    expect(useDiffStore().canFinish).toBe(true)
    wrapper.unmount()
  })

  it.each(['unified', 'split'])('preserves CRLF when reading the resolved %s review', async layout => {
    const { diff, wrapper } = mountActive({ original: 'before\r\nsame\r\n', modified: 'after\r\nsame\r\n' })
    diff.setLayout(layout)
    await flushPromises()
    expect(wrapper.vm.getResolvedContent()).toBe('after\r\nsame\r\n')
    wrapper.unmount()
  })

  it('preserves CRLF when rejecting the last unified chunk', async () => {
    const { wrapper } = mountActive({ original: 'before\r\nsame\r\n', modified: 'after\r\nsame\r\n' })
    const view = EditorView.findFromDOM(wrapper.element.querySelector('.cm-editor'))
    vi.useFakeTimers()
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'before\nsame\n' } })
    await vi.runAllTimersAsync()
    expect(wrapper.vm.getResolvedContent()).toBe('before\r\nsame\r\n')
    expect(wrapper.emitted('accept')).toBeUndefined()
    wrapper.unmount()
  })

  it('shows read-only original and result views without offering merge chunks', async () => {
    const { diff, wrapper } = mountActive({
      original: 'ORIGINAL TEXT',
      modified: 'MODIFIED TEXT',
    })

    diff.setViewMode('original')
    await flushPromises()
    expect(wrapper.find('.diff-readonly').exists()).toBe(true)
    expect(wrapper.text()).toContain('ORIGINAL TEXT')
    // Read-only views fall back to the stored modified content.
    expect(wrapper.vm.getResolvedContent()).toBe('MODIFIED TEXT')

    diff.setViewMode('result')
    await flushPromises()
    expect(wrapper.text()).toContain('MODIFIED TEXT')
    expect(wrapper.text()).not.toContain('ORIGINAL TEXT')

    wrapper.unmount()
  })

  it('renders a two-pane merge view in split layout', async () => {
    const { diff, wrapper } = mountActive({
      original: 'alpha\nshared',
      modified: 'beta\nshared',
    })

    diff.setLayout('split')
    await flushPromises()

    expect(wrapper.find('.side-by-side-merge').exists()).toBe(true)
    expect(wrapper.find('.cm-mergeView').exists()).toBe(true)
    expect(wrapper.findAll('.cm-editor').length).toBe(2)
    expect(diff.chunkCount).toBeGreaterThan(0)
    expect(wrapper.vm.getResolvedContent()).toBe('beta\nshared')

    wrapper.unmount()
  })

  it('builds on activation and tears the view down on deactivation', async () => {
    const diff = useDiffStore()
    const wrapper = mount(DiffView)
    expect(wrapper.find('.cm-editor').exists()).toBe(false)

    diff.activate({ original: 'a', modified: 'b' })
    await flushPromises()
    expect(wrapper.find('.cm-editor').exists()).toBe(true)

    diff.deactivate()
    await flushPromises()
    expect(wrapper.find('.cm-editor').exists()).toBe(false)

    wrapper.unmount()
  })

  it('keeps partial batch decisions when switching the focused review layout', async () => {
    const middle = Array.from({ length: 12 }, (_, i) => `same ${i}`).join('\n')
    const diff = useDiffStore()
    diff.activateBatch({ fileList: [{ path: '/a.md', original: `old A\n${middle}\nold B`, modified: `new A\n${middle}\nnew B` }] })
    diff.focusBatchFile('/a.md')
    const wrapper = mount(DiffView)
    const view = EditorView.findFromDOM(wrapper.element.querySelector('.cm-editor'))
    rejectChunk(view, 0)
    const expected = `old A\n${middle}\nnew B`
    expect(diff.files[0].modified).toBe(expected)
    diff.setLayout('split')
    await flushPromises()
    expect(wrapper.vm.getResolvedContent()).toBe(expected)
    diff.setViewMode('result')
    await flushPromises()
    expect(wrapper.vm.getResolvedContent()).toBe(expected)
    wrapper.unmount()
  })

  it('shows the committed result as read-only while its status can be retried', async () => {
    const { diff, wrapper } = mountActive()
    diff.decision = { status: 'applied', content: 'Reviewed subset', pending: false }
    await flushPromises()
    const view = EditorView.findFromDOM(wrapper.element.querySelector('.cm-editor'))
    expect(view.state.facet(EditorView.editable)).toBe(false)
    expect(wrapper.vm.getResolvedContent()).toBe('Reviewed subset')
    expect(wrapper.find('.cm-mergeButtons').exists()).toBe(false)
    wrapper.unmount()
  })
  it.each(['unified', 'split'])('retains mixed decisions, result, and Undo through every view from %s', async layout => {
    const middle = Array.from({ length: 12 }, (_, i) => `same ${i}`).join('\n')
    const original = `old A\n${middle}\nold B\n${middle}\nold C`
    const modified = `new A\n${middle}\nnew B\n${middle}\nnew C`
    const { diff, wrapper } = mountActive({ original, modified })
    diff.setLayout(layout)
    await flushPromises()
    const click = async action => {
      await vi.waitFor(() => expect(wrapper.find(`button[name=${action}]`).exists()).toBe(true))
      await wrapper.find(`button[name=${action}]`).trigger('click')
      await flushPromises()
    }
    await click('accept')
    expect(diff.pendingChanges).toBe(2)
    await click('reject')
    expect(diff.pendingChanges).toBe(1)
    const expected = `new A\n${middle}\nold B\n${middle}\nnew C`
    for (const next of ['split', 'unified', 'result', 'original', 'split']) {
      if (next === 'split' || next === 'unified') { diff.setLayout(next); diff.setViewMode('diff') }
      else diff.setViewMode(next)
      await flushPromises()
      expect(wrapper.vm.getResolvedContent()).toBe(expected)
      expect(diff.pendingChanges).toBe(1)
    }
    expect(diff.currentReview.original).toBe(original)
    diff.undoReview()
    await flushPromises()
    expect(diff.pendingChanges).toBe(2)
    expect(wrapper.vm.getResolvedContent()).toBe(modified)
    diff.undoReview()
    await flushPromises()
    expect(diff.pendingChanges).toBe(3)
    diff.redoReview()
    diff.redoReview()
    await flushPromises()
    expect(wrapper.vm.getResolvedContent()).toBe(expected)
    expect(diff.pendingChanges).toBe(1)
    wrapper.unmount()
  })

  it.each(['accept', 'reject'])('preserves a pure deletion decision in split view (%s)', async action => {
    const { diff, wrapper } = mountActive({ original: 'remove me\r\n', modified: '' })
    diff.setLayout('split')
    await flushPromises()
    await vi.waitFor(() => expect(wrapper.find(`button[name=${action}]`).exists()).toBe(true))
    await wrapper.find(`button[name=${action}]`).trigger('click')
    expect(diff.pendingChanges).toBe(0)
    expect(diff.canFinish).toBe(true)
    expect(wrapper.vm.getResolvedContent()).toBe(action === 'accept' ? '' : 'remove me\r\n')
    await wrapper.trigger('keydown', { key: 'z', metaKey: true })
    expect(diff.pendingChanges).toBe(1)
    wrapper.unmount()
  })

  it('preserves manual result edits and history across view replacement', async () => {
    const { diff, wrapper } = mountActive()
    const view = EditorView.findFromDOM(wrapper.element.querySelector('.cm-editor'))
    view.dispatch({ changes: { from: 0, to: 5, insert: 'custom' }, userEvent: 'input.type' })
    diff.setLayout('split')
    await flushPromises()
    expect(wrapper.vm.getResolvedContent()).toBe('custom\nsame')
    diff.undoReview()
    await flushPromises()
    expect(wrapper.vm.getResolvedContent()).toBe('after\nsame')
    wrapper.unmount()
  })

})
