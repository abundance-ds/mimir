import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useLaunchersStore } from '../../stores/launchers.js'
import {
  deleteMeeting,
  dismissMeetingCandidate,
  issueMeetingStartConsent,
  listenToMeetingEvents,
  loadMeetingSnapshot,
  loadMeetingTranscriptPage,
  openMeetingSystemAudioSettings,
  prepareMeeting,
  prepareMeetingFollowUpContext,
  requestMeetingMicrophonePermission,
  requestMeetingSystemAudioPermission,
  retranscribeMeeting,
  runMeetingSummary,
  searchMeetingLibrary,
  retryMeetingJob,
  showMeetingFiles,
  startMeeting,
  stopMeeting,
  updateMeeting,
} from '../../services/meetings.js'
import ScribeApp from './ScribeApp.vue'
import ScribeFollowUpDialog from './scribe/ScribeFollowUpDialog.vue'
import ScribeMarkdownEditor from './scribe/ScribeMarkdownEditor.vue'
import { summaryPromptFor } from './scribe/summaryRecipes.js'

const { launchPreset, loadGraphCatalog, createGraphEntity } = vi.hoisted(() => ({
  launchPreset: vi.fn(),
  loadGraphCatalog: vi.fn(),
  createGraphEntity: vi.fn(),
}))

vi.mock('../../stores/activityRuntime.js', () => ({
  useActivityRuntimeStore: () => ({ launchPreset }),
}))

vi.mock('../../services/meetingGraphCatalog.js', () => ({
  loadMeetingGraphCatalog: loadGraphCatalog,
  createMeetingGraphEntity: createGraphEntity,
  preferredMeetingGraphScope: scopes => scopes.find(scope => scope.kind === 'team')?.id
    || scopes[0]?.id
    || '',
}))

vi.mock('../../services/meetings.js', async importOriginal => ({
  ...(await importOriginal()),
  clearMeetingsApiKey: vi.fn(),
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
  prepareMeeting: vi.fn(),
  prepareMeetingFollowUpContext: vi.fn(),
  requestMeetingMicrophonePermission: vi.fn(),
  requestMeetingSystemAudioPermission: vi.fn(),
  retranscribeMeeting: vi.fn(),
  runMeetingSummary: vi.fn(),
  searchMeetingLibrary: vi.fn(),
  retryMeetingJob: vi.fn(),
  showMeetingFiles: vi.fn(),
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
    startProjection: false,
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
    permissions: { microphone: 'granted', systemAudio: 'not-determined' },
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

function activeFollowUpDialog(wrapper, mode) {
  return wrapper.findAllComponents(ScribeFollowUpDialog).find(dialog => (
    dialog.props('open') && dialog.props('mode') === mode
  ))
}

describe('ScribeApp', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(listenToMeetingEvents).mockReset().mockResolvedValue(vi.fn())
    vi.mocked(loadMeetingSnapshot).mockReset().mockResolvedValue(snapshot())
    vi.mocked(loadMeetingTranscriptPage).mockReset().mockResolvedValue(transcriptPage())
    vi.mocked(requestMeetingMicrophonePermission).mockReset().mockResolvedValue(snapshot())
    vi.mocked(requestMeetingSystemAudioPermission).mockReset().mockResolvedValue(snapshot({
      permissions: { microphone: 'granted', systemAudio: 'granted' },
    }))
    vi.mocked(openMeetingSystemAudioSettings).mockReset().mockResolvedValue()
    vi.mocked(prepareMeeting).mockReset()
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
    vi.mocked(retryMeetingJob).mockReset()
    vi.mocked(retranscribeMeeting).mockReset().mockResolvedValue(snapshot())
    vi.mocked(prepareMeetingFollowUpContext).mockReset().mockResolvedValue({
      meetingId: 'm1',
      transcriptRevision: 2,
      transcriptPath: '/private/mimir/m1/followups/activity-context-2/transcript.jsonl',
    })
    vi.mocked(runMeetingSummary).mockReset().mockResolvedValue(snapshot())
    vi.mocked(searchMeetingLibrary).mockReset().mockResolvedValue([])
    launchPreset.mockReset().mockResolvedValue({ id: 'agent:follow-up' })
    loadGraphCatalog.mockReset().mockResolvedValue({ scopes: [], projects: [], people: [] })
    createGraphEntity.mockReset()
    vi.mocked(showMeetingFiles).mockReset()
  })

  it('reloads graph context when Scribe becomes active', async () => {
    const wrapper = mount(ScribeApp, { props: { workspacePath: '/work', active: false } })
    await flushPromises()
    expect(loadGraphCatalog).not.toHaveBeenCalled()

    await wrapper.setProps({ active: true })
    await flushPromises()

    expect(loadGraphCatalog).toHaveBeenCalledWith('/work')
  })

  it('starts recording with one action and no participant attestation gate', async () => {
    const started = snapshot({
      revision: 2,
      startProjection: true,
      activeMeetingId: 'm1',
      meetings: [meeting({ lifecycle: 'capturing', transcription: 'initializing' })],
    })
    vi.mocked(startMeeting).mockResolvedValue(started)
    const wrapper = mount(ScribeApp, { props: { workspacePath: '/work', active: true } })
    await vi.waitFor(() => expect(wrapper.get('[data-scribe-new]').attributes('disabled')).toBeUndefined())

    let finishLibraryRefresh
    vi.mocked(loadMeetingSnapshot).mockImplementation(() => new Promise(resolve => {
      finishLibraryRefresh = resolve
    }))

    expect(wrapper.get('[data-scribe-home-toolbar]').text()).not.toContain('Record this meeting')
    expect(wrapper.text()).not.toContain('Mimir records your microphone')
    expect(wrapper.get('[data-scribe-route-disclosure]').text()).toBe('Using local model')
    expect(wrapper.find('[data-scribe-consent-checkbox]').exists()).toBe(false)
    await wrapper.get('[data-scribe-new]').trigger('click')

    await vi.waitFor(() => expect(startMeeting).toHaveBeenCalledWith(expect.objectContaining({
      workspacePath: '/work',
      requestId: 'scribe-start-native',
      consentToken: 'native-secret',
    })))
    await vi.waitFor(() => expect(wrapper.get('[data-scribe-stop]').exists()).toBe(true))

    finishLibraryRefresh({ ...started, startProjection: false })
    await vi.waitFor(() => expect(loadMeetingSnapshot).toHaveBeenCalledTimes(2))
  })

  it('prepares one meeting row, saves notes, and records into that row', async () => {
    const prepared = meeting({
      id: 'prepared', title: 'Untitled meeting', lifecycle: 'arming',
      transcription: 'idle', startedAt: '2026-08-28T10:00:00.000Z', notes: '',
    })
    vi.mocked(prepareMeeting).mockResolvedValue(snapshot({
      revision: 2,
      meetings: [prepared],
    }))
    vi.mocked(updateMeeting).mockImplementation(async (_id, patch) => snapshot({
      revision: 3,
      meetings: [{ ...prepared, ...patch }],
    }))
    vi.mocked(startMeeting).mockResolvedValue(snapshot({
      revision: 4,
      activeMeetingId: 'prepared',
      meetings: [{ ...prepared, lifecycle: 'capturing', notes: 'Ask about delivery.' }],
    }))
    const wrapper = mount(ScribeApp, { props: { workspacePath: '/work', active: true } })
    await vi.waitFor(() => expect(wrapper.get('[data-scribe-prepare]').exists()).toBe(true))

    await wrapper.get('[data-scribe-prepare]').trigger('click')
    await vi.waitFor(() => expect(wrapper.get('[data-scribe-detail-notes]').exists()).toBe(true))
    const notesEditor = wrapper.findComponent(ScribeMarkdownEditor)
    notesEditor.vm.setValue('Ask about delivery.')
    notesEditor.vm.$emit('save')
    await vi.waitFor(() => expect(updateMeeting).toHaveBeenCalledWith('prepared', {
      notes: 'Ask about delivery.',
    }))

    await wrapper.get('[data-scribe-continue]').trigger('click')
    await vi.waitFor(() => expect(startMeeting).toHaveBeenCalledWith(expect.objectContaining({
      continueMeetingId: 'prepared',
      workspacePath: '/work',
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

    expect(wrapper.get('[data-scribe-route-disclosure]').text()).toBe('Using OpenAI')
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

    expect(wrapper.get('[data-scribe-candidates]').text()).toContain('Zoom may be in a call')
    await wrapper.get('[aria-label="Dismiss Zoom suggestion"]').trigger('click')
    await vi.waitFor(() => expect(dismissMeetingCandidate).toHaveBeenCalledWith('candidate-zoom'))
  })

  it('keeps Stop visible above nonblocking transcription failure', async () => {
    const active = meeting({
      lifecycle: 'capturing',
      transcription: 'failed',
      transcriptFinal: false,
      error: 'OpenAI transcription worker failed: rate_limit_exceeded (request req_123); Authorization: Bearer sk-secret-value',
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

    expect(wrapper.get('[data-scribe-error]').text()).toContain('Recording continues')
    expect(wrapper.get('[data-scribe-error]').text()).toContain('rate_limit_exceeded')
    expect(wrapper.get('[data-scribe-error]').text()).toContain('req_123')
    expect(wrapper.get('[data-scribe-error]').text()).toContain('[redacted]')
    expect(wrapper.get('[data-scribe-error]').text()).not.toContain('sk-secret-value')
    expect(wrapper.get('[data-scribe-ledger]').attributes('title')).toContain('microphone + system audio')
    await wrapper.get('[data-scribe-stop]').trigger('click')
    await vi.waitFor(() => expect(stopMeeting).toHaveBeenCalledWith('m1'))
  })

  it('advances the recording clock during silence without native events', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-02T10:00:00.000Z'))
    const active = meeting({
      lifecycle: 'capturing',
      transcription: 'listening',
      startedAt: '2026-08-02T10:00:00.000Z',
      recordingStartedAt: '2026-08-02T10:00:00.000Z',
      stoppedAt: null,
      durationMs: 0,
    })
    vi.mocked(loadMeetingSnapshot).mockResolvedValue(snapshot({
      activeMeetingId: active.id,
      meetings: [active],
    }))

    const wrapper = mount(ScribeApp, { props: { active: true } })
    await flushPromises()
    expect(wrapper.get('[data-scribe-recording-label]').text()).toContain('0:00')
    expect(wrapper.get('[data-scribe-ledger]').text()).toContain('Transcript starting')
    expect(wrapper.text()).toContain('Listening · transcript will appear shortly')

    await vi.advanceTimersByTimeAsync(3_000)
    expect(wrapper.get('[data-scribe-recording-label]').text()).toContain('0:03')

    wrapper.unmount()
    vi.useRealTimers()
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
    expect(wrapper.get('[data-scribe-ledger]').text()).toContain('Transcript live')
  })

  it('lets visible transcript segments outrank a stale preparing state after Stop', async () => {
    const active = meeting({
      lifecycle: 'finalizing',
      transcription: 'initializing',
      transcriptFinal: false,
    })
    vi.mocked(loadMeetingSnapshot).mockResolvedValue(snapshot({
      activeMeetingId: active.id,
      meetings: [active],
    }))
    vi.mocked(loadMeetingTranscriptPage).mockResolvedValue(transcriptPage({
      totalSegments: 1,
      segments: [
        { id: 's1', text: 'Already transcribed', startMs: 0, endMs: 1_000, channel: 'microphone', final: true, revision: 1 },
      ],
    }))
    const wrapper = mount(ScribeApp, { props: { active: true } })

    await vi.waitFor(() => expect(wrapper.get('[data-scribe-transcript-ledger]').text())
      .toContain('Already transcribed'))
    expect(wrapper.get('[data-scribe-ledger]').text()).toContain('Transcript live')
    expect(wrapper.get('[data-scribe-ledger]').text()).not.toContain('Preparing transcription')
  })

  it('keeps Earlier and Latest transcript navigation in the tab rail', async () => {
    const cursor = { startMs: 60_000, id: 'recent' }
    vi.mocked(loadMeetingSnapshot).mockResolvedValue(snapshot({ meetings: [meeting()] }))
    vi.mocked(loadMeetingTranscriptPage).mockImplementation(async (_id, before) => (
      before
        ? transcriptPage({
          totalSegments: 2,
          hasMore: false,
          segments: [{ id: 'older', text: 'Earlier turn', startMs: 0, endMs: 1_000, channel: 'microphone', final: true, revision: 1 }],
        })
        : transcriptPage({
        totalSegments: 2,
        hasMore: true,
        nextBefore: cursor,
        segments: [{ id: 'recent', text: 'Recent turn', startMs: 60_000, endMs: 61_000, channel: 'system', final: true, revision: 2 }],
        })
    ))
    const wrapper = mount(ScribeApp, { props: { active: true } })
    await vi.waitFor(() => expect(wrapper.get('[data-scribe-meeting-row]').exists()).toBe(true))
    await wrapper.get('[data-scribe-meeting-row]').trigger('click')
    await vi.waitFor(() => expect(wrapper.get('[data-scribe-transcript-earlier]').exists()).toBe(true))

    await wrapper.get('[data-scribe-transcript-earlier]').trigger('click')
    await vi.waitFor(() => expect(wrapper.get('[data-scribe-transcript-ledger]').text()).toContain('Earlier turn'))
    expect(loadMeetingTranscriptPage).toHaveBeenCalledWith('m1', cursor)
    expect(wrapper.get('[data-scribe-transcript-latest]').exists()).toBe(true)

    await wrapper.get('[data-scribe-transcript-latest]').trigger('click')
    await vi.waitFor(() => expect(wrapper.get('[data-scribe-transcript-ledger]').text()).toContain('Recent turn'))
    expect(loadMeetingTranscriptPage).toHaveBeenLastCalledWith('m1', null)
  })

  it('opens a summarized meeting as one document with compact header and tab actions', async () => {
    const reviewed = meeting({ summary: 'Decision captured.', summaryState: 'succeeded' })
    // Continue is a property of this completed record. It must remain
    // discoverable even when the current new-recording setup needs attention.
    vi.mocked(loadMeetingSnapshot).mockResolvedValue(snapshot({ meetings: [reviewed], models: [] }))
    vi.mocked(loadMeetingTranscriptPage).mockResolvedValue(transcriptPage({
      totalSegments: 1,
      segments: [{ id: 's1', text: 'Approved.', startMs: 0, endMs: 1_000, channel: 'microphone', final: true, revision: 1 }],
      summary: reviewed.summary,
    }))
    const wrapper = mount(ScribeApp, { props: { active: true } })
    await vi.waitFor(() => expect(wrapper.get('[data-scribe-meeting-row]').exists()).toBe(true))

    await wrapper.get('[data-scribe-meeting-row]').trigger('click')
    await vi.waitFor(() => expect(wrapper.get('[data-scribe-title]').element.value).toBe('Planning'))
    expect(wrapper.get('#scribe-detail-tab-summary').attributes('aria-selected')).toBe('true')
    expect(wrapper.get('#scribe-detail-panel-summary').text()).toContain('Decision captured')
    expect(wrapper.get('[data-scribe-detail-header]').findAll('button')).toHaveLength(3)
    expect(wrapper.get('[data-scribe-continue]').text()).toContain('Continue')
    expect(wrapper.get('[data-scribe-save-state]').text()).toBe('Saved')
    expect(wrapper.find('[data-scribe-detail-header] [data-scribe-settings]').exists()).toBe(false)
    expect(wrapper.get('[data-scribe-regenerate-summary]').element.compareDocumentPosition(
      wrapper.get('[data-scribe-summary-content]').element,
    ) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(wrapper.find('[data-scribe-summary-actions]').exists()).toBe(false)
  })

  it('keeps per-run summary controls in one compact dialog', async () => {
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

    await wrapper.get('[data-scribe-regenerate-summary]').trigger('click')
    const dialog = activeFollowUpDialog(wrapper, 'summary')
    expect(dialog).toBeTruthy()
    expect(dialog.props('formats').map(option => option.label)).toEqual([
      'Standard',
      'Brief',
      'Decisions + actions',
    ])
    dialog.vm.$emit('update:format', 'brief')
    await flushPromises()
    expect(activeFollowUpDialog(wrapper, 'summary').props('prompt')).toBe(summaryPromptFor('brief'))
    dialog.vm.$emit('update:prompt', 'Fine-tuned summary prompt')
    await flushPromises()
    activeFollowUpDialog(wrapper, 'summary').vm.$emit('submit')
    await vi.waitFor(() => expect(runMeetingSummary).toHaveBeenCalledWith('m1', {
      template: 'brief',
      prompt: 'Fine-tuned summary prompt',
      preset: '',
    }))
    expect(retryMeetingJob).not.toHaveBeenCalled()
  })

  it('opens a custom agent task from the detail menu', async () => {
    const reviewed = meeting({ summary: 'Decision captured.', summaryState: 'succeeded' })
    useLaunchersStore().presets = [{
      id: 'codex-review',
      title: 'Codex',
      kind: 'agent',
      binary: '/usr/bin/codex',
      args: [],
    }]
    vi.mocked(loadMeetingSnapshot).mockResolvedValue(snapshot({ meetings: [reviewed] }))
    vi.mocked(loadMeetingTranscriptPage).mockResolvedValue(transcriptPage({ summary: reviewed.summary }))
    const wrapper = mount(ScribeApp, { props: { active: true } })
    await vi.waitFor(() => expect(wrapper.get('[data-scribe-meeting-row]').exists()).toBe(true))
    await wrapper.get('[data-scribe-meeting-row]').trigger('click')

    await wrapper.get('[data-scribe-detail-overflow]').trigger('click')
    expect(wrapper.find('[data-scribe-rename-meeting]').exists()).toBe(false)
    expect(wrapper.find('[data-scribe-continue-meeting]').exists()).toBe(false)
    await wrapper.get('[data-scribe-ask-agent]').trigger('click')
    const dialog = activeFollowUpDialog(wrapper, 'agent')
    expect(dialog).toBeTruthy()
    expect(dialog.props('agents').map(option => option.label)).toContain('Codex')
    dialog.vm.$emit('update:prompt', 'Challenge the release plan.')
    await flushPromises()
    activeFollowUpDialog(wrapper, 'agent').vm.$emit('submit')

    await vi.waitFor(() => expect(launchPreset).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'codex-review' }),
      '/work',
      {
        title: 'Follow up · Planning',
        retention: 'durable',
        source: { type: 'scribe-follow-up', meetingId: 'm1' },
        env: {
          MIMIR_MEETING_ID: 'm1',
          MIMIR_MEETING_TRANSCRIPT_PATH: '/private/mimir/m1/followups/activity-context-2/transcript.jsonl',
          MIMIR_MEETING_TRANSCRIPT_REVISION: '2',
        },
        args: [expect.stringMatching(/Challenge the release plan[\s\S]+complete immutable meeting transcript[\s\S]+untrusted meeting data/)],
      },
    ))
    expect(prepareMeetingFollowUpContext).toHaveBeenCalledWith('m1')
  })

  it('runs a per-meeting preset draft without mutating global settings or showing KG UI', async () => {
    const reviewed = meeting({
      summary: 'Decision captured.',
      summaryState: 'succeeded',
      kgState: 'awaiting-decision',
    })
    vi.mocked(loadMeetingSnapshot).mockResolvedValue(snapshot({ meetings: [reviewed] }))
    vi.mocked(loadMeetingTranscriptPage).mockResolvedValue(transcriptPage({ summary: reviewed.summary }))
    const wrapper = mount(ScribeApp, { props: { active: true } })
    await vi.waitFor(() => expect(wrapper.get('[data-scribe-meeting-row]').exists()).toBe(true))
    await wrapper.get('[data-scribe-meeting-row]').trigger('click')
    await wrapper.get('[data-scribe-regenerate-summary]').trigger('click')
    const dialog = activeFollowUpDialog(wrapper, 'summary')
    dialog.vm.$emit('update:format', 'decisions-actions')
    await flushPromises()
    activeFollowUpDialog(wrapper, 'summary').vm.$emit('submit')

    await vi.waitFor(() => expect(runMeetingSummary).toHaveBeenCalledWith('m1', {
      template: 'decisions-actions',
      prompt: summaryPromptFor('decisions-actions'),
      preset: '',
    }))
    expect(retryMeetingJob).not.toHaveBeenCalled()
    expect(wrapper.find('[data-scribe-kg-offer]').exists()).toBe(false)
  })

  it('shows durable summary progress instead of leaving the action at Starting', async () => {
    const running = meeting({
      summaryState: 'running',
      jobs: [{ id: 'summary-1', kind: 'title-summary', status: 'running', attempt: 1, error: null }],
    })
    vi.mocked(loadMeetingSnapshot).mockResolvedValue(snapshot({ meetings: [running] }))
    const wrapper = mount(ScribeApp, { props: { active: true } })
    await vi.waitFor(() => expect(wrapper.get('[data-scribe-meeting-row]').exists()).toBe(true))
    await wrapper.get('[data-scribe-meeting-row]').trigger('click')
    await wrapper.get('#scribe-detail-tab-summary').trigger('click')

    expect(wrapper.find('[data-scribe-regenerate-summary]').exists()).toBe(false)
    expect(wrapper.find('[data-scribe-create-summary]').exists()).toBe(false)
    expect(wrapper.get('[data-scribe-summary-content]').text()).toBe('Creating…')
    expect(wrapper.text()).not.toContain('Starting…')
  })

  it('explains that transcript recovery blocks summary instead of showing generic waiting', async () => {
    const interrupted = meeting({
      lifecycle: 'interrupted',
      transcription: 'failed',
      transcriptFinal: false,
      segmentCount: 2,
      jobs: [{
        id: 'transcription-1',
        kind: 'transcription',
        status: 'failed',
        attempt: 1,
        error: 'OpenAI returned an invalid empty segment',
      }],
    })
    vi.mocked(loadMeetingSnapshot).mockResolvedValue(snapshot({ meetings: [interrupted] }))
    const wrapper = mount(ScribeApp, { props: { active: true } })
    await vi.waitFor(() => expect(wrapper.get('[data-scribe-meeting-row]').exists()).toBe(true))
    await wrapper.get('[data-scribe-meeting-row]').trigger('click')
    await wrapper.get('#scribe-detail-tab-summary').trigger('click')

    expect(wrapper.get('[data-scribe-summary-content]').text()).toContain(
      'Retranscribe this meeting before creating a summary',
    )
    expect(wrapper.get('[data-scribe-summary-content]').text()).toContain('invalid empty segment')
    expect(wrapper.get('[data-scribe-summary-content]').text()).not.toContain(
      'Waiting for final transcript',
    )
  })

  it('trusts a failed summary job over stale running state and exposes a safe retry', async () => {
    const failed = meeting({
      summaryState: 'running',
      jobs: [{
        id: 'summary-1',
        kind: 'title-summary',
        status: 'failed',
        attempt: 3,
        error: 'OpenAI returned insufficient_quota; api_key=sk-summary-secret',
      }],
    })
    vi.mocked(loadMeetingSnapshot).mockResolvedValue(snapshot({ meetings: [failed] }))
    const wrapper = mount(ScribeApp, { props: { active: true } })
    await vi.waitFor(() => expect(wrapper.get('[data-scribe-meeting-row]').exists()).toBe(true))
    await wrapper.get('[data-scribe-meeting-row]').trigger('click')
    await wrapper.get('#scribe-detail-tab-summary').trigger('click')

    const retry = wrapper.get('[data-scribe-create-summary]')
    expect(retry.text()).toBe('Try again')
    expect(retry.attributes('disabled')).toBeUndefined()
    expect(wrapper.get('[data-scribe-summary-content]').text()).toContain('insufficient_quota')
    expect(wrapper.get('[data-scribe-summary-content]').text()).toContain('[redacted]')
    expect(wrapper.get('[data-scribe-summary-content]').text()).not.toContain('sk-summary-secret')
    await retry.trigger('click')
    const dialog = activeFollowUpDialog(wrapper, 'summary')
    dialog.vm.$emit('submit')
    await vi.waitFor(() => expect(runMeetingSummary).toHaveBeenCalledWith('m1', expect.objectContaining({
      template: 'standard',
    })))
  })

  it('edits title and Markdown summary while keeping tags out of the review surface', async () => {
    const complete = meeting({ summary: 'Initial summary.', tags: ['release', 'customer'] })
    vi.mocked(loadMeetingSnapshot).mockResolvedValue(snapshot({ meetings: [complete] }))
    vi.mocked(loadMeetingTranscriptPage).mockResolvedValue(transcriptPage({
      totalSegments: 1,
      summary: complete.summary,
    }))
    vi.mocked(updateMeeting).mockResolvedValue(snapshot({ meetings: [complete] }))
    const wrapper = mount(ScribeApp, { props: { active: true } })
    await vi.waitFor(() => expect(wrapper.get('[data-scribe-meeting-row]').exists()).toBe(true))
    await wrapper.get('[data-scribe-meeting-row]').trigger('click')
    await wrapper.get('[data-scribe-title]').setValue('Reviewed outcome')
    await wrapper.get('[data-scribe-title]').trigger('blur')
    const summaryEditor = wrapper.findAllComponents(ScribeMarkdownEditor).at(-1)
    summaryEditor.vm.setValue('## Outcome\n\n- Reviewed summary.')
    summaryEditor.vm.$emit('save')

    await vi.waitFor(() => {
      expect(updateMeeting).toHaveBeenCalledWith('m1', { title: 'Reviewed outcome' })
      expect(updateMeeting).toHaveBeenCalledWith('m1', expect.objectContaining({
        summary: '## Outcome\n\n- Reviewed summary.',
      }))
    })
    expect(wrapper.find('[data-scribe-reviewed-tags]').exists()).toBe(false)
    expect(wrapper.find('[data-scribe-edit-tags-inline]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('customer')
  })

  it('opens the one global Scribe settings surface', async () => {
    vi.mocked(loadMeetingSnapshot).mockResolvedValue(snapshot({
      permissions: { microphone: 'denied', systemAudio: 'not-determined' },
    }))
    const wrapper = mount(ScribeApp, { props: { active: true } })
    await vi.waitFor(() => expect(wrapper.get('[data-scribe-settings]').exists()).toBe(true))
    await wrapper.get('[data-scribe-settings]').trigger('click')

    expect(wrapper.emitted('openSettings')).toEqual([['scribe']])
    expect(wrapper.find('[data-scribe-settings-panel]').exists()).toBe(false)
  })

  it('requires native confirmation before permanently deleting a meeting', async () => {
    vi.mocked(loadMeetingSnapshot).mockResolvedValue(snapshot({ meetings: [meeting()] }))
    vi.mocked(deleteMeeting).mockResolvedValue(snapshot({ revision: 2, meetings: [] }))
    const wrapper = mount(ScribeApp, { props: { active: true } })
    await vi.waitFor(() => expect(wrapper.get('[data-scribe-meeting-row]').exists()).toBe(true))
    await wrapper.get('[data-scribe-meeting-row]').trigger('click')
    await wrapper.get('[data-scribe-detail-overflow]').trigger('click')
    expect(wrapper.get('[data-scribe-delete-meeting]').isVisible()).toBe(true)
    await wrapper.get('[data-scribe-delete-meeting]').trigger('click')

    await vi.waitFor(() => expect(deleteMeeting).toHaveBeenCalledWith('m1', 'all'))
  })

  it('reveals current Markdown beside the owned meeting audio', async () => {
    vi.mocked(loadMeetingSnapshot).mockResolvedValue(snapshot({ meetings: [meeting()] }))
    vi.mocked(showMeetingFiles).mockResolvedValue({
      format: 'files',
      path: '/meetings/m1',
    })
    const wrapper = mount(ScribeApp, { props: { active: true } })
    await vi.waitFor(() => expect(wrapper.get('[data-scribe-meeting-row]').exists()).toBe(true))
    await wrapper.get('[data-scribe-meeting-row]').trigger('click')
    await wrapper.get('[data-scribe-detail-overflow]').trigger('click')
    await wrapper.get('[data-scribe-show-files]').trigger('click')

    await vi.waitFor(() => expect(showMeetingFiles).toHaveBeenCalledWith('m1'))
  })

  it('opens the row menu by right-click and renames without entering notes editing', async () => {
    vi.mocked(loadMeetingSnapshot).mockResolvedValue(snapshot({ meetings: [meeting()] }))
    vi.mocked(updateMeeting).mockResolvedValue(snapshot({ meetings: [meeting({ title: 'Renamed' })] }))
    const wrapper = mount(ScribeApp, { props: { active: true } })
    await vi.waitFor(() => expect(wrapper.get('[data-scribe-meeting-row]').exists()).toBe(true))

    await wrapper.get('[data-scribe-meeting-row]').trigger('contextmenu', { clientX: 80, clientY: 90 })
    expect(wrapper.get('[data-scribe-meeting-menu]').attributes('role')).toBe('menu')
    await wrapper.get('[data-scribe-rename-meeting]').trigger('click')
    expect(wrapper.get('[data-scribe-edit-title]').exists()).toBe(true)
    expect(wrapper.find('[data-scribe-edit-summary]').exists()).toBe(false)
    await wrapper.get('[data-scribe-edit-title]').setValue('Renamed')
    await wrapper.get('[data-scribe-save-review]').trigger('submit')

    await vi.waitFor(() => expect(updateMeeting).toHaveBeenCalledWith('m1', { title: 'Renamed' }))
  })

  it('offers manual retranscription for an interrupted recording', async () => {
    const interrupted = meeting({ lifecycle: 'interrupted' })
    vi.mocked(loadMeetingSnapshot).mockResolvedValue(snapshot({ meetings: [interrupted] }))
    const wrapper = mount(ScribeApp, { props: { active: true } })
    await vi.waitFor(() => expect(wrapper.get('[data-scribe-meeting-row]').exists()).toBe(true))

    await wrapper.get('[data-scribe-meeting-row]').trigger('keydown', { key: 'F10', shiftKey: true })
    await wrapper.get('[data-scribe-recover-meeting]').trigger('click')
    await vi.waitFor(() => expect(retranscribeMeeting).toHaveBeenCalledWith('m1'))
  })

  it('keeps durable retranscription progress visible and prevents duplicate repair', async () => {
    const queued = meeting({
      lifecycle: 'failed',
      error: 'Live transcription stopped',
      jobs: [{ id: 'repair-1', kind: 'transcription', status: 'queued', attempt: 1, error: null }],
    })
    vi.mocked(loadMeetingSnapshot).mockResolvedValue(snapshot({ meetings: [queued] }))
    const wrapper = mount(ScribeApp, { props: { active: true } })
    await vi.waitFor(() => expect(wrapper.get('[data-scribe-meeting-row]').exists()).toBe(true))

    await wrapper.get('[data-scribe-meeting-row]').trigger('click')

    expect(wrapper.get('[data-scribe-recovery-status]').text()).toContain('queued')
    expect(wrapper.get('[data-scribe-recover-inline]').text()).toBe('Queued')
    expect(wrapper.get('[data-scribe-recover-inline]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-scribe-recover-inline]').trigger('click')
    expect(retranscribeMeeting).not.toHaveBeenCalled()
  })

  it('offers manual retranscription for a legacy repair lifecycle', async () => {
    const interrupted = meeting({ lifecycle: 'needs_repair' })
    vi.mocked(loadMeetingSnapshot).mockResolvedValue(snapshot({ meetings: [interrupted] }))
    const wrapper = mount(ScribeApp, { props: { active: true } })
    await vi.waitFor(() => expect(wrapper.get('[data-scribe-meeting-row]').exists()).toBe(true))

    await wrapper.get('[data-scribe-meeting-row]').trigger('keydown', { key: 'F10', shiftKey: true })
    await wrapper.get('[data-scribe-recover-meeting]').trigger('click')
    await vi.waitFor(() => expect(retranscribeMeeting).toHaveBeenCalledWith('m1'))
  })

  it('does not offer manual retranscription while a meeting is still finalizing', async () => {
    const interrupted = meeting({ lifecycle: 'finalizing', error: 'Finalizing transcript' })
    vi.mocked(loadMeetingSnapshot).mockResolvedValue(snapshot({ meetings: [interrupted] }))
    const wrapper = mount(ScribeApp, { props: { active: true } })
    await vi.waitFor(() => expect(wrapper.get('[data-scribe-meeting-row]').exists()).toBe(true))

    await wrapper.get('[data-scribe-meeting-row]').trigger('keydown', { key: 'F10', shiftKey: true })
    expect(wrapper.get('[data-scribe-meeting-menu]').exists()).toBe(true)
    expect(wrapper.find('[data-scribe-recover-meeting]').exists()).toBe(false)
    await wrapper.get('[data-scribe-meeting-row]').trigger('click')
    expect(wrapper.find('[data-scribe-recover-inline]').exists()).toBe(false)
    expect(retranscribeMeeting).not.toHaveBeenCalled()
  })

  it('offers manual retranscription for a failed terminal meeting', async () => {
    const failed = meeting({ lifecycle: 'failed', error: 'Provider rejected the audio' })
    vi.mocked(loadMeetingSnapshot).mockResolvedValue(snapshot({ meetings: [failed] }))
    const wrapper = mount(ScribeApp, { props: { active: true } })
    await vi.waitFor(() => expect(wrapper.get('[data-scribe-meeting-row]').exists()).toBe(true))

    await wrapper.get('[data-scribe-meeting-row]').trigger('keydown', { key: 'F10', shiftKey: true })
    await wrapper.get('[data-scribe-recover-meeting]').trigger('click')
    await vi.waitFor(() => expect(retranscribeMeeting).toHaveBeenCalledWith('m1'))
  })

  it('debounces full-library search, shows one transcript snippet, and clears it', async () => {
    vi.mocked(searchMeetingLibrary).mockResolvedValue([{
      meeting: meeting({ id: 'older', title: 'Older release review' }),
      matched: {
        title: true,
        summary: false,
        tags: false,
        transcript: [
          { meetingId: 'older', segmentId: 's1', startMs: 0, text: 'First release evidence.' },
          { meetingId: 'older', segmentId: 's2', startMs: 1_000, text: 'Second evidence.' },
        ],
      },
    }])
    const wrapper = mount(ScribeApp, { props: { active: true } })
    await vi.waitFor(() => expect(wrapper.get('[data-scribe-meeting-search]').exists()).toBe(true))
    expect(wrapper.get('[data-scribe-meeting-search]').attributes('placeholder')).toBe('Search')

    await wrapper.get('[data-scribe-meeting-search]').setValue('re')
    await new Promise(resolve => setTimeout(resolve, 275))
    expect(searchMeetingLibrary).not.toHaveBeenCalled()

    await wrapper.get('[data-scribe-meeting-search]').setValue('release')
    expect(searchMeetingLibrary).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(searchMeetingLibrary).toHaveBeenCalledWith('release'))
    expect(wrapper.get('[data-scribe-search-result]').text()).toContain('Older release review')
    expect(wrapper.get('[data-scribe-search-snippet]').text()).toBe('First release evidence.')
    expect(wrapper.findAll('[data-scribe-search-snippet]')).toHaveLength(1)

    await wrapper.get('[data-scribe-clear-search]').trigger('click')
    expect(wrapper.get('[data-scribe-meeting-search]').element.value).toBe('')
    expect(wrapper.find('[data-scribe-search-result]').exists()).toBe(false)
  })

  it('shows compact Project, multi-People, and Scope context in the library', async () => {
    vi.mocked(loadMeetingSnapshot).mockResolvedValue(snapshot({
      meetings: [meeting({
        graphDraft: {
          projectResolved: true,
          projectId: 'project-eversana',
          peopleIds: ['person-ana', 'person-paul', 'person-chris'],
          scopeId: 'team:main',
        },
      })],
    }))
    loadGraphCatalog.mockResolvedValue({
      projects: [{ id: 'project-eversana', title: 'Eversana' }],
      people: [
        { id: 'person-ana', title: 'Ana Smith' },
        { id: 'person-paul', title: 'Paul Miller' },
        { id: 'person-chris', title: 'Chris Reed' },
      ],
      scopes: [{ id: 'team:main', kind: 'team' }],
    })
    const wrapper = mount(ScribeApp, { props: { workspacePath: '/work', active: true } })
    await vi.waitFor(() => expect(wrapper.findAll('[data-scribe-row-context]')).toHaveLength(3))

    const context = wrapper.findAll('[data-scribe-row-context]')
    expect(context.map(item => item.attributes('data-kind'))).toEqual(['project', 'people', 'scope'])
    expect(context.map(item => item.text())).toEqual([
      'Project: Eversana',
      'People: Ana Smith, Paul Miller +1',
      'Scope: Team',
    ])
    expect(context[1].attributes('title')).toBe('People: Ana Smith, Paul Miller, Chris Reed')
  })

  it('keeps today first, then groups older unresolved meetings before earlier dates', async () => {
    const now = Date.now()
    vi.mocked(loadMeetingSnapshot).mockResolvedValue(snapshot({
      meetings: [
        meeting({ id: 'week', title: 'This week', startedAt: new Date(now - 3 * 86_400_000).toISOString() }),
        meeting({ id: 'old', title: 'Older', startedAt: new Date(now - 14 * 86_400_000).toISOString() }),
        meeting({ id: 'today', title: 'Today item', lifecycle: 'needs_repair', startedAt: new Date(now).toISOString() }),
        meeting({ id: 'repair', title: 'Interrupted', lifecycle: 'needs_repair', startedAt: new Date(now - 20 * 86_400_000).toISOString() }),
      ],
    }))
    const wrapper = mount(ScribeApp, { props: { active: true } })
    await vi.waitFor(() => expect(wrapper.findAll('[data-scribe-meeting-group]')).toHaveLength(4))

    expect(wrapper.findAll('[data-scribe-meeting-group]').map(group => group.attributes('data-group')))
      .toEqual(['today', 'unresolved', 'previous-7-days', 'earlier'])
    expect(wrapper.findAll('[data-scribe-meeting-row]').map(row => row.text())).toEqual([
      expect.stringContaining('Today item'),
      expect.stringContaining('Interrupted'),
      expect.stringContaining('This week'),
      expect.stringContaining('Older'),
    ])
  })
})
