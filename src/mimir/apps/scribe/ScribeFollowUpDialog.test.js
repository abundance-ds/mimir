import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ScribeFollowUpDialog from './ScribeFollowUpDialog.vue'

const formats = [
  { value: 'standard', label: 'Standard' },
  { value: 'brief', label: 'Brief' },
]
const agents = [
  { value: '', label: 'Automatic · first available' },
  { value: 'codex', label: 'Codex' },
]

function mountDialog(props = {}) {
  return mount(ScribeFollowUpDialog, {
    props: {
      open: true,
      format: 'standard',
      formats,
      agent: '',
      agents,
      prompt: 'Use BLUF.',
      actionLabel: 'Regenerate',
      ...props,
    },
    global: { stubs: { Teleport: true } },
  })
}

describe('ScribeFollowUpDialog', () => {
  it('keeps summary format and agent visible while the prompt stays optional', async () => {
    const wrapper = mountDialog()

    expect(wrapper.get('[role="dialog"]').text()).toContain('Regenerate summary')
    expect(wrapper.get('[aria-label="Summary format"]').text()).toContain('Standard')
    expect(wrapper.get('[aria-label="Summary agent"]').text()).toContain('Automatic')
    expect(wrapper.find('[data-scribe-summary-prompt]').exists()).toBe(false)

    await wrapper.get('[data-scribe-prompt-toggle]').trigger('click')
    const prompt = wrapper.get('[data-scribe-summary-prompt]')
    expect(prompt.attributes('rows')).toBe('9')
    expect(prompt.element.value).toBe('Use BLUF.')
    await prompt.setValue('Use the short format.')
    expect(wrapper.emitted('update:prompt')).toEqual([['Use the short format.']])
  })

  it('uses a separate Ask agent dialog and blocks launch without an agent', () => {
    const wrapper = mountDialog({
      mode: 'agent',
      agents: [{ value: '', label: 'Automatic · first available' }],
      agentAvailable: false,
      actionLabel: 'Open Activity',
    })

    expect(wrapper.get('[role="dialog"]').text()).toContain('Ask agent')
    expect(wrapper.find('[aria-label="Summary format"]').exists()).toBe(false)
    expect(wrapper.get('[aria-label="Custom task agent"]').exists()).toBe(true)
    expect(wrapper.get('[data-scribe-custom-task-prompt]').attributes('rows')).toBe('4')
    expect(wrapper.get('[data-scribe-follow-up-submit]').attributes('disabled')).toBeDefined()
  })
})
