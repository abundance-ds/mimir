import { defineComponent, h, nextTick, ref, Teleport } from 'vue'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import PaneFrame from '../components/PaneFrame.vue'
import { usePaneChrome } from './usePaneChrome.js'

function surface(active, meta) {
  return defineComponent({
    props: { active: { type: Boolean, default: true } },
    setup(props) {
      const { actionsHost, hosted } = usePaneChrome({ active: () => props.active, meta })
      return () => h('div', { 'data-surface': hosted ? 'hosted' : 'alone' }, [
        h(Teleport, { to: actionsHost.value, disabled: !actionsHost.value }, [
          h('button', { 'data-surface-action': '' }, 'New'),
        ]),
        h('p', 'content'),
      ])
    },
  })
}

describe('usePaneChrome', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('lifts meta and actions of the active surface into the pane header', async () => {
    const active = ref(true)
    const meta = ref('3 armed')
    const Surface = surface(active, meta)
    const wrapper = mount(PaneFrame, {
      props: { pane: 'activity', title: 'Routines', meta: 'Ready' },
      attachTo: document.body,
      slots: { default: () => h(Surface, { active: active.value }) },
    })
    await nextTick()
    const header = wrapper.get('[data-pane-header="activity"]')
    expect(header.text()).toContain('3 armed')
    expect(header.text()).not.toContain('Ready')
    expect(wrapper.get('[data-pane-actions="activity"] [data-surface-action]').exists()).toBe(true)
    expect(wrapper.get('[data-surface]').attributes('data-surface')).toBe('hosted')

    meta.value = ''
    await nextTick()
    expect(header.text()).toContain('Ready')
    wrapper.unmount()
  })

  it('keeps tool actions beside tabs without an extra header row', async () => {
    const Surface = surface(ref(true), ref('3 armed'))
    const wrapper = mount(PaneFrame, {
      props: { pane: 'activity', title: 'Routines', meta: 'Ready' },
      attachTo: document.body,
      slots: {
        tabs: '<div role="tablist"><button role="tab">Routines</button></div>',
        actions: '<button data-explicit-action>Return</button>',
        default: () => h(Surface, { active: true }),
      },
    })
    await nextTick()
    const header = wrapper.get('[data-pane-header="activity"]')
    expect(header.get('[role=tablist]').exists()).toBe(true)
    expect(header.get('[data-surface-action]').exists()).toBe(true)
    expect(header.get('[data-explicit-action]').exists()).toBe(true)
    expect(wrapper.find('.pane-bar').exists()).toBe(false)
    wrapper.unmount()
  })

  it('renders actions inline and keeps the pane meta when the surface is inactive or alone', async () => {
    const Surface = surface(ref(false), ref('hidden meta'))
    const wrapper = mount(PaneFrame, {
      props: { pane: 'activity', title: 'Routines', meta: 'Ready' },
      attachTo: document.body,
      slots: { default: () => h(Surface, { active: false }) },
    })
    await nextTick()
    expect(wrapper.get('[data-pane-header="activity"]').text()).toContain('Ready')
    expect(wrapper.find('[data-pane-actions="activity"] [data-surface-action]').exists()).toBe(false)
    expect(wrapper.get('[data-surface] [data-surface-action]').exists()).toBe(true)
    wrapper.unmount()

    const alone = mount(surface(ref(true), ref('x')))
    expect(alone.get('[data-surface]').attributes('data-surface')).toBe('alone')
    expect(alone.get('[data-surface-action]').exists()).toBe(true)
  })
})
