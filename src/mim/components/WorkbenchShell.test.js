import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { useWorkbenchStore } from '../../stores/workbench.js'
import WorkbenchShell from './WorkbenchShell.vue'

const StableHost = defineComponent({
  name: 'StableHost',
  setup() {
    return () => h('input', { 'data-testid': 'stable-host', value: 'alive' })
  },
})

describe('WorkbenchShell', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  function render() {
    const pinia = createPinia()
    setActivePinia(pinia)
    return mount(WorkbenchShell, {
      global: { plugins: [pinia] },
      slots: {
        sidebar: '<div data-testid="sidebar-slot">Sidebar</div>',
        activity: StableHost,
        editor: '<div data-testid="editor-slot">Editor</div>',
      },
    })
  }

  it('renders the three pane stages edge to edge', () => {
    const wrapper = render()

    expect(wrapper.get('[data-pane="sidebar"]').attributes('style')).toContain('width: 240px')
    expect(wrapper.get('[data-pane="activity"]').attributes('data-pane-state')).toBe('expanded')
    expect(wrapper.get('[data-pane="editor"]').attributes('style')).toContain('width: 520px')
    expect(wrapper.get('[data-testid="sidebar-slot"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="stable-host"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="editor-slot"]').exists()).toBe(true)
  })

  it('uses permanent rail widths from the workbench contract', async () => {
    const wrapper = render()
    const store = useWorkbenchStore()

    store.setPaneState('sidebar', 'rail')
    store.setPaneState('activity', 'rail')
    await wrapper.vm.$nextTick()

    expect(wrapper.get('[data-pane="sidebar"]').attributes('style')).toContain('width: 52px')
    expect(wrapper.get('[data-pane="activity"]').attributes('style')).toContain('width: 44px')
    expect(wrapper.get('[data-pane="editor"]').attributes('data-pane-state')).toBe('expanded')
  })

  it('keeps an Activity host mounted while its pane is railed', async () => {
    const wrapper = render()
    const store = useWorkbenchStore()
    const host = wrapper.get('[data-testid="stable-host"]').element

    store.setPaneState('activity', 'rail')
    await wrapper.vm.$nextTick()

    expect(wrapper.get('[data-testid="stable-host"]').element).toBe(host)
    expect(wrapper.get('[data-pane-stage="activity"]').attributes('aria-hidden')).toBe('true')
  })

  it('emits pane resize starts only while both content panes are expanded', async () => {
    const wrapper = render()
    const store = useWorkbenchStore()

    await wrapper.get('[data-resize-handle="sidebar"]').trigger('pointerdown')
    await wrapper.get('[data-resize-handle="editor"]').trigger('pointerdown')
    expect(wrapper.emitted('resizeStart')).toHaveLength(2)

    store.setPaneState('editor', 'rail')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-resize-handle="editor"]').exists()).toBe(false)
  })

  it('marks the shell as inert during a resize gesture', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(WorkbenchShell, {
      props: { dragging: true },
      global: { plugins: [pinia] },
    })

    expect(wrapper.get('[data-pane-shell="workbench"]').classes()).toContain('is-dragging')
  })
})
