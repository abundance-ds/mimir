import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  listenToMeetingEvents,
  loadMeetingSnapshot,
  openMeetingSystemAudioSettings,
  requestMeetingMicrophonePermission,
  setMeetingsApiKey,
} from '../../../services/meetings.js'
import ScribeSettingsSection from './ScribeSettingsSection.vue'

vi.mock('../../../services/meetings.js', async importOriginal => ({
  ...(await importOriginal()),
  listenToMeetingEvents: vi.fn(),
  loadMeetingSnapshot: vi.fn(),
  loadMeetingTranscriptPage: vi.fn(),
  openMeetingSystemAudioSettings: vi.fn(),
  requestMeetingMicrophonePermission: vi.fn(),
  setMeetingsApiKey: vi.fn(),
}))

const snapshot = {
  revision: 1,
  meetings: [],
  activeMeetingId: null,
  candidates: [],
  config: {
    detectionEnabled: false,
    transcriptionMode: 'local',
    customUrl: '',
    customModel: '',
    localModel: 'whisper-small',
    summaryEnabled: true,
    kgPrompt: 'ask',
    retentionDays: 30,
  },
  permissions: { microphone: 'denied', systemAudio: 'denied' },
  models: [],
  diagnostic: null,
}

describe('ScribeSettingsSection permission repair', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(listenToMeetingEvents).mockReset().mockResolvedValue(vi.fn())
    vi.mocked(loadMeetingSnapshot).mockReset().mockResolvedValue(snapshot)
    vi.mocked(requestMeetingMicrophonePermission).mockReset().mockResolvedValue({
      ...snapshot,
      revision: 2,
      permissions: { microphone: 'granted', systemAudio: 'denied' },
    })
    vi.mocked(openMeetingSystemAudioSettings).mockReset().mockResolvedValue()
    vi.mocked(setMeetingsApiKey).mockReset()
  })

  it('forwards both child permission actions to their narrow native owners', async () => {
    const wrapper = mount(ScribeSettingsSection)
    await flushPromises()

    await wrapper.get('[data-scribe-grant-microphone]').trigger('click')
    await flushPromises()
    expect(requestMeetingMicrophonePermission).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[role="status"]').exists()).toBe(false)

    await wrapper.get('[data-scribe-open-system-audio-settings]').trigger('click')
    await flushPromises()
    expect(openMeetingSystemAudioSettings).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[role="status"]').exists()).toBe(false)
  })

  it('confirms a Keychain save beside the credential control', async () => {
    const hosted = {
      ...snapshot,
      config: {
        ...snapshot.config,
        transcriptionMode: 'custom',
        customUrl: 'https://api.openai.com/v1/realtime',
        customModel: 'gpt-live-transcribe',
        apiKeyConfigured: false,
      },
    }
    vi.mocked(loadMeetingSnapshot).mockResolvedValue(hosted)
    vi.mocked(setMeetingsApiKey).mockResolvedValue({
      ...hosted,
      revision: 2,
      config: { ...hosted.config, apiKeyConfigured: true },
    })
    const wrapper = mount(ScribeSettingsSection)
    await flushPromises()

    await wrapper.get('[data-scribe-api-key]').setValue('test-secret')
    await wrapper.get('[data-scribe-save-api-key]').trigger('submit')
    await flushPromises()

    expect(setMeetingsApiKey).toHaveBeenCalledWith('test-secret')
    expect(wrapper.get('[data-scribe-api-key-feedback]').text())
      .toContain('saved and verified')
  })
})
