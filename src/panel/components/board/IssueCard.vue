<template>
  <div class="rounded border border-rule-light bg-chrome-mid p-3 space-y-2">
    <!-- Header: status pill + priority -->
    <div class="flex items-center gap-2">
      <span
        class="text-[10px] font-medium px-1.5 py-0.5 rounded"
        :style="statusStyle"
      >
        {{ statusLabel }}
      </span>
      <PriorityIcon :priority="data.priority" />
    </div>

    <!-- Title -->
    <p class="text-sm font-medium text-ink line-clamp-2 leading-snug">
      {{ data.title }}
    </p>

    <!-- Task progress -->
    <div v-if="data.taskProgress" class="flex items-center gap-2">
      <span class="text-[11px] text-ink-3">
        {{ data.taskProgress.done }}/{{ data.taskProgress.total }} tasks
      </span>
      <div class="flex-1 h-1 bg-chrome-high rounded overflow-hidden">
        <div
          class="h-full bg-accent rounded"
          :style="{ width: progressPct + '%' }"
        />
      </div>
    </div>

    <!-- Body preview -->
    <p v-if="bodyPreview" class="text-xs text-ink-3 line-clamp-3 leading-relaxed">
      {{ bodyPreview }}
    </p>

    <!-- Action row -->
    <div class="pt-1">
      <button
        class="text-[10.5px] font-medium px-2.5 py-1 rounded bg-surface border border-rule text-ink-2 hover:bg-chrome-mid"
        @click="openInEditor"
      >
        Open in Editor
      </button>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import PriorityIcon from './PriorityIcon.vue'
import { STATUS_LABELS } from '../../../services/board/loader.js'

const props = defineProps({
  data: {
    type: Object,
    required: true,
  },
})

const statusLabel = computed(() => STATUS_LABELS[props.data.status] || props.data.status)

const STATUS_COLORS = {
  backlog: { bg: 'rgba(128,128,128,0.12)', color: 'inherit' },
  plan: { bg: 'rgba(96,165,250,0.15)', color: '#3b82f6' },
  'in-progress': { bg: 'rgba(245,158,11,0.15)', color: '#d97706' },
  review: { bg: 'rgba(168,85,247,0.15)', color: '#9333ea' },
  done: { bg: 'rgba(34,197,94,0.15)', color: '#16a34a' },
}

const statusStyle = computed(() => {
  const c = STATUS_COLORS[props.data.status] || STATUS_COLORS.backlog
  return { backgroundColor: c.bg, color: c.color }
})

const progressPct = computed(() => {
  if (!props.data.taskProgress || props.data.taskProgress.total === 0) return 0
  return Math.round((props.data.taskProgress.done / props.data.taskProgress.total) * 100)
})

function stripMd(text) {
  return text.replace(/^#{1,6}\s+/gm, '').replace(/[*_~`]/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim()
}

const bodyPreview = computed(() => {
  if (!props.data.body) return ''
  const plain = stripMd(props.data.body)
  return plain.length > 200 ? plain.slice(0, 200) + '...' : plain
})

async function openInEditor() {
  const { invoke } = await import('@tauri-apps/api/core')
  invoke('open_files_in_editor', { paths: [props.data.boardFilePath] })
}
</script>
