import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import LaunchPlanHost from './LaunchPlanHost.vue'

const activity = {
  id: 'app:claude-review',
  title: 'Claude review',
  status: 'ready',
  workspacePath: '/work',
}

describe('LaunchPlanHost', () => {
  it('dispatches a fresh process app only when its Activity becomes active', async () => {
    const plan = {
      mode: 'process',
      appId: 'claude-review',
      command: 'claude',
      args: ['-p', 'Review this workspace'],
      cwd: '/work',
      env: {},
      launchOnly: false,
    }
    const wrapper = mount(LaunchPlanHost, {
      props: {
        app: { id: 'claude-review', title: 'Claude review' },
        plan,
        activity,
        active: false,
      },
    })
    expect(wrapper.emitted('launchPlan')).toBeUndefined()

    await wrapper.setProps({ active: true })

    expect(wrapper.emitted('launchPlan')).toHaveLength(1)
    expect(wrapper.emitted('launchPlan')[0][0]).toMatchObject({ plan, activity })
    expect(wrapper.text()).toContain('claude -p Review this workspace')
  })

  it('does not rerun a restored execution without an explicit click', async () => {
    const wrapper = mount(LaunchPlanHost, {
      props: {
        app: { id: 'remote', title: 'Remote' },
        plan: { mode: 'window', appId: 'remote', url: 'https://example.com' },
        activity: { ...activity, status: 'interrupted' },
        active: true,
      },
    })

    expect(wrapper.emitted('launchPlan')).toBeUndefined()
    await wrapper.get('[data-launch-plan-run]').trigger('click')
    expect(wrapper.emitted('launchPlan')).toHaveLength(1)
  })

  it('accepts lifecycle callbacks from the workbench integration', async () => {
    const wrapper = mount(LaunchPlanHost, {
      props: {
        app: { id: 'task', title: 'Task' },
        plan: { mode: 'action', appId: 'task', tool: 'apps.task.run' },
        activity,
        active: true,
      },
    })
    const payload = wrapper.emitted('launchPlan')[0][0]

    payload.onError(new Error('tool unavailable'))
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-launch-plan-error]').text()).toContain('tool unavailable')

    await wrapper.get('[data-launch-plan-run]').trigger('click')
    const retry = wrapper.emitted('launchPlan')[1][0]
    retry.onStarted({ label: 'Run 2' })
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-launch-plan-state]').text()).toContain('Run 2')
  })
})
