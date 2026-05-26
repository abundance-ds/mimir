<template>
  <Teleport to="body">
    <div class="ctx-overlay" @click="$emit('close')" @contextmenu.prevent="$emit('close')">
      <div class="ctx-menu" :style="menuStyle" @click.stop>
        <button class="ctx-item" @click="$emit('rename')">
          <IconPencil :size="13" />
          <span>Rename</span>
        </button>
        <button class="ctx-item" @click="$emit('pin')">
          <IconPinnedOff v-if="pinned" :size="13" />
          <IconPin v-else :size="13" />
          <span>{{ pinned ? 'Unpin' : 'Pin' }}</span>
        </button>
        <button class="ctx-item" @click="$emit('export')">
          <IconFileExport :size="13" />
          <span>Export</span>
        </button>
        <div class="ctx-divider" />
        <button class="ctx-item" @click="$emit('archive')">
          <IconArchive :size="13" />
          <span>Archive</span>
          <span class="ctx-shortcut">{{ isMac ? '⌘⇧D' : 'Ctrl+Shift+D' }}</span>
        </button>
        <button class="ctx-item destructive" @click="$emit('delete')">
          <IconTrash :size="13" />
          <span>Delete</span>
        </button>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { computed } from 'vue'
import { IconPencil, IconPin, IconPinnedOff, IconFileExport, IconArchive, IconTrash } from '@tabler/icons-vue'
import { platformKind } from '../../shared/platform.js'

const isMac = platformKind() === 'macos'

const props = defineProps({
  x: { type: Number, default: 0 },
  y: { type: Number, default: 0 },
  pinned: { type: Boolean, default: false },
})
defineEmits(['close', 'rename', 'pin', 'export', 'archive', 'delete'])

const menuStyle = computed(() => ({
  position: 'fixed',
  left: `${props.x}px`,
  top: `${props.y}px`,
}))
</script>

<style scoped>
.ctx-overlay {
  position: fixed; inset: 0; z-index: 200;
}
.ctx-menu {
  background: var(--color-surface); border: 1px solid var(--color-rule); border-radius: 6px;
  padding: 4px; min-width: 180px; z-index: 201;
  box-shadow: 0 8px 30px rgba(0,0,0,.18);
}
.ctx-item {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 6px 10px; border-radius: 4px;
  font-family: var(--font-sans); font-size: 12px; color: var(--color-ink-2);
  text-align: left;
}
.ctx-item:hover { background: var(--color-chrome-high); color: var(--color-ink); }
.ctx-item.destructive { color: var(--color-accent); }
.ctx-item.destructive:hover { background: var(--color-accent-tint); }
.ctx-shortcut {
  margin-left: auto; font-size: 11px; color: var(--color-ink-3); font-family: var(--font-mono);
}
.ctx-divider {
  height: 1px; background: var(--color-rule-light); margin: 3px 4px;
}
</style>
