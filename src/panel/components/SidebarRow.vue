<template>
  <div
    class="sb-row"
    :class="{ 'is-active': active, 'is-dim': dim }"
    :style="{ paddingLeft: `${14 + indent * 14}px` }"
    @click="$emit('click')"
  >
    <span class="sb-icon">
      <slot name="icon" />
    </span>
    <span class="sb-label">{{ label }}</span>
    <slot name="badge" />
    <span v-if="shortcut" class="sb-shortcut">{{ shortcut }}</span>
  </div>
</template>

<script setup>
defineProps({
  label: { type: String, required: true },
  active: Boolean,
  dim: Boolean,
  indent: { type: Number, default: 0 },
  shortcut: String,
})
defineEmits(['click'])
</script>

<style scoped>
.sb-row {
  display: flex; align-items: center; gap: 10px;
  height: 26px; padding-right: 10px;
  border-radius: 6px; color: var(--color-ink-2);
}
.sb-row:hover { background: var(--color-chrome-mid); }
.sb-row.is-active { background: var(--color-accent-tint); color: var(--color-ink); }
.sb-row.is-dim { color: var(--color-ink-3); }
.sb-icon {
  display: inline-flex; width: 16px; height: 16px;
  align-items: center; justify-content: center;
  color: var(--color-ink-3); flex-shrink: 0;
}
.sb-row.is-active .sb-icon { color: var(--color-accent); }
.sb-label {
  font-size: 13px; flex: 1;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.sb-shortcut { font-size: 11px; color: var(--color-ink-3); font-family: var(--font-mono); }
</style>
