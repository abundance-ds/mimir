import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import AppActivity from './AppActivity.vue'

function activity(app, plan = {}) {
  return {
    id: `app:${app.id}`,
    kind: 'app',
    title: app.title,
    status: 'ready',
    workspacePath: '/work',
    source: { type: 'app', appId: app.id, app },
    launch: { plan: { appId: app.id, mode: app.mode, ...plan } },
  }
}

describe('AppActivity', () => {
  it('routes the native Changes helper to its focused surface', () => {
    const record = activity({
      id: 'changes',
      title: 'Changes',
      mode: 'rust-helper',
      helper: 'git-changes',
    }, { helper: 'git-changes' })
    const wrapper = mount(AppActivity, { props: { activity: record, active: true } })

    expect(wrapper.findComponent({ name: 'ChangesApp' }).exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'ScratchApp' }).exists()).toBe(false)
  })

  it('routes Scratch and gives its tool provider a stable instance identity', () => {
    const record = activity({
      id: 'scratch',
      title: 'Scratch',
      mode: 'embedded',
      entry: 'mim://builtin/scratch',
      tools: [],
    }, { url: 'mim://builtin/scratch' })
    const wrapper = mount(AppActivity, { props: { activity: record, active: true } })
    const scratch = wrapper.findComponent({ name: 'ScratchApp' })

    expect(scratch.exists()).toBe(true)
    expect(scratch.props('instanceId')).toBe('app:scratch')
  })

  it('routes external launch plans through a callback event', async () => {
    const record = activity({
      id: 'runner',
      title: 'Runner',
      mode: 'process',
    }, { command: 'runner', args: [], cwd: '/work' })
    const wrapper = mount(AppActivity, { props: { activity: record, active: true } })
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('launchPlan')).toHaveLength(1)
    expect(wrapper.emitted('launchPlan')[0][0].plan.command).toBe('runner')
  })

  it('renders an actionable diagnostic for malformed durable records', () => {
    const record = {
      id: 'app:missing',
      kind: 'app',
      title: 'Missing',
      status: 'interrupted',
      source: {},
      launch: {},
    }
    const wrapper = mount(AppActivity, { props: { activity: record, active: true } })

    expect(wrapper.get('[data-app-activity-invalid]').text()).toContain('definition is missing')
  })
})
