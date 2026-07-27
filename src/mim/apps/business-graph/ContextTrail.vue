<template>
  <nav
    v-if="items.length"
    data-graph-context-trail
    class="context-trail"
    aria-label="Graph context trail"
  >
    <span class="context-mode">{{ focus ? 'Focus' : 'Peek' }}</span>
    <div class="context-path">
      <template v-for="(item, index) in items" :key="`${item.id}:${index}`">
        <IconChevronRight v-if="index" :size="12" aria-hidden="true" />
        <button
          type="button"
          :data-context-node="item.id"
          :data-graph-control="`context-${item.id}`"
          :class="{ 'context-current': index === items.length - 1 }"
          :aria-current="index === items.length - 1 ? 'page' : undefined"
          @click="$emit('step', index)"
        >
          <span>{{ item.title || item.id }}</span>
          <small>{{ human(item.kind) }}</small>
        </button>
      </template>
    </div>
    <button
      type="button"
      data-context-close
      data-graph-control="context-close"
      class="context-close"
      title="Close object"
      aria-label="Close object"
      @click="$emit('close')"
    >
      <IconX :size="14" />
    </button>
  </nav>
</template>

<script setup>
import { IconChevronRight, IconX } from '@tabler/icons-vue'

defineProps({
  items: { type: Array, default: () => [] },
  focus: { type: Boolean, default: false },
})

defineEmits(['step', 'close'])

function human(value) {
  return String(value || '').replaceAll('-', ' ')
}
</script>

<style scoped>
.context-trail {
  display: flex;
  min-height: 38px;
  flex: 0 0 auto;
  align-items: center;
  gap: 10px;
  overflow: hidden;
  border-bottom: 1px solid var(--color-rule-light);
  background: var(--color-surface);
  padding: 4px 10px 4px 13px;
}

.context-mode {
  flex: 0 0 auto;
  color: var(--color-accent);
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 650;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.context-path {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  align-items: center;
  gap: 3px;
  overflow-x: auto;
  color: var(--color-ink-4);
  scrollbar-width: none;
}

.context-path::-webkit-scrollbar {
  display: none;
}

.context-path button {
  display: flex;
  min-width: 0;
  max-width: 230px;
  height: 29px;
  flex: 0 0 auto;
  align-items: baseline;
  gap: 7px;
  border-radius: 4px;
  padding: 0 7px;
  color: var(--color-ink-3);
  font-size: 11px;
}

.context-path button:hover {
  background: var(--color-chrome-mid);
  color: var(--color-ink);
}

.context-path button:focus-visible,
.context-close:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--color-accent) 24%, transparent);
  outline-offset: 1px;
}

.context-path button span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.context-path button small {
  color: var(--color-ink-4);
  font-family: var(--font-mono);
  font-size: 9px;
}

.context-path .context-current {
  color: var(--color-ink);
  font-weight: 630;
}

.context-close {
  display: grid;
  width: 30px;
  height: 30px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 5px;
  color: var(--color-ink-4);
}

.context-close:hover {
  background: var(--color-chrome-mid);
  color: var(--color-ink);
}

@container business-graph (max-width: 520px) {
  .context-mode,
  .context-path button small {
    display: none;
  }
}
</style>
