import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  listenToMeetingEvents,
  loadMeetingSnapshot,
  openMeetingSystemAudioSettings,
  requestMeetingMicrophonePermission,
} from '../../../services/meetings.js'
import ScribeSettingsSection from './ScribeSettingsSection.vue'

vi.mock('../../../services/meetings.js', async importOriginal => ({
  ...(await importOriginal()),
  listenToMeetingEvents: vi.fn(),
  loadMeetingSnapshot: vi.fn(),
  loadMeetingTranscriptPage: vi.fn(),
  openMeetingSystemAudioSettings: vi.fn(),
  requestMeetingMicrophonePermission: vi.fn(),
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
  })

  it('forwards both child permission actions to their narrow native owners', async () => {
    const wrapper = mount(ScribeSettingsSection)
    await flushPromises()

    await wrapper.get('[data-scribe-grant-microphone]').trigger('click')
    await flushPromises()
    expect(requestMeetingMicrophonePermission).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[role="status"]').text()).toContain('Microphone access granted')

    await wrapper.get('[data-scribe-open-system-audio-settings]').trigger('click')
    await flushPromises()
    expect(openMeetingSystemAudioSettings).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[role="status"]').text()).toContain('System Settings opened')
  })
})
