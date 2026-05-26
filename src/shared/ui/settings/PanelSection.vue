<template>
  <div>
    <div class="panel-empty">
      <p class="panel-empty-text">Panel-specific settings will appear here in a future update.</p>
      <p class="panel-empty-hint">Terminal, sidebar, and notification preferences.</p>
    </div>
  </div>
</template>

<style scoped>
.panel-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding-top: 60px;
}

.panel-empty-text {
  font-family: var(--font-sans);
  font-size: 12px;
  color: var(--color-ink-3);
  margin: 0 0 6px;
}

.panel-empty-hint {
  font-family: var(--font-sans);
  font-size: 10px;
  color: var(--color-ink-3);
  margin: 0;
}
</style>
