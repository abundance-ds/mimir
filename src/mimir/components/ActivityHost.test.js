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
  it('lazily mounts a surface on first visit, then preserves it while switching', async () => {
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
    expect(wrapper.find('[data-stateful-activity="agent"]').exists()).toBe(false)

    await wrapper.setProps({ activeId: 'agent:one' })
    const agent = wrapper.get('[data-stateful-activity="agent"]').element

    expect(wrapper.get('[data-stateful-activity="files"]').element).toBe(files)
    expect(wrapper.get('[data-stateful-activity="agent"]').element).toBe(agent)
    expect(wrapper.get('[data-activity-surface="files"]').attributes('aria-hidden')).toBe('true')
    expect(wrapper.get('[data-activity-surface="agent:one"]').attributes('aria-hidden')).toBe('false')
  })

  it('mounts O(1) surfaces for a large unvisited Activity history', () => {
    const activities = Array.from({ length: 100 }, (_, index) => ({
      id: `terminal:${index}`,
      title: `Terminal ${index}`,
    }))
    const wrapper = mount(ActivityHost, {
      props: { activities, activeId: 'terminal:42' },
      slots: Object.fromEntries(activities.map((activity) => [
        `activity-${activity.id}`,
        () => h(StatefulActivity, { label: activity.id }),
      ])),
    })

    expect(wrapper.findAll('[data-activity-surface]')).toHaveLength(1)
    expect(wrapper.get('[data-activity-surface="terminal:42"]').exists()).toBe(true)
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

  it('shows an explicit state while an automatic session restore is not usable', async () => {
    const wrapper = mount(ActivityHost, {
      props: {
        activities: [{ id: 'agent:one', title: 'Codex' }],
        activeId: 'agent:one',
        restoringActivityIds: new Set(['agent:one']),
      },
      slots: {
        'activity-agent:one': () => h(StatefulActivity, { label: 'agent' }),
      },
    })

    expect(wrapper.get('[data-activity-restoring="agent:one"]').text())
      .toBe('Restoring session…')
    expect(wrapper.get('[data-stateful-activity="agent"]').exists()).toBe(true)

    await wrapper.setProps({ restoringActivityIds: new Set() })
    expect(wrapper.find('[data-activity-restoring]').exists()).toBe(false)
  })
})
