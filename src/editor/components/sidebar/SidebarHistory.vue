<template>
  <div class="flex flex-col flex-1 min-h-0">
    <!-- Empty state -->
    <div v-if="!entries.length && status !== 'loading'" class="flex-1 flex flex-col items-center justify-center px-6 py-12 text-center">
      <span class="text-[11px] font-sans text-ink-3">No earlier versions</span>
    </div>

    <!-- Timeline -->
    <div v-else-if="entries.length" class="flex-1 overflow-y-auto">
      <!-- Current version anchor -->
      <button class="current-marker" @click="showCurrent">
        <span class="marker-dot"></span>
        <span class="marker-label">Current</span>
        <span v-if="isDirty" class="marker-dirty">Unsaved changes</span>
      </button>

      <button
        v-for="entry in entries"
        :key="entry.hash"
        class="history-entry"
        @click="openDiff(entry)"
      >
        <span class="entry-time">{{ relativeTime(entry.timestamp) }}</span>
        <span class="entry-message">{{ entry.message || 'Untitled change' }}</span>
        <span class="entry-meta">
          {{ entry.author }}<template v-if="entry.insertions || entry.deletions">
            &nbsp;&middot;&nbsp;<span class="entry-add">+{{ entry.insertions }}</span>&nbsp;<span class="entry-rem">&minus;{{ entry.deletions }}</span>
          </template>
        </span>
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { useFileStore } from '../../../stores/files.js'
import { useEditorUIStore } from '../../../stores/editorUI.js'
import { useDiffStore } from '../../../stores/diff.js'
import { relativeTime } from '../../../services/audit.js'

const fileStore = useFileStore()
const ui = useEditorUIStore()
const diff = useDiffStore()

const entries = ref([])
const status = ref('idle')

const filePath = computed(() => fileStore.currentFile?.path)
const isDirty = computed(() => fileStore.currentFile?.dirty ?? false)
const isVisible = computed(() => ui.activePanel === 'history' && ui.panelOpen)

async function probeGit() {
  const path = filePath.value
  if (!path) {
    ui.historyAvailable = false
    status.value = 'no_file'
    entries.value = []
    return
  }

  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const result = await invoke('git_file_log', { filePath: path, limit: 1 })
    ui.historyAvailable = true
    if (isVisible.value) {
      await fetchFullLog(path)
    } else {
      entries.value = result
      status.value = 'loaded'
    }
  } catch {
    ui.historyAvailable = false
    status.value = 'no_git'
    entries.value = []
  }
}

async function fetchFullLog(path) {
  status.value = 'loading'
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const result = await invoke('git_file_log', { filePath: path })
    entries.value = result
    status.value = 'loaded'
  } catch {
    status.value = 'no_git'
    entries.value = []
  }
}

watch(filePath, () => probeGit(), { immediate: true })

watch(isVisible, (visible) => {
  if (visible && ui.historyAvailable && entries.value.length <= 1) {
    fetchFullLog(filePath.value)
  }
})

function showCurrent() {
  if (diff.active) diff.deactivate()
}

async function openDiff(entry) {
  const path = filePath.value
  const current = fileStore.currentFile?.content
  if (!path || current == null) return

  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const historical = await invoke('git_file_at_revision', {
      filePath: path,
      revision: entry.hash,
    })

    diff.activate({
      original: historical,
      modified: current,
      path,
      review: {
        type: 'history',
        label: entry.message,
        hash: entry.short_hash,
        timestamp: entry.timestamp,
      },
    })
  } catch (e) {
    console.warn('[history] Failed to load revision:', e)
  }
}
</script>

<style scoped>
.current-marker {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  text-align: left;
  padding: 8px 12px;
  border: none;
  background: none;
  border-bottom: 1px solid var(--color-rule-light);
}
.current-marker:hover {
  background: var(--color-chrome-mid);
}
.marker-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-accent);
  flex-shrink: 0;
}
.marker-label {
  font-family: var(--font-sans);
  font-size: 11px;
  font-weight: 600;
  color: var(--color-ink-2);
}
.marker-dirty {
  font-family: var(--font-sans);
  font-size: 9.5px;
  color: var(--color-ink-3);
}

.history-entry {
  display: flex;
  flex-direction: column;
  gap: 1px;
  width: 100%;
  text-align: left;
  padding: 8px 12px;
  border: none;
  background: none;
  border-bottom: 1px solid var(--color-rule-light);
}
.history-entry:hover {
  background: var(--color-chrome-mid);
}

.entry-time {
  font-family: var(--font-sans);
  font-size: 9.5px;
  color: var(--color-ink-3);
}
.entry-message {
  font-family: var(--font-sans);
  font-size: 11px;
  font-weight: 500;
  color: var(--color-ink-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.entry-meta {
  font-family: var(--font-sans);
  font-size: 9.5px;
  color: var(--color-ink-3);
}
.entry-add {
  color: var(--color-add);
}
.entry-rem {
  color: var(--color-rem);
}
</style>
