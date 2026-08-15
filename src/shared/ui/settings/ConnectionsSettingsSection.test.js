import { invoke } from '@tauri-apps/api/core'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ConnectionsSettingsSection from './ConnectionsSettingsSection.vue'

const initialConnections = [
  {
    provider: 'google',
    name: 'Google',
    state: 'connected',
    account: 'work@example.com',
    detail: 'Gmail, Calendar, and Drive are available to agents.',
  },
  {
    provider: 'slack',
    name: 'Slack',
    state: 'needs_sign_in',
    account: 'Pirates',
    detail: 'Sign in again to restore Slack access.',
  },
  {
    provider: 'granola',
    name: 'Granola',
    state: 'not_connected',
    account: null,
    detail: 'Connect to use meeting notes and transcripts.',
  },
]

describe('ConnectionsSettingsSection', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockImplementation(command => {
      if (command === 'connections_status') return Promise.resolve(initialConnections)
      return Promise.resolve(undefined)
    })
  })

  it('shows plain provider states and connected identity', async () => {
    const wrapper = mount(ConnectionsSettingsSection)
    await flushPromises()

    expect(wrapper.text()).toContain('Connected as work@example.com')
    expect(wrapper.text()).toContain('Needs sign-in')
    expect(wrapper.text()).toContain('Not connected')
  })

  it('opens the supported Granola API key journey inline', async () => {
    const wrapper = mount(ConnectionsSettingsSection)
    await flushPromises()

    const row = wrapper.get('[data-connection-provider="granola"]')
    await row.get('button').trigger('click')

    expect(wrapper.get('#granola-api-key').exists()).toBe(true)
    expect(wrapper.text()).toContain('Settings → Connectors → API keys')
  })
})
