import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  appUpdatesSupported,
  checkForAppUpdate,
  downloadAndInstallAppUpdate,
  installedAppVersion,
  relaunchUpdatedApp,
} from '../services/appUpdates.js'

export const UPDATE_PHASE = Object.freeze({
  IDLE: 'idle',
  CHECKING: 'checking',
  CURRENT: 'current',
  AVAILABLE: 'available',
  DOWNLOADING: 'downloading',
  INSTALLING: 'installing',
  READY: 'ready',
  RESTARTING: 'restarting',
  ERROR: 'error',
  UNSUPPORTED: 'unsupported',
})

const AUTO_CHECK_DELAY_MS = 1800

export const useAppUpdateStore = defineStore('appUpdate', () => {
  const phase = ref(UPDATE_PHASE.IDLE)
  const currentVersion = ref('')
  const updateVersion = ref('')
  const releaseNotes = ref('')
  const publishedAt = ref('')
  const progress = ref(null)
  const errorMessage = ref('')
  const errorDetail = ref('')
  const errorStage = ref('')
  const toastVisible = ref(false)

  let pendingUpdate = null
  let versionPromise = null
  let checkPromise = null
  let installPromise = null
  let restartPromise = null
  let restartGuard = null
  let autoCheckTimer = null
  let autoCheckStarted = false

  const supported = computed(() => appUpdatesSupported())
  const busy = computed(() => [
    UPDATE_PHASE.CHECKING,
    UPDATE_PHASE.DOWNLOADING,
    UPDATE_PHASE.INSTALLING,
    UPDATE_PHASE.RESTARTING,
  ].includes(phase.value))
  const hasUpdate = computed(() => Boolean(updateVersion.value))
  const handoff = computed(() => {
    const current = versionLabel(currentVersion.value)
    if (!updateVersion.value) return current
    return `${current} → ${versionLabel(updateVersion.value)}`
  })

  async function loadVersion() {
    if (currentVersion.value) return currentVersion.value
    if (!versionPromise) {
      versionPromise = installedAppVersion()
        .then(version => {
          currentVersion.value = version
          return version
        })
        .finally(() => {
          versionPromise = null
        })
    }
    return versionPromise
  }

  function startAutomaticCheck({ delayMs = AUTO_CHECK_DELAY_MS } = {}) {
    void loadVersion()
    if (!supported.value || autoCheckStarted) return
    autoCheckStarted = true
    clearTimeout(autoCheckTimer)
    autoCheckTimer = setTimeout(() => {
      void checkForUpdate({ automatic: true })
    }, Math.max(0, delayMs))
  }

  async function checkForUpdate({ automatic = false } = {}) {
    await loadVersion()
    if (!supported.value) {
      phase.value = UPDATE_PHASE.UNSUPPORTED
      return null
    }
    if (checkPromise) return checkPromise
    if (installPromise || restartPromise) return pendingUpdate

    checkPromise = (async () => {
      phase.value = UPDATE_PHASE.CHECKING
      clearError()
      progress.value = null
      try {
        const update = await checkForAppUpdate()
        if (!update || update.available === false) {
          pendingUpdate = null
          updateVersion.value = ''
          releaseNotes.value = ''
          publishedAt.value = ''
          phase.value = UPDATE_PHASE.CURRENT
          if (!automatic) toastVisible.value = false
          return null
        }

        pendingUpdate = update
        updateVersion.value = update.version || ''
        releaseNotes.value = update.body || ''
        publishedAt.value = update.date || ''
        phase.value = UPDATE_PHASE.AVAILABLE
        toastVisible.value = true
        return update
      } catch (error) {
        if (automatic) {
          phase.value = UPDATE_PHASE.IDLE
          clearError()
          return null
        }
        setError(
          'Could not check for updates. Check your connection and try again.',
          error,
          false,
          'check',
        )
        return null
      }
    })().finally(() => {
      checkPromise = null
    })
    return checkPromise
  }

  async function installUpdate() {
    if (installPromise) return installPromise
    if (!pendingUpdate) {
      await checkForUpdate()
      if (!pendingUpdate) return false
    }

    installPromise = (async () => {
      phase.value = UPDATE_PHASE.DOWNLOADING
      progress.value = 0
      clearError()
      toastVisible.value = true
      let contentLength = 0
      let downloaded = 0
      try {
        await downloadAndInstallAppUpdate(pendingUpdate, event => {
          if (event?.event === 'Started') {
            contentLength = Number(event.data?.contentLength) || 0
            progress.value = contentLength > 0 ? 0 : null
          } else if (event?.event === 'Progress') {
            downloaded += Number(event.data?.chunkLength) || 0
            progress.value = contentLength > 0
              ? Math.min(99, Math.round((downloaded / contentLength) * 100))
              : null
          } else if (event?.event === 'Finished') {
            progress.value = 100
            phase.value = UPDATE_PHASE.INSTALLING
          }
        })
        progress.value = 100
        phase.value = UPDATE_PHASE.READY
        return true
      } catch (error) {
        setError(
          'Could not install the update. Check your connection and try again.',
          error,
          true,
          'install',
        )
        return false
      }
    })().finally(() => {
      installPromise = null
    })
    return installPromise
  }

  async function restartToUpdate() {
    if (restartPromise) return restartPromise
    if (phase.value !== UPDATE_PHASE.READY) return false

    restartPromise = (async () => {
      phase.value = UPDATE_PHASE.RESTARTING
      clearError()
      try {
        const safe = restartGuard ? await restartGuard() : true
        if (safe === false) {
          phase.value = UPDATE_PHASE.READY
          return false
        }
        await relaunchUpdatedApp()
        return true
      } catch (error) {
        setError(
          'Could not restart Mimir. Your update is still ready.',
          error,
          true,
          'restart',
        )
        return false
      }
    })().finally(() => {
      restartPromise = null
    })
    return restartPromise
  }

  async function retry() {
    if (errorStage.value === 'restart') {
      phase.value = UPDATE_PHASE.READY
      return restartToUpdate()
    }
    if (errorStage.value === 'install' && pendingUpdate) return installUpdate()
    return checkForUpdate()
  }

  function setRestartGuard(guard) {
    restartGuard = typeof guard === 'function' ? guard : null
    return () => {
      if (restartGuard === guard) restartGuard = null
    }
  }

  function dismissToast() {
    if (busy.value) return
    toastVisible.value = false
  }

  function showToast() {
    if (hasUpdate.value) toastVisible.value = true
  }

  function clearError() {
    errorMessage.value = ''
    errorDetail.value = ''
    errorStage.value = ''
  }

  function setError(message, cause, showToastOnError, stage) {
    phase.value = UPDATE_PHASE.ERROR
    errorMessage.value = message
    errorDetail.value = errorText(cause)
    errorStage.value = stage
    toastVisible.value = showToastOnError
  }

  function dispose() {
    clearTimeout(autoCheckTimer)
    autoCheckTimer = null
    restartGuard = null
  }

  return {
    phase,
    currentVersion,
    updateVersion,
    releaseNotes,
    publishedAt,
    progress,
    errorMessage,
    errorDetail,
    errorStage,
    toastVisible,
    supported,
    busy,
    hasUpdate,
    handoff,
    loadVersion,
    startAutomaticCheck,
    checkForUpdate,
    installUpdate,
    restartToUpdate,
    retry,
    setRestartGuard,
    dismissToast,
    showToast,
    dispose,
  }
})

function versionLabel(value) {
  if (!value) return 'v—'
  return value.startsWith('v') ? value : `v${value}`
}

function errorText(error) {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : String(error || 'Unknown updater error')
}
