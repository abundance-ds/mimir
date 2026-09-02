<template>
  <section class="font-sans text-ink" aria-label="Connections settings">
    <h2 class="section-title mb-0">Connections</h2>
    <p class="mt-1 text-[10px] leading-relaxed text-ink-3">
      Connect the accounts and services Mimir uses.
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
              v-if="showConnectionAction(connection)"
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
          v-if="connection.provider === 'github' && showGithubManagement"
          class="github-management"
          data-github-management
        >
          <p v-if="githubSignOutArmed">
            This signs {{ connection.account || 'the active account' }} out of GitHub CLI for Mimir, Terminal, and other tools.
          </p>
          <p v-else>
            Mimir has no separate GitHub login. This account is shared with Terminal and other tools.
          </p>
          <div class="flex items-center gap-2">
            <button
              v-if="!githubSignOutArmed"
              type="button"
              class="connection-cancel text-rem"
              data-github-sign-out
              :disabled="busyProvider !== ''"
              @click="githubSignOutArmed = true"
            >
              Sign out of GitHub CLI
            </button>
            <template v-else>
              <button
                type="button"
                class="connection-cancel"
                :disabled="busyProvider !== ''"
                @click="githubSignOutArmed = false"
              >
                Cancel
              </button>
              <button
                type="button"
                class="connection-action connection-action-disconnect text-rem"
                data-github-confirm-sign-out
                :disabled="busyProvider !== ''"
                @click="disconnectGithubCli"
              >
                {{ busyProvider === 'github' ? 'Signing out…' : 'Confirm sign out' }}
              </button>
            </template>
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
import { nextTick, onMounted, onUnmounted, ref } from 'vue'
import { openExternalUrl } from '../../../services/externalLinks.js'

const connections = ref([])
const loading = ref(true)
const busyProvider = ref('')
const showGranolaKey = ref(false)
const granolaKey = ref('')
const granolaKeyInput = ref(null)
const showSlackToken = ref(false)
const slackToken = ref('')
const slackTokenInput = ref(null)
const showGithubManagement = ref(false)
const githubSignOutArmed = ref(false)
const notice = ref('')
const error = ref('')

onMounted(() => {
  void load()
  window.addEventListener('focus', refreshGithub)
})
onUnmounted(() => window.removeEventListener('focus', refreshGithub))

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [value, github] = await Promise.all([
      invoke('connections_status'),
      invoke('github_connection_status'),
    ])
    connections.value = [githubConnection(github), ...(Array.isArray(value) ? value : [])]
  } catch (cause) {
    error.value = errorMessage(cause)
  } finally {
    loading.value = false
  }
}

async function handleAction(connection) {
  error.value = ''
  notice.value = ''
  if (connection.provider === 'github' && connection.action.startsWith('install-')) {
    try {
      const installGit = connection.action === 'install-git'
      await openExternalUrl(installGit ? 'https://git-scm.com/downloads' : 'https://cli.github.com/')
      notice.value = `Install ${installGit ? 'Git' : 'GitHub CLI'}, then return to Mimir.`
    } catch (cause) {
      error.value = errorMessage(cause)
    }
    return
  }
  if (connection.provider === 'google') {
    await connectBrowserProvider(connection)
    return
  }
  if (connection.provider === 'github' && connection.action === 'manage') {
    showGithubManagement.value = !showGithubManagement.value
    githubSignOutArmed.value = false
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

async function disconnectGithubCli() {
  busyProvider.value = 'github'
  error.value = ''
  notice.value = ''
  try {
    replaceConnection(githubConnection(await invoke('github_disconnect')))
    showGithubManagement.value = false
    githubSignOutArmed.value = false
    notice.value = 'Signed out of GitHub CLI. Local files are unchanged.'
  } catch (cause) {
    error.value = errorMessage(cause)
  } finally {
    busyProvider.value = ''
  }
}

async function connectBrowserProvider(connection) {
  busyProvider.value = connection.provider
  try {
    const updated = connection.provider === 'github'
      ? githubConnection(await invoke('github_connect'))
      : await invoke(`connections_connect_${connection.provider}`)
    replaceConnection(updated)
    notice.value = connection.provider === 'github'
      ? 'GitHub is ready.'
      : connection.provider === 'google'
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
    replaceProviderConnections(updated)
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
    replaceProviderConnections(updated)
    notice.value = `${account.label} is disconnected.`
  } catch (cause) {
    error.value = errorMessage(cause)
  } finally {
    busyProvider.value = ''
  }
}

function replaceProviderConnections(updated) {
  if (!Array.isArray(updated)) return
  const github = connections.value.find(item => item.provider === 'github')
  connections.value = [github, ...updated.filter(item => item.provider !== 'github')].filter(Boolean)
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

function githubConnection(status = {}) {
  return {
    provider: 'github',
    name: 'GitHub',
    state: status.connected ? 'connected' : 'disconnected',
    account: status.login || '',
    action: status.connected
      ? 'manage'
      : !status.gitAvailable
        ? 'install-git'
        : !status.cliAvailable
          ? 'install-gh'
          : 'connect',
    detail: status.connected
      ? 'Managed by GitHub CLI. Mimir uses this account for Team and Project sync.'
      : !status.gitAvailable
        ? 'Git is not installed.'
        : !status.cliAvailable
          ? 'GitHub CLI is not installed.'
          : 'Sign in with your existing GitHub CLI setup.',
  }
}

async function refreshGithub() {
  if (loading.value || busyProvider.value) return
  try {
    replaceConnection(githubConnection(await invoke('github_connection_status')))
  } catch { /* the visible state stays unchanged until the next explicit action */ }
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
  if (busyProvider.value === connection.provider) {
    return connection.provider === 'github' ? 'Waiting for GitHub…' : 'Working…'
  }
  if (connection.provider === 'github' && connection.action === 'install-git') return 'Install Git'
  if (connection.provider === 'github' && connection.action === 'install-gh') return 'Install GitHub CLI'
  if (connection.provider === 'github' && connection.action === 'manage') return 'Manage'
  if (connection.provider === 'github') return 'Sign in'
  if (connection.provider === 'google') {
    return connection.accounts?.length ? 'Add account' : 'Connect'
  }
  if (connection.state === 'connected') return 'Disconnect'
  if (connection.provider === 'slack' && !connection.oauthAvailable) return 'Use personal token'
  return connection.state === 'needs_sign_in' ? 'Sign in again' : 'Connect'
}

function showConnectionAction(connection) {
  return true
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
  min-height: 58px;
  border-bottom: 1px solid var(--color-rule-light);
}

.connection-main {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 20px;
  min-height: 58px;
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

.github-management {
  display: flex;
  flex-wrap: wrap;
  min-height: 40px;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  border-top: 1px solid var(--color-rule-light);
  padding: 6px 0 6px 16px;
  color: var(--color-ink-3);
  font-size: 9px;
  line-height: 1.4;
}

.github-management > p {
  min-width: 220px;
  flex: 1 1 300px;
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
