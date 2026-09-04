<template>
  <section
    data-file-history-panel
    class="absolute inset-0 z-[250] flex min-h-0 flex-col bg-surface"
    :aria-label="`History for ${name}`"
    :aria-busy="loading"
    @keydown.esc.prevent.stop="$emit('close')"
  >
    <header data-file-history-toolbar class="pane-bar gap-2">
      <button
        ref="backButton"
        type="button"
        data-file-history-back
        aria-label="Back to files"
        class="grid size-7 shrink-0 place-items-center text-ink-3 outline-none hover:bg-chrome hover:text-ink focus-visible:ring-1 focus-visible:ring-accent"
        @click="$emit('close')"
      >
        <IconArrowLeft :size="14" :stroke-width="1.8" />
      </button>
      <div class="min-w-0">
        <strong class="block truncate text-[11px] font-semibold text-ink">{{ name }}</strong>
        <span class="block font-mono text-[9px] text-ink-4">History</span>
      </div>
    </header>

    <div class="scrollbar-thin min-h-0 flex-1 overflow-auto">
      <div v-if="loading" data-file-history-loading class="grid h-40 place-items-center px-8 text-center">
        <p class="font-mono text-[9px] uppercase tracking-[0.12em] text-ink-3">Loading History</p>
      </div>
      <div v-else-if="error" data-file-history-error role="alert" class="px-4 py-5 text-[10px] leading-relaxed text-rem">
        {{ error }}
      </div>
      <div v-else-if="!entries.length" data-file-history-empty class="grid h-40 place-items-center px-8 text-center">
        <div>
          <IconHistory :size="20" :stroke-width="1.5" class="mx-auto text-ink-3" />
          <p class="mt-3 text-[11px] font-semibold text-ink">No saved versions yet</p>
          <p class="mt-1 text-[10px] text-ink-3">History starts after this file is committed.</p>
        </div>
      </div>
      <template v-else>
        <button
          v-for="entry in entries"
          :key="entry.hash"
          type="button"
          :data-file-history-version="entry.hash"
          :disabled="entry.binary"
          class="flex w-full items-start gap-3 border-b border-rule-light px-3 py-2.5 text-left outline-none hover:bg-chrome-high focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-45"
          @click="openVersion(entry)"
        >
          <IconHistory :size="13" :stroke-width="1.7" class="mt-0.5 shrink-0 text-ink-4" />
          <span class="min-w-0 flex-1">
            <strong class="block truncate text-[11px] font-medium text-ink">{{ entry.message || 'Saved version' }}</strong>
            <small class="mt-0.5 block truncate font-mono text-[9px] text-ink-4">
              {{ entry.shortHash }} · {{ readableDateTime(entry.authoredAt) }}
              <template v-if="entry.author"> · {{ entry.author }}</template>
            </small>
          </span>
          <span v-if="entry.binary" class="shrink-0 font-mono text-[9px] text-ink-4">No text diff</span>
        </button>
      </template>
    </div>
  </section>
</template>

<script setup>
import { nextTick, onMounted, ref, watch } from 'vue'
import { IconArrowLeft, IconHistory } from '@tabler/icons-vue'
import { invoke } from '@tauri-apps/api/core'

const props = defineProps({
  path: { type: String, required: true },
  name: { type: String, required: true },
})

const emit = defineEmits(['close', 'open'])
const backButton = ref(null)
const entries = ref([])
const loading = ref(false)
const error = ref('')

watch(() => props.path, loadHistory)

onMounted(async () => {
  await nextTick()
  backButton.value?.focus()
  void loadHistory()
})

async function loadHistory() {
  const path = String(props.path || '').trim()
  if (!path) return
  loading.value = true
  error.value = ''
  entries.value = []
  try {
    const result = await invoke('git_file_history', { path, limit: 50 })
    entries.value = Array.isArray(result) ? result : []
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loading.value = false
  }
}

function openVersion(entry) {
  if (!entry?.hash || entry.binary) return
  emit('open', {
    path: props.path,
    preview: false,
    history: {
      hash: entry.hash,
      shortHash: entry.shortHash,
      label: entry.message,
      timestamp: entry.authoredAt,
    },
  })
}

function readableDateTime(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value || '')
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}
</script>
