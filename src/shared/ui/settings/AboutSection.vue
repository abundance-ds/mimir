<template>
  <div class="about-page">
    <div class="about-hero">
      <span class="about-title">mim terminal</span>
      <span class="about-version">v0.3.0-alpha</span>
    </div>

    <div class="about-links">
      <a href="https://shoulde.rs" target="_blank" rel="noopener">shoulde.rs</a>
    </div>

    <!-- Update check (Tauri only) -->
    <div v-if="isTauri" class="update-section">
      <template v-if="updateState === 'idle'">
        <button class="update-btn" @click="onCheckUpdate">Check for updates</button>
      </template>
      <template v-else-if="updateState === 'checking'">
        <span class="update-status">Checking...</span>
      </template>
      <template v-else-if="updateState === 'available'">
        <span class="update-status">v{{ updateVersion }} available</span>
        <button class="update-btn update-btn-accent" @click="onInstall">Update now</button>
      </template>
      <template v-else-if="updateState === 'installing'">
        <span class="update-status">Installing...</span>
      </template>
      <template v-else-if="updateState === 'current'">
        <span class="update-status">You're up to date</span>
      </template>
      <template v-else-if="updateState === 'error'">
        <span class="update-status update-error">Check failed</span>
        <button class="update-btn" @click="onCheckUpdate">Retry</button>
      </template>
    </div>

    <div class="telemetry-section">
      <div class="setting-row last">
        <div class="setting-label">
          Help improve mim terminal
          <span class="setting-desc">Anonymous usage data. No file contents or personal information.</span>
        </div>
        <button
          class="toggle-switch"
          :class="{ 'toggle-on': settings.telemetryEnabled !== false }"
          @click="settings.set('telemetryEnabled', settings.telemetryEnabled === false)"
        >
          <span class="toggle-knob"></span>
        </button>
      </div>
    </div>

    <span class="about-copy">&copy; 2026</span>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useSettingsStore } from '../../../stores/settings.js'

const settings = useSettingsStore()

const isTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__

const updateState = ref('idle') // idle | checking | available | installing | current | error
const updateVersion = ref('')
let pendingUpdate = null

async function onCheckUpdate() {
  updateState.value = 'checking'
  try {
    const { checkForUpdate } = await import('../../../services/appUpdater.js')
    const update = await checkForUpdate()
    if (update) {
      pendingUpdate = update
      updateVersion.value = update.version
      updateState.value = 'available'
    } else {
      updateState.value = 'current'
    }
  } catch {
    updateState.value = 'error'
  }
}

async function onInstall() {
  if (!pendingUpdate) return
  updateState.value = 'installing'
  try {
    await pendingUpdate.download()
  } catch {
    updateState.value = 'error'
  }
}
</script>

<style scoped>
.about-page {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding-top: 40px;
}

.about-hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  margin-bottom: 16px;
}

.about-title {
  font-family: var(--font-brand);
  font-size: 24px;
  font-weight: 400;
  color: var(--color-ink);
}

.about-version {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--color-ink-3);
  margin-top: 4px;
}

.about-desc {
  font-family: var(--font-sans);
  font-size: 12px;
  color: var(--color-ink-3);
  line-height: 1.5;
  max-width: 280px;
  margin: 0 0 20px;
}

.about-links {
  font-family: var(--font-sans);
  font-size: 11px;
  margin-bottom: 20px;
}
.about-links a {
  color: var(--color-accent);
  text-decoration: none;
}
.about-links a:hover {
  text-decoration: underline;
}

.about-sep {
  color: var(--color-ink-3);
  margin: 0 5px;
}

/* ── Update section ── */
.update-section {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  margin-bottom: 20px;
}

.update-btn {
  font-family: var(--font-sans);
  font-size: 11px;
  color: var(--color-ink-2);
  background: var(--color-chrome-mid);
  border: 1px solid var(--color-rule-light);
  border-radius: 6px;
  padding: 5px 14px;
}
.update-btn:hover {
  border-color: var(--color-rule);
  color: var(--color-ink);
}

.update-btn-accent {
  background: var(--color-accent);
  border-color: var(--color-accent);
  color: white;
}
.update-btn-accent:hover {
  opacity: 0.85;
  border-color: var(--color-accent);
  color: white;
}

.update-status {
  font-family: var(--font-sans);
  font-size: 10px;
  color: var(--color-ink-3);
}

.update-error {
  color: var(--color-rem);
}

.about-copy {
  font-family: var(--font-sans);
  font-size: 10px;
  color: var(--color-ink-3);
}

.telemetry-section {
  width: 100%;
  max-width: 320px;
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--color-rule-light);
}
</style>
