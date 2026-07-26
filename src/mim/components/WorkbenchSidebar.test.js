import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import WorkbenchSidebar from './WorkbenchSidebar.vue'

const launchers = [
  { id: 'files', title: 'Files', icon: 'files', shortcut: '⌘P' },
  { id: 'codex', title: 'Codex', icon: 'codex' },
  {
    id: 'terminal',
    title: 'Terminal',
    icon: 'terminal',
    available: false,
    unavailableReason: 'shell unavailable',
  },
]

const activities = [
  {
    id: 'agent:one',
    title: 'Review API',
    kind: 'agent',
    status: 'working',
    retention: 'durable',
    unread: true,
    updatedAt: '2026-07-25T10:00:00Z',
    source: { presetId: 'codex-review' },
    host: { type: 'pty' },
  },
  {
    id: 'terminal:two',
    title: 'Dev server',
    kind: 'terminal',
    status: 'needs-input',
    retention: 'ephemeral',
    updatedAt: '2026-07-25T09:00:00Z',
    source: { presetId: 'terminal' },
    host: { type: 'pty' },
  },
]

function render(collapsed = false, attach = false) {
  return mount(WorkbenchSidebar, {
    ...(attach ? { attachTo: document.body } : {}),
    props: {
      collapsed,
      workspaceName: 'mim-panel-editor',
      workspacePath: '/work/mim-panel-editor',
      launchers: [launchers[0]],
      apps: launchers.slice(1),
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
    expect(wrapper.get('[data-sidebar-row="launcher:codex"] [data-launcher-identity]').attributes('data-launcher-identity')).toBe('codex')
    expect(wrapper.get('[data-sidebar-row="launcher:codex"] svg').attributes('viewBox')).toBe('0 0 256 260')
    expect(wrapper.get('[data-sidebar-row="activity:agent:one"] svg').attributes('viewBox')).toBe('0 0 256 260')
  })

  it('keeps the same rows and exposes source identity in rail mode', async () => {
    const wrapper = render()
    const activityRow = wrapper.get('[data-sidebar-row="activity:agent:one"]').element

    await wrapper.setProps({ collapsed: true })

    expect(wrapper.get('[data-sidebar-row="activity:agent:one"]').element).toBe(activityRow)
    expect(wrapper.get('[data-sidebar-monogram="agent:one"]').attributes('data-activity-identity')).toBe('Codex')
    expect(wrapper.get('[data-sidebar-row="activity:agent:one"]').attributes('title')).toContain('Review API')
    expect(wrapper.get('[data-sidebar-row="activity:agent:one"]').find('button').attributes('aria-label')).toBe('Review API')
    expect(wrapper.get('[data-sidebar-row="launcher:codex"]').find('button').attributes('aria-label')).toBe('Codex')
    expect(wrapper.get('[data-sidebar-copy="activity:agent:one"]').attributes('aria-hidden')).toBe('true')
  })

  it('emits explicit launcher, activity, workspace, and collapse intents', async () => {
    const wrapper = render()

    await wrapper.get('[data-sidebar-row="launcher:codex"]').trigger('click')
    await wrapper.get('[data-sidebar-row="activity:terminal:two"]').trigger('click')
    await wrapper.get('[data-sidebar-workspace]').trigger('click')
    document.body.querySelector('[data-project-open-folder]')?.click()
    await wrapper.get('[data-sidebar-collapse]').trigger('click')
    await wrapper.get('[data-sidebar-settings]').trigger('click')
    await wrapper.get('[data-sidebar-manage-apps]').trigger('click')

    expect(wrapper.emitted('launch')[0]).toEqual(['codex'])
    expect(wrapper.emitted('selectActivity')[0]).toEqual(['terminal:two'])
    expect(wrapper.emitted('chooseWorkspace')).toHaveLength(1)
    expect(wrapper.emitted('toggleCollapse')).toHaveLength(1)
    expect(wrapper.emitted('settings')).toHaveLength(1)
    expect(wrapper.emitted('manageApps')).toHaveLength(1)
  })

  it('keeps pane collapse in the top chrome and Settings anchored at the bottom', () => {
    const wrapper = render()

    expect(wrapper.get('[data-sidebar-header]').find('[data-sidebar-collapse]').exists()).toBe(true)
    expect(wrapper.get('[data-sidebar-header]').text()).toBe('')
    expect(wrapper.get('[data-sidebar-footer]').find('[data-sidebar-settings]').exists()).toBe(true)
    expect(wrapper.get('[data-sidebar-settings]').text()).toContain('Settings')
  })

  it('discloses Apps and Activities independently while archived rows stay hidden by default', async () => {
    const wrapper = render()
    await wrapper.setProps({
      archivedActivities: [{
        ...activities[0],
        id: 'agent:archived',
        title: 'Archived review',
        status: 'done',
        archivedAt: '2026-07-25T11:00:00Z',
      }],
    })

    const appsToggle = wrapper.get('[data-sidebar-apps-toggle]')
    const activitiesToggle = wrapper.get('[data-sidebar-activities-toggle]')
    expect(appsToggle.attributes('aria-expanded')).toBe('true')
    expect(activitiesToggle.attributes('aria-expanded')).toBe('true')
    expect(wrapper.get('[data-sidebar-archived-toggle]').attributes('aria-expanded')).toBe('false')
    expect(wrapper.find('[data-sidebar-row="archived:agent:archived"]').exists()).toBe(false)

    await wrapper.get('[data-sidebar-archived-toggle]').trigger('click')
    expect(wrapper.get('[data-sidebar-row="archived:agent:archived"]').exists()).toBe(true)
    await wrapper.get('[data-sidebar-archived-toggle]').trigger('click')
    expect(wrapper.find('[data-sidebar-row="archived:agent:archived"]').exists()).toBe(false)

    await appsToggle.trigger('click')
    expect(wrapper.find('[data-sidebar-row="launcher:codex"]').exists()).toBe(false)
    expect(wrapper.get('[data-sidebar-row="activity:agent:one"]').exists()).toBe(true)
    expect(wrapper.emitted('manageApps')).toBeUndefined()

    await appsToggle.trigger('keydown', { key: 'ArrowRight' })
    expect(wrapper.get('[data-sidebar-row="launcher:codex"]').exists()).toBe(true)
    await appsToggle.trigger('keydown', { key: 'ArrowLeft' })
    expect(wrapper.find('[data-sidebar-row="launcher:codex"]').exists()).toBe(false)

    await wrapper.get('[data-sidebar-manage-apps]').trigger('click')
    expect(wrapper.emitted('manageApps')).toHaveLength(1)
    expect(appsToggle.attributes('aria-expanded')).toBe('false')

    await activitiesToggle.trigger('click')
    expect(wrapper.find('[data-sidebar-row="activity:agent:one"]').exists()).toBe(false)
    expect(wrapper.find('[data-sidebar-row="archived:agent:archived"]').exists()).toBe(false)

    await wrapper.setProps({ collapsed: true })
    expect(wrapper.get('[data-sidebar-row="launcher:codex"]').exists()).toBe(true)
    expect(wrapper.get('[data-sidebar-row="activity:agent:one"]').exists()).toBe(true)
    expect(wrapper.get('[data-sidebar-archived-toggle]').exists()).toBe(true)
    expect(wrapper.find('[data-sidebar-row="archived:agent:archived"]').exists()).toBe(false)
  })

  it('uses status and unread overlays without duplicating rows', () => {
    const wrapper = render(true)

    expect(wrapper.findAll('[data-sidebar-row="activity:agent:one"]')).toHaveLength(1)
    expect(wrapper.get('[data-activity-status="working"]').classes()).toContain('bg-accent')
    expect(wrapper.get('[data-activity-unread="agent:one"]').exists()).toBe(true)
  })

  it('keeps unavailable launchers actionable with an exact native diagnostic', () => {
    const wrapper = render()
    const terminal = wrapper.get('[data-sidebar-row="launcher:terminal"]')

    expect(terminal.attributes('data-launcher-available')).toBe('false')
    expect(terminal.attributes('aria-disabled')).toBe('true')
    expect(terminal.find('button').attributes('aria-disabled')).toBe('true')
    expect(terminal.find('button').attributes('title')).toBe('Terminal — shell unavailable')
    expect(terminal.attributes('title')).toBe('Terminal — shell unavailable')
    expect(terminal.text()).toContain('missing')
  })

  it('makes rename discoverable by double-click, F2, and the actions menu', async () => {
    const wrapper = render()
    const row = wrapper.get('[data-sidebar-row="activity:agent:one"]')

    await row.trigger('dblclick')
    const input = wrapper.get('[data-activity-rename="agent:one"]')
    await input.setValue('API review')
    await input.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('renameActivity').at(-1)).toEqual([
      { id: 'agent:one', title: 'API review' },
    ])

    await row.find('button').trigger('keydown', { key: 'F2' })
    expect(wrapper.get('[data-activity-rename="agent:one"]').exists()).toBe(true)
    await wrapper.get('[data-activity-rename="agent:one"]').trigger('keydown', { key: 'Escape' })

    await row.trigger('contextmenu')
    expect(wrapper.get('[data-activity-menu="agent:one"]').text()).toContain('Rename')
  })

  it('opens row and sort menus from the keyboard with roving focus and Escape restore', async () => {
    const wrapper = render(false, true)
    const rowButton = wrapper.get('[data-sidebar-row="activity:agent:one"]').find('button')

    rowButton.element.focus()
    await rowButton.trigger('keydown', { key: 'F10', shiftKey: true })
    const activityMenu = wrapper.get('[data-activity-menu="agent:one"]')
    expect(document.activeElement.textContent).toContain('Rename')
    await activityMenu.trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement.textContent).toContain('Stop / kill')
    await activityMenu.trigger('keydown', { key: 'Escape' })
    expect(document.activeElement).toBe(
      wrapper.get('[data-activity-menu-button="agent:one"]').element,
    )

    const sortButton = wrapper.get('[data-activity-sort-button]')
    sortButton.element.focus()
    await sortButton.trigger('keydown', { key: 'ArrowDown' })
    const sortMenu = wrapper.get('[data-activity-sort-menu]')
    expect(document.activeElement.textContent).toContain('Manual')
    await sortMenu.trigger('keydown', { key: 'End' })
    expect(document.activeElement.textContent).toContain('Name')
    await sortMenu.trigger('keydown', { key: 'Escape' })
    expect(document.activeElement).toBe(sortButton.element)
    wrapper.unmount()
  })

  it('creates every dynamic Activity type from the compact plus menu without Chat', async () => {
    const wrapper = mount(WorkbenchSidebar, {
      attachTo: document.body,
      props: {
        apps: [
          { id: 'preset:codex', title: 'Codex', icon: 'codex', available: true },
          { id: 'preset:terminal', title: 'Terminal', icon: 'terminal', available: true },
          { id: 'app:ledger', title: 'Ledger', icon: 'apps', available: true },
        ],
        activities,
      },
    })
    const create = wrapper.get('[data-activity-create-button]')

    create.element.focus()
    await create.trigger('keydown', { key: 'ArrowDown' })
    const menu = document.body.querySelector('[data-activity-create-menu]')
    const options = [...menu.querySelectorAll('[data-activity-create-option]')]

    expect(create.attributes('title')).toBe('New Activity')
    expect(create.attributes('aria-expanded')).toBe('true')
    expect(menu.textContent).toContain('Codex')
    expect(menu.textContent).toContain('Terminal')
    expect(menu.textContent).toContain('Ledger')
    expect(menu.textContent).not.toContain('Chat')
    expect(menu.querySelector('[data-activity-create-divider]')).not.toBeNull()
    expect(document.activeElement).toBe(options[0])

    options.find(option => option.textContent.includes('Terminal')).click()
    await nextTick()
    expect(wrapper.emitted('launch').at(-1)).toEqual(['preset:terminal'])
    expect(document.body.querySelector('[data-activity-create-menu]')).toBeNull()
    expect(document.activeElement).toBe(create.element)

    await wrapper.setProps({ collapsed: true })
    expect(wrapper.get('[data-activity-create-button]').attributes('title')).toBe('New Activity')
    wrapper.unmount()
  })

  it('restores focus to the Activity plus button when its menu closes with Escape', async () => {
    const wrapper = mount(WorkbenchSidebar, {
      attachTo: document.body,
      props: {
        apps: [
          { id: 'preset:terminal', title: 'Terminal', icon: 'terminal', available: true },
        ],
      },
    })
    const create = wrapper.get('[data-activity-create-button]')
    create.element.focus()
    await create.trigger('click')
    const menu = document.body.querySelector('[data-activity-create-menu]')

    menu.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    }))
    await nextTick()

    expect(document.body.querySelector('[data-activity-create-menu]')).toBeNull()
    expect(document.activeElement).toBe(create.element)
    wrapper.unmount()
  })

  it('exposes real lifecycle actions and explains why a live run cannot archive', async () => {
    const wrapper = render()

    await wrapper.get('[data-activity-menu-button="agent:one"]').trigger('click')
    const liveMenu = wrapper.get('[data-activity-menu="agent:one"]')
    expect(liveMenu.text()).toContain('Stop / kill')
    const archive = liveMenu.findAll('button').find((button) => button.text().includes('Archive'))
    expect(archive.attributes('disabled')).toBeDefined()
    expect(archive.attributes('title')).toContain('Stop')

    await wrapper.setProps({
      activities: [
        activities[0],
        { ...activities[1], status: 'done' },
      ],
    })
    await wrapper.get('[data-activity-menu-button="terminal:two"]').trigger('click')
    const endedMenu = wrapper.get('[data-activity-menu="terminal:two"]')
    expect(endedMenu.text()).toContain('Delete')
    await endedMenu.findAll('button').find((button) => button.text().includes('Delete')).trigger('click')
    expect(wrapper.emitted('clearActivity').at(-1)).toEqual(['terminal:two'])
  })

  it('supports keyboard manual reorder and explicit useful sort modes', async () => {
    const wrapper = render()
    const rowButton = wrapper.get('[data-sidebar-row="activity:agent:one"]').find('button')

    await rowButton.trigger('keydown', {
      key: 'ArrowDown',
      altKey: true,
      shiftKey: true,
    })
    expect(wrapper.emitted('reorderActivities').at(-1)).toEqual([
      ['terminal:two', 'agent:one'],
    ])

    await wrapper.get('[data-activity-sort-button]').trigger('click')
    const recent = wrapper
      .get('[data-activity-sort-menu]')
      .findAll('button')
      .find((button) => button.text().includes('Most recent'))
    await recent.trigger('click')
    expect(wrapper.emitted('sortActivities').at(-1)).toEqual(['recent'])
  })

  it('commits pointer drag reorder only after crossing the movement threshold', async () => {
    const wrapper = render()
    const first = wrapper.get('[data-sidebar-row="activity:agent:one"]')
    const second = wrapper.get('[data-sidebar-row="activity:terminal:two"]')
    vi.spyOn(first.element, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      height: 36,
    })
    vi.spyOn(second.element, 'getBoundingClientRect').mockReturnValue({
      top: 36,
      height: 36,
    })

    await first.trigger('pointerdown', { button: 0, clientX: 4, clientY: 10 })
    document.dispatchEvent(new PointerEvent('pointermove', {
      clientX: 6,
      clientY: 80,
    }))
    document.dispatchEvent(new PointerEvent('pointerup', {
      clientX: 6,
      clientY: 80,
    }))

    expect(wrapper.emitted('reorderActivities').at(-1)).toEqual([
      ['terminal:two', 'agent:one'],
    ])
  })

  it('uses the Anthropic provider mark and truthful renderer-app lifecycle actions', async () => {
    const wrapper = mount(WorkbenchSidebar, {
      props: {
        apps: [{ id: 'preset:claude', title: 'Claude', icon: 'claude' }],
        activities: [{
          id: 'app:ledger',
          title: 'Ledger',
          kind: 'app',
          status: 'ready',
          retention: 'durable',
          updatedAt: '2026-07-25T10:00:00Z',
          source: { appId: 'ledger' },
          host: { type: 'app', mode: 'embedded' },
        }],
      },
    })

    expect(wrapper.get('[data-sidebar-row="launcher:preset:claude"] svg').attributes('viewBox'))
      .toBe('110 145 292 222')
    await wrapper.get('[data-activity-menu-button="app:ledger"]').trigger('click')
    const menu = wrapper.get('[data-activity-menu="app:ledger"]')
    expect(menu.text()).not.toContain('Stop / kill')
    expect(menu.text()).toContain('Archive')
    expect(menu.text()).toContain('Delete')
    const archive = menu.findAll('button').find((button) => button.text().includes('Archive'))
    expect(archive.attributes('disabled')).toBeUndefined()
    await archive.trigger('click')
    expect(wrapper.emitted('archiveActivity').at(-1)).toEqual(['app:ledger'])
  })
})
