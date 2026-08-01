import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
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
  it('routes the restored scratch identity to the focused Today surface', () => {
    const record = activity({
      id: 'scratch',
      title: 'Today',
      mode: 'embedded',
      entry: 'mimir://builtin/scratch',
      tools: [],
    }, { url: 'mimir://builtin/scratch' })
    const wrapper = mount(AppActivity, {
      props: { activity: record, active: true },
      global: { stubs: { TodayApp: true, EmbeddedAppHost: true } },
    })

    expect(wrapper.findComponent({ name: 'TodayApp' }).exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'EmbeddedAppHost' }).exists()).toBe(false)
  })

  it('routes the built-in business graph to its native Vue surface', () => {
    const record = activity({
      id: 'business-graph',
      title: 'Business graph',
      mode: 'rust-helper',
      helper: 'business-graph',
    }, { helper: 'business-graph' })
    const wrapper = mount(AppActivity, {
      props: { activity: record, active: true },
      global: {
        stubs: {
          BusinessGraphApp: true,
          EmbeddedAppHost: true,
        },
      },
    })

    expect(wrapper.findComponent({ name: 'BusinessGraphApp' }).exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'EmbeddedAppHost' }).exists()).toBe(false)
  })

  it('routes the built-in Scribe tool to its native meeting surface', () => {
    const record = activity({
      id: 'scribe',
      title: 'Scribe',
      mode: 'rust-helper',
      helper: 'scribe',
    }, { helper: 'scribe' })
    const wrapper = mount(AppActivity, {
      props: { activity: record, active: true },
      global: {
        stubs: {
          ScribeApp: true,
          EmbeddedAppHost: true,
        },
      },
    })

    expect(wrapper.findComponent({ name: 'ScribeApp' }).exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'EmbeddedAppHost' }).exists()).toBe(false)
  })

  it('forwards Scribe settings to the one global settings surface', async () => {
    const record = activity({
      id: 'scribe',
      title: 'Scribe',
      mode: 'rust-helper',
      helper: 'scribe',
    }, { helper: 'scribe' })
    const wrapper = mount(AppActivity, {
      props: { activity: record, active: true },
      global: {
        stubs: {
          ScribeApp: defineComponent({
            name: 'ScribeApp',
            emits: ['openSettings'],
            setup(_, { emit }) {
              return () => h('button', {
                'data-open-scribe-settings': '',
                onClick: () => emit('openSettings', 'scribe'),
              })
            },
          }),
        },
      },
    })

    await wrapper.get('[data-open-scribe-settings]').trigger('click')
    expect(wrapper.emitted('openSettings')).toEqual([['scribe']])
  })

  it('forwards workbench entry focus to the hosted surface', () => {
    const focusEntry = vi.fn()
    const record = activity({
      id: 'business-graph',
      title: 'Business graph',
      mode: 'rust-helper',
      helper: 'business-graph',
    }, { helper: 'business-graph' })
    const wrapper = mount(AppActivity, {
      props: { activity: record, active: true },
      global: {
        stubs: {
          BusinessGraphApp: defineComponent({
            name: 'BusinessGraphApp',
            setup(_, { expose }) {
              expose({ focusEntry })
              return () => h('div')
            },
          }),
        },
      },
    })

    wrapper.vm.focusEntry()
    expect(focusEntry).toHaveBeenCalledTimes(1)
  })

  it('forwards live Today state to the workbench tool runtime', () => {
    const state = { text: 'Current draft', loading: false, dirty: true, live: true }
    const record = activity({
      id: 'scratch',
      title: 'Today',
      mode: 'embedded',
      entry: 'mimir://builtin/scratch',
      tools: [],
    }, { url: 'mimir://builtin/scratch' })
    const wrapper = mount(AppActivity, {
      props: { activity: record, active: true },
      global: {
        stubs: {
          TodayApp: defineComponent({
            name: 'TodayApp',
            setup(_, { expose }) {
              expose({ todayState: () => state })
              return () => h('div')
            },
          }),
        },
      },
    })

    expect(wrapper.vm.todayState()).toEqual(state)
  })

  it('bubbles graph Activity handoffs through the ordinary app surface contract', async () => {
    const record = activity({
      id: 'business-graph',
      title: 'Business graph',
      mode: 'rust-helper',
      helper: 'business-graph',
    }, { helper: 'business-graph' })
    const wrapper = mount(AppActivity, {
      props: { activity: record, active: true },
      global: { stubs: { BusinessGraphApp: true } },
    })
    const payload = { nodeId: 'issue-1', prompt: 'Work from graph context.' }

    wrapper.findComponent({ name: 'BusinessGraphApp' }).vm.$emit('startWork', payload)
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('startWork')).toEqual([[payload]])
  })

  it('routes embedded apps and gives their host a stable instance identity', () => {
    const record = activity({
      id: 'ledger',
      title: 'Ledger',
      mode: 'embedded',
      entry: 'index.html',
      tools: [],
    }, { url: 'mimir-app://ledger/index.html' })
    const wrapper = mount(AppActivity, {
      props: { activity: record, active: true },
      global: { stubs: { EmbeddedAppHost: true } },
    })
    const embedded = wrapper.findComponent({ name: 'EmbeddedAppHost' })

    expect(embedded.exists()).toBe(true)
    expect(embedded.props('instanceId')).toBe('app:ledger')
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
