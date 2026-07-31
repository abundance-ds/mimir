import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import {
  decideMeetingKgProposal,
  deleteMeeting,
  dismissMeetingCandidate,
  issueMeetingStartConsent,
  listenToMeetingEvents,
  loadMeetingSnapshot,
  loadMeetingTranscriptPage,
  openMeetingSystemAudioSettings,
  requestMeetingMicrophonePermission,
  startMeeting,
  stopMeeting,
  updateMeeting,
} from '../../services/meetings.js'
import ScribeApp from './ScribeApp.vue'

vi.mock('../../services/meetings.js', async importOriginal => ({
  ...(await importOriginal()),
  clearMeetingsApiKey: vi.fn(),
  decideMeetingKgProposal: vi.fn(),
  deleteMeeting: vi.fn(),
  deleteMeetingModel: vi.fn(),
  dismissMeetingCandidate: vi.fn(),
  exportMeeting: vi.fn(),
  installMeetingModel: vi.fn(),
  issueMeetingStartConsent: vi.fn(),
  listenToMeetingEvents: vi.fn(),
  loadMeetingLibraryPage: vi.fn(),
  loadMeetingSnapshot: vi.fn(),
  loadMeetingTranscriptPage: vi.fn(),
  openMeetingSystemAudioSettings: vi.fn(),
  requestMeetingMicrophonePermission: vi.fn(),
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
    tags: [],
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
    vi.mocked(loadMeetingTranscriptPage).mockReset().mockImplementation(async meetingId => ({
      meetingId,
      revision: 0,
      totalSegments: 0,
      hasMore: false,
      nextBefore: null,
      segments: [],
      summary: null,
    }))
    vi.mocked(requestMeetingMicrophonePermission).mockReset().mockResolvedValue(snapshot())
    vi.mocked(openMeetingSystemAudioSettings).mockReset().mockResolvedValue()
    vi.mocked(issueMeetingStartConsent).mockReset().mockResolvedValue({
      token: 'native-secret',
      requestId: 'scribe-start-native',
      expiresInMs: 45_000,
    })
    vi.mocked(dismissMeetingCandidate).mockReset()
    vi.mocked(deleteMeeting).mockReset()
    vi.mocked(updateMeeting).mockReset()
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
      requestId: 'scribe-start-native',
      consentToken: 'native-secret',
    }))
  })

  it('keeps the disclosure open with an actionable error when native consent expires', async () => {
    vi.mocked(startMeeting).mockRejectedValue(new Error(
      'Recording consent expired. Review the disclosure and confirm again.',
    ))
    const wrapper = mount(ScribeApp, { props: { active: true } })
    await vi.waitFor(() => expect(wrapper.get('[data-scribe-new]').exists()).toBe(true))

    await wrapper.get('[data-scribe-new]').trigger('click')
    await wrapper.get('[data-scribe-consent-checkbox]').setValue(true)
    await wrapper.get('[data-scribe-confirm-start]').trigger('click')

    await vi.waitFor(() => expect(wrapper.get('[data-scribe-consent-error]').text())
      .toContain('Review the disclosure and confirm again'))
    expect(wrapper.get('[data-scribe-consent]').exists()).toBe(true)
  })

  it('discloses the exact hosted destination before custom transcription capture', async () => {
    vi.mocked(loadMeetingSnapshot).mockResolvedValue(snapshot({
      config: {
        ...snapshot().config,
        transcriptionMode: 'custom',
        customUrl: 'https://speech.example.com/v1/listen',
        customModel: 'meeting-v2',
        apiKeyConfigured: true,
      },
    }))
    const wrapper = mount(ScribeApp, { props: { active: true } })
    await vi.waitFor(() => expect(wrapper.get('[data-scribe-new]').exists()).toBe(true))

    await wrapper.get('[data-scribe-new]').trigger('click')

    expect(wrapper.get('[data-scribe-hosted-disclosure]').text())
      .toContain('speech.example.com')
    expect(wrapper.get('[data-scribe-hosted-disclosure]').text())
      .toContain('Both audio channels')
  })

  it('lets the user dismiss a detected meeting without recording it', async () => {
    vi.mocked(loadMeetingSnapshot).mockResolvedValue(snapshot({
      candidates: [{ id: 'candidate-zoom', appName: 'Zoom', appId: 'us.zoom.xos' }],
    }))
    vi.mocked(dismissMeetingCandidate).mockResolvedValue(snapshot({
      revision: 2,
      candidates: [],
    }))
    const wrapper = mount(ScribeApp, { props: { active: true } })
    await vi.waitFor(() => expect(wrapper.get('[data-scribe-candidates]').exists()).toBe(true))

    await wrapper.get('[aria-label="Dismiss Zoom suggestion"]').trigger('click')

    await vi.waitFor(() => expect(dismissMeetingCandidate)
      .toHaveBeenCalledWith('candidate-zoom'))
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

  it('presents partial speech and capture gaps on one keyboard-navigable time ledger', async () => {
    const reviewed = meeting({
      lifecycle: 'ready',
      transcription: 'final',
      transcriptFinal: true,
      gapCount: 1,
      gaps: [{
        channel: 'system',
        startMs: 1_500,
        endMs: 2_750,
        reason: 'device-restart',
      }],
    })
    vi.mocked(loadMeetingSnapshot).mockResolvedValue(snapshot({ meetings: [reviewed] }))
    vi.mocked(loadMeetingTranscriptPage).mockResolvedValue({
      meetingId: 'm1',
      revision: 3,
      totalSegments: 2,
      hasMore: false,
      nextBefore: null,
      segments: [
        {
          id: 's1',
          text: 'Opening thought',
          startMs: 0,
          endMs: 1_000,
          channel: 'microphone',
          final: true,
          revision: 1,
        },
        {
          id: 's2',
          text: 'Working wording',
          startMs: 3_000,
          endMs: 4_000,
          channel: 'system',
          final: false,
          revision: 2,
        },
      ],
      summary: null,
    })
    const wrapper = mount(ScribeApp, { props: { active: true } })
    await vi.waitFor(() => expect(
      wrapper.findAll('[data-scribe-ledger-kind]'),
    ).toHaveLength(3))

    expect(wrapper.get('[data-scribe-transcript-ledger]').text()).toContain('You')
    expect(wrapper.get('[data-scribe-transcript-ledger]').text()).toContain('Capture gap')
    expect(wrapper.get('[data-scribe-transcript-ledger]').text()).toContain('wording may change')
    const tabs = wrapper.get('[role="tablist"]').findAll('[role="tab"]')
    expect(tabs[0].attributes('aria-selected')).toBe('true')
    await tabs[0].trigger('keydown', { key: 'ArrowRight' })
    expect(wrapper.get('#scribe-detail-tab-summary').attributes('aria-selected')).toBe('true')
    expect(wrapper.get('#scribe-detail-panel-summary').attributes('role')).toBe('tabpanel')
  })

  it('offers a deliberate permission repair action without enabling automatic recording', async () => {
    vi.mocked(loadMeetingSnapshot).mockResolvedValue(snapshot({
      permissions: { microphone: 'denied', systemAudio: 'denied' },
    }))
    vi.mocked(requestMeetingMicrophonePermission).mockResolvedValue(snapshot({
      revision: 2,
      permissions: { microphone: 'granted', systemAudio: 'prompt-on-start' },
    }))
    const wrapper = mount(ScribeApp, { props: { active: true } })
    await vi.waitFor(() => expect(wrapper.get('[data-scribe-settings]').exists()).toBe(true))

    await wrapper.get('[data-scribe-settings]').trigger('click')
    expect(wrapper.text()).not.toContain('Automatic recording')
    await wrapper.get('[data-scribe-grant-microphone]').trigger('click')

    await vi.waitFor(() => expect(requestMeetingMicrophonePermission).toHaveBeenCalledTimes(1))
    await wrapper.get('[data-scribe-open-system-audio-settings]').trigger('click')
    await vi.waitFor(() => expect(openMeetingSystemAudioSettings).toHaveBeenCalledTimes(1))
  })

  it('uses explicit route choices and keyboard listboxes in settings', async () => {
    const wrapper = mount(ScribeApp, { props: { active: true } })
    await vi.waitFor(() => expect(wrapper.get('[data-scribe-settings]').exists()).toBe(true))

    await wrapper.get('[data-scribe-settings]').trigger('click')

    expect(wrapper.get('[role="radiogroup"]').attributes('aria-label'))
      .toBe('Transcription route')
    expect(wrapper.findAll('[role="radio"]')).toHaveLength(2)
    expect(wrapper.find('select').exists()).toBe(false)
    expect(wrapper.findAll('[role="combobox"]')).toHaveLength(2)
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

  it('lets the user review and edit the generated title summary and tags', async () => {
    const complete = meeting({
      lifecycle: 'ready',
      transcription: 'final',
      transcriptFinal: true,
      summary: 'Initial summary.',
      summaryState: 'succeeded',
      tags: ['release', 'customer'],
    })
    vi.mocked(loadMeetingSnapshot).mockResolvedValue(snapshot({ meetings: [complete] }))
    vi.mocked(updateMeeting).mockResolvedValue(snapshot({
      revision: 2,
      meetings: [{
        ...complete,
        title: 'Reviewed planning outcome',
        summary: 'Reviewed summary.',
        tags: ['release', 'decision'],
      }],
    }))
    const wrapper = mount(ScribeApp, { props: { active: true } })
    await vi.waitFor(() => expect(wrapper.get('[data-scribe-meeting]').exists()).toBe(true))

    expect(wrapper.get('[data-scribe-reviewed-tags]').text()).toContain('release')
    expect(wrapper.get('[data-scribe-reviewed-tags]').text()).toContain('customer')
    await wrapper.findAll('button').find(button => button.text() === 'Edit').trigger('click')
    await wrapper.get('[data-scribe-edit-title]').setValue('Reviewed planning outcome')
    await wrapper.get('[data-scribe-edit-summary]').setValue('Reviewed summary.')
    await wrapper.get('[data-scribe-edit-tags]').setValue('release, decision, release')
    await wrapper.get('[data-scribe-save-review]').element.closest('form')
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))

    await vi.waitFor(() => expect(updateMeeting).toHaveBeenCalledWith('m1', {
      title: 'Reviewed planning outcome',
      summary: 'Reviewed summary.',
      tags: ['release', 'decision'],
    }))
  })

  it('keeps an oversized reviewed tag local and explains the payload bound', async () => {
    const complete = meeting({
      lifecycle: 'ready',
      transcription: 'final',
      transcriptFinal: true,
      summary: 'Initial summary.',
      summaryState: 'succeeded',
    })
    vi.mocked(loadMeetingSnapshot).mockResolvedValue(snapshot({ meetings: [complete] }))
    const wrapper = mount(ScribeApp, { props: { active: true } })
    await vi.waitFor(() => expect(wrapper.get('[data-scribe-meeting]').exists()).toBe(true))

    await wrapper.findAll('button').find(button => button.text() === 'Edit').trigger('click')
    await wrapper.get('[data-scribe-edit-tags]').setValue(`release, ${'x'.repeat(81)}`)

    expect(wrapper.get('[data-scribe-edit-tags-error]').attributes('role')).toBe('alert')
    expect(wrapper.get('[data-scribe-edit-tags-error]').text()).toContain('80 characters')
    expect(wrapper.get('[data-scribe-save-review]').attributes('disabled')).toBeDefined()
    expect(updateMeeting).not.toHaveBeenCalled()
  })

  it('requires native confirmation before permanently deleting a meeting', async () => {
    const complete = meeting({
      lifecycle: 'ready',
      transcription: 'final',
      transcriptFinal: true,
    })
    vi.mocked(loadMeetingSnapshot).mockResolvedValue(snapshot({ meetings: [complete] }))
    vi.mocked(deleteMeeting).mockResolvedValue(snapshot({ revision: 2, meetings: [] }))
    const wrapper = mount(ScribeApp, { props: { active: true } })
    await vi.waitFor(() => expect(wrapper.get('[data-scribe-meeting]').exists()).toBe(true))

    await wrapper.findAll('button').find(button => button.text() === 'Details').trigger('click')
    await wrapper.get('[data-scribe-delete-meeting]').trigger('click')

    await vi.waitFor(() => expect(deleteMeeting).toHaveBeenCalledWith('m1', 'all'))
  })
})
