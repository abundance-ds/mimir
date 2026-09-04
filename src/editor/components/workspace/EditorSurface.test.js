import { EditorView } from '@codemirror/view'
import { undo } from '@codemirror/commands'
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
})
