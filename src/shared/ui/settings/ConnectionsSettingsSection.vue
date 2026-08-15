<template>
  <section class="font-sans text-ink" aria-label="Connections settings">
    <h2 class="section-title mb-0">Connections</h2>
    <p class="mt-1 text-[10px] leading-relaxed text-ink-3">
      Connect once. Mimir makes the matching tools available to every agent immediately.
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
        <button
          type="button"
          class="connection-action"
          :class="{ 'connection-action-disconnect': connection.state === 'connected' }"
          :disabled="busyProvider !== ''"
          @click="handleAction(connection)"
        >
          {{ actionLabel(connection) }}
        </button>
      </article>
    </div>

    <form
      v-if="showGranolaKey"
      class="granola-key-form"
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
          class="granola-key-input"
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
  await connectBrowserProvider(connection)
}

async function connectBrowserProvider(connection) {
  busyProvider.value = connection.provider
  try {
    const updated = await invoke(`connections_connect_${connection.provider}`)
    replaceConnection(updated)
    notice.value = `${connection.name} is connected. Its tools are ready now.`
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

function closeGranolaKey() {
  granolaKey.value = ''
  showGranolaKey.value = false
}

function replaceConnection(updated) {
  if (!updated?.provider) return
  connections.value = connections.value.map(connection => (
    connection.provider === updated.provider ? updated : connection
  ))
}

function statusLabel(connection) {
  if (connection.state === 'connected') {
    return connection.account ? `Connected as ${connection.account}` : 'Connected'
  }
  if (connection.state === 'needs_sign_in') return 'Needs sign-in'
  return 'Not connected'
}

function actionLabel(connection) {
  if (busyProvider.value === connection.provider) return 'Working…'
  if (connection.state === 'connected') return 'Disconnect'
  return connection.state === 'needs_sign_in' ? 'Sign in again' : 'Connect'
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
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 20px;
  min-height: 72px;
  border-bottom: 1px solid var(--color-rule-light);
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

.connection-action-disconnect {
  background: transparent;
  color: var(--color-ink-3);
}

.connection-cancel {
  border-color: transparent;
  background: transparent;
}

.granola-key-form {
  margin-top: 14px;
  border-left: 2px solid var(--color-rule);
  padding: 3px 0 3px 12px;
}

.granola-key-input {
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

.granola-key-input:focus {
  border-color: var(--color-accent);
}
</style>
