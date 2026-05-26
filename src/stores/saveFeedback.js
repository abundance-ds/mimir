import { ref } from 'vue'
import { defineStore } from 'pinia'

const SAVE_SAVING_DELAY = 400
const SAVE_SAVED_VISIBLE_MS = 1600

export const useSaveFeedbackStore = defineStore('saveFeedback', () => {
  const savingVisible = ref(false)
  const savedVisible = ref(false)
  const savedLabel = ref('')

  let pendingSaveSource = 'auto'
  let pendingSaveMode = 'save'
  let saveSavingTimer = null
  let saveSavedTimer = null

  function clearTimers() {
    clearTimeout(saveSavingTimer)
    clearTimeout(saveSavedTimer)
    saveSavingTimer = null
    saveSavedTimer = null
  }

  function begin(source = 'auto') {
    clearTimers()
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
  }

  function setMode(mode) {
    pendingSaveMode = mode
  }

  function finish(didSave, fileLabel = 'Saved') {
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
  }

  return {
    savingVisible,
    savedVisible,
    savedLabel,
    begin,
    setMode,
    finish,
    dispose,
  }
})
