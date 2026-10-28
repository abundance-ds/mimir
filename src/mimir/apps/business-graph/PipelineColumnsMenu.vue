<template>
  <div ref="root" class="pipeline-columns">
    <button ref="trigger" type="button" data-graph-control="pipeline-columns" class="pipeline-columns-trigger"
      :class="{ 'pipeline-columns-active': hidden.length }" aria-haspopup="menu" :aria-expanded="opened"
      :aria-label="hidden.length ? `Columns. ${hidden.length} hidden: ${hiddenLabels}` : 'Columns. All shown'"
      :title="hidden.length ? `Hidden: ${hiddenLabels}` : 'Show or hide columns'"
      @click="toggle" @keydown.down.prevent="open('first')" @keydown.up.prevent="open('last')">
      <IconColumns :size="13" aria-hidden="true" />
      <span>Columns</span>
      <span v-if="hidden.length" class="pipeline-columns-count">{{ hidden.length }} hidden</span>
    </button>
    <Teleport to="body">
      <div v-if="opened" ref="menu" data-modal-portal :data-pipeline-columns-menu="view" role="menu"
        :aria-label="`${viewLabel} columns`" class="pipeline-columns-menu" :style="style" @keydown="onKeydown">
        <p>Show columns</p>
        <button v-for="column in columns" :key="column.id" type="button" role="menuitemcheckbox"
          :data-graph-control="`pipeline-column-${view}-${column.id}`" :disabled="column.locked"
          :aria-checked="!hidden.includes(column.id)"
          :title="column.locked ? 'This column is always shown' : undefined"
          @click="$emit('toggle', column.id, !hidden.includes(column.id))">
          <span class="pipeline-check" :class="{ checked: !hidden.includes(column.id) }" aria-hidden="true">
            <IconCheck v-if="!hidden.includes(column.id)" :size="11" />
          </span>
          <span class="pipeline-columns-label">{{ column.label }}</span>
          <small v-if="column.locked">Always shown</small>
        </button>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { IconCheck, IconColumns } from '@tabler/icons-vue'

const props = defineProps({
  view: { type: String, required: true },
  viewLabel: { type: String, default: '' },
  columns: { type: Array, default: () => [] },
  hidden: { type: Array, default: () => [] },
})
defineEmits(['toggle'])
const root = ref(null), trigger = ref(null), menu = ref(null), opened = ref(false), style = ref({})
const hiddenLabels = computed(() => props.columns.filter(column => props.hidden.includes(column.id)).map(column => column.label).join(', '))

function items() { return [...(menu.value?.querySelectorAll('[role="menuitemcheckbox"]:not(:disabled)') || [])] }
async function open(edge = '') {
  opened.value = true
  await nextTick()
  place()
  if (edge) items()[edge === 'last' ? items().length - 1 : 0]?.focus()
}
function toggle() { if (opened.value) closeMenus(); else void open() }
function place() {
  const rect = trigger.value?.getBoundingClientRect()
  if (!rect) return
  const width = 210
  style.value = { top: `${rect.bottom + 4}px`, left: `${Math.max(6, Math.min(rect.right - width, window.innerWidth - width - 6))}px`, width: `${width}px` }
}
function closeMenus({ restoreFocus = false } = {}) {
  if (!opened.value) return false
  opened.value = false
  if (restoreFocus) trigger.value?.focus({ preventScroll: true })
  return true
}
function onKeydown(event) {
  const list = items()
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    closeMenus({ restoreFocus: true })
  } else if (list.length && ['Home', 'End'].includes(event.key)) {
    event.preventDefault()
    list[event.key === 'Home' ? 0 : list.length - 1].focus()
  } else if (list.length && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
    event.preventDefault()
    const index = list.indexOf(document.activeElement)
    const delta = event.key === 'ArrowDown' ? 1 : -1
    list[index < 0 ? (delta > 0 ? 0 : list.length - 1) : (index + delta + list.length) % list.length].focus()
  }
}
function outside(event) {
  if (opened.value && !root.value?.contains(event.target) && !menu.value?.contains(event.target)) closeMenus()
}
watch(() => props.view, () => closeMenus())
onMounted(() => {
  document.addEventListener('pointerdown', outside)
  window.addEventListener('resize', place)
})
onUnmounted(() => {
  document.removeEventListener('pointerdown', outside)
  window.removeEventListener('resize', place)
})
defineExpose({ closeMenus })
</script>

<style scoped>
.pipeline-columns { flex: 0 0 auto; }
.pipeline-columns-trigger { display: inline-flex; height: 24px; align-items: center; gap: 5px; border: 1px solid transparent; padding: 0 7px; color: var(--color-ink-3); font-size: 10px; }
.pipeline-columns-trigger:hover, .pipeline-columns-trigger[aria-expanded='true'] { background: var(--color-chrome-mid); color: var(--color-ink); }
.pipeline-columns-active { border-color: color-mix(in srgb, var(--color-accent) 48%, var(--color-rule)); color: var(--color-ink); }
.pipeline-columns-count { color: var(--color-accent); font-size: 9.5px; }
.pipeline-columns-trigger:focus-visible, .pipeline-columns-menu button:focus-visible { outline: 2px solid var(--color-accent); outline-offset: -2px; }
.pipeline-columns-menu { position: fixed; z-index: 270; max-height: min(340px, calc(100vh - 80px)); overflow-y: auto; border: 1px solid var(--color-rule); background: var(--color-surface); padding: 5px; box-shadow: 0 8px 24px color-mix(in srgb, var(--color-ink) 12%, transparent); }
.pipeline-columns-menu > p { padding: 7px 8px 6px; color: var(--color-ink-3); font-size: 11px; font-weight: 650; }
.pipeline-columns-menu > button { display: flex; width: 100%; min-height: 30px; align-items: center; gap: 9px; padding: 0 8px; color: var(--color-ink-2); font-size: 11px; text-align: left; }
.pipeline-columns-menu > button:hover:not(:disabled) { background: var(--color-chrome-mid); }
.pipeline-columns-menu > button:disabled { color: var(--color-ink-3); cursor: default; }
.pipeline-columns-label { flex: 1 1 auto; }
.pipeline-columns-menu small { color: var(--color-ink-3); font-size: 10px; }
.pipeline-check { display: grid; width: 17px; height: 17px; flex: 0 0 auto; place-items: center; border: 1px solid var(--color-rule); border-radius: 3px; color: transparent; }
.pipeline-check.checked { border-color: color-mix(in srgb, var(--color-accent) 52%, var(--color-rule)); background: var(--color-accent-soft); color: var(--color-accent); }
</style>
