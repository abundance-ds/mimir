<template>
  <div class="flex items-center justify-center py-2.5">
    <div class="bh-pill">
      <button
        v-for="mode in modes"
        :key="mode.value"
        class="bh-segment"
        :class="boardStore.viewMode === mode.value && 'is-active'"
        @click="switchMode(mode.value)"
      >
        {{ mode.label }}
      </button>
    </div>
  </div>
</template>

<script setup>
import { useBoardStore } from '../../../stores/panel/board.js'
import { usePanelUIStore } from '../../../stores/panel/ui.js'

const boardStore = useBoardStore()
const panelUI = usePanelUIStore()

const modes = [
  { value: 'chat', label: 'Chat' },
  { value: 'board', label: 'Board' },
  { value: 'knowledge', label: 'Knowledge' },
  { value: 'history', label: 'History' },
  { value: 'settings', label: 'Settings' },
]

function switchMode(mode) {
  boardStore.clearSelection()
  boardStore.viewMode = mode
  panelUI.pushProjectNav(mode, null)
}
</script>

<style scoped>
.bh-pill {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  height: 30px;
  padding: 3px;
  border-radius: 100px;
  background: var(--color-chrome-mid);
  border: 1px solid var(--color-rule-light);
}

.bh-segment {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 22px;
  padding: 0 11px;
  border-radius: 100px;
  background: transparent;
  color: var(--color-ink-3);
  font-family: var(--font-sans);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.01em;
  transition: color 150ms ease, background 150ms ease, box-shadow 150ms ease;
}

.bh-segment:hover:not(.is-active) {
  color: var(--color-ink-2);
}

.bh-segment.is-active {
  background: var(--color-surface);
  color: var(--color-ink);
  font-weight: 600;
  box-shadow:
    0 0 0 1px var(--color-rule-light),
    0 1px 2px rgba(0, 0, 0, 0.06);
}
</style>
