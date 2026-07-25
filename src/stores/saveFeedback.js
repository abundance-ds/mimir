import { ref } from 'vue'
import { defineStore } from 'pinia'

const SAVE_SAVING_DELAY = 400
const SAVE_SAVED_VISIBLE_MS = 1600

export const useSaveFeedbackStore = defineStore('saveFeedback', () => {
  const savingVisible = ref(false)
  const savedVisible = ref(false)
  const savedLabel = ref('')
  const fileId = ref(null)

  let pendingSaveSource = 'auto'
  let pendingSaveMode = 'save'
  let saveSavingTimer = null
  let saveSavedTimer = null
  let activeToken = null

  function clearTimers() {
    clearTimeout(saveSavingTimer)
    clearTimeout(saveSavedTimer)
    saveSavingTimer = null
    saveSavedTimer = null
  }

  function begin(source = 'auto', nextFileId = null) {
    clearTimers()
    activeToken = Symbol('save-feedback')
    fileId.value = nextFileId
    pendingSaveSource = source
    pendingSaveMode = 'save'
    savedVisible.value = false
    savedLabel.value = ''
    savingVisible.value = source === 'manual'
    if (source !== 'manual') {
      saveSavingTimer = setTimeout(() => {
        savingVisible.value = true
      }, SAVE_SAVING_DELAY)
    }
    return activeToken
  }

  function setMode(mode, token = null) {
    if (token && token !== activeToken) return
    pendingSaveMode = mode
  }

  function finish(didSave, fileLabel = 'Saved', token = null) {
    if (token && token !== activeToken) return
    clearTimeout(saveSavingTimer)
    saveSavingTimer = null
    const label = pendingSaveMode === 'saveAs' && fileLabel !== 'Saved'
      ? `Saved as ${fileLabel}`
      : 'Saved'
    const shouldShowSaved = Boolean(didSave) && (pendingSaveSource === 'manual' || savingVisible.value)
    savingVisible.value = false
    savedVisible.value = shouldShowSaved
    savedLabel.value = shouldShowSaved ? label : ''
    if (shouldShowSaved) {
      saveSavedTimer = setTimeout(() => {
        savedVisible.value = false
      }, SAVE_SAVED_VISIBLE_MS)
    }
  }

  function dispose() {
    clearTimers()
    activeToken = null
    fileId.value = null
  }

  return {
    savingVisible,
    savedVisible,
    savedLabel,
    fileId,
    begin,
    setMode,
    finish,
    dispose,
  }
})
