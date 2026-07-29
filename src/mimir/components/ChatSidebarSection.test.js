import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
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

  it('collapses the whole sidebar to one chat hub instead of a rail full of rooms', () => {
    const wrapper = mount(ChatSidebarSection, {
      props: { targets, collapsed: true, unreadTotal: 104 },
    })
    expect(wrapper.findAll('[data-sidebar-row]')).toHaveLength(1)
    expect(wrapper.get('[data-chat-unread-total]').attributes('aria-label'))
      .toBe('104 unread chat messages')
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
