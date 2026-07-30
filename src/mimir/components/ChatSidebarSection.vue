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
        title="Chats"
        @click="$emit('selectChat', selectedTarget || preferredTarget)"
      >
        <span class="relative grid size-7 place-items-center">
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
  </section>
</template>

<script setup>
import { computed } from 'vue'
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

defineEmits(['selectChat', 'newChat', 'toggleCollapsed'])

const channels = computed(() => props.targets.filter(target => target.kind === 'channel'))
const directs = computed(() => props.targets.filter(target => target.kind === 'direct'))
const visibleTargets = computed(() => [...channels.value, ...directs.value])
const preferredTarget = computed(
  () => channels.value.find(target => target.id === '#general')?.id
    || props.targets[0]?.id
    || '',
)

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
</script>
