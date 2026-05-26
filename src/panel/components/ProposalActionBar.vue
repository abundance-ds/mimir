<template>
  <div v-if="pendingFiles.length > 0" class="proposal-drawer">
    <div class="drawer-bar" @click="expanded = !expanded">
      <IconChevronUp v-if="expanded" :size="10" class="text-ink-3 shrink-0" />
      <IconChevronDown v-else :size="10" class="text-ink-3 shrink-0" />
      <span class="font-sans text-[10.5px] text-ink-3 flex-1">{{ pendingFiles.length }} {{ pendingFiles.length === 1 ? 'file' : 'files' }} pending review</span>
      <button class="font-sans text-[10px] font-medium h-[20px] px-2 rounded-[3px] text-ink-3 hover:text-ink-2 hover:bg-chrome-high border-0 bg-transparent" @click.stop="emit('reject-all')">Reject All</button>
      <button class="font-sans text-[10px] font-medium h-[20px] px-2 rounded-[3px] text-ink-3 hover:text-ink-2 hover:bg-chrome-high border-0 bg-transparent" @click.stop="emit('accept-all')">Accept All</button>
      <button class="font-sans text-[10px] font-semibold h-[20px] px-2 rounded-[3px] bg-accent text-accent-ink hover:opacity-90 border-0" @click.stop="emit('review')">Review</button>
    </div>
    <div v-if="expanded" class="drawer-files">
      <div
        v-for="g in pendingFiles"
        :key="g.path"
        class="flex items-center gap-1.5 px-3 py-1 border-t border-rule-light"
      >
        <span class="font-mono text-[11px] flex-1 min-w-0 truncate text-ink-2">{{ fileName(g) }}</span>
        <span class="font-mono text-[10px] flex gap-1.5 shrink-0">
          <span class="text-add">+{{ g.added }}</span>
          <span class="text-rem">-{{ g.removed }}</span>
        </span>
        <button
          class="shrink-0 size-4.5 flex items-center justify-center rounded text-add hover:bg-chrome-high bg-transparent border-0"
          title="Accept"
          @click.stop="acceptFile(g)"
        >
          <IconCheck :size="11" />
        </button>
        <button
          class="shrink-0 size-4.5 flex items-center justify-center rounded text-rem hover:bg-chrome-high bg-transparent border-0"
          title="Reject"
          @click.stop="rejectFile(g)"
        >
          <IconX :size="11" />
        </button>
        <button
          class="shrink-0 size-4.5 flex items-center justify-center rounded text-ink-3 hover:text-ink-2 hover:bg-chrome-high bg-transparent border-0"
          title="Open in Editor"
          @click.stop="emit('open-file', g.proposals[0])"
        >
          <IconExternalLink :size="10" />
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { IconChevronUp, IconChevronDown, IconCheck, IconX, IconExternalLink } from '@tabler/icons-vue'
import { computeLineDelta } from '../../shared/lineDelta.js'

const props = defineProps({
  proposals: { type: Array, required: true },
})

const emit = defineEmits(['review', 'accept-all', 'reject-all', 'accept-file', 'reject-file', 'open-file'])

const expanded = ref(false)

const pendingFiles = computed(() => {
  const map = new Map()
  for (const p of props.proposals) {
    if (p.status !== 'pending') continue
    const key = p.absolutePath || p.path || 'document.md'
    if (!map.has(key)) map.set(key, { path: key, proposals: [], added: 0, removed: 0 })
    const group = map.get(key)
    group.proposals.push(p)
    const delta = computeLineDelta(p.targetText || '', p.replacement || '')
    group.added += delta.added
    group.removed += delta.removed
  }
  return [...map.values()]
})

function fileName(group) {
  return group.path.split('/').pop()
}

function acceptFile(group) {
  for (const p of group.proposals) emit('accept-file', p)
}

function rejectFile(group) {
  for (const p of group.proposals) emit('reject-file', p)
}
</script>

<style scoped>
.proposal-drawer {
  max-width: calc(720px + 80px);
  margin: 0 auto;
  padding: 0 64px;
}

.drawer-bar {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px;
  background: var(--color-surface);
  border: 1px solid var(--color-rule);
  border-bottom: none;
  border-radius: 8px 8px 0 0;
}

.drawer-files {
  background: var(--color-surface);
  border-left: 1px solid var(--color-rule);
  border-right: 1px solid var(--color-rule);
  max-height: 200px;
  overflow-y: auto;
}
</style>
