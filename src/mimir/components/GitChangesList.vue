<template>
  <section class="flex min-h-0 flex-1 flex-col bg-surface" aria-label="Git changes">
    <div
      v-if="git.repositoryState !== 'not-repository'"
      class="flex h-8 shrink-0 items-center border-b border-rule-light bg-chrome-high px-2"
    >
      <span v-if="managed" class="font-mono text-[9px] text-ink-4">
        Unpublished batch · {{ eligibleChanges.length }}
      </span>
      <div v-else class="flex h-6 items-center border border-rule-light" role="group" aria-label="Git change scope">
        <button
          v-for="option in scopes"
          :key="option.id"
          type="button"
          :data-git-scope="option.id"
          :aria-pressed="git.scope === option.id"
          class="h-full px-2 font-mono text-[9px] text-ink-4 outline-none hover:bg-chrome hover:text-ink focus-visible:ring-1 focus-visible:ring-accent"
          :class="{ 'bg-surface text-ink': git.scope === option.id }"
          @click="selectScope(option.id)"
        >
          {{ option.label }} {{ option.count }}
        </button>
      </div>
      <button
        type="button"
        data-git-refresh
        aria-label="Refresh Git changes"
        title="Refresh Git changes"
        :disabled="git.changesLoading"
        class="ml-auto grid size-6 place-items-center text-ink-4 outline-none hover:bg-chrome hover:text-ink focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-40"
        @click="git.refreshChanges()"
      >
        <IconRefresh :size="12" :stroke-width="1.8" :class="{ 'motion-safe:animate-spin': git.changesLoading }" />
      </button>
    </div>

    <div
      ref="listRef"
      data-git-changes-list
      role="listbox"
      aria-label="Changed files"
      tabindex="0"
      class="scrollbar-thin min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
      @keydown="onKeydown"
    >
      <button
        v-for="(change, index) in filteredChanges"
        :key="change.path"
        type="button"
        :data-git-change="change.path"
        role="option"
        :aria-selected="selectedPath === change.path"
        :aria-label="changeAriaLabel(change)"
        class="grid h-9 w-full grid-cols-[24px_minmax(0,1fr)_auto] items-center border-b border-rule-light px-2 text-left outline-none hover:bg-chrome-high focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
        :class="selectedPath === change.path ? 'bg-accent-soft text-ink' : 'text-ink-2'"
        @click="review(change, index)"
        @dblclick.prevent="openFile(change)"
      >
        <span
          class="font-mono text-[10px] font-semibold"
          :class="statusTone(change.status)"
          :title="statusLabel(change.status)"
        >{{ statusMark(change.status) }}</span>
        <span class="min-w-0">
          <span class="block truncate text-[12px]">{{ basename(change.path) }}</span>
          <span class="block truncate font-mono text-[9px] leading-3 text-ink-4">
            {{ change.oldPath ? `${change.oldPath} → ${change.path}` : parentPath(change.path) }}
          </span>
        </span>
        <span class="ml-2 flex shrink-0 items-center gap-1.5 font-mono text-[9px] text-ink-4">
          <span v-if="change.conflicted" class="text-rem">conflict</span>
          <template v-else-if="!managed && git.scope === 'all'">
            <span v-if="change.staged">staged</span>
            <span v-if="change.unstaged">unstaged</span>
          </template>
        </span>
      </button>

      <div v-if="git.changesLoading && !filteredChanges.length" class="grid h-40 place-items-center text-center">
        <div>
          <IconLoader2 :size="18" :stroke-width="1.6" class="mx-auto motion-safe:animate-spin text-accent" />
          <p class="mt-2 text-[10px] text-ink-3">Reading Git changes</p>
        </div>
      </div>
      <div
        v-else-if="git.repositoryState === 'not-repository'"
        data-git-not-repository
        class="grid min-h-52 place-items-center px-8 text-center"
      >
        <div class="max-w-xs">
          <IconGitCompare :size="21" :stroke-width="1.5" class="mx-auto text-ink-3" />
          <p class="mt-3 text-[12px] font-semibold">No Git repository</p>
          <p class="mt-1 text-[10px] leading-relaxed text-ink-3">
            This folder is not tracked with Git. Initialize Git, then check again.
          </p>
          <button
            type="button"
            class="mt-4 h-8 border border-rule px-3 text-[10px] font-semibold hover:bg-chrome focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            @click="git.refreshChanges()"
          >Check again</button>
        </div>
      </div>
      <div v-else-if="git.changesError" role="alert" class="grid min-h-48 place-items-center px-8 text-center">
        <div class="max-w-xs">
          <IconAlertTriangle :size="20" :stroke-width="1.5" class="mx-auto text-rem" />
          <p class="mt-3 text-[12px] font-semibold">Changes could not be loaded</p>
          <p class="mt-1 break-words text-[10px] leading-relaxed text-ink-3">{{ git.changesError }}</p>
          <button
            type="button"
            class="mt-4 h-8 border border-rule px-3 text-[10px] font-semibold hover:bg-chrome focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            @click="git.refreshChanges()"
          >Try again</button>
        </div>
      </div>
      <div v-else-if="!filteredChanges.length" class="grid min-h-48 place-items-center px-8 text-center">
        <div class="max-w-xs">
          <IconGitCompare :size="21" :stroke-width="1.5" class="mx-auto text-ink-3" />
          <p class="mt-3 text-[12px] font-semibold">{{ emptyTitle }}</p>
          <p class="mt-1 text-[10px] leading-relaxed text-ink-3">{{ emptyBody }}</p>
        </div>
      </div>
    </div>

    <div
      v-if="git.notice"
      role="status"
      class="flex h-7 shrink-0 items-center border-t border-rule-light bg-chrome-high px-3 text-[10px] text-add"
    >{{ git.notice }}</div>
  </section>
</template>

<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import {
  IconAlertTriangle,
  IconGitCompare,
  IconLoader2,
  IconRefresh,
} from '@tabler/icons-vue'
import { useGitReviewStore } from '../../stores/gitReview.js'
import { absoluteWorkspacePath } from '../../services/gitChanges.js'
import { basename, dirname } from '../../shared/utils/path.js'

const props = defineProps({
  query: { type: String, default: '' },
  managed: { type: Boolean, default: false },
  excludedPaths: { type: Array, default: () => [] },
})

const emit = defineEmits(['review', 'openFile'])
const git = useGitReviewStore()
const listRef = ref(null)
const focusedIndex = ref(0)

const scopes = computed(() => [
  { id: 'all', label: 'All', count: git.changes.length },
  { id: 'unstaged', label: 'Unstaged', count: git.unstagedCount },
  { id: 'staged', label: 'Staged', count: git.stagedCount },
])

const excludedPaths = computed(() => new Set(props.excludedPaths.map(path => String(path))))
const eligibleChanges = computed(() => (
  props.managed
    ? git.visibleChanges.filter(change => !excludedPaths.value.has(change.path))
    : git.visibleChanges
))
const filteredChanges = computed(() => {
  const needle = props.query.trim().toLowerCase()
  return needle
    ? eligibleChanges.value.filter(change => (
        change.path.toLowerCase().includes(needle)
        || change.oldPath?.toLowerCase().includes(needle)
      ))
    : eligibleChanges.value
})

const selectedPath = computed(() => git.active ? git.review?.path || '' : '')
const emptyTitle = computed(() => props.query.trim()
  ? 'No matching changes'
  : git.scope === 'staged' ? 'Nothing is staged'
    : git.scope === 'unstaged' ? 'No unstaged changes'
      : 'Working tree clean')
const emptyBody = computed(() => props.query.trim()
  ? 'Try a shorter path.'
  : git.scope === 'staged' ? 'Stage a file when it is ready to commit.'
    : git.scope === 'unstaged' ? 'All current changes are staged.'
      : 'New agent and editor changes will appear here.')

watch(filteredChanges, (changes) => {
  focusedIndex.value = Math.min(focusedIndex.value, Math.max(changes.length - 1, 0))
})

watch(() => props.managed, (managed) => {
  if (managed && git.scope !== 'all') void git.setScope('all')
}, { immediate: true })

async function selectScope(scope) {
  await git.setScope(scope)
  focusedIndex.value = 0
  await nextTick()
  listRef.value?.focus()
}

function review(change, index) {
  focusedIndex.value = index
  emit('review', {
    workspacePath: git.workspacePath,
    file: change.path,
    scope: git.scope,
    ...(props.managed ? { managed: true } : {}),
  })
}

function openFile(change) {
  if (change.status === 'deleted') return
  emit('openFile', {
    path: absoluteWorkspacePath(git.workspacePath, change.path),
    preview: false,
  })
}

function onKeydown(event) {
  const total = filteredChanges.value.length
  if (!total) return
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    const delta = event.key === 'ArrowDown' ? 1 : -1
    focusedIndex.value = (focusedIndex.value + delta + total) % total
    review(filteredChanges.value[focusedIndex.value], focusedIndex.value)
    scrollFocusedIntoView()
  } else if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault()
    focusedIndex.value = event.key === 'Home' ? 0 : total - 1
    review(filteredChanges.value[focusedIndex.value], focusedIndex.value)
    scrollFocusedIntoView()
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    review(filteredChanges.value[focusedIndex.value], focusedIndex.value)
  }
}

function scrollFocusedIntoView() {
  nextTick(() => {
    listRef.value?.querySelectorAll?.('[data-git-change]')[focusedIndex.value]
      ?.scrollIntoView?.({ block: 'nearest' })
  })
}

function enter(delta = 1) {
  const total = filteredChanges.value.length
  if (!total) return
  focusedIndex.value = delta > 0 ? 0 : total - 1
  listRef.value?.focus()
  review(filteredChanges.value[focusedIndex.value], focusedIndex.value)
  scrollFocusedIntoView()
}

defineExpose({ enter })

function parentPath(path) {
  const parent = dirname(path)
  return parent && parent !== '.' ? parent : 'workspace'
}

function statusMark(status) {
  return { new: 'A', modified: 'M', deleted: 'D', renamed: 'R', conflicted: '!' }[status] || '•'
}

function statusLabel(status) {
  return { new: 'Added', modified: 'Modified', deleted: 'Deleted', renamed: 'Renamed', conflicted: 'Conflict' }[status] || 'Changed'
}

function statusTone(status) {
  return { new: 'text-add', modified: 'text-accent', deleted: 'text-rem', renamed: 'text-ink-3', conflicted: 'text-rem' }[status] || 'text-ink-3'
}

function changeAriaLabel(change) {
  const states = []
  if (change.conflicted) states.push('conflict')
  else {
    if (change.staged) states.push('staged')
    if (change.unstaged) states.push('unstaged')
  }
  return `${change.path}, ${statusLabel(change.status)}, ${states.join(' and ')}`
}
</script>
