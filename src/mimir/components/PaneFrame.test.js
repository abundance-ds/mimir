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

  function render(pane = 'activity', attach = false) {
    const pinia = createPinia()
    setActivePinia(pinia)
    return mount(PaneFrame, {
      props: { pane, title: pane === 'activity' ? 'Codex' : 'Editor', meta: 'Working' },
      ...(attach ? { attachTo: document.body } : {}),
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
    expect(wrapper.get('[data-pane-actions="activity"]').exists()).toBe(true)
    expect(wrapper.get('[data-pane-action="collapse"]').attributes('title')).toBe('Collapse Codex')
    expect(wrapper.get('[data-pane-action="expand"]').attributes('title')).toBe('Expand Activity')
    expect(wrapper.get('[data-pane-action="collapse"]').attributes('data-collapse-direction')).toBe('left')
    expect(render('editor').get('[data-editor-action="collapse"]').attributes('data-collapse-direction')).toBe('right')
  })

  it('uses the Activity expand control to focus the pane and restore the split', async () => {
    const wrapper = render()
    const store = useWorkbenchStore()

    await wrapper.get('[data-pane-action="expand"]').trigger('click')
    expect(store.paneLayout.activity.state).toBe('expanded')
    expect(store.paneLayout.editor.state).toBe('rail')
    expect(wrapper.get('[data-pane-action="expand"]').attributes('title')).toBe('Restore split')

    await wrapper.get('[data-pane-action="expand"]').trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-pane-action="expand"]').exists()).toBe(true)
    expect(store.paneLayout.activity.state).toBe('expanded')
    expect(store.paneLayout.editor.state).toBe('expanded')
  })

  it('keeps content mounted and exposes a vertical restore rail when collapsed', async () => {
    const wrapper = render()
    const store = useWorkbenchStore()
    const content = wrapper.get('[data-testid="stateful-content"]').element

    store.setPaneState('activity', 'rail')
    await wrapper.vm.$nextTick()

    expect(wrapper.get('[data-testid="stateful-content"]').element).toBe(content)
    expect(wrapper.get('[data-pane-content="activity"]').attributes('aria-hidden')).toBe('true')
    expect(wrapper.find('[data-pane-rail="activity"]').exists()).toBe(false)
  })

  it('removes previous and next history controls', () => {
    const wrapper = render()
    expect(wrapper.find('[data-pane-action="previous"]').exists()).toBe(false)
    expect(wrapper.find('[data-pane-action="next"]').exists()).toBe(false)
  })

  it('restores Sidebar from the Main header', async () => {
    const wrapper = render()
    const store = useWorkbenchStore()
    store.setPaneState('sidebar', 'rail')
    await wrapper.vm.$nextTick()

    expect(wrapper.get('[data-pane-header="activity"]').classes()).toContain('pl-6')
    await wrapper.get('[data-pane-action="restore-sidebar"]').trigger('click')
    expect(store.paneLayout.sidebar.state).toBe('expanded')
  })
})
