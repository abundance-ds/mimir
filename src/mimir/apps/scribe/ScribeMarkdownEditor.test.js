import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ScribeMarkdownEditor from './ScribeMarkdownEditor.vue'

describe('ScribeMarkdownEditor', () => {
  it('is an unframed Markdown document editor with Tab indentation', async () => {
    const wrapper = mount(ScribeMarkdownEditor, {
      props: {
        modelValue: '- First item',
        ariaLabel: 'Meeting notes in Markdown',
      },
    })

    expect(wrapper.find('textarea').exists()).toBe(false)
    expect(wrapper.get('[role="textbox"]').attributes('contenteditable')).toBe('true')
    wrapper.vm.focus()
    await wrapper.get('[role="textbox"]').trigger('keydown', { key: 'Tab' })

    expect(wrapper.vm.getValue()).toBe('  - First item')
    expect(wrapper.emitted('change')?.at(-1)).toEqual(['  - First item'])
  })

  it('keeps external Markdown updates synchronized', async () => {
    const wrapper = mount(ScribeMarkdownEditor, {
      props: { modelValue: '# Before', ariaLabel: 'Meeting summary in Markdown' },
    })
    await wrapper.setProps({ modelValue: '## After\n\n- Outcome' })
    expect(wrapper.vm.getValue()).toBe('## After\n\n- Outcome')
  })
})
