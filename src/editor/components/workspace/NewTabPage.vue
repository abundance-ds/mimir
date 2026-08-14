<template>
  <div class="flex-1 flex flex-col items-center justify-start pt-[12vh] px-6 overflow-y-auto bg-surface">
    <div class="w-full max-w-[380px]">
      <div class="flex items-center gap-4 mb-5">
        <button
          class="flex items-center gap-1.5 text-[13px] font-sans text-ink-2 hover:text-ink transition-colors duration-75"
          @click="startBlankFile"
        >
          New File
          <kbd class="text-[10px] text-ink-3 bg-chrome-mid border border-rule-light rounded px-1 py-px">{{ modKey }}N</kbd>
        </button>
        <button
          class="flex items-center gap-1.5 text-[13px] font-sans text-ink-2 hover:text-ink transition-colors duration-75"
          @click="openFile"
        >
          Open File...
          <kbd class="text-[10px] text-ink-3 bg-chrome-mid border border-rule-light rounded px-1 py-px">{{ modKey }}O</kbd>
        </button>
      </div>

      <input
        ref="inputRef"
        v-model="query"
        type="text"
        placeholder="Search recent files..."
        autocorrect="off"
        autocapitalize="off"
        class="w-full h-10 px-3.5 bg-chrome-mid border border-rule-light rounded-lg text-[13px] text-ink font-sans placeholder:text-ink-3 outline-none focus:border-accent/40"
        @keydown.down.prevent="moveSelection(1)"
        @keydown.up.prevent="moveSelection(-1)"
        @keydown.enter.prevent="confirmSelection"
      />

      <div v-if="filtered.length" class="mt-3">
        <p class="px-1 pb-1.5 text-[10px] font-medium uppercase tracking-wide text-ink-3 font-sans">Recent</p>
        <div class="flex flex-col">
          <button
            v-for="(item, i) in filtered"
            :key="item.path"
            class="flex items-center gap-2 px-3 py-[7px] rounded-md text-left text-[13px] font-sans transition-colors duration-75"
            :class="selectedIndex === i ? 'bg-accent/8' : 'hover:bg-chrome-high'"
            @click="openRecent(item.path)"
            @mouseenter="selectedIndex = i"
          >
            <span class="truncate text-ink">{{ item.name }}</span>
            <span class="ml-auto shrink-0 truncate max-w-[160px] text-ink-3 text-[11px]">{{ item.dir }}</span>
          </button>
        </div>
      </div>

      <p
        v-else-if="query"
        class="mt-6 text-center text-ink-3 text-[12px] font-sans"
      >
        No matching files
      </p>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useFileStore } from '../../../stores/files.js'
import { readFile } from '../../../services/fileSystem.js'
import { platformKind } from '../../../shared/platform.js'
import { basename } from '../../../shared/utils/path.js'

const files = useFileStore()
const emit = defineEmits(['activated'])

const inputRef = ref(null)
const query = ref('')
const selectedIndex = ref(0)

const modKey = platformKind() === 'macos' ? '⌘' : 'Ctrl+'

function fileNameFromPath(path) {
  if (!path) return 'Untitled'
  return basename(path)
}

function dirFromPath(path) {
  if (!path) return ''
  const parts = path.split(/[/\\]/)
  if (parts.length <= 2) return '/'
  return parts.slice(-3, -1).join('/')
}

function fuzzyMatch(text, pattern) {
  if (!pattern) return true
  const lower = text.toLowerCase()
  const pat = pattern.toLowerCase()
  let pi = 0
  for (let i = 0; i < lower.length && pi < pat.length; i++) {
    if (lower[i] === pat[pi]) pi++
  }
  return pi === pat.length
}

const items = computed(() => {
  return files.visibleRecentFiles.map(p => ({
    path: p,
    name: fileNameFromPath(p),
    dir: dirFromPath(p),
  }))
})

const filtered = computed(() => {
  if (!query.value) return items.value
  return items.value.filter(t => fuzzyMatch(t.name + ' ' + t.path, query.value))
})

function moveSelection(delta) {
  const total = filtered.value.length
  if (!total) return
  selectedIndex.value = (selectedIndex.value + delta + total) % total
}

function confirmSelection() {
  const item = filtered.value[selectedIndex.value]
  if (item) openRecent(item.path)
}

async function openRecent(path) {
  try {
    const content = await readFile(path)
    await files.openFile(path, content)
    emit('activated')
  } catch {
    files.removeRecentFile(path)
  }
}

function startBlankFile() {
  const f = files.currentFile
  if (!f) return
  f.newTab = false
  emit('activated')
}

async function openFile() {
  await files.openDialog()
  if (!files.currentFile?.newTab) emit('activated')
}

watch(query, () => {
  selectedIndex.value = 0
})

onMounted(() => {
  inputRef.value?.focus()
})
</script>
