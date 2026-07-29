import { nextTick } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { useChatStore } from '../../stores/chat.js'
import ChatPaneActions from './ChatPaneActions.vue'

describe('ChatPaneActions', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(invoke).mockClear()
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'chat_members') {
        return [
          { nick: 'waqr', account: 'waqr', displayName: 'Waqr', away: false },
          {
            nick: 'anna',
            account: 'anna',
            displayName: 'Anna Example',
            away: true,
            awayMessage: 'User is currently disconnected',
          },
        ]
      }
      if (command === 'chat_targets') {
        return [{
          id: '#general',
          kind: 'channel',
          title: 'general',
          topic: 'Daily company work',
          memberCount: 2,
          unreadCount: 0,
          muted: false,
        }]
      }
      return undefined
    })
  })

  it('keeps useful channel details and topic editing in the existing pane header', async () => {
    const chat = useChatStore()
    chat.activeTarget = '#general'
    chat.targets = [{
      id: '#general',
      kind: 'channel',
      title: 'general',
      topic: 'Daily company work',
      memberCount: 2,
      unreadCount: 0,
      muted: false,
    }]
    const wrapper = mount(ChatPaneActions, { props: { agents: [] } })

    await wrapper.get('[data-chat-action="details"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-chat-details-menu]').attributes('role')).toBe('dialog')
    expect(wrapper.text()).toContain('Daily company work')
    expect(wrapper.text()).toContain('Anna Example')
    expect(wrapper.text()).toContain('away')

    const edit = wrapper.findAll('[role="menuitem"]')
      .find(button => button.text().includes('Edit topic'))
    await edit.trigger('click')
    await nextTick()
    await wrapper.get('#chat-topic').setValue('Decisions and daily coordination')
    await wrapper.get('#chat-topic').element.form.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    )
    await flushPromises()

    expect(invoke).toHaveBeenCalledWith('chat_set_topic', {
      target: '#general',
      topic: 'Decisions and daily coordination',
    })
  })

  it('allows leaving an ordinary channel but keeps #general durable', async () => {
    const chat = useChatStore()
    chat.activeTarget = '#project'
    chat.targets = [{
      id: '#project',
      kind: 'channel',
      title: 'project',
      topic: '',
      memberCount: 2,
      unreadCount: 0,
      muted: false,
    }]
    const wrapper = mount(ChatPaneActions, { props: { agents: [] } })

    await wrapper.get('[data-chat-action="details"]').trigger('click')
    const leave = wrapper.findAll('[role="menuitem"]')
      .find(button => button.text().includes('Leave channel'))
    expect(leave).toBeTruthy()
    await leave.trigger('click')
    await flushPromises()

    expect(invoke).toHaveBeenCalledWith('chat_leave', { target: '#project' })

    chat.activeTarget = '#general'
    chat.targets = [{
      id: '#general',
      kind: 'channel',
      title: 'general',
      topic: '',
      memberCount: 2,
      unreadCount: 0,
      muted: false,
    }]
    await wrapper.get('[data-chat-action="details"]').trigger('click')
    expect(wrapper.findAll('[role="menuitem"]')
      .some(button => button.text().includes('Leave channel'))).toBe(false)
  })
})
