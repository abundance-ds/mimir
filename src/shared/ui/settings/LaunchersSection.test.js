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

const terminalPreset = {
  id: 'terminal',
  title: 'Terminal',
  kind: 'terminal',
  enabled: true,
  args: [],
  env: {},
  cwd: { mode: 'workspace' },
}

describe('CLI tool settings', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    detectAgents.mockResolvedValue([
      {
        id: 'codex',
        title: 'Codex',
        installed: true,
        binaryPath: '/bin/codex',
        version: '0.145.0',
      },
      {
        id: 'claude',
        title: 'Claude',
        installed: false,
        binaryPath: null,
      },
      {
        id: 'pi',
        title: 'Pi',
        installed: true,
        binaryPath: '/bin/pi',
      },
    ])
    loadLauncherConfig.mockResolvedValue({
      path: '/home/me/.mim/launchers.json',
      presets: [{
        id: 'codex',
        title: 'Codex',
        kind: 'agent',
        agentId: 'codex',
        enabled: true,
        args: ['--full-auto'],
        env: {},
        cwd: { mode: 'workspace' },
      }, terminalPreset],
      diagnostic: null,
    })
  })

  function render(attach = false) {
    const pinia = createPinia()
    setActivePinia(pinia)
    return mount(LaunchersSection, {
      ...(attach ? { attachTo: document.body } : {}),
      global: { plugins: [pinia] },
    })
  }

  async function customise(wrapper, id) {
    await wrapper.get(`[data-launcher-customize="${id}"]`).trigger('click')
  }

  async function openAdvanced(wrapper, id) {
    await wrapper.get(`[data-launcher-advanced="${id}"]`).trigger('click')
  }

  it('uses compact detected-agent rows and no native selector maze', async () => {
    const wrapper = render()
    await flushPromises()

    expect(wrapper.findAll('[data-launcher-preset]')).toHaveLength(2)
    expect(wrapper.text()).toContain('/bin/codex')
    expect(wrapper.text()).toContain('0.145.0')
    expect(wrapper.text()).toContain('/home/me/.mim/launchers.json')
    expect(wrapper.find('select').exists()).toBe(false)
    expect(wrapper.find('[data-launcher-args]').exists()).toBe(false)

    await customise(wrapper, 'codex')
    expect(wrapper.get('[data-launcher-args]').element.value).toBe('--full-auto')
    expect(wrapper.find('[data-launcher-binary]').exists()).toBe(false)
    await openAdvanced(wrapper, 'codex')
    expect(wrapper.get('[data-launcher-binary]').attributes('placeholder')).toContain('detected')
  })

  it('saves familiar quoted CLI flags as exact argv plus advanced environment', async () => {
    const wrapper = render()
    await flushPromises()
    await customise(wrapper, 'terminal')
    await wrapper.get('[data-launcher-args]').setValue('--model "gpt 5" --label=hello\\ world \'\'')
    await openAdvanced(wrapper, 'terminal')
    await wrapper.get('[data-launcher-env]').setValue('MIM_MODE=fast\nLABEL= hello world ')
    await wrapper.get('[data-launcher-save]').trigger('click')
    await flushPromises()

    expect(saveLauncherConfig).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'codex',
        enabled: true,
        args: ['--full-auto'],
      }),
      {
        id: 'terminal',
        title: 'Terminal',
        kind: 'terminal',
        enabled: true,
        args: ['--model', 'gpt 5', '--label=hello world', ''],
        env: { MIM_MODE: 'fast', LABEL: ' hello world ' },
        cwd: { mode: 'workspace' },
      },
    ])
    expect(wrapper.text()).toContain('CLI presets saved')
  })

  it('keeps invalid advanced edits local and reports the precise error', async () => {
    const wrapper = render()
    await flushPromises()
    await customise(wrapper, 'terminal')
    await openAdvanced(wrapper, 'terminal')
    await wrapper.get('[data-launcher-id]').setValue('Not Valid')
    await wrapper.get('[data-launcher-save]').trigger('click')

    expect(saveLauncherConfig).not.toHaveBeenCalled()
    expect(wrapper.get('[role="alert"]').text()).toContain('lowercase letters')
  })

  it('toggles sidebar visibility and adds a specific agent without kind dropdowns', async () => {
    const wrapper = render()
    await flushPromises()

    await wrapper.get('[data-launcher-enabled="codex"]').trigger('click')
    await wrapper.get('[data-launcher-add]').trigger('click')
    const claude = wrapper.get('[data-launcher-add-menu]')
      .findAll('[data-launcher-add-option]')
      .find(option => option.text().includes('Claude'))
    await claude.trigger('click')
    await wrapper.get('[data-launcher-save]').trigger('click')
    await flushPromises()

    expect(saveLauncherConfig).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ id: 'codex', enabled: false }),
      expect.objectContaining({
        id: 'claude',
        title: 'Claude',
        kind: 'agent',
        agentId: 'claude',
        enabled: true,
      }),
    ]))
    expect(wrapper.find('select').exists()).toBe(false)
  })

  it('opens the add menu from the keyboard and restores focus on Escape', async () => {
    const wrapper = render(true)
    await flushPromises()
    const add = wrapper.get('[data-launcher-add]')
    add.element.focus()
    await add.trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement).toBe(
      wrapper.get('[data-launcher-add-menu] [data-launcher-add-option]').element,
    )
    await wrapper.get('[data-launcher-add-menu]').trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('[data-launcher-add-menu]').exists()).toBe(false)
    expect(document.activeElement).toBe(add.element)
    wrapper.unmount()
  })
})
