<template>
  <section
    data-changes-app
    class="flex h-full min-h-0 flex-col bg-chrome-high text-ink"
    @keydown.down.prevent="move(1)"
    @keydown.up.prevent="move(-1)"
    @keydown.enter.prevent="openSelected"
  >
    <header class="flex h-10 shrink-0 items-center gap-1 border-b border-rule bg-chrome-high px-2">
      <div class="flex min-w-0 flex-1 items-center">
        <IconGitBranch :size="14" :stroke-width="1.7" class="mx-1 shrink-0 text-ink-3" />
        <span data-change-summary class="truncate font-mono text-[9px] text-ink-3">
          {{ summary }}
        </span>
      </div>
      <button
        v-for="option in filters"
        :key="option.id"
        type="button"
        :data-change-filter="option.id"
        class="h-7 px-2 font-mono text-[8px] uppercase tracking-[0.08em] text-ink-3 hover:bg-chrome hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        :class="{ 'bg-chrome text-ink': filter === option.id }"
        @click="setFilter(option.id)"
      >
        {{ option.label }}
        <span v-if="option.id !== 'all'" class="ml-1 text-ink-4">{{ counts[option.id] }}</span>
      </button>
      <button
        type="button"
        title="Refresh changes"
        aria-label="Refresh changes"
        class="ml-1 grid size-7 place-items-center text-ink-3 hover:bg-chrome hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-40"
        :disabled="loading"
        @click="refresh()"
      >
        <IconRefresh
          :size="13"
          :stroke-width="1.7"
          :class="{ 'motion-safe:animate-spin': loading }"
        />
      </button>
    </header>

    <div
      v-if="workspacePath"
      tabindex="0"
      class="min-h-0 flex-1 overflow-y-auto outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
    >
      <button
        v-for="(change, index) in visibleChanges"
        :key="`${change.status}:${change.path}`"
        type="button"
        :data-change-row="change.path"
        :disabled="change.status === 'deleted'"
        :title="change.status === 'deleted' ? `${change.path} no longer exists` : `Open ${change.path}`"
        class="group grid min-h-11 w-full grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-2 border-b border-rule-light px-3 text-left hover:bg-chrome-mid focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent disabled:opacity-70"
        :class="{ 'bg-accent-soft': index === selectionIndex }"
        @mouseenter="selectionIndex = index"
        @click="selectionIndex = index"
        @dblclick="open(change)"
      >
        <span
          class="grid size-6 place-items-center border font-mono text-[9px] font-semibold"
          :class="statusClass(change.status)"
        >
          {{ statusMark(change.status) }}
        </span>
        <span class="min-w-0">
          <span class="block truncate text-[11px] font-medium">{{ basename(change.path) }}</span>
          <span class="block truncate font-mono text-[8px] text-ink-3">
            {{ directory(change.path) }}
          </span>
        </span>
        <span class="font-mono text-[8px] uppercase tracking-[0.1em] text-ink-4">
          {{ change.status }}
        </span>
      </button>

      <div
        v-if="loading && !loaded"
        class="grid h-40 place-items-center font-mono text-[9px] uppercase tracking-[0.12em] text-ink-3"
      >
        Reading worktree
      </div>

      <div
        v-else-if="!visibleChanges.length && !error"
        data-changes-empty
        class="grid h-48 place-items-center px-8 text-center"
      >
        <div>
          <IconCircleCheck :size="21" :stroke-width="1.5" class="mx-auto text-add" />
          <p class="mt-3 text-[11px] font-semibold">
            {{ filter === 'all' ? 'Worktree clear' : `No ${filter} files` }}
          </p>
          <p class="mt-1 text-[9px] text-ink-3">
            {{ filter === 'all' ? 'There are no uncommitted changes.' : 'Choose another status filter.' }}
          </p>
        </div>
      </div>
    </div>

    <div v-else class="grid min-h-0 flex-1 place-items-center px-8 text-center">
      <div>
        <IconFolderOpen :size="22" :stroke-width="1.5" class="mx-auto text-ink-3" />
        <p class="mt-3 text-[12px] font-semibold">Open a workspace</p>
        <p class="mt-1 text-[10px] leading-relaxed text-ink-3">
          Changes reads the current Git worktree.
        </p>
        <button
          type="button"
          data-changes-choose-workspace
          class="mt-4 h-8 border border-rule px-3 text-[10px] font-semibold hover:bg-chrome focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          @click="$emit('chooseWorkspace')"
        >
          Choose folder
        </button>
      </div>
    </div>

    <div
      v-if="error"
      data-changes-error
      role="alert"
      class="flex shrink-0 items-center gap-3 border-t border-rem/30 bg-rem/5 px-3 py-2"
    >
      <IconAlertTriangle :size="14" :stroke-width="1.6" class="shrink-0 text-rem" />
      <p class="min-w-0 flex-1 text-[10px] text-rem">{{ error }}</p>
      <button
        type="button"
        data-changes-retry
        class="h-7 shrink-0 border border-rem/30 px-2 text-[9px] font-semibold text-rem hover:bg-rem/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-rem"
        @click="refresh()"
      >
        Retry
      </button>
    </div>

    <footer
      v-if="workspacePath"
      class="flex h-7 shrink-0 items-center border-t border-rule bg-chrome-high px-3 font-mono text-[8px] text-ink-4"
    >
      <span>{{ shortWorkspace }}</span>
      <span class="ml-auto">{{ lastRefreshed ? `Updated ${lastRefreshed}` : 'Live while selected' }}</span>
    </footer>
  </section>
</template>

<script setup>
import { computed, onUnmounted, ref, watch } from 'vue'
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconFolderOpen,
  IconGitBranch,
  IconRefresh,
} from '@tabler/icons-vue'
import {
  absoluteWorkspacePath,
  loadGitChanges,
} from '../../services/gitChanges.js'

const props = defineProps({
  workspacePath: { type: String, default: '' },
  active: { type: Boolean, default: false },
})

const emit = defineEmits(['openFile', 'chooseWorkspace', 'diagnostic'])
const changes = ref([])
const filter = ref('all')
const loading = ref(false)
const loaded = ref(false)
const error = ref('')
const selectionIndex = ref(0)
const lastRefreshed = ref('')
let pollTimer = null
let requestSequence = 0

const filters = Object.freeze([
  { id: 'all', label: 'All' },
  { id: 'modified', label: 'M' },
  { id: 'new', label: 'A' },
  { id: 'deleted', label: 'D' },
  { id: 'renamed', label: 'R' },
])

const counts = computed(() => Object.fromEntries(
  filters.slice(1).map((item) => [
    item.id,
    changes.value.filter((change) => change.status === item.id).length,
  ]),
))
const visibleChanges = computed(() => (
  filter.value === 'all'
    ? changes.value
    : changes.value.filter((change) => change.status === filter.value)
))
const summary = computed(() => {
  if (!props.workspacePath) return 'No workspace'
  if (!loaded.value) return 'Worktree'
  const count = changes.value.length
  return `${count} ${count === 1 ? 'file' : 'files'} changed`
})
const shortWorkspace = computed(() => (
  String(props.workspacePath).split(/[\\/]/).filter(Boolean).at(-1) || props.workspacePath
))

watch(
  [() => props.active, () => props.workspacePath],
  ([active, workspace], previous = []) => {
    clearInterval(pollTimer)
    pollTimer = null
    if (!active || !workspace) return
    if (!loaded.value || workspace !== previous[1]) void refresh()
    pollTimer = setInterval(() => void refresh({ silent: true }), 5_000)
  },
  { immediate: true },
)

watch(visibleChanges, () => {
  selectionIndex.value = Math.min(
    selectionIndex.value,
    Math.max(0, visibleChanges.value.length - 1),
  )
})

function setFilter(value) {
  filter.value = value
  selectionIndex.value = 0
}

async function refresh({ silent = false } = {}) {
  if (!props.workspacePath) return
  const sequence = ++requestSequence
  if (!silent) loading.value = true
  try {
    const next = await loadGitChanges(props.workspacePath)
    if (sequence !== requestSequence) return
    changes.value = next
    loaded.value = true
    error.value = ''
    lastRefreshed.value = new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date())
  } catch (cause) {
    if (sequence !== requestSequence) return
    error.value = errorMessage(cause)
    emit('diagnostic', error.value)
  } finally {
    if (sequence === requestSequence) loading.value = false
  }
}

function move(delta) {
  if (!visibleChanges.value.length) return
  selectionIndex.value = (
    selectionIndex.value + delta + visibleChanges.value.length
  ) % visibleChanges.value.length
}

function openSelected() {
  open(visibleChanges.value[selectionIndex.value])
}

function open(change) {
  if (!change || change.status === 'deleted') return
  emit('openFile', absoluteWorkspacePath(props.workspacePath, change.path))
}

function basename(path) {
  return String(path).split(/[\\/]/).filter(Boolean).at(-1) || path
}

function directory(path) {
  const parts = String(path).split(/[\\/]/).filter(Boolean)
  parts.pop()
  return parts.join('/') || 'workspace'
}

function statusMark(status) {
  return { new: 'A', modified: 'M', deleted: 'D', renamed: 'R' }[status] || '?'
}

function statusClass(status) {
  return {
    new: 'border-add/30 bg-add/5 text-add',
    modified: 'border-accent/30 bg-accent-soft text-accent',
    deleted: 'border-rem/30 bg-rem/5 text-rem',
    renamed: 'border-rule bg-chrome text-ink-2',
  }[status]
}

function errorMessage(cause) {
  return cause instanceof Error ? cause.message : String(cause || 'Git changes could not be read.')
}

onUnmounted(() => {
  clearInterval(pollTimer)
  requestSequence += 1
})
</script>
