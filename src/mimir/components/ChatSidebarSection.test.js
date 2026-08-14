import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import ChatSidebarSection from './ChatSidebarSection.vue'

const targets = [
  {
    id: '#general',
    kind: 'channel',
    title: 'general',
    topic: 'Company chat',
    unreadCount: 3,
    muted: false,
  },
  {
    id: '#noise',
    kind: 'channel',
    title: 'noise',
    unreadCount: 8,
    muted: true,
  },
  {
    id: 'anna',
    kind: 'direct',
    title: 'anna',
    unreadCount: 1,
    muted: false,
  },
]

afterEach(() => {
  document.body.innerHTML = ''
})

describe('ChatSidebarSection', () => {
  it('uses one flat channel-and-person list with compact unread dots', async () => {
    const wrapper = mount(ChatSidebarSection, {
      props: {
        targets,
        members: [{ nick: 'anna', account: 'anna', displayName: 'Anna Example' }],
        selectedTarget: '#general',
        active: true,
        unreadTotal: 12,
      },
    })

    expect(wrapper.text()).not.toContain('Channels')
    expect(wrapper.text()).not.toContain('Direct messages')
    expect(wrapper.text()).toContain('Anna Example')
    expect(wrapper.findAll('[data-chat-row]').map(row => row.attributes('data-sidebar-row')))
      .toEqual(['chat:#general', 'chat:#noise', 'chat:anna'])
    expect(wrapper.findAll('[data-chat-unread-dot]')).toHaveLength(3)
    expect(wrapper.get('[data-chat-unread-total]').attributes('aria-label'))
      .toBe('12 unread chat messages')
    expect(wrapper.get('[data-sidebar-row="chat:#general"]').attributes('class')).toContain('bg-accent-soft')
    expect(wrapper.get('[data-sidebar-row="chat:#general"] button').attributes('aria-label'))
      .toBe('general, 3 unread messages')
    expect(wrapper.get('[data-sidebar-row="chat:anna"] button').attributes('aria-label'))
      .toBe('Anna Example, 1 unread message')

    await wrapper.get('[data-sidebar-row="chat:anna"]').trigger('click')
    expect(wrapper.emitted('selectChat')).toEqual([['anna']])
  })

  it('collapses the expanded section with mouse or arrow keys while keeping its unread state', async () => {
    const wrapper = mount(ChatSidebarSection, {
      props: { targets, unreadTotal: 12 },
    })
    const toggle = wrapper.get('[data-chat-section-toggle]')

    expect(toggle.attributes('aria-expanded')).toBe('true')
    await toggle.trigger('click')
    expect(wrapper.emitted('toggleCollapsed')).toHaveLength(1)

    await wrapper.setProps({ sectionCollapsed: true })
    expect(toggle.attributes('aria-expanded')).toBe('false')
    expect(wrapper.find('[data-chat-row]').exists()).toBe(false)
    expect(wrapper.get('[data-chat-unread-total]').exists()).toBe(true)

    await toggle.trigger('keydown', { key: 'ArrowRight' })
    expect(wrapper.emitted('toggleCollapsed')).toHaveLength(2)
    await toggle.trigger('keydown', { key: 'ArrowLeft' })
    expect(wrapper.emitted('toggleCollapsed')).toHaveLength(2)
  })

  it('opens every room from one rail hub and activates the last room', async () => {
    const wrapper = mount(ChatSidebarSection, {
      attachTo: document.body,
      props: {
        targets,
        collapsed: true,
        selectedTarget: '#noise',
        unreadTotal: 104,
      },
    })
    expect(wrapper.findAll('[data-sidebar-row]')).toHaveLength(1)
    expect(wrapper.get('[data-chat-unread-total]').attributes('aria-label'))
      .toBe('104 unread chat messages')

    await wrapper.get('[data-sidebar-row="chat:hub"]').trigger('click')
    const switcher = document.body.querySelector('[data-chat-rail-switcher]')
    expect(wrapper.emitted('selectChat')).toEqual([['#noise', { focus: false }]])
    expect(switcher.querySelectorAll('[data-chat-rail-target]')).toHaveLength(3)
    expect(switcher.querySelector('[data-chat-target="#noise"]').getAttribute('aria-checked'))
      .toBe('true')
    expect(switcher.querySelectorAll('[data-chat-rail-unread]')).toHaveLength(3)
    expect(switcher.querySelector('[data-chat-rail-new]')).not.toBeNull()

    switcher.querySelector('[data-chat-target="anna"]').click()
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('selectChat')).toEqual([
      ['#noise', { focus: false }],
      ['anna'],
    ])
    expect(document.body.querySelector('[data-chat-rail-switcher]')).toBeNull()
    wrapper.unmount()
  })

  it('supports rail switcher arrow keys, Escape, and focus return', async () => {
    const wrapper = mount(ChatSidebarSection, {
      attachTo: document.body,
      props: {
        targets,
        collapsed: true,
        selectedTarget: '#general',
        active: true,
      },
    })
    const hub = wrapper.get('[data-sidebar-row="chat:hub"] button')
    hub.element.getBoundingClientRect = () => ({
      bottom: 232,
      height: 32,
      left: 0,
      right: 52,
      top: 200,
      width: 52,
      x: 0,
      y: 200,
      toJSON() {},
    })
    expect(hub.attributes('aria-expanded')).toBe('false')
    expect(hub.attributes('aria-haspopup')).toBe('menu')
    await hub.trigger('click')

    expect(hub.attributes('aria-expanded')).toBe('true')
    expect(document.body.querySelector('[data-chat-rail-switcher]').style.left).toBe('56px')
    const general = document.body.querySelector('[data-chat-target="#general"]')
    expect(document.activeElement).toBe(general)
    general.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    const noise = document.body.querySelector('[data-chat-target="#noise"]')
    expect(document.activeElement).toBe(noise)
    noise.click()
    expect(wrapper.emitted('selectChat')).toEqual([['#noise']])

    await hub.trigger('click')
    const activeRow = document.body.querySelector('[data-chat-target="#general"]')
    activeRow.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await wrapper.vm.$nextTick()
    expect(document.body.querySelector('[data-chat-rail-switcher]')).toBeNull()
    expect(document.activeElement).toBe(hub.element)
    wrapper.unmount()
  })

  it('offers the new-chat flow when the rail has no rooms', async () => {
    const wrapper = mount(ChatSidebarSection, {
      attachTo: document.body,
      props: { collapsed: true, targets: [] },
    })
    await wrapper.get('[data-sidebar-row="chat:hub"] button').trigger('click')

    expect(wrapper.emitted('selectChat')).toBeUndefined()
    expect(document.body.querySelector('[data-chat-rail-empty]').textContent).toContain('No chats yet')
    const newChat = document.body.querySelector('[data-chat-rail-new]')
    expect(document.activeElement).toBe(newChat)
    newChat.click()
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('newChat')).toHaveLength(1)
    expect(document.body.querySelector('[data-chat-rail-switcher]')).toBeNull()
    wrapper.unmount()
  })

  it('shows no unread dot for zero or negative counts', async () => {
    const wrapper = mount(ChatSidebarSection, {
      props: {
        targets: [
          { id: '#general', kind: 'channel', title: 'general', unreadCount: 0 },
          { id: '#quiet', kind: 'channel', title: 'quiet', unreadCount: -1 },
        ],
        unreadTotal: 0,
      },
    })

    expect(wrapper.find('[data-chat-unread-total]').exists()).toBe(false)
    expect(wrapper.find('[data-chat-unread-dot]').exists()).toBe(false)

    await wrapper.setProps({ collapsed: true, unreadTotal: -3 })
    expect(wrapper.find('[data-chat-unread-total]').exists()).toBe(false)
  })
})
