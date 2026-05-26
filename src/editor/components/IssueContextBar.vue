<template>
  <div class="h-9 shrink-0 border-b border-rule-light bg-surface flex items-center gap-2 px-3">
    <!-- Title (inline-editable) -->
    <input
      v-if="editingTitle"
      ref="titleInput"
      v-model="titleDraft"
      class="bg-transparent text-sm text-ink font-medium outline-none border-b border-accent py-0 px-1 -mx-1 min-w-[120px] max-w-[320px]"
      @blur="commitTitle"
      @keydown.enter.prevent="commitTitle"
      @keydown.escape.prevent="cancelTitle"
    />
    <span
      v-else
      class="text-sm text-ink font-medium truncate max-w-[320px] rounded px-1 -mx-1 hover:bg-chrome-mid"
      @click="startEditTitle"
    >{{ meta.title || 'Untitled' }}</span>

    <template v-if="meta.type === 'issue'">
      <span class="w-px self-stretch bg-rule-light my-2" />

      <!-- Status pill -->
      <label class="inline-flex items-center rounded px-1.5 py-0.5 hover:brightness-95" :style="statusStyle">
        <select
          :value="meta.status"
          class="appearance-none bg-transparent outline-none border-none text-[10px] font-medium"
          style="color: inherit"
          @change="onStatusChange"
        >
          <option v-for="s in ISSUE_STATUSES" :key="s" :value="s">{{ STATUS_LABELS[s] }}</option>
        </select>
        <span class="text-[8px] text-ink-3 pointer-events-none ml-0.5">▾</span>
      </label>

      <!-- Priority -->
      <label class="inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-chrome-mid">
        <PriorityIcon :priority="meta.priority" />
        <select
          :value="meta.priority"
          class="appearance-none bg-transparent outline-none border-none text-xs text-ink-2"
          @change="onPriorityChange"
        >
          <option v-for="p in PRIORITIES" :key="p" :value="p">{{ PRIORITY_LABELS[p] }}</option>
        </select>
        <span class="text-[8px] text-ink-3 pointer-events-none">▾</span>
      </label>
    </template>

    <div class="flex-1" />

    <!-- Dirty indicator (matches tab strip's 5px accent dot) -->
    <span v-if="isDirty" class="w-[5px] h-[5px] rounded-full bg-accent shrink-0" />

    <!-- Send to Agent -->
    <button
      class="inline-flex items-center gap-1 h-[22px] min-w-[22px] px-1.5 rounded-[3px] font-sans text-[12px] text-ink-3 hover:text-ink hover:bg-chrome-high"
      title="Send to Agent panel"
      @click="emit('send-to-agent')"
    >
      <IconSparkles :size="13" :stroke-width="2" />
      <span>Agent</span>
    </button>
  </div>
</template>

<script setup>
import { ref, computed, nextTick } from 'vue'
import { IconSparkles } from '@tabler/icons-vue'
import { useFileStore } from '../../stores/files.js'
import { ISSUE_STATUSES, STATUS_LABELS, PRIORITIES, PRIORITY_LABELS } from '../../services/board/loader.js'
import PriorityIcon from '../../panel/components/board/PriorityIcon.vue'

const STATUS_COLORS = {
  backlog: { bg: 'rgba(128,128,128,0.12)', color: 'inherit' },
  plan: { bg: 'rgba(96,165,250,0.15)', color: '#3b82f6' },
  'in-progress': { bg: 'rgba(245,158,11,0.15)', color: '#d97706' },
  review: { bg: 'rgba(168,85,247,0.15)', color: '#9333ea' },
  done: { bg: 'rgba(34,197,94,0.15)', color: '#16a34a' },
}

const props = defineProps({
  meta: { type: Object, required: true },
  fileId: { type: Number, required: true },
})

const emit = defineEmits(['send-to-agent', 'meta-changed'])
const fileStore = useFileStore()

const file = computed(() => fileStore.openFiles.find(f => f.id === props.fileId))
const isDirty = computed(() => file.value?.dirty ?? false)

const statusStyle = computed(() => {
  const c = STATUS_COLORS[props.meta.status] || STATUS_COLORS.backlog
  return { backgroundColor: c.bg, color: c.color }
})

const editingTitle = ref(false)
const titleDraft = ref('')
const titleInput = ref(null)

function startEditTitle() {
  titleDraft.value = props.meta.title || ''
  editingTitle.value = true
  nextTick(() => titleInput.value?.select())
}

function commitTitle() {
  editingTitle.value = false
  if (titleDraft.value.trim() && titleDraft.value !== props.meta.title) {
    fileStore.updateMeta(props.fileId, { title: titleDraft.value.trim() })
    emit('meta-changed')
  }
}

function cancelTitle() {
  editingTitle.value = false
}

function onStatusChange(e) {
  fileStore.updateMeta(props.fileId, { status: e.target.value })
  emit('meta-changed')
}

function onPriorityChange(e) {
  fileStore.updateMeta(props.fileId, { priority: e.target.value })
  emit('meta-changed')
}
</script>
