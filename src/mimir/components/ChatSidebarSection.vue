<template>
  <section
    data-sidebar-chats
    :aria-label="collapsed ? 'Chats' : undefined"
    @keydown="onSectionKeydown"
  >
    <div class="mx-3 my-2 h-px bg-rule" />

    <template v-if="collapsed">
      <SidebarRow
        data-sidebar-row="chat:hub"
        label="Chats"
        :collapsed="true"
        :active="active"
        :aria-expanded="railPopoverOpen"
        aria-haspopup="menu"
        aria-controls="chat-rail-switcher"
        title="Chats"
        @click="toggleRailPopover"
      >
        <span ref="railAnchorRef" class="relative grid size-7 place-items-center">
          <IconMessages :size="16" :stroke-width="1.8" />
          <span
            v-if="unreadTotal > 0"
            data-chat-unread-total
            class="absolute right-0 top-0 size-1.5 rounded-full bg-accent"
            role="img"
            :title="`${unreadTotal} unread chat messages`"
            :aria-label="`${unreadTotal} unread chat messages`"
          />
        </span>
      </SidebarRow>
    </template>

    <template v-else>
      <div data-sidebar-chats-header class="flex h-7 items-center px-3">
        <button
          type="button"
          data-chat-section-toggle
          :aria-expanded="!sectionCollapsed"
          title="Toggle Chats"
          class="flex h-6 min-w-0 flex-1 items-center gap-1 text-left font-mono text-[9px] uppercase tracking-[0.14em] text-ink-3 hover:bg-chrome-high hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          @click="$emit('toggleCollapsed')"
          @keydown.right.prevent="sectionCollapsed && $emit('toggleCollapsed')"
          @keydown.left.prevent="!sectionCollapsed && $emit('toggleCollapsed')"
        >
          <IconChevronRight v-if="sectionCollapsed" :size="12" :stroke-width="2" />
          <IconChevronDown v-else :size="12" :stroke-width="2" />
          <span>Chats</span>
          <span
            v-if="unreadTotal > 0"
            data-chat-unread-total
            class="ml-0.5 size-1.5 rounded-full bg-accent"
            role="img"
            :title="`${unreadTotal} unread chat messages`"
            :aria-label="`${unreadTotal} unread chat messages`"
          />
        </button>
        <button
          type="button"
          data-chat-add
          title="New channel or message"
          aria-label="New channel or message"
          class="grid size-6 place-items-center text-ink-3 hover:bg-chrome-high hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          @click="$emit('newChat')"
        >
          <IconPlus :size="13" :stroke-width="1.9" />
        </button>
      </div>

      <template v-if="!sectionCollapsed">
        <SidebarRow
          v-for="target in visibleTargets"
          :key="target.id"
          :data-sidebar-row="`chat:${target.id}`"
          data-chat-row
          :data-chat-kind="target.kind"
          :label="targetTitle(target)"
          :aria-label="targetAriaLabel(target)"
          :collapsed="false"
          :active="active && selectedTarget === target.id"
          :muted="target.muted"
          :title="targetTitleAttribute(target)"
          @click="$emit('selectChat', target.id)"
        >
          <span class="relative grid size-7 place-items-center text-ink-3">
            <IconHash
              v-if="target.kind === 'channel'"
              :size="15"
              :stroke-width="1.8"
            />
            <template v-else>
              <IconUser :size="14" :stroke-width="1.8" />
              <span
                v-if="memberFor(target)"
                data-chat-presence
                class="absolute bottom-[3px] right-[3px] size-2 rounded-full"
                :class="memberFor(target).away ? 'border border-ink-4 bg-transparent' : 'bg-add'"
                :title="memberFor(target).away ? memberFor(target).awayMessage || 'Away' : 'Available'"
                aria-hidden="true"
              />
            </template>
          </span>
          <template #label>
            <span :class="{ 'font-semibold text-ink': target.unreadCount > 0 }">
              {{ targetTitle(target) }}
            </span>
          </template>
          <template #trailing>
            <span
              v-if="target.unreadCount > 0"
              data-chat-unread-dot
              class="mr-1 block size-1.5 rounded-full bg-accent"
              role="img"
              :title="`${target.unreadCount} unread messages`"
              :aria-label="`${target.unreadCount} unread messages`"
            />
          </template>
        </SidebarRow>

        <button
          v-if="!visibleTargets.length"
          type="button"
          class="mx-3 mb-1 flex h-8 w-[calc(100%-24px)] items-center px-2 text-left text-[10px] text-ink-3 hover:bg-chrome-high hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          @click="$emit('newChat')"
        >
          Start a channel or message
        </button>
      </template>
    </template>

    <Teleport to="body">
      <div
        v-if="railPopoverOpen"
        id="chat-rail-switcher"
        ref="railPopoverRef"
        data-chat-rail-switcher
        role="menu"
        aria-label="Switch chat"
        class="fixed z-[220] flex max-h-[min(420px,calc(100vh-16px))] w-[248px] max-w-[calc(100vw-16px)] flex-col overflow-hidden border border-rule bg-surface shadow-lg"
        :style="railPopoverStyle"
        @keydown="onRailPopoverKeydown"
      >
        <div class="flex h-8 shrink-0 items-center border-b border-rule px-3">
          <span class="font-mono text-[9px] uppercase tracking-[0.14em] text-ink-3">
            Chats
          </span>
        </div>

        <div class="min-h-0 overflow-y-auto p-1">
          <button
            v-for="target in visibleTargets"
            :key="target.id"
            type="button"
            data-chat-rail-target
            :data-chat-target="target.id"
            role="menuitemradio"
            :aria-checked="selectedTarget === target.id"
            :aria-label="targetAriaLabel(target)"
            :title="targetTitleAttribute(target)"
            class="flex h-8 w-full min-w-0 items-center px-2 text-left text-ink-2 hover:bg-chrome-high hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
            :class="{
              'bg-accent-soft text-ink': selectedTarget === target.id,
              'text-ink-4': target.muted && selectedTarget !== target.id,
            }"
            @click="selectRailTarget(target.id)"
          >
            <span class="relative grid size-7 shrink-0 place-items-center text-ink-3">
              <IconHash
                v-if="target.kind === 'channel'"
                :size="15"
                :stroke-width="1.8"
              />
              <template v-else>
                <IconUser :size="14" :stroke-width="1.8" />
                <span
                  v-if="memberFor(target)"
                  class="absolute bottom-[3px] right-[3px] size-2 rounded-full"
                  :class="memberFor(target).away ? 'border border-ink-4 bg-transparent' : 'bg-add'"
                  :title="memberFor(target).away ? memberFor(target).awayMessage || 'Away' : 'Available'"
                  aria-hidden="true"
                />
              </template>
            </span>
            <span
              class="ml-1 min-w-0 flex-1 truncate text-[11px] font-medium"
              :class="{ 'font-semibold text-ink': target.unreadCount > 0 }"
            >
              {{ targetTitle(target) }}
            </span>
            <span
              v-if="target.unreadCount > 0"
              data-chat-rail-unread
              class="ml-2 mr-1 size-1.5 shrink-0 rounded-full bg-accent"
              role="img"
              :title="`${target.unreadCount} unread messages`"
              :aria-label="`${target.unreadCount} unread messages`"
            />
          </button>

          <div
            v-if="!visibleTargets.length"
            data-chat-rail-empty
            class="px-2.5 py-3 text-[10px] text-ink-3"
            role="status"
          >
            No chats yet.
          </div>
        </div>

        <button
          type="button"
          data-chat-rail-new
          role="menuitem"
          class="flex h-9 w-full shrink-0 items-center border-t border-rule px-3 text-left text-[11px] font-medium text-ink-2 hover:bg-chrome-high hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
          @click="startNewChat"
        >
          <IconPlus :size="14" :stroke-width="1.8" class="mr-2 shrink-0 text-ink-3" />
          New channel or message
        </button>
      </div>
    </Teleport>
  </section>
</template>

<script setup>
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import {
  IconChevronDown,
  IconChevronRight,
  IconHash,
  IconMessages,
  IconPlus,
  IconUser,
} from '@tabler/icons-vue'
import SidebarRow from './SidebarRow.vue'

const props = defineProps({
  collapsed: { type: Boolean, default: false },
  sectionCollapsed: { type: Boolean, default: false },
  targets: { type: Array, default: () => [] },
  members: { type: Array, default: () => [] },
  selectedTarget: { type: String, default: '' },
  active: { type: Boolean, default: false },
  unreadTotal: { type: Number, default: 0 },
})

const emit = defineEmits(['selectChat', 'newChat', 'toggleCollapsed'])

const railAnchorRef = ref(null)
const railPopoverRef = ref(null)
const railPopoverOpen = ref(false)
const railPopoverStyle = ref({})
let railTabCloseTimer = null

const channels = computed(() => props.targets.filter(target => target.kind === 'channel'))
const directs = computed(() => props.targets.filter(target => target.kind === 'direct'))
const visibleTargets = computed(() => [...channels.value, ...directs.value])
const preferredTarget = computed(
  () => channels.value.find(target => target.id === '#general')?.id
    || props.targets[0]?.id
    || '',
)

watch(
  () => props.collapsed,
  collapsed => {
    if (!collapsed) closeRailPopover()
  },
)

function toggleRailPopover() {
  if (railPopoverOpen.value) {
    closeRailPopover()
    return
  }
  const target = props.selectedTarget || preferredTarget.value
  if (!props.active && target) emit('selectChat', target, { focus: false })
  void openRailPopover()
}

async function openRailPopover() {
  if (railPopoverOpen.value || !props.collapsed) return
  railPopoverOpen.value = true
  document.addEventListener('pointerdown', onRailPointerDown)
  window.addEventListener('resize', positionRailPopover)
  window.addEventListener('scroll', positionRailPopover, true)
  await nextTick()
  positionRailPopover()
  focusPreferredRailItem()
}

function closeRailPopover({ restoreFocus = false } = {}) {
  if (railTabCloseTimer !== null) {
    clearTimeout(railTabCloseTimer)
    railTabCloseTimer = null
  }
  if (!railPopoverOpen.value) return
  railPopoverOpen.value = false
  document.removeEventListener('pointerdown', onRailPointerDown)
  window.removeEventListener('resize', positionRailPopover)
  window.removeEventListener('scroll', positionRailPopover, true)
  if (restoreFocus) nextTick(() => railTrigger()?.focus())
}

function railTrigger() {
  return railAnchorRef.value?.closest('button') || null
}

function positionRailPopover() {
  const trigger = railTrigger()
  const popover = railPopoverRef.value
  if (!trigger || !popover) return
  const rect = trigger.getBoundingClientRect()
  const width = Math.min(248, window.innerWidth - 16)
  const height = popover.getBoundingClientRect().height
  const left = Math.max(8, Math.min(rect.right + 4, window.innerWidth - width - 8))
  const top = Math.max(8, Math.min(rect.top, window.innerHeight - height - 8))
  railPopoverStyle.value = { left: `${left}px`, top: `${top}px`, width: `${width}px` }
}

function railMenuItems() {
  return Array.from(railPopoverRef.value?.querySelectorAll('[role^="menuitem"]') || [])
}

function focusPreferredRailItem() {
  const items = railMenuItems()
  const selected = items.find(item => item.dataset.chatTarget === props.selectedTarget)
  const preferred = selected || items[0]
  preferred?.focus()
}

function selectRailTarget(target) {
  closeRailPopover()
  emit('selectChat', target)
}

function startNewChat() {
  closeRailPopover()
  emit('newChat')
}

function onRailPointerDown(event) {
  if (railTrigger()?.contains(event.target) || railPopoverRef.value?.contains(event.target)) return
  closeRailPopover()
}

function onRailPopoverKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    closeRailPopover({ restoreFocus: true })
    return
  }
  if (event.key === 'Tab') {
    if (railTabCloseTimer !== null) clearTimeout(railTabCloseTimer)
    railTabCloseTimer = setTimeout(() => {
      railTabCloseTimer = null
      closeRailPopover()
    }, 0)
    return
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  const items = railMenuItems()
  if (!items.length) return
  event.preventDefault()
  const current = items.indexOf(document.activeElement)
  let index = current
  if (event.key === 'Home') index = 0
  else if (event.key === 'End') index = items.length - 1
  else {
    const delta = event.key === 'ArrowDown' ? 1 : -1
    index = (Math.max(current, 0) + delta + items.length) % items.length
  }
  items[index]?.focus()
}

function memberFor(target) {
  if (target.kind !== 'direct') return null
  const key = target.id?.toLowerCase()
  return props.members.find(candidate => (
    candidate.nick?.toLowerCase() === key
      || candidate.account?.toLowerCase() === key
  )) || null
}

function directTitle(target) {
  return memberFor(target)?.displayName || target.title || target.id
}

function targetTitle(target) {
  return target.kind === 'direct' ? directTitle(target) : target.title
}

function targetTitleAttribute(target) {
  return target.kind === 'direct'
    ? `Message ${directTitle(target)}`
    : target.topic || target.id
}

function targetAriaLabel(target) {
  const title = targetTitle(target)
  const unread = Math.max(0, Number(target.unreadCount) || 0)
  return unread > 0
    ? `${title}, ${unread} unread ${unread === 1 ? 'message' : 'messages'}`
    : title
}

function onSectionKeydown(event) {
  if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return
  const rows = Array.from(
    event.currentTarget.querySelectorAll('[data-chat-row] > button'),
  )
  const index = rows.indexOf(event.target.closest('button'))
  if (index < 0) return
  event.preventDefault()
  const delta = event.key === 'ArrowDown' ? 1 : -1
  rows[(index + delta + rows.length) % rows.length]?.focus()
}

onUnmounted(() => closeRailPopover())
</script>
