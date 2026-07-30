<template>
  <section
    data-scribe-settings-panel
    :class="embedded ? 'min-h-full' : 'h-full overflow-y-auto'"
  >
    <header v-if="!embedded" class="flex h-10 items-center border-b border-rule px-4">
      <h2 class="flex-1 text-[11px] font-semibold">Scribe settings</h2>
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
        <label class="scribe-setting-row">
          <span>
            <strong>Detect meeting apps</strong>
            <small>Show a local recording suggestion after sustained meeting activity.</small>
          </span>
          <input
            type="checkbox"
            :checked="config.detectionEnabled"
            @change="save({ detectionEnabled: $event.target.checked })"
          />
        </label>
        <dl class="mt-3 grid grid-cols-[130px_1fr] border-t border-rule-light text-[10px]">
          <dt class="border-b border-rule-light py-2 font-mono text-ink-3">Microphone</dt>
          <dd class="border-b border-rule-light py-2">{{ permissions.microphone }}</dd>
          <dt class="border-b border-rule-light py-2 font-mono text-ink-3">System audio</dt>
          <dd class="border-b border-rule-light py-2">{{ permissions.systemAudio }}</dd>
        </dl>
        <button
          v-if="permissions.microphone !== 'granted'"
          type="button"
          data-scribe-grant-microphone
          class="scribe-settings-button mt-3"
          :disabled="Boolean(pending['microphone-permission'])"
          @click="$emit('requestMicrophonePermission')"
        >
          Grant microphone access
        </button>
      </section>

      <section class="py-4">
        <h3 class="text-[11px] font-semibold">Transcription</h3>
        <div class="mt-3 grid grid-cols-2 border border-rule">
          <button
            type="button"
            class="h-9 border-r border-rule text-[10px]"
            :class="config.transcriptionMode === 'local'
              ? 'bg-accent-soft text-ink'
              : 'bg-chrome-high text-ink-3 hover:bg-chrome-mid'"
            :aria-pressed="config.transcriptionMode === 'local'"
            @click="save({ transcriptionMode: 'local' })"
          >
            Local model
          </button>
          <button
            type="button"
            class="h-9 text-[10px]"
            :class="config.transcriptionMode === 'custom'
              ? 'bg-accent-soft text-ink'
              : 'bg-chrome-high text-ink-3 hover:bg-chrome-mid'"
            :aria-pressed="config.transcriptionMode === 'custom'"
            @click="save({ transcriptionMode: 'custom' })"
          >
            Custom URL
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
            </span>
            <button
              v-if="model.status !== 'installed'"
              type="button"
              class="scribe-settings-button"
              :disabled="Boolean(pending[`model:${model.id}`])"
              @click="$emit('installModel', model.id)"
            >
              Install
            </button>
            <button
              v-else
              type="button"
              class="scribe-settings-button text-rem"
              :disabled="Boolean(pending[`model:${model.id}`])"
              @click="$emit('deleteModel', model.id)"
            >
              Remove
            </button>
          </div>
        </div>

        <div v-else class="mt-3 space-y-3">
          <label class="block">
            <span class="scribe-settings-label">Endpoint URL</span>
            <input
              v-model="customUrl"
              type="url"
              class="scribe-settings-input"
              placeholder="https://stt.example.com/v1/listen"
              @change="save({ customUrl })"
            />
          </label>
          <label class="block">
            <span class="scribe-settings-label">Model</span>
            <input
              v-model="customModel"
              class="scribe-settings-input"
              placeholder="Provider model name"
              @change="save({ customModel })"
            />
          </label>
          <label class="block">
            <span class="scribe-settings-label">API key</span>
            <span class="flex gap-2">
              <input
                v-model="apiKey"
                type="password"
                autocomplete="new-password"
                class="scribe-settings-input min-w-0 flex-1"
                :placeholder="config.apiKeyConfigured ? 'Stored in Keychain' : 'Enter API key'"
              />
              <button
                type="button"
                class="scribe-settings-button"
                :disabled="!apiKey.trim() || Boolean(pending['api-key'])"
                @click="saveKey"
              >
                Save key
              </button>
              <button
                v-if="config.apiKeyConfigured"
                type="button"
                class="scribe-settings-button text-rem"
                :disabled="Boolean(pending['api-key'])"
                @click="$emit('clearApiKey')"
              >
                Clear
              </button>
            </span>
          </label>
          <p class="text-[9px] leading-relaxed text-ink-3">
            Remote URLs must use HTTPS; Mimir upgrades the connection to secure WebSocket.
            The key remains native and is never returned to the renderer.
          </p>
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
            type="checkbox"
            :checked="config.summaryEnabled"
            @change="save({ summaryEnabled: $event.target.checked })"
          />
        </label>
        <label class="mt-3 block">
          <span class="scribe-settings-label">Knowledge-graph follow-up</span>
          <select
            :value="config.kgPrompt"
            class="scribe-settings-input"
            @change="save({ kgPrompt: $event.target.value })"
          >
            <option value="ask">Ask every time</option>
            <option value="always-draft">Always create a reviewable draft</option>
            <option value="never">Never ask</option>
          </select>
        </label>
      </section>

      <section class="py-4">
        <h3 class="text-[11px] font-semibold">Retention</h3>
        <label class="mt-3 block">
          <span class="scribe-settings-label">Keep source audio</span>
          <select
            :value="retentionValue"
            class="scribe-settings-input"
            @change="saveRetention($event.target.value)"
          >
            <option value="0">Delete after final transcript</option>
            <option value="7">7 days</option>
            <option value="30">30 days</option>
            <option value="90">90 days</option>
            <option value="forever">Until I delete it</option>
          </select>
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

const props = defineProps({
  config: { type: Object, required: true },
  permissions: { type: Object, required: true },
  models: { type: Array, default: () => [] },
  pending: { type: Object, default: () => ({}) },
  embedded: { type: Boolean, default: false },
})
const emit = defineEmits([
  'close',
  'save',
  'saveApiKey',
  'clearApiKey',
  'installModel',
  'deleteModel',
  'requestMicrophonePermission',
])

const customUrl = ref(props.config.customUrl)
const customModel = ref(props.config.customModel)
const apiKey = ref('')
const retentionValue = computed(() => (
  props.config.retentionDays == null ? 'forever' : String(props.config.retentionDays)
))

watch(() => props.config.customUrl, value => { customUrl.value = value })
watch(() => props.config.customModel, value => { customModel.value = value })

function save(patch) {
  emit('save', patch)
}

function saveKey() {
  if (!apiKey.value.trim()) return
  emit('saveApiKey', apiKey.value)
  apiKey.value = ''
}

function saveRetention(value) {
  save({ retentionDays: value === 'forever' ? null : Number(value) })
}

function modelStatus(model) {
  if (model.status === 'downloading') {
    const total = Math.max(1, model.bytes)
    return `Downloading ${Math.round((model.downloadedBytes / total) * 100)}%`
  }
  if (model.status === 'installed') {
    return `${formatBytes(model.bytes)} · checksum verified`
  }
  if (model.error) return model.error
  return `${formatBytes(model.bytes)} download`
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
</style>
