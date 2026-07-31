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
      :pending="meetings.pending"
      @save="run('Settings saved.', meetings.saveConfig, $event)"
      @save-api-key="run('API key stored in Keychain.', meetings.saveApiKey, $event)"
      @clear-api-key="run('API key removed.', meetings.clearApiKey)"
      @install-model="run('Model installation started.', meetings.installModel, $event)"
      @delete-model="run('Model removed.', meetings.deleteModel, $event)"
      @request-microphone-permission="
        run('Microphone access granted.', meetings.requestMicrophonePermission)
      "
      @open-system-audio-settings="
        run('System Settings opened to Screen & System Audio Recording.', meetings.openSystemAudioSettings)
      "
    />
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { useMeetingsStore } from '../../../stores/meetings.js'
import ScribeSettings from '../../../mimir/apps/scribe/ScribeSettings.vue'

const meetings = useMeetingsStore()
const status = ref('')
const failed = ref(false)

onMounted(async () => {
  try {
    await meetings.initialize()
  } catch (error) {
    failed.value = true
    status.value = message(error)
  }
})

async function run(success, operation, value) {
  failed.value = false
  status.value = ''
  try {
    await operation(value)
    status.value = success
  } catch (error) {
    failed.value = true
    status.value = message(error)
  }
}

function message(error) {
  return error instanceof Error ? error.message : String(error || 'Scribe setting failed.')
}
</script>
