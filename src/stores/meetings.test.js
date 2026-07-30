import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  dismissMeetingCandidate,
  listenToMeetingEvents,
  loadMeetingSnapshot,
  requestMeetingMicrophonePermission,
  startMeeting,
  stopMeeting,
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
  listenToMeetingEvents: vi.fn(),
  loadMeetingSnapshot: vi.fn(),
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
    summaryEnabled: true,
    kgPrompt: 'ask',
  },
  permissions: { microphone: 'granted', systemAudio: 'granted' },
  models: [],
  diagnostic: null,
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
    vi.mocked(requestMeetingMicrophonePermission).mockReset()
    vi.mocked(dismissMeetingCandidate).mockReset()
    vi.mocked(startMeeting).mockReset()
    vi.mocked(stopMeeting).mockReset()
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

  it('requires explicit consent and prevents a second active capture', async () => {
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
    await store.start({ title: 'Planning', consentConfirmed: true })
    expect(startMeeting).toHaveBeenCalledWith(expect.objectContaining({
      consentConfirmed: true,
    }))
    await expect(store.start({ consentConfirmed: true }))
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
})
