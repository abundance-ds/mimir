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
  retryMeetingJob,
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
      summaryTemplate: 'standard',
      summaryPreset: '',
      kgPrompt: 'ask',
      kgPreset: '',
      retentionDays: 30,
    },
    permissions: { microphone: 'granted', systemAudio: 'prompt-on-start' },
    models: [{ id: 'whisper-small', title: 'Whisper Small', status: 'installed' }],
    diagnostic: null,
    ...overrides,
  }
}

function meeting(overrides = {}) {
  return {
    id: 'm1',
    title: 'Planning',
    lifecycle: 'ready',
    transcription: 'final',
    startedAt: new Date(Date.now() - 65_000).toISOString(),
    stoppedAt: new Date().toISOString(),
    durationMs: 65_000,
    workspacePath: '/work',
    sourceApp: 'Zoom',
    micMuted: false,
    channels: ['microphone', 'system'],
    gaps: [],
    gapCount: 0,
    transcriptRevision: 2,
    transcriptFinal: true,
    segmentCount: 1,
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

function transcriptPage(overrides = {}) {
  return {
    meetingId: 'm1',
    revision: 2,
    totalSegments: 0,
    hasMore: false,
    nextBefore: null,
    segments: [],
    summary: null,
    ...overrides,
  }
}

describe('ScribeApp', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(listenToMeetingEvents).mockReset().mockResolvedValue(vi.fn())
    vi.mocked(loadMeetingSnapshot).mockReset().mockResolvedValue(snapshot())
    vi.mocked(loadMeetingTranscriptPage).mockReset().mockResolvedValue(transcriptPage())
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
    vi.mocked(retryMeetingJob).mockReset()
  })

  it('starts recording with one action and no participant attestation gate', async () => {
    vi.mocked(startMeeting).mockResolvedValue(snapshot({
      revision: 2,
      activeMeetingId: 'm1',
      meetings: [meeting({ lifecycle: 'capturing', transcription: 'initializing' })],
    }))
    const wrapper = mount(ScribeApp, { props: { workspacePath: '/work', active: true } })
    await vi.waitFor(() => expect(wrapper.get('[data-scribe-new]').attributes('disabled')).toBeUndefined())

    expect(wrapper.find('[data-scribe-consent-checkbox]').exists()).toBe(false)
    await wrapper.get('[data-scribe-new]').trigger('click')

    await vi.waitFor(() => expect(startMeeting).toHaveBeenCalledWith(expect.objectContaining({
      workspacePath: '/work',
      requestId: 'scribe-start-native',
      consentToken: 'native-secret',
    })))
  })

  it('discloses OpenAI processing inline without adding a confirmation step', async () => {
    const hosted = snapshot({
      config: {
        ...snapshot().config,
        transcriptionMode: 'custom',
        customUrl: 'https://api.openai.com/v1/realtime',
        customModel: 'gpt-live-transcribe',
        apiKeyConfigured: true,
      },
    })
    vi.mocked(loadMeetingSnapshot).mockResolvedValue(hosted)
    vi.mocked(requestMeetingMicrophonePermission).mockResolvedValue(hosted)
    vi.mocked(startMeeting).mockResolvedValue(snapshot({
      revision: 2,
      activeMeetingId: 'm1',
      meetings: [meeting({ lifecycle: 'capturing', transcription: 'initializing' })],
    }))
    const wrapper = mount(ScribeApp, { props: { active: true } })
    await vi.waitFor(() => expect(wrapper.get('[data-scribe-new]').attributes('disabled')).toBeUndefined())

    expect(wrapper.get('[data-scribe-route-disclosure]').text())
      .toBe('Microphone and system audio are sent to OpenAI for live transcription.')
    expect(wrapper.find('[data-scribe-consent]').exists()).toBe(false)
    await wrapper.get('[data-scribe-new]').trigger('click')
    await vi.waitFor(() => expect(startMeeting).toHaveBeenCalledTimes(1))
  })

  it('keeps a failed start on the ready screen with a local actionable message', async () => {
    vi.mocked(startMeeting).mockRejectedValue(new Error('Capture device unavailable'))
    const wrapper = mount(ScribeApp, { props: { active: true } })
    await vi.waitFor(() => expect(wrapper.get('[data-scribe-new]').attributes('disabled')).toBeUndefined())

    await wrapper.get('[data-scribe-new]').trigger('click')

    await vi.waitFor(() => expect(wrapper.get('[data-scribe-error]').text())
      .toContain('Capture device unavailable'))
    expect(wrapper.get('[data-scribe-new]').exists()).toBe(true)
  })

  it('shows a detected app as a dismissible inline suggestion', async () => {
    vi.mocked(loadMeetingSnapshot).mockResolvedValue(snapshot({
      candidates: [{ id: 'candidate-zoom', appName: 'Zoom', appId: 'us.zoom.xos' }],
    }))
    vi.mocked(dismissMeetingCandidate).mockResolvedValue(snapshot({ revision: 2 }))
    const wrapper = mount(ScribeApp, { props: { active: true } })
    await vi.waitFor(() => expect(wrapper.get('[data-scribe-candidates]').text()).toContain('Zoom'))

    await wrapper.get('[aria-label="Dismiss Zoom suggestion"]').trigger('click')
    await vi.waitFor(() => expect(dismissMeetingCandidate).toHaveBeenCalledWith('candidate-zoom'))
  })

  it('keeps Stop visible above nonblocking transcription failure', async () => {
    const active = meeting({
      lifecycle: 'capturing',
      transcription: 'failed',
      transcriptFinal: false,
      error: 'meeting m1 has no live transcription worker',
    })
    vi.mocked(loadMeetingSnapshot).mockResolvedValue(snapshot({
      activeMeetingId: active.id,
      meetings: [active],
    }))
    vi.mocked(stopMeeting).mockResolvedValue(snapshot({
      revision: 2,
      activeMeetingId: active.id,
      meetings: [{ ...active, lifecycle: 'finalizing' }],
    }))
    const wrapper = mount(ScribeApp, { props: { active: true } })
    await vi.waitFor(() => expect(wrapper.get('[data-scribe-stop]').exists()).toBe(true))

    expect(wrapper.get('[data-scribe-error]').text()).toContain('Recording is safe')
    expect(wrapper.get('[data-scribe-ledger]').text()).toContain('microphone + system audio')
    await wrapper.get('[data-scribe-stop]').trigger('click')
    await vi.waitFor(() => expect(stopMeeting).toHaveBeenCalledWith('m1'))
  })

  it('shows live partial speech and capture gaps in one ledger', async () => {
    const active = meeting({ lifecycle: 'capturing', transcription: 'initializing', transcriptFinal: false })
    vi.mocked(loadMeetingSnapshot).mockResolvedValue(snapshot({
      activeMeetingId: active.id,
      meetings: [active],
    }))
    vi.mocked(loadMeetingTranscriptPage).mockResolvedValue(transcriptPage({
      totalSegments: 2,
      segments: [
        { id: 's1', text: 'Opening thought', startMs: 0, endMs: 1_000, channel: 'microphone', final: true, revision: 1 },
        { id: 's2', text: 'Working wording', startMs: 3_000, endMs: 4_000, channel: 'system', final: false, revision: 2 },
      ],
    }))
    active.gaps = [{ channel: 'system', startMs: 1_500, endMs: 2_750, reason: 'device-restart' }]
    active.gapCount = 1
    const wrapper = mount(ScribeApp, { props: { active: true } })

    await vi.waitFor(() => expect(wrapper.findAll('[data-scribe-ledger-kind]')).toHaveLength(3))
    expect(wrapper.get('[data-scribe-transcript-ledger]').text()).toContain('You')
    expect(wrapper.get('[data-scribe-transcript-ledger]').text()).toContain('Others')
    expect(wrapper.get('[data-scribe-transcript-ledger]').text()).toContain('wording may change')
    expect(wrapper.get('[data-scribe-ledger]').text()).toContain('Transcribing live on this Mac')
  })

  it('opens one recent meeting into the focused Transcript and Summary review', async () => {
    const reviewed = meeting({ summary: 'Decision captured.', summaryState: 'succeeded' })
    vi.mocked(loadMeetingSnapshot).mockResolvedValue(snapshot({ meetings: [reviewed] }))
    vi.mocked(loadMeetingTranscriptPage).mockResolvedValue(transcriptPage({
      totalSegments: 1,
      segments: [{ id: 's1', text: 'Approved.', startMs: 0, endMs: 1_000, channel: 'microphone', final: true, revision: 1 }],
      summary: reviewed.summary,
    }))
    const wrapper = mount(ScribeApp, { props: { active: true } })
    await vi.waitFor(() => expect(wrapper.get('[data-scribe-meeting-row]').exists()).toBe(true))

    await wrapper.get('[data-scribe-meeting-row]').trigger('click')
    await vi.waitFor(() => expect(wrapper.get('[data-scribe-meeting]').text()).toContain('Planning'))
    expect(wrapper.get('#scribe-detail-tab-transcript').attributes('aria-selected')).toBe('true')
    await vi.waitFor(() => expect(wrapper.get('#scribe-detail-panel-transcript').text())
      .toContain('Approved.'))
    await wrapper.get('#scribe-detail-tab-summary').trigger('click')
    expect(wrapper.get('#scribe-detail-panel-summary').text()).toContain('Decision captured')
  })

  it('lets a completed summary run again with the currently selected recipe', async () => {
    const reviewed = meeting({ summary: 'Decision captured.', summaryState: 'succeeded' })
    vi.mocked(loadMeetingSnapshot).mockResolvedValue(snapshot({ meetings: [reviewed] }))
    vi.mocked(loadMeetingTranscriptPage).mockResolvedValue(transcriptPage({
      totalSegments: 1,
      segments: [{ id: 's1', text: 'Approved.', startMs: 0, endMs: 1_000, channel: 'microphone', final: true, revision: 1 }],
      summary: reviewed.summary,
    }))
    vi.mocked(retryMeetingJob).mockResolvedValue(snapshot({
      revision: 2,
      meetings: [{ ...reviewed, summaryState: 'queued' }],
    }))
    const wrapper = mount(ScribeApp, { props: { active: true } })
    await vi.waitFor(() => expect(wrapper.get('[data-scribe-meeting-row]').exists()).toBe(true))
    await wrapper.get('[data-scribe-meeting-row]').trigger('click')
    await wrapper.get('#scribe-detail-tab-summary').trigger('click')
    await wrapper.get('[data-scribe-regenerate-summary]').trigger('click')

    await vi.waitFor(() => expect(retryMeetingJob).toHaveBeenCalledWith('m1', 'title-summary'))
  })

  it('offers a reviewable KG draft only in the completed meeting review', async () => {
    const complete = meeting({
      summary: 'The team agreed on the release boundary.',
      summaryState: 'succeeded',
      kgState: 'awaiting-decision',
    })
    vi.mocked(loadMeetingSnapshot).mockResolvedValue(snapshot({ meetings: [complete] }))
    vi.mocked(loadMeetingTranscriptPage).mockResolvedValue(transcriptPage({ summary: complete.summary }))
    vi.mocked(decideMeetingKgProposal).mockResolvedValue(snapshot({
      revision: 2,
      meetings: [{ ...complete, kgState: 'draft-queued' }],
    }))
    const wrapper = mount(ScribeApp, { props: { active: true } })
    await vi.waitFor(() => expect(wrapper.get('[data-scribe-meeting-row]').exists()).toBe(true))
    await wrapper.get('[data-scribe-meeting-row]').trigger('click')
    await wrapper.get('#scribe-detail-tab-summary').trigger('click')

    expect(wrapper.get('[data-scribe-kg-offer]').text()).toContain('reviewable')
    await wrapper.get('[data-scribe-kg-offer]').findAll('button').at(-1).trigger('click')
    await vi.waitFor(() => expect(decideMeetingKgProposal)
      .toHaveBeenCalledWith('m1', 'create-draft'))
  })

  it('edits reviewed title summary and bounded tags', async () => {
    const complete = meeting({ summary: 'Initial summary.', tags: ['release', 'customer'] })
    vi.mocked(loadMeetingSnapshot).mockResolvedValue(snapshot({ meetings: [complete] }))
    vi.mocked(updateMeeting).mockResolvedValue(snapshot({ meetings: [complete] }))
    const wrapper = mount(ScribeApp, { props: { active: true } })
    await vi.waitFor(() => expect(wrapper.get('[data-scribe-meeting-row]').exists()).toBe(true))
    await wrapper.get('[data-scribe-meeting-row]').trigger('click')
    await wrapper.findAll('button').find(button => button.text() === 'Edit').trigger('click')
    await wrapper.get('[data-scribe-edit-title]').setValue('Reviewed outcome')
    await wrapper.get('[data-scribe-edit-summary]').setValue('Reviewed summary.')
    await wrapper.get('[data-scribe-edit-tags]').setValue('release, decision, release')
    await wrapper.get('[data-scribe-save-review]').element.closest('form')
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))

    await vi.waitFor(() => expect(updateMeeting).toHaveBeenCalledWith('m1', {
      title: 'Reviewed outcome', summary: 'Reviewed summary.', tags: ['release', 'decision'],
    }))
  })

  it('keeps oversized reviewed tags local', async () => {
    vi.mocked(loadMeetingSnapshot).mockResolvedValue(snapshot({ meetings: [meeting()] }))
    const wrapper = mount(ScribeApp, { props: { active: true } })
    await vi.waitFor(() => expect(wrapper.get('[data-scribe-meeting-row]').exists()).toBe(true))
    await wrapper.get('[data-scribe-meeting-row]').trigger('click')
    await wrapper.findAll('button').find(button => button.text() === 'Edit').trigger('click')
    await wrapper.get('[data-scribe-edit-tags]').setValue(`release, ${'x'.repeat(81)}`)

    expect(wrapper.get('[data-scribe-edit-tags-error]').text()).toContain('80 characters')
    expect(wrapper.get('[data-scribe-save-review]').attributes('disabled')).toBeDefined()
    expect(updateMeeting).not.toHaveBeenCalled()
  })

  it('keeps permission repair actions in settings without blocking recording controls', async () => {
    vi.mocked(loadMeetingSnapshot).mockResolvedValue(snapshot({
      permissions: { microphone: 'denied', systemAudio: 'prompt-on-start' },
    }))
    const wrapper = mount(ScribeApp, { props: { active: true } })
    await vi.waitFor(() => expect(wrapper.get('[data-scribe-settings]').exists()).toBe(true))
    await wrapper.get('[data-scribe-settings]').trigger('click')
    await wrapper.get('[data-scribe-grant-microphone]').trigger('click')
    await wrapper.get('[data-scribe-open-system-audio-settings]').trigger('click')

    await vi.waitFor(() => expect(requestMeetingMicrophonePermission).toHaveBeenCalledTimes(1))
    expect(openMeetingSystemAudioSettings).toHaveBeenCalledTimes(1)
  })

  it('requires native confirmation before permanently deleting a meeting', async () => {
    vi.mocked(loadMeetingSnapshot).mockResolvedValue(snapshot({ meetings: [meeting()] }))
    vi.mocked(deleteMeeting).mockResolvedValue(snapshot({ revision: 2, meetings: [] }))
    const wrapper = mount(ScribeApp, { props: { active: true } })
    await vi.waitFor(() => expect(wrapper.get('[data-scribe-meeting-row]').exists()).toBe(true))
    await wrapper.get('[data-scribe-meeting-row]').trigger('click')
    await wrapper.get('[data-scribe-delete-meeting]').trigger('click')

    await vi.waitFor(() => expect(deleteMeeting).toHaveBeenCalledWith('m1', 'all'))
  })
})
