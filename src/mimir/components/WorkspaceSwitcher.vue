<template>
  <div class="shrink-0 border-b border-rule">
    <button
      ref="triggerRef"
      type="button"
      data-sidebar-workspace
      class="no-drag group flex h-11 w-full min-w-0 items-center text-left hover:bg-chrome-mid focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
      :aria-label="workspacePath ? `Switch project: ${workspaceName}` : 'Open project folder'"
      :aria-expanded="menuOpen"
      aria-haspopup="menu"
      :title="workspacePath || 'Open project folder'"
      @click.stop="toggleMenu"
      @keydown.down.prevent="openMenu"
    >
      <span class="ml-3 grid size-7 shrink-0 place-items-center border border-rule-light bg-chrome-mid font-sans text-[10px] font-semibold uppercase text-ink-2 group-hover:border-rule">
        {{ monogram }}
      </span>
      <span v-if="!collapsed" class="ml-2 min-w-0 flex-1">
        <span class="block truncate text-[12px] font-semibold text-ink">
          {{ workspaceName || 'Open project' }}
        </span>
        <span class="block truncate font-mono text-[9px] text-ink-3">
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
        v-if="menuOpen"
        ref="menuRef"
        data-project-switcher-menu
        role="menu"
        aria-label="Projects"
        class="fixed z-[220] w-[320px] max-w-[calc(100vw-16px)] overflow-hidden border border-rule bg-surface p-1 shadow-lg"
        :style="menuStyle"
        @keydown="onMenuKeydown"
      >
        <div v-if="workspacePath" class="border-b border-rule-light px-2.5 pb-2 pt-1.5">
          <div class="font-sans text-[9px] font-semibold uppercase tracking-[0.12em] text-ink-4">
            Current project
          </div>
          <div class="mt-1 flex min-w-0 items-center gap-2">
            <span class="grid size-6 shrink-0 place-items-center bg-accent-soft font-sans text-[9px] font-semibold uppercase text-accent">
              {{ monogram }}
            </span>
            <span class="min-w-0 flex-1">
              <span class="block truncate font-sans text-[11px] font-semibold text-ink">{{ workspaceName }}</span>
              <span class="block truncate font-mono text-[9px] text-ink-3">{{ workspacePath }}</span>
            </span>
            <IconCheck :size="14" :stroke-width="2" class="shrink-0 text-accent" />
          </div>
        </div>

        <template v-if="otherWorkspaces.length">
          <div class="px-2.5 pb-1 pt-2 font-sans text-[9px] font-semibold uppercase tracking-[0.12em] text-ink-4">
            Recent projects
          </div>
          <button
            v-for="workspace in otherWorkspaces"
            :key="workspace.path"
            type="button"
            data-project-menu-item
            role="menuitem"
            class="flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left hover:bg-chrome-high focus:bg-chrome-high focus:outline-none"
            :title="workspace.path"
            @click="openRecent(workspace.path)"
          >
            <IconHistory :size="13" :stroke-width="1.8" class="shrink-0 text-ink-3" />
            <span class="min-w-0 flex-1">
              <span class="block truncate font-sans text-[11px] text-ink-2">{{ workspace.name }}</span>
              <span
                data-project-activity-summary
                class="block truncate font-mono text-[9px] text-ink-4"
              >
                {{ workspaceDetail(workspace) }}
              </span>
            </span>
          </button>
          <div class="my-1 border-t border-rule-light" />
        </template>

        <button
          type="button"
          data-project-menu-item
          data-project-open-folder
          role="menuitem"
          class="flex w-full items-center gap-2 px-2.5 py-2 text-left font-sans text-[11px] font-medium text-ink-2 hover:bg-chrome-high hover:text-ink focus:bg-chrome-high focus:outline-none"
          @click="chooseFolder"
        >
          <IconFolderOpen :size="14" :stroke-width="1.8" class="shrink-0" />
          <span>{{ workspacePath ? 'Open another folder…' : 'Open project folder…' }}</span>
        </button>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { computed, nextTick, onUnmounted, ref } from 'vue'
import {
  IconCheck,
  IconChevronDown,
  IconFolderOpen,
  IconHistory,
} from '@tabler/icons-vue'

const props = defineProps({
  collapsed: { type: Boolean, default: false },
  workspaceName: { type: String, default: '' },
  workspacePath: { type: String, default: '' },
  recentWorkspaces: { type: Array, default: () => [] },
})

const emit = defineEmits(['chooseWorkspace', 'openWorkspace'])
const triggerRef = ref(null)
const menuRef = ref(null)
const menuOpen = ref(false)
const menuStyle = ref({})

const monogram = computed(() => {
  const parts = String(props.workspaceName || 'Project').trim().split(/[^a-zA-Z0-9]+/).filter(Boolean)
  const mark = parts.length > 1
    ? parts.slice(0, 2).map(part => part[0]).join('')
    : parts[0]?.slice(0, 2)
  return String(mark || 'P').toUpperCase()
})
const otherWorkspaces = computed(() => props.recentWorkspaces.filter(
  workspace => workspace?.path && workspace.path !== props.workspacePath,
))

function toggleMenu() {
  if (menuOpen.value) closeMenu()
  else openMenu()
}

async function openMenu() {
  if (menuOpen.value) return
  menuOpen.value = true
  document.addEventListener('pointerdown', onPointerDown)
  window.addEventListener('resize', positionMenu)
  window.addEventListener('scroll', positionMenu, true)
  await nextTick()
  positionMenu()
  menuItems()[0]?.focus()
}

function closeMenu({ restoreFocus = false } = {}) {
  if (!menuOpen.value) return
  menuOpen.value = false
  document.removeEventListener('pointerdown', onPointerDown)
  window.removeEventListener('resize', positionMenu)
  window.removeEventListener('scroll', positionMenu, true)
  if (restoreFocus) nextTick(() => triggerRef.value?.focus())
}

function positionMenu() {
  const trigger = triggerRef.value
  if (!trigger) return
  const rect = trigger.getBoundingClientRect()
  const width = Math.min(320, window.innerWidth - 16)
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
  menuStyle.value = {
    left: `${left}px`,
    top: `${Math.min(rect.bottom + 4, window.innerHeight - 12)}px`,
    width: `${width}px`,
  }
}

function onPointerDown(event) {
  const target = event.target
  if (triggerRef.value?.contains(target) || menuRef.value?.contains(target)) return
  closeMenu()
}

function menuItems() {
  return Array.from(menuRef.value?.querySelectorAll('[data-project-menu-item]') || [])
}

function onMenuKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault()
    closeMenu({ restoreFocus: true })
    return
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const items = menuItems()
  if (!items.length) return
  let index = items.indexOf(document.activeElement)
  if (event.key === 'Home') index = 0
  else if (event.key === 'End') index = items.length - 1
  else {
    const delta = event.key === 'ArrowDown' ? 1 : -1
    index = (Math.max(index, 0) + delta + items.length) % items.length
  }
  items[index]?.focus()
}

function chooseFolder() {
  closeMenu()
  emit('chooseWorkspace')
}

function openRecent(path) {
  closeMenu()
  emit('openWorkspace', path)
}

function workspaceDetail(workspace) {
  const count = Math.max(0, Number(workspace?.activityCount) || 0)
  const needsInput = Math.max(0, Number(workspace?.needsInputCount) || 0)
  const activity = needsInput
    ? `${needsInput} needs input`
    : count
      ? `${count} ${count === 1 ? 'Activity' : 'Activities'}`
      : ''
  return [activity, workspace?.path].filter(Boolean).join(' · ')
}

onUnmounted(() => closeMenu())
</script>
