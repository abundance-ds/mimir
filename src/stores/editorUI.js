import { ref } from 'vue'
import { defineStore } from 'pinia'

export const useEditorUIStore = defineStore('editorUI', () => {
  const zoomLevel = ref(100)
  const settingsOpen = ref(false)

  function zoomIn() {
    zoomLevel.value = Math.min(200, zoomLevel.value + 5)
  }

  function zoomOut() {
    zoomLevel.value = Math.max(25, zoomLevel.value - 5)
  }

  function setZoomLevel(level) {
    zoomLevel.value = Math.min(200, Math.max(25, level))
  }

  return {
    zoomLevel,
    settingsOpen,
    zoomIn,
    zoomOut,
    setZoomLevel,
  }
})
