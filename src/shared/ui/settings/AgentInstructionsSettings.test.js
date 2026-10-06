import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '../../../stores/settings.js'
import { AGENTS_STARTER } from '../../agentInstructions.js'
import AgentInstructionsSettings from './AgentInstructionsSettings.vue'

const wrappers = []
async function render() {
  const settings = useSettingsStore()
  await settings.load()
  settings.set('agentsTemplate', AGENTS_STARTER)
  await settings.flush()
  const wrapper = mount(AgentInstructionsSettings)
  wrappers.push(wrapper)
  return { wrapper, settings }
}

afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
  vi.restoreAllMocks()
})

describe('default project instructions', () => {
  it('saves only on Save and resets the draft without changing the saved template', async () => {
    const { wrapper, settings } = await render()
    const editor = wrapper.get('[data-agents-template]')
    expect(editor.element.value).toBe(AGENTS_STARTER)
    expect(wrapper.get('[data-agents-save]').element.disabled).toBe(true)
    await editor.setValue('# Rules\nUse German.\n')
    expect(settings.agentsTemplate).toBe(AGENTS_STARTER)
    await wrapper.get('[data-agents-save]').trigger('click')
    await flushPromises()
    expect(settings.agentsTemplate).toBe('# Rules\nUse German.\n')
    expect(wrapper.get('[role="status"]').text()).toContain('Template saved')
    await wrapper.get('[data-agents-reset]').trigger('click')
    expect(editor.element.value).toBe(AGENTS_STARTER)
    expect(settings.agentsTemplate).toBe('# Rules\nUse German.\n')
    await wrapper.get('[data-agents-save]').trigger('click')
    await flushPromises()
    expect(settings.agentsTemplate).toBe(AGENTS_STARTER)
  })

  it('copies the current draft and reports clipboard failure', async () => {
    const writeText = vi.fn(async () => {})
    vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({ writeText })
    const { wrapper, settings } = await render()
    await wrapper.get('textarea').setValue('Custom draft')
    await wrapper.get('[data-agents-copy]').trigger('click')
    expect(writeText).toHaveBeenCalledWith('Custom draft')
    expect(settings.agentsTemplate).toBe(AGENTS_STARTER)
    writeText.mockRejectedValueOnce(new Error('Clipboard denied'))
    await wrapper.get('[data-agents-copy]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toBe('Clipboard denied')
  })

  it('keeps failed edits available for retry and rejects blank templates', async () => {
    const { wrapper, settings } = await render()
    await wrapper.get('textarea').setValue('   ')
    expect(wrapper.get('[data-agents-save]').element.disabled).toBe(true)
    await wrapper.get('textarea').setValue('Custom rules')
    vi.spyOn(settings, 'flush').mockResolvedValueOnce(false)
    await wrapper.get('[data-agents-save]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('could not be saved')
    expect(settings.agentsTemplate).toBe(AGENTS_STARTER)
    expect(wrapper.get('textarea').element.value).toBe('Custom rules')
    expect(wrapper.get('[data-agents-save]').element.disabled).toBe(false)
    await wrapper.get('[data-agents-save]').trigger('click')
    await flushPromises()
    expect(settings.agentsTemplate).toBe('Custom rules')
  })

  it('accepts external settings changes without discarding a local draft', async () => {
    const { wrapper, settings } = await render()
    settings.set('agentsTemplate', 'From another window')
    await flushPromises()
    expect(wrapper.get('textarea').element.value).toBe('From another window')
    await wrapper.get('textarea').setValue('My unsaved rules')
    settings.set('agentsTemplate', 'Another update')
    await flushPromises()
    expect(wrapper.get('textarea').element.value).toBe('My unsaved rules')
    await settings.flush()
  })
})
