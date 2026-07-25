<template>
  <Teleport to="body">
    <Transition name="quick-open">
      <div
        v-if="open"
        data-quick-open
        class="fixed inset-0 z-[240] flex justify-center bg-black/20 px-4 pt-[12vh]"
        @keydown.esc.prevent="$emit('close')"
      >
        <button
          type="button"
          data-quick-open-backdrop
          aria-label="Close quick open"
          class="absolute inset-0"
          @click="$emit('close')"
        />
        <div class="relative flex max-h-[62vh] w-full max-w-[620px] flex-col self-start overflow-hidden border border-rule bg-surface">
          <div class="flex h-11 shrink-0 items-center gap-2 border-b border-rule px-3">
            <IconFileSearch :size="16" :stroke-width="1.7" class="text-ink-3" />
            <input
              ref="input"
              v-model="query"
              data-quick-open-input
              type="search"
              placeholder="Jump to file…"
              class="h-full min-w-0 flex-1 bg-transparent font-mono text-[12px] text-ink outline-none placeholder:text-ink-4"
              @input="onInput"
              @keydown.down.prevent="files.moveSelection(1)"
              @keydown.up.prevent="files.moveSelection(-1)"
              @keydown.enter.prevent="confirm"
              @keydown.esc.stop.prevent="$emit('close')"
            />
            <kbd class="font-mono text-[9px] text-ink-3">ESC</kbd>
          </div>
          <div class="min-h-0 overflow-y-auto py-1">
            <button
              v-for="(file, index) in files.visibleFiles.slice(0, 100)"
              :key="file.path"
              type="button"
              data-quick-open-row
              class="flex h-9 w-full items-center gap-3 px-3 text-left hover:bg-chrome-mid"
              :class="{ 'bg-accent-soft': index === files.selectionIndex }"
              @mouseenter="files.selectionIndex = index"
              @click="openFile(file.path)"
            >
              <span class="min-w-0 flex-1 truncate text-[11px] font-medium">{{ file.name }}</span>
              <span class="max-w-[60%] truncate font-mono text-[9px] text-ink-3">{{ file.relativePath }}</span>
            </button>
            <div v-if="!files.visibleFiles.length" class="grid h-24 place-items-center text-[11px] text-ink-3">
              {{ files.workspacePath ? 'No matching files.' : 'Open a workspace to jump to files.' }}
            </div>
          </div>
          <div class="flex h-7 shrink-0 items-center gap-3 border-t border-rule bg-chrome-high px-3 font-mono text-[9px] text-ink-3">
            <span>↑↓ select</span>
            <span>↵ open in Editor</span>
            <span class="ml-auto">{{ Math.min(files.visibleFiles.length, 100) }} files</span>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { nextTick, ref, watch } from 'vue'
import { IconFileSearch } from '@tabler/icons-vue'
import { useWorkspaceFilesStore } from '../../stores/workspaceFiles.js'

const props = defineProps({
  open: { type: Boolean, default: false },
})
const emit = defineEmits(['close', 'openFile'])
const files = useWorkspaceFilesStore()
const query = ref('')
const input = ref(null)
let queryTimer = null

watch(
  () => props.open,
  async (open) => {
    if (!open) return
    query.value = ''
    await files.setQuery('')
    await nextTick()
    input.value?.focus()
  },
  { immediate: true },
)

function onInput() {
  clearTimeout(queryTimer)
  queryTimer = setTimeout(() => files.setQuery(query.value), 40)
}

function confirm() {
  if (files.selectedFile) openFile(files.selectedFile.path)
}

function openFile(path) {
  emit('openFile', path)
  emit('close')
}
</script>

<style scoped>
.quick-open-enter-active,
.quick-open-leave-active {
  transition: opacity 100ms ease;
}

.quick-open-enter-from,
.quick-open-leave-to {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .quick-open-enter-active,
  .quick-open-leave-active {
    transition: none;
  }
}
</style>
