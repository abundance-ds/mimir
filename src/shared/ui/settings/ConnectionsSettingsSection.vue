<template>
  <section class="font-sans text-ink" aria-label="Connections settings">
    <h2 class="section-title mb-0">Connections</h2>
    <p class="mt-1 text-[10px] leading-relaxed text-ink-3">
      Connect the accounts you use. Mimir makes their tools available to every agent immediately.
    </p>

    <div class="connection-list mt-5 border-y border-rule-light">
      <div v-if="loading" class="connection-loading" role="status">Checking connections…</div>
      <article
        v-for="connection in connections"
        v-else
        :key="connection.provider"
        class="connection-row"
        :data-connection-provider="connection.provider"
      >
        <div class="connection-main">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <strong class="text-[11px] font-medium text-ink">{{ connection.name }}</strong>
              <span class="connection-status" :class="statusClass(connection)">
                <span class="connection-dot" :class="dotClass(connection)" />
                {{ statusLabel(connection) }}
              </span>
            </div>
            <p class="mt-1 text-[9px] leading-relaxed text-ink-3">{{ connection.detail }}</p>
          </div>
          <div class="flex items-center gap-2">
            <button
              v-if="showSlackTokenAlternative(connection)"
              type="button"
              class="connection-cancel"
              :disabled="busyProvider !== ''"
              @click="openSlackToken"
            >
              Use personal token
            </button>
            <button
              type="button"
              class="connection-action"
              :class="{ 'connection-action-disconnect': connection.state === 'connected' && connection.provider !== 'google' }"
              :disabled="busyProvider !== ''"
              @click="handleAction(connection)"
            >
              {{ actionLabel(connection) }}
            </button>
          </div>
        </div>

        <div
          v-if="connection.provider === 'google' && connection.accounts?.length"
          class="connection-accounts"
          aria-label="Connected Google accounts"
        >
          <div v-for="account in connection.accounts" :key="account.id" class="connection-account-row">
            <div class="min-w-0">
              <div class="truncate text-[10px] text-ink-2">{{ account.label }}</div>
              <div v-if="account.detail" class="mt-0.5 truncate text-[9px] text-ink-4">{{ account.detail }}</div>
            </div>
            <span v-if="account.state === 'needs_sign_in'" class="text-[9px] text-attn">
              {{ account.isDefault ? 'Default · Needs sign-in' : 'Needs sign-in' }}
            </span>
            <span v-else-if="account.isDefault" class="text-[9px] text-ink-3">Default</span>
            <button
              v-else
              type="button"
              class="connection-account-action"
              :disabled="busyProvider !== ''"
              @click="setGoogleDefault(account)"
            >
              Make default
            </button>
            <button
              type="button"
              class="connection-account-action text-rem"
              :aria-label="`Remove ${account.label}`"
              :disabled="busyProvider !== ''"
              @click="disconnectGoogleAccount(account)"
            >
              Remove
            </button>
          </div>
        </div>
      </article>
    </div>

    <form v-if="showSlackToken" class="credential-form" @submit.prevent="connectSlackToken">
      <label for="slack-personal-token" class="text-[10px] font-medium text-ink-2">Slack personal token</label>
      <p class="mt-1 text-[9px] leading-relaxed text-ink-3">
        Use an existing user token that starts with xoxp-. Mimir verifies it before saving it in Keychain.
      </p>
      <div class="mt-3 flex items-center gap-2">
        <input
          id="slack-personal-token"
          ref="slackTokenInput"
          v-model="slackToken"
          class="credential-input"
          type="password"
          autocomplete="off"
          autocapitalize="none"
          spellcheck="false"
          placeholder="xoxp-…"
        />
        <button type="submit" class="connection-action" :disabled="busyProvider !== '' || !slackToken.trim()">
          Connect
        </button>
        <button type="button" class="connection-cancel" :disabled="busyProvider !== ''" @click="closeSlackToken">
          Cancel
        </button>
      </div>
    </form>

    <form
      v-if="showGranolaKey"
      class="credential-form"
      @submit.prevent="connectGranola"
    >
      <label for="granola-api-key" class="text-[10px] font-medium text-ink-2">Granola API key</label>
      <p class="mt-1 text-[9px] leading-relaxed text-ink-3">
        In Granola, go to Settings → Connectors → API keys. API access requires a Business or Enterprise workspace.
      </p>
      <div class="mt-3 flex items-center gap-2">
        <input
          id="granola-api-key"
          ref="granolaKeyInput"
          v-model="granolaKey"
          class="credential-input"
          type="password"
          autocomplete="off"
          autocapitalize="none"
          spellcheck="false"
          placeholder="grn_…"
        />
        <button type="submit" class="connection-action" :disabled="busyProvider !== '' || !granolaKey.trim()">
          Connect
        </button>
        <button type="button" class="connection-cancel" :disabled="busyProvider !== ''" @click="closeGranolaKey">
          Cancel
        </button>
      </div>
    </form>

    <p v-if="notice" class="mt-3 text-[10px] text-add" role="status">{{ notice }}</p>
    <p v-if="error" class="mt-3 text-[10px] leading-relaxed text-rem" role="alert">{{ error }}</p>
  </section>
</template>

<script setup>
import { invoke } from '@tauri-apps/api/core'
import { nextTick, onMounted, ref } from 'vue'

const connections = ref([])
const loading = ref(true)
const busyProvider = ref('')
const showGranolaKey = ref(false)
const granolaKey = ref('')
const granolaKeyInput = ref(null)
const showSlackToken = ref(false)
const slackToken = ref('')
const slackTokenInput = ref(null)
const notice = ref('')
const error = ref('')

onMounted(load)

async function load() {
  loading.value = true
  error.value = ''
  try {
    const value = await invoke('connections_status')
    connections.value = Array.isArray(value) ? value : []
  } catch (cause) {
    error.value = errorMessage(cause)
  } finally {
    loading.value = false
  }
}

async function handleAction(connection) {
  error.value = ''
  notice.value = ''
  if (connection.provider === 'google') {
    await connectBrowserProvider(connection)
    return
  }
  if (connection.state === 'connected') {
    await disconnect(connection)
    return
  }
  if (connection.provider === 'granola') {
    showGranolaKey.value = true
    await nextTick()
    granolaKeyInput.value?.focus()
    return
  }
  if (connection.provider === 'slack' && !connection.oauthAvailable) {
    await openSlackToken()
    return
  }
  await connectBrowserProvider(connection)
}

async function connectBrowserProvider(connection) {
  busyProvider.value = connection.provider
  try {
    const updated = await invoke(`connections_connect_${connection.provider}`)
    replaceConnection(updated)
    notice.value = connection.provider === 'google'
      ? 'Google account added. Its tools are ready now.'
      : `${connection.name} is connected. Its tools are ready now.`
  } catch (cause) {
    error.value = errorMessage(cause)
  } finally {
    busyProvider.value = ''
  }
}

async function openSlackToken() {
  showSlackToken.value = true
  await nextTick()
  slackTokenInput.value?.focus()
}

async function connectSlackToken() {
  busyProvider.value = 'slack'
  error.value = ''
  notice.value = ''
  try {
    const updated = await invoke('connections_connect_slack_token', { token: slackToken.value.trim() })
    replaceConnection(updated)
    slackToken.value = ''
    showSlackToken.value = false
    notice.value = 'Slack is connected. Its tools are ready now.'
  } catch (cause) {
    error.value = errorMessage(cause)
  } finally {
    busyProvider.value = ''
  }
}

async function connectGranola() {
  busyProvider.value = 'granola'
  error.value = ''
  notice.value = ''
  try {
    const updated = await invoke('connections_connect_granola', { apiKey: granolaKey.value.trim() })
    replaceConnection(updated)
    granolaKey.value = ''
    showGranolaKey.value = false
    notice.value = 'Granola is connected. Its tools are ready now.'
  } catch (cause) {
    error.value = errorMessage(cause)
  } finally {
    busyProvider.value = ''
  }
}

async function disconnect(connection) {
  busyProvider.value = connection.provider
  try {
    const updated = await invoke('connections_disconnect', { provider: connection.provider })
    if (Array.isArray(updated)) connections.value = updated
    notice.value = `${connection.name} is disconnected. Its tools are no longer available.`
  } catch (cause) {
    error.value = errorMessage(cause)
  } finally {
    busyProvider.value = ''
  }
}

async function disconnectGoogleAccount(account) {
  busyProvider.value = 'google'
  error.value = ''
  notice.value = ''
  try {
    const updated = await invoke('connections_disconnect', { provider: 'google', account: account.id })
    if (Array.isArray(updated)) connections.value = updated
    notice.value = `${account.label} is disconnected.`
  } catch (cause) {
    error.value = errorMessage(cause)
  } finally {
    busyProvider.value = ''
  }
}

async function setGoogleDefault(account) {
  busyProvider.value = 'google'
  error.value = ''
  notice.value = ''
  try {
    const updated = await invoke('connections_set_google_default', { account: account.id })
    replaceConnection(updated)
    notice.value = `${account.label} is now the default Google account.`
  } catch (cause) {
    error.value = errorMessage(cause)
  } finally {
    busyProvider.value = ''
  }
}

function closeGranolaKey() {
  granolaKey.value = ''
  showGranolaKey.value = false
}

function closeSlackToken() {
  slackToken.value = ''
  showSlackToken.value = false
}

function replaceConnection(updated) {
  if (!updated?.provider) return
  connections.value = connections.value.map(connection => (
    connection.provider === updated.provider ? updated : connection
  ))
}

function statusLabel(connection) {
  if (connection.provider === 'google' && connection.accounts?.length > 1) {
    return `${connection.accounts.length} accounts`
  }
  if (connection.state === 'connected') {
    return connection.account ? `Connected as ${connection.account}` : 'Connected'
  }
  if (connection.state === 'needs_sign_in') return 'Needs sign-in'
  return 'Not connected'
}

function actionLabel(connection) {
  if (busyProvider.value === connection.provider) return 'Working…'
  if (connection.provider === 'google') {
    return connection.accounts?.length ? 'Add account' : 'Connect'
  }
  if (connection.state === 'connected') return 'Disconnect'
  if (connection.provider === 'slack' && !connection.oauthAvailable) return 'Use personal token'
  return connection.state === 'needs_sign_in' ? 'Sign in again' : 'Connect'
}

function showSlackTokenAlternative(connection) {
  return connection.provider === 'slack'
    && connection.state !== 'connected'
    && connection.oauthAvailable
}

function statusClass(connection) {
  return connection.state === 'connected' ? 'text-add' : 'text-ink-3'
}

function dotClass(connection) {
  if (connection.state === 'connected') return 'bg-add'
  if (connection.state === 'needs_sign_in') return 'bg-attn'
  return 'bg-ink-4'
}

function errorMessage(cause) {
  if (typeof cause === 'string') return cause
  return cause?.message || 'Mimir could not update this connection.'
}
</script>

<style scoped>
.connection-list {
  min-height: 54px;
}

.connection-loading {
  padding: 16px 0;
  font-size: 10px;
  color: var(--color-ink-3);
}

.connection-row {
  min-height: 72px;
  border-bottom: 1px solid var(--color-rule-light);
}

.connection-main {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 20px;
  min-height: 72px;
}

.connection-row:last-child {
  border-bottom: 0;
}

.connection-status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  font-size: 9px;
  line-height: 1.2;
}

.connection-dot {
  width: 6px;
  height: 6px;
  flex: 0 0 auto;
  border-radius: 999px;
}

.connection-action,
.connection-cancel {
  height: 26px;
  border: 1px solid var(--color-rule);
  border-radius: 4px;
  padding: 0 10px;
  background: var(--color-chrome-mid);
  color: var(--color-ink-2);
  font-family: var(--font-sans);
  font-size: 9px;
  white-space: nowrap;
}

.connection-action:hover:not(:disabled),
.connection-cancel:hover:not(:disabled) {
  border-color: var(--color-accent);
  color: var(--color-ink);
}

.connection-action:disabled,
.connection-cancel:disabled {
  cursor: default;
  opacity: 0.5;
}

.connection-action:focus-visible,
.connection-cancel:focus-visible,
.connection-account-action:focus-visible {
  outline: none;
  box-shadow: 0 0 0 1px var(--color-accent);
}

.connection-action-disconnect {
  background: transparent;
  color: var(--color-ink-3);
}

.connection-accounts {
  border-top: 1px solid var(--color-rule-light);
  padding: 0 0 6px 16px;
}

.connection-account-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 12px;
  min-height: 42px;
  border-bottom: 1px solid var(--color-rule-light);
}

.connection-account-row:last-child {
  border-bottom: 0;
}

.connection-account-action {
  min-height: 24px;
  padding: 0 4px;
  color: var(--color-ink-3);
  font-family: var(--font-sans);
  font-size: 9px;
}

.connection-account-action:hover:not(:disabled) {
  color: var(--color-ink);
}

.connection-account-action.text-rem:hover:not(:disabled) {
  color: var(--color-rem);
}

.connection-account-action:disabled {
  opacity: 0.5;
}

.connection-cancel {
  border-color: transparent;
  background: transparent;
}

.credential-form {
  margin-top: 14px;
  border-left: 2px solid var(--color-rule);
  padding: 3px 0 3px 12px;
}

.credential-input {
  min-width: 0;
  height: 28px;
  flex: 1;
  border: 1px solid var(--color-rule);
  border-radius: 4px;
  background: var(--color-surface);
  padding: 0 8px;
  color: var(--color-ink);
  font-family: var(--font-mono);
  font-size: 9px;
  outline: none;
}

.credential-input:focus {
  border-color: var(--color-accent);
}
</style>
