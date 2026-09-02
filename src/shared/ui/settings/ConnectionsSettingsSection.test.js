import { invoke } from '@tauri-apps/api/core'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openExternalUrl } from '../../../services/externalLinks.js'
import ConnectionsSettingsSection from './ConnectionsSettingsSection.vue'

vi.mock('../../../services/externalLinks.js', () => ({
  openExternalUrl: vi.fn(),
}))

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
      if (command === 'github_connection_status') {
        return Promise.resolve({ connected: false, gitAvailable: true, cliAvailable: true })
      }
      return Promise.resolve(undefined)
    })
  })

  it('shows plain provider states and connected identity', async () => {
    const wrapper = mount(ConnectionsSettingsSection)
    await flushPromises()

    expect(wrapper.text()).toContain('Connected as work@example.com')
    expect(wrapper.text()).toContain('Needs sign-in')
    expect(wrapper.text()).toContain('Not connected')
    expect(wrapper.get('[data-connection-provider="github"]').text()).toContain('existing GitHub CLI setup')
  })

  it('uses and explicitly manages the shared GitHub CLI login', async () => {
    vi.mocked(invoke).mockImplementation(command => {
      if (command === 'connections_status') return Promise.resolve(initialConnections)
      if (command === 'github_connection_status') {
        return Promise.resolve({ connected: false, gitAvailable: true, cliAvailable: true })
      }
      if (command === 'github_connect') {
        return Promise.resolve({ connected: true, gitAvailable: true, cliAvailable: true, login: 'waqr' })
      }
      if (command === 'github_disconnect') {
        return Promise.resolve({ connected: false, gitAvailable: true, cliAvailable: true })
      }
      return Promise.resolve(undefined)
    })
    const wrapper = mount(ConnectionsSettingsSection)
    await flushPromises()

    const github = wrapper.get('[data-connection-provider="github"]')
    await github.get('.connection-action').trigger('click')
    await flushPromises()
    expect(invoke).toHaveBeenCalledWith('github_connect')
    expect(github.text()).toContain('Connected as waqr')
    expect(github.text()).toContain('Managed by GitHub CLI')
    expect(github.get('.connection-action').text()).toBe('Manage')
    expect(wrapper.get('[role="status"]').text()).toContain('GitHub is ready')

    await github.get('.connection-action').trigger('click')
    expect(github.text()).toContain('Mimir has no separate GitHub login')
    await github.get('[data-github-sign-out]').trigger('click')
    expect(github.text()).toContain('Terminal, and other tools')
    expect(invoke).not.toHaveBeenCalledWith('github_disconnect')
    await github.get('[data-github-confirm-sign-out]').trigger('click')
    await flushPromises()
    expect(invoke).toHaveBeenCalledWith('github_disconnect')
    expect(github.text()).toContain('Not connected')
    expect(wrapper.get('[role="status"]').text()).toContain('Local files are unchanged')
  })

  it('points to GitHub CLI when the local tool is missing', async () => {
    vi.mocked(invoke).mockImplementation(command => {
      if (command === 'connections_status') return Promise.resolve(initialConnections)
      if (command === 'github_connection_status') {
        return Promise.resolve({ connected: false, gitAvailable: true, cliAvailable: false })
      }
      return Promise.resolve(undefined)
    })
    const wrapper = mount(ConnectionsSettingsSection)
    await flushPromises()

    const github = wrapper.get('[data-connection-provider="github"]')
    expect(github.text()).toContain('GitHub CLI is not installed')
    expect(github.get('.connection-action').text()).toBe('Install GitHub CLI')
    expect(github.text()).not.toContain('.env')
    await github.get('.connection-action').trigger('click')
    expect(openExternalUrl).toHaveBeenCalledWith('https://cli.github.com/')
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
    expect(wrapper.find('[data-connection-provider="github"]').exists()).toBe(true)
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
