<template>
  <div class="shrink-0 border-b border-rule">
    <button
      ref="triggerRef"
      type="button"
      data-sidebar-workspace
      class="no-drag group flex h-11 w-full min-w-0 items-center text-left hover:bg-chrome-mid focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
      :aria-label="workspaceMissing
        ? `Workspace unavailable: ${workspaceName}`
        : workspacePath ? `Switch workspace: ${workspaceName}` : 'Open workspace folder'"
      :aria-expanded="popoverOpen"
      aria-haspopup="dialog"
      aria-controls="project-switcher-popover"
      :title="workspaceMissing ? `${workspacePath} is unavailable` : workspacePath || 'Open workspace folder'"
      @click.stop="togglePopover"
      @keydown.down.prevent="openPopover"
    >
      <span class="ml-3 grid size-7 shrink-0 place-items-center border border-rule-light bg-chrome-mid font-sans text-[10px] font-semibold uppercase text-ink-2 group-hover:border-rule">
        {{ monogram }}
      </span>
      <span v-if="!collapsed" class="ml-2 min-w-0 flex-1">
        <span class="block truncate text-[12px] font-semibold text-ink">
          {{ workspaceMissing
            ? `${workspaceName || 'Workspace'} - not found`
            : workspaceName || 'Open workspace' }}
        </span>
        <span
          class="block truncate font-mono text-[9px]"
          :class="workspaceMissing ? 'text-rem' : 'text-ink-3'"
        >
          {{ workspacePath || 'Choose a folder' }}
        </span>
      </span>
      <IconChevronDown
        v-if="!collapsed"
        :size="13"
        :stroke-width="1.9"
        class="mx-3 shrink-0 text-ink-4 group-hover:text-ink-2"
      />
    </button>

    <Teleport to="body">
      <div
        v-if="popoverOpen"
        id="project-switcher-popover"
        ref="popoverRef"
        data-project-switcher-menu
        role="dialog"
        aria-label="Switch workspace"
        class="fixed z-[220] flex max-h-[min(420px,calc(100vh-16px))] w-[360px] max-w-[calc(100vw-16px)] flex-col overflow-hidden border border-rule bg-surface shadow-lg"
        :style="popoverStyle"
        @keydown="onPopoverKeydown"
      >
        <div class="flex h-10 shrink-0 items-center gap-2 border-b border-rule px-2.5">
          <IconSearch :size="14" :stroke-width="1.8" class="shrink-0 text-ink-3" />
          <input
            ref="inputRef"
            v-model="query"
            data-project-search
            type="search"
            placeholder="Switch workspace…"
            autocomplete="off"
            autocorrect="off"
            autocapitalize="off"
            spellcheck="false"
            role="combobox"
            aria-autocomplete="list"
            aria-controls="project-switcher-results"
            :aria-expanded="options.length > 0"
            :aria-activedescendant="selectedOption?.id"
            class="h-full min-w-0 flex-1 bg-transparent font-mono text-[11px] text-ink outline-none placeholder:text-ink-4"
            @input="onInput"
            @keydown.down.prevent="moveSelection(1)"
            @keydown.up.prevent="moveSelection(-1)"
            @keydown.home.prevent="selectEdge('start')"
            @keydown.end.prevent="selectEdge('end')"
            @keydown.enter.prevent="activateSelected"
            @keydown.tab="closePopover"
          />
          <kbd class="font-mono text-[9px] text-ink-4">ESC</kbd>
        </div>

        <div
          id="project-switcher-results"
          class="min-h-0 overflow-y-auto p-1"
          role="listbox"
          aria-label="Workspaces and workspace actions"
        >
          <div
            v-if="filteredWorkspaces.length === 0"
            data-project-empty
            class="px-2.5 py-3 text-[10px] text-ink-3"
            role="status"
          >
            No matching workspaces.
          </div>

          <button
            v-for="(option, index) in options"
            :id="option.id"
            :key="option.key"
            type="button"
            data-project-menu-item
            :data-project-path="option.path || undefined"
            :data-project-open-folder="option.type === 'open' ? '' : undefined"
            :data-project-create="option.type === 'create' ? '' : undefined"
            role="option"
            :aria-selected="index === selectedIndex"
            :aria-disabled="option.disabled ? 'true' : undefined"
            :disabled="option.disabled"
            tabindex="-1"
            class="flex h-8 w-full min-w-0 items-center px-2.5 text-left hover:bg-chrome-high focus:outline-none disabled:cursor-default disabled:hover:bg-transparent"
            :class="[
              { 'bg-accent-soft': index === selectedIndex },
              option.divider ? 'mt-1 border-t border-rule-light pt-px' : '',
            ]"
            :title="option.path || option.title"
            @mouseenter="selectIndex(index)"
            @click="activateOption(option)"
          >
            <template v-if="option.type === 'project'">
              <span
                class="min-w-0 flex-1 truncate text-[11px] font-medium"
                :class="option.disabled ? 'text-ink-4' : 'text-ink'"
              >
                {{ option.title }}
              </span>
              <span
                class="ml-3 max-w-[55%] shrink-0 truncate font-mono text-[9px]"
                :class="option.disabled ? 'text-rem' : 'text-ink-4'"
              >
                {{ option.meta }}
              </span>
            </template>
            <template v-else>
              <component
                :is="option.type === 'open' ? IconFolderOpen : IconFolderPlus"
                :size="14"
                :stroke-width="1.8"
                class="mr-2 shrink-0 text-ink-3"
              />
              <span class="text-[11px] font-medium text-ink-2">{{ option.title }}</span>
            </template>
          </button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import {
  IconChevronDown,
  IconFolderOpen,
  IconFolderPlus,
  IconSearch,
} from '@tabler/icons-vue'

const DEFAULT_PROJECT_LIMIT = 8

const props = defineProps({
  collapsed: { type: Boolean, default: false },
  workspaceName: { type: String, default: '' },
  workspacePath: { type: String, default: '' },
  workspaceMissing: { type: Boolean, default: false },
  recentWorkspaces: { type: Array, default: () => [] },
})

const emit = defineEmits([
  'chooseWorkspace',
  'createWorkspace',
  'dismissMissingWorkspaces',
  'openWorkspace',
  'reconcileWorkspaces',
])
const triggerRef = ref(null)
const popoverRef = ref(null)
const inputRef = ref(null)
const popoverOpen = ref(false)
const popoverStyle = ref({})
const query = ref('')
const selectedIndex = ref(0)
const shownMissingPaths = ref(new Set())
const hiddenMissingPaths = ref(new Set())

const monogram = computed(() => {
  const parts = String(props.workspaceName || 'Workspace').trim().split(/[^a-zA-Z0-9]+/).filter(Boolean)
  const mark = parts.length > 1
    ? parts.slice(0, 2).map(part => part[0]).join('')
    : parts[0]?.slice(0, 2)
  return String(mark || 'P').toUpperCase()
})

const otherWorkspaces = computed(() => props.recentWorkspaces.filter(
  workspace => (
    workspace?.path
    && !samePath(workspace.path, props.workspacePath)
    && !(workspace.missing && hiddenMissingPaths.value.has(normalizePath(workspace.path)))
  ),
))

const filteredWorkspaces = computed(() => {
  const term = query.value.trim().toLocaleLowerCase()
  const rows = otherWorkspaces.value
  if (!term) return rows.slice(0, DEFAULT_PROJECT_LIMIT)
  return rows
    .map((workspace, index) => ({ workspace, index }))
    .filter(({ workspace }) => projectSearchText(workspace).includes(term))
    .sort((left, right) => (
      projectMatchRank(left.workspace, term) - projectMatchRank(right.workspace, term)
      || left.index - right.index
    ))
    .map(({ workspace }) => workspace)
})

const options = computed(() => [
  ...filteredWorkspaces.value.map((workspace, index) => ({
    id: `project-switcher-option-${index}`,
    key: `project:${workspace.path}`,
    type: 'project',
    title: workspace.missing
      ? `${workspace.name || basename(workspace.path)} - not found`
      : workspace.name || basename(workspace.path),
    meta: parentPath(workspace.path),
    path: workspace.path,
    disabled: Boolean(workspace.missing),
  })),
  {
    id: `project-switcher-option-${filteredWorkspaces.value.length}`,
    key: 'project:open',
    type: 'open',
    title: 'Open workspace…',
    divider: true,
  },
  {
    id: `project-switcher-option-${filteredWorkspaces.value.length + 1}`,
    key: 'project:create',
    type: 'create',
    title: 'Create workspace…',
  },
])

const selectedOption = computed(() => options.value[selectedIndex.value] || null)

watch(
  () => options.value.map(option => `${option.key}:${option.disabled ? 'disabled' : 'enabled'}`).join('|'),
  () => {
    const bounded = Math.min(selectedIndex.value, Math.max(options.value.length - 1, 0))
    selectedIndex.value = options.value[bounded]?.disabled
      ? firstSelectableIndex()
      : bounded
  },
)

watch(
  () => props.recentWorkspaces
    .map(workspace => `${normalizePath(workspace?.path)}:${workspace?.missing ? 'missing' : 'available'}`)
    .join('|'),
  () => {
    const missing = currentMissingPaths()
    shownMissingPaths.value = retainedPaths(shownMissingPaths.value, missing)
    hiddenMissingPaths.value = retainedPaths(hiddenMissingPaths.value, missing)
    if (!popoverOpen.value) return
    const nextShown = new Set(shownMissingPaths.value)
    for (const path of missing) {
      if (!hiddenMissingPaths.value.has(path)) nextShown.add(path)
    }
    shownMissingPaths.value = nextShown
  },
)

function togglePopover() {
  if (popoverOpen.value) closePopover()
  else void openPopover()
}

async function openPopover() {
  if (popoverOpen.value) return
  advanceMissingNotices()
  query.value = ''
  selectedIndex.value = firstSelectableIndex()
  popoverOpen.value = true
  emit('reconcileWorkspaces')
  document.addEventListener('pointerdown', onPointerDown)
  window.addEventListener('resize', positionPopover)
  window.addEventListener('scroll', positionPopover, true)
  await nextTick()
  positionPopover()
  inputRef.value?.focus()
}

function advanceMissingNotices() {
  const missing = currentMissingPaths()
  const nextHidden = new Set(hiddenMissingPaths.value)
  const dismissed = []
  for (const path of shownMissingPaths.value) {
    if (!missing.has(path)) continue
    nextHidden.add(path)
    dismissed.push(path)
  }
  hiddenMissingPaths.value = nextHidden
  shownMissingPaths.value = new Set(
    [...missing].filter(path => !nextHidden.has(path)),
  )
  if (dismissed.length) emit('dismissMissingWorkspaces', dismissed)
}

function currentMissingPaths() {
  return new Set(
    props.recentWorkspaces
      .filter(workspace => (
        workspace?.missing
        && workspace.path
        && !samePath(workspace.path, props.workspacePath)
      ))
      .map(workspace => normalizePath(workspace.path)),
  )
}

function retainedPaths(paths, available) {
  return new Set([...paths].filter(path => available.has(path)))
}

function closePopover({ restoreFocus = false } = {}) {
  if (!popoverOpen.value) return
  popoverOpen.value = false
  document.removeEventListener('pointerdown', onPointerDown)
  window.removeEventListener('resize', positionPopover)
  window.removeEventListener('scroll', positionPopover, true)
  if (restoreFocus) nextTick(() => triggerRef.value?.focus())
}

function positionPopover() {
  const trigger = triggerRef.value
  const popover = popoverRef.value
  if (!trigger || !popover) return
  const rect = trigger.getBoundingClientRect()
  const width = Math.min(360, window.innerWidth - 16)
  const height = popover.getBoundingClientRect().height
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
  const top = Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - height - 8))
  popoverStyle.value = { left: `${left}px`, top: `${top}px`, width: `${width}px` }
}

function onPointerDown(event) {
  const target = event.target
  if (triggerRef.value?.contains(target) || popoverRef.value?.contains(target)) return
  closePopover()
}

function onInput() {
  selectedIndex.value = firstSelectableIndex()
  void scrollSelectionIntoView()
}

function selectIndex(index) {
  const bounded = Math.min(Math.max(index, 0), Math.max(options.value.length - 1, 0))
  if (!options.value[bounded]?.disabled) selectedIndex.value = bounded
}

function moveSelection(delta) {
  if (!options.value.length) return
  for (let step = 1; step <= options.value.length; step++) {
    const index = (selectedIndex.value + (delta * step) + options.value.length) % options.value.length
    if (options.value[index]?.disabled) continue
    selectedIndex.value = index
    break
  }
  void scrollSelectionIntoView()
}

function selectEdge(edge) {
  selectedIndex.value = firstSelectableIndex(edge)
  void scrollSelectionIntoView()
}

function firstSelectableIndex(edge = 'start') {
  if (edge === 'end') {
    for (let index = options.value.length - 1; index >= 0; index--) {
      if (!options.value[index]?.disabled) return index
    }
    return 0
  }
  const index = options.value.findIndex(option => !option.disabled)
  return index >= 0 ? index : 0
}

async function scrollSelectionIntoView() {
  await nextTick()
  popoverRef.value?.querySelector(`#${selectedOption.value?.id}`)
    ?.scrollIntoView?.({ block: 'nearest' })
}

function activateSelected() {
  if (selectedOption.value) activateOption(selectedOption.value)
}

function activateOption(option) {
  if (option.disabled) return
  closePopover()
  if (option.type === 'project') emit('openWorkspace', option.path)
  else if (option.type === 'open') emit('chooseWorkspace')
  else if (option.type === 'create') emit('createWorkspace')
}

function onPopoverKeydown(event) {
  if (event.key !== 'Escape') return
  event.preventDefault()
  event.stopPropagation()
  closePopover({ restoreFocus: true })
}

function projectSearchText(workspace) {
  return `${workspace?.name || ''} ${workspace?.path || ''}`.toLocaleLowerCase()
}

function projectMatchRank(workspace, term) {
  const name = String(workspace?.name || basename(workspace?.path)).toLocaleLowerCase()
  if (name === term) return 0
  if (name.startsWith(term)) return 1
  return 2
}

function basename(path) {
  return String(path || '').replaceAll('\\', '/').split('/').filter(Boolean).at(-1) || ''
}

function parentPath(path) {
  const normalized = String(path || '').replaceAll('\\', '/').replace(/\/+$/, '')
  const name = basename(normalized)
  return normalized.slice(0, Math.max(0, normalized.length - name.length)).replace(/\/$/, '') || '/'
}

function samePath(left, right) {
  return Boolean(left && right) && normalizePath(left) === normalizePath(right)
}

function normalizePath(value) {
  return String(value || '').replaceAll('\\', '/').replace(/\/+$/, '')
}

onUnmounted(() => closePopover())
</script>
