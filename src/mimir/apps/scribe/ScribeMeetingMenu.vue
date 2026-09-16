<template>
  <div
    ref="menu"
    data-scribe-meeting-menu
    role="menu"
    aria-label="Meeting actions"
    class="scribe-meeting-menu"
    :style="visiblePosition"
    @keydown="onKeydown"
  >
    <button
      v-if="canContinue"
      type="button"
      role="menuitem"
      data-scribe-continue-meeting
      @click="choose('continue')"
    >
      {{ continueLabel }}
    </button>
    <button
      v-if="context === 'row' && canRename"
      type="button"
      role="menuitem"
      data-scribe-rename-meeting
      @click="choose('rename')"
    >
      Rename
    </button>
    <button
      v-if="context === 'detail'"
      type="button"
      role="menuitem"
      data-scribe-ask-agent
      @click="choose('askAgent')"
    >
      Ask agent…
    </button>
    <button type="button" role="menuitem" data-scribe-show-files :disabled="filesPending" @click="choose('files')">
      Show in Finder
    </button>
    <button type="button" role="menuitem" :disabled="markdownPending" @click="choose('saveMarkdown')">
      Save Markdown copy
    </button>
    <button type="button" role="menuitem" :disabled="audioPending" @click="choose('saveAudio')">
      Save audio copy
    </button>
    <button
      v-if="canRetranscribe"
      type="button"
      role="menuitem"
      data-scribe-recover-meeting
      :disabled="retranscribePending"
      @click="choose('recover')"
    >
      {{ retranscribeLabel }}
    </button>
    <button
      type="button"
      role="menuitem"
      data-scribe-delete-meeting
      class="scribe-menu-danger"
      :disabled="deletePending"
      @click="choose('delete')"
    >
      Delete
    </button>
  </div>
</template>

<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

const props = defineProps({
  position: { type: Object, required: true },
  context: { type: String, default: 'row' },
  canRetranscribe: { type: Boolean, default: false },
  retranscribePending: { type: Boolean, default: false },
  retranscribeLabel: { type: String, default: 'Transcribe again' },
  canContinue: { type: Boolean, default: false },
  continueLabel: { type: String, default: 'Continue recording' },
  canRename: { type: Boolean, default: true },
  filesPending: { type: Boolean, default: false },
  markdownPending: { type: Boolean, default: false },
  audioPending: { type: Boolean, default: false },
  deletePending: { type: Boolean, default: false },
})

const emit = defineEmits([
  'close',
  'rename',
  'askAgent',
  'continue',
  'files',
  'saveMarkdown',
  'saveAudio',
  'recover',
  'delete',
])
const menu = ref(null)
const visiblePosition = ref(props.position)

onMounted(() => {
  document.addEventListener('pointerdown', onOutsidePointerDown)
  nextTick(() => {
    const rect = menu.value.getBoundingClientRect()
    visiblePosition.value = {
      left: `${Math.max(4, Math.min(rect.left, window.innerWidth - rect.width - 4))}px`,
      top: `${Math.max(4, Math.min(rect.top, window.innerHeight - rect.height - 4))}px`,
    }
    items()[0]?.focus({ preventScroll: true })
  })
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onOutsidePointerDown)
})

function items() {
  return [...(menu.value?.querySelectorAll('[role="menuitem"]:not(:disabled)') || [])]
}

function choose(action) {
  emit(action)
}

function onOutsidePointerDown(event) {
  if (!menu.value?.contains(event.target)) emit('close')
}

function onKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
    return
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  const options = items()
  if (!options.length) return
  event.preventDefault()
  const current = Math.max(0, options.indexOf(document.activeElement))
  const index = event.key === 'Home'
    ? 0
    : event.key === 'End'
      ? options.length - 1
      : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
  options[index]?.focus()
}
</script>

<style scoped>
.scribe-meeting-menu {
  position: fixed;
  z-index: 80;
  min-width: 168px;
  max-height: calc(100vh - 8px);
  overflow-y: auto;
  border: 1px solid var(--color-rule);
  background: var(--color-surface);
  padding: 3px;
}

.scribe-meeting-menu button {
  display: flex;
  min-height: 30px;
  width: 100%;
  align-items: center;
  padding: 0 8px;
  color: var(--color-ink-2);
  font-size: 10px;
  text-align: left;
}

.scribe-meeting-menu button:hover:not(:disabled),
.scribe-meeting-menu button:focus-visible {
  background: var(--color-chrome-mid);
  color: var(--color-ink);
  outline: none;
}

.scribe-meeting-menu button:disabled {
  opacity: 0.45;
}

.scribe-meeting-menu .scribe-menu-danger {
  border-top: 1px solid var(--color-rule-light);
  color: var(--color-rem);
}
</style>
