import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  endTrackerBreak,
  importArgus,
  listenToTrackerChanges,
  listenToTrackerOpen,
  previewArgusImport,
  requestTrackerAccessibility,
  setTrackerArmed,
  setTrackerEnabled,
  startTrackerBreak,
  trackerClassifications,
  trackerQuery,
  trackerReport,
  trackerStatus,
  updateTrackerClassification,
  updateTrackerConfig,
  updateTrackerContext,
} from '../services/tracker.js'

export const DEFAULT_TRACKER_CONFIG = Object.freeze({
  enabled: false,
  armed: true,
  launchAtLogin: true,
  collectWindowTitles: true,
  collectBrowserDomains: false,
  classificationEnabled: true,
  includeWindowTitlesInAi: false,
  nudgesEnabled: true,
  nudgeOther: false,
  pollIntervalSeconds: 15,
  changeConfirmationSeconds: 20,
  afkThresholdSeconds: 300,
  classificationBatchSeconds: 300,
  classificationRetrySeconds: 3600,
  classificationModel: 'auto',
  nudgeModel: 'auto',
  dailyCostCapUsd: 1,
  nudgeGraceMinutes: 5,
  nudgeIntervalMinutes: 5,
  nudgeMaxPerSession: 3,
  lunchStartMinutes: 720,
  lunchEndMinutes: 810,
  deepWorkMinutes: 60,
  earnedBreakMinutes: 20,
  endOfDayMinutes: 1020,
  endOfDayWorkMinutes: 300,
  timezone: 'Europe/Berlin',
})

export const DEFAULT_TRACKER_STATUS = Object.freeze({
  mode: 'disabled',
  config: DEFAULT_TRACKER_CONFIG,
  permissions: {
    platformSupported: true,
    accessibility: false,
    accessibilityRequired: true,
    browserAutomationEnabled: false,
    notifications: null,
  },
  current: null,
  breakRemainingSeconds: null,
  queuedClassifications: 0,
  todayCostUsd: 0,
  launchAtLoginActive: false,
  autostartDiagnostic: null,
  diagnostic: null,
  revision: 0,
})

export const useTrackerStore = defineStore('tracker', () => {
  const status = ref(cloneStatus(DEFAULT_TRACKER_STATUS))
  const initialized = ref(false)
  const loading = ref(false)
  const error = ref('')
  const openRequestRevision = ref(0)
  let initializePromise = null
  let unlistenChanges = null
  let unlistenOpen = null

  const enabled = computed(() => Boolean(status.value.config?.enabled))
  const armed = computed(() => Boolean(status.value.config?.armed))
  const mode = computed(() => status.value.mode || 'disabled')

  async function initialize() {
    if (initialized.value) return status.value
    if (initializePromise) return initializePromise
    initializePromise = (async () => {
      loading.value = true
      error.value = ''
      try {
        if (!unlistenChanges) unlistenChanges = await listenToTrackerChanges(onChanged)
        if (!unlistenOpen) {
          unlistenOpen = await listenToTrackerOpen(() => {
            openRequestRevision.value += 1
          })
        }
        applyStatus(await trackerStatus())
        initialized.value = true
        return status.value
      } catch (cause) {
        error.value = message(cause)
        unlistenChanges?.()
        unlistenOpen?.()
        unlistenChanges = null
        unlistenOpen = null
        throw cause
      } finally {
        loading.value = false
        initializePromise = null
      }
    })()
    return initializePromise
  }

  async function refresh() {
    return applyStatus(await trackerStatus())
  }

  async function setEnabled(value) {
    return mutate(() => setTrackerEnabled(Boolean(value)))
  }

  async function setArmed(value) {
    return mutate(() => setTrackerArmed(Boolean(value)))
  }

  async function updateConfig(patch) {
    const config = {
      ...DEFAULT_TRACKER_CONFIG,
      ...status.value.config,
      ...patch,
    }
    return mutate(() => updateTrackerConfig(config))
  }

  async function startBreak(minutes = 20) {
    return mutate(() => startTrackerBreak(minutes))
  }

  async function endBreak() {
    return mutate(() => endTrackerBreak())
  }

  async function requestAccessibility() {
    const next = await requestTrackerAccessibility()
    if (next) applyStatus(next)
    return next
  }

  function onChanged(payload) {
    if (payload?.status) applyStatus(payload.status)
    else void refresh().catch(cause => { error.value = message(cause) })
  }

  function applyStatus(next) {
    status.value = {
      ...cloneStatus(DEFAULT_TRACKER_STATUS),
      ...(next || {}),
      config: {
        ...DEFAULT_TRACKER_CONFIG,
        ...(next?.config || {}),
      },
      permissions: {
        ...DEFAULT_TRACKER_STATUS.permissions,
        ...(next?.permissions || {}),
      },
    }
    error.value = ''
    return status.value
  }

  async function mutate(operation) {
    loading.value = true
    error.value = ''
    try {
      return applyStatus(await operation())
    } catch (cause) {
      error.value = message(cause)
      throw cause
    } finally {
      loading.value = false
    }
  }

  function dispose() {
    unlistenChanges?.()
    unlistenOpen?.()
    unlistenChanges = null
    unlistenOpen = null
    initialized.value = false
  }

  return {
    status,
    initialized,
    loading,
    error,
    openRequestRevision,
    enabled,
    armed,
    mode,
    initialize,
    refresh,
    setEnabled,
    setArmed,
    updateConfig,
    startBreak,
    endBreak,
    requestAccessibility,
    report: trackerReport,
    query: trackerQuery,
    classifications: trackerClassifications,
    updateClassification: updateTrackerClassification,
    previewImport: previewArgusImport,
    importArgus,
    setContext: updateTrackerContext,
    dispose,
  }
})

function cloneStatus(status) {
  return {
    ...status,
    config: { ...status.config },
    permissions: { ...status.permissions },
  }
}

function message(error) {
  return error instanceof Error ? error.message : String(error || 'Tracker is unavailable.')
}
