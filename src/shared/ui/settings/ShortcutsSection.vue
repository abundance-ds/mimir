<template>
  <div>
    <section v-for="group in groups" :key="group.scope" class="shortcut-group">
      <div class="section-title">{{ group.title }}</div>
      <div class="shortcuts-table">
        <div v-for="(binding, index) in group.items" :key="binding.id" class="shortcut-row" :class="{ last: index === group.items.length - 1 }">
          <span class="shortcut-action">{{ binding.label }}</span>
          <span class="shortcut-keys"><span v-for="(key, i) in shortcutKeys(binding)" :key="i" class="kbd">{{ key }}</span></span>
        </div>
      </div>
    </section>
    <p class="mt-4 text-[11px] text-ink-3">Dialogs temporarily block commands for the panels behind them. Rename a session with F2 while its tab has focus. In Files, use ↑/↓ to select and Enter to open.</p>
  </div>
</template>
<script setup>
import { SHORTCUTS, shortcutKeys } from '../../shortcuts.js'
const groups = [
  { scope: 'global', title: 'App-wide' },
  { scope: 'panel', title: 'Focused panel' },
  { scope: 'editor', title: 'Editor' },
].map(group => ({ ...group, items: SHORTCUTS.filter(binding => binding.scope === group.scope) }))
</script>

<style scoped>
.shortcut-group + .shortcut-group {
  margin-top: 20px;
}

.shortcut-action {
  font-family: var(--font-sans);
  font-size: 11.5px;
  color: var(--color-ink-2);
}

.shortcut-keys {
  display: flex;
  align-items: center;
  gap: 3px;
}

.key-sep {
  font-family: var(--font-sans);
  font-size: 10px;
  color: var(--color-ink-3);
  margin: 0 1px;
}
</style>
