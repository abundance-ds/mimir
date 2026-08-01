import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  dismissMeetingCandidate,
  issueMeetingStartConsent,
  listenToMeetingAudioTestEvents,
  listenToMeetingEvents,
  loadMeetingLibraryPage,
  loadMeetingSnapshot,
  loadMeetingTranscriptPage,
  requestMeetingMicrophonePermission,
  startMeetingAudioTest,
  runMeetingSummary,
  searchMeetingLibrary,
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
  listenToMeetingAudioTestEvents: vi.fn(),
  listenToMeetingEvents: vi.fn(),
  loadMeetingLibraryPage: vi.fn(),
  loadMeetingSnapshot: vi.fn(),
  loadMeetingTranscriptPage: vi.fn(),
  requestMeetingMicrophonePermission: vi.fn(),
  startMeetingAudioTest: vi.fn(),
  stopMeetingAudioTest: vi.fn(),
  runMeetingSummary: vi.fn(),
  searchMeetingLibrary: vi.fn(),
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
    summaryTemplate: 'standard',
    summaryPrompt: 'Write a balanced meeting summary.',
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
  let audioTestHandler

  beforeEach(() => {
    setActivePinia(createPinia())
    eventHandler = null
    audioTestHandler = null
    vi.mocked(listenToMeetingEvents).mockReset().mockImplementation(async handler => {
      eventHandler = handler
      return vi.fn()
    })
    vi.mocked(listenToMeetingAudioTestEvents).mockReset().mockImplementation(async handler => {
      audioTestHandler = handler
      return vi.fn()
    })
    vi.mocked(startMeetingAudioTest).mockReset().mockResolvedValue({ testId: 'audio-1' })
    vi.mocked(loadMeetingSnapshot).mockReset().mockResolvedValue(emptySnapshot)
    vi.mocked(loadMeetingLibraryPage).mockReset()
    vi.mocked(loadMeetingTranscriptPage).mockReset().mockImplementation(async meetingId => ({
      ...emptyTranscriptPage,
      meetingId,
    }))
    vi.mocked(requestMeetingMicrophonePermission).mockReset()
      .mockResolvedValue(emptySnapshot)
    vi.mocked(searchMeetingLibrary).mockReset().mockResolvedValue([])
    vi.mocked(runMeetingSummary).mockReset()
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

  it('keeps a bounded per-source audio-check result outside meeting history', async () => {
    const store = useMeetingsStore()
    await store.checkAudio()
    audioTestHandler({
      testId: 'audio-1',
      state: 'running',
      sequence: 1,
      microphone: { state: 'signal', level: 74, error: null },
      systemAudio: { state: 'signal', level: 61, error: null },
    })
    expect(store.audioCheck).toEqual({
      testId: 'audio-1',
      state: 'running',
      sequence: 1,
      microphone: { state: 'signal', level: 74, error: null },
      systemAudio: { state: 'signal', level: 61, error: null },
    })
    expect(store.meetings).toEqual([])
    expect(startMeetingAudioTest).toHaveBeenCalledOnce()
  })

  it('keeps native search results separate from the bounded recent library', async () => {
    vi.mocked(searchMeetingLibrary).mockResolvedValue([{
      meeting: { id: 'older', title: 'Older release review' },
      matched: { title: true, summary: false, tags: false, transcript: [] },
    }])
    const store = useMeetingsStore()

    await expect(store.search(' release ')).resolves.toHaveLength(1)
    expect(searchMeetingLibrary).toHaveBeenCalledWith('release')
    expect(store.searchResults[0].meeting.id).toBe('older')

    await expect(store.search('re')).resolves.toEqual([])
    expect(store.searchResults).toEqual([])
    expect(searchMeetingLibrary).toHaveBeenCalledTimes(1)
  })

  it('never lets a slower stale library search replace the latest query', async () => {
    let releaseFirst
    vi.mocked(searchMeetingLibrary)
      .mockImplementationOnce(() => new Promise(resolve => { releaseFirst = resolve }))
      .mockResolvedValueOnce([{
        meeting: { id: 'latest', title: 'Latest match' },
        matched: { title: true, summary: false, tags: false, transcript: [] },
      }])
    const store = useMeetingsStore()

    const first = store.search('first query')
    const second = store.search('latest query')
    await second
    releaseFirst([{
      meeting: { id: 'stale', title: 'Stale match' },
      matched: { title: true, summary: false, tags: false, transcript: [] },
    }])
    await first

    expect(store.searchQuery).toBe('latest query')
    expect(store.searchResults.map(hit => hit.meeting.id)).toEqual(['latest'])
    expect(store.pending.search).toBeUndefined()
  })

  it('opens and pages a full-library search hit outside the recent snapshot', async () => {
    vi.mocked(searchMeetingLibrary).mockResolvedValue([{
      meeting: {
        id: 'older',
        title: 'Older searchable meeting',
        lifecycle: 'ready',
        transcriptRevision: 4,
        jobs: [],
        gaps: [],
      },
      matched: { title: false, summary: false, tags: false, transcript: [] },
    }])
    vi.mocked(loadMeetingTranscriptPage).mockResolvedValue({
      ...emptyTranscriptPage,
      meetingId: 'older',
      revision: 4,
      totalSegments: 1,
      segments: [{
        id: 'older-segment', text: 'Found in history.', startMs: 0, endMs: 1000,
        channel: 'microphone', final: true, revision: 4,
      }],
      summary: 'Historical summary.',
    })
    const store = useMeetingsStore()

    await store.search('history')
    store.select('older')
    await vi.waitFor(() => expect(store.selectedMeeting?.segments).toHaveLength(1))

    expect(loadMeetingTranscriptPage).toHaveBeenCalledWith('older', null)
    expect(store.selectedMeeting).toMatchObject({
      id: 'older', summary: 'Historical summary.',
    })
  })

  it('runs a fine-tuned summary without changing global defaults', async () => {
    const reviewed = {
      id: 'reviewed', title: 'Reviewed', lifecycle: 'ready', jobs: [], gaps: [], channels: [],
    }
    vi.mocked(runMeetingSummary).mockResolvedValue({
      ...emptySnapshot,
      revision: 2,
      meetings: [{ ...reviewed, summaryState: 'queued' }],
    })
    const store = useMeetingsStore()
    store.applySnapshot({ ...emptySnapshot, meetings: [reviewed] })

    await store.runSummary('reviewed', {
      template: 'decisions-actions',
      prompt: 'Put decisions first.',
      preset: 'codex-review',
    })

    expect(runMeetingSummary).toHaveBeenCalledWith('reviewed', {
      template: 'decisions-actions',
      prompt: 'Put decisions first.',
      preset: 'codex-review',
    })
    expect(store.config).toMatchObject({
      summaryTemplate: 'standard',
      summaryPrompt: 'Write a balanced meeting summary.',
    })
    expect(store.meetings[0].summaryState).toBe('queued')
  })

  it('makes the recorder usable before transcript detail hydration completes', async () => {
    let releaseTranscript
    vi.mocked(loadMeetingSnapshot).mockResolvedValue({
      ...emptySnapshot,
      meetings: [{
        id: 'history',
        title: 'History',
        lifecycle: 'ready',
        durationMs: 60_000,
        segments: [],
        jobs: [],
        gaps: [],
        channels: ['microphone', 'system'],
      }],
    })
    vi.mocked(loadMeetingTranscriptPage).mockImplementation(() => new Promise(resolve => {
      releaseTranscript = resolve
    }))
    const store = useMeetingsStore()

    await store.initialize()

    expect(store.loaded).toBe(true)
    expect(store.loading).toBe(false)
    expect(store.meetings).toHaveLength(1)
    expect(releaseTranscript).toBeTypeOf('function')
    releaseTranscript({ ...emptyTranscriptPage, meetingId: 'history' })
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
    expect(requestMeetingMicrophonePermission).not.toHaveBeenCalled()
    expect(issueMeetingStartConsent).toHaveBeenCalledWith({
      candidateId: undefined,
      candidateAppName: undefined,
      continueMeetingId: undefined,
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

  it('continues a completed meeting under the same identity with fresh consent', async () => {
    const completed = {
      id: 'm1', title: 'Planning', lifecycle: 'ready', transcriptFinal: true,
      durationMs: 65_000, segments: [], jobs: [], gaps: [], channels: ['microphone'],
    }
    vi.mocked(loadMeetingSnapshot).mockResolvedValue({
      ...emptySnapshot,
      meetings: [completed],
    })
    vi.mocked(startMeeting).mockResolvedValue({
      ...emptySnapshot,
      revision: 2,
      activeMeetingId: 'm1',
      meetings: [{
        ...completed,
        lifecycle: 'capturing',
        recordingStartedAt: new Date().toISOString(),
      }],
    })
    const store = useMeetingsStore()
    await store.initialize()

    await store.start({ continueMeetingId: 'm1', workspacePath: '/work' })

    expect(issueMeetingStartConsent).toHaveBeenCalledWith(expect.objectContaining({
      continueMeetingId: 'm1',
    }))
    expect(startMeeting).toHaveBeenCalledWith(expect.objectContaining({
      continueMeetingId: 'm1',
      requestId: 'scribe-start-native',
    }))
    expect(store.activeMeeting?.id).toBe('m1')
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

  it('requests microphone access only when the native projection is not already granted', async () => {
    vi.mocked(loadMeetingSnapshot).mockResolvedValue({
      ...emptySnapshot,
      permissions: { microphone: 'prompt', systemAudio: 'prompt-on-start' },
    })
    vi.mocked(requestMeetingMicrophonePermission).mockResolvedValue({
      ...emptySnapshot,
      revision: 2,
      permissions: { microphone: 'granted', systemAudio: 'prompt-on-start' },
    })
    vi.mocked(startMeeting).mockResolvedValue({
      ...emptySnapshot,
      revision: 3,
      activeMeetingId: 'm1',
      meetings: [
        {
          id: 'm1',
          title: 'Permission test',
          lifecycle: 'capturing',
          durationMs: 0,
          segments: [],
          jobs: [],
          gaps: [],
          channels: ['microphone', 'system'],
        },
      ],
    })
    const store = useMeetingsStore()
    await store.initialize()

    await store.start({ title: 'Permission test' })

    expect(requestMeetingMicrophonePermission).toHaveBeenCalledTimes(1)
    expect(startMeeting).toHaveBeenCalledTimes(1)
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
