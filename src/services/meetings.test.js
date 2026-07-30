import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import {
  decideMeetingKgProposal,
  dismissMeetingCandidate,
  issueMeetingStartConsent,
  listenToMeetingEvents,
  loadMeetingSnapshot,
  loadMeetingTranscriptPage,
  normalizeMeetingTranscriptPage,
  normalizeMeetingSnapshot,
  requestMeetingMicrophonePermission,
  startMeeting,
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
    await expect(decideMeetingKgProposal('meeting-1', 'publish-everywhere'))
      .rejects.toThrow('knowledge-graph draft')
    expect(invoke).not.toHaveBeenCalled()
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
