import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ActivityHost from './ActivityHost.vue'

const StatefulActivity = defineComponent({
  props: { label: String },
  setup(props) {
    return () => h('input', {
      'data-stateful-activity': props.label,
      value: props.label,
    })
  },
})

describe('ActivityHost', () => {
  it('keeps every created Activity surface mounted while switching', async () => {
    const wrapper = mount(ActivityHost, {
      props: {
        activities: [
          { id: 'files', title: 'Files' },
          { id: 'agent:one', title: 'Codex' },
        ],
        activeId: 'files',
      },
      slots: {
        'activity-files': () => h(StatefulActivity, { label: 'files' }),
        'activity-agent:one': () => h(StatefulActivity, { label: 'agent' }),
      },
    })
    const files = wrapper.get('[data-stateful-activity="files"]').element
    const agent = wrapper.get('[data-stateful-activity="agent"]').element

    await wrapper.setProps({ activeId: 'agent:one' })

    expect(wrapper.get('[data-stateful-activity="files"]').element).toBe(files)
    expect(wrapper.get('[data-stateful-activity="agent"]').element).toBe(agent)
    expect(wrapper.get('[data-activity-surface="files"]').attributes('aria-hidden')).toBe('true')
    expect(wrapper.get('[data-activity-surface="agent:one"]').attributes('aria-hidden')).toBe('false')
  })

  it('renders an actionable missing state for an unknown selection', () => {
    const wrapper = mount(ActivityHost, {
      props: { activities: [], activeId: 'missing' },
    })

    expect(wrapper.get('[data-activity-missing]').text()).toContain('missing')
    expect(wrapper.get('[data-activity-recover]').exists()).toBe(true)
  })

  it('emits recovery without manufacturing an Activity', async () => {
    const wrapper = mount(ActivityHost, {
      props: { activities: [], activeId: 'missing' },
    })

    await wrapper.get('[data-activity-recover]').trigger('click')

    expect(wrapper.emitted('recover')).toHaveLength(1)
  })
})
