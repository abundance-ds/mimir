import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { useWorkbenchStore } from '../../stores/workbench.js'
import PaneFrame from './PaneFrame.vue'

describe('PaneFrame', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  function render(pane = 'activity') {
    const pinia = createPinia()
    setActivePinia(pinia)
    return mount(PaneFrame, {
      props: { pane, title: pane === 'activity' ? 'Codex' : 'Editor', meta: 'Working' },
      global: { plugins: [pinia] },
      slots: {
        default: defineComponent({
          setup() {
            return () => h('textarea', { 'data-testid': 'stateful-content', value: 'draft' })
          },
        }),
      },
    })
  }

  it('shows a compact shared pane header while expanded', () => {
    const wrapper = render()

    expect(wrapper.get('[data-pane-header="activity"]').text()).toContain('Codex')
    expect(wrapper.get('[data-pane-header="activity"]').text()).toContain('Working')
    expect(wrapper.get('[data-pane-action="collapse"]').attributes('title')).toBe('Collapse Codex')
  })

  it('keeps content mounted and exposes a vertical restore rail when collapsed', async () => {
    const wrapper = render()
    const store = useWorkbenchStore()
    const content = wrapper.get('[data-testid="stateful-content"]').element

    store.setPaneState('activity', 'rail')
    await wrapper.vm.$nextTick()

    expect(wrapper.get('[data-testid="stateful-content"]').element).toBe(content)
    expect(wrapper.get('[data-pane-content="activity"]').attributes('aria-hidden')).toBe('true')
    expect(wrapper.get('[data-pane-rail="activity"]').text()).toContain('Codex')
    expect(wrapper.get('[data-pane-rail="activity"]').text()).toContain('Working')
  })

  it('restores a collapsed pane from the rail', async () => {
    const wrapper = render()
    const store = useWorkbenchStore()
    store.setPaneState('activity', 'rail')
    await wrapper.vm.$nextTick()

    await wrapper.get('[data-pane-rail="activity"]').trigger('click')

    expect(store.paneLayout.activity.state).toBe('expanded')
  })

  it('routes Previous and Next through the Activity history', async () => {
    const wrapper = render()
    const store = useWorkbenchStore()
    store.openActivity('agent:one')
    store.openActivity('terminal:two')
    await wrapper.vm.$nextTick()

    await wrapper.get('[data-pane-action="previous"]').trigger('click')
    expect(store.activeActivityId).toBe('agent:one')
    await wrapper.get('[data-pane-action="next"]').trigger('click')
    expect(store.activeActivityId).toBe('terminal:two')
  })

  it('lets the first expanded content header restore a railed sidebar', async () => {
    const wrapper = render()
    const store = useWorkbenchStore()
    store.setPaneState('sidebar', 'rail')
    await wrapper.vm.$nextTick()

    await wrapper.get('[data-pane-action="restore-sidebar"]').trigger('click')

    expect(store.paneLayout.sidebar.state).toBe('expanded')
  })
})
