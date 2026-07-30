import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import {
  decideMeetingKgProposal,
  dismissMeetingCandidate,
  listenToMeetingEvents,
  loadMeetingSnapshot,
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

  it('starts only with an explicit consent assertion', async () => {
    vi.mocked(invoke).mockResolvedValue({ revision: 1, meetings: [] })
    await startMeeting({
      title: 'Architecture',
      workspacePath: '/work',
      consentConfirmed: true,
    })
    expect(invoke).toHaveBeenNthCalledWith(1, 'meetings_request_microphone_permission')
    expect(invoke).toHaveBeenCalledWith('meetings_start', {
      request: {
        title: 'Architecture',
        workspacePath: '/work',
        candidateId: null,
        consentConfirmed: true,
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
})
