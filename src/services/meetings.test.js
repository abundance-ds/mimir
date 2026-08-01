import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import {
  checkMeetingAudio,
  decideMeetingKgProposal,
  dismissMeetingCandidate,
  issueMeetingStartConsent,
  listenToMeetingEvents,
  loadMeetingSnapshot,
  loadMeetingTranscriptPage,
  normalizeMeetingTranscriptPage,
  normalizeMeetingSnapshot,
  openMeetingSystemAudioSettings,
  requestMeetingMicrophonePermission,
  showMeetingFiles,
  startMeeting,
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
        consentToken: 'native-secret',
      },
    })
  })

  it('exposes the deliberate microphone permission action without starting capture', async () => {
    vi.mocked(invoke).mockResolvedValue({
      revision: 2,
      meetings: [],
      permissions: { microphone: 'granted', systemAudio: 'prompt-on-start' },
    })

    await expect(requestMeetingMicrophonePermission()).resolves.toMatchObject({
      revision: 2,
      permissions: { microphone: 'granted', systemAudio: 'prompt-on-start' },
    })
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('meetings_request_microphone_permission')
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
