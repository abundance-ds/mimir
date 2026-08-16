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
    accounts: [
      { id: 'work@example.com', label: 'work@example.com', detail: 'Work', state: 'connected', isDefault: true },
    ],
    oauthAvailable: true,
    detail: 'Gmail, Calendar, and Drive are available to agents.',
  },
  {
    provider: 'slack',
    name: 'Slack',
    state: 'needs_sign_in',
    account: 'Pirates',
    accounts: [],
    oauthAvailable: false,
    detail: 'Sign in again to restore Slack access.',
  },
  {
    provider: 'granola',
    name: 'Granola',
    state: 'not_connected',
    account: null,
    accounts: [],
    oauthAvailable: false,
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

  it('adds Google accounts and marks a selected account as default', async () => {
    const google = {
      ...initialConnections[0],
      account: 'work@example.com',
      accounts: [
        { id: 'work@example.com', label: 'work@example.com', state: 'connected', isDefault: true },
        { id: 'me@example.net', label: 'me@example.net', state: 'connected', isDefault: false },
      ],
    }
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === 'connections_status') return Promise.resolve([google, ...initialConnections.slice(1)])
      if (command === 'connections_set_google_default') {
        return Promise.resolve({
          ...google,
          account: 'me@example.net',
          accounts: google.accounts.map(account => ({ ...account, isDefault: account.id === 'me@example.net' })),
        })
      }
      if (command === 'connections_connect_google') return Promise.resolve(google)
      if (command === 'connections_disconnect') return Promise.resolve([google, ...initialConnections.slice(1)])
      return Promise.resolve(undefined)
    })

    const wrapper = mount(ConnectionsSettingsSection)
    await flushPromises()

    expect(wrapper.text()).toContain('2 accounts')
    const googleRow = wrapper.get('[data-connection-provider="google"]')
    await googleRow.get('.connection-main .connection-action').trigger('click')
    expect(invoke).toHaveBeenCalledWith('connections_connect_google')

    const makeDefault = googleRow.findAll('.connection-account-action').find(button => button.text() === 'Make default')
    await makeDefault.trigger('click')
    expect(invoke).toHaveBeenCalledWith('connections_set_google_default', { account: 'me@example.net' })
    const defaultRow = googleRow.findAll('.connection-account-row').find(row => row.text().includes('me@example.net'))
    expect(defaultRow.text()).toContain('Default')

    const removeWork = googleRow.find('[aria-label="Remove work@example.com"]')
    await removeWork.trigger('click')
    expect(invoke).toHaveBeenCalledWith('connections_disconnect', {
      provider: 'google',
      account: 'work@example.com',
    })
  })

  it('accepts an existing Slack personal token', async () => {
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === 'connections_status') return Promise.resolve(initialConnections)
      if (command === 'connections_connect_slack_token') {
        return Promise.resolve({ ...initialConnections[1], state: 'connected', account: 'Pirates · waqr' })
      }
      return Promise.resolve(undefined)
    })
    const wrapper = mount(ConnectionsSettingsSection)
    await flushPromises()

    const slackRow = wrapper.get('[data-connection-provider="slack"]')
    await slackRow.get('.connection-action').trigger('click')
    const input = wrapper.get('#slack-personal-token')
    await input.setValue('xoxp-test-token')
    await input.element.form.dispatchEvent(new Event('submit'))
    await flushPromises()

    expect(invoke).toHaveBeenCalledWith('connections_connect_slack_token', { token: 'xoxp-test-token' })
    expect(wrapper.text()).toContain('Connected as Pirates · waqr')
  })
})
