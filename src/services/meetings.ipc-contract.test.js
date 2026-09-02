import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import {
  exportMeeting,
  issueMeetingStartConsent,
  loadMeetingLibraryPage,
  loadMeetingSnapshot,
  loadMeetingTranscriptPage,
  startMeeting,
} from './meetings.js'
import { loadIpcFixture } from '../test/ipcFixtures.js'

const expectedLiveMeeting = {
  id: 'meeting-live-01',
  title: 'Architecture sync',
  lifecycle: 'capturing',
  transcription: 'live',
  startedAt: '2026-07-31T08:00:00.000Z',
  recordingStartedAt: '2026-07-31T08:00:00.000Z',
  stoppedAt: null,
  durationMs: 754_321,
  workspacePath: null,
  sourceApp: 'Zoom',
  tags: ['architecture'],
  notes: '',
  graphNodeId: null,
  graphDraft: { projectResolved: false, projectId: null, peopleIds: [], scopeId: null },
  micMuted: false,
  channels: ['microphone', 'system'],
  gaps: [],
  gapCount: 0,
  transcriptRevision: 12,
  transcriptFinal: false,
  segmentCount: 2,
  transcriptAllFinal: false,
  segments: [],
  summary: null,
  summaryTruncated: false,
  summaryState: 'not-started',
  kgState: 'not-offered',
  jobs: [],
  error: null,
  updatedAt: '2026-07-31T08:12:34.321Z',
}

const expectedFinalMeeting = {
  id: 'meeting-final-01',
  title: 'Launch readiness',
  lifecycle: 'ready',
  transcription: 'final',
  startedAt: '2026-07-30T14:00:00.000Z',
  recordingStartedAt: null,
  stoppedAt: '2026-07-30T14:42:17.000Z',
  durationMs: 2_537_000,
  workspacePath: null,
  sourceApp: 'Google Meet',
  tags: ['launch', 'reviewed'],
  notes: '',
  graphNodeId: null,
  graphDraft: { projectResolved: false, projectId: null, peopleIds: [], scopeId: null },
  micMuted: false,
  channels: ['microphone', 'system'],
  gaps: [{
    channel: 'system',
    startMs: 1_201_000,
    endMs: 1_204_500,
    reason: 'device-change',
  }],
  gapCount: 1,
  transcriptRevision: 48,
  transcriptFinal: true,
  segmentCount: 2,
  transcriptAllFinal: true,
  segments: [],
  summary: 'Release readiness is confirmed; prepare the deployment checklist.',
  summaryTruncated: false,
  summaryState: 'succeeded',
  kgState: 'awaiting-decision',
  jobs: [
    {
      id: 'job-summary-01',
      kind: 'title-summary',
      status: 'succeeded',
      activityId: 'agent:summary-01',
      attempt: 1,
      error: null,
    },
    {
      id: 'job-kg-01',
      kind: 'kg-proposal',
      status: 'failed',
      activityId: 'agent:kg-01',
      attempt: 2,
      error: 'Agent exited before writing a proposal.',
    },
  ],
  error: null,
  updatedAt: '2026-07-30T14:43:02.000Z',
}

const expectedSnapshot = {
  revision: 73,
  meetings: [expectedLiveMeeting, expectedFinalMeeting],
  startProjection: false,
  meetingsTruncated: true,
  nextMeetingsBefore: {
    createdAt: '2026-07-30T14:00:00.000Z',
    meetingId: 'meeting-final-01',
  },
  activeMeetingId: 'meeting-live-01',
  activeMeeting: expectedLiveMeeting,
  candidates: [{
    id: 'candidate-teams-01',
    appId: 'com.microsoft.teams2',
    appName: 'Microsoft Teams',
    detectedAt: '2026-07-31T08:13:00.000Z',
    confidence: 0.98,
  }],
  config: {
    detectionEnabled: true,
    autoRecord: false,
    microphoneDeviceId: 'CoreAudio:fixture-microphone',
    transcriptionMode: 'custom',
    customUrl: 'https://speech.example.test/v1/listen',
    customModel: 'nova-3',
    apiKeyConfigured: true,
    localModel: 'whisper-small',
    summaryEnabled: true,
    summaryTemplate: 'standard',
    summaryPrompt: 'Use the BLUF approach. Return a concise Markdown document. Use these sections in order: # BLUF, # Key points, and # Follow-up. Under # BLUF, write one short paragraph of one or two sentences that states the outcome or direction. Under # Key points, write short flat bullets for only the essential decisions, facts, constraints, or risks. Under # Follow-up, combine actions, open questions, and blockers in one flat list; start each bullet with a useful bold cue such as **Action — Paul:**, **Open:**, or **Blocker:**. Omit # Follow-up when nothing useful belongs there. Prefer more short bullets over fewer long bullets. Keep each bullet to one sentence and at most 25 words. Do not repeat information across sections. Document height is not a target; achieve concision by selecting useful information, not by flattening structure. Read the user notes with judgment: use useful facts, questions, decisions, actions, or context; ignore noise or memory aids that add nothing.',
    summaryPreset: 'meeting-follow-up',
    kgPrompt: 'ask',
    kgPreset: 'meeting-kg-draft',
    retentionDays: 30,
  },
  permissions: {
    microphone: 'granted',
    systemAudio: 'granted',
  },
  models: [{
    id: 'whisper-small',
    title: 'Whisper Small',
    status: 'installed',
    bytes: 466_000_000,
    downloadedBytes: 466_000_000,
    checksum: 'sha256:fixture-checksum',
    error: null,
  }],
  diagnostic: 'Custom STT is available; local fallback is installed.',
}

describe('Scribe golden IPC contracts', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset()
  })

  it('normalizes the complete native snapshot contract without losing fields', async () => {
    vi.mocked(invoke).mockResolvedValue(loadIpcFixture('meetings_snapshot'))

    await expect(loadMeetingSnapshot()).resolves.toEqual(expectedSnapshot)
    expect(invoke).toHaveBeenCalledWith('meetings_snapshot')
  })

  it('normalizes the bounded library page and its opaque cursor', async () => {
    vi.mocked(invoke).mockResolvedValue(loadIpcFixture('meetings_library_page'))

    await expect(loadMeetingLibraryPage(null, 200)).resolves.toEqual({
      meetings: [expectedFinalMeeting],
      hasMore: true,
      nextBefore: {
        createdAt: '2026-07-30T14:00:00.000Z',
        meetingId: 'meeting-final-01',
      },
    })
    expect(invoke).toHaveBeenCalledWith('meetings_library_page', {
      before: null,
      limit: 200,
    })
  })

  it('normalizes transcript detail separately from bounded library metadata', async () => {
    vi.mocked(invoke).mockResolvedValue(loadIpcFixture('meetings_transcript_page'))

    await expect(loadMeetingTranscriptPage('meeting-final-01')).resolves.toEqual({
      meetingId: 'meeting-final-01',
      revision: 48,
      totalSegments: 482,
      hasMore: true,
      nextBefore: {
        startMs: 1_120,
        endMs: 3_870,
        segmentId: 'segment-final-01',
      },
      segments: [
        {
          id: 'segment-final-01',
          text: 'The release candidate passed the smoke test.',
          startMs: 1_120,
          endMs: 3_870,
          channel: 'system',
          speaker: 'Avery',
          final: true,
          revision: 47,
        },
        {
          id: 'segment-final-02',
          text: 'I will prepare the deployment checklist.',
          startMs: 4_110,
          endMs: 6_640,
          channel: 'microphone',
          speaker: 'You',
          final: true,
          revision: 48,
        },
      ],
      summary: 'Release readiness is confirmed; prepare the deployment checklist.',
    })
  })

  it('consumes the native consent grant and normalizes the start response', async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce(loadIpcFixture('meetings_issue_start_consent'))
      .mockResolvedValueOnce(loadIpcFixture('meetings_start'))

    const consent = await issueMeetingStartConsent({
      candidateId: 'candidate-teams-01',
      candidateAppName: 'Microsoft Teams',
      transcriptionMode: 'custom',
      destination: 'https://speech.example.test/v1/listen',
      model: 'nova-3',
    })
    expect(consent).toEqual({
      token: 'fixture-consent-token-never-valid',
      requestId: 'scribe-start-fixture-01',
      expiresInMs: 45_000,
      disclosure: {
        candidateId: 'candidate-teams-01',
        candidateAppName: 'Microsoft Teams',
        transcriptionMode: 'custom',
        destination: 'https://speech.example.test/v1/listen',
        model: 'nova-3',
      },
    })

    await expect(startMeeting({
      requestId: consent.requestId,
      consentToken: consent.token,
      candidateId: 'candidate-teams-01',
      title: 'Architecture sync',
    })).resolves.toEqual(expectedSnapshot)
    expect(invoke).toHaveBeenLastCalledWith('meetings_start', {
      request: {
        requestId: 'scribe-start-fixture-01',
        title: 'Architecture sync',
        workspacePath: null,
        candidateId: 'candidate-teams-01',
        continueMeetingId: null,
        consentToken: 'fixture-consent-token-never-valid',
      },
    })
  })

  it('preserves the typed export response and validates its request', async () => {
    const response = loadIpcFixture('meetings_export')
    vi.mocked(invoke).mockResolvedValue(response)

    await expect(exportMeeting('meeting-final-01', 'markdown')).resolves.toEqual({
      format: 'markdown',
      path: '/Users/me/Exports/Launch readiness.md',
    })
    expect(invoke).toHaveBeenCalledWith('meetings_export', {
      meetingId: 'meeting-final-01',
      format: 'markdown',
    })
  })
})
