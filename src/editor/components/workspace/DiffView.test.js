import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
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
})
