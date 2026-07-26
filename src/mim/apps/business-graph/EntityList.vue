<template>
  <div
    data-graph-entity-list
    class="min-h-0 flex-1 overflow-y-auto outline-none"
    tabindex="0"
    role="listbox"
    aria-label="Graph items"
    :aria-activedescendant="nodes[selection] ? `graph-list-option-${nodes[selection].id}` : undefined"
    @keydown.down.prevent="move(1)"
    @keydown.up.prevent="move(-1)"
    @keydown.enter.prevent="openSelected"
  >
    <button
      v-for="(node, index) in nodes"
      :key="node.id"
      type="button"
      :data-graph-node="node.id"
      :id="`graph-list-option-${node.id}`"
      role="option"
      :aria-selected="index === selection"
      class="group grid min-h-[54px] w-full grid-cols-[28px_minmax(0,1fr)_auto] items-start gap-2 border-b border-rule-light px-3 py-2 text-left hover:bg-chrome-mid focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
      :class="{ 'bg-accent-soft': index === selection }"
      @mouseenter="selection = index"
      @click="$emit('open', node.id)"
    >
      <span class="mt-0.5 grid size-6 place-items-center border border-rule-light bg-surface text-ink-3">
        <component :is="iconFor(node.kind)" :size="12" :stroke-width="1.7" />
      </span>
      <span class="min-w-0">
        <span class="flex min-w-0 items-center gap-2">
          <span class="truncate text-[11px] font-semibold text-ink-2">{{ node.title || node.id }}</span>
          <span
            v-if="node.status"
            class="shrink-0 border border-rule-light px-1 py-px font-mono text-[7px] uppercase tracking-[0.08em] text-ink-3"
          >
            {{ human(node.status) }}
          </span>
        </span>
        <span v-if="node.summary" class="mt-0.5 line-clamp-1 text-[9px] leading-relaxed text-ink-3">
          {{ node.summary }}
        </span>
        <span v-else class="mt-0.5 block truncate font-mono text-[8px] text-ink-4">
          {{ node.id }}
        </span>
        <span v-if="node.tags?.length" class="mt-1 flex flex-wrap gap-1">
          <span
            v-for="tag in node.tags.slice(0, 4)"
            :key="tag"
            class="bg-chrome px-1 py-px font-mono text-[7px] text-ink-3"
          >{{ tag }}</span>
        </span>
      </span>
      <span class="mt-1 flex items-center gap-1 font-mono text-[7px] uppercase tracking-[0.08em] text-ink-4">
        <span class="size-1.5 rounded-full" :class="scopeClass(node.scopeId)" />
        {{ scopeLabel(node.scopeId) }}
        <IconChevronRight :size="11" class="opacity-0 transition-opacity group-hover:opacity-100" />
      </span>
    </button>

    <div v-if="!nodes.length" class="grid min-h-56 place-items-center px-8 text-center">
      <div>
        <IconDatabaseOff :size="21" :stroke-width="1.4" class="mx-auto text-ink-4" />
        <p class="mt-3 text-[11px] font-semibold text-ink-2">{{ emptyTitle }}</p>
        <p class="mt-1 text-[9px] leading-relaxed text-ink-3">{{ emptyCopy }}</p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue'
import {
  IconBriefcase2,
  IconBuilding,
  IconChevronRight,
  IconCircleCheck,
  IconDatabaseOff,
  IconFileText,
  IconScale,
  IconUser,
} from '@tabler/icons-vue'

const props = defineProps({
  nodes: { type: Array, default: () => [] },
  scopes: { type: Array, default: () => [] },
  emptyTitle: { type: String, default: 'Nothing here yet' },
  emptyCopy: { type: String, default: 'Create an item or choose another scope.' },
})

const emit = defineEmits(['open'])
const selection = ref(0)

watch(() => props.nodes.length, length => {
  selection.value = Math.min(selection.value, Math.max(0, length - 1))
})

const icons = {
  issue: IconCircleCheck,
  project: IconBriefcase2,
  person: IconUser,
  company: IconBuilding,
  decision: IconScale,
  default: IconFileText,
}

function iconFor(kind) {
  return icons[kind] || icons.default
}

function move(delta) {
  if (!props.nodes.length) return
  selection.value = (selection.value + delta + props.nodes.length) % props.nodes.length
}

function openSelected() {
  const node = props.nodes[selection.value]
  if (node) emit('open', node.id)
}

function scopeLabel(id) {
  return props.scopes.find(scope => scope.id === id)?.kind || 'source'
}

function scopeClass(id) {
  return {
    private: 'bg-ink-3',
    project: 'bg-accent',
    team: 'bg-add',
  }[scopeLabel(id)] || 'bg-ink-4'
}

function human(value) {
  return String(value || '').replaceAll('-', ' ')
}
</script>
