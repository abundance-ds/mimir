import { EditorView } from '@codemirror/view'
import { undo } from '@codemirror/commands'
import { language } from '@codemirror/language'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '../../../stores/settings.js'
import EditorSurface from './EditorSurface.vue'

describe('EditorSurface feature extensions', () => {
  it('remeasures CodeMirror after Commit Mono becomes ready', async () => {
    let resolveFont
    const fontReady = new Promise(resolve => { resolveFont = resolve })
    const load = vi.fn(() => fontReady)
    const originalFonts = Object.getOwnPropertyDescriptor(document, 'fonts')
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { load },
    })

    let wrapper
    try {
      wrapper = mount(EditorSurface, {
        props: {
          content: 'Draft',
          path: '/work/draft.md',
        },
        global: { plugins: [createPinia()] },
      })
      const requestMeasure = vi.spyOn(wrapper.vm.getView(), 'requestMeasure')

      expect(load).toHaveBeenCalledWith('450 16px "Commit Mono"')
      expect(requestMeasure).not.toHaveBeenCalled()

      resolveFont([])
      await fontReady
      await wrapper.vm.$nextTick()
      expect(requestMeasure).toHaveBeenCalledOnce()

      await wrapper.setProps({ zoomLevel: 125 })
      await Promise.resolve()
      await wrapper.vm.$nextTick()
      expect(load).toHaveBeenLastCalledWith('450 20px "Commit Mono"')
      expect(requestMeasure).toHaveBeenCalledTimes(2)
    } finally {
      wrapper?.unmount()
      if (originalFonts) Object.defineProperty(document, 'fonts', originalFonts)
      else delete document.fonts
    }
  })

  it('does not remeasure a destroyed editor after font loading finishes', async () => {
    let resolveFont
    const fontReady = new Promise(resolve => { resolveFont = resolve })
    const originalFonts = Object.getOwnPropertyDescriptor(document, 'fonts')
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { load: () => fontReady },
    })

    let wrapper
    try {
      wrapper = mount(EditorSurface, {
        props: { content: 'Draft' },
        global: { plugins: [createPinia()] },
      })
      const requestMeasure = vi.spyOn(wrapper.vm.getView(), 'requestMeasure')
      wrapper.unmount()
      wrapper = null

      resolveFont([])
      await fontReady
      await Promise.resolve()
      expect(requestMeasure).not.toHaveBeenCalled()
    } finally {
      wrapper?.unmount()
      if (originalFonts) Object.defineProperty(document, 'fonts', originalFonts)
      else delete document.fonts
    }
  })

  it('applies the compact typography scale and theme-aware Commit Mono weight', async () => {
    const pinia = createPinia()
    const wrapper = mount(EditorSurface, {
      props: {
        content: 'Draft',
        path: '/work/draft.md',
        zoomLevel: 125,
      },
      global: { plugins: [pinia] },
    })
    const settings = useSettingsStore(pinia)
    const surface = wrapper.get('.editor-wrap').element

    expect(surface.style.getPropertyValue('--editor-size')).toBe('20px')
    expect(surface.style.getPropertyValue('--editor-line-height')).toBe('29px')
    expect(surface.style.getPropertyValue('--editor-font-weight')).toBe('450')
    expect(surface.style.getPropertyValue('--font-mono')).toContain('"Commit Mono"')

    settings.set('editorTheme', 'monokai')
    await wrapper.vm.$nextTick()
    expect(surface.style.getPropertyValue('--editor-font-weight')).toBe('400')
    wrapper.unmount()
  })

  it('reconfigures an already-mounted editor when AI/editor features change', async () => {
    const feature = value => EditorView.contentAttributes.of({ 'data-live-feature': value })
    const wrapper = mount(EditorSurface, {
      props: {
        content: 'Draft',
        path: '/work/draft.md',
        extensions: [feature('first')],
      },
      global: { plugins: [createPinia()] },
    })

    expect(wrapper.get('.cm-content').attributes('data-live-feature')).toBe('first')
    await wrapper.setProps({ extensions: [feature('second')] })
    expect(wrapper.get('.cm-content').attributes('data-live-feature')).toBe('second')
    expect(wrapper.vm.getContent()).toBe('Draft')

    wrapper.unmount()
  })

  it('moves the cursor for a search destination while ordinary scrolling retains selection', () => {
    const wrapper = mount(EditorSurface, {
      props: { content: 'first\nsecond\nthird', path: '/work/search.md' },
      global: { plugins: [createPinia()] },
    })
    wrapper.vm.scrollToPos(8, { select: true })
    expect(wrapper.vm.getCursor()).toMatchObject({ line: 2, column: 3, offset: 8 })
    wrapper.vm.scrollToPos(0)
    expect(wrapper.vm.getCursor().offset).toBe(8)
    wrapper.vm.scrollToPos(999, { select: true })
    expect(wrapper.vm.getCursor().offset).toBe(wrapper.vm.getContent().length)
    wrapper.unmount()
  })

  it('keeps the row highlight and adds the line-number highlight', async () => {
    const pinia = createPinia()
    const wrapper = mount(EditorSurface, {
      props: {
        content: 'one\ntwo',
        path: '/work/draft.md',
      },
      global: { plugins: [pinia] },
    })
    const settings = useSettingsStore(pinia)

    expect(wrapper.find('.cm-lineNumbers').exists()).toBe(false)
    expect(wrapper.find('.cm-activeLine').exists()).toBe(true)
    expect(wrapper.find('.cm-activeLineGutter').exists()).toBe(false)

    settings.set('editorLineNumbers', true)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.cm-lineNumbers').exists()).toBe(true)
    expect(wrapper.find('.cm-activeLine').exists()).toBe(true)
    expect(wrapper.find('.cm-activeLineGutter').exists()).toBe(true)

    settings.set('editorLineNumbers', false)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.cm-lineNumbers').exists()).toBe(false)
    expect(wrapper.find('.cm-activeLine').exists()).toBe(true)
    expect(wrapper.find('.cm-activeLineGutter').exists()).toBe(false)
    wrapper.unmount()
  })

  it('does not let undo after a tab switch reach into the previous file', async () => {
    const wrapper = mount(EditorSurface, {
      props: {
        content: 'file one',
        path: '/work/one.md',
        fileId: 1,
      },
      global: { plugins: [createPinia()] },
    })
    const view = wrapper.vm.getView()

    view.dispatch({ changes: { from: 0, to: 0, insert: 'EDIT ' } })
    expect(view.state.doc.toString()).toBe('EDIT file one')

    await wrapper.setProps({ content: 'file two', path: '/work/two.md', fileId: 2 })
    expect(view.state.doc.toString()).toBe('file two')

    undo(view)
    expect(view.state.doc.toString()).toBe('file two')

    wrapper.unmount()
  })

  it('keeps each open file its own undo history and scroll position across switches', async () => {
    const wrapper = mount(EditorSurface, {
      props: {
        content: 'file one',
        path: '/work/one.md',
        fileId: 1,
        openFileIds: [1, 2],
      },
      global: { plugins: [createPinia()] },
    })
    const view = wrapper.vm.getView()

    view.dispatch({ changes: { from: 0, to: 0, insert: 'EDIT ' } })
    expect(view.state.doc.toString()).toBe('EDIT file one')
    view.scrollDOM.scrollTop = 42

    await wrapper.setProps({ content: 'file two', path: '/work/two.md', fileId: 2 })
    view.dispatch({ changes: { from: 0, to: 0, insert: 'OTHER ' } })
    expect(view.state.doc.toString()).toBe('OTHER file two')

    await wrapper.setProps({ content: 'EDIT file one', path: '/work/one.md', fileId: 1 })
    expect(view.state.doc.toString()).toBe('EDIT file one')
    expect(view.scrollDOM.scrollTop).toBe(42)

    undo(view)
    expect(view.state.doc.toString()).toBe('file one')

    await wrapper.setProps({ content: 'OTHER file two', path: '/work/two.md', fileId: 2 })
    expect(view.state.doc.toString()).toBe('OTHER file two')
    undo(view)
    expect(view.state.doc.toString()).toBe('file two')

    wrapper.unmount()
  })

  it('keeps unflushed edits when the store did not change while the file was in the background', async () => {
    const wrapper = mount(EditorSurface, {
      props: { content: 'file one', path: '/work/one.md', fileId: 1, openFileIds: [1, 2] },
      global: { plugins: [createPinia()] },
    })
    const view = wrapper.vm.getView()

    view.dispatch({ changes: { from: 0, to: 0, insert: 'EDIT ' } })
    await wrapper.setProps({ content: 'file two', path: '/work/two.md', fileId: 2 })
    await wrapper.setProps({ content: 'file one', path: '/work/one.md', fileId: 1 })

    expect(view.state.doc.toString()).toBe('EDIT file one')
    undo(view)
    expect(view.state.doc.toString()).toBe('file one')

    wrapper.unmount()
  })

  it('applies a store change that happened while the file was in the background', async () => {
    const wrapper = mount(EditorSurface, {
      props: { content: 'file one', path: '/work/one.md', fileId: 1, openFileIds: [1, 2] },
      global: { plugins: [createPinia()] },
    })
    const view = wrapper.vm.getView()

    await wrapper.setProps({ content: 'file two', path: '/work/two.md', fileId: 2 })
    await wrapper.setProps({ content: 'file one reloaded', path: '/work/one.md', fileId: 1 })

    expect(view.state.doc.toString()).toBe('file one reloaded')

    wrapper.unmount()
  })

  it('keeps the language mode bound to each file across switches and renames', async () => {
    const wrapper = mount(EditorSurface, {
      props: { content: '# one', path: '/work/one.md', fileId: 1, openFileIds: [1, 2] },
      global: { plugins: [createPinia()] },
    })
    const view = wrapper.vm.getView()
    const mode = () => view.state.facet(language)?.name

    expect(mode()).toBe('markdown')
    await wrapper.setProps({ content: 'const x = 1', path: '/work/two.js', fileId: 2 })
    expect(mode()).toBe('javascript')
    await wrapper.setProps({ content: '# one', path: '/work/one.md', fileId: 1 })
    expect(mode()).toBe('markdown')

    await wrapper.setProps({ path: '/work/one.py' })
    expect(mode()).toBe('python')
    await wrapper.setProps({ content: 'const x = 1', path: '/work/two.js', fileId: 2 })
    await wrapper.setProps({ content: '# one', path: '/work/one.py', fileId: 1 })
    expect(mode()).toBe('python')

    wrapper.unmount()
  })

  it('forgets a file once it is no longer open', async () => {
    const wrapper = mount(EditorSurface, {
      props: {
        content: 'file one',
        path: '/work/one.md',
        fileId: 1,
        openFileIds: [1, 2],
      },
      global: { plugins: [createPinia()] },
    })
    const view = wrapper.vm.getView()

    view.dispatch({ changes: { from: 0, to: 0, insert: 'EDIT ' } })
    await wrapper.setProps({ content: 'file two', path: '/work/two.md', fileId: 2 })

    await wrapper.setProps({ openFileIds: [2] })
    await wrapper.setProps({ content: 'file one', path: '/work/one.md', fileId: 1 })

    expect(view.state.doc.toString()).toBe('file one')
    undo(view)
    expect(view.state.doc.toString()).toBe('file one')

    wrapper.unmount()
  })
})
