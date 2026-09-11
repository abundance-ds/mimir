<template>
  <button
    ref="trigger"
    type="button"
    class="pane-icon-button workbench-menu-trigger"
    :aria-label="label"
    :title="label"
    :aria-haspopup="searchable ? 'dialog' : 'menu'"
    :aria-expanded="open"
    @click="toggle"
    @keydown.down.prevent="show()"
  >
    <slot>{{ label }}</slot>
  </button>
  <Teleport to="body">
    <div
      v-if="open"
      ref="menu"
      :role="searchable ? 'dialog' : 'menu'"
      :aria-label="label"
      class="workbench-popup"
      :class="{ 'workbench-popup-compact': compact, 'workbench-popup-search': searchable }"
      :style="position"
      @keydown="keydown"
      @contextmenu.prevent
    >
      <input
        v-if="searchable"
        ref="searchInput"
        v-model="query"
        type="search"
        role="combobox"
        aria-autocomplete="list"
        :aria-expanded="open"
        :aria-controls="`${menuId}-list`"
        aria-label="Find tab"
        placeholder="Find tab…"
        class="m-1 h-7 w-[calc(100%-8px)] border border-rule bg-surface px-2 text-ink"
        :aria-activedescendant="selected >= 0 ? `${menuId}-${selected}` : undefined"
      />
      <div :id="`${menuId}-list`" :role="searchable ? 'listbox' : undefined" :aria-label="searchable ? label : undefined">
      <button
        v-for="(item, index) in filtered"
        :id="`${menuId}-${index}`"
        :key="item.id"
        type="button"
        :role="searchable ? 'option' : 'menuitem'"
        :aria-selected="searchable ? selected === index : undefined"
        :disabled="item.disabled"
        :aria-current="item.active ? 'true' : undefined"
        :class="{ 'bg-accent-soft': searchable ? selected === index : item.active }"
        @click="choose(item)"
      >
        {{ item.label
        }}<span v-if="item.detail" class="ml-auto pl-3 text-ink-3">{{
          item.detail
        }}</span>
      </button>
      <span v-if="!filtered.length" class="block px-3 py-2 text-ink-3"
        >No matches</span>
      <button
        v-if="action"
        :id="`${menuId}-${filtered.length}`"
        type="button"
        :role="searchable ? 'option' : 'menuitem'"
        :aria-selected="searchable ? selected === filtered.length : undefined"
        data-menu-action
        :class="{ 'bg-accent-soft': selected === filtered.length }"
        @click="chooseAction"
      >{{ action.label }}<span class="ml-auto pl-3 text-ink-3">{{ action.detail }}</span></button>
      </div>
    </div>
  </Teleport>
</template>
<script setup>
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'
const props = defineProps({
  label: { type: String, required: true },
  items: { type: Array, default: () => [] },
  searchable: Boolean,
  action: { type: Object, default: null },
  compact: Boolean,
})
const emit = defineEmits(['select', 'action'])
const trigger = ref(null),
  menu = ref(null),
  searchInput = ref(null),
  open = ref(false),
  query = ref(''),
  position = ref({})
const menuId = useId()
const selected = ref(-1)
let returnFocus = null
watch(query, () => { selected.value = 0 })
const filtered = computed(() =>
  props.items.filter((item) =>
    item.label.toLowerCase().includes(query.value.toLowerCase()),
  ),
)
function items() {
  return [
    ...(menu.value?.querySelectorAll('button:not(:disabled)') || []),
  ]
}
function focusItem(index) {
  items()[index]?.focus()
}
async function show(event) {
  returnFocus =
    event?.currentTarget?.querySelector?.('[role=tab], [data-activity-key] > button') || trigger.value
  const rect = trigger.value?.getBoundingClientRect()
  position.value = {
    left: `${Math.max(4, Math.min(event?.clientX ?? rect?.left ?? 4, window.innerWidth - (props.compact ? 200 : 264)))}px`,
    top: `${Math.max(4, Math.min(event?.clientY ?? rect?.bottom ?? 40, window.innerHeight - 180))}px`,
  }
  query.value = ''
  selected.value = 0
  open.value = true
  document.addEventListener('pointerdown', outside, true)
  window.addEventListener('resize', close)
  await nextTick()
  const bounds = menu.value?.getBoundingClientRect()
  if (bounds?.bottom > window.innerHeight - 4)
    position.value.top = `${Math.max(4, window.innerHeight - bounds.height - 4)}px`
  if (props.searchable) searchInput.value?.focus()
  else focusItem(0)
}
function close(restore = false) {
  open.value = false
  document.removeEventListener('pointerdown', outside, true)
  window.removeEventListener('resize', close)
  if (restore === true)
    nextTick(() => returnFocus?.isConnected && returnFocus.focus())
}
function toggle() {
  if (open.value) close()
  else show()
}
function outside(e) {
  if (!menu.value?.contains(e.target) && !trigger.value?.contains(e.target))
    close()
}
function choose(item) {
  close(true)
  emit('select', item.id)
}
function chooseAction() {
  close()
  emit('action', props.action.id)
}
function keydown(e) {
  if (e.isComposing) return
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    close(true)
    return
  }
  if (e.key === 'Tab') {
    close()
    return
  }
  if (e.target === searchInput.value) {
    const count = filtered.value.length + (props.action ? 1 : 0)
    if (['ArrowDown', 'ArrowUp', 'Enter'].includes(e.key)) {
      e.preventDefault()
      e.stopPropagation()
      if (!count) return
      if (e.key === 'Enter') {
        const index = Math.min(count - 1, Math.max(0, selected.value))
        if (index === filtered.value.length) chooseAction()
        else choose(filtered.value[index])
      } else {
        selected.value = selected.value < 0
          ? (e.key === 'ArrowDown' ? 0 : count - 1)
          : (selected.value + (e.key === 'ArrowDown' ? 1 : -1) + count) % count
        nextTick(() => document.getElementById(`${menuId}-${selected.value}`)?.scrollIntoView?.({ block: 'nearest' }))
      }
    }
    return
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
  e.preventDefault()
  const all = items(),
    i = all.indexOf(document.activeElement)
  focusItem(
    e.key === 'Home'
      ? 0
      : e.key === 'End'
        ? all.length - 1
        : (i + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length,
  )
}
onBeforeUnmount(() => close())
defineExpose({ show, close })
</script>
<style>
.workbench-menu-trigger { gap: 4px; }
.workbench-popup button:focus-visible {
  outline: 1px solid var(--color-accent);
  outline-offset: -1px;
}
.workbench-popup {
  position: fixed;
  z-index: 250;
  width: 256px;
  max-width: calc(100vw - 8px);
  max-height: min(360px, calc(100vh - 8px));
  overflow: auto;
  padding: 4px;
  background: var(--color-surface);
  border: 1px solid var(--color-rule);
  box-shadow: 0 4px 16px #0003;
  font-size: 12px;
  color: var(--color-ink);
}
.workbench-popup-search {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.workbench-popup-search input {
  flex: 0 0 28px;
}
.workbench-popup-search > [role="listbox"] {
  min-height: 0;
  overflow: auto;
  scroll-padding-bottom: 32px;
}
.workbench-popup-search [data-menu-action] {
  position: sticky;
  bottom: 0;
  border-top: 1px solid var(--color-rule);
  background: var(--color-surface);
}
.workbench-popup-search [data-menu-action].bg-accent-soft {
  background: var(--color-accent-soft);
}
.workbench-popup-compact {
  width: 192px;
  padding: 4px 0;
  font-size: 11px;
  color: var(--color-ink-2);
}
.workbench-popup button {
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 28px;
  text-align: left;
  padding: 4px 8px;
  overflow-wrap: anywhere;
}
.workbench-popup button:hover {
  background: var(--color-chrome-mid);
}
.workbench-popup button:disabled {
  opacity: 0.4;
}
</style>
