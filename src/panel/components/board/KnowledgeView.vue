<template>
  <div class="flex flex-col flex-1 min-h-0">
    <div class="flex items-center gap-2 px-4 pt-3 pb-1">
      <button
        class="inline-flex items-center gap-1 h-[30px] px-2.5 rounded-md font-sans text-[11px] text-ink-3 hover:bg-chrome-mid hover:text-ink-2 shrink-0"
        @click="addEntry"
      >
        <IconPlus :size="12" />
        New entry
      </button>
      <div class="kv-search max-w-[320px] ml-auto">
        <IconSearch :size="12" class="text-ink-3 shrink-0" />
        <input
          v-model="boardStore.noteSearch"
          type="search"
          placeholder="Search knowledge base..."
          class="flex-1 min-w-0 bg-transparent font-sans text-[11px] text-ink outline-none placeholder:text-ink-3"
          autocorrect="off"
          autocapitalize="off"
        />
      </div>
    </div>

    <div class="flex-1 overflow-y-auto p-4">
      <div v-if="boardStore.filteredKnowledge.length === 0" class="flex items-center justify-center h-full">
        <div class="text-center py-8">
          <div class="flex justify-center mb-3">
            <IconBook :size="24" class="text-ink-3" />
          </div>
          <p class="font-sans text-[12px] text-ink-3">
            {{ boardStore.noteSearch ? 'No matching entries' : 'No knowledge entries yet' }}
          </p>
          <p class="font-mono text-[10px] text-ink-3 mt-2 max-w-[240px] mx-auto leading-relaxed">
            {{ boardStore.noteSearch
              ? 'Try different search terms.'
              : 'Knowledge entries are created by the AI during conversations.' }}
          </p>
        </div>
      </div>
      <div v-else class="grid gap-3" style="grid-template-columns: repeat(auto-fill, minmax(220px, 1fr))">
        <KnowledgeCard
          v-for="entry in boardStore.filteredKnowledge"
          :key="entry.id"
          :entry="entry"
          @click="boardStore.selectEntry(entry.id)"
        />
      </div>
    </div>
  </div>
</template>

<script setup>
import { IconSearch, IconBook, IconPlus } from '@tabler/icons-vue'
import { useBoardStore } from '../../../stores/panel/board.js'
import KnowledgeCard from './KnowledgeCard.vue'

const boardStore = useBoardStore()

async function addEntry() {
  const id = await boardStore.createEntry('knowledge', { title: '' })
  if (id) boardStore.selectEntry(id)
}
</script>

<style scoped>
.kv-search {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 10px;
  border-radius: 6px;
  background: var(--color-chrome-mid);
  border: 1px solid var(--color-rule-light);
}
.kv-search:focus-within {
  border-color: var(--color-accent);
}
</style>
