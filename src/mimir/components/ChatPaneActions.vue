<template>
  <div class="relative flex items-center">
    <button
      type="button"
      data-chat-action="search"
      title="Search chat (⌘F)"
      aria-label="Search chat"
      class="chat-pane-action"
      :disabled="!chat.activeTarget"
      @click="chat.openSearch()"
    >
      <IconSearch :size="15" :stroke-width="1.8" />
    </button>
    <button
      ref="agentButton"
      type="button"
      data-chat-action="agent"
      :title="agents.length ? 'Start an agent in this chat' : 'No agent launcher is configured'"
      aria-label="Start an agent in this chat"
      aria-haspopup="menu"
      :aria-expanded="agentMenuOpen"
      class="chat-pane-action gap-1.5 px-1.5"
      :disabled="!chat.activeTarget || !agents.length"
      @click="toggleAgentMenu"
      @keydown.down.prevent="openAgentMenu"
    >
      <IconRobot :size="15" :stroke-width="1.8" />
      <span class="chat-agent-label text-[10px] font-medium">Start agent</span>
    </button>
    <div
      v-if="agentMenuOpen"
      ref="agentMenu"
      data-chat-agent-menu
      class="absolute right-7 top-8 z-50 w-52 border border-rule bg-surface p-1 shadow-lg"
      role="menu"
      aria-label="Choose an agent"
      @keydown="onAgentMenuKeydown"
    >
      <button
        v-for="agent in agents"
        :key="agent.id"
        type="button"
        class="chat-menu-item"
        :class="{ 'cursor-not-allowed opacity-40': agent.available === false }"
        role="menuitem"
        tabindex="-1"
        :disabled="agent.available === false"
        :title="agent.available === false ? agent.unavailableReason : agent.title"
        @click="startAgent(agent.id)"
      >
        <IconRobot :size="13" />
        <span class="min-w-0 flex-1 truncate">{{ agent.title }}</span>
        <span v-if="agent.available === false" class="font-mono text-[8px] text-ink-4">missing</span>
      </button>
    </div>
    <button
      ref="menuButton"
      type="button"
      data-chat-action="details"
      title="Chat details and actions"
      aria-label="Chat details and actions"
      aria-haspopup="dialog"
      :aria-expanded="menuOpen"
      class="chat-pane-action"
      :disabled="!chat.activeRecord"
      @click="toggleMenu"
      @keydown.down.prevent="openMenu"
    >
      <IconDots :size="16" :stroke-width="1.8" />
    </button>

    <div
      v-if="menuOpen"
      ref="menu"
      data-chat-details-menu
      class="absolute right-0 top-8 z-50 w-64 border border-rule bg-surface p-1 shadow-lg"
      role="dialog"
      aria-label="Chat details"
      @keydown="onMenuKeydown"
    >
      <div class="px-2 pb-2 pt-1.5">
        <div class="truncate text-[11px] font-semibold text-ink">{{ targetTitle }}</div>
        <p
          v-if="chat.activeRecord?.topic && !editingTopic"
          class="mt-1 text-[10px] leading-relaxed text-ink-2"
        >
          {{ chat.activeRecord.topic }}
        </p>
        <form
          v-if="editingTopic"
          class="mt-1.5"
          @submit.prevent="saveTopic"
          @keydown.stop
        >
          <label for="chat-topic" class="sr-only">Channel topic</label>
          <input
            id="chat-topic"
            ref="topicInput"
            v-model="topicDraft"
            maxlength="300"
            autocorrect="off"
            autocapitalize="off"
            placeholder="What is this channel for?"
            class="h-7 w-full border border-rule bg-canvas px-1.5 text-[10px] text-ink outline-none focus:border-accent"
          />
          <div class="mt-1 flex items-center justify-end gap-1">
            <button type="button" class="chat-topic-button" @click="editingTopic = false">Cancel</button>
            <button type="submit" class="chat-topic-button text-accent" :disabled="topicSaving">
              {{ topicSaving ? 'Saving…' : 'Save' }}
            </button>
          </div>
        </form>
        <p v-if="menuError" class="mt-1.5 text-[9px] leading-snug text-rem">{{ menuError }}</p>
        <p v-if="chat.activeRecord?.kind === 'channel'" class="mt-1 font-mono text-[9px] uppercase tracking-[0.08em] text-ink-4">
          {{ chat.activeRecord.memberCount }} {{ chat.activeRecord.memberCount === 1 ? 'member' : 'members' }}
        </p>
        <div
          v-if="chat.activeRecord?.kind === 'channel' && visibleMembers.length"
          class="mt-2 max-h-32 overflow-y-auto border-t border-rule-light pt-1.5"
          aria-label="Channel members"
        >
          <div
            v-for="member in visibleMembers"
            :key="member.account || member.nick"
            class="flex h-6 min-w-0 items-center gap-1.5 text-[10px]"
          >
            <span
              class="size-2 shrink-0 rounded-full"
              :class="member.away ? 'border border-ink-4 bg-transparent' : 'bg-add'"
              :title="member.away ? member.awayMessage || 'Away' : 'Available'"
              aria-hidden="true"
            />
            <span class="min-w-0 flex-1 truncate text-ink-2">{{ member.displayName || member.nick }}</span>
            <span v-if="member.away" class="text-[9px] text-ink-4">away</span>
            <span
              v-if="member.account && member.account !== member.displayName"
              class="max-w-20 truncate font-mono text-[9px] text-ink-4"
            >
              {{ member.account }}
            </span>
          </div>
        </div>
      </div>
      <div class="h-px bg-rule-light" role="separator" />
      <button class="chat-menu-item" role="menuitem" tabindex="-1" @click="toggleMuted">
        <IconBellOff v-if="!chat.activeRecord?.muted" :size="13" />
        <IconBell v-else :size="13" />
        {{ chat.activeRecord?.muted ? 'Unmute chat' : 'Mute chat' }}
      </button>
      <button
        v-if="chat.activeRecord?.kind === 'channel'"
        class="chat-menu-item"
        role="menuitem"
        tabindex="-1"
        @click="beginTopicEdit"
      >
        <IconPencil :size="13" />
        Edit topic
      </button>
      <button
        v-if="chat.activeRecord?.kind === 'direct'"
        class="chat-menu-item"
        role="menuitem"
        tabindex="-1"
        @click="closeDirect"
      >
        <IconX :size="13" />
        Close conversation
      </button>
      <button
        v-else-if="chat.activeTarget !== '#general'"
        class="chat-menu-item text-rem"
        role="menuitem"
        tabindex="-1"
        @click="leaveChannel"
      >
        <IconLogout :size="13" />
        Leave channel
      </button>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import {
  IconBell,
  IconBellOff,
  IconDots,
  IconLogout,
  IconPencil,
  IconRobot,
  IconSearch,
  IconX,
} from '@tabler/icons-vue'
import { useChatStore } from '../../stores/chat.js'

const props = defineProps({
  agents: { type: Array, default: () => [] },
})

const emit = defineEmits(['startAgent'])

const chat = useChatStore()
const menuOpen = ref(false)
const agentMenuOpen = ref(false)
const menuButton = ref(null)
const menu = ref(null)
const agentButton = ref(null)
const agentMenu = ref(null)
const topicInput = ref(null)
const editingTopic = ref(false)
const topicDraft = ref('')
const topicSaving = ref(false)
const menuError = ref('')
const agents = computed(() => props.agents)
const visibleMembers = computed(
  () => (chat.membersByTarget[chat.activeTarget] || []).slice(0, 20),
)
const targetTitle = computed(() => (
  chat.activeRecord?.kind === 'channel'
    ? chat.activeTarget
    : chat.activeRecord?.title || chat.activeTarget
))

onMounted(() => document.addEventListener('pointerdown', closeFromOutside))
onUnmounted(() => document.removeEventListener('pointerdown', closeFromOutside))

async function toggleMenu() {
  closeAgentMenu()
  if (menuOpen.value) return closeMenu()
  await openMenu()
}

async function toggleAgentMenu() {
  if (agentMenuOpen.value) return closeAgentMenu({ restore: true })
  await openAgentMenu()
}

async function openAgentMenu() {
  menuOpen.value = false
  agentMenuOpen.value = true
  await nextTick()
  agentMenu.value?.querySelector('[role="menuitem"]:not(:disabled)')?.focus()
}

function closeAgentMenu({ restore = false } = {}) {
  agentMenuOpen.value = false
  if (restore) nextTick(() => agentButton.value?.focus())
}

async function openMenu() {
  editingTopic.value = false
  menuError.value = ''
  menuOpen.value = true
  if (chat.activeRecord?.kind === 'channel') {
    try {
      await chat.refreshMembers(chat.activeTarget)
    } catch (cause) {
      menuError.value = errorMessage(cause)
    }
  }
  await nextTick()
  menu.value?.querySelector('[role="menuitem"]')?.focus()
}

function closeMenu({ restore = false } = {}) {
  menuOpen.value = false
  editingTopic.value = false
  menuError.value = ''
  if (restore) nextTick(() => menuButton.value?.focus())
}

function closeFromOutside(event) {
  if (
    menuOpen.value
    && !event.target.closest('[data-chat-details-menu], [data-chat-action="details"]')
  ) {
    closeMenu()
  }
  if (
    agentMenuOpen.value
    && !event.target.closest('[data-chat-agent-menu], [data-chat-action="agent"]')
  ) {
    closeAgentMenu()
  }
}

function onAgentMenuKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault()
    closeAgentMenu({ restore: true })
    return
  }
  if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return
  event.preventDefault()
  const items = [...agentMenu.value.querySelectorAll('[role="menuitem"]:not(:disabled)')]
  const index = items.indexOf(document.activeElement)
  const delta = event.key === 'ArrowDown' ? 1 : -1
  items[(index + delta + items.length) % items.length]?.focus()
}

function startAgent(id) {
  closeAgentMenu()
  emit('startAgent', id)
}

function onMenuKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault()
    closeMenu({ restore: true })
    return
  }
  if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return
  event.preventDefault()
  const items = [...menu.value.querySelectorAll('[role="menuitem"]:not(:disabled)')]
  const index = items.indexOf(document.activeElement)
  const delta = event.key === 'ArrowDown' ? 1 : -1
  items[(index + delta + items.length) % items.length]?.focus()
}

async function toggleMuted() {
  await runMenuAction(
    () => chat.setMuted(chat.activeTarget, !chat.activeRecord.muted),
  )
}

async function beginTopicEdit() {
  topicDraft.value = chat.activeRecord?.topic || ''
  menuError.value = ''
  editingTopic.value = true
  await nextTick()
  topicInput.value?.focus()
  topicInput.value?.select()
}

async function saveTopic() {
  if (topicSaving.value) return
  topicSaving.value = true
  menuError.value = ''
  try {
    await chat.setTopic(chat.activeTarget, topicDraft.value.trim())
    editingTopic.value = false
    await chat.refreshTargets()
  } catch (cause) {
    menuError.value = errorMessage(cause)
  } finally {
    topicSaving.value = false
  }
}

async function closeDirect() {
  await runMenuAction(() => chat.closeDirect(chat.activeTarget))
}

async function leaveChannel() {
  await runMenuAction(() => chat.leaveChannel(chat.activeTarget))
}

async function runMenuAction(action) {
  menuError.value = ''
  try {
    await action()
    closeMenu({ restore: true })
  } catch (cause) {
    menuError.value = errorMessage(cause)
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || 'Chat action failed.')
}
</script>

<style scoped>
.chat-pane-action {
  display: flex;
  min-width: 1.75rem;
  height: 1.75rem;
  align-items: center;
  justify-content: center;
  color: var(--color-ink-3);
}

.chat-pane-action:hover:not(:disabled) {
  background: var(--color-chrome);
  color: var(--color-ink);
}

.chat-pane-action:focus-visible {
  outline: none;
  box-shadow: 0 0 0 1px var(--color-accent);
}

.chat-pane-action:disabled {
  opacity: 0.3;
}

.chat-menu-item {
  display: flex;
  width: 100%;
  height: 1.875rem;
  align-items: center;
  gap: 0.5rem;
  padding: 0 0.5rem;
  text-align: left;
  font-size: 10px;
  color: var(--color-ink-2);
}

.chat-menu-item:hover,
.chat-menu-item:focus-visible {
  outline: none;
  background: var(--color-chrome-mid);
  color: var(--color-ink);
}

.chat-topic-button {
  height: 1.5rem;
  padding: 0 0.375rem;
  font-size: 9px;
}

.chat-topic-button:hover:not(:disabled),
.chat-topic-button:focus-visible {
  outline: none;
  background: var(--color-chrome-mid);
}

.chat-topic-button:disabled {
  opacity: 0.5;
}

@media (max-width: 1100px) {
  .chat-agent-label {
    display: none;
  }
}
</style>
