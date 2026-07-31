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
    expect(wrapper.get('input[placeholder="gpt-live-transcribe"]').attributes('disabled'))
      .toBeDefined()
    expect(wrapper.get('[data-scribe-summary-enabled]').attributes('disabled')).toBeDefined()
  })

  it('selects OpenAI with a valid endpoint and model in one mutation', async () => {
    const wrapper = mount(ScribeSettings, {
      props: {
        embedded: true,
        config,
        permissions: { microphone: 'granted', systemAudio: 'prompt-on-start' },
      },
    })

    await wrapper.get('[data-scribe-openai-mode]').trigger('click')

    expect(wrapper.emitted('save')).toEqual([[
      {
        transcriptionMode: 'custom',
        customUrl: 'https://api.openai.com/v1/realtime',
        customModel: 'gpt-live-transcribe',
      },
    ]])
    expect(wrapper.get('[data-scribe-openai-mode]').text()).toBe('Hosted')
  })

  it('keeps an explicit custom URL visible and labels its credential honestly', () => {
    const wrapper = mount(ScribeSettings, {
      props: {
        embedded: true,
        config: {
          ...config,
          transcriptionMode: 'custom',
          customUrl: 'https://speech.example.com/mimir-stt',
          customModel: 'meeting-v2',
        },
        permissions: { microphone: 'granted', systemAudio: 'prompt-on-start' },
      },
    })

    expect(wrapper.text()).toContain('configured HTTPS transcription service')
    expect(wrapper.text()).toContain('Hosted transcription API key')
    expect(wrapper.get('input[type="url"]').element.value)
      .toBe('https://speech.example.com/mimir-stt')
  })

  it('checks both audio sources without presenting a recording workflow', async () => {
    const wrapper = mount(ScribeSettings, {
      props: {
        embedded: true,
        config,
        permissions: { microphone: 'development-host', systemAudio: 'development-host' },
        audioCheck: {
          microphone: 'signal',
          systemAudio: 'silent',
          runtimeIdentity: 'development-host',
          observedMs: 4_000,
        },
      },
    })

    expect(wrapper.get('[data-scribe-audio-check-result]').text()).toContain('Signal detected')
    expect(wrapper.get('[data-scribe-audio-check-result]').text()).toContain('play audio and retry')
    expect(wrapper.text()).toContain('discarded immediately')
    expect(wrapper.text()).toContain('development host, not the installed Mimir app')
    await wrapper.get('[data-scribe-check-audio]').trigger('click')
    expect(wrapper.emitted('checkAudio')).toHaveLength(1)
  })
})
