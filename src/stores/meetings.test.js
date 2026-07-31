import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  dismissMeetingCandidate,
  issueMeetingStartConsent,
  listenToMeetingEvents,
  loadMeetingLibraryPage,
  loadMeetingSnapshot,
  loadMeetingTranscriptPage,
  requestMeetingMicrophonePermission,
  startMeeting,
  stopMeeting,
  updateMeetingsConfig,
} from '../services/meetings.js'
import { useMeetingsStore } from './meetings.js'

vi.mock('../services/meetings.js', async importOriginal => ({
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
  requestMeetingMicrophonePermission: vi.fn(),
  retryMeetingJob: vi.fn(),
  setMeetingMicMuted: vi.fn(),
  setMeetingsApiKey: vi.fn(),
  startMeeting: vi.fn(),
  stopMeeting: vi.fn(),
  updateMeeting: vi.fn(),
  updateMeetingsConfig: vi.fn(),
}))

const emptySnapshot = {
  revision: 1,
  meetings: [],
  activeMeetingId: null,
  activeMeeting: null,
  candidates: [],
  config: {
    detectionEnabled: false,
    transcriptionMode: 'local',
    customUrl: '',
    customModel: '',
    localModel: 'whisper-small',
    summaryEnabled: true,
    kgPrompt: 'ask',
  },
  permissions: { microphone: 'granted', systemAudio: 'granted' },
  models: [],
  diagnostic: null,
}

const emptyTranscriptPage = {
  meetingId: '',
  revision: 0,
  totalSegments: 0,
  hasMore: false,
  nextBefore: null,
  segments: [],
  summary: null,
}

describe('meetings store', () => {
  let eventHandler

  beforeEach(() => {
    setActivePinia(createPinia())
    eventHandler = null
    vi.mocked(listenToMeetingEvents).mockReset().mockImplementation(async handler => {
      eventHandler = handler
      return vi.fn()
    })
    vi.mocked(loadMeetingSnapshot).mockReset().mockResolvedValue(emptySnapshot)
    vi.mocked(loadMeetingLibraryPage).mockReset()
    vi.mocked(loadMeetingTranscriptPage).mockReset().mockImplementation(async meetingId => ({
      ...emptyTranscriptPage,
      meetingId,
    }))
    vi.mocked(requestMeetingMicrophonePermission).mockReset()
      .mockResolvedValue(emptySnapshot)
    vi.mocked(dismissMeetingCandidate).mockReset()
    vi.mocked(issueMeetingStartConsent).mockReset().mockResolvedValue({
      token: 'native-secret',
      requestId: 'scribe-start-native',
      expiresInMs: 45_000,
    })
    vi.mocked(startMeeting).mockReset()
    vi.mocked(stopMeeting).mockReset()
    vi.mocked(updateMeetingsConfig).mockReset()
  })

  it('installs the event listener before the first authoritative snapshot', async () => {
    const order = []
    vi.mocked(listenToMeetingEvents).mockImplementation(async handler => {
      order.push('listener')
      eventHandler = handler
      return vi.fn()
    })
    vi.mocked(loadMeetingSnapshot).mockImplementation(async () => {
      order.push('snapshot')
      return emptySnapshot
    })
    const store = useMeetingsStore()
    await store.initialize()
    expect(order).toEqual(['listener', 'snapshot'])
    expect(store.loaded).toBe(true)
  })

  it('rejects stale snapshots and accepts newer event snapshots', async () => {
    const store = useMeetingsStore()
    await store.initialize()
    expect(store.applySnapshot({ ...emptySnapshot, revision: 0 })).toBe(false)
    eventHandler({
      revision: 2,
      kind: 'capture-started',
      snapshot: {
        ...emptySnapshot,
        revision: 2,
        activeMeetingId: 'm1',
        meetings: [{
          id: 'm1',
          title: 'Design',
          lifecycle: 'capturing',
          durationMs: 0,
          segments: [],
          jobs: [],
          gaps: [],
          channels: ['microphone', 'system'],
        }],
      },
    })
    expect(store.activeMeeting?.id).toBe('m1')
    expect(store.recording).toBe(true)
  })

  it('refreshes an equal-revision projection after native platform progress', async () => {
    const store = useMeetingsStore()
    await store.initialize()
    vi.mocked(loadMeetingSnapshot).mockResolvedValue({
      ...emptySnapshot,
      models: [{ id: 'whisper-small', status: 'downloading', downloadedBytes: 1024 }],
    })

    eventHandler({ kind: 'model-progress', refresh: true })
    await vi.waitFor(() => expect(loadMeetingSnapshot).toHaveBeenCalledTimes(2))

    expect(store.models[0]?.status).toBe('downloading')
  })

  it('obtains single-use native consent after permission and prevents a second capture', async () => {
    const store = useMeetingsStore()
    await store.initialize()
    vi.mocked(startMeeting).mockResolvedValue({
      ...emptySnapshot,
      revision: 2,
      activeMeetingId: 'm1',
      meetings: [{
        id: 'm1',
        title: 'Planning',
        lifecycle: 'capturing',
        durationMs: 0,
        segments: [],
        jobs: [],
        gaps: [],
        channels: ['microphone', 'system'],
      }],
    })
    await store.start({ title: 'Planning' })
    expect(issueMeetingStartConsent).toHaveBeenCalledWith({
      candidateId: undefined,
      candidateAppName: undefined,
      transcriptionMode: 'local',
      destination: null,
      model: 'whisper-small',
    })
    expect(startMeeting).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'scribe-start-native',
      consentToken: 'native-secret',
    }))
    await expect(store.start({}))
      .rejects.toThrow('already active')
  })

  it('projects an explicitly granted microphone permission', async () => {
    const store = useMeetingsStore()
    await store.initialize()
    vi.mocked(requestMeetingMicrophonePermission).mockResolvedValue({
      ...emptySnapshot,
      revision: 2,
      permissions: { microphone: 'granted', systemAudio: 'prompt-on-start' },
    })

    await expect(store.requestMicrophonePermission()).resolves.toBe('granted')
    expect(store.permissions).toEqual({
      microphone: 'granted',
      systemAudio: 'prompt-on-start',
    })
  })

  it('serializes concurrent config mutations without dropping either user intent', async () => {
    let releaseFirst
    const first = new Promise(resolve => { releaseFirst = resolve })
    vi.mocked(updateMeetingsConfig)
      .mockImplementationOnce(() => first)
      .mockResolvedValueOnce({
        ...emptySnapshot,
        revision: 3,
        config: {
          ...emptySnapshot.config,
          detectionEnabled: true,
          summaryEnabled: false,
        },
      })
    const store = useMeetingsStore()
    await store.initialize()

    const detecting = store.saveConfig({ detectionEnabled: true })
    const summary = store.saveConfig({ summaryEnabled: false })

    expect(store.pending.config).toBe(true)
    await vi.waitFor(() => expect(updateMeetingsConfig).toHaveBeenCalledTimes(1))
    releaseFirst({
      ...emptySnapshot,
      revision: 2,
      config: {
        ...emptySnapshot.config,
        detectionEnabled: true,
      },
    })
    await detecting
    await summary

    expect(updateMeetingsConfig).toHaveBeenNthCalledWith(1, { detectionEnabled: true })
    expect(updateMeetingsConfig).toHaveBeenNthCalledWith(2, { summaryEnabled: false })
    expect(store.config).toMatchObject({
      detectionEnabled: true,
      summaryEnabled: false,
    })
    expect(store.pending.config).toBeUndefined()
  })

  it('removes a dismissed meeting candidate from the authoritative snapshot', async () => {
    const store = useMeetingsStore()
    store.applySnapshot({
      ...emptySnapshot,
      revision: 2,
      candidates: [{ id: 'candidate-zoom', appName: 'Zoom' }],
    })
    vi.mocked(dismissMeetingCandidate).mockResolvedValue({
      ...emptySnapshot,
      revision: 3,
      candidates: [],
    })

    await store.dismissCandidate('candidate-zoom')
    expect(store.candidates).toEqual([])
  })

  it('keeps a finalizing meeting selected after Stop', async () => {
    const store = useMeetingsStore()
    store.applySnapshot({
      ...emptySnapshot,
      revision: 2,
      activeMeetingId: 'm1',
      meetings: [{
        id: 'm1',
        title: 'Planning',
        lifecycle: 'capturing',
        durationMs: 1000,
        segments: [],
        jobs: [],
        gaps: [],
        channels: [],
      }],
    })
    vi.mocked(stopMeeting).mockResolvedValue({
      ...emptySnapshot,
      revision: 3,
      activeMeetingId: 'm1',
      meetings: [{
        id: 'm1',
        title: 'Planning',
        lifecycle: 'finalizing',
        durationMs: 1200,
        segments: [],
        jobs: [],
        gaps: [],
        channels: [],
      }],
    })
    await store.stop()
    expect(store.selectedMeeting.lifecycle).toBe('finalizing')
    expect(store.stopping).toBe(true)
  })

  it('keeps a bounded page for a one-hundred-thousand-segment transcript', async () => {
    const page = Array.from({ length: 250 }, (_, index) => ({
      id: `segment-${index}`,
      text: `word ${index}`,
      startMs: 99_750_000 + index * 1_000,
      endMs: 99_750_900 + index * 1_000,
      channel: 'system',
      final: true,
      revision: 1,
    }))
    vi.mocked(loadMeetingSnapshot).mockResolvedValue({
      ...emptySnapshot,
      meetings: [{
        id: 'long-meeting',
        title: 'Long meeting',
        lifecycle: 'ready',
        transcriptRevision: 1,
        transcriptFinal: true,
        segments: [],
        jobs: [],
        gaps: [],
        gapCount: 0,
        channels: ['microphone', 'system'],
      }],
    })
    vi.mocked(loadMeetingTranscriptPage).mockResolvedValue({
      meetingId: 'long-meeting',
      revision: 1,
      totalSegments: 100_000,
      hasMore: true,
      nextBefore: {
        startMs: 99_750_000,
        endMs: 99_750_900,
        segmentId: 'segment-0',
      },
      segments: page,
      summary: 'Bounded.',
    })

    const store = useMeetingsStore()
    await store.initialize()

    expect(store.selectedMeeting.segments).toHaveLength(250)
    expect(store.selectedMeeting.transcriptTotalSegments).toBe(100_000)
    expect(Object.keys(store.transcriptWindows)).toEqual(['long-meeting'])
  })

  it('coalesces transcript event bursts without reloading the whole library', async () => {
    vi.useFakeTimers()
    vi.mocked(loadMeetingSnapshot).mockResolvedValue({
      ...emptySnapshot,
      meetings: [{
        id: 'live',
        title: 'Live',
        lifecycle: 'capturing',
        transcriptRevision: 1,
        segments: [],
        jobs: [],
        gaps: [],
        gapCount: 0,
        channels: ['microphone', 'system'],
      }],
      activeMeetingId: 'live',
    })
    const store = useMeetingsStore()
    await store.initialize()
    vi.mocked(loadMeetingTranscriptPage).mockClear()
    vi.mocked(loadMeetingSnapshot).mockClear()

    for (let index = 0; index < 1_000; index += 1) {
      eventHandler({ kind: 'transcript', meetingId: 'live', refresh: true })
    }
    await vi.advanceTimersByTimeAsync(125)

    expect(loadMeetingTranscriptPage).toHaveBeenCalledTimes(1)
    expect(loadMeetingSnapshot).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('loads older meeting pages without discarding the selected library', async () => {
    const recent = {
      id: 'recent',
      title: 'Recent',
      lifecycle: 'ready',
      segments: [],
      jobs: [],
      gaps: [],
      channels: [],
    }
    const older = { ...recent, id: 'older', title: 'Older' }
    vi.mocked(loadMeetingSnapshot).mockResolvedValue({
      ...emptySnapshot,
      meetings: [recent],
      meetingsTruncated: true,
      nextMeetingsBefore: {
        createdAt: '2026-01-02T00:00:00Z',
        meetingId: 'recent',
      },
    })
    vi.mocked(loadMeetingLibraryPage).mockResolvedValue({
      meetings: [older],
      hasMore: false,
      nextBefore: null,
    })
    const store = useMeetingsStore()
    await store.initialize()

    await store.loadOlderMeetings()

    expect(store.meetings.map(meeting => meeting.id)).toEqual(['recent', 'older'])
    expect(store.meetingsTruncated).toBe(false)
  })
})
