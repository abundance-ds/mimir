<template>
  <Teleport to="body">
    <div class="ctx-overlay" @click="$emit('close')" @contextmenu.prevent="$emit('close')">
      <div class="ctx-menu" :style="menuStyle" @click.stop>
        <button v-if="hasFolder" class="ctx-item" @click="$emit('reveal')">
          <IconFolderOpen :size="13" />
          <span>Reveal in Finder</span>
        </button>
        <button class="ctx-item" @click="$emit('settings')">
          <IconSettings :size="13" />
          <span>Open</span>
        </button>
        <button v-if="hasDoneSessions" class="ctx-item" @click="$emit('cleanup')">
          <IconArchive :size="13" />
          <span>Clean up</span>
        </button>
        <template v-if="!system">
          <div class="ctx-divider" />
          <button class="ctx-item destructive" @click="$emit('remove')">
            <IconTrash :size="13" />
            <span>Remove from Sidebar</span>
          </button>
        </template>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { computed } from 'vue'
import { IconFolderOpen, IconSettings, IconTrash, IconArchive } from '@tabler/icons-vue'

const props = defineProps({
  x: { type: Number, default: 0 },
  y: { type: Number, default: 0 },
  hasFolder: { type: Boolean, default: false },
  system: { type: Boolean, default: false },
  hasDoneSessions: { type: Boolean, default: false },
})
defineEmits(['close', 'reveal', 'remove', 'settings', 'cleanup'])

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
.ctx-divider {
  height: 1px; background: var(--color-rule-light); margin: 3px 4px;
}
</style>
