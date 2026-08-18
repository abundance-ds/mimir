<template>
  <div ref="rootRef" class="relative flex h-full shrink-0 items-center">
    <button
      ref="buttonRef"
      type="button"
      data-files-sort-button
      aria-haspopup="menu"
      :aria-expanded="menuOpen"
      :aria-label="`More sort options. ${label}, ${directionLabel}.`"
      :title="`More sort options — ${label}, ${directionLabel}`"
      class="flex h-full min-w-6 items-center justify-center gap-0.5 px-1 font-mono text-[9px] text-ink-4 outline-none hover:bg-chrome hover:text-ink focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
      @click.stop="toggleMenu"
      @keydown.down.stop.prevent="openMenu(1)"
      @keydown.up.stop.prevent="openMenu(-1)"
    >
      <IconArrowsSort :size="11" :stroke-width="1.8" />
      <span v-if="summary" class="max-w-20 truncate text-ink-3">{{ summary }}</span>
      <span v-if="summary && sortKey !== 'view'" aria-hidden="true">
        {{ sortDirection === 'desc' ? '↓' : '↑' }}
      </span>
    </button>
    <div
      v-if="menuOpen"
      ref="menuRef"
      data-files-sort-menu
      role="menu"
      class="absolute right-0 top-[calc(100%+4px)] z-50 w-40 border border-rule bg-surface py-1 text-[10px] text-ink-2 shadow-lg"
      @click.stop
      @pointerdown.stop
      @keydown="onMenuKeydown"
    >
      <button
        v-for="option in options"
        :key="option.id"
        type="button"
        role="menuitemradio"
        tabindex="-1"
        :data-file-sort-option="option.id"
        :aria-checked="sortKey === option.id"
        class="flex h-7 w-full items-center gap-2 px-2.5 text-left outline-none hover:bg-chrome focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
        :class="{ 'text-accent': sortKey === option.id }"
        @click="selectSort(option.id)"
      >
        <IconCheck v-if="sortKey === option.id" :size="12" :stroke-width="2" />
        <span v-else class="size-3" />
        <span>{{ option.label }}</span>
      </button>
      <div v-if="sortKey !== 'view'" role="separator" class="my-1 border-t border-rule-light" />
      <button
        v-for="option in sortKey === 'view' ? [] : directionOptions"
        :key="option.id"
        type="button"
        role="menuitemradio"
        tabindex="-1"
        :data-file-sort-direction="option.id"
        :aria-checked="sortDirection === option.id"
        class="flex h-7 w-full items-center gap-2 px-2.5 text-left outline-none hover:bg-chrome focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
        :class="{ 'text-accent': sortDirection === option.id }"
        @click="selectDirection(option.id)"
      >
        <IconCheck v-if="sortDirection === option.id" :size="12" :stroke-width="2" />
        <span v-else class="size-3" />
        <span>{{ option.label }}</span>
      </button>
    </div>
  </div>
</template>

<script setup>
import { nextTick, onMounted, onUnmounted, ref } from 'vue'
import { IconArrowsSort, IconCheck } from '@tabler/icons-vue'

defineProps({
  options: { type: Array, required: true },
  sortKey: { type: String, required: true },
  sortDirection: { type: String, required: true },
  directionOptions: { type: Array, required: true },
  label: { type: String, required: true },
  directionLabel: { type: String, required: true },
  summary: { type: String, default: '' },
})

const emit = defineEmits(['open', 'select-sort', 'select-direction'])
const rootRef = ref(null)
const buttonRef = ref(null)
const menuRef = ref(null)
const menuOpen = ref(false)

onMounted(() => document.addEventListener('pointerdown', onDocumentPointerDown, true))
onUnmounted(() => document.removeEventListener('pointerdown', onDocumentPointerDown, true))

async function toggleMenu() {
  if (menuOpen.value) {
    closeMenu()
    return
  }
  await openMenu(1)
}

async function openMenu(edge = 1) {
  emit('open')
  menuOpen.value = true
  await nextTick()
  const items = menuItems()
  items[edge < 0 ? items.length - 1 : 0]?.focus()
}

function closeMenu({ restoreFocus = false } = {}) {
  if (!menuOpen.value) return
  menuOpen.value = false
  if (restoreFocus) nextTick(() => buttonRef.value?.focus())
}

function selectSort(key) {
  emit('select-sort', key)
  closeMenu({ restoreFocus: true })
}

function selectDirection(direction) {
  emit('select-direction', direction)
  closeMenu({ restoreFocus: true })
}

function menuItems() {
  return [...(menuRef.value?.querySelectorAll('[role="menuitemradio"]') || [])]
}

function onMenuKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    closeMenu({ restoreFocus: true })
    return
  }
  if (event.key === 'Tab') {
    closeMenu()
    return
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  event.stopPropagation()
  const items = menuItems()
  if (!items.length) return
  const current = Math.max(items.indexOf(document.activeElement), 0)
  const next = event.key === 'Home'
    ? 0
    : event.key === 'End'
      ? items.length - 1
      : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
  items[next]?.focus()
}

function onDocumentPointerDown(event) {
  if (!rootRef.value?.contains(event.target)) closeMenu()
}
</script>
