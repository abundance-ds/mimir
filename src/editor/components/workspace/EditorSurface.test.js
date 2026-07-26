import { EditorView } from '@codemirror/view'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { describe, expect, it } from 'vitest'
import { useSettingsStore } from '../../../stores/settings.js'
import EditorSurface from './EditorSurface.vue'

describe('EditorSurface feature extensions', () => {
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

  it('renders the paper-style line gutter only while the setting is enabled', async () => {
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
    settings.set('editorLineNumbers', true)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.cm-lineNumbers').exists()).toBe(true)

    settings.set('editorLineNumbers', false)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.cm-lineNumbers').exists()).toBe(false)
    wrapper.unmount()
  })
})
