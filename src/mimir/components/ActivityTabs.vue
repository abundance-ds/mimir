<template>
  <PaneTabStrip
    ref="tabStrip" label="Main tabs" class="activity-tabs"
    @keydown="onKeydown"
  >
    <template #leading>
    <WorkbenchMenu
      label="All tabs"
      :items="allTabs"
      :action="{ id: 'new', label: 'New tab', detail: '⌘T' }"
      searchable
      @select="$emit('select', $event)"
      @action="$emit('new')"
      ><IconChevronDown :size="15" :stroke-width="1.8" /><span
        v-if="tabs.some(needsAttention)"
        aria-label="Tabs need attention"
        >!</span
      ></WorkbenchMenu
    >
    </template>
      <PaneTab
        v-for="tab in tabs"
        :key="tab.id"
        :data-main-tab="tab.id"
        class="main-tab"
        :label="tab.title" :selected="tab.id === activeId"
        :class="{
          selected: tab.id === activeId,
          'drop-before': reorder.dropIndicator.value?.beforeId === tab.id,
          'drop-after': reorder.dropIndicator.value?.afterId === tab.id,
        }"
        @pointerdown="reorder.onPointerDown($event, tab.id)"
        @contextmenu.prevent="showContext(tab, $event)"
      >
        <input
          v-if="renaming === tab.id"
          ref="renameInput"
          v-model="draft"
          data-tab-rename
          aria-label="Session name"
          maxlength="160"
          spellcheck="false"
          autocapitalize="off"
          autocorrect="off"
          class="tab-name-input border border-accent bg-surface px-1 text-ink"
          @keydown="renameKey"
          @blur="cancelRename"
        />
        <PaneTabButton
          v-else
          :selected="tab.id === activeId"
          :title="tabTitle(tab)"
          class="tab-select"
          @click="select(tab.id)"
          @dblclick="beginRename(tab)"
        >
          <component
            :is="activityIcon(tab)"
            :size="14"
            :stroke-width="1.7"
            :monochrome="true"
            class="shrink-0"
          />
          <span class="min-w-0 flex-1 truncate">{{ tab.title }}</span>
          <span
            v-if="needsAttention(tab)"
            :title="status(tab)"
            :aria-label="status(tab)"
            class="shrink-0 text-[11px]"
          >!</span>
        </PaneTabButton>
        <PaneTabClose :action="closeLabel(tab)" :label="tab.title" @close="$emit('close', tab.id)" />
      </PaneTab>
    <template #trailing>
    <button
      type="button"
      data-new-main-tab
      title="New tab (⌘T)"
      aria-label="New tab"
      class="pane-icon-button"
      @click="$emit('new')"
    >
      <IconPlus :size="15" :stroke-width="1.8" />
    </button>
    <span class="hidden"
      ><WorkbenchMenu
        ref="context"
        label="Tab actions"
        compact
        :items="contextItems"
        @select="contextAction"
    /></span>
    </template>
  </PaneTabStrip>
</template>
<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { IconChevronDown, IconPlus } from '@tabler/icons-vue'
import { activityIcon } from '../activityIcons.js'
import { usePointerReorder } from '../composables/usePointerReorder.js'
import WorkbenchMenu from './WorkbenchMenu.vue'
import PaneTab from '../../shared/ui/chrome/PaneTab.vue'
import PaneTabButton from '../../shared/ui/chrome/PaneTabButton.vue'
import PaneTabClose from '../../shared/ui/chrome/PaneTabClose.vue'
import PaneTabStrip from '../../shared/ui/chrome/PaneTabStrip.vue'
const props = defineProps({
  tabs: { type: Array, default: () => [] },
  activeId: { type: String, default: '' },
  blockingIds: { type: Set, default: () => new Set() },
  restoringIds: { type: Set, default: () => new Set() },
})
const emit = defineEmits(['select', 'close', 'rename', 'new', 'reorder'])
const tabStrip = ref(null)
const strip = computed(() => tabStrip.value?.scroll)
const context = ref(null),
  contextTab = ref(null),
  renaming = ref(''),
  draft = ref(''),
  renameInput = ref(null)
const live = (tab) =>
  ['starting', 'working', 'needs-input', 'idle'].includes(tab.status) &&
  tab.host?.type === 'pty'
const closeLabel = (tab) => (live(tab) ? 'Stop and archive' : tab.unique ? 'Close' : 'Archive')
const status = (tab) =>
  tab.status === 'error' || tab.error
    ? 'Error'
    : props.blockingIds.has(tab.id) || tab.status === 'needs-input'
      ? 'Needs input'
      : tab.unread
        ? 'Unread'
        : props.restoringIds.has(tab.id)
          ? 'Resuming'
          : ({ starting: 'Starting', working: 'Working', idle: 'Idle', done: 'Done', interrupted: 'Interrupted' }[tab.status] || '')
const needsAttention = (tab) => ['Error', 'Needs input', 'Unread'].includes(status(tab))
const tabTitle = (tab) =>
  `${tab.title}${status(tab) ? ` — ${status(tab)}` : ''}`
const allTabs = computed(() =>
  props.tabs.map((tab) => ({
    id: tab.id,
    label: tab.title,
    detail: status(tab),
    active: tab.id === props.activeId,
  })),
)
const contextItems = computed(() =>
  contextTab.value
    ? [
        ...(!contextTab.value.unique
          ? [{ id: 'rename', label: 'Rename…', detail: 'F2' }]
          : []),
        { id: 'close', label: closeLabel(contextTab.value), detail: '⌘W' },
        {
          id: 'left',
          label: 'Move tab left',
          disabled: props.tabs[0]?.id === contextTab.value.id,
        },
        {
          id: 'right',
          label: 'Move tab right',
          disabled: props.tabs.at(-1)?.id === contextTab.value.id,
        },
      ]
    : [],
)
const reorder = usePointerReorder({
  root: strip,
  axis: 'x',
  rowSelector: '[data-main-tab]',
  keyAttribute: 'data-main-tab',
  keys: () => props.tabs.map((tab) => tab.id),
  onReorder: (ids) => emit('reorder', ids),
})
function select(id) {
  if (!reorder.suppressClick.value) emit('select', id)
}
async function beginRename(tab) {
  if (tab.unique) return
  renaming.value = tab.id
  draft.value = tab.title
  await nextTick()
  const field = Array.isArray(renameInput.value)
    ? renameInput.value[0]
    : renameInput.value
  field?.focus()
  field?.select()
}
function cancelRename() {
  renaming.value = ''
}
function renameKey(event) {
  event.stopPropagation()
  if (event.isComposing || event.keyCode === 229) return
  if (event.key === 'Escape') {
    event.preventDefault()
    cancelRename()
    focusTab(props.activeId)
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    const title = draft.value.trim(),
      id = renaming.value
    if (!title) return
    cancelRename()
    emit('rename', { id, title })
    focusTab(id)
  }
}
function focusTab(id) {
  nextTick(() =>
    [...(strip.value?.querySelectorAll('[data-main-tab]') || [])]
      .find((el) => el.dataset.mainTab === id)
      ?.querySelector('[role="tab"]')
      ?.focus(),
  )
}
function showContext(tab, event) {
  contextTab.value = tab
  context.value?.show(event)
}
function contextAction(action) {
  const tab = contextTab.value
  if (action === 'rename') {
    void nextTick(() => beginRename(tab))
    return
  }
  if (action === 'close') {
    emit('close', tab.id)
    return
  }
  const ids = props.tabs.map((t) => t.id),
    from = ids.indexOf(tab.id),
    to = from + (action === 'left' ? -1 : 1)
  if (to >= 0 && to < ids.length) {
    ;[ids[from], ids[to]] = [ids[to], ids[from]]
    emit('reorder', ids)
  }
}
function onKeydown(event) {
  if (
    event.isComposing ||
    event.target?.closest('input') ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey
  )
    return
  const tabButton = event.target?.closest('[role="tab"]')
  if (!tabButton) return
  const tab = props.tabs.find((t) => t.id === tabButton.closest('[data-main-tab]')?.dataset.mainTab)
  if (!tab) return
  if (event.key === 'F2') {
    event.preventDefault()
    beginRename(tab)
    return
  }
  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
    event.preventDefault()
    const r = event.target.getBoundingClientRect()
    showContext(tab, { clientX: r.left, clientY: r.bottom, currentTarget: tabButton.closest('[data-main-tab]') })
    return
  }
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const i = props.tabs.indexOf(tab),
    n = props.tabs.length
  const next =
    props.tabs[
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? n - 1
          : (i + (event.key === 'ArrowRight' ? 1 : -1) + n) % n
    ]
  emit('select', next.id)
  focusTab(next.id)
}
watch(
  () => props.activeId,
  async (id) => {
    cancelRename()
    await nextTick()
    ;[...(strip.value?.querySelectorAll('[data-main-tab]') || [])]
      .find((el) => el.dataset.mainTab === id)
      ?.scrollIntoView?.({ behavior: 'auto', block: 'nearest', inline: 'nearest' })
  },
)
</script>
<style scoped>
.main-tab.drop-before {
  box-shadow: inset 1px 0 var(--color-accent);
}
.main-tab.drop-after {
  box-shadow: inset -1px 0 var(--color-accent);
}
.tab-name-input {
  position: absolute;
  inset: 2px 28px 2px 8px;
  width: calc(100% - 36px);
  min-width: 0;
}
</style>
