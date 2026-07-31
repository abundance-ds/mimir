import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ScribeSettings from './ScribeSettings.vue'

const config = {
  detectionEnabled: false,
  transcriptionMode: 'local',
  customUrl: '',
  customModel: '',
  localModel: 'whisper-small',
  summaryEnabled: true,
  kgPrompt: 'ask',
  retentionDays: 30,
}

describe('ScribeSettings', () => {
  it('makes every config mutation visibly unavailable during an ordered save', () => {
    const wrapper = mount(ScribeSettings, {
      props: {
        embedded: true,
        config: { ...config, transcriptionMode: 'custom' },
        permissions: { microphone: 'granted', systemAudio: 'granted' },
        pending: { config: true },
      },
    })

    expect(wrapper.get('[data-scribe-config-pending]').text()).toContain('Saving settings')
    expect(wrapper.get('[data-scribe-detection]').attributes('disabled')).toBeDefined()
    expect(wrapper.findAll('[role="radio"]').every(
      control => control.attributes('disabled') !== undefined,
    )).toBe(true)
    expect(wrapper.findAll('[role="combobox"]').every(
      control => control.attributes('disabled') !== undefined,
    )).toBe(true)
    expect(wrapper.get('input[type="url"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('input[placeholder="Provider model name"]').attributes('disabled'))
      .toBeDefined()
    expect(wrapper.get('[data-scribe-summary-enabled]').attributes('disabled')).toBeDefined()
  })
})
