import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import SegmentedControl from './SegmentedControl.vue'

describe('SegmentedControl', () => {
  it('marks the current value as pressed', () => {
    const wrapper = mount(SegmentedControl, {
      props: {
        options: ['source', 'split', 'preview'],
        modelValue: 'split',
      },
    })

    const buttons = wrapper.findAll('button')
    expect(buttons.map(button => button.attributes('aria-pressed'))).toEqual([
      'false',
      'true',
      'false',
    ])
    expect(buttons[1].classes()).toContain('is-active')
  })

  it('emits value changes', async () => {
    const wrapper = mount(SegmentedControl, {
      props: {
        options: ['source', 'split', 'preview'],
        modelValue: 'source',
      },
    })

    await wrapper.findAll('button')[2].trigger('click')

    expect(wrapper.emitted('update:modelValue')).toEqual([['preview']])
  })
})
