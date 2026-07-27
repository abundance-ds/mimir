<template>
  <Teleport to="body">
    <Transition name="quick-open">
      <div
        v-if="open"
        ref="dialog"
        data-quick-open
        class="fixed inset-0 z-[240] flex justify-center bg-black/20 px-4 pt-[6vh]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="quick-open-title"
        @keydown="onDialogKeydown"
      >
        <h2 id="quick-open-title" class="sr-only">Go to</h2>
        <button
          type="button"
          data-quick-open-backdrop
          tabindex="-1"
          aria-label="Close Go to"
          class="absolute inset-0"
          @click="requestClose"
        />
        <div
          data-quick-open-panel
          class="relative flex max-h-[min(420px,calc(100vh-32px))] w-full max-w-[640px] flex-col self-start overflow-hidden border border-rule bg-surface"
        >
          <div class="flex h-11 shrink-0 items-center gap-2 border-b border-rule px-3">
            <IconSearch :size="16" :stroke-width="1.7" class="text-ink-3" />
            <span
              v-if="scope !== 'all'"
              data-quick-open-scope
              class="shrink-0 bg-chrome-high px-1.5 py-1 font-mono text-[9px] uppercase tracking-[0.08em] text-ink-2"
            >
              {{ scopeLabel }}
            </span>
            <input
              ref="input"
              v-model="query"
              data-quick-open-input
              type="search"
              placeholder="Go to tools, files, or history…"
              role="combobox"
              aria-autocomplete="list"
              aria-controls="quick-open-results"
              :aria-expanded="results.length > 0"
              :aria-activedescendant="selectedResult?.optionId"
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
            aria-label="Tools, new activities, history, and files"
          >
            <template v-for="(result, index) in results" :key="result.key">
              <div
                v-if="startsGroup(index)"
                class="px-3 pb-1 pt-2 font-mono text-[9px] uppercase tracking-[0.12em] text-ink-4"
                role="presentation"
              >
                {{ result.group }}
              </div>
              <button
                type="button"
                data-quick-open-row
                :data-quick-open-type="result.type"
                :data-quick-open-key="result.key"
                :id="result.optionId"
                role="option"
                :aria-selected="index === selectedIndex"
                :tabindex="index === selectedIndex ? 0 : -1"
                class="group flex min-h-10 w-full items-center gap-2.5 px-3 py-1.5 text-left hover:bg-chrome-mid"
                :class="{ 'bg-accent-soft': index === selectedIndex }"
                @focus="setSelection(index)"
                @mouseenter="setSelection(index)"
                @keydown.down.prevent="moveSelection(1, true)"
                @keydown.up.prevent="moveSelection(-1, true)"
                @keydown.home.prevent="selectEdge('start', true)"
                @keydown.end.prevent="selectEdge('end', true)"
                @keydown.enter.prevent="activate(result)"
                @click="activate(result)"
              >
                <span class="grid size-7 shrink-0 place-items-center text-ink-3">
                  <component
                    :is="iconFor(result.icon)"
                    :size="15"
                    :stroke-width="1.7"
                    :monochrome="true"
                    aria-hidden="true"
                  />
                </span>
                <span class="min-w-0 flex-1">
                  <span class="flex min-w-0 items-baseline gap-2">
                    <span class="min-w-0 flex-1 truncate text-[11px] font-medium text-ink">
                      {{ result.title }}
                    </span>
                    <span class="max-w-[48%] shrink-0 truncate font-mono text-[9px] text-ink-3">
                      {{ result.meta }}
                    </span>
                  </span>
                  <span
                    v-if="result.snippet"
                    data-quick-open-snippet
                    class="mt-0.5 block truncate font-mono text-[9px] text-ink-3"
                  >
                    {{ result.snippet }}
                  </span>
                </span>
                <span class="shrink-0 font-mono text-[8px] uppercase tracking-[0.06em] text-ink-4 group-hover:text-ink-2">
                  {{ result.verb }}
                </span>
              </button>
            </template>

            <div
              v-if="searching"
              class="grid h-20 place-items-center text-[11px] text-ink-3"
              role="status"
            >
              Searching…
            </div>
            <div
              v-else-if="searchError"
              data-quick-open-error
              class="grid h-20 place-items-center px-6 text-center text-[11px] text-rem"
              role="alert"
            >
              {{ searchError }}
            </div>
            <div
              v-else-if="!results.length"
              class="grid h-24 place-items-center text-[11px] text-ink-3"
            >
              {{ files.workspacePath ? 'No matching tools, history, or files.' : 'No matching tools or history.' }}
            </div>
          </div>

          <div class="flex h-7 shrink-0 items-center gap-3 border-t border-rule bg-chrome-high px-3 font-mono text-[9px] text-ink-3">
            <span>↑↓ select</span>
            <span>↵ {{ selectedResult?.verb || 'open' }}</span>
            <span class="ml-auto">/ files · @ history · + new</span>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import {
  IconApps,
  IconClockPlay,
  IconFile,
  IconFileStack,
  IconFocus2,
  IconMathPi,
  IconPlus,
  IconRobot,
  IconSearch,
  IconSparkles,
  IconTerminal2,
  IconTopologyStar3,
} from '@tabler/icons-vue'
import { useWorkspaceFilesStore } from '../../stores/workspaceFiles.js'
import { searchActivityHistory } from '../../services/activities.js'
import IconProviderAnthropic from '../../shared/icons/IconProviderAnthropic.vue'
import IconProviderOpenAI from '../../shared/icons/IconProviderOpenAI.vue'
import {
  buildQuickOpenResults,
  parseQuickOpenQuery,
} from '../quickOpenResults.js'

const SEARCH_DEBOUNCE_MS = 130

const props = defineProps({
  open: { type: Boolean, default: false },
  tools: { type: Array, default: () => [] },
  newActivity: { type: Array, default: () => [] },
  history: { type: Array, default: () => [] },
})
const emit = defineEmits(['close', 'activate'])
const files = useWorkspaceFilesStore()
const query = ref('')
const input = ref(null)
const dialog = ref(null)
const selectedIndex = ref(0)
const searching = ref(false)
const searchError = ref('')
const historySnippets = ref(new Map())
const newActivityExpanded = ref(false)
const parsedQuery = computed(() => parseQuickOpenQuery(query.value))
const scope = computed(() => parsedQuery.value.scope)
const scopeLabel = computed(() => ({
  files: 'Files',
  history: 'History',
  'new-activity': 'New activity',
}[scope.value] || 'All'))
const results = computed(() => buildQuickOpenResults({
  query: query.value,
  tools: props.tools,
  newActivity: props.newActivity,
  history: props.history,
  files: files.visibleFiles,
  historySnippets: historySnippets.value,
  newActivityExpanded: newActivityExpanded.value,
}))
const selectedResult = computed(() => results.value[selectedIndex.value] || null)
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
    selectedIndex.value = 0
    searchError.value = ''
    historySnippets.value = new Map()
    newActivityExpanded.value = false
    await files.setQuery('')
    if (!props.open) return
    await nextTick()
    input.value?.focus()
  },
  { immediate: true },
)

watch(
  () => results.value.map(result => result.key).join('|'),
  () => {
    selectedIndex.value = Math.min(
      selectedIndex.value,
      Math.max(results.value.length - 1, 0),
    )
  },
)

function onInput() {
  cancelPendingSearch()
  selectedIndex.value = 0
  historySnippets.value = new Map()
  newActivityExpanded.value = false
  const { scope: nextScope, term } = parsedQuery.value
  const generation = ++searchGeneration
  const searchFiles = nextScope === 'all' || nextScope === 'files'
  const searchHistory = Boolean(term) && (nextScope === 'all' || nextScope === 'history')
  searching.value = Boolean(term) && (searchFiles || searchHistory)
  searchError.value = ''
  queryTimer = setTimeout(async () => {
    queryTimer = null
    const errors = []
    const jobs = []
    if (searchFiles) {
      jobs.push(
        files.setQuery(term).catch((cause) => errors.push(errorMessage(cause))),
      )
    } else {
      jobs.push(files.setQuery(''))
    }
    if (searchHistory) {
      jobs.push(
        searchActivityHistory(term, 30)
          .then((hits) => {
            if (generation !== searchGeneration) return
            historySnippets.value = new Map(
              (Array.isArray(hits) ? hits : [])
                .map(hit => [hit.activityId, String(hit.snippet || '')]),
            )
          })
          .catch((cause) => errors.push(errorMessage(cause))),
      )
    }
    await Promise.all(jobs)
    if (generation !== searchGeneration) return
    searchError.value = errors[0] || ''
    searching.value = false
  }, SEARCH_DEBOUNCE_MS)
}

function confirm() {
  if (selectedResult.value) activate(selectedResult.value)
}

function activate(result) {
  if (result.type === 'new-activity-toggle') {
    newActivityExpanded.value = !newActivityExpanded.value
    return
  }
  emit('activate', result)
  requestClose()
}

function requestClose() {
  emit('close')
}

function setSelection(index) {
  selectedIndex.value = Math.min(Math.max(index, 0), Math.max(results.value.length - 1, 0))
}

function moveSelection(delta, focusRow = false) {
  const total = results.value.length
  if (!total) {
    selectedIndex.value = 0
    return
  }
  selectedIndex.value = (selectedIndex.value + delta + total) % total
  if (focusRow) focusSelectedRow()
}

function selectEdge(edge, focusRow = false) {
  selectedIndex.value = edge === 'end' ? Math.max(results.value.length - 1, 0) : 0
  if (focusRow) focusSelectedRow()
}

async function focusSelectedRow() {
  await nextTick()
  dialog.value?.querySelector(`#${selectedResult.value?.optionId}`)?.focus()
}

function startsGroup(index) {
  return index === 0 || results.value[index - 1]?.group !== results.value[index]?.group
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

function errorMessage(cause) {
  return cause instanceof Error ? cause.message : String(cause || 'Search failed.')
}

const icons = {
  files: IconFileStack,
  file: IconFile,
  agent: IconRobot,
  codex: IconProviderOpenAI,
  claude: IconProviderAnthropic,
  pi: IconMathPi,
  terminal: IconTerminal2,
  apps: IconApps,
  today: IconFocus2,
  graph: IconTopologyStar3,
  routines: IconClockPlay,
  'new-activity': IconPlus,
  default: IconSparkles,
}

function iconFor(name) {
  return icons[name] || icons.default
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
