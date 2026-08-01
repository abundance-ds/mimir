<template>
  <div data-settings-scribe class="-mx-6 -my-5 min-h-full">
    <div
      v-if="status"
      :class="failed ? 'text-rem' : 'text-ink-2'"
      class="border-b border-rule px-4 py-2 text-[10px]"
      :role="failed ? 'alert' : 'status'"
    >
      {{ status }}
    </div>
    <ScribeSettings
      embedded
      :config="meetings.config"
      :permissions="meetings.permissions"
      :models="meetings.models"
      :audio-check="meetings.audioCheck"
      :audio-testing="meetings.audioTesting"
      :microphone-catalog="meetings.microphoneCatalog"
      :pending="meetings.pending"
      :summary-agents="summaryAgents"
      :credential-notice="credentialNotice"
      :credential-error="credentialError"
      @save="run(meetings.saveConfig, $event)"
      @save-api-key="saveApiKey"
      @clear-api-key="clearApiKey"
      @install-model="run(meetings.installModel, $event)"
      @delete-model="run(meetings.deleteModel, $event)"
      @request-microphone-permission="
        run(meetings.requestMicrophonePermission)
      "
      @open-system-audio-settings="
        run(meetings.openSystemAudioSettings)
      "
      @check-audio="run(meetings.checkAudio)"
    />
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useLaunchersStore } from '../../../stores/launchers.js'
import { useMeetingsStore } from '../../../stores/meetings.js'
import ScribeSettings from '../../../mimir/apps/scribe/ScribeSettings.vue'

const meetings = useMeetingsStore()
const launchers = useLaunchersStore()
const status = ref('')
const failed = ref(false)
const credentialNotice = ref('')
const credentialError = ref('')
const summaryAgents = computed(() => launchers.availablePresets.filter(
  preset => preset.kind === 'agent',
))

onMounted(async () => {
  try {
    await meetings.initialize()
    await meetings.refreshMicrophones()
  } catch (error) {
    failed.value = true
    status.value = message(error)
  }
})

async function run(operation, value) {
  failed.value = false
  status.value = ''
  try {
    await operation(value)
  } catch (error) {
    failed.value = true
    status.value = message(error)
  }
}

async function saveApiKey(value) {
  credentialNotice.value = ''
  credentialError.value = ''
  try {
    const replacing = meetings.config.apiKeyConfigured
    const configured = await meetings.saveApiKey(value)
    if (!configured) throw new Error('Keychain did not confirm the saved API key.')
    credentialNotice.value = replacing
      ? 'API key replaced and verified in Keychain.'
      : 'API key saved and verified in Keychain.'
  } catch (error) {
    credentialError.value = message(error)
  }
}

async function clearApiKey() {
  credentialNotice.value = ''
  credentialError.value = ''
  try {
    const configured = await meetings.clearApiKey()
    if (configured) throw new Error('Keychain still reports an API key after removal.')
    credentialNotice.value = 'API key removed from Keychain.'
  } catch (error) {
    credentialError.value = message(error)
  }
}

function message(error) {
  return error instanceof Error ? error.message : String(error || 'Scribe setting failed.')
}
</script>
