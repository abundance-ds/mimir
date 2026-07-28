import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { open } from '@tauri-apps/plugin-dialog'
import { useSettingsStore } from '../../../stores/settings.js'
import GraphSettingsSection from './GraphSettingsSection.vue'

describe('graph settings', () => {
  beforeEach(() => {
    vi.mocked(open).mockReset()
    setActivePinia(createPinia())
  })

  it('explains the three physical scopes and stores one optional team folder', async () => {
    vi.mocked(open).mockResolvedValue('/shared/mimir-team-graph')
    const wrapper = mount(GraphSettingsSection)
    await flushPromises()

    expect(wrapper.text()).toContain('Private')
    expect(wrapper.text()).toContain('Project')
    expect(wrapper.text()).toContain('Team')

    await wrapper.get('[data-graph-team-choose]').trigger('click')
    await flushPromises()
    expect(useSettingsStore().mimirTeamGraphFolder).toBe('/shared/mimir-team-graph')
    expect(wrapper.get('[role="status"]').text()).toContain('compose it automatically')

    await wrapper.get('[data-graph-team-clear]').trigger('click')
    expect(useSettingsStore().mimirTeamGraphFolder).toBe('')
  })
})
