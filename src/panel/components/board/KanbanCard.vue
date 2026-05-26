<template>
  <div
    class="group rounded border border-rule-light p-2 text-left"
    :class="[
      ghost ? 'bg-surface shadow-sm w-[160px]' : 'bg-surface hover:bg-chrome-high',
      dimmed && 'opacity-30',
    ]"
  >
    <div class="flex items-start gap-1">
      <span class="font-sans text-[11.5px] font-medium text-ink line-clamp-2 leading-snug flex-1">
        {{ entry.meta.title }}
      </span>
      <div ref="priorityRef" class="relative">
        <div
          class="rounded hover:bg-chrome-mid p-px"
          @click.stop="priorityMenuOpen = !priorityMenuOpen"
        >
          <PriorityIcon :priority="entry.meta.priority" class="mt-0.5" />
        </div>
        <div v-if="priorityMenuOpen" class="absolute right-0 top-full mt-1 z-50 min-w-[110px] p-1 bg-surface border border-rule rounded-md shadow-lg">
          <button
            v-for="p in PRIORITIES"
            :key="p"
            class="flex items-center gap-1.5 w-full h-[24px] px-1.5 rounded text-left font-sans text-[11px] text-ink-2 hover:bg-chrome-mid"
            :class="p === entry.meta.priority && 'bg-chrome-mid text-ink'"
            @click.stop="selectPriority(p)"
          >
            <PriorityIcon :priority="p" />
            {{ PRIORITY_LABELS[p] }}
          </button>
        </div>
      </div>
    </div>
    <div v-if="hasFooter" class="flex items-center gap-2 mt-1.5">
      <span v-if="deliverableCount" class="font-mono text-[9px] text-ink-3">
        {{ deliverableCount }} file{{ deliverableCount > 1 ? 's' : '' }}
      </span>
      <span class="flex-1" />
      <div class="relative" @click.stop>
        <span
          v-if="!dateEditing && dueInfo"
          class="font-mono text-[9px] hover:bg-chrome-mid rounded px-0.5"
          :class="dueInfo.cls"
          @click="startDateEdit"
        >{{ dueInfo.label }}</span>
        <span
          v-else-if="!dateEditing && shortDate"
          class="font-mono text-[9px] text-ink-3 hover:bg-chrome-mid rounded px-0.5"
          @click="startDateEdit"
        >{{ shortDate }}</span>
        <span
          v-else-if="!dateEditing && !dueInfo && !shortDate"
          class="font-mono text-[9px] text-ink-3 opacity-0 group-hover:opacity-100 hover:bg-chrome-mid rounded px-0.5"
          @click="startDateEdit"
        >+ date</span>
        <input
          v-if="dateEditing"
          ref="dateInputRef"
          type="date"
          class="font-mono text-[9px] text-ink bg-chrome-mid border border-rule rounded px-1 py-px w-[110px] outline-none focus:border-accent"
          :value="entry.meta.dueDate || ''"
          @change="onDateChange"
          @blur="dateEditing = false"
          @keydown.escape="dateEditing = false"
        />
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, nextTick, onMounted, onBeforeUnmount } from 'vue'
import PriorityIcon from './PriorityIcon.vue'
import { PRIORITIES, PRIORITY_LABELS } from '../../../services/board/loader.js'

const props = defineProps({
  entry: { type: Object, required: true },
  ghost: { type: Boolean, default: false },
  dimmed: { type: Boolean, default: false },
})

const emit = defineEmits(['update-priority', 'update-due-date'])

const priorityMenuOpen = ref(false)
const priorityRef = ref(null)
const dateEditing = ref(false)
const dateInputRef = ref(null)

function selectPriority(p) {
  priorityMenuOpen.value = false
  emit('update-priority', { entryId: props.entry.id, priority: p })
}

function startDateEdit() {
  dateEditing.value = true
  nextTick(() => {
    dateInputRef.value?.showPicker?.()
    dateInputRef.value?.focus()
  })
}

function onDateChange(e) {
  dateEditing.value = false
  emit('update-due-date', { entryId: props.entry.id, dueDate: e.target.value })
}

function onPointerDown(e) {
  if (priorityMenuOpen.value && priorityRef.value && !priorityRef.value.contains(e.target)) {
    priorityMenuOpen.value = false
  }
}

onMounted(() => document.addEventListener('pointerdown', onPointerDown))
onBeforeUnmount(() => document.removeEventListener('pointerdown', onPointerDown))

const deliverableCount = computed(() => props.entry.meta.deliverables?.length || 0)

const dueInfo = computed(() => {
  const raw = props.entry.meta.dueDate
  if (!raw) return null
  const d = new Date(raw + 'T00:00:00')
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const diff = Math.floor((d - today) / 86400000)

  const fmt = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  if (diff < 0) return { label: fmt, cls: 'text-accent font-medium' }
  if (diff === 0) return { label: 'Today', cls: 'text-accent font-medium' }
  if (diff === 1) return { label: 'Tomorrow', cls: 'text-ink-2' }
  if (diff <= 7) return { label: fmt, cls: 'text-ink-2' }
  return { label: fmt, cls: 'text-ink-3' }
})

const hasFooter = computed(() => deliverableCount.value > 0 || dueInfo.value || props.entry.meta.updated)

const shortDate = computed(() => {
  if (!props.entry.meta.updated) return ''
  return new Date(props.entry.meta.updated).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
})
</script>
