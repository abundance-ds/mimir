import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { open } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import { useSettingsStore } from '../../../stores/settings.js'
import GraphSettingsSection from './GraphSettingsSection.vue'

describe('graph settings', () => {
  beforeEach(() => {
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
    expect(wrapper.text()).toContain('Project')
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
})
