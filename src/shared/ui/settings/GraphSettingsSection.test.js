import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { invoke } from '@tauri-apps/api/core'
import { useSettingsStore } from '../../../stores/settings.js'
import { openExternalUrl } from '../../../services/externalLinks.js'
import GraphSettingsSection from './GraphSettingsSection.vue'

vi.mock('../../../services/externalLinks.js', () => ({
  openExternalUrl: vi.fn(),
}))

describe('graph settings', () => {
  beforeEach(() => {
    vi.mocked(openExternalUrl).mockReset().mockResolvedValue(undefined)
    const storage = new Map()
    vi.stubGlobal('localStorage', {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key),
    })
    vi.mocked(invoke).mockReset().mockImplementation(async (command) => {
      if (command === 'scope_inventory') return [
        { scope: 'private', root: '/home/me/.mimir/private', mounted: true, components: ['graph', 'skills'] },
        { scope: 'project', root: '/work', mounted: true, components: ['graph', 'agents'] },
        { scope: 'team', root: '', mounted: false, components: [] },
      ]
      if (command === 'team_repository_status') {
        return { managed: false, root: '/home/me/.mimir/team-graph', state: 'notConfigured' }
      }
      if (command === 'github_connection_status') {
        return { connected: true, gitAvailable: true, cliAvailable: true, login: 'waqr' }
      }
      if (command === 'team_repository_setup') {
        return {
          managed: true,
          root: '/home/me/.mimir/team-graph',
          remoteUrl: 'https://github.com/health-economics/team-graph.git',
          state: 'synced',
        }
      }
      return null
    })
    setActivePinia(createPinia())
  })

  it('sets up the managed Team checkout from GitHub without asking for a folder', async () => {
    const wrapper = mount(GraphSettingsSection)
    await flushPromises()

    expect(wrapper.text()).toContain('Private')
    expect(wrapper.text()).toContain('Workspace')
    expect(wrapper.text()).toContain('Team')
    expect(wrapper.text()).toContain('graph · skills')
    expect(wrapper.text()).toContain('graph · agents')
    expect(wrapper.text()).toContain('not mounted')

    await wrapper.get('[data-graph-team-connect]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('choose the owner and visibility')
    await wrapper.get('[data-graph-team-create-on-github]').trigger('click')
    expect(openExternalUrl).toHaveBeenCalledWith('https://github.com/new')
    await wrapper.get('[data-graph-team-repository]')
      .setValue('https://github.com/health-economics/team-graph.git')
    await wrapper.get('[data-graph-team-use-repository]').trigger('click')
    await flushPromises()
    expect(useSettingsStore().mimirTeamFolder).toBeUndefined()
    expect(invoke).toHaveBeenCalledWith('team_repository_setup', {
      remoteUrl: 'https://github.com/health-economics/team-graph.git',
      teamName: null,
    })
    expect(wrapper.get('[role="status"]').text()).toContain('Team is ready')
    expect(wrapper.find('[data-graph-team-root]').exists()).toBe(false)
  })

  it('edits the rare workspace link in Graph settings', async () => {
    const settings = useSettingsStore()
    settings.set('mimirWorkspaceFolder', '/work')
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'scope_inventory') return []
      if (command === 'team_repository_status') {
        return { managed: true, root: '/home/me/.mimir/team-graph', state: 'synced' }
      }
      if (command === 'github_connection_status') {
        return { connected: true, gitAvailable: true, cliAvailable: true, login: 'waqr' }
      }
      if (command === 'managed_project_status') return { managed: false, state: 'notRepository' }
      if (command === 'workspace_config_load') {
        return { version: 1, id: 'ws-work', project: 'project-alpha', graphScope: 'team' }
      }
      if (command === 'graph_query') {
        return { items: [
          { id: 'project-zeta', kind: 'project', title: 'Zeta', status: 'active' },
          { id: 'project-alpha', kind: 'project', title: 'Alpha', status: 'planned' },
        ] }
      }
      if (command === 'workspace_config_save') {
        return { version: 1, id: 'ws-work', project: 'project-alpha', graphScope: 'workspace' }
      }
      return null
    })

    const wrapper = mount(GraphSettingsSection)
    await flushPromises()

    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'workspace_config_load'))
      .toHaveLength(1)
    expect(wrapper.get('[data-current-workspace-project]').text()).toContain('Alpha')
    await wrapper.get('[data-current-workspace-project]').trigger('click')
    await flushPromises()
    const options = [...document.querySelectorAll('[data-graph-select-option]')]
    expect(options.map(option => option.dataset.graphSelectOption)).toEqual([
      '',
      '__new_project__',
      'project-alpha',
      'project-zeta',
    ])
    expect(document.querySelector('[role="separator"]')
      .previousElementSibling.dataset.graphSelectOption).toBe('__new_project__')
    expect(document.querySelectorAll('.graph-select-option-hint')).toHaveLength(0)
    await wrapper.get('[data-current-workspace-project]').trigger('click')
    await wrapper.get('[data-current-workspace-scope="workspace"]').trigger('click')
    await wrapper.get('[data-current-workspace-save]').trigger('click')
    await flushPromises()

    expect(invoke).toHaveBeenCalledWith('workspace_config_save', expect.objectContaining({
      workspace: '/work',
      config: expect.objectContaining({ project: 'project-alpha', graphScope: 'workspace' }),
    }))
    expect(wrapper.text()).toContain('Workspace settings saved.')
  })

  it('uses GitHub CLI sign-in when Team setup needs a login', async () => {
    vi.mocked(invoke).mockImplementation(async command => {
      if (command === 'team_repository_status') return { managed: false, state: 'notConfigured' }
      if (command === 'github_connection_status') {
        return { connected: false, gitAvailable: true, cliAvailable: true }
      }
      if (command === 'github_connect') {
        return { connected: true, gitAvailable: true, cliAvailable: true, login: 'waqr' }
      }
      if (command === 'scope_inventory') return []
      return null
    })
    const wrapper = mount(GraphSettingsSection)
    await flushPromises()

    await wrapper.get('[data-graph-team-connect]').trigger('click')
    await flushPromises()

    expect(invoke).toHaveBeenCalledWith('github_connect')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.get('[data-graph-team-create-on-github]').exists()).toBe(true)
  })

  it('moves Team to an empty organization repository and keeps the old remote', async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'scope_inventory') return []
      if (command === 'team_repository_status') {
        return {
          managed: true,
          root: '/home/me/.mimir/team-graph',
          remoteUrl: 'https://github.com/waqr/team-graph.git',
          state: 'synced',
        }
      }
      if (command === 'github_connection_status') {
        return { connected: true, gitAvailable: true, cliAvailable: true, login: 'waqr' }
      }
      if (command === 'team_repository_move') {
        return {
          managed: true,
          root: '/home/me/.mimir/team-graph',
          remoteUrl: 'https://github.com/outcome-lab/team-graph.git',
          state: 'synced',
        }
      }
      return null
    })
    const wrapper = mount(GraphSettingsSection)
    await flushPromises()

    await wrapper.get('[data-graph-team-change-repository]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('remains on GitHub as a backup')
    await wrapper.get('[data-graph-team-move-repository]')
      .setValue('https://github.com/outcome-lab/team-graph.git')
    await wrapper.get('[data-graph-team-move]').trigger('click')
    await flushPromises()

    expect(invoke).toHaveBeenCalledWith('team_repository_move', {
      remoteUrl: 'https://github.com/outcome-lab/team-graph.git',
    })
    expect(wrapper.text()).toContain('Team now uses outcome-lab/team-graph')
  })

  it('connects a Project from a pasted empty GitHub repository URL', async () => {
    useSettingsStore().set('mimirWorkspaceFolder', '/work')
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'scope_inventory') return []
      if (command === 'team_repository_status') {
        return {
          managed: true,
          root: '/home/me/.mimir/team-graph',
          remoteUrl: 'https://github.com/acme/team-graph.git',
          state: 'synced',
        }
      }
      if (command === 'github_connection_status') {
        return { connected: true, gitAvailable: true, cliAvailable: true, login: 'waqr' }
      }
      if (command === 'managed_project_status') return { managed: false, state: 'manual' }
      if (command === 'workspace_config_load') return { version: 1, id: 'ws-work', graphScope: 'team' }
      if (command === 'graph_query') return { items: [] }
      if (command === 'managed_project_set_remote') return { managed: false, state: 'manual' }
      if (command === 'managed_project_set_enabled') {
        return { managed: true, state: 'synced', remoteUrl: 'https://github.com/acme/project.git' }
      }
      if (command === 'managed_project_sync') return { managed: true, state: 'synced' }
      return null
    })
    const wrapper = mount(GraphSettingsSection)
    await flushPromises()

    await wrapper.get('[data-current-workspace-create-on-github]').trigger('click')
    expect(openExternalUrl).toHaveBeenCalledWith('https://github.com/new')
    await wrapper.get('[data-current-workspace-repository]')
      .setValue('https://github.com/acme/project.git')
    await wrapper.get('[data-current-workspace-use-repository]').trigger('click')
    await flushPromises()

    expect(invoke).toHaveBeenCalledWith('managed_project_set_remote', {
      workspace: '/work',
      remoteUrl: 'https://github.com/acme/project.git',
    })
  })

  it('keeps a non-GitHub Project repository manual', async () => {
    useSettingsStore().set('mimirWorkspaceFolder', '/work')
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'scope_inventory') return []
      if (command === 'team_repository_status') {
        return { managed: true, root: '/home/me/.mimir/team-graph', state: 'synced' }
      }
      if (command === 'github_connection_status') {
        return { connected: true, gitAvailable: true, cliAvailable: true, login: 'waqr' }
      }
      if (command === 'managed_project_status') {
        return {
          managed: false,
          state: 'manual',
          remoteUrl: 'https://gitlab.com/acme/project.git',
        }
      }
      if (command === 'workspace_config_load') return { version: 1, id: 'ws-work', graphScope: 'team' }
      if (command === 'graph_query') return { items: [] }
      return null
    })

    const wrapper = mount(GraphSettingsSection)
    await flushPromises()

    const projectRow = wrapper.get('[data-current-workspace-git]')
    expect(projectRow.text()).toContain('manual')
    expect(projectRow.text()).not.toContain('automatic')
    expect(wrapper.find('[data-current-workspace-repository]').exists()).toBe(false)
  })
})
