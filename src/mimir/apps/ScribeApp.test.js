import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import {
  decideMeetingKgProposal,
  listenToMeetingEvents,
  loadMeetingSnapshot,
  startMeeting,
  stopMeeting,
} from '../../services/meetings.js'
import ScribeApp from './ScribeApp.vue'

vi.mock('../../services/meetings.js', async importOriginal => ({
  ...(await importOriginal()),
  clearMeetingsApiKey: vi.fn(),
  decideMeetingKgProposal: vi.fn(),
  deleteMeeting: vi.fn(),
  deleteMeetingModel: vi.fn(),
  exportMeeting: vi.fn(),
  installMeetingModel: vi.fn(),
  listenToMeetingEvents: vi.fn(),
  loadMeetingSnapshot: vi.fn(),
  retryMeetingJob: vi.fn(),
  setMeetingMicMuted: vi.fn(),
  setMeetingsApiKey: vi.fn(),
  startMeeting: vi.fn(),
  stopMeeting: vi.fn(),
  updateMeeting: vi.fn(),
  updateMeetingsConfig: vi.fn(),
}))

function snapshot(overrides = {}) {
  return {
    revision: 1,
    meetings: [],
    activeMeetingId: null,
    activeMeeting: null,
    candidates: [],
    config: {
      detectionEnabled: false,
      autoRecord: false,
      transcriptionMode: 'local',
      customUrl: '',
      customModel: '',
      apiKeyConfigured: false,
      localModel: 'whisper-small',
      summaryEnabled: true,
      summaryPreset: '',
      kgPrompt: 'ask',
      kgPreset: '',
      retentionDays: 30,
    },
    permissions: { microphone: 'granted', systemAudio: 'granted' },
    models: [],
    diagnostic: null,
    ...overrides,
  }
}

function meeting(overrides = {}) {
  return {
    id: 'm1',
    title: 'Planning',
    lifecycle: 'capturing',
    transcription: 'live',
    startedAt: new Date(Date.now() - 65_000).toISOString(),
    stoppedAt: null,
    durationMs: 65_000,
    workspacePath: '/work',
    sourceApp: 'Zoom',
    micMuted: false,
    channels: ['microphone', 'system'],
    gaps: [],
    transcriptRevision: 2,
    transcriptFinal: false,
    segments: [],
    summary: null,
    summaryState: 'not-started',
    kgState: 'not-offered',
    jobs: [],
    error: null,
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

describe('ScribeApp', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(listenToMeetingEvents).mockReset().mockResolvedValue(vi.fn())
    vi.mocked(loadMeetingSnapshot).mockReset().mockResolvedValue(snapshot())
    vi.mocked(startMeeting).mockReset()
    vi.mocked(stopMeeting).mockReset()
    vi.mocked(decideMeetingKgProposal).mockReset()
  })

  it('requires the human consent acknowledgement before capture starts', async () => {
    vi.mocked(startMeeting).mockResolvedValue(snapshot({
      revision: 2,
      activeMeetingId: 'm1',
      meetings: [meeting()],
    }))
    const wrapper = mount(ScribeApp, { props: { workspacePath: '/work', active: true } })
    await vi.waitFor(() => expect(wrapper.get('[data-scribe-new]').exists()).toBe(true))

    await wrapper.get('[data-scribe-new]').trigger('click')
    const start = wrapper.get('[data-scribe-confirm-start]')
    expect(start.attributes('disabled')).toBeDefined()
    await wrapper.get('[data-scribe-consent-checkbox]').setValue(true)
    await wrapper.get('[data-scribe-title]').setValue('Planning')
    await start.trigger('click')

    await vi.waitFor(() => expect(startMeeting).toHaveBeenCalledWith({
      title: 'Planning',
      candidateId: null,
      workspacePath: '/work',
      consentConfirmed: true,
    }))
  })

  it('keeps recording state, both channels, and Stop visible in global tool chrome', async () => {
    const active = meeting()
    vi.mocked(loadMeetingSnapshot).mockResolvedValue(snapshot({
      activeMeetingId: active.id,
      meetings: [active],
    }))
    vi.mocked(stopMeeting).mockResolvedValue(snapshot({
      revision: 2,
      activeMeetingId: active.id,
      meetings: [meeting({ lifecycle: 'finalizing' })],
    }))
    const wrapper = mount(ScribeApp, { props: { active: true } })
    await vi.waitFor(() => expect(wrapper.get('[data-scribe-stop]').exists()).toBe(true))

    expect(wrapper.get('[data-scribe-recording-label]').text()).toContain('Recording')
    expect(wrapper.get('[data-scribe-ledger]').text()).toContain('Mic active')
    expect(wrapper.get('[data-scribe-ledger]').text()).toContain('System active')
    await wrapper.get('[data-scribe-stop]').trigger('click')
    await vi.waitFor(() => expect(stopMeeting).toHaveBeenCalledWith('m1'))
  })

  it('offers a reviewable KG draft only after title and summary complete', async () => {
    const complete = meeting({
      lifecycle: 'ready',
      transcription: 'final',
      transcriptFinal: true,
      summary: 'The team agreed on the release boundary.',
      summaryState: 'succeeded',
      kgState: 'awaiting-decision',
    })
    vi.mocked(loadMeetingSnapshot).mockResolvedValue(snapshot({ meetings: [complete] }))
    vi.mocked(decideMeetingKgProposal).mockResolvedValue(snapshot({
      revision: 2,
      meetings: [{ ...complete, kgState: 'draft-queued' }],
    }))
    const wrapper = mount(ScribeApp, { props: { active: true } })
    await vi.waitFor(() => expect(wrapper.get('[data-scribe-kg-offer]').exists()).toBe(true))

    expect(wrapper.get('[data-scribe-kg-offer]').text()).toContain('Create reviewable')
    const buttons = wrapper.get('[data-scribe-kg-offer]').findAll('button')
    await buttons.at(-1).trigger('click')
    await vi.waitFor(() => expect(decideMeetingKgProposal)
      .toHaveBeenCalledWith('m1', 'create-draft'))
  })
})
