import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  checkMeetingAudio,
  clearMeetingsApiKey,
  decideMeetingKgProposal,
  deleteMeeting,
  deleteMeetingModel,
  dismissMeetingCandidate,
  exportMeeting,
  exportMeetingToFinder,
  installMeetingModel,
  issueMeetingStartConsent,
  listenToMeetingEvents,
  loadMeetingLibraryPage,
  loadMeetingSnapshot,
  loadMeetingTranscriptPage,
  openMeetingSystemAudioSettings,
  requestMeetingMicrophonePermission,
  retryMeetingJob,
  setMeetingMicMuted,
  setMeetingsApiKey,
  startMeeting,
  stopMeeting,
  showMeetingFiles,
  updateMeeting,
  updateMeetingsConfig,
} from '../services/meetings.js'

export const useMeetingsStore = defineStore('meetings', () => {
  const revision = ref(0)
  const meetings = ref([])
  const meetingsTruncated = ref(false)
  const nextMeetingsBefore = ref(null)
  const transcriptWindows = ref({})
  const candidates = ref([])
  const config = ref(defaultConfig())
  const permissions = ref({ microphone: 'unknown', systemAudio: 'unknown' })
  const audioCheck = ref(null)
  const models = ref([])
  const selectedId = ref('')
  const activeMeetingId = ref(null)
  const loaded = ref(false)
  const loading = ref(false)
  const error = ref('')
  const pending = ref({})
  let unlisten = null
  let initializing = null
  let refreshQueued = false
  let transcriptRefreshTimer = null
  let configMutationTail = Promise.resolve()
  let queuedConfigMutations = 0
  const transcriptRefreshIds = new Set()

  const selectedMeeting = computed(() => {
    const meeting = meetings.value.find(meeting => meeting.id === selectedId.value)
      || meetings.value.find(meeting => meeting.id === activeMeetingId.value)
      || meetings.value[0]
      || null
    if (!meeting) return null
    return withTranscriptWindow(meeting, transcriptWindows.value[meeting.id])
  })
  const activeMeeting = computed(() => (
    withTranscriptWindow(
      meetings.value.find(meeting => meeting.id === activeMeetingId.value) || null,
      transcriptWindows.value[activeMeetingId.value],
    )
  ))
  const recording = computed(() => activeMeeting.value?.lifecycle === 'capturing')
  const stopping = computed(() => (
    ['stopping', 'finalizing'].includes(activeMeeting.value?.lifecycle)
  ))
  const elapsedMs = computed(() => {
    const active = activeMeeting.value
    if (!active?.startedAt) return 0
    if (!recording.value) return active.durationMs
    return Math.max(active.durationMs, Date.now() - Date.parse(active.startedAt))
  })
  const kgOffer = computed(() => meetings.value.find(
    meeting => meeting.kgState === 'awaiting-decision',
  ) || null)

  async function initialize() {
    if (loaded.value) return
    if (initializing) return initializing
    initializing = (async () => {
      error.value = ''
      try {
        // Events are notifications, not a queue. Install first, then reconcile
        // with the authoritative native snapshot.
        if (!unlisten) unlisten = await listenToMeetingEvents(onEvent)
        await refresh()
      } catch (cause) {
        error.value = message(cause)
        throw cause
      } finally {
        initializing = null
      }
    })()
    return initializing
  }

  async function refresh() {
    if (loading.value) {
      refreshQueued = true
      return
    }
    loading.value = true
    try {
      applySnapshot(await loadMeetingSnapshot())
      error.value = ''
      loaded.value = true
      // History detail is secondary to the recorder. Do not hold the usable
      // Scribe surface behind transcript I/O; hydrate the selected/live detail
      // independently once the authoritative recorder state is visible.
      void refreshVisibleTranscripts()
    } catch (cause) {
      error.value = message(cause)
      throw cause
    } finally {
      loading.value = false
      if (refreshQueued) {
        refreshQueued = false
        void refresh()
      }
    }
  }

  async function start(request) {
    if (activeMeeting.value || pending.value.start) {
      throw new Error('A meeting is already active.')
    }
    return runPending('start', async () => {
      applySnapshot(await requestMeetingMicrophonePermission())
      const candidate = request?.candidateId
        ? candidates.value.find(value => value.id === request.candidateId)
        : null
      if (request?.candidateId && !candidate) {
        throw new Error('The selected meeting suggestion is no longer available.')
      }
      const custom = config.value.transcriptionMode === 'custom'
      const consent = await issueMeetingStartConsent({
        candidateId: candidate?.id,
        candidateAppName: candidate?.appName,
        transcriptionMode: config.value.transcriptionMode,
        destination: custom ? config.value.customUrl : null,
        model: custom ? config.value.customModel : config.value.localModel,
      })
      const snapshot = await startMeeting({
        ...request,
        requestId: consent.requestId,
        consentToken: consent.token,
      })
      applySnapshot(snapshot)
      if (snapshot.activeMeetingId) selectedId.value = snapshot.activeMeetingId
      void refreshVisibleTranscripts()
      return activeMeeting.value
    })
  }

  async function dismissCandidate(id) {
    return runPending(`candidate:${id}`, async () => {
      applySnapshot(await dismissMeetingCandidate(id))
      return true
    })
  }

  async function stop() {
    const active = activeMeeting.value
    if (!active || pending.value.stop) return null
    return runPending('stop', async () => {
      applySnapshot(await stopMeeting(active.id))
      void refreshVisibleTranscripts()
      return selectedMeeting.value
    })
  }

  async function setMicMuted(muted) {
    const active = activeMeeting.value
    if (!active) throw new Error('No meeting is being recorded.')
    return runPending('mic', async () => {
      applySnapshot(await setMeetingMicMuted(active.id, muted))
      return activeMeeting.value
    })
  }

  async function saveMeeting(id, patch) {
    return runPending(`update:${id}`, async () => {
      applySnapshot(await updateMeeting(id, patch))
      return meetings.value.find(meeting => meeting.id === id) || null
    })
  }

  async function decideKg(id, decision) {
    return runPending(`kg:${id}`, async () => {
      applySnapshot(await decideMeetingKgProposal(id, decision))
      return meetings.value.find(meeting => meeting.id === id) || null
    })
  }

  async function retryJob(id, kind) {
    return runPending(`retry:${id}:${kind}`, async () => {
      applySnapshot(await retryMeetingJob(id, kind))
      return meetings.value.find(meeting => meeting.id === id) || null
    })
  }

  async function remove(id, mode = 'all') {
    return runPending(`delete:${id}`, async () => {
      applySnapshot(await deleteMeeting(id, mode))
      return true
    })
  }

  async function exportRecord(id, format = 'markdown') {
    return runPending(`export:${id}:${format}`, () => exportMeeting(id, format))
  }

  async function revealFiles(id) {
    return runPending(`export:${id}:files`, () => showMeetingFiles(id))
  }

  async function exportToFinder(id, format) {
    return runPending(`export:${id}:${format}`, () => exportMeetingToFinder(id, format))
  }

  function saveConfig(patch) {
    const queuedPatch = { ...patch }
    queuedConfigMutations += 1
    pending.value = { ...pending.value, config: true }
    const operation = configMutationTail.then(async () => {
      error.value = ''
      try {
        applySnapshot(await updateMeetingsConfig(queuedPatch))
        return config.value
      } catch (cause) {
        error.value = message(cause)
        throw cause
      }
    })
    configMutationTail = operation.catch(() => undefined)
    return operation.finally(() => {
      queuedConfigMutations -= 1
      if (queuedConfigMutations > 0) return
      const nextPending = { ...pending.value }
      delete nextPending.config
      pending.value = nextPending
    })
  }

  async function openSystemAudioSettings() {
    return runPending('system-audio-settings', async () => {
      await openMeetingSystemAudioSettings()
      return true
    })
  }

  async function requestMicrophonePermission() {
    return runPending('microphone-permission', async () => {
      applySnapshot(await requestMeetingMicrophonePermission())
      return permissions.value.microphone
    })
  }

  async function checkAudio() {
    return runPending('audio-check', async () => {
      audioCheck.value = await checkMeetingAudio()
      return audioCheck.value
    })
  }

  async function saveApiKey(value) {
    return runPending('api-key', async () => {
      applySnapshot(await setMeetingsApiKey(value))
      return config.value.apiKeyConfigured
    })
  }

  async function clearApiKey() {
    return runPending('api-key', async () => {
      applySnapshot(await clearMeetingsApiKey())
      return config.value.apiKeyConfigured
    })
  }

  async function installModel(id) {
    return runPending(`model:${id}`, async () => {
      applySnapshot(await installMeetingModel(id))
      return models.value.find(model => model.id === id) || null
    })
  }

  async function deleteModel(id) {
    return runPending(`model:${id}`, async () => {
      applySnapshot(await deleteMeetingModel(id))
      return true
    })
  }

  function select(id) {
    if (!meetings.value.some(meeting => meeting.id === id)) return
    selectedId.value = id
    pruneTranscriptWindows()
    void refreshTranscript(id).catch(() => {})
  }

  function applySnapshot(snapshot) {
    if (!snapshot || snapshot.revision < revision.value) return false
    revision.value = snapshot.revision
    meetings.value = snapshot.meetings
    meetingsTruncated.value = snapshot.meetingsTruncated
    nextMeetingsBefore.value = snapshot.nextMeetingsBefore
    candidates.value = snapshot.candidates
    config.value = snapshot.config
    permissions.value = snapshot.permissions
    models.value = snapshot.models
    activeMeetingId.value = snapshot.activeMeetingId
    if (!meetings.value.some(meeting => meeting.id === selectedId.value)) {
      selectedId.value = snapshot.activeMeetingId || meetings.value[0]?.id || ''
    }
    pruneTranscriptWindows()
    // A later healthy native projection must clear a stale diagnostic. The
    // previous behavior made normal transient states (notably detector enable)
    // survive indefinitely as a blocking global error.
    error.value = snapshot.diagnostic || ''
    return true
  }

  function dismissError() {
    error.value = ''
  }

  function onEvent(event) {
    if (
      event?.meetingId
      && String(event.kind || '').toLowerCase().includes('transcript')
    ) {
      queueTranscriptRefresh(event.meetingId)
      return
    }
    if (event?.refresh) {
      queueRefresh()
      return
    }
    if (!event || event.revision <= revision.value) return
    if (event.snapshot) {
      applySnapshot(event.snapshot)
      loaded.value = true
      return
    }
    // Coalesce high-frequency notifications into one authoritative read.
    queueRefresh()
  }

  function queueRefresh() {
    refreshQueued = true
    queueMicrotask(() => {
      if (!refreshQueued) return
      refreshQueued = false
      void refresh()
    })
  }

  async function refreshVisibleTranscripts() {
    const ids = new Set([selectedId.value, activeMeetingId.value].filter(Boolean))
    await Promise.allSettled([...ids].map(id => refreshTranscript(id)))
  }

  async function refreshTranscript(id, before = null) {
    if (!id || !meetings.value.some(meeting => meeting.id === id)) return null
    const existing = transcriptWindows.value[id]
    if (existing?.loading) {
      queueTranscriptRefresh(id)
      return existing
    }
    setTranscriptWindow(id, {
      ...(existing || emptyTranscriptWindow()),
      loading: true,
      error: '',
    })
    try {
      const page = await loadMeetingTranscriptPage(id, before)
      const current = transcriptWindows.value[id] || emptyTranscriptWindow()
      setTranscriptWindow(id, {
        ...current,
        segments: page.segments,
        revision: page.revision,
        totalSegments: page.totalSegments,
        hasMore: page.hasMore,
        nextBefore: page.nextBefore,
        showingLatest: before == null,
        newerAvailable: before == null ? false : current.newerAvailable,
        summary: before == null ? page.summary : current.summary,
        summaryLoaded: before == null ? true : current.summaryLoaded,
        loading: false,
        error: '',
      })
      const meeting = meetings.value.find(value => value.id === id)
      if (meeting && page.revision > meeting.transcriptRevision) {
        meeting.transcriptRevision = page.revision
      }
      pruneTranscriptWindows()
      return transcriptWindows.value[id]
    } catch (cause) {
      setTranscriptWindow(id, {
        ...(transcriptWindows.value[id] || emptyTranscriptWindow()),
        loading: false,
        error: message(cause),
      })
      throw cause
    }
  }

  async function loadEarlierTranscript() {
    const meeting = selectedMeeting.value
    if (!meeting?.transcriptNextBefore) return null
    return refreshTranscript(meeting.id, meeting.transcriptNextBefore)
  }

  async function loadOlderMeetings() {
    if (!nextMeetingsBefore.value || pending.value['library-page']) return null
    return runPending('library-page', async () => {
      const page = await loadMeetingLibraryPage(nextMeetingsBefore.value)
      const known = new Set(meetings.value.map(meeting => meeting.id))
      meetings.value = [
        ...meetings.value,
        ...page.meetings.filter(meeting => !known.has(meeting.id)),
      ]
      meetingsTruncated.value = page.hasMore
      nextMeetingsBefore.value = page.nextBefore
      return page.meetings.length
    })
  }

  async function loadLatestTranscript() {
    const meeting = selectedMeeting.value
    if (!meeting) return null
    return refreshTranscript(meeting.id)
  }

  function queueTranscriptRefresh(id) {
    if (!id || !meetings.value.some(meeting => meeting.id === id)) return
    // Do not kick a reader out of an older page when live words arrive.
    const window = transcriptWindows.value[id]
    if (window && !window.showingLatest) {
      setTranscriptWindow(id, { ...window, newerAvailable: true })
      return
    }
    transcriptRefreshIds.add(id)
    if (transcriptRefreshTimer != null) return
    transcriptRefreshTimer = setTimeout(() => {
      transcriptRefreshTimer = null
      const ids = [...transcriptRefreshIds]
      transcriptRefreshIds.clear()
      for (const meetingId of ids) void refreshTranscript(meetingId).catch(() => {})
    }, 125)
  }

  function setTranscriptWindow(id, value) {
    transcriptWindows.value = { ...transcriptWindows.value, [id]: value }
  }

  function pruneTranscriptWindows() {
    const retained = new Set([selectedId.value, activeMeetingId.value].filter(Boolean))
    transcriptWindows.value = Object.fromEntries(
      Object.entries(transcriptWindows.value).filter(([id]) => retained.has(id)),
    )
  }

  async function runPending(key, operation) {
    if (pending.value[key]) return null
    pending.value = { ...pending.value, [key]: true }
    error.value = ''
    try {
      return await operation()
    } catch (cause) {
      error.value = message(cause)
      throw cause
    } finally {
      const next = { ...pending.value }
      delete next[key]
      pending.value = next
    }
  }

  function dispose() {
    unlisten?.()
    unlisten = null
    initializing = null
    loaded.value = false
    if (transcriptRefreshTimer != null) clearTimeout(transcriptRefreshTimer)
    transcriptRefreshTimer = null
    transcriptRefreshIds.clear()
    transcriptWindows.value = {}
    audioCheck.value = null
  }

  return {
    revision,
    meetings,
    meetingsTruncated,
    nextMeetingsBefore,
    transcriptWindows,
    candidates,
    config,
    permissions,
    audioCheck,
    models,
    selectedId,
    activeMeetingId,
    loaded,
    loading,
    error,
    pending,
    selectedMeeting,
    activeMeeting,
    recording,
    stopping,
    elapsedMs,
    kgOffer,
    initialize,
    refresh,
    requestMicrophonePermission,
    checkAudio,
    openSystemAudioSettings,
    dismissCandidate,
    start,
    stop,
    setMicMuted,
    saveMeeting,
    decideKg,
    retryJob,
    remove,
    exportRecord,
    revealFiles,
    exportToFinder,
    saveConfig,
    saveApiKey,
    clearApiKey,
    installModel,
    deleteModel,
    select,
    loadOlderMeetings,
    loadEarlierTranscript,
    loadLatestTranscript,
    applySnapshot,
    dismissError,
    dispose,
  }
})

function emptyTranscriptWindow() {
  return {
    segments: [],
    revision: 0,
    totalSegments: 0,
    hasMore: false,
    nextBefore: null,
    showingLatest: true,
    newerAvailable: false,
    summary: null,
    summaryLoaded: false,
    loading: false,
    error: '',
  }
}

function withTranscriptWindow(meeting, window) {
  if (!meeting) return null
  const detail = window || emptyTranscriptWindow()
  return {
    ...meeting,
    segments: detail.segments,
    summary: detail.summaryLoaded ? detail.summary : meeting.summary,
    transcriptLoading: detail.loading,
    transcriptError: detail.error,
    transcriptTotalSegments: detail.totalSegments,
    transcriptHasEarlier: detail.hasMore,
    transcriptNextBefore: detail.nextBefore,
    transcriptShowingLatest: detail.showingLatest,
    transcriptNewerAvailable: detail.newerAvailable,
  }
}

function defaultConfig() {
  return {
    detectionEnabled: false,
    autoRecord: false,
    transcriptionMode: 'local',
    customUrl: '',
    customModel: '',
    apiKeyConfigured: false,
    localModel: 'whisper-small',
    summaryEnabled: true,
    summaryTemplate: 'standard',
    summaryPrompt: '',
    summaryPreset: '',
    kgPrompt: 'ask',
    kgPreset: '',
    retentionDays: 30,
  }
}

function message(error) {
  return error instanceof Error ? error.message : String(error || 'Meeting operation failed.')
}
