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
        <h3 class="text-[11px] font-semibold">Capture and detection</h3>
        <p class="mt-1 text-[10px] leading-relaxed text-ink-3">
          Detection suggests a recording after sustained meeting activity. Starting capture
          always remains a deliberate human action.
        </p>
        <p
          v-if="configPending"
          data-scribe-config-pending
          class="mt-2 border-y border-rule-light py-2 font-mono text-[9px] text-ink-3"
          role="status"
        >
          Saving settings… further changes will follow in order.
        </p>
        <label class="scribe-setting-row">
          <span>
            <strong>Detect meeting apps</strong>
            <small>Show a local recording suggestion after sustained meeting activity.</small>
          </span>
          <input
            data-scribe-detection
            type="checkbox"
            :checked="config.detectionEnabled"
            :disabled="configPending"
            @change="save({ detectionEnabled: $event.target.checked })"
          />
        </label>
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
          This development build is running under another macOS host. Its permission is not
          Mimir's permission; use the installed Mimir app for the final permission check.
        </p>
        <div class="mt-3 border-t border-rule-light pt-3">
          <div class="flex items-start gap-3">
            <p class="min-w-0 flex-1 text-[9px] leading-relaxed text-ink-3">
              Play sound in any app, then check both inputs for four seconds. Samples are
              discarded immediately and no meeting is created.
            </p>
            <button
              type="button"
              data-scribe-check-audio
              class="scribe-settings-button shrink-0"
              :disabled="Boolean(pending['audio-check'])"
              @click="$emit('checkAudio')"
            >
              {{ pending['audio-check'] ? 'Checking…' : 'Check audio' }}
            </button>
          </div>
          <dl
            v-if="audioCheck"
            data-scribe-audio-check-result
            class="mt-2 grid grid-cols-[130px_1fr] border-t border-rule-light text-[10px]"
            role="status"
          >
            <dt class="border-b border-rule-light py-2 font-mono text-ink-3">Microphone</dt>
            <dd class="border-b border-rule-light py-2">
              <span>{{ signalLabel(audioCheck.microphone) }}</span>
              <span
                data-scribe-audio-level="microphone"
                class="scribe-audio-level"
                role="progressbar"
                aria-label="Microphone input level"
                aria-valuemin="0"
                aria-valuemax="100"
                :aria-valuenow="audioCheck.microphoneLevel"
              >
                <span :style="{ width: `${audioCheck.microphoneLevel}%` }" />
              </span>
            </dd>
            <dt class="border-b border-rule-light py-2 font-mono text-ink-3">System audio</dt>
            <dd class="border-b border-rule-light py-2">
              <span>{{ signalLabel(audioCheck.systemAudio) }}</span>
              <span
                data-scribe-audio-level="system"
                class="scribe-audio-level"
                role="progressbar"
                aria-label="System-audio input level"
                aria-valuemin="0"
                aria-valuemax="100"
                :aria-valuenow="audioCheck.systemAudioLevel"
              >
                <span :style="{ width: `${audioCheck.systemAudioLevel}%` }" />
              </span>
            </dd>
          </dl>
          <p
            v-if="audioCheck?.runtimeIdentity === 'development-host'"
            class="mt-2 text-[9px] leading-relaxed text-rem"
          >
            These results belong to the development host, not the installed Mimir app.
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
              : 'Set up system audio'
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
          <p class="text-[10px] leading-relaxed text-ink-3">
            Local mode stays on this Mac. Mimir will not silently fall back to a network provider.
          </p>
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
            {{ config.apiKeyConfigured ? 'Saved in Keychain · ready to use' : 'API key required' }}
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
          <p class="text-[9px] leading-relaxed text-ink-3">
            Stored in Keychain and never returned to this screen.
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
                OpenAI Realtime uses <code>/v1/realtime</code>. Other URLs must implement
                Mimir's versioned STT WebSocket contract. Both audio channels are sent only
                to the exact HTTPS destination shown here.
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
            <small>Runs after the transcript reaches a terminal revision.</small>
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
          <label class="block">
            <span class="scribe-settings-label">Summary format</span>
            <ScribeSelect
              :model-value="config.summaryTemplate || 'standard'"
              :options="summaryTemplateOptions"
              :disabled="configPending"
              aria-label="Summary format"
              @update:model-value="save({ summaryTemplate: $event })"
            />
          </label>
          <label class="block">
            <span class="scribe-settings-label">CLI agent</span>
            <ScribeSelect
              :model-value="config.summaryPreset || ''"
              :options="summaryAgentOptions"
              :disabled="configPending"
              aria-label="Summary CLI agent"
              @update:model-value="save({ summaryPreset: $event })"
            />
          </label>
        </div>
        <p v-if="config.summaryEnabled" class="mt-2 text-[9px] leading-relaxed text-ink-3">
          This recipe is used after future meetings and when you deliberately create a summary again.
        </p>
        <label class="mt-3 block">
          <span class="scribe-settings-label">Knowledge-graph follow-up</span>
          <ScribeSelect
            :model-value="config.kgPrompt"
            :options="kgPromptOptions"
            :disabled="configPending"
            aria-label="Knowledge-graph follow-up"
            @update:model-value="save({ kgPrompt: $event })"
          />
        </label>
      </section>

      <section class="py-4">
        <h3 class="text-[11px] font-semibold">Retention</h3>
        <label class="mt-3 block">
          <span class="scribe-settings-label">Keep source audio</span>
          <ScribeSelect
            :model-value="retentionValue"
            :options="retentionOptions"
            :disabled="configPending"
            aria-label="Keep source audio"
            @update:model-value="saveRetention"
          />
        </label>
        <p class="mt-2 text-[9px] leading-relaxed text-ink-3">
          Recovery-required audio and audio used by an active follow-up job are held until safe.
        </p>
      </section>
    </div>
  </section>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { IconX } from '@tabler/icons-vue'
import ScribeSelect from './ScribeSelect.vue'
import { SUMMARY_TEMPLATE_OPTIONS, summaryAgentOptions as buildSummaryAgentOptions } from './summaryRecipes.js'

const props = defineProps({
  config: { type: Object, required: true },
  permissions: { type: Object, required: true },
  models: { type: Array, default: () => [] },
  audioCheck: { type: Object, default: null },
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
    ? 'Streams both sides of the meeting to OpenAI for low-latency transcription.'
    : 'Streams both sides of the meeting only to the configured HTTPS transcription service.'
))
const hostedKeyLabel = computed(() => (
  isOpenAiEndpoint.value ? 'OpenAI API key' : 'Hosted transcription API key'
))
const retentionValue = computed(() => (
  props.config.retentionDays == null ? 'forever' : String(props.config.retentionDays)
))
const summaryTemplateOptions = SUMMARY_TEMPLATE_OPTIONS
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
const kgPromptOptions = [
  { value: 'ask', label: 'Ask every time' },
  { value: 'always-draft', label: 'Always create a reviewable draft' },
  { value: 'never', label: 'Never ask' },
]
const retentionOptions = [
  { value: '0', label: 'Delete after final transcript' },
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: 'forever', label: 'Until I delete it' },
]

watch(() => props.config.customUrl, value => { customUrl.value = value })
watch(() => props.config.customModel, value => { customModel.value = value })
watch(() => props.credentialNotice, value => {
  if (value) apiKey.value = ''
})

function save(patch) {
  emit('save', patch)
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
    return `${formatBytes(model.bytes)} · checksum verified`
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
    'prompt-on-start': 'Set up before the first recording',
    restricted: 'Restricted by macOS',
    unknown: 'Not checked',
    'development-host': 'Development host — not Mimir',
  })[value] || String(value || 'Unknown').replaceAll('-', ' ')
}

function signalLabel(value) {
  return ({
    signal: 'Signal detected',
    silent: 'No sound detected — play audio and retry',
    'no-data': 'No frames received',
  })[value] || 'Not checked'
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

.scribe-settings-input:focus {
  border-color: var(--color-accent);
}

.scribe-settings-input:focus-visible,
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
  margin-top: 5px;
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
