import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  clearMeetingsApiKey,
  decideMeetingKgProposal,
  deleteMeeting,
  deleteMeetingModel,
  dismissMeetingCandidate,
  exportMeeting,
  installMeetingModel,
  listenToMeetingEvents,
  loadMeetingSnapshot,
  requestMeetingMicrophonePermission,
  retryMeetingJob,
  setMeetingMicMuted,
  setMeetingsApiKey,
  startMeeting,
  stopMeeting,
  updateMeeting,
  updateMeetingsConfig,
} from '../services/meetings.js'

export const useMeetingsStore = defineStore('meetings', () => {
  const revision = ref(0)
  const meetings = ref([])
  const candidates = ref([])
  const config = ref(defaultConfig())
  const permissions = ref({ microphone: 'unknown', systemAudio: 'unknown' })
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

  const selectedMeeting = computed(() => (
    meetings.value.find(meeting => meeting.id === selectedId.value)
      || meetings.value.find(meeting => meeting.id === activeMeetingId.value)
      || meetings.value[0]
      || null
  ))
  const activeMeeting = computed(() => (
    meetings.value.find(meeting => meeting.id === activeMeetingId.value) || null
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
      const snapshot = await startMeeting({
        ...request,
        consentConfirmed: request?.consentConfirmed === true,
      })
      applySnapshot(snapshot)
      if (snapshot.activeMeetingId) selectedId.value = snapshot.activeMeetingId
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

  async function saveConfig(patch) {
    return runPending('config', async () => {
      applySnapshot(await updateMeetingsConfig(patch))
      return config.value
    })
  }

  async function requestMicrophonePermission() {
    return runPending('microphone-permission', async () => {
      applySnapshot(await requestMeetingMicrophonePermission())
      return permissions.value.microphone
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
    if (meetings.value.some(meeting => meeting.id === id)) selectedId.value = id
  }

  function applySnapshot(snapshot) {
    if (!snapshot || snapshot.revision < revision.value) return false
    revision.value = snapshot.revision
    meetings.value = snapshot.meetings
    candidates.value = snapshot.candidates
    config.value = snapshot.config
    permissions.value = snapshot.permissions
    models.value = snapshot.models
    activeMeetingId.value = snapshot.activeMeetingId
    if (!meetings.value.some(meeting => meeting.id === selectedId.value)) {
      selectedId.value = snapshot.activeMeetingId || meetings.value[0]?.id || ''
    }
    if (snapshot.diagnostic) error.value = snapshot.diagnostic
    return true
  }

  function onEvent(event) {
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
  }

  return {
    revision,
    meetings,
    candidates,
    config,
    permissions,
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
    dismissCandidate,
    start,
    stop,
    setMicMuted,
    saveMeeting,
    decideKg,
    retryJob,
    remove,
    exportRecord,
    saveConfig,
    saveApiKey,
    clearApiKey,
    installModel,
    deleteModel,
    select,
    applySnapshot,
    dispose,
  }
})

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
    summaryPreset: '',
    kgPrompt: 'ask',
    kgPreset: '',
    retentionDays: 30,
  }
}

function message(error) {
  return error instanceof Error ? error.message : String(error || 'Meeting operation failed.')
}
