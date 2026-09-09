<template>
  <div class="pane-tab no-drag" :class="{ selected }" :style="{ '--tab-ideal-width': `${Math.max(100, Math.min(188, String(label).length * 7 + 56))}px` }"><slot /></div>
</template>
<script setup>
defineProps({ selected: Boolean, label: { type: String, default: '' } })
</script>
<style>
.pane-tab {
  position: relative;
  flex: 1 1 var(--tab-ideal-width);
  min-width: 92px;
  max-width: 188px;
  height: 28px;
  color: var(--color-ink-2);
  font-family: var(--font-sans);
  font-size: 11.5px;
  font-weight: 400;
}

.pane-tab.selected {
  background: var(--color-chrome-high);
  color: var(--color-ink);
}

.pane-tab:not(.selected):hover {
  background: var(--color-chrome-mid);
}

.pane-tab::after {
  content: '';
  position: absolute;
  pointer-events: none;
  right: 0;
  top: 20%;
  height: 60%;
  width: 1px;
  background: var(--color-rule-light);
}

.pane-tab.selected::after, .pane-tab:hover::after, .pane-tab:has(+ .selected)::after, .pane-tab:has(+ .pane-tab:hover)::after {
  opacity: 0;
}

.pane-tab button:focus-visible {
  outline: 1px solid var(--color-accent);
  outline-offset: -1px;
}

.pane-tab-drag-preview {
  position: fixed;
  z-index: 99999;
  pointer-events: none;
  overflow: hidden;
  opacity: 0.55;
}
</style>
