<template>
  <div>
    <div class="section-title">Editor</div>
    <div class="shortcuts-table">
      <div
        v-for="(s, i) in editorShortcuts"
        :key="'e' + i"
        class="shortcut-row"
        :class="{ last: i === editorShortcuts.length - 1 }"
      >
        <span class="shortcut-action">{{ s.action }}</span>
        <span class="shortcut-keys">
          <span
            v-for="(k, ki) in s.keys"
            :key="ki"
            :class="k === '/' ? 'key-sep' : 'kbd'"
          >{{ k }}</span>
        </span>
      </div>
    </div>

    <div class="section-title mt">Panel</div>
    <div class="shortcuts-table">
      <div
        v-for="(s, i) in panelShortcuts"
        :key="'p' + i"
        class="shortcut-row"
        :class="{ last: i === panelShortcuts.length - 1 }"
      >
        <span class="shortcut-action">{{ s.action }}</span>
        <span class="shortcut-keys">
          <span
            v-for="(k, ki) in s.keys"
            :key="ki"
            :class="k === '/' ? 'key-sep' : 'kbd'"
          >{{ k }}</span>
        </span>
      </div>
    </div>
  </div>
</template>

<script setup>
const editorShortcuts = [
  { action: 'Toggle sidebar', keys: ['⌘', '\\'] },
  { action: 'Cycle toolbar', keys: ['⌘', '/'] },
  { action: 'Bold', keys: ['⌘', 'B'] },
  { action: 'Italic', keys: ['⌘', 'I'] },
  { action: 'Cycle view', keys: ['⌘', 'E'] },
  { action: 'Settings', keys: ['⌘', ','] },
  { action: 'Save', keys: ['⌘', 'S'] },
  { action: 'New document', keys: ['⌘', 'N'] },
  { action: 'Close tab', keys: ['⌘', 'W'] },
  { action: 'Zoom in / out', keys: ['⌘', '+', '/', '⌘', '−'] },
]

const panelShortcuts = [
  { action: 'New chat', keys: ['⌘', 'N'] },
  { action: 'Toggle sidebar', keys: ['⌘', '\\'] },
  { action: 'Toggle terminal', keys: ['⌘', '`'] },
  { action: 'Send message', keys: ['Enter'] },
  { action: 'New line', keys: ['Shift', 'Enter'] },
  { action: 'Stop generation', keys: ['Esc'] },
]
</script>

<style scoped>
.mt {
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
