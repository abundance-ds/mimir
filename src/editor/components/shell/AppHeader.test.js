import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkbenchStore } from '../../../stores/workbench.js'
import AppHeader from './AppHeader.vue'

describe('embedded editor header', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  function render() {
    const pinia = createPinia()
    setActivePinia(pinia)
    return mount(AppHeader, {
      props: {
        embedded: true,
        hideSidebar: true,
        tabs: [],
      },
      global: { plugins: [pinia] },
    })
  }

  it.each(['expanded', 'rail'])('keeps Main restore in the header when Sidebar is %s', async (sidebar) => {
    const wrapper = render()
    const workbench = useWorkbenchStore()
    workbench.setPaneState('sidebar', sidebar)
    workbench.setPaneState('activity', 'rail')
    await wrapper.vm.$nextTick()
    expect(wrapper.classes()).toContain('pane-header')
    expect(wrapper.find('[data-editor-restore-cluster]').exists()).toBe(true)
    expect(wrapper.get('[data-editor-restore-cluster]').findAll('button').map(button => button.attributes('data-editor-action'))).toEqual(['restore-activity'])
    expect(wrapper.find('[data-editor-action="restore-sidebar"]').exists()).toBe(false)
    expect(wrapper.get('[data-editor-action="expand"]').attributes('title')).toBe('Restore split')
  })

  it('keeps the generic drag spacer only in the standalone window header', () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(AppHeader, {
      props: { embedded: false, hideSidebar: true, tabs: [] },
      global: { plugins: [pinia] },
    })

    expect(wrapper.get('[data-header-drag-spacer]').exists()).toBe(true)
  })

  it('shows and emits the HTML browser action only when enabled', async () => {
    const wrapper = render()
    expect(wrapper.find('[data-editor-action="open-in-browser"]').exists()).toBe(false)

    await wrapper.setProps({ canOpenInBrowser: true })
    const action = wrapper.get('[data-editor-action="open-in-browser"]')
    const cluster = wrapper.get('[data-editor-browser-cluster]')
    expect(action.attributes('title')).toBe('Open in browser')
    expect(action.attributes('aria-label')).toBe('Open in browser')
    expect(cluster.classes()).toEqual(expect.arrayContaining(['border-r', 'border-rule']))
    expect(cluster.element.nextElementSibling?.querySelector('button')?.getAttribute('data-editor-action')).toBe('expand')

    await action.trigger('click')
    expect(wrapper.emitted('open-in-browser')).toHaveLength(1)
  })

  it('forwards the tab discard action to the Editor owner', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(AppHeader, {
      props: {
        embedded: true,
        hideSidebar: true,
        tabs: [{
          id: 'temp-tab',
          name: 'temp-note.md',
          lifecycleAction: 'trash',
        }],
      },
      global: {
        plugins: [pinia],
        stubs: { Teleport: true, Transition: false },
      },
    })

    await wrapper.get('button.file-tab').trigger('contextmenu', { clientX: 20, clientY: 20 })
    await wrapper.get('[data-tab-menu-action="discard"]').trigger('click')

    expect(wrapper.emitted('discard-tab')).toEqual([[0]])
    wrapper.unmount()
  })

  it('expands Editor into focus, restores the split, and keeps collapse separate', async () => {
    const wrapper = render()
    const workbench = useWorkbenchStore()

    await wrapper.get('[data-editor-action="expand"]').trigger('click')
    expect(workbench.paneLayout.activity.state).toBe('rail')
    expect(workbench.paneLayout.editor.state).toBe('expanded')
    expect(wrapper.get('[data-editor-action="expand"]').attributes('title')).toBe('Restore split')

    await wrapper.get('[data-editor-action="expand"]').trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-editor-action="expand"]').exists()).toBe(true)
    expect(workbench.paneLayout.activity.state).toBe('expanded')
    expect(workbench.paneLayout.editor.state).toBe('expanded')

    await wrapper.get('[data-editor-action="collapse"]').trigger('click')
    expect(workbench.paneLayout.editor.state).toBe('rail')
  })

  it('hands focus to the Editor rail after collapse', async () => {
    const editorRail = document.createElement('button')
    editorRail.dataset.paneRestore = 'editor'
    document.body.append(editorRail)
    const wrapper = render()
    await wrapper.get('[data-editor-action="collapse"]').trigger('click')
    await wrapper.vm.$nextTick()
    expect(document.activeElement).toBe(editorRail)
    wrapper.unmount()
    editorRail.remove()
  })
})
