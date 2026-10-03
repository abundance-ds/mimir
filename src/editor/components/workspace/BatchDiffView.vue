<template>
  <div class="batch-diff-view flex-1 min-w-0 overflow-y-auto bg-chrome" :style="wrapperStyle" @keydown.capture="onKeydown">
    <template v-for="(file, i) in diffStore.files" :key="file.path">
      <div v-if="i > 0" class="border-t border-rule-light"></div>
      <div :data-file-path="file.path">
        <BatchFileDiff
          :file="file"
          :displayName="fileDisplayNames[i]"
        />
      </div>
    </template>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useDiffStore } from '../../../stores/diff.js'
import { useSettingsStore } from '../../../stores/settings.js'
import { useEditorUIStore } from '../../../stores/editorUI.js'
import { editorTypographyVars } from '../../../shared/fonts.js'
import { disambiguateFilenames } from '../../../shared/lineDelta.js'
import BatchFileDiff from './BatchFileDiff.vue'

const diffStore = useDiffStore()
const settings = useSettingsStore()
const editorUI = useEditorUIStore()

const fileDisplayNames = computed(() => {
  return disambiguateFilenames(diffStore.files.map(f => f.path))
})

const wrapperStyle = computed(() => {
  return editorTypographyVars({
    fontSize: settings.editorFontSize,
    zoom: editorUI.zoomLevel / 100,
    fontKey: settings.editorFontFamily,
    dark: settings.isDarkTheme,
  })
})

function onKeydown(event) {
  if (event.target?.closest?.('input, textarea, [contenteditable="true"]:not(.cm-content)')) return
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && !event.isComposing) {
    event.preventDefault()
    event.stopPropagation()
    if (event.shiftKey) diffStore.redoReview()
    else diffStore.undoReview()
  }
}

function scrollToFile(path) {
  const el = document.querySelector(`[data-file-path="${CSS.escape(path)}"]`)
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

defineExpose({ scrollToFile })
</script>

<style scoped>
.batch-diff-view::-webkit-scrollbar { width: 4px; }
.batch-diff-view::-webkit-scrollbar-thumb { background: var(--color-rule); border-radius: 2px; }
</style>
