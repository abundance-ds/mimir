import { EditorView } from '@codemirror/view'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { describe, expect, it } from 'vitest'
import { useSettingsStore } from '../../../stores/settings.js'
import EditorSurface from './EditorSurface.vue'

describe('EditorSurface feature extensions', () => {
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
    expect(surface.style.getPropertyValue('--editor-line-height')).toBe('27px')
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
})
