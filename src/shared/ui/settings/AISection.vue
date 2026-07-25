<template>
  <div>
    <!-- ─── Keys ─── -->
    <div class="section-title">Keys</div>

    <div v-if="!isTauri" class="browser-notice">
      <IconInfoCircle :size="16" />
      <span>API key management is not available in browser mode.</span>
    </div>

    <template v-else>
      <div v-for="(prov, i) in providers" :key="prov.id" class="key-row">
        <div class="key-info">
          <div class="key-name-row">
            <span
              class="key-dot"
              :class="{ configured: keyStatus[prov.id]?.configured }"
            ></span>
            <span class="key-name">{{ prov.label }}</span>
            <span class="key-envvar">{{ prov.envVar }}</span>
          </div>
          <span class="key-preview">
            <template v-if="keyStatus[prov.id]?.maskedPreview">
              {{ keyStatus[prov.id].maskedPreview }}
            </template>
            <template v-else-if="keyStatus[prov.id]?.configured">Configured</template>
            <em v-else>Not configured</em>
          </span>
        </div>
        <div class="key-input-row">
          <input
            v-model="keyInputs[prov.id]"
            type="password"
            class="key-input"
            :placeholder="prov.placeholder"
            @keydown.enter="saveKey(prov.id)"
          />
          <button
            class="key-save-btn"
            :disabled="!keyInputs[prov.id]?.trim() || saving[prov.id]"
            @click="saveKey(prov.id)"
          >Save</button>
        </div>
        <div v-if="messages[prov.id]" class="key-message" :class="messages[prov.id].type">
          {{ messages[prov.id].text }}
        </div>
      </div>

      <div class="keys-footer">Keys are stored securely in your system keychain.</div>
    </template>

    <!-- ─── Features ─── -->
    <div class="section-title mt">Features</div>

    <!-- Ghost suggestions -->
    <div class="setting-row">
      <div class="setting-label">
        Ghost suggestions
        <span class="setting-desc">Suggest completions as you write (type ++ to trigger)</span>
      </div>
      <button
        class="toggle-switch"
        :class="{ 'toggle-on': settings.aiGhostSuggestions }"
        @click="settings.set('aiGhostSuggestions', !settings.aiGhostSuggestions)"
      >
        <span class="toggle-knob"></span>
      </button>
    </div>

    <!-- Ghost model sub-row -->
    <div v-if="settings.aiGhostSuggestions" class="setting-row sub-row">
      <div class="setting-label">
        Model
        <span class="setting-desc">Which model generates completions</span>
      </div>
      <div style="position: relative" ref="ghostDropdownRef">
        <button class="ghost-picker-trigger" @click="ghostModelOpen = !ghostModelOpen">
          <component v-if="ghostProviderIcon" :is="ghostProviderIcon" :size="11" class="ghost-picker-icon" />
          <span>{{ ghostModelLabel }}</span>
          <IconChevronDown :size="12" />
        </button>
        <div v-if="ghostModelOpen" class="ghost-picker-dropdown">
          <button
            v-for="model in flatGhostModels"
            :key="model.id"
            class="ghost-picker-option"
            :class="{ selected: settings.aiGhostModel === model.id }"
            :disabled="model.disabled"
            @click="!model.disabled && selectGhostModel(model.id)"
          >
            <component v-if="model.icon" :is="model.icon" :size="11" class="ghost-option-icon" />
            <span class="ghost-option-name">{{ model.displayName }}</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Inline rewrite -->
    <div class="setting-row last">
      <div class="setting-label">
        AI rewrite
        <span class="setting-desc">Rewrite selected text with AI (&#x2318;K)</span>
      </div>
      <button
        class="toggle-switch"
        :class="{ 'toggle-on': settings.aiInlineRewrite }"
        @click="settings.set('aiInlineRewrite', !settings.aiInlineRewrite)"
      >
        <span class="toggle-knob"></span>
      </button>
    </div>

  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue'
import { useSettingsStore } from '../../../stores/settings.js'
import { getAiKeyStatus, setAiApiKey, getModelRegistry } from '../../../services/ai/client.js'
import { ghostModels, modelDisplayName, providerConfigured, resolveGhostDefault } from '../../../services/ai/modelControls.js'
import { IconChevronDown, IconCheck, IconInfoCircle } from '@tabler/icons-vue'
import IconProviderAnthropic from '../../icons/IconProviderAnthropic.vue'
import IconProviderOpenAI from '../../icons/IconProviderOpenAI.vue'
import IconProviderGoogle from '../../icons/IconProviderGoogle.vue'

const providerIconMap = {
  anthropic: IconProviderAnthropic,
  openai: IconProviderOpenAI,
  google: IconProviderGoogle,
}

const settings = useSettingsStore()
const isTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__

// ─── Keys ───

const providers = [
  { id: 'anthropic', label: 'Anthropic', placeholder: 'sk-ant-...', envVar: 'ANTHROPIC_API_KEY' },
  { id: 'openai',    label: 'OpenAI',    placeholder: 'sk-...',     envVar: 'OPENAI_API_KEY' },
  { id: 'google',    label: 'Google',    placeholder: 'AIza...',    envVar: 'GOOGLE_AI_API_KEY' },
]

const keyStatus = reactive({})
const keyInputs = reactive({})
const saving = reactive({})
const messages = reactive({})

async function loadKeyStatus() {
  try {
    const statuses = await getAiKeyStatus()
    for (const s of statuses) {
      keyStatus[s.provider] = s
    }
  } catch { /* ignore */ }
}

async function saveKey(providerId) {
  const key = keyInputs[providerId]?.trim()
  if (!key) return
  saving[providerId] = true
  messages[providerId] = null
  try {
    await setAiApiKey(providerId, key)
    keyInputs[providerId] = ''
    messages[providerId] = { type: 'success', text: 'Key saved successfully.' }
    await loadKeyStatus()
  } catch (err) {
    messages[providerId] = { type: 'error', text: err?.message || 'Failed to save key.' }
  } finally {
    saving[providerId] = false
  }
}

// ─── Ghost model ───

const ghostModelOpen = ref(false)
const ghostDropdownRef = ref(null)
const registry = ref(null)
const keyStatuses = ref([])

const flatGhostModels = computed(() => {
  if (!registry.value) return []
  const models = ghostModels(registry.value)
  return models.map((model) => ({
    id: model.id,
    displayName: model.shortLabel || modelDisplayName(model),
    provider: model.provider,
    icon: providerIconMap[model.provider] || null,
    disabled: !providerConfigured(keyStatuses.value, model.provider),
  }))
})

const ghostModelLabel = computed(() => {
  const model = flatGhostModels.value.find(m => m.id === settings.aiGhostModel)
  if (model) return model.displayName
  if (!registry.value) return settings.aiGhostModel
  return 'No key configured'
})

const ghostProviderIcon = computed(() => {
  const model = flatGhostModels.value.find(m => m.id === settings.aiGhostModel)
  return model?.icon || null
})

function selectGhostModel(id) {
  settings.set('aiGhostModel', id)
  ghostModelOpen.value = false
}

// ─── Lifecycle ───

function onClickOutside(e) {
  if (ghostDropdownRef.value && !ghostDropdownRef.value.contains(e.target)) {
    ghostModelOpen.value = false
  }
}

onMounted(async () => {
  document.addEventListener('pointerdown', onClickOutside)
  if (isTauri) {
    const [reg, keys] = await Promise.all([getModelRegistry(), getAiKeyStatus()])
    registry.value = reg
    keyStatuses.value = keys
    for (const s of keys) keyStatus[s.provider] = s
    ensureGhostModelSelected()
  }
})

function ensureGhostModelSelected() {
  if (!registry.value) return
  const current = settings.aiGhostModel
  const currentOk = current && current !== 'auto'
    && providerConfigured(keyStatuses.value, ghostModels(registry.value).find(m => m.id === current)?.provider)
  if (currentOk) return
  const best = resolveGhostDefault(registry.value, keyStatuses.value)
  settings.set('aiGhostModel', best?.id || 'auto')
}

onUnmounted(() => {
  document.removeEventListener('pointerdown', onClickOutside)
})
</script>

<style scoped>
.key-row {
  padding: 12px 0;
  border-bottom: 1px solid var(--color-rule-light);
}
.key-row:last-of-type {
  border-bottom: none;
}

.key-info {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.key-name-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.key-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--color-ink-4);
  flex-shrink: 0;
}
.key-dot.configured {
  background: #4a9;
}

.key-name {
  font-family: var(--font-sans);
  font-size: 12px;
  font-weight: 500;
  color: var(--color-ink);
}

.key-envvar {
  font-family: var(--font-mono);
  font-size: 9px;
  color: var(--color-ink-3);
  background: var(--color-chrome-mid);
  padding: 1px 5px;
  border-radius: 3px;
  margin-left: 4px;
}

.key-preview {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--color-ink-3);
}
.key-preview em {
  font-style: italic;
  color: var(--color-ink-3);
}

.key-input-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.key-input {
  flex: 1;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--color-ink-2);
  background: var(--color-chrome-mid);
  border: 1px solid var(--color-rule-light);
  border-radius: 5px;
  height: 28px;
  padding: 0 10px;
  outline: none;
  transition: border-color 120ms ease;
}
.key-input:focus {
  border-color: var(--color-accent);
}

.key-save-btn {
  font-family: var(--font-sans);
  font-size: 11px;
  font-weight: 500;
  color: white;
  background: var(--color-accent);
  border: none;
  border-radius: 5px;
  height: 28px;
  padding: 0 14px;
  flex-shrink: 0;
}
.key-save-btn:hover:not(:disabled) {
  opacity: 0.85;
}
.key-save-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.key-message {
  font-family: var(--font-sans);
  font-size: 10px;
  margin-top: 6px;
  padding-left: 15px;
}
.key-message.success {
  color: #4a9;
}
.key-message.error {
  color: #c55;
}

.keys-footer {
  font-family: var(--font-sans);
  font-size: 10px;
  color: var(--color-ink-3);
  text-align: center;
  padding: 14px 0 4px;
}

.browser-notice {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  font-family: var(--font-sans);
  font-size: 11px;
  color: var(--color-ink-3);
  background: var(--color-chrome-mid);
  border: 1px solid var(--color-rule-light);
  border-radius: 6px;
  padding: 14px;
}

.sub-row {
  padding-left: 16px;
}

.ghost-picker-trigger {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 10px;
  border-radius: 999px;
  color: var(--color-ink-2);
  font-family: var(--font-mono);
  font-size: 12px;
  border: 1px solid var(--color-rule-light);
  background: var(--color-surface);
}
.ghost-picker-trigger:hover {
  background: var(--color-chrome-high);
}
.ghost-picker-icon {
  flex-shrink: 0;
  color: var(--color-ink-3);
}
.ghost-picker-dropdown {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 4px;
  background: var(--color-surface);
  border: 1px solid var(--color-rule);
  border-radius: 6px;
  padding: 5px;
  width: 200px;
  z-index: 20;
  box-shadow: 0 8px 30px rgba(0,0,0,.18);
}
.ghost-picker-option {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border-radius: 4px;
  font-size: 12px;
  text-align: left;
}
.ghost-picker-option:hover {
  background: var(--color-chrome-high);
}
.ghost-picker-option.selected {
  background: var(--color-accent-tint);
  color: var(--color-accent);
  font-weight: 600;
}
.ghost-picker-option:disabled {
  opacity: 0.4;
  cursor: default;
}
.ghost-picker-option:disabled:hover {
  background: transparent;
}
.ghost-option-name {
  font-family: var(--font-mono);
}
.ghost-option-icon {
  flex-shrink: 0;
  color: var(--color-ink-3);
}

.mt {
  margin-top: 20px;
}
</style>
