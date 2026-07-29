<template>
  <section class="font-sans text-ink" aria-label="Chat settings">
    <div class="flex items-start justify-between gap-4">
      <div>
        <h2 class="section-title mb-0">Team chat</h2>
        <p class="mt-1 text-[10px] leading-relaxed text-ink-3">
          One shared transcript for a small team. Your passphrase stays in the system keychain.
        </p>
      </div>
      <span class="chat-status" :class="statusClass">
        <span class="size-1.5 rounded-full" :class="statusDotClass" />
        {{ statusLabel }}
      </span>
    </div>

    <div class="chat-setting-row mt-4 border-y border-rule-light">
      <span>
        <strong>Show Chats</strong>
        <small>Turn off to remove Chats, disconnect, and hide its agent tools. Cached history stays local.</small>
      </span>
      <button
        type="button"
        data-chat-enabled-toggle
        class="chat-notification-toggle"
        :aria-pressed="chat.config.enabled"
        :disabled="busy"
        @click="toggleChatEnabled"
      >
        {{ chat.config.enabled ? 'On' : 'Off' }}
      </button>
    </div>

    <form
      v-if="chat.config.enabled"
      class="mt-5 divide-y divide-rule-light border-y border-rule-light"
      @submit.prevent="save"
    >
      <label class="chat-setting-row">
        <span>
          <strong>Display name</strong>
          <small>The human-readable name teammates see.</small>
        </span>
        <input v-model="form.displayName" autocomplete="name" />
      </label>
      <label class="chat-setting-row">
        <span>
          <strong>Account</strong>
          <small>Your stable team login and direct-message address.</small>
        </span>
        <input v-model="form.account" autocomplete="username" autocapitalize="none" spellcheck="false" />
      </label>
      <label class="chat-setting-row">
        <span>
          <strong>Replace passphrase</strong>
          <small>Leave blank to keep the passphrase already in Keychain.</small>
        </span>
        <input
          v-model="form.password"
          type="password"
          autocomplete="new-password"
          placeholder="Keep existing"
        />
      </label>
      <div class="chat-setting-row">
        <span>
          <strong>Focused notifications</strong>
          <small>Alert only for direct messages and @mentions. Muted chats stay quiet.</small>
        </span>
        <button
          type="button"
          class="chat-notification-toggle"
          :aria-pressed="notificationsOn"
          @click="toggleNotifications"
        >
          {{ notificationsOn ? 'On' : 'Enable' }}
        </button>
      </div>

      <details class="py-3">
        <summary class="text-[10px] font-medium text-ink-2 hover:text-ink">Advanced server</summary>
        <label class="mt-3 block">
          <span class="font-mono text-[8px] uppercase tracking-[0.08em] text-ink-3">WebSocket URL</span>
          <input
            v-model="form.endpoint"
            class="mt-1 h-8 w-full border border-rule bg-surface px-2 font-mono text-[9px] text-ink-2 outline-none focus:border-accent"
            autocapitalize="none"
            spellcheck="false"
          />
        </label>
        <p v-if="chat.status.diagnostic" class="mt-3 break-words font-mono text-[8px] leading-relaxed text-ink-4">
          {{ chat.status.diagnostic }}
        </p>
      </details>
    </form>

    <div v-if="chat.config.enabled" class="mt-4 flex items-center gap-2">
      <button
        type="submit"
        class="chat-settings-primary"
        :disabled="busy"
        @click="save"
      >
        {{ busy ? 'Saving…' : 'Save and reconnect' }}
      </button>
      <button
        type="button"
        class="chat-settings-secondary"
        :disabled="busy"
        @click="reconnect"
      >
        Reconnect
      </button>
    </div>

    <p v-if="notice" class="mt-3 text-[10px] text-add" role="status">{{ notice }}</p>
    <p v-if="error" class="mt-3 text-[10px] leading-relaxed text-rem" role="alert">{{ error }}</p>
  </section>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useChatStore } from '../../../stores/chat.js'
import { useSettingsStore } from '../../../stores/settings.js'
import {
  chatNotificationPermission,
  requestChatNotificationPermission,
} from '../../../services/chatNotifications.js'

const chat = useChatStore()
const settings = useSettingsStore()
const form = reactive({
  displayName: chat.config.displayName,
  account: chat.config.account,
  endpoint: chat.config.endpoint,
  password: '',
})
const busy = ref(false)
const notice = ref('')
const error = ref('')
const notificationPermission = ref('unknown')
const notificationsOn = computed(() => (
  settings.chatNotifications && notificationPermission.value === 'granted'
))
const statusLabel = computed(() => (
  !chat.config.enabled
    ? 'Disabled'
    : {
      needs_credentials: 'Needs passphrase',
      disconnected: 'Offline',
      connecting: 'Connecting',
      connected: 'Connected',
      reconnecting: 'Reconnecting',
      error: 'Connection error',
    }[chat.status.state] || 'Unavailable'
))
const statusClass = computed(() => (
  chat.status.state === 'connected' ? 'text-add' : 'text-ink-3'
))
const statusDotClass = computed(() => (
  chat.status.state === 'connected'
    ? 'bg-add'
    : chat.status.state === 'error'
      ? 'bg-rem'
      : 'bg-ink-4'
))

async function toggleChatEnabled() {
  busy.value = true
  notice.value = ''
  error.value = ''
  const enabled = !chat.config.enabled
  try {
    await chat.setEnabled(enabled)
    notice.value = enabled
      ? 'Chats is on and reconnecting.'
      : 'Chats is off. Cached history remains on this Mac.'
  } catch (cause) {
    error.value = errorMessage(cause)
  } finally {
    busy.value = false
  }
}

watch(
  () => chat.config,
  value => {
    form.displayName = value.displayName
    form.account = value.account
    form.endpoint = value.endpoint
  },
  { deep: true },
)

onMounted(() => {
  void chat.initialize()
  void chatNotificationPermission().then(value => {
    notificationPermission.value = value
  })
})

async function toggleNotifications() {
  error.value = ''
  notice.value = ''
  if (notificationsOn.value) {
    settings.set('chatNotifications', false)
    notice.value = 'Focused chat notifications are off.'
    return
  }
  const permission = await requestChatNotificationPermission()
  notificationPermission.value = permission
  if (permission === 'granted') {
    settings.set('chatNotifications', true)
    notice.value = 'Focused chat notifications are on.'
  } else if (permission === 'unsupported') {
    error.value = 'Desktop notifications are unavailable in this environment.'
  } else {
    settings.set('chatNotifications', false)
    error.value = 'Notifications were not allowed in system settings.'
  }
}

async function save() {
  busy.value = true
  notice.value = ''
  error.value = ''
  try {
    await chat.updateConfig({
      displayName: form.displayName.trim(),
      account: form.account.trim(),
      endpoint: form.endpoint.trim(),
      password: form.password,
    })
    form.password = ''
    notice.value = 'Chat settings saved. Reconnecting now.'
  } catch (cause) {
    error.value = errorMessage(cause)
  } finally {
    busy.value = false
  }
}

async function reconnect() {
  busy.value = true
  notice.value = ''
  error.value = ''
  try {
    await chat.reconnect()
    notice.value = 'Reconnecting to team chat.'
  } catch (cause) {
    error.value = errorMessage(cause)
  } finally {
    busy.value = false
  }
}

function errorMessage(cause) {
  return cause instanceof Error ? cause.message : String(cause || 'Chat settings could not be saved.')
}
</script>

<style scoped>
.chat-status {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 0.375rem;
  border: 1px solid var(--color-rule-light);
  padding: 0.25rem 0.5rem;
  font-family: var(--font-mono);
  font-size: 8px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.chat-setting-row {
  display: flex;
  min-height: 4rem;
  align-items: center;
  gap: 1rem;
  padding: 0.75rem 0;
}

.chat-setting-row > span {
  display: grid;
  min-width: 0;
  flex: 1;
  gap: 0.125rem;
}

.chat-setting-row strong {
  font-size: 11px;
  font-weight: 600;
  color: var(--color-ink-2);
}

.chat-setting-row small {
  font-size: 9px;
  line-height: 1.4;
  color: var(--color-ink-3);
}

.chat-setting-row input {
  width: 13rem;
  height: 1.875rem;
  flex: 0 0 auto;
  border: 1px solid var(--color-rule);
  background: var(--color-surface);
  padding: 0 0.5rem;
  font-size: 10px;
  color: var(--color-ink);
  outline: none;
}

.chat-setting-row input:focus {
  border-color: var(--color-accent);
}

.chat-settings-primary,
.chat-settings-secondary,
.chat-notification-toggle {
  height: 1.875rem;
  padding: 0 0.75rem;
  font-size: 9px;
  font-weight: 600;
}

.chat-settings-primary {
  background: var(--color-accent);
  color: var(--color-accent-ink);
}

.chat-settings-secondary {
  border: 1px solid var(--color-rule);
  color: var(--color-ink-2);
}

.chat-notification-toggle {
  min-width: 4.5rem;
  border: 1px solid var(--color-rule);
  color: var(--color-ink-2);
}

.chat-notification-toggle[aria-pressed='true'] {
  border-color: var(--color-add);
  color: var(--color-add);
}

.chat-settings-primary:hover:not(:disabled) {
  background: var(--color-accent-2);
}

.chat-settings-secondary:hover:not(:disabled) {
  background: var(--color-chrome-mid);
  color: var(--color-ink);
}

.chat-settings-primary:focus-visible,
.chat-settings-secondary:focus-visible {
  outline: 1px solid var(--color-accent);
  outline-offset: 1px;
}

button:disabled {
  opacity: 0.4;
}
</style>
