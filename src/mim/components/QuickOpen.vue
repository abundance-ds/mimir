<template>
  <Teleport to="body">
    <Transition name="quick-open">
      <div
        v-if="open"
        ref="dialog"
        data-quick-open
        class="fixed inset-0 z-[240] flex justify-center bg-black/20 px-4 pt-[12vh]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="quick-open-title"
        @keydown="onDialogKeydown"
      >
        <h2 id="quick-open-title" class="sr-only">Quick Open</h2>
        <button
          type="button"
          data-quick-open-backdrop
          tabindex="-1"
          aria-label="Close quick open"
          class="absolute inset-0"
          @click="requestClose"
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
              role="combobox"
              aria-autocomplete="list"
              aria-controls="quick-open-results"
              :aria-expanded="quickFiles.length > 0"
              :aria-activedescendant="selectedOptionId"
              class="h-full min-w-0 flex-1 bg-transparent font-mono text-[12px] text-ink outline-none placeholder:text-ink-4"
              @input="onInput"
              @keydown.down.prevent="moveSelection(1)"
              @keydown.up.prevent="moveSelection(-1)"
              @keydown.home.prevent="selectEdge('start')"
              @keydown.end.prevent="selectEdge('end')"
              @keydown.enter.prevent="confirm"
            />
            <kbd class="font-mono text-[9px] text-ink-3">ESC</kbd>
          </div>
          <div
            id="quick-open-results"
            class="min-h-0 overflow-y-auto py-1"
            role="listbox"
            aria-label="Workspace files"
          >
            <button
              v-for="(file, index) in quickFiles"
              :key="file.path"
              type="button"
              data-quick-open-row
              :id="optionId(index)"
              role="option"
              :aria-selected="index === files.selectionIndex"
              :tabindex="index === files.selectionIndex ? 0 : -1"
              class="flex h-9 w-full items-center gap-3 px-3 text-left hover:bg-chrome-mid"
              :class="{ 'bg-accent-soft': index === files.selectionIndex }"
              @focus="setSelection(index)"
              @mouseenter="setSelection(index)"
              @keydown.down.prevent="moveSelection(1, true)"
              @keydown.up.prevent="moveSelection(-1, true)"
              @keydown.home.prevent="selectEdge('start', true)"
              @keydown.end.prevent="selectEdge('end', true)"
              @keydown.enter.prevent="openFile(file.path)"
              @click="openFile(file.path)"
            >
              <span class="min-w-0 flex-1 truncate text-[11px] font-medium">{{ file.name }}</span>
              <span class="max-w-[60%] truncate font-mono text-[9px] text-ink-3">{{ file.relativePath }}</span>
            </button>
            <div
              v-if="searching"
              class="grid h-24 place-items-center text-[11px] text-ink-3"
              role="status"
            >
              Searching indexed files…
            </div>
            <div
              v-else-if="searchError"
              data-quick-open-error
              class="grid h-24 place-items-center px-6 text-center text-[11px] text-rem"
              role="alert"
            >
              {{ searchError }}
            </div>
            <div
              v-else-if="!quickFiles.length"
              class="grid h-24 place-items-center text-[11px] text-ink-3"
            >
              {{ files.workspacePath ? 'No matching files.' : 'Open a workspace to jump to files.' }}
            </div>
          </div>
          <div class="flex h-7 shrink-0 items-center gap-3 border-t border-rule bg-chrome-high px-3 font-mono text-[9px] text-ink-3">
            <span>↑↓ select</span>
            <span>↵ open in Editor</span>
            <span class="ml-auto">
              {{ quickFiles.length }}{{ files.visibleFiles.length > quickFiles.length ? ` of ${files.visibleFiles.length}` : '' }} files
            </span>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { IconFileSearch } from '@tabler/icons-vue'
import { useWorkspaceFilesStore } from '../../stores/workspaceFiles.js'

const SEARCH_DEBOUNCE_MS = 130

const props = defineProps({
  open: { type: Boolean, default: false },
})
const emit = defineEmits(['close', 'openFile'])
const files = useWorkspaceFilesStore()
const query = ref('')
const input = ref(null)
const dialog = ref(null)
const searching = ref(false)
const searchError = ref('')
const quickFiles = computed(() => files.visibleFiles.slice(0, 100))
const selectedOptionId = computed(() => (
  quickFiles.value.length ? optionId(files.selectionIndex) : undefined
))
let queryTimer = null
let searchGeneration = 0
let previousFocus = null

watch(
  () => props.open,
  async (open, wasOpen) => {
    if (!open) {
      cancelPendingSearch()
      if (wasOpen) {
        await nextTick()
        if (previousFocus?.isConnected) previousFocus.focus()
        previousFocus = null
      }
      return
    }
    previousFocus = document.activeElement
    cancelPendingSearch()
    query.value = ''
    searchError.value = ''
    await files.setQuery('')
    if (!props.open) return
    await nextTick()
    input.value?.focus()
  },
  { immediate: true },
)

function onInput() {
  cancelPendingSearch()
  const value = query.value
  const generation = ++searchGeneration
  searching.value = Boolean(value.trim())
  searchError.value = ''
  queryTimer = setTimeout(async () => {
    queryTimer = null
    try {
      await files.setQuery(value)
    } catch (cause) {
      if (generation === searchGeneration) searchError.value = errorMessage(cause)
    } finally {
      if (generation === searchGeneration) searching.value = false
    }
  }, SEARCH_DEBOUNCE_MS)
}

function confirm() {
  const file = quickFiles.value[files.selectionIndex]
  if (file) openFile(file.path)
}

function openFile(path) {
  emit('openFile', path)
  requestClose()
}

function requestClose() {
  emit('close')
}

function setSelection(index) {
  files.selectionIndex = Math.min(Math.max(index, 0), Math.max(quickFiles.value.length - 1, 0))
}

function moveSelection(delta, focusRow = false) {
  const total = quickFiles.value.length
  if (!total) {
    files.selectionIndex = 0
    return
  }
  files.selectionIndex = (files.selectionIndex + delta + total) % total
  if (focusRow) focusSelectedRow()
}

function selectEdge(edge, focusRow = false) {
  files.selectionIndex = edge === 'end' ? Math.max(quickFiles.value.length - 1, 0) : 0
  if (focusRow) focusSelectedRow()
}

async function focusSelectedRow() {
  await nextTick()
  dialog.value?.querySelector(`#${optionId(files.selectionIndex)}`)?.focus()
}

function onDialogKeydown(event) {
  if (
    event.key === 'Escape'
    || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'w')
  ) {
    event.preventDefault()
    event.stopPropagation()
    requestClose()
    return
  }
  if (event.key !== 'Tab') return
  const targets = [
    input.value,
    dialog.value?.querySelector('[data-quick-open-row][tabindex="0"]'),
  ].filter(Boolean)
  if (!targets.length) return
  const current = targets.indexOf(document.activeElement)
  const next = event.shiftKey
    ? (current <= 0 ? targets.at(-1) : targets[current - 1])
    : (current < 0 || current === targets.length - 1 ? targets[0] : targets[current + 1])
  event.preventDefault()
  next.focus()
}

function cancelPendingSearch() {
  searchGeneration += 1
  clearTimeout(queryTimer)
  queryTimer = null
  searching.value = false
}

function optionId(index) {
  return `quick-open-option-${index}`
}

function errorMessage(cause) {
  return cause instanceof Error ? cause.message : String(cause || 'File search failed.')
}

onBeforeUnmount(() => {
  cancelPendingSearch()
  if (previousFocus?.isConnected) previousFocus.focus()
})
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
