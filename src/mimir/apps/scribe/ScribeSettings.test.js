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
        permissions: { microphone: 'granted', systemAudio: 'not-determined' },
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
    expect(wrapper.text()).toContain('Not requested')
    expect(wrapper.get('[data-scribe-grant-system-audio]').text())
      .toBe('Grant system audio access')
    await wrapper.get('[data-scribe-grant-system-audio]').trigger('click')
    expect(wrapper.emitted('requestSystemAudioPermission')).toHaveLength(1)
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
        permissions: { microphone: 'granted', systemAudio: 'not-determined' },
      },
    })

    expect(wrapper.text()).toContain('Using hosted transcription')
    expect(wrapper.text()).toContain('Hosted transcription API key')
    expect(wrapper.get('input[type="url"]').element.value)
      .toBe('https://speech.example.com/mimir-stt')
  })

  it('spells out live input states and development-host results', async () => {
    const wrapper = mount(ScribeSettings, {
      props: {
        embedded: true,
        config,
        permissions: { microphone: 'development-host', systemAudio: 'development-host' },
        audioCheck: {
          state: 'running',
          runtimeIdentity: 'development-host',
          microphone: { state: 'signal', level: 78 },
          systemAudio: { state: 'silent', level: 12 },
        },
        audioTesting: true,
      },
    })

    expect(wrapper.get('[data-scribe-audio-level="microphone"]').attributes('aria-valuenow'))
      .toBe('78')
    expect(wrapper.get('[data-scribe-audio-level="system"]').attributes('aria-valuenow'))
      .toBe('12')
    expect(wrapper.get('[data-scribe-audio-state="microphone"]').text()).toBe('78%')
    expect(wrapper.get('[data-scribe-audio-state="system"]').text()).toBe('Silent')
    expect(wrapper.text()).toContain('Development-host results')
    expect(wrapper.get('[data-scribe-check-audio]').text()).toBe('Stop test')

    await wrapper.setProps({
      audioCheck: {
        state: 'running',
        runtimeIdentity: 'development-host',
        microphone: { state: 'signal', level: 22 },
        systemAudio: {
          state: 'open-failed',
          level: 0,
          error: 'System audio permission belongs to the development host.',
        },
      },
    })
    expect(wrapper.get('[data-scribe-audio-state="system"]').text()).toBe('Open failed')
    expect(wrapper.get('[data-scribe-audio-error="system"]').text())
      .toBe('System audio permission belongs to the development host.')

    await wrapper.get('[data-scribe-check-audio]').trigger('click')
    expect(wrapper.emitted('checkAudio')).toHaveLength(1)
  })

  it('hides stale input levels whenever the audio test is not running', () => {
    const wrapper = mount(ScribeSettings, {
      props: {
        embedded: true,
        config,
        permissions: { microphone: 'granted', systemAudio: 'granted' },
        audioCheck: {
          state: 'stopped',
          microphone: { state: 'stopped', level: 0 },
          systemAudio: { state: 'stopped', level: 0 },
        },
        audioTesting: false,
      },
    })

    expect(wrapper.find('[data-scribe-audio-check-result]').exists()).toBe(false)
    expect(wrapper.get('[data-scribe-check-audio]').text()).toBe('Test inputs')
  })

  it('selects a stable microphone identity or returns to the system default', async () => {
    const wrapper = mount(ScribeSettings, {
      props: {
        embedded: true,
        config,
        permissions: { microphone: 'granted', systemAudio: 'granted' },
        microphoneCatalog: {
          devices: [{ id: 'coreaudio:desk-mic', name: 'Desk Mic', isDefault: false }],
          fallbackReason: null,
        },
      },
    })

    const selector = wrapper.get('[aria-label="Microphone input"]')
    expect(selector.text()).toContain('System default')
    await selector.trigger('click')
    await wrapper.findAll('[role="option"]')
      .find(option => option.text().includes('Desk Mic'))
      .trigger('click')
    expect(wrapper.emitted('save')?.at(-1)).toEqual([{ microphoneDeviceId: 'coreaudio:desk-mic' }])
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

    expect(wrapper.get('[data-scribe-api-key-state]').text()).toContain('Configured')
    expect(wrapper.get('[data-scribe-api-key-state]').text()).toContain('Keychain')
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

  it('keeps the editable summary prompt in global settings and resets it with a preset', async () => {
    const wrapper = mount(ScribeSettings, {
      props: {
        embedded: true,
        config,
        permissions: { microphone: 'granted', systemAudio: 'granted' },
      },
    })

    const prompt = wrapper.get('[data-scribe-summary-prompt]')
    expect(wrapper.text()).toContain('Summary prompt')
    expect(wrapper.text()).not.toContain('Knowledge-graph follow-up')
    expect(prompt.attributes('rows')).toBe('10')
    expect(prompt.element.value).toBe('Write a balanced meeting summary.')
    await prompt.setValue('Always list decisions before actions.')
    await wrapper.get('[data-scribe-save-summary-prompt]').trigger('click')
    expect(wrapper.emitted('save')).toContainEqual([{
      summaryPrompt: 'Always list decisions before actions.',
    }])

    const format = wrapper.get('[aria-label="Summary format"]')
    expect(format.element.closest('label')).toBeNull()
    await format.trigger('click')
    await wrapper.findAll('[role="option"]')
      .find(option => option.text().includes('Brief'))
      .trigger('click')
    expect(wrapper.emitted('save').at(-1)).toEqual([expect.objectContaining({
      summaryTemplate: 'brief',
      summaryPrompt: expect.stringContaining('BLUF approach'),
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

    expect(wrapper.text()).toContain('Using OpenAI')
    expect(wrapper.text()).not.toContain('Detection suggests a recording')
    expect(wrapper.text()).not.toContain('This recipe is used after future meetings')
    expect(wrapper.text()).not.toContain('Stored in Keychain and never returned')
  })
})
