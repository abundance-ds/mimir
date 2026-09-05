import { nextTick } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import ChatSettingsSection from './ChatSettingsSection.vue'
import { useChatStore } from '../../../stores/chat.js'

describe('ChatSettingsSection', () => {
  beforeEach(() => {
    const pinia = createPinia()
    setActivePinia(pinia)
    vi.mocked(invoke).mockReset()
    vi.mocked(invoke).mockImplementation(command => {
      if (command === 'chat_set_enabled') {
        return Promise.resolve({
          state: 'disconnected',
          endpoint: 'wss://chat.abundanceds.com/webirc',
          account: 'waqr',
          relayReady: false,
          diagnostic: null,
        })
      }
      return Promise.resolve()
    })
  })

  it('keeps the re-enable control visible while hiding Chat settings', async () => {
    const chat = useChatStore()
    chat.initialized = true
    chat.config = {
      enabled: true,
      endpoint: 'wss://chat.abundanceds.com/webirc',
      account: 'waqr',
      displayName: 'Waqr',
    }
    chat.status = {
      state: 'connected',
      endpoint: chat.config.endpoint,
      account: chat.config.account,
      relayReady: true,
      diagnostic: null,
    }

    const wrapper = mount(ChatSettingsSection)
    await wrapper.get('[data-chat-enabled-toggle]').trigger('click')
    await flushPromises()
    await nextTick()

    expect(invoke).toHaveBeenCalledWith('chat_set_enabled', { enabled: false })
    expect(wrapper.get('[data-chat-enabled-toggle]').text()).toBe('Off')
    expect(wrapper.find('form').exists()).toBe(false)
    expect(wrapper.text()).toContain('Cached history remains on this Mac.')
  })
})
