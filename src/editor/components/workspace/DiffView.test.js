import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import { rejectChunk } from '@codemirror/merge'
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

  it('emits accept with the resolved document once every chunk is settled', async () => {
    const { wrapper } = mountActive()
    const view = EditorView.findFromDOM(wrapper.element.querySelector('.cm-editor'))
    expect(view).toBeTruthy()

    vi.useFakeTimers()
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: 'before\nsame' },
    })
    await vi.runAllTimersAsync()

    expect(wrapper.emitted('accept')).toEqual([['before\nsame']])
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
    expect(wrapper.emitted('accept')).toEqual([['before\r\nsame\r\n']])
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
})
