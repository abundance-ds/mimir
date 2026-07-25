import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import WorkbenchSidebar from './WorkbenchSidebar.vue'

const launchers = [
  { id: 'files', title: 'Files', icon: 'files', shortcut: '⌘P' },
  { id: 'codex', title: 'Codex', icon: 'agent' },
  { id: 'terminal', title: 'Terminal', icon: 'terminal' },
]

const activities = [
  { id: 'agent:one', title: 'Review API', kind: 'agent', status: 'working', unread: true },
  { id: 'terminal:two', title: 'Dev server', kind: 'terminal', status: 'needs-input' },
]

function render(collapsed = false) {
  return mount(WorkbenchSidebar, {
    props: {
      collapsed,
      workspaceName: 'mim-panel-editor',
      workspacePath: '/work/mim-panel-editor',
      launchers,
      activities,
      activeActivityId: 'agent:one',
    },
  })
}

describe('WorkbenchSidebar', () => {
  it('renders stable launchers before live activities', () => {
    const wrapper = render()
    const rows = wrapper.findAll('[data-sidebar-row]').map((row) => row.attributes('data-sidebar-row'))

    expect(rows).toEqual([
      'launcher:files',
      'launcher:codex',
      'launcher:terminal',
      'activity:agent:one',
      'activity:terminal:two',
    ])
    expect(wrapper.text()).toContain('mim-panel-editor')
    expect(wrapper.get('[data-activity-status="working"]').exists()).toBe(true)
  })

  it('keeps the same rows and exposes monograms in rail mode', async () => {
    const wrapper = render()
    const activityRow = wrapper.get('[data-sidebar-row="activity:agent:one"]').element

    await wrapper.setProps({ collapsed: true })

    expect(wrapper.get('[data-sidebar-row="activity:agent:one"]').element).toBe(activityRow)
    expect(wrapper.get('[data-sidebar-monogram="agent:one"]').text()).toBe('RA')
    expect(wrapper.get('[data-sidebar-row="activity:agent:one"]').attributes('title')).toContain('Review API')
    expect(wrapper.get('[data-sidebar-copy="activity:agent:one"]').attributes('aria-hidden')).toBe('true')
  })

  it('emits explicit launcher, activity, workspace, and collapse intents', async () => {
    const wrapper = render()

    await wrapper.get('[data-sidebar-row="launcher:codex"]').trigger('click')
    await wrapper.get('[data-sidebar-row="activity:terminal:two"]').trigger('click')
    await wrapper.get('[data-sidebar-workspace]').trigger('click')
    await wrapper.get('[data-sidebar-collapse]').trigger('click')

    expect(wrapper.emitted('launch')[0]).toEqual(['codex'])
    expect(wrapper.emitted('selectActivity')[0]).toEqual(['terminal:two'])
    expect(wrapper.emitted('chooseWorkspace')).toHaveLength(1)
    expect(wrapper.emitted('toggleCollapse')).toHaveLength(1)
  })

  it('uses status and unread overlays without duplicating rows', () => {
    const wrapper = render(true)

    expect(wrapper.findAll('[data-sidebar-row="activity:agent:one"]')).toHaveLength(1)
    expect(wrapper.get('[data-activity-status="working"]').classes()).toContain('bg-accent')
    expect(wrapper.get('[data-activity-unread="agent:one"]').exists()).toBe(true)
  })
})
