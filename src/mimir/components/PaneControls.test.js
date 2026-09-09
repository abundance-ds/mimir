import { h, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'
import { useWorkbenchStore } from '../../stores/workbench.js'
import WorkbenchShell from './WorkbenchShell.vue'
import WorkbenchSidebar from './WorkbenchSidebar.vue'
import PaneFrame from './PaneFrame.vue'
import AppHeader from '../../editor/components/shell/AppHeader.vue'

// Mount the real neighbouring controls together: isolated header tests cannot
// detect two components offering the same restore action.
describe('pane control ownership', () => {
  const states = ['expanded', 'rail'].flatMap(sidebar => [
    [sidebar, 'expanded', 'expanded'],
    [sidebar, 'rail', 'expanded'],
    [sidebar, 'expanded', 'rail'],
  ])
  it.each(states)('owns restore controls in %s / %s / %s', async (sidebar, activity, editor) => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useWorkbenchStore()
    for (const [pane, state] of Object.entries({ sidebar, activity, editor })) store.setPaneState(pane, state)
    const wrapper = mount(WorkbenchShell, {
      attachTo: document.body,
      global: { plugins: [pinia] },
      slots: {
        sidebar: ({ collapsed }) => h(WorkbenchSidebar, { collapsed, onToggleCollapse: () => store.togglePane('sidebar') }),
        activity: () => h(PaneFrame, { pane: 'activity', title: 'Activity' }),
        editor: () => h(AppHeader, { embedded: true, hideSidebar: true, tabs: [{ id: 'notes', name: 'Notes.md' }] }),
      },
    })
    try {
      expect(wrapper.findAll('[data-editor-action="restore-activity"]')).toHaveLength(activity === 'rail' ? 1 : 0)
      if (activity === 'rail') {
        expect(wrapper.get('[data-editor-restore-cluster]').findAll('button').map(button => button.attributes('data-editor-action'))).toEqual(sidebar === 'rail' ? ['restore-sidebar', 'restore-activity'] : ['restore-activity'])
      }
      const sidebarRestores = wrapper.findAll('[data-pane-action="restore-sidebar"], [data-editor-action="restore-sidebar"]')
      expect(sidebarRestores).toHaveLength(sidebar === 'rail' ? 1 : 0)
      if (sidebar === 'rail') {
        expect(sidebarRestores[0].element.closest('[data-pane]').dataset.pane).toBe(activity === 'rail' ? 'editor' : 'activity')
      }
      expect(wrapper.findAll('[data-sidebar-restore]')).toHaveLength(0)
      for (const pane of ['activity', 'editor']) {
        const rail = wrapper.find(`[data-pane-restore="${pane}"]`)
        expect(rail.exists()).toBe(store.paneLayout[pane].state === 'rail')
        if (rail.exists()) {
          expect(rail.findAll('[data-rail-header] svg')).toHaveLength(pane === 'editor' ? 1 : 0)
          const other = pane === 'activity' ? 'editor' : 'activity'
          const selector = other === 'editor' ? '[data-editor-action="expand"]' : '[data-pane-action="expand"]'
          expect(wrapper.get(selector).attributes('title')).toBe('Restore split')
          await rail.trigger('click')
          await nextTick()
          expect(store.paneLayout[pane].state).toBe('expanded')
          expect(document.activeElement.closest(`[data-pane="${pane}"]`)).not.toBeNull()
        }
      }
      if (sidebar === 'rail') {
        store.setPaneState('activity', 'rail')
        await nextTick()
        expect(wrapper.find('[data-pane-action="restore-sidebar"]').exists()).toBe(false)
        await wrapper.get('[data-editor-action="restore-sidebar"]').trigger('click')
        await nextTick()
        expect(document.activeElement).toBe(wrapper.get('[data-sidebar-collapse]').element)
        store.setPaneState('sidebar', 'rail')
        await nextTick()
        await wrapper.get('[data-editor-action="restore-activity"]').trigger('click')
        await nextTick()
        expect(document.activeElement.closest('[data-pane="activity"]')).not.toBeNull()
      }
      // The same button reverses expansion and retains keyboard focus.
      for (const pane of ['activity', 'editor']) {
        const prefix = pane === 'activity' ? 'data-pane-action' : 'data-editor-action'
        const toggle = wrapper.get(`[${prefix}="expand"]`)
        const element = toggle.element
        await toggle.trigger('click')
        await nextTick()
        expect(document.activeElement).toBe(element)
        expect(toggle.attributes('title')).toBe('Restore split')
        await toggle.trigger('click')
        await nextTick()
        expect(toggle.element).toBe(element)
        expect(document.activeElement).toBe(element)
        expect(store.paneLayout.activity.state).toBe('expanded')
        expect(store.paneLayout.editor.state).toBe('expanded')
        const other = pane === 'activity' ? 'editor' : 'activity'
        // Collapsing the sole open content pane must open its neighbour.
        await wrapper.get(`[${prefix}="expand"]`).trigger('click')
        await wrapper.get(`[${prefix}="collapse"]`).trigger('click')
        await nextTick()
        expect(store.paneLayout[pane].state).toBe('rail')
        expect(store.paneLayout[other].state).toBe('expanded')
        const ownRail = wrapper.get(`[data-pane-restore="${pane}"]`)
        expect(document.activeElement).toBe(ownRail.element)
        await ownRail.trigger('click')
        await nextTick()
      }
      if (sidebar === 'rail') {
        await wrapper.get('[data-pane-action="restore-sidebar"]').trigger('click')
        await nextTick()
        expect(store.paneLayout.sidebar.state).toBe('expanded')
        expect(document.activeElement).toBe(wrapper.get('[data-sidebar-collapse]').element)
      }
    } finally {
      wrapper.unmount()
    }
  })
})
