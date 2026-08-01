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
  summaryTemplate: 'standard',
  summaryPrompt: 'Write a balanced meeting summary.',
  summaryPreset: '',
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

    expect(wrapper.get('[data-scribe-config-pending]').text()).toBe('Saving…')
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

    expect(wrapper.text()).toContain('Sends microphone and system audio to the configured HTTPS service')
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
          microphoneLevel: 78,
          systemAudioLevel: 12,
          runtimeIdentity: 'development-host',
          observedMs: 4_000,
        },
      },
    })

    expect(wrapper.get('[data-scribe-audio-check-result]').text()).toContain('Signal detected')
    expect(wrapper.get('[data-scribe-audio-check-result]').text()).toContain('play audio and retry')
    expect(wrapper.get('[data-scribe-audio-level="microphone"]').attributes('aria-valuenow'))
      .toBe('78')
    expect(wrapper.get('[data-scribe-audio-level="system"]').attributes('aria-valuenow'))
      .toBe('12')
    expect(wrapper.text()).toContain('No samples are kept')
    expect(wrapper.text()).toContain('Verify in the installed Mimir app')
    await wrapper.get('[data-scribe-check-audio]').trigger('click')
    expect(wrapper.emitted('checkAudio')).toHaveLength(1)
  })

  it('keeps credential state visible and does not erase a replacement before confirmation', async () => {
    const wrapper = mount(ScribeSettings, {
      props: {
        embedded: true,
        config: {
          ...config,
          transcriptionMode: 'custom',
          customUrl: 'https://api.openai.com/v1/realtime',
          customModel: 'gpt-live-transcribe',
          apiKeyConfigured: true,
        },
        permissions: { microphone: 'granted', systemAudio: 'granted' },
      },
    })

    expect(wrapper.get('[data-scribe-api-key-state]').text()).toContain('Saved in Keychain')
    expect(wrapper.get('[data-scribe-api-key]').attributes('placeholder')).toBe('Enter replacement key')
    expect(wrapper.get('[data-scribe-save-api-key]').text()).toBe('Replace key')
    expect(wrapper.get('[data-scribe-clear-api-key]').text()).toBe('Remove key')

    await wrapper.get('[data-scribe-api-key]').setValue('replacement-secret')
    await wrapper.get('[data-scribe-save-api-key]').trigger('submit')
    expect(wrapper.emitted('saveApiKey')).toEqual([['replacement-secret']])
    expect(wrapper.get('[data-scribe-api-key]').element.value).toBe('replacement-secret')

    await wrapper.setProps({ credentialNotice: 'API key replaced and verified in Keychain.' })
    expect(wrapper.get('[data-scribe-api-key]').element.value).toBe('')
    expect(wrapper.get('[data-scribe-api-key-feedback]').text()).toContain('replaced and verified')
  })

  it('shows credential failures beside the key and exposes summary format and agent', () => {
    const wrapper = mount(ScribeSettings, {
      props: {
        embedded: true,
        config: {
          ...config,
          transcriptionMode: 'custom',
          customUrl: 'https://api.openai.com/v1/realtime',
          customModel: 'gpt-live-transcribe',
          summaryPreset: 'codex-review',
        },
        permissions: { microphone: 'granted', systemAudio: 'granted' },
        credentialError: 'Keychain refused the write.',
        summaryAgents: [{ value: 'codex-review', label: 'Codex · Review preset' }],
      },
    })

    expect(wrapper.get('[data-scribe-api-key-error]').text()).toContain('Keychain refused')
    expect(wrapper.get('[aria-label="Summary format"]').exists()).toBe(true)
    expect(wrapper.get('[aria-label="Summary CLI agent"]').text()).toContain('Codex')
  })

  it('makes the actual summary system prompt editable and resets it with a preset', async () => {
    const wrapper = mount(ScribeSettings, {
      props: {
        embedded: true,
        config,
        permissions: { microphone: 'granted', systemAudio: 'granted' },
      },
    })

    const prompt = wrapper.get('[data-scribe-summary-prompt]')
    expect(prompt.attributes('rows')).toBe('10')
    expect(prompt.element.value).toBe('Write a balanced meeting summary.')
    await prompt.setValue('Always list decisions before actions.')
    await wrapper.get('[data-scribe-save-summary-prompt]').trigger('click')
    expect(wrapper.emitted('save')).toContainEqual([{
      summaryPrompt: 'Always list decisions before actions.',
    }])

    const format = wrapper.get('[aria-label="Summary format"]')
    await format.trigger('click')
    await wrapper.findAll('[role="option"]')
      .find(option => option.text().includes('Brief'))
      .trigger('click')
    expect(wrapper.emitted('save').at(-1)).toEqual([expect.objectContaining({
      summaryTemplate: 'brief',
      summaryPrompt: expect.stringContaining('compact executive summary'),
    })])
  })

  it('keeps settings labels and hosted disclosure without product-tour prose', () => {
    const wrapper = mount(ScribeSettings, {
      props: {
        embedded: true,
        config: {
          ...config,
          transcriptionMode: 'custom',
          customUrl: 'https://api.openai.com/v1/realtime',
          customModel: 'gpt-live-transcribe',
        },
        permissions: { microphone: 'granted', systemAudio: 'granted' },
      },
    })

    expect(wrapper.text()).toContain('Sends microphone and system audio to OpenAI')
    expect(wrapper.text()).not.toContain('Detection suggests a recording')
    expect(wrapper.text()).not.toContain('This recipe is used after future meetings')
    expect(wrapper.text()).not.toContain('Stored in Keychain and never returned')
  })
})
