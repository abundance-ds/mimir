import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import UpdatesSection from './UpdatesSection.vue'
import { UPDATE_PHASE, useAppUpdateStore } from '../../../stores/appUpdate.js'

describe('UpdatesSection', () => {
  it('uses the version handoff as the stable update action', async () => {
    const updates = useAppUpdateStore()
    updates.currentVersion = '0.2.0'
    updates.updateVersion = '0.2.1'
    updates.phase = UPDATE_PHASE.AVAILABLE
    updates.installUpdate = vi.fn()

    const wrapper = mount(UpdatesSection)

    expect(wrapper.text()).toContain('v0.2.0 → v0.2.1')
    expect(wrapper.text()).toContain('v0.2.1 is ready to download.')
    await wrapper.get('button').trigger('click')
    expect(updates.installUpdate).toHaveBeenCalledTimes(1)
  })

  it('shows a restart action after a successful install', () => {
    const updates = useAppUpdateStore()
    updates.currentVersion = '0.2.0'
    updates.updateVersion = '0.2.1'
    updates.phase = UPDATE_PHASE.READY

    const wrapper = mount(UpdatesSection)

    expect(wrapper.text()).toContain('v0.2.1 is installed and ready.')
    expect(wrapper.get('button').text()).toContain('Restart Mimir')
  })

  it('shows useful failure text and optional technical detail', () => {
    const updates = useAppUpdateStore()
    updates.phase = UPDATE_PHASE.ERROR
    updates.errorMessage = 'Could not install the update.'
    updates.errorDetail = 'network timeout'

    const wrapper = mount(UpdatesSection)

    expect(wrapper.text()).toContain('Could not install the update.')
    expect(wrapper.text()).toContain('Technical details')
    expect(wrapper.text()).toContain('network timeout')
  })
})
