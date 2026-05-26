<template>
  <div class="flex flex-col flex-1 min-h-0">
    <div class="h-[26px] shrink-0 border-b border-rule-light flex items-center gap-2.5 px-3 whitespace-nowrap overflow-hidden">
      <span :class="activeFilter === 'in-doc' ? 'chip-active' : 'chip-default'" @click="activeFilter = 'in-doc'">In document <span class="font-bold ml-0.5">{{ inDocCount }}</span></span>
      <span :class="activeFilter === 'all' ? 'chip-active' : 'chip-default'" @click="activeFilter = 'all'">All</span>
      <div class="flex-1"></div>
      <button class="text-accent text-[10.5px] font-sans font-medium hover:bg-chrome-mid hover:rounded" @click="showImport = !showImport">+ import</button>
    </div>

    <!-- Search -->
    <div class="px-3 py-2 border-b border-rule-light">
      <input
        v-model="searchQuery"
        type="text"
        placeholder="Search references..."
        class="w-full bg-surface border border-rule-light rounded-[3px] px-2.5 py-1 text-[10.5px] font-sans text-ink outline-none focus:border-accent"
        autocorrect="off"
        autocapitalize="off"
      />
    </div>

    <!-- Import panel -->
    <div v-if="showImport" class="border-b border-rule-light px-3 py-2.5 bg-chrome">
      <textarea
        v-model="bibtexInput"
        placeholder="Paste BibTeX entries here..."
        class="w-full h-24 bg-surface border border-rule-light rounded px-2.5 py-1.5 text-[10.5px] font-mono text-ink resize-none outline-none focus:border-accent"
        autocorrect="off"
        autocapitalize="off"
      ></textarea>
      <div class="flex items-center gap-2 mt-1.5">
        <button
          class="text-accent text-[10.5px] font-sans font-medium hover:bg-chrome-mid hover:rounded"
          @click="importBibtex"
        >Import</button>
        <button
          class="text-ink-3 text-[10.5px] font-sans hover:text-ink hover:bg-chrome-mid rounded"
          @click="showImport = false; bibtexInput = ''; importFeedback = ''"
        >Cancel</button>
        <span v-if="importFeedback" class="text-[10px] font-sans text-ink-3 ml-auto">{{ importFeedback }}</span>
      </div>
    </div>

    <!-- Reference list -->
    <div class="flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin">
      <div
        v-for="r in filteredRefs"
        :key="r.key"
        class="px-3 py-2.5 border-b border-rule-light overflow-hidden hover:bg-surface"
        @click="copyKey(r.key)"
      >
        <div class="font-mono text-[9.5px] font-semibold mb-px" :class="copiedKey === r.key ? 'text-ink-3' : 'text-accent'">{{ copiedKey === r.key ? `Copied [@${r.key}]` : r.key }}</div>
        <div class="font-sans text-[11px] text-ink font-medium leading-snug overflow-hidden text-ellipsis whitespace-nowrap">{{ r.title }}</div>
        <div class="font-mono text-[10px] text-ink-3 mt-0.5 overflow-hidden text-ellipsis whitespace-nowrap">{{ r.authors }} · {{ r.year }}</div>
      </div>
      <div v-if="filteredRefs.length === 0" class="px-3 py-4 text-[10.5px] font-sans text-ink-3 text-center">
        No references found.
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { extractCitedKeys, searchReferences, addReference } from '../../../services/references.js'
import { parseBibtex } from '../../../services/bibtexParser.js'
import { useFileStore } from '../../../stores/files.js'

const fileStore = useFileStore()

const props = defineProps({
  references: { type: Array, default: () => [] },
})
const emit = defineEmits(['reload-refs'])

const currentContent = computed(() => fileStore.currentFile?.content ?? '')

const activeFilter = ref('in-doc')
const searchQuery = ref('')
const showImport = ref(false)
const bibtexInput = ref('')
const importFeedback = ref('')
const copiedKey = ref(null)
let copiedTimer = null

const citedKeys = computed(() => {
  return new Set(extractCitedKeys(currentContent.value))
})

const inDocCount = computed(() => {
  return props.references.filter(r => citedKeys.value.has(r._key || r.key)).length
})

// Map CSL-JSON entries to display format
const displayRefs = computed(() => {
  return props.references.map(r => ({
    key: r._key || r.key,
    title: r.title || '',
    authors: (r.author || []).map(a => `${a.given || ''} ${a.family || ''}`).join(', ') || 'Unknown author',
    year: r.issued?.['date-parts']?.[0]?.[0]?.toString() || 'n.d.',
    _raw: r,
  }))
})

const filteredRefs = computed(() => {
  let refs = displayRefs.value

  if (activeFilter.value === 'in-doc') {
    refs = refs.filter(r => citedKeys.value.has(r.key))
  }

  if (searchQuery.value.trim()) {
    const q = searchQuery.value.toLowerCase().trim()
    refs = refs.filter(r =>
      r.key.toLowerCase().includes(q) ||
      r.title.toLowerCase().includes(q) ||
      r.authors.toLowerCase().includes(q)
    )
  }

  return refs
})

async function importBibtex() {
  if (!bibtexInput.value.trim()) return
  const entries = parseBibtex(bibtexInput.value)
  if (entries.length === 0) {
    importFeedback.value = 'No valid entries found.'
    return
  }
  let count = 0
  for (const entry of entries) {
    await addReference(entry)
    count++
  }
  importFeedback.value = `Imported ${count} ${count === 1 ? 'entry' : 'entries'}.`
  bibtexInput.value = ''
  emit('reload-refs')
}

function copyKey(key) {
  navigator.clipboard.writeText(`[@${key}]`).catch(() => {})
  copiedKey.value = key
  clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => { copiedKey.value = null }, 1500)
}
</script>

<style scoped>
.chip-active {
  padding: 0; border: none; background: none;
  color: var(--color-ink); font-family: var(--font-sans); font-size: 10px; font-weight: 600;
  text-decoration: underline; text-decoration-color: var(--color-accent);
  text-decoration-thickness: 1.5px; text-underline-offset: 3px;
}
.chip-default {
  padding: 0; border: none; background: none;
  color: var(--color-ink-3); font-family: var(--font-sans); font-size: 10px;
}
.chip-default:hover { color: var(--color-ink-2); background: var(--color-chrome-mid); }
</style>
