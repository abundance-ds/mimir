<template>
  <section data-tracker-log class="border-t border-rule bg-surface">
    <header class="flex h-7 items-center gap-2 border-b border-rule-light px-3">
      <h2 class="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-ink-2">Activity evidence</h2>
      <span class="font-mono text-[9px] tabular-nums text-ink-4">{{ page.total.toLocaleString() }} rows</span>
      <label class="ml-auto flex h-6 min-w-[150px] max-w-[260px] flex-1 items-center border border-rule bg-surface px-2 focus-within:border-accent">
        <IconSearch :size="11" class="shrink-0 text-ink-4" />
        <input
          :value="search"
          data-tracker-log-search
          type="search"
          placeholder="App, title, category"
          class="min-w-0 flex-1 border-0 bg-transparent px-1.5 text-[9px] text-ink outline-none placeholder:text-ink-4"
          autocorrect="off"
          autocapitalize="off"
          spellcheck="false"
          @input="$emit('search', $event.target.value)"
        >
      </label>
    </header>

    <div class="overflow-x-auto">
      <table class="w-full min-w-[650px] table-fixed text-left">
        <thead class="bg-chrome-high">
          <tr class="border-b border-rule-light font-mono text-[9px] uppercase tracking-[0.1em] text-ink-4">
            <th class="w-[124px] px-3 py-2 font-medium">Start</th>
            <th class="w-[72px] px-2 py-2 font-medium">Length</th>
            <th class="w-[94px] px-2 py-2 font-medium">Kind</th>
            <th class="w-[150px] px-2 py-2 font-medium">Application</th>
            <th class="px-2 py-2 font-medium">Evidence</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="block in page.blocks"
            :key="block.id"
            :data-tracker-block="block.id"
            tabindex="0"
            class="cursor-default border-b border-rule-light text-[10px] text-ink-2 hover:bg-chrome-mid focus:bg-accent-soft focus:outline-none"
            @click="$emit('select', block)"
            @keydown.enter.prevent="$emit('select', block)"
          >
            <td class="px-3 py-2 font-mono tabular-nums text-ink-3">{{ startLabel(block.startMs) }}</td>
            <td class="px-2 py-2 font-mono tabular-nums">{{ duration(block.durationSeconds) }}</td>
            <td class="px-2 py-2">
              <span class="inline-flex items-center gap-1.5">
                <span class="size-1.5 border border-rule" :class="`block-mark-${slug(block.activity)}`" />
                {{ block.activity }}
              </span>
            </td>
            <td class="truncate px-2 py-2" :title="block.appName || block.offReason || ''">
              {{ block.appName || systemLabel(block) }}
            </td>
            <td class="truncate px-2 py-2 text-ink-3" :title="evidence(block)">
              {{ evidence(block) || '—' }}
            </td>
          </tr>
          <tr v-if="!page.blocks.length">
            <td colspan="5" class="px-3 py-10 text-center text-[9px] text-ink-4">
              No activity matches this range and filter.
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <footer class="flex h-9 items-center border-t border-rule-light px-3">
      <span class="font-mono text-[9px] text-ink-4">
        {{ page.total ? page.offset + 1 : 0 }}–{{ Math.min(page.total, page.offset + page.blocks.length) }} of {{ page.total }}
      </span>
      <div class="ml-auto flex items-center">
        <button
          type="button"
          :disabled="page.offset === 0"
          class="h-6 border border-rule px-2 text-[9px] font-semibold text-ink-3 hover:bg-chrome-mid disabled:opacity-35"
          @click="$emit('page', Math.max(0, page.offset - page.limit))"
        >
          Previous
        </button>
        <button
          type="button"
          :disabled="page.offset + page.blocks.length >= page.total"
          class="-ml-px h-6 border border-rule px-2 text-[9px] font-semibold text-ink-3 hover:bg-chrome-mid disabled:opacity-35"
          @click="$emit('page', page.offset + page.limit)"
        >
          Next
        </button>
      </div>
    </footer>
  </section>
</template>

<script setup>
import { IconSearch } from '@tabler/icons-vue'

defineProps({
  page: {
    type: Object,
    default: () => ({ blocks: [], total: 0, offset: 0, limit: 100 }),
  },
  search: { type: String, default: '' },
})

defineEmits(['select', 'search', 'page'])

function startLabel(value) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function duration(seconds) {
  const minutes = Math.max(0, Math.round(Number(seconds || 0) / 60))
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function evidence(block) {
  return [block.domain, block.subcategory, block.windowTitle].filter(Boolean).join(' · ')
}

function systemLabel(block) {
  if (block.activity === 'AFK') return 'Away'
  if (block.activity === 'OFF') return block.offReason || 'Mimir not collecting'
  if (block.activity === 'Break') return block.subcategory || 'Break'
  return 'Unknown application'
}

function slug(value) {
  return String(value || 'unknown').toLowerCase()
}
</script>

<style scoped>
.block-mark-work { background: var(--color-accent); }
.block-mark-leisure { background: var(--color-ink-2); }
.block-mark-other { background: var(--color-add); }
.block-mark-break { background: var(--color-accent-soft); border-color: var(--color-accent); }
.block-mark-afk { background: var(--color-rule); }
.block-mark-off { background: var(--color-chrome); }
.block-mark-unknown { background: var(--color-rem); }
button:focus-visible {
  outline: 1px solid var(--color-accent);
  outline-offset: -1px;
}
</style>
