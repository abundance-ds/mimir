import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import WorkspaceSwitcher from './WorkspaceSwitcher.vue'

function render(props = {}) {
  return mount(WorkspaceSwitcher, {
    attachTo: document.body,
    props: {
      workspaceName: 'mim-panel-editor',
      workspacePath: '/work/mim-panel-editor',
      recentWorkspaces: [
        { name: 'mim-panel-editor', path: '/work/mim-panel-editor' },
        { name: 'mim-os', path: '/work/mim-os' },
      ],
      ...props,
    },
  })
}

describe('WorkspaceSwitcher', () => {
  it('shows the current project and switches directly to a recent project', async () => {
    const wrapper = render()
    await wrapper.get('[data-sidebar-workspace]').trigger('click')

    const menu = document.body.querySelector('[data-project-switcher-menu]')
    expect(menu?.textContent).toContain('Current project')
    expect(menu?.textContent).toContain('/work/mim-panel-editor')
    expect(menu?.textContent).toContain('mim-os')
    const recent = [...menu.querySelectorAll('[data-project-menu-item]')]
      .find(item => item.textContent.includes('mim-os'))
    recent.click()
    expect(wrapper.emitted('openWorkspace')).toEqual([['/work/mim-os']])
    wrapper.unmount()
  })

  it('offers the native folder picker and supports roving keyboard focus', async () => {
    const wrapper = render()
    const trigger = wrapper.get('[data-sidebar-workspace]')
    trigger.element.focus()
    await trigger.trigger('keydown', { key: 'ArrowDown' })

    const menu = document.body.querySelector('[data-project-switcher-menu]')
    const items = [...menu.querySelectorAll('[data-project-menu-item]')]
    expect(document.activeElement).toBe(items[0])
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    expect(document.activeElement).toBe(items.at(-1))
    items.at(-1).click()
    expect(wrapper.emitted('chooseWorkspace')).toHaveLength(1)
    wrapper.unmount()
  })

  it('keeps the same switcher available in rail mode', async () => {
    const wrapper = render({ collapsed: true })
    expect(wrapper.get('[data-sidebar-workspace]').text()).toBe('MP')
    await wrapper.get('[data-sidebar-workspace]').trigger('click')
    expect(document.body.querySelector('[data-project-switcher-menu]')).not.toBeNull()
    wrapper.unmount()
  })
})
