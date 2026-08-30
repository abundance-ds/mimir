import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import WorkspaceSwitcher from './WorkspaceSwitcher.vue'

function render(props = {}) {
  return mount(WorkspaceSwitcher, {
    attachTo: document.body,
    props: {
      workspaceName: 'mimir',
      workspacePath: '/work/mimir',
      recentWorkspaces: [
        { name: 'mimir', path: '/work/mimir', current: true },
        { name: 'other-project', path: '/work/other-project' },
      ],
      ...props,
    },
  })
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('WorkspaceSwitcher', () => {
  it('opens as a focused project filter without repeating current-project detail', async () => {
    const wrapper = render()
    await wrapper.get('[data-sidebar-workspace]').trigger('click')

    const popover = document.body.querySelector('[data-project-switcher-menu]')
    const input = popover.querySelector('[data-project-search]')
    expect(document.activeElement).toBe(input)
    expect(popover.textContent).not.toContain('Current project')
    expect(popover.textContent).not.toContain('Activities')
    expect(popover.textContent).toContain('other-project')
    expect(popover.textContent).toContain('/work')

    popover.querySelector('[data-project-path="/work/other-project"]').click()
    expect(wrapper.emitted('openWorkspace')).toEqual([['/work/other-project']])
    wrapper.unmount()
  })

  it('shows eight recent projects but filters the complete retained list', async () => {
    const projects = [
      { name: 'mimir', path: '/work/mimir', current: true },
      ...Array.from({ length: 10 }, (_, index) => ({
        name: index === 9 ? 'deep-archive' : `project-${index}`,
        path: `/work/${index === 9 ? 'deep-archive' : `project-${index}`}`,
      })),
    ]
    const wrapper = render({ recentWorkspaces: projects })
    await wrapper.get('[data-sidebar-workspace]').trigger('click')

    const popover = document.body.querySelector('[data-project-switcher-menu]')
    expect(popover.querySelectorAll('[data-project-path]')).toHaveLength(8)

    const input = popover.querySelector('[data-project-search]')
    input.value = 'archive'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await wrapper.vm.$nextTick()

    expect(popover.querySelectorAll('[data-project-path]')).toHaveLength(1)
    expect(popover.textContent).toContain('deep-archive')
    wrapper.unmount()
  })

  it('uses Arrow keys and Return across projects and actions', async () => {
    const wrapper = render()
    await wrapper.get('[data-sidebar-workspace]').trigger('click')
    const input = document.body.querySelector('[data-project-search]')

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(wrapper.emitted('openWorkspace')).toEqual([['/work/other-project']])

    await wrapper.get('[data-sidebar-workspace]').trigger('click')
    const reopenedInput = document.body.querySelector('[data-project-search]')
    reopenedInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    reopenedInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(wrapper.emitted('createWorkspace')).toHaveLength(1)
    wrapper.unmount()
  })

  it('offers open and create project actions', async () => {
    const wrapper = render()
    await wrapper.get('[data-sidebar-workspace]').trigger('click')
    document.body.querySelector('[data-project-open-folder]').click()
    expect(wrapper.emitted('chooseWorkspace')).toHaveLength(1)

    await wrapper.get('[data-sidebar-workspace]').trigger('click')
    document.body.querySelector('[data-project-create]').click()
    expect(wrapper.emitted('createWorkspace')).toHaveLength(1)
    wrapper.unmount()
  })

  it('opens immediately, requests reconciliation, and disables missing Activity projects', async () => {
    const wrapper = render({
      recentWorkspaces: [
        { name: 'mimir', path: '/work/mimir', current: true },
        { name: 'removed', path: '/work/removed', missing: true },
      ],
    })
    await wrapper.get('[data-sidebar-workspace]').trigger('click')

    expect(wrapper.emitted('reconcileWorkspaces')).toHaveLength(1)
    const missing = document.body.querySelector('[data-project-path="/work/removed"]')
    expect(missing).not.toBeNull()
    expect(missing.disabled).toBe(true)
    expect(missing.textContent).toContain('Missing')

    const input = document.body.querySelector('[data-project-search]')
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(wrapper.emitted('openWorkspace')).toBeUndefined()
    expect(wrapper.emitted('chooseWorkspace')).toHaveLength(1)
    wrapper.unmount()
  })

  it('closes without trapping Tab focus', async () => {
    const wrapper = render()
    await wrapper.get('[data-sidebar-workspace]').trigger('click')
    const input = document.body.querySelector('[data-project-search]')
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    await wrapper.vm.$nextTick()

    expect(document.body.querySelector('[data-project-switcher-menu]')).toBeNull()
    wrapper.unmount()
  })

  it('keeps the same switcher available in rail mode', async () => {
    const wrapper = render({ collapsed: true })
    expect(wrapper.get('[data-sidebar-workspace]').text()).toBe('MI')
    await wrapper.get('[data-sidebar-workspace]').trigger('click')
    expect(document.body.querySelector('[data-project-switcher-menu]')).not.toBeNull()
    wrapper.unmount()
  })

  it('marks the current workspace when its folder is missing', () => {
    const wrapper = render({ workspaceMissing: true })

    expect(wrapper.get('[data-sidebar-workspace]').attributes('aria-label'))
      .toBe('Workspace unavailable: mimir')
    expect(wrapper.get('[data-sidebar-workspace]').text()).toContain('Missing · /work/mimir')
    wrapper.unmount()
  })
})
