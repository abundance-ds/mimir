import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import {
  checkMeetingAudio,
  decideMeetingKgProposal,
  dismissMeetingCandidate,
  fileMeetingToGraph,
  issueMeetingStartConsent,
  listenToMeetingRecordRequests,
  listenToMeetingAudioTestEvents,
  listenToMeetingEvents,
  loadMeetingMicrophones,
  loadMeeting,
  loadMeetingSnapshot,
  loadMeetingTranscriptPage,
  normalizeMeetingTranscriptPage,
  normalizeMeetingSnapshot,
  openMeetingSystemAudioSettings,
  prepareMeeting,
  prepareMeetingFollowUpContext,
  requestMeetingMicrophonePermission,
  requestMeetingSystemAudioPermission,
  retranscribeMeeting,
  runMeetingSummary,
  searchMeetingLibrary,
  showMeetingFiles,
  signalMeetingStop,
  startMeetingAudioTest,
  stopMeetingAudioTest,
  startMeeting,
  takeMeetingRecordRequests,
  updateMeeting,
  updateMeetingsConfig,
} from './meetings.js'

describe('meetings service', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset()
    vi.mocked(listen).mockReset().mockResolvedValue(vi.fn())
  })

  it('normalizes a durable revisioned snapshot and orders newest meetings first', () => {
    expect(normalizeMeetingSnapshot({
      revision: 9,
      active_meeting_id: 'live',
      meetings: [
        { id: 'old', title: 'Old', started_at: '2026-01-01T00:00:00Z' },
        {
          id: 'live',
          title: 'Stand-up',
          lifecycle: 'capturing',
          started_at: '2026-01-02T00:00:00Z',
          transcript_revision: 7,
          transcript_final: false,
          segments: [{ id: 's1', text: 'Hello', start_ms: 4, end_ms: 20 }],
        },
      ],
      config: { transcription_mode: 'custom', retention_days: 30 },
      permissions: { microphone: 'granted', system_audio: 'denied' },
    })).toMatchObject({
      revision: 9,
      activeMeetingId: 'live',
      activeMeeting: { id: 'live', lifecycle: 'capturing', transcriptRevision: 7 },
      meetings: [{ id: 'live' }, { id: 'old' }],
      config: { transcriptionMode: 'custom', retentionDays: 30 },
      permissions: { microphone: 'granted', systemAudio: 'denied' },
    })
  })

  it('normalizes only bounded audio-check statuses from native IPC', async () => {
    vi.mocked(invoke).mockResolvedValue({
      microphone: 'signal',
      system_audio: 'unexpected-provider-detail',
      microphone_level: 72,
      system_audio_level: 140,
      runtime_identity: 'mimir',
      observed_ms: 4_000,
    })
    await expect(checkMeetingAudio()).resolves.toEqual({
      microphone: 'signal',
      systemAudio: 'no-data',
      microphoneLevel: 72,
      systemAudioLevel: 100,
      runtimeIdentity: 'mimir',
      observedMs: 4_000,
    })
    expect(invoke).toHaveBeenCalledWith('meetings_check_audio')
  })

  it('normalizes stable microphones and bounded live level events', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      selected_device_id: 'uid-selected',
      selected_available: false,
      effective_device_id: 'uid-default',
      fallback_reason: 'Selected microphone is unavailable; using MacBook Microphone.',
      devices: [
        { id: 'uid-default', name: 'MacBook Microphone', is_default: true },
        { id: '', name: 'Invalid' },
      ],
    })
    await expect(loadMeetingMicrophones()).resolves.toEqual({
      selectedDeviceId: 'uid-selected',
      selectedAvailable: false,
      effectiveDeviceId: 'uid-default',
      fallbackReason: 'Selected microphone is unavailable; using MacBook Microphone.',
      devices: [{ id: 'uid-default', name: 'MacBook Microphone', isDefault: true }],
    })

    let eventHandler
    vi.mocked(listen).mockImplementationOnce(async (_name, handler) => {
      eventHandler = handler
      return vi.fn()
    })
    const received = vi.fn()
    await listenToMeetingAudioTestEvents(received)
    eventHandler({ payload: {
      test_id: 'test-1',
      sequence: 7,
      state: 'running',
      runtime_identity: 'mimir',
      microphone: { state: 'signal', level: 73 },
      system_audio: { state: 'provider-detail', level: 140, error: 'bounded' },
      microphone_device_name: 'MacBook Microphone',
    } })
    expect(received).toHaveBeenCalledWith({
      testId: 'test-1',
      sequence: 7,
      state: 'running',
      runtimeIdentity: 'mimir',
      microphone: { state: 'signal', level: 73, error: null },
      systemAudio: { state: 'no-data', level: 100, error: 'bounded' },
      microphoneDeviceId: null,
      microphoneDeviceName: 'MacBook Microphone',
      fallbackFromMicrophoneDeviceId: null,
    })

    vi.mocked(invoke).mockResolvedValueOnce({ test_id: 'test-1' }).mockResolvedValueOnce()
    await expect(startMeetingAudioTest()).resolves.toEqual({
      testId: 'test-1',
      requestedMicrophoneDeviceId: null,
    })
    await stopMeetingAudioTest('test-1')
    expect(invoke).toHaveBeenLastCalledWith('meetings_audio_test_stop', { testId: 'test-1' })
  })

  it('signals native capture before the full Stop drain', async () => {
    vi.mocked(invoke).mockResolvedValue()

    await signalMeetingStop('meeting-live-01')

    expect(invoke).toHaveBeenCalledWith('meetings_signal_stop', {
      meetingId: 'meeting-live-01',
    })
  })

  it('normalizes bounded reviewed tags and validates tag updates before IPC', async () => {
    const normalized = normalizeMeetingSnapshot({
      revision: 1,
      meetings: [{
        id: 'reviewed',
        tags: [' release ', 'customer', 'release', '', 'x'.repeat(81)],
      }],
    })
    expect(normalized.meetings[0].tags).toEqual(['release', 'customer'])

    vi.mocked(invoke).mockResolvedValue({ revision: 2, meetings: [] })
    await updateMeeting('reviewed', {
      tags: [' release ', 'customer', 'release'],
    })
    expect(invoke).toHaveBeenCalledWith('meetings_update', {
      meetingId: 'reviewed',
      patch: { tags: ['release', 'customer'] },
    })

    vi.mocked(invoke).mockClear()
    await expect(updateMeeting('reviewed', {
      tags: Array.from({ length: 65 }, (_, index) => `tag-${index}`),
    })).rejects.toThrow('64')
    await expect(updateMeeting('reviewed', {
      tags: ['x'.repeat(81)],
    })).rejects.toThrow('80')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('keeps blank versus None in the small meeting Graph draft', async () => {
    const normalized = normalizeMeetingSnapshot({
      revision: 1,
      meetings: [{
        id: 'prepared',
        graph_draft: {
          project_resolved: true,
          project_id: null,
          people_ids: ['person-ana', 'person-ana'],
          scope_id: 'team:main',
        },
      }],
    })
    expect(normalized.meetings[0].graphDraft).toEqual({
      projectResolved: true,
      projectId: null,
      peopleIds: ['person-ana'],
      scopeId: 'team:main',
    })

    vi.mocked(invoke).mockResolvedValue({ revision: 2, meetings: [] })
    await updateMeeting('prepared', {
      graphDraft: {
        projectResolved: false,
        projectId: 'must-be-cleared',
        peopleIds: [],
        scopeId: null,
      },
    })
    expect(invoke).toHaveBeenCalledWith('meetings_update', {
      meetingId: 'prepared',
      patch: {
        graphDraft: {
          projectResolved: false,
          projectId: null,
          peopleIds: [],
          scopeId: null,
        },
      },
    })
  })

  it('prepares a notes-first meeting and loads its exact detail', async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce({
        revision: 2,
        meetings: [{ id: 'prepared', lifecycle: 'arming', notes: 'Ask about timing.' }],
      })
      .mockResolvedValueOnce({
        id: 'prepared', lifecycle: 'arming', notes: 'Ask about timing.', graph_node_id: null,
      })

    await expect(prepareMeeting({ workspacePath: '/work' })).resolves.toMatchObject({
      meetings: [{ id: 'prepared', lifecycle: 'arming', notes: 'Ask about timing.' }],
    })
    expect(invoke).toHaveBeenNthCalledWith(1, 'meetings_prepare', {
      request: { title: null, workspacePath: '/work' },
    })
    await expect(loadMeeting('prepared')).resolves.toMatchObject({
      id: 'prepared', notes: 'Ask about timing.', graphNodeId: null,
    })
    expect(invoke).toHaveBeenNthCalledWith(2, 'meetings_get', { meetingId: 'prepared' })
  })

  it('files one summary with only the selected Graph relationships', async () => {
    vi.mocked(invoke).mockResolvedValue({ id: 'meeting-1', kind: 'meeting' })

    await expect(fileMeetingToGraph({
      meetingId: 'meeting-1',
      scopeId: 'team:main',
      projectId: '',
      peopleIds: ['person-ana', 'person-ana', ' person-lee '],
    })).resolves.toEqual({ id: 'meeting-1', kind: 'meeting' })
    expect(invoke).toHaveBeenCalledWith('meetings_file_to_graph', {
      request: {
        meetingId: 'meeting-1',
        scopeId: 'team:main',
        projectId: null,
        peopleIds: ['person-ana', 'person-lee'],
      },
    })
  })

  it('requests explicit retranscription without a renderer consent checkbox', async () => {
    vi.mocked(invoke).mockResolvedValue({
      revision: 12,
      meetings: [{ id: 'retained-audio', transcription: 'batch' }],
    })

    await expect(retranscribeMeeting('retained-audio')).resolves.toMatchObject({
      revision: 12,
      meetings: [{ id: 'retained-audio', transcription: 'batch' }],
    })
    expect(invoke).toHaveBeenCalledWith('meetings_retranscribe', {
      meetingId: 'retained-audio',
    })
  })

  it('prepares immutable transcript context before opening a custom agent', async () => {
    vi.mocked(invoke).mockResolvedValue({
      meetingId: 'reviewed',
      transcriptRevision: 7,
      transcriptPath: '/private/mimir/reviewed/transcript.jsonl',
    })

    await expect(prepareMeetingFollowUpContext('reviewed')).resolves.toEqual({
      meetingId: 'reviewed',
      transcriptRevision: 7,
      transcriptPath: '/private/mimir/reviewed/transcript.jsonl',
    })
    expect(invoke).toHaveBeenCalledWith('meetings_follow_up_context', {
      meetingId: 'reviewed',
    })
  })

  it('sends a fine-tuned summary recipe as one per-run native request', async () => {
    vi.mocked(invoke).mockResolvedValue({ revision: 4, meetings: [] })

    await runMeetingSummary('reviewed', {
      template: 'brief',
      prompt: 'Lead with the decision, then list owners.',
      preset: 'codex-review',
    })

    expect(invoke).toHaveBeenCalledWith('meetings_run_summary', {
      meetingId: 'reviewed',
      request: {
        template: 'brief',
        prompt: 'Lead with the decision, then list owners.',
        preset: 'codex-review',
      },
    })
    await expect(runMeetingSummary('reviewed', {
      template: 'brief', prompt: '  ', preset: '',
    })).rejects.toThrow('summary prompt')
  })

  it('searches the complete native meeting library and bounds transcript evidence', async () => {
    vi.mocked(invoke).mockResolvedValue([{
      meeting: { id: 'm1', title: 'Launch review', lifecycle: 'ready' },
      matched: {
        title: true,
        summary: false,
        tags: true,
        transcript: Array.from({ length: 8 }, (_, index) => ({
          meeting_id: 'm1',
          segment_id: `s${index}`,
          start_ms: index * 1000,
          text: `release evidence ${index}`,
        })),
      },
    }])

    const [result] = await searchMeetingLibrary(' release ', 500)
    expect(result).toMatchObject({
      meeting: { id: 'm1', title: 'Launch review' },
      matched: { title: true, tags: true },
    })
    expect(result.matched.transcript[0]).toMatchObject({ segmentId: 's0' })
    expect(result.matched.transcript).toHaveLength(3)
    expect(invoke).toHaveBeenNthCalledWith(1, 'meetings_search_library', {
      query: 'release', limit: 100,
    })
    await expect(searchMeetingLibrary('re')).resolves.toEqual([])
  })

  it('acquires native consent authority and starts only with its opaque grant', async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce({
        token: 'native-secret',
        requestId: 'scribe-start-native',
        expiresInMs: 45_000,
        disclosure: { transcriptionMode: 'local', model: 'whisper-small' },
      })
      .mockResolvedValueOnce({ revision: 1, meetings: [] })
    const consent = await issueMeetingStartConsent({
      transcriptionMode: 'local',
      model: 'whisper-small',
    })
    await startMeeting({
      title: 'Architecture',
      workspacePath: '/work',
      requestId: consent.requestId,
      consentToken: consent.token,
    })
    expect(invoke).toHaveBeenNthCalledWith(1, 'meetings_issue_start_consent', {
      disclosure: {
        candidateId: null,
        candidateAppName: null,
        continueMeetingId: null,
        transcriptionMode: 'local',
        destination: null,
        model: 'whisper-small',
      },
    })
    expect(invoke).toHaveBeenCalledWith('meetings_start', {
      request: {
        requestId: 'scribe-start-native',
        title: 'Architecture',
        workspacePath: '/work',
        candidateId: null,
        continueMeetingId: null,
        consentToken: 'native-secret',
      },
    })
  })

  it('exposes the deliberate microphone permission action without starting capture', async () => {
    vi.mocked(invoke).mockResolvedValue({
      revision: 2,
      meetings: [],
      permissions: { microphone: 'granted', systemAudio: 'not-determined' },
    })

    await expect(requestMeetingMicrophonePermission()).resolves.toMatchObject({
      revision: 2,
      permissions: { microphone: 'granted', systemAudio: 'not-determined' },
    })
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('meetings_request_microphone_permission')
  })

  it('exposes the deliberate system-audio permission request without starting capture', async () => {
    vi.mocked(invoke).mockResolvedValue({
      revision: 2,
      meetings: [],
      permissions: { microphone: 'granted', systemAudio: 'granted' },
    })

    await expect(requestMeetingSystemAudioPermission()).resolves.toMatchObject({
      revision: 2,
      permissions: { microphone: 'granted', systemAudio: 'granted' },
    })
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('meetings_request_system_audio_permission')
  })

  it('opens only the native system-audio permission repair surface', async () => {
    vi.mocked(invoke).mockResolvedValue()

    await expect(openMeetingSystemAudioSettings()).resolves.toBeUndefined()

    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('meetings_open_system_audio_settings')
  })

  it('dismisses a detector suggestion through a human-only native command', async () => {
    vi.mocked(invoke).mockResolvedValue({ revision: 3, meetings: [], candidates: [] })
    await dismissMeetingCandidate('candidate-zoom')
    expect(invoke).toHaveBeenCalledWith('meetings_dismiss_candidate', {
      candidateId: 'candidate-zoom',
    })
  })

  it('drains and listens for native notification record requests', async () => {
    vi.mocked(invoke).mockResolvedValue([
      { candidate_id: 'candidate-zoom', app_name: 'Zoom', action: 'record' },
      { candidateId: 'candidate-chrome', appName: 'Chrome', action: 'open' },
      { candidateId: 'unknown-action', appName: 'Chrome', action: 'unexpected' },
      { candidateId: '', appName: 'Invalid' },
    ])
    await expect(takeMeetingRecordRequests()).resolves.toEqual([
      { candidateId: 'candidate-zoom', appName: 'Zoom', action: 'record' },
      { candidateId: 'candidate-chrome', appName: 'Chrome', action: 'open' },
      { candidateId: 'unknown-action', appName: 'Chrome', action: 'open' },
    ])
    expect(invoke).toHaveBeenCalledWith('meetings_take_record_requests')

    const pending = vi.fn()
    let handler
    vi.mocked(listen).mockImplementationOnce(async (event, callback) => {
      expect(event).toBe('mimir://meeting-record-requested')
      handler = callback
      return vi.fn()
    })
    await listenToMeetingRecordRequests(pending)
    handler({ payload: null })
    expect(pending).toHaveBeenCalledTimes(1)
  })

  it('rejects unsupported routing and KG decisions before IPC', async () => {
    await expect(updateMeetingsConfig({ transcriptionMode: 'surprise-cloud' }))
      .rejects.toThrow('local or custom')
    await expect(updateMeetingsConfig({ summaryTemplate: 'write-anything' }))
      .rejects.toThrow('summary format')
    await expect(decideMeetingKgProposal('meeting-1', 'publish-everywhere'))
      .rejects.toThrow('knowledge-graph draft')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('serializes user-owned summary instructions and bounded meeting-file export', async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce({ revision: 2, meetings: [] })
      .mockResolvedValueOnce({ format: 'files', path: '/meetings/meeting-1' })
      .mockResolvedValueOnce()

    await updateMeetingsConfig({ summaryPrompt: 'Lead with decisions and name each owner.' })
    expect(invoke).toHaveBeenNthCalledWith(1, 'meetings_update_config', {
      patch: { summaryPrompt: 'Lead with decisions and name each owner.' },
    })

    await expect(showMeetingFiles('meeting-1')).resolves.toEqual({
      format: 'files',
      path: '/meetings/meeting-1',
    })
    expect(invoke).toHaveBeenNthCalledWith(2, 'meetings_export', {
      meetingId: 'meeting-1',
      format: 'files',
    })
    expect(invoke).toHaveBeenNthCalledWith(3, 'reveal_in_finder', {
      path: '/meetings/meeting-1',
    })
  })

  it('installs the event listener before callers request their snapshot', async () => {
    const order = []
    vi.mocked(listen).mockImplementation(async () => {
      order.push('listener')
      return vi.fn()
    })
    vi.mocked(invoke).mockImplementation(async () => {
      order.push('snapshot')
      return { revision: 0, meetings: [] }
    })
    await listenToMeetingEvents(() => {})
    await loadMeetingSnapshot()
    expect(order).toEqual(['listener', 'listener', 'snapshot'])
  })

  it('caps transcript pages defensively before they enter renderer state', async () => {
    const oversized = Array.from({ length: 100_000 }, (_, index) => ({
      id: `segment-${index}`,
      text: 'word',
      start_ms: index * 1_000,
      end_ms: index * 1_000 + 900,
    }))
    const normalized = normalizeMeetingTranscriptPage({
      meeting_id: 'long-meeting',
      revision: 7,
      total_segments: 100_000,
      has_more: true,
      next_before: {
        start_ms: 99_750_000,
        end_ms: 99_750_900,
        segment_id: 'segment-99750',
      },
      segments: oversized,
    })
    expect(normalized.segments).toHaveLength(250)
    expect(normalized.totalSegments).toBe(100_000)

    vi.mocked(invoke).mockResolvedValue({
      meetingId: 'long-meeting',
      segments: [],
    })
    await loadMeetingTranscriptPage('long-meeting', null, 10_000)
    expect(invoke).toHaveBeenCalledWith('meetings_transcript_page', {
      meetingId: 'long-meeting',
      before: null,
      limit: 250,
    })
  })
})
