import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { open } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import { useSettingsStore } from '../../../stores/settings.js'
import GraphSettingsSection from './GraphSettingsSection.vue'

describe('graph settings', () => {
  beforeEach(() => {
    const storage = new Map()
    vi.stubGlobal('localStorage', {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key),
    })
    vi.mocked(open).mockReset()
    vi.mocked(invoke).mockReset().mockResolvedValue([
      { scope: 'private', root: '/home/me/.mimir/private', mounted: true, components: ['graph', 'skills'] },
      { scope: 'project', root: '/work', mounted: true, components: ['graph', 'agents'] },
      { scope: 'team', root: '', mounted: false, components: [] },
    ])
    setActivePinia(createPinia())
  })

  it('explains the three physical scopes and stores one optional team folder', async () => {
    vi.mocked(open).mockResolvedValue('/shared/mimir-team-graph')
    const wrapper = mount(GraphSettingsSection)
    await flushPromises()

    expect(wrapper.text()).toContain('Private')
    expect(wrapper.text()).toContain('Workspace')
    expect(wrapper.text()).toContain('Team')
    expect(wrapper.text()).toContain('graph · skills')
    expect(wrapper.text()).toContain('graph · agents')
    expect(wrapper.text()).toContain('not mounted')

    await wrapper.get('[data-graph-team-choose]').trigger('click')
    await flushPromises()
    expect(useSettingsStore().mimirTeamFolder).toBe('/shared/mimir-team-graph')
    expect(wrapper.get('[role="status"]').text()).toContain('compose automatically')

    await wrapper.get('[data-graph-team-clear]').trigger('click')
    expect(useSettingsStore().mimirTeamFolder).toBe('')
  })

  it('edits the rare workspace link in Graph settings', async () => {
    const settings = useSettingsStore()
    settings.set('mimirTeamFolder', '/team')
    settings.set('mimirWorkspaceFolder', '/work')
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'scope_inventory') return []
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
})
