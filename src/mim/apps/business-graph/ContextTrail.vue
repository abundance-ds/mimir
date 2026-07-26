<template>
  <nav
    v-if="items.length"
    data-graph-context-trail
    class="flex h-8 shrink-0 items-center gap-0 overflow-x-auto border-b border-rule-light bg-surface px-2"
    aria-label="Graph context trail"
  >
    <template v-for="(item, index) in items" :key="`${item.id}:${index}`">
      <IconChevronRight
        v-if="index"
        :size="11"
        :stroke-width="1.7"
        class="mx-0.5 shrink-0 text-ink-4"
      />
      <button
        type="button"
        :data-context-node="item.id"
        class="group flex h-6 max-w-44 shrink-0 items-center gap-1.5 px-1.5 text-[9px] text-ink-3 hover:bg-chrome-mid hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        :class="{ 'font-semibold text-ink': index === items.length - 1 }"
        :aria-current="index === items.length - 1 ? 'page' : undefined"
        @click="$emit('step', index)"
      >
        <component :is="iconFor(item.kind)" :size="11" :stroke-width="1.7" class="shrink-0" />
        <span class="truncate">{{ item.title || item.id }}</span>
      </button>
    </template>
    <button
      type="button"
      data-context-close
      class="ml-auto grid size-6 shrink-0 place-items-center text-ink-4 hover:bg-chrome-mid hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      title="Close context"
      aria-label="Close context"
      @click="$emit('close')"
    >
      <IconX :size="12" />
    </button>
  </nav>
</template>

<script setup>
import {
  IconBriefcase2,
  IconBuilding,
  IconChevronRight,
  IconCircleCheck,
  IconFileText,
  IconUser,
  IconX,
} from '@tabler/icons-vue'

defineProps({
  items: { type: Array, default: () => [] },
})

defineEmits(['step', 'close'])

const icons = {
  issue: IconCircleCheck,
  project: IconBriefcase2,
  person: IconUser,
  company: IconBuilding,
  default: IconFileText,
}

function iconFor(kind) {
  return icons[kind] || icons.default
}
</script>
