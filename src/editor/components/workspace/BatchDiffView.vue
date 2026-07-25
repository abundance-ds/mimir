<template>
  <div class="batch-diff-view flex-1 min-w-0 overflow-y-auto bg-chrome" :style="wrapperStyle">
    <template v-for="(file, i) in diffStore.files" :key="file.path">
      <div v-if="i > 0" class="border-t border-rule-light"></div>
      <div :data-file-path="file.path">
        <BatchFileDiff
          :file="file"
          :displayName="fileDisplayNames[i]"
          @accept="onAcceptFile"
          @reject="onRejectFile"
          @reset="onResetFile"
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
import { fontFamilyForKey } from '../../../shared/fonts.js'
import { disambiguateFilenames } from '../../../shared/lineDelta.js'
import BatchFileDiff from './BatchFileDiff.vue'

const diffStore = useDiffStore()
const settings = useSettingsStore()
const editorUI = useEditorUIStore()

const emit = defineEmits(['all-resolved'])

const fileDisplayNames = computed(() => {
  return disambiguateFilenames(diffStore.files.map(f => f.path))
})

const wrapperStyle = computed(() => {
  const baseFontSize = settings.editorFontSize
  const zoom = editorUI.zoomLevel / 100
  return {
    '--editor-size': (baseFontSize * zoom) + 'px',
    '--editor-line-height': ((23 * baseFontSize / 12) * zoom) + 'px',
    '--font-mono': fontFamilyForKey(settings.editorFontFamily),
  }
})

function onAcceptFile(path) {
  diffStore.acceptFile(path)
  emitIfResolved()
}

function onRejectFile(path) {
  diffStore.rejectFile(path)
  emitIfResolved()
}

function onResetFile(path) {
  diffStore.resetFile(path)
}

function scrollToFile(path) {
  const el = document.querySelector(`[data-file-path="${CSS.escape(path)}"]`)
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

defineExpose({ scrollToFile })

function emitIfResolved() {
  if (diffStore.allResolved) {
    emit('all-resolved')
  }
}
</script>

<style scoped>
.batch-diff-view::-webkit-scrollbar { width: 4px; }
.batch-diff-view::-webkit-scrollbar-thumb { background: var(--color-rule); border-radius: 2px; }
</style>
