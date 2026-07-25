<template>
  <div class="flex h-full min-h-0 flex-col bg-chrome-high text-ink">
    <div class="flex h-10 shrink-0 items-center gap-1 border-b border-rule bg-chrome-high px-2">
      <IconSearch :size="14" :stroke-width="1.8" class="ml-1 shrink-0 text-ink-3" />
      <input
        ref="queryInput"
        v-model="query"
        type="search"
        :placeholder="contentMode ? 'Search file contents…' : 'Filter paths…'"
        class="h-8 min-w-0 flex-1 bg-transparent px-1 font-mono text-[11px] text-ink outline-none placeholder:text-ink-4"
        @input="onQueryInput"
        @keydown.down.prevent="move(1)"
        @keydown.up.prevent="move(-1)"
        @keydown.enter.prevent="openSelected"
      />
      <button
        type="button"
        data-search-mode="paths"
        title="Filter paths"
        class="h-7 px-2 font-mono text-[9px] uppercase tracking-[0.08em] text-ink-3 hover:bg-chrome hover:text-ink"
        :class="{ 'bg-chrome text-ink': !contentMode }"
        @click="setContentMode(false)"
      >
        Paths
      </button>
      <button
        type="button"
        data-search-mode="content"
        title="Search contents"
        class="h-7 px-2 font-mono text-[9px] uppercase tracking-[0.08em] text-ink-3 hover:bg-chrome hover:text-ink"
        :class="{ 'bg-chrome text-ink': contentMode }"
        @click="setContentMode(true)"
      >
        Content
      </button>
    </div>

    <div
      v-if="files.workspacePath"
      data-files-list
      tabindex="0"
      class="min-h-0 flex-1 overflow-y-auto outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
      @keydown.down.prevent="move(1)"
      @keydown.up.prevent="move(-1)"
      @keydown.enter.prevent="openSelected"
    >
      <template v-if="!contentMode">
        <button
          v-for="(file, index) in files.visibleFiles"
          :key="file.path"
          type="button"
          :data-file-row="file.path"
          class="group grid h-10 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-rule-light px-3 text-left hover:bg-chrome-mid"
          :class="{ 'bg-accent-soft': index === files.selectionIndex }"
          @mouseenter="files.selectionIndex = index"
          @click="files.selectionIndex = index"
          @dblclick="$emit('openFile', file.path)"
        >
          <span class="min-w-0">
            <span class="block truncate text-[11px] font-medium">{{ file.name }}</span>
            <span class="block truncate font-mono text-[9px] text-ink-3">{{ directory(file.relativePath) }}</span>
          </span>
          <span class="flex items-center gap-3 font-mono text-[9px] tabular-nums text-ink-3">
            <span>{{ byteSize(file.size) }}</span>
            <span class="w-14 text-right">{{ relativeTime(file.mtime) }}</span>
          </span>
        </button>

        <div v-if="!files.visibleFiles.length && !files.loading" class="grid h-40 place-items-center text-[11px] text-ink-3">
          {{ query ? 'No matching paths.' : 'No reviewable files in this workspace.' }}
        </div>
      </template>

      <template v-else>
        <button
          v-for="match in files.contentMatches"
          :key="`${match.path}:${match.line}:${match.column}`"
          type="button"
          data-content-match
          class="block w-full border-b border-rule-light px-3 py-2 text-left hover:bg-chrome-mid"
          @click="$emit('openFile', match.path)"
        >
          <span class="block font-mono text-[9px] text-accent">
            {{ match.relativePath }}:{{ match.line }}:{{ match.column }}
          </span>
          <span class="mt-1 block truncate font-mono text-[10px] text-ink-2">{{ match.excerpt }}</span>
        </button>
        <div v-if="files.contentSearching" class="px-3 py-3 font-mono text-[9px] uppercase tracking-[0.1em] text-ink-3">
          Searching…
        </div>
        <div v-else-if="query && !files.contentMatches.length" class="grid h-40 place-items-center text-[11px] text-ink-3">
          No content matches.
        </div>
        <div v-if="files.contentTruncated" class="border-t border-rule px-3 py-2 text-[10px] text-ink-3">
          Results reached the bounded search limit. Narrow the query to continue.
        </div>
      </template>
    </div>

    <div v-else class="grid min-h-0 flex-1 place-items-center px-8 text-center">
      <div>
        <IconFolderOpen :size="22" :stroke-width="1.5" class="mx-auto text-ink-3" />
        <p class="mt-3 text-[12px] font-semibold">Open a workspace</p>
        <p class="mt-1 text-[10px] leading-relaxed text-ink-3">Files become a recent-first review inbox.</p>
        <button
          type="button"
          data-files-choose-workspace
          class="mt-4 h-8 border border-rule px-3 text-[10px] font-semibold hover:bg-chrome"
          @click="$emit('chooseWorkspace')"
        >
          Choose folder
        </button>
      </div>
    </div>

    <div v-if="files.error" class="shrink-0 border-t border-rem/30 bg-rem/5 px-3 py-2 text-[10px] text-rem">
      {{ files.error }}
    </div>
  </div>
</template>

<script setup>
import { onUnmounted, ref } from 'vue'
import { IconFolderOpen, IconSearch } from '@tabler/icons-vue'
import { useWorkspaceFilesStore } from '../../stores/workspaceFiles.js'

const files = useWorkspaceFilesStore()
const queryInput = ref(null)
const query = ref('')
const contentMode = ref(false)
let queryTimer = null

function setContentMode(value) {
  contentMode.value = value
  onQueryInput()
  queryInput.value?.focus()
}

function onQueryInput() {
  clearTimeout(queryTimer)
  queryTimer = setTimeout(() => {
    if (contentMode.value) files.searchContent(query.value)
    else files.setQuery(query.value)
  }, contentMode.value ? 180 : 40)
}

function move(delta) {
  if (contentMode.value) return
  files.moveSelection(delta)
}

function openSelected() {
  if (contentMode.value) {
    const match = files.contentMatches[0]
    if (match) emit('openFile', match.path)
    return
  }
  if (files.selectedFile) emit('openFile', files.selectedFile.path)
}

const emit = defineEmits(['openFile', 'chooseWorkspace'])

function directory(path) {
  const index = String(path).lastIndexOf('/')
  return index < 0 ? 'workspace' : path.slice(0, index)
}

function byteSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function relativeTime(timestamp) {
  const delta = Math.max(0, Date.now() - Number(timestamp || 0))
  if (delta < 60_000) return 'now'
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`
  return `${Math.floor(delta / 86_400_000)}d`
}

onUnmounted(() => clearTimeout(queryTimer))
</script>
