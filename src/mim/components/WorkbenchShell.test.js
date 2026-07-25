import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { useWorkbenchStore } from '../../stores/workbench.js'
import WorkbenchShell from './WorkbenchShell.vue'

const StableHost = defineComponent({
  name: 'StableHost',
  setup() {
    return () => h('div', [
      h('div', { 'data-pane-header': 'activity' }, [
        h('button', { 'data-testid': 'activity-header-action' }, 'Activity action'),
      ]),
      h('input', { 'data-testid': 'stable-host', value: 'alive' }),
    ])
  },
})

describe('WorkbenchShell', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  function render(attach = false) {
    const pinia = createPinia()
    setActivePinia(pinia)
    return mount(WorkbenchShell, {
      ...(attach ? { attachTo: document.body } : {}),
      global: { plugins: [pinia] },
      slots: {
        sidebar: '<div data-testid="sidebar-slot">Sidebar</div>',
        activity: StableHost,
        editor: '<div data-testid="editor-slot"><div data-editor-tabs-region><button data-testid="editor-tab">Editor</button></div></div>',
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
    expect(wrapper.get('[data-pane="editor"]').classes()).toContain('flex-1')
    expect(wrapper.get('[data-pane="editor"]').attributes('style') || '').not.toContain('520px')
  })

  it('keeps Editor fixed in the split and lets it reclaim all released Activity width', async () => {
    const wrapper = render()
    const store = useWorkbenchStore()

    expect(wrapper.get('[data-pane="editor"]').attributes('style')).toContain('width: 520px')
    expect(wrapper.get('[data-pane="editor"]').classes()).not.toContain('flex-1')

    store.setPaneState('activity', 'rail')
    await wrapper.vm.$nextTick()

    expect(wrapper.get('[data-pane="editor"]').classes()).toContain('flex-1')
    expect(wrapper.get('[data-pane="editor"]').attributes('style') || '').not.toContain('width')
  })

  it('fits remembered Editor width against live viewport geometry', async () => {
    const wrapper = render()
    const store = useWorkbenchStore()
    store.setPaneState('sidebar', 'rail')
    store.setPaneWidth('editor', 900)
    await wrapper.setProps({ viewportWidth: 800 })

    expect(wrapper.get('[data-pane="editor"]').attributes('style')).toContain('width: 412px')
    expect(wrapper.get('[data-pane="activity"]').attributes('style')).toContain('min-width: 336px')
    expect(wrapper.get('[data-resize-handle="editor"]').exists()).toBe(true)
    expect(wrapper.get('[data-resize-handle="editor"] [data-resize-line]').classes()).toContain('w-px')

    await wrapper.setProps({ viewportWidth: 1280 })
    expect(wrapper.get('[data-pane="editor"]').attributes('style')).toContain('width: 892px')
    expect(store.paneLayout.editor.width).toBe(900)
  })

  it('keeps the Sidebar component visible in its rail and restores hidden content panes outside their stages', async () => {
    const wrapper = render()
    const store = useWorkbenchStore()
    const sidebar = wrapper.get('[data-testid="sidebar-slot"]').element

    store.setPaneState('sidebar', 'rail')
    store.setPaneState('activity', 'rail')
    await wrapper.vm.$nextTick()

    expect(wrapper.get('[data-testid="sidebar-slot"]').element).toBe(sidebar)
    expect(wrapper.get('[data-pane-stage="sidebar"]').attributes('aria-hidden')).toBeUndefined()
    expect(wrapper.get('[data-pane-restore="activity"]').exists()).toBe(true)

    await wrapper.get('[data-pane-restore="activity"]').trigger('click')
    expect(store.paneLayout.activity.state).toBe('expanded')
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

  it('moves focus from each rail restore into the restored pane', async () => {
    const wrapper = render(true)
    const store = useWorkbenchStore()
    store.setPaneState('activity', 'rail')
    await wrapper.vm.$nextTick()

    const activityRestore = wrapper.get('[data-pane-restore="activity"]')
    activityRestore.element.focus()
    await activityRestore.trigger('click')
    expect(document.activeElement).toBe(wrapper.get('[data-testid="activity-header-action"]').element)

    store.setPaneState('editor', 'rail')
    await wrapper.vm.$nextTick()
    const editorRestore = wrapper.get('[data-pane-restore="editor"]')
    editorRestore.element.focus()
    await editorRestore.trigger('click')
    expect(document.activeElement).toBe(wrapper.get('[data-testid="editor-tab"]').element)
    wrapper.unmount()
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

  it('uses quiet persistent hairlines inside six-pixel resize targets', () => {
    const wrapper = render()

    for (const pane of ['sidebar', 'editor']) {
      const handle = wrapper.get(`[data-resize-handle="${pane}"]`)
      expect(handle.classes()).toContain('w-1.5')
      expect(handle.get('[data-resize-line]').classes()).toContain('w-px')
    }
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
