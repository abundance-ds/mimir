<template>
  <section
    ref="settingsRoot"
    data-scribe-settings-panel
    :aria-labelledby="embedded ? undefined : 'scribe-settings-title'"
    :aria-label="embedded ? 'Scribe settings' : undefined"
    tabindex="-1"
    :class="embedded ? 'min-h-full' : 'h-full overflow-y-auto'"
    @keydown.esc="close"
  >
    <header v-if="!embedded" class="flex h-10 items-center border-b border-rule px-4">
      <h2 id="scribe-settings-title" class="flex-1 text-[11px] font-semibold">
        Scribe settings
      </h2>
      <button
        type="button"
        class="grid size-7 place-items-center text-ink-3 hover:bg-chrome-mid hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        aria-label="Close Scribe settings"
        @click="$emit('close')"
      >
        <IconX :size="14" />
      </button>
    </header>

    <div class="mx-auto max-w-2xl divide-y divide-rule px-4 pb-8">
      <section class="py-4">
        <h3 class="text-[11px] font-semibold">Capture</h3>
        <p
          v-if="configPending"
          data-scribe-config-pending
          class="mt-2 border-y border-rule-light py-2 font-mono text-[9px] text-ink-3"
          role="status"
        >
          Saving…
        </p>
        <label class="scribe-setting-row">
          <span>
            <strong>Detect meeting apps</strong>
          </span>
          <input
            data-scribe-detection
            type="checkbox"
            :checked="config.detectionEnabled"
            :disabled="configPending"
            @change="save({ detectionEnabled: $event.target.checked })"
          />
        </label>
        <div class="mt-3 block">
          <span class="scribe-settings-label">Microphone input</span>
          <ScribeSelect
            :model-value="config.microphoneDeviceId || ''"
            :options="microphoneOptions"
            :disabled="configPending || audioTesting"
            aria-label="Microphone input"
            @update:model-value="save({ microphoneDeviceId: $event || null })"
          />
        </div>
        <p
          v-if="microphoneCatalog.fallbackReason"
          class="mt-2 text-[9px] text-rem"
          role="status"
        >
          {{ microphoneCatalog.fallbackReason }}
        </p>
        <dl class="mt-3 grid grid-cols-[130px_1fr] border-t border-rule-light text-[10px]">
          <dt class="border-b border-rule-light py-2 font-mono text-ink-3">Microphone</dt>
          <dd class="border-b border-rule-light py-2">
            {{ permissionLabel(permissions.microphone) }}
          </dd>
          <dt class="border-b border-rule-light py-2 font-mono text-ink-3">System audio</dt>
          <dd class="border-b border-rule-light py-2">
            {{ permissionLabel(permissions.systemAudio) }}
          </dd>
        </dl>
        <p
          v-if="permissions.microphone === 'development-host'"
          class="mt-3 text-[9px] leading-relaxed text-ink-3"
        >
          Permission belongs to the development host. Verify it in the installed Mimir app.
        </p>
        <div class="mt-3 border-t border-rule-light pt-3">
          <div class="flex items-start gap-3">
            <span class="min-w-0 flex-1 text-[10px] font-medium">Input levels</span>
            <button
              type="button"
              data-scribe-check-audio
              class="scribe-settings-button shrink-0"
              :disabled="Boolean(pending['audio-check'])"
              @click="$emit('checkAudio')"
            >
              {{ pending['audio-check'] ? 'Starting…' : audioTesting ? 'Stop test' : 'Test inputs' }}
            </button>
          </div>
          <dl
            v-if="audioTesting && audioCheck"
            data-scribe-audio-check-result
            class="mt-2 grid grid-cols-[130px_1fr] border-t border-rule-light text-[10px]"
          >
            <dt class="border-b border-rule-light py-2 font-mono text-ink-3">Microphone</dt>
            <dd class="flex items-center border-b border-rule-light py-2">
              <span
                data-scribe-audio-level="microphone"
                class="scribe-audio-level flex-1"
                role="progressbar"
                aria-label="Microphone input level"
                aria-valuemin="0"
                aria-valuemax="100"
                :aria-valuenow="audioSourceLevel(audioCheck.microphone)"
              >
                <span :style="{ width: `${audioSourceLevel(audioCheck.microphone)}%` }" />
              </span>
            </dd>
            <dt class="border-b border-rule-light py-2 font-mono text-ink-3">System audio</dt>
            <dd class="flex items-center border-b border-rule-light py-2">
              <span
                data-scribe-audio-level="system"
                class="scribe-audio-level flex-1"
                role="progressbar"
                aria-label="System-audio input level"
                aria-valuemin="0"
                aria-valuemax="100"
                :aria-valuenow="audioSourceLevel(audioCheck.systemAudio)"
              >
                <span :style="{ width: `${audioSourceLevel(audioCheck.systemAudio)}%` }" />
              </span>
            </dd>
          </dl>
          <p
            v-if="audioTesting && audioCheck?.runtimeIdentity === 'development-host'"
            class="mt-2 text-[9px] leading-relaxed text-rem"
          >
            Development-host results. Verify in the installed Mimir app.
          </p>
        </div>
        <button
          v-if="!['granted', 'development-host'].includes(permissions.microphone)"
          type="button"
          data-scribe-grant-microphone
          class="scribe-settings-button mt-3"
          :disabled="Boolean(pending['microphone-permission'])"
          @click="$emit('requestMicrophonePermission')"
        >
          Grant microphone access
        </button>
        <button
          v-if="!['granted', 'development-host'].includes(permissions.systemAudio)"
          type="button"
          data-scribe-open-system-audio-settings
          class="scribe-settings-button mt-3"
          :disabled="Boolean(pending['system-audio-settings'])"
          @click="$emit('openSystemAudioSettings')"
        >
          {{
            pending['system-audio-settings']
              ? 'Opening System Settings…'
              : 'Open macOS audio permissions'
          }}
        </button>
      </section>

      <section class="py-4">
        <h3 class="text-[11px] font-semibold">Transcription</h3>
        <div
          class="mt-3 grid grid-cols-2 border border-rule"
          role="radiogroup"
          aria-label="Transcription route"
        >
          <button
            type="button"
            role="radio"
            class="h-9 border-r border-rule text-[10px] disabled:pointer-events-none disabled:opacity-45"
            :class="config.transcriptionMode === 'local'
              ? 'bg-accent-soft text-ink'
              : 'bg-chrome-high text-ink-3 hover:bg-chrome-mid'"
            :aria-checked="config.transcriptionMode === 'local'"
            :tabindex="config.transcriptionMode === 'local' ? 0 : -1"
            :disabled="configPending"
            @click="selectMode('local')"
            @keydown="onModeKeydown"
          >
            Local model
          </button>
          <button
            type="button"
            role="radio"
            class="h-9 text-[10px] disabled:pointer-events-none disabled:opacity-45"
            :class="config.transcriptionMode === 'custom'
              ? 'bg-accent-soft text-ink'
              : 'bg-chrome-high text-ink-3 hover:bg-chrome-mid'"
            :aria-checked="config.transcriptionMode === 'custom'"
            :tabindex="config.transcriptionMode === 'custom' ? 0 : -1"
            :disabled="configPending"
            data-scribe-openai-mode
            @click="selectMode('custom')"
            @keydown="onModeKeydown"
          >
            Hosted
          </button>
        </div>

        <div v-if="config.transcriptionMode === 'local'" class="mt-3">
          <div
            v-for="model in models"
            :key="model.id"
            class="mt-2 flex min-h-10 items-center border-y border-rule-light py-2"
          >
            <span class="min-w-0 flex-1">
              <strong class="block truncate text-[10px] font-medium">{{ model.title }}</strong>
              <small class="block font-mono text-[9px] text-ink-3">
                {{ modelStatus(model) }}
              </small>
              <span
                v-if="model.status === 'downloading'"
                role="progressbar"
                :aria-label="`Installing ${model.title}`"
                :aria-valuenow="modelProgress(model)"
                aria-valuemin="0"
                aria-valuemax="100"
                class="sr-only"
              >
                {{ modelProgress(model) }}%
              </span>
            </span>
            <button
              v-if="model.status !== 'installed'"
              type="button"
              class="scribe-settings-button"
              :disabled="Boolean(pending[`model:${model.id}`])"
              @click="$emit('installModel', model.id)"
            >
              {{ pending[`model:${model.id}`] ? 'Installing…' : 'Install' }}
            </button>
            <button
              v-else
              type="button"
              class="scribe-settings-button text-rem"
              :disabled="Boolean(pending[`model:${model.id}`])"
              @click="$emit('deleteModel', model.id)"
            >
              {{ pending[`model:${model.id}`] ? 'Removing…' : 'Remove' }}
            </button>
          </div>
        </div>

        <div v-else class="mt-3 space-y-3">
          <p class="text-[10px] leading-relaxed text-ink-3">{{ hostedDescription }}</p>
          <p
            data-scribe-api-key-state
            class="border-y border-rule-light py-2 text-[10px]"
            role="status"
          >
            {{ config.apiKeyConfigured ? 'Saved in Keychain' : 'API key required' }}
          </p>
          <form class="block" @submit.prevent="saveKey">
            <span class="scribe-settings-label">{{ hostedKeyLabel }}</span>
            <span class="flex gap-2">
              <input
                v-model="apiKey"
                data-scribe-api-key
                type="password"
                autocomplete="new-password"
                class="scribe-settings-input min-w-0 flex-1"
                :placeholder="config.apiKeyConfigured ? 'Enter replacement key' : 'Enter API key'"
              />
              <button
                type="submit"
                data-scribe-save-api-key
                class="scribe-settings-button"
                :disabled="!apiKey.trim() || Boolean(pending['api-key'])"
              >
                {{ pending['api-key'] ? 'Saving…' : config.apiKeyConfigured ? 'Replace key' : 'Save key' }}
              </button>
              <button
                v-if="config.apiKeyConfigured"
                type="button"
                data-scribe-clear-api-key
                class="scribe-settings-button text-rem"
                :disabled="Boolean(pending['api-key'])"
                @click="$emit('clearApiKey')"
              >
                {{ pending['api-key'] ? 'Removing…' : 'Remove key' }}
              </button>
            </span>
          </form>
          <p
            v-if="credentialNotice"
            data-scribe-api-key-feedback
            class="text-[9px] leading-relaxed text-add"
            role="status"
          >
            {{ credentialNotice }}
          </p>
          <p
            v-if="credentialError"
            data-scribe-api-key-error
            class="text-[9px] leading-relaxed text-rem"
            role="alert"
          >
            {{ credentialError }}
          </p>
          <details class="border-t border-rule-light pt-3">
            <summary class="cursor-pointer text-[10px] text-ink-3 hover:text-ink">
              Advanced endpoint
            </summary>
            <div class="mt-3 space-y-3">
              <label class="block">
                <span class="scribe-settings-label">Endpoint URL</span>
                <input
                  v-model="customUrl"
                  type="url"
                  class="scribe-settings-input"
                  placeholder="https://api.openai.com/v1/realtime"
                  aria-describedby="scribe-custom-route-help"
                  :disabled="configPending"
                  @change="save({ customUrl })"
                />
              </label>
              <label class="block">
                <span class="scribe-settings-label">Model</span>
                <input
                  v-model="customModel"
                  class="scribe-settings-input"
                  placeholder="gpt-live-transcribe"
                  :disabled="configPending"
                  @change="save({ customModel })"
                />
              </label>
              <p id="scribe-custom-route-help" class="text-[9px] leading-relaxed text-ink-3">
                Custom endpoints require HTTPS and Mimir's STT WebSocket protocol. Both audio
                channels are sent to this URL.
              </p>
            </div>
          </details>
        </div>
      </section>

      <section class="py-4">
        <h3 class="text-[11px] font-semibold">After the meeting</h3>
        <label class="scribe-setting-row">
          <span>
            <strong>Create title and summary</strong>
          </span>
          <input
            data-scribe-summary-enabled
            type="checkbox"
            :checked="config.summaryEnabled"
            :disabled="configPending"
            @change="save({ summaryEnabled: $event.target.checked })"
          />
        </label>
        <div v-if="config.summaryEnabled" class="mt-3 grid gap-3 sm:grid-cols-2">
          <div class="block">
            <span class="scribe-settings-label">Summary format</span>
            <ScribeSelect
              :model-value="config.summaryTemplate || 'standard'"
              :options="summaryTemplateOptions"
              :disabled="configPending"
              aria-label="Summary format"
              @update:model-value="selectSummaryTemplate"
            />
          </div>
          <div class="block">
            <span class="scribe-settings-label">CLI agent</span>
            <ScribeSelect
              :model-value="config.summaryPreset || ''"
              :options="summaryAgentOptions"
              :disabled="configPending"
              aria-label="Summary CLI agent"
              @update:model-value="save({ summaryPreset: $event })"
            />
          </div>
        </div>
        <div v-if="config.summaryEnabled" class="mt-3">
          <div class="mb-1 flex items-center gap-2">
            <label for="scribe-summary-prompt" class="scribe-settings-label mb-0 flex-1">
              Summary prompt
            </label>
            <button
              type="button"
              class="text-[9px] text-ink-3 underline underline-offset-2 hover:text-ink"
              :disabled="configPending"
              @click="resetSummaryPrompt"
            >
              Reset to preset
            </button>
          </div>
          <textarea
            id="scribe-summary-prompt"
            v-model="summaryPrompt"
            data-scribe-summary-prompt
            rows="10"
            maxlength="16000"
            class="scribe-settings-textarea"
            :disabled="configPending"
          />
          <div class="mt-2 flex justify-end">
            <button
              type="button"
              data-scribe-save-summary-prompt
              class="scribe-settings-button"
              :disabled="configPending || !summaryPrompt.trim() || !summaryPromptChanged"
              @click="saveSummaryPrompt"
            >
              Save prompt
            </button>
          </div>
        </div>
      </section>

      <section class="py-4">
        <h3 class="text-[11px] font-semibold">Retention</h3>
        <div class="mt-3 block">
          <span class="scribe-settings-label">Keep source audio</span>
          <ScribeSelect
            :model-value="retentionValue"
            :options="retentionOptions"
            :disabled="configPending"
            aria-label="Keep source audio"
            @update:model-value="saveRetention"
          />
        </div>
        <p class="mt-2 text-[9px] leading-relaxed text-ink-3">
          Recovery and active jobs may keep audio longer.
        </p>
      </section>
    </div>
  </section>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { IconX } from '@tabler/icons-vue'
import ScribeSelect from './ScribeSelect.vue'
import {
  SUMMARY_TEMPLATE_OPTIONS,
  summaryAgentOptions as buildSummaryAgentOptions,
  summaryPromptFor,
} from './summaryRecipes.js'

const props = defineProps({
  config: { type: Object, required: true },
  permissions: { type: Object, required: true },
  models: { type: Array, default: () => [] },
  audioCheck: { type: Object, default: null },
  audioTesting: { type: Boolean, default: false },
  microphoneCatalog: {
    type: Object,
    default: () => ({ devices: [], fallbackReason: null }),
  },
  pending: { type: Object, default: () => ({}) },
  embedded: { type: Boolean, default: false },
  credentialNotice: { type: String, default: '' },
  credentialError: { type: String, default: '' },
  summaryAgents: { type: Array, default: () => [] },
})
const emit = defineEmits([
  'close',
  'save',
  'saveApiKey',
  'clearApiKey',
  'installModel',
  'deleteModel',
  'requestMicrophonePermission',
  'openSystemAudioSettings',
  'checkAudio',
])

const settingsRoot = ref(null)
const customUrl = ref(props.config.customUrl)
const customModel = ref(props.config.customModel)
const apiKey = ref('')
const summaryPrompt = ref(
  props.config.summaryPrompt || summaryPromptFor(props.config.summaryTemplate),
)
const OPENAI_REALTIME_URL = 'https://api.openai.com/v1/realtime'
const OPENAI_TRANSCRIPTION_MODEL = 'gpt-live-transcribe'
const configPending = computed(() => Boolean(props.pending.config))
const isOpenAiEndpoint = computed(() => {
  try {
    const endpoint = new URL(customUrl.value)
    return endpoint.hostname === 'api.openai.com'
      && endpoint.pathname.replace(/\/+$/u, '') === '/v1/realtime'
      && customModel.value.startsWith('gpt-')
  } catch {
    return false
  }
})
const hostedDescription = computed(() => (
  isOpenAiEndpoint.value
    ? 'Sends microphone and system audio to OpenAI.'
    : 'Sends microphone and system audio to the configured HTTPS service.'
))
const hostedKeyLabel = computed(() => (
  isOpenAiEndpoint.value ? 'OpenAI API key' : 'Hosted transcription API key'
))
const retentionValue = computed(() => (
  props.config.retentionDays == null ? 'forever' : String(props.config.retentionDays)
))
const summaryTemplateOptions = SUMMARY_TEMPLATE_OPTIONS
const microphoneOptions = computed(() => [
  { value: '', label: 'System default' },
  ...(props.microphoneCatalog.devices || []).map(device => ({
    value: device.id,
    label: `${device.name}${device.isDefault ? ' · Default' : ''}`,
  })),
])
const summaryPromptChanged = computed(() => (
  summaryPrompt.value !== (
    props.config.summaryPrompt || summaryPromptFor(props.config.summaryTemplate)
  )
))
const summaryAgentOptions = computed(() => buildSummaryAgentOptions(
  props.summaryAgents.map(option => ({
    id: option.id ?? option.value,
    title: option.title ?? option.label,
    kind: 'agent',
    enabled: option.enabled !== false,
    available: option.available !== false,
  })),
  props.config.summaryPreset,
))
const retentionOptions = [
  { value: '0', label: 'Delete after final transcript' },
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: 'forever', label: 'Until I delete it' },
]

watch(() => props.config.customUrl, value => { customUrl.value = value })
watch(() => props.config.customModel, value => { customModel.value = value })
watch(
  () => [props.config.summaryPrompt, props.config.summaryTemplate],
  ([prompt, template]) => { summaryPrompt.value = prompt || summaryPromptFor(template) },
)
watch(() => props.credentialNotice, value => {
  if (value) apiKey.value = ''
})

function save(patch) {
  emit('save', patch)
}

function selectSummaryTemplate(template) {
  summaryPrompt.value = summaryPromptFor(template)
  save({ summaryTemplate: template, summaryPrompt: summaryPrompt.value })
}

function resetSummaryPrompt() {
  summaryPrompt.value = summaryPromptFor(props.config.summaryTemplate)
}

function saveSummaryPrompt() {
  if (!summaryPrompt.value.trim() || !summaryPromptChanged.value) return
  save({ summaryPrompt: summaryPrompt.value })
}

function selectMode(mode) {
  if (mode === 'local') {
    save({ transcriptionMode: 'local' })
    return
  }
  save({
    transcriptionMode: 'custom',
    customUrl: props.config.customUrl || OPENAI_REALTIME_URL,
    customModel: props.config.customModel || OPENAI_TRANSCRIPTION_MODEL,
  })
}

function saveKey() {
  if (!apiKey.value.trim()) return
  emit('saveApiKey', apiKey.value)
}

function saveRetention(value) {
  save({ retentionDays: value === 'forever' ? null : Number(value) })
}

function focusEntry() {
  settingsRoot.value?.querySelector('button, input, [tabindex="0"]')?.focus()
}

defineExpose({ focusEntry })

function close(event) {
  if (props.embedded) return
  event?.preventDefault()
  event?.stopPropagation()
  emit('close')
}

function onModeKeydown(event) {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
    return
  }
  const custom = ['ArrowRight', 'ArrowDown', 'End'].includes(event.key)
  const mode = custom ? 'custom' : 'local'
  event.preventDefault()
  selectMode(mode)
  event.currentTarget
    ?.parentElement
    ?.querySelector(`[role="radio"]:nth-child(${custom ? 2 : 1})`)
    ?.focus()
}

function modelStatus(model) {
  if (model.status === 'downloading') {
    return `Downloading ${modelProgress(model)}%`
  }
  if (model.status === 'installed') {
    return `${formatBytes(model.bytes)} · Installed`
  }
  if (model.error) return model.error
  return `${formatBytes(model.bytes)} download`
}

function modelProgress(model) {
  const total = Math.max(1, model.bytes)
  return Math.min(100, Math.round((model.downloadedBytes / total) * 100))
}

function permissionLabel(value) {
  return ({
    granted: 'Granted',
    denied: 'Denied — use the repair action below',
    'prompt-on-start': 'Requested on first use',
    restricted: 'Restricted by macOS',
    unknown: 'Not checked',
    'development-host': 'Development host — not Mimir',
  })[value] || String(value || 'Unknown').replaceAll('-', ' ')
}

function audioSourceLevel(value) {
  if (typeof value === 'number') return Math.min(100, Math.max(0, value))
  return Math.min(100, Math.max(0, Number(value?.level) || 0))
}

function formatBytes(bytes) {
  const amount = Math.max(0, Number(bytes) || 0)
  if (amount < 1024) return `${amount} B`
  if (amount < 1024 ** 2) return `${Math.round(amount / 1024)} KB`
  if (amount < 1024 ** 3) return `${Math.round(amount / 1024 ** 2)} MB`
  return `${(amount / 1024 ** 3).toFixed(1)} GB`
}
</script>

<style scoped>
.scribe-setting-row {
  display: flex;
  min-height: 48px;
  align-items: center;
  gap: 12px;
  border-bottom: 1px solid var(--color-rule-light);
  padding: 9px 0;
}

.scribe-setting-row > span {
  min-width: 0;
  flex: 1;
}

.scribe-setting-row strong {
  display: block;
  font-size: 10px;
  font-weight: 500;
}

.scribe-setting-row small {
  display: block;
  margin-top: 2px;
  color: var(--color-ink-3);
  font-size: 9px;
  line-height: 1.45;
}

.scribe-settings-label {
  display: block;
  margin-bottom: 4px;
  color: var(--color-ink-3);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 9px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.scribe-settings-input {
  width: 100%;
  height: 32px;
  border: 1px solid var(--color-rule);
  background: var(--color-surface);
  padding: 0 8px;
  color: var(--color-ink);
  font-size: 10px;
  outline: none;
}

.scribe-settings-textarea {
  min-height: 190px;
  width: 100%;
  resize: vertical;
  border: 1px solid var(--color-rule);
  background: var(--color-surface);
  padding: 9px;
  color: var(--color-ink);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px;
  line-height: 1.55;
  outline: none;
}

.scribe-settings-textarea:focus {
  border-color: var(--color-accent);
}

.scribe-settings-input:focus {
  border-color: var(--color-accent);
}

.scribe-settings-input:focus-visible,
.scribe-settings-textarea:focus-visible,
.scribe-settings-button:focus-visible,
[role='radio']:focus-visible,
input[type='checkbox']:focus-visible {
  outline: 1px solid var(--color-accent);
  outline-offset: 1px;
}

.scribe-settings-button {
  min-height: 30px;
  border: 1px solid var(--color-rule);
  padding: 0 9px;
  font-size: 9px;
  font-weight: 600;
}

.scribe-settings-button:hover:not(:disabled) {
  background: var(--color-chrome-mid);
}

.scribe-settings-button:disabled {
  cursor: default;
  opacity: 0.45;
}

.scribe-audio-level {
  display: block;
  height: 3px;
  overflow: hidden;
  background: var(--color-rule-light);
}

.scribe-audio-level > span {
  display: block;
  height: 100%;
  background: var(--color-accent);
  transition: width 160ms ease-out;
}

@media (prefers-reduced-motion: reduce) {
  .scribe-audio-level > span {
    transition: none;
  }
}
</style>
