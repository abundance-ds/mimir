<template>
  <div
    data-git-review-bar
    class="git-review-bar relative flex h-[32px] shrink-0 items-center gap-2 border-b border-rule-light bg-chrome-high px-3"
  >
    <template v-if="review">
      <span class="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-2" :title="review.path">
        {{ review.path }}
      </span>
      <span class="git-scope-label shrink-0 font-mono text-[9px] text-ink-4" :title="scopeDetail">
        {{ scopeLabel }}
      </span>
      <span
        data-git-review-state
        class="shrink-0 font-mono text-[9px]"
        :class="stateTone"
        :title="stateDetail"
      >{{ stateLabel }}</span>
      <span class="git-change-stats shrink-0 font-mono text-[9px] tabular-nums">
        <span class="text-add">+{{ review.added }}</span>
        <span class="ml-1 text-rem">−{{ review.removed }}</span>
      </span>

      <div class="ml-1 flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          class="git-review-action"
          :disabled="review.status === 'deleted'"
          aria-label="Open changed file"
          title="Open changed file"
          @mousedown.prevent
          @click="$emit('openFile')"
        >
          <IconFileCode :size="13" :stroke-width="1.7" />
          <span class="git-action-label">Open</span>
        </button>
        <button
          ref="agentButton"
          type="button"
          data-git-ask-agent
          class="git-review-action"
          :disabled="!agentPresets.length"
          aria-label="Choose an agent for this Git change"
          aria-haspopup="menu"
          :aria-expanded="agentMenuOpen"
          :title="agentPresets.length ? 'Choose an agent and edit the draft before sending' : 'No agent launcher is available'"
          @mousedown.prevent
          @click="toggleAgentMenu"
          @keydown.down.prevent="openAgentMenu"
        >
          <IconMessageCode :size="13" :stroke-width="1.7" />
          <span class="git-action-label">Ask agent…</span>
          <IconChevronDown class="git-action-chevron" :size="10" :stroke-width="1.8" />
        </button>
        <button
          v-if="reviewNewEditsVisible"
          type="button"
          data-git-review-new-edits
          class="git-review-action git-review-primary"
          :disabled="git.actionBusy"
          aria-label="Review new edits that are not staged"
          title="Review new edits that are not staged"
          @mousedown.prevent
          @click="reviewNewEdits"
        >
          <IconGitCompare :size="13" :stroke-width="1.8" />
          <span class="git-action-label">Review new edits</span>
        </button>
        <button
          v-if="currentStaged && canUnstage"
          type="button"
          data-git-unstage
          class="git-review-action"
          :disabled="git.actionBusy"
          aria-label="Unstage file"
          title="Remove this file from the next commit. The working file does not change."
          @mousedown.prevent
          @click="git.unstageCurrent()"
        >
          <IconMinus :size="13" :stroke-width="1.9" />
          <span class="git-action-label">Unstage</span>
        </button>
        <button
          v-if="currentUnstaged && !review.conflicted && (canStage || dirty)"
          type="button"
          data-git-stage
          class="git-review-action git-review-primary"
          :disabled="git.actionBusy || dirty"
          :aria-label="stageTitle"
          :title="stageTitle"
          @mousedown.prevent
          @click="git.stageCurrent()"
        >
          <IconPlus :size="13" :stroke-width="1.9" />
          <span class="git-action-label">Stage file</span>
        </button>
      </div>

      <div
        v-if="agentMenuOpen"
        ref="agentMenu"
        data-git-agent-menu
        class="absolute right-9 top-[30px] z-50 w-56 border border-rule bg-surface p-1 shadow-lg"
        role="menu"
        aria-label="Choose an agent for this Git change"
        @keydown="onAgentMenuKeydown"
      >
        <button
          v-for="preset in agentPresets"
          :key="preset.id"
          type="button"
          role="menuitem"
          tabindex="-1"
          :data-git-agent-preset="preset.id"
          class="flex h-7 w-full items-center gap-2 px-2 text-left text-[10px] text-ink-2 outline-none hover:bg-chrome-mid hover:text-ink focus-visible:bg-chrome-mid focus-visible:text-ink"
          @click="chooseAgent(preset.id)"
        >
          <IconMessageCode :size="13" :stroke-width="1.7" class="shrink-0 text-accent" />
          <span class="min-w-0 flex-1 truncate">{{ preset.title }}</span>
          <span class="shrink-0 font-mono text-[9px] text-ink-4">{{ preset.agentId || preset.id }}</span>
        </button>
      </div>
    </template>
    <span v-else class="min-w-0 flex-1 truncate text-[10px] text-ink-3">
      {{ git.loading ? `Loading ${git.requestedFile}` : git.error }}
    </span>
    <button
      type="button"
      class="git-review-close ml-1 grid size-6 shrink-0 place-items-center text-ink-4 outline-none hover:bg-chrome hover:text-ink focus-visible:ring-1 focus-visible:ring-accent"
      aria-label="Close Git review"
      title="Close Git review"
      @mousedown.prevent
      @click="$emit('close')"
    >
      <IconX :size="13" :stroke-width="1.8" />
    </button>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import {
  IconChevronDown,
  IconFileCode,
  IconGitCompare,
  IconMessageCode,
  IconMinus,
  IconPlus,
  IconX,
} from '@tabler/icons-vue'
import { useGitReviewStore } from '../../../stores/gitReview.js'
import { useLaunchersStore } from '../../../stores/launchers.js'

const props = defineProps({
  dirty: { type: Boolean, default: false },
})

const emit = defineEmits(['openFile', 'askAgent', 'close'])
const git = useGitReviewStore()
const launchers = useLaunchersStore()
const agentButton = ref(null)
const agentMenu = ref(null)
const agentMenuOpen = ref(false)
const review = computed(() => git.review)
const currentChange = computed(() => git.currentChange || review.value)
const currentStaged = computed(() => Boolean(currentChange.value?.staged))
const currentUnstaged = computed(() => Boolean(currentChange.value?.unstaged))
const agentPresets = computed(() => launchers.availablePresets.filter(
  preset => preset.kind === 'agent',
))
const canStage = computed(() => (
  currentUnstaged.value
  && !review.value.conflicted
  && review.value.scope !== 'staged'
  && !(review.value.scope === 'all' && currentStaged.value)
))
const canUnstage = computed(() => (
  currentStaged.value
  && review.value.scope !== 'unstaged'
  && !(review.value.scope === 'all' && currentUnstaged.value)
))
const reviewNewEditsVisible = computed(() => (
  currentStaged.value
  && currentUnstaged.value
  && review.value?.scope !== 'unstaged'
))
const stageTitle = computed(() => {
  if (props.dirty) return 'Save the open file before staging it'
  return 'Include this reviewed file in the next commit. This does not create a commit.'
})
const scopeLabel = computed(() => ({
  all: 'all changes',
  unstaged: 'unstaged diff',
  staged: 'staged diff',
})[review.value?.scope] || '')
const scopeDetail = computed(() => ({
  all: 'Last commit to working file',
  unstaged: 'Staged version to working file',
  staged: 'Last commit to staged version',
})[review.value?.scope] || '')
const stateLabel = computed(() => {
  if (props.dirty && currentUnstaged.value) return 'Unsaved text not included'
  if (review.value?.conflicted) return 'Conflict'
  if (currentStaged.value && currentUnstaged.value) return 'New edits not staged'
  if (currentStaged.value) return 'Ready to commit'
  return 'Not staged'
})
const stateDetail = computed(() => {
  if (props.dirty && currentUnstaged.value) return 'Save the open Editor file before staging it.'
  if (review.value?.conflicted) return 'Resolve this conflict outside this review.'
  if (currentStaged.value && currentUnstaged.value) return 'The staged version is ready, but the working file has newer edits.'
  if (currentStaged.value) return 'This file is included in the next commit. No commit has been created.'
  return 'This file is not included in the next commit.'
})
const stateTone = computed(() => {
  if (review.value?.conflicted) return 'text-rem'
  if ((props.dirty && currentUnstaged.value) || (currentStaged.value && currentUnstaged.value)) return 'text-attn'
  if (currentStaged.value) return 'text-add'
  return 'text-ink-3'
})

async function toggleAgentMenu() {
  if (agentMenuOpen.value) return closeAgentMenu({ restore: true })
  await openAgentMenu()
}

async function openAgentMenu() {
  if (!agentPresets.value.length) return
  agentMenuOpen.value = true
  await nextTick()
  agentMenu.value?.querySelector('[role="menuitem"]')?.focus()
}

function closeAgentMenu({ restore = false } = {}) {
  agentMenuOpen.value = false
  if (restore) nextTick(() => agentButton.value?.focus())
}

function chooseAgent(presetId) {
  closeAgentMenu()
  emit('askAgent', presetId)
}

function onAgentMenuKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault()
    closeAgentMenu({ restore: true })
    return
  }
  const items = [...(agentMenu.value?.querySelectorAll('[role="menuitem"]') || [])]
  if (!items.length) return
  if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault()
    items[event.key === 'Home' ? 0 : items.length - 1]?.focus()
    return
  }
  if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return
  event.preventDefault()
  const index = items.indexOf(document.activeElement)
  const delta = event.key === 'ArrowDown' ? 1 : -1
  items[(index + delta + items.length) % items.length]?.focus()
}

function closeAgentMenuFromOutside(event) {
  if (
    agentMenuOpen.value
    && !event.target.closest('[data-git-agent-menu], [data-git-ask-agent]')
  ) closeAgentMenu()
}

function reviewNewEdits() {
  if (!review.value?.path) return
  closeAgentMenu()
  void git.reviewFile(review.value.path, { scope: 'unstaged' })
}

onMounted(() => document.addEventListener('pointerdown', closeAgentMenuFromOutside, true))
onUnmounted(() => document.removeEventListener('pointerdown', closeAgentMenuFromOutside, true))
</script>

<style scoped>
.git-review-bar {
  container: git-review-bar / inline-size;
}

.git-review-action {
  display: inline-flex;
  height: 24px;
  align-items: center;
  gap: 4px;
  padding: 0 7px;
  color: var(--color-ink-3);
  font-family: var(--font-sans);
  font-size: 10px;
  font-weight: 600;
  outline: none;
}

.git-review-action:hover:not(:disabled) {
  background: var(--color-chrome);
  color: var(--color-ink);
}

.git-review-action:focus-visible {
  box-shadow: inset 0 0 0 1px var(--color-accent);
}

.git-review-action:disabled {
  opacity: 0.42;
}

.git-review-primary {
  background: var(--color-accent);
  color: var(--color-accent-ink);
}

.git-review-primary:hover:not(:disabled) {
  background: var(--color-accent);
  color: var(--color-accent-ink);
  opacity: 0.9;
}

@container git-review-bar (max-width: 620px) {
  .git-action-label {
    display: none;
  }

  .git-action-chevron {
    display: none;
  }

  .git-review-action {
    width: 24px;
    justify-content: center;
    padding: 0;
  }
}

@container git-review-bar (max-width: 430px) {
  .git-scope-label {
    display: none;
  }

  .git-change-stats {
    display: none;
  }
}
</style>
