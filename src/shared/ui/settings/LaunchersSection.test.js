import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../../services/launchers.js', () => ({
  detectAgents: vi.fn(),
  loadLauncherConfig: vi.fn(),
  saveLauncherConfig: vi.fn(),
}))

import {
  detectAgents,
  loadLauncherConfig,
  saveLauncherConfig,
} from '../../../services/launchers.js'
import LaunchersSection from './LaunchersSection.vue'

describe('Launcher settings', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    detectAgents.mockResolvedValue([
      { id: 'codex', title: 'Codex', installed: true, binaryPath: '/bin/codex' },
    ])
    loadLauncherConfig.mockResolvedValue({
      path: '/home/me/.mim/launchers.json',
      presets: [{
        id: 'terminal',
        title: 'Terminal',
        kind: 'terminal',
        args: [],
        env: {},
        cwd: { mode: 'workspace' },
      }],
      diagnostic: null,
    })
  })

  function render() {
    const pinia = createPinia()
    setActivePinia(pinia)
    return mount(LaunchersSection, { global: { plugins: [pinia] } })
  }

  it('renders one binary override per preset and the real config path', async () => {
    const wrapper = render()
    await flushPromises()

    expect(wrapper.findAll('[data-launcher-preset]')).toHaveLength(1)
    expect(wrapper.findAll('[data-launcher-binary]')).toHaveLength(1)
    expect(wrapper.text()).toContain('/home/me/.mim/launchers.json')
  })

  it('saves flags as exact argv entries and environment as key-value pairs', async () => {
    const wrapper = render()
    await flushPromises()

    await wrapper.get('[data-launcher-args]').setValue('--model\ngpt 5\n"  padded  "\n""')
    await wrapper.get('[data-launcher-env]').setValue('MIM_MODE=fast\nLABEL= hello world ')
    await wrapper.get('[data-launcher-save]').trigger('click')
    await flushPromises()

    expect(saveLauncherConfig).toHaveBeenCalledWith([{
      id: 'terminal',
      title: 'Terminal',
      kind: 'terminal',
      args: ['--model', 'gpt 5', '  padded  ', ''],
      env: { MIM_MODE: 'fast', LABEL: ' hello world ' },
      cwd: { mode: 'workspace' },
    }])
    expect(wrapper.text()).toContain('Launcher file saved')
  })

  it('keeps invalid drafts local and shows a precise validation error', async () => {
    const wrapper = render()
    await flushPromises()

    const id = wrapper.get('input.font-mono')
    await id.setValue('Not Valid')
    await wrapper.get('[data-launcher-args]').setValue('--flag')
    await wrapper.get('[data-launcher-save]').trigger('click')

    expect(saveLauncherConfig).not.toHaveBeenCalled()
    expect(wrapper.get('[role="alert"]').text()).toContain('lowercase letters')
  })
})
