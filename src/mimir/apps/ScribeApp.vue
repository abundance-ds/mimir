<template>
  <section
    ref="scribeRoot"
    data-scribe-app
    class="flex h-full min-h-0 flex-col overflow-hidden bg-chrome-high text-ink"
  >
    <template v-if="settingsOpen">
      <header class="scribe-bar">
        <button type="button" class="scribe-quiet-button" @click="closeSettings">
          <IconChevronLeft :size="14" />
          Back
        </button>
        <span class="min-w-0 flex-1 truncate text-[11px] font-semibold">Scribe settings</span>
      </header>
      <div class="min-h-0 flex-1 overflow-y-auto">
        <ScribeSettings
          ref="settingsPanel"
          embedded
          :config="meetings.config"
          :permissions="meetings.permissions"
          :models="meetings.models"
          :audio-check="meetings.audioCheck"
          :pending="meetings.pending"
          :credential-notice="credentialNotice"
          :credential-error="credentialError"
          :summary-agents="availableSummaryAgents"
          @save="saveConfig"
          @save-api-key="saveApiKey"
          @clear-api-key="clearApiKey"
          @install-model="installModel"
          @delete-model="deleteModel"
          @request-microphone-permission="requestMicrophonePermission"
          @open-system-audio-settings="openSystemAudioSettings"
          @check-audio="checkAudio"
        />
      </div>
    </template>

    <template v-else-if="meetings.activeMeeting">
      <header class="scribe-transport">
        <span class="size-2 shrink-0 rounded-full bg-rem" aria-hidden="true" />
        <span data-scribe-recording-label class="font-mono text-[11px] tabular-nums">
          {{ meetings.recording ? 'Recording' : 'Finalizing' }} {{ formattedElapsed }}
        </span>
        <span class="min-w-0 flex-1 truncate text-[10px] text-ink-3">
          {{ meetings.activeMeeting.title }}
        </span>
        <button
          v-if="meetings.recording"
          type="button"
          data-scribe-mute
          class="scribe-quiet-button"
          :aria-pressed="meetings.activeMeeting.micMuted"
          :disabled="Boolean(meetings.pending.mic)"
          @click="toggleMute"
        >
          <IconMicrophoneOff v-if="meetings.activeMeeting.micMuted" :size="14" />
          <IconMicrophone v-else :size="14" />
          {{ meetings.activeMeeting.micMuted ? 'Unmute' : 'Mute' }}
        </button>
        <button
          type="button"
          data-scribe-stop
          class="scribe-stop-button"
          :disabled="!meetings.recording || Boolean(meetings.pending.stop)"
          @click="stop"
        >
          <IconPlayerStopFilled :size="12" />
          {{ meetings.pending.stop ? 'Stopping…' : 'Stop' }}
        </button>
      </header>

      <div data-scribe-ledger class="scribe-capture-status" role="status">
        <span>{{ captureStatus }}</span>
        <span class="text-ink-3">{{ transcriptionStatus }}</span>
      </div>

      <div v-if="recordingNotice" data-scribe-error class="scribe-inline-notice" role="status">
        <IconAlertTriangle :size="13" class="mt-px shrink-0" />
        <span class="min-w-0 flex-1">{{ recordingNotice }}</span>
        <button type="button" class="shrink-0 underline underline-offset-2" @click="dismissNotice">
          Dismiss
        </button>
      </div>

      <main class="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <div class="mx-auto max-w-3xl">
          <p v-if="!liveLedger.length" class="py-16 text-center text-[11px] text-ink-3">
            {{ emptyLiveTranscript }}
          </p>
          <ol
            v-else
            data-scribe-transcript-ledger
            aria-label="Live meeting transcript"
            class="divide-y divide-rule-light"
          >
            <li
              v-for="entry in liveLedger"
              :key="entry.key"
              data-scribe-ledger-kind
              :data-kind="entry.kind"
              class="grid grid-cols-[52px_70px_1fr] gap-3 py-3 text-[11px] leading-relaxed"
            >
              <time class="font-mono text-[9px] text-ink-3">{{ timestamp(entry.startMs) }}</time>
              <span class="text-[10px] font-medium">{{ entrySpeaker(entry) }}</span>
              <span v-if="entry.kind === 'gap'" class="text-rem">
                Capture gap · {{ gapDuration(entry) }}
              </span>
              <span v-else :class="entry.final ? 'text-ink-2' : 'text-ink-3'">
                {{ entry.text }}
                <em v-if="!entry.final" class="ml-1 text-[9px] not-italic">wording may change</em>
              </span>
            </li>
          </ol>
        </div>
      </main>
    </template>

    <template v-else-if="detailMeeting">
      <header class="scribe-bar">
        <button type="button" class="scribe-quiet-button" @click="closeDetail">
          <IconChevronLeft :size="14" />
          Meetings
        </button>
        <span class="min-w-0 flex-1" />
        <button type="button" class="scribe-quiet-button" @click="beginEdit">
          <IconEdit :size="13" />
          Edit
        </button>
        <button
          type="button"
          class="scribe-quiet-button"
          :disabled="meetingActionPending('export')"
          @click="exportSelected('markdown')"
        >
          <IconDownload :size="13" />
          Export
        </button>
        <button
          type="button"
          data-scribe-settings
          class="scribe-icon-button"
          aria-label="Scribe settings"
          @click="openSettings"
        >
          <IconSettings :size="14" />
        </button>
      </header>

      <article data-scribe-meeting class="min-h-0 flex-1 overflow-y-auto">
        <div class="mx-auto max-w-3xl px-5 py-6">
          <template v-if="editingMeeting">
            <form class="space-y-4" @submit.prevent="saveMeetingEdits">
              <label class="block">
                <span class="scribe-field-label">Title</span>
                <input v-model="editedTitle" data-scribe-edit-title class="scribe-input" />
              </label>
              <label class="block">
                <span class="scribe-field-label">Summary</span>
                <textarea
                  v-model="editedSummary"
                  data-scribe-edit-summary
                  rows="8"
                  class="scribe-input h-auto resize-y py-2"
                />
              </label>
              <label class="block">
                <span class="scribe-field-label">Tags, separated by commas</span>
                <input v-model="editedTags" data-scribe-edit-tags class="scribe-input" />
              </label>
              <p
                v-if="reviewedTagsError"
                data-scribe-edit-tags-error
                role="alert"
                class="text-[10px] text-rem"
              >
                {{ reviewedTagsError }}
              </p>
              <div class="flex gap-2">
                <button type="button" class="scribe-quiet-button" @click="editingMeeting = false">
                  Cancel
                </button>
                <button
                  type="submit"
                  data-scribe-save-review
                  class="scribe-primary-button"
                  :disabled="Boolean(reviewedTagsError)"
                >
                  Save changes
                </button>
              </div>
            </form>
          </template>

          <template v-else>
            <h1 class="text-[20px] font-semibold leading-tight">{{ detailMeeting.title }}</h1>
            <p class="mt-2 font-mono text-[9px] text-ink-3">
              {{ meetingDate(detailMeeting) }} · {{ formatDuration(detailMeeting.durationMs) }}
            </p>
            <ul
              v-if="detailMeeting.tags?.length"
              data-scribe-reviewed-tags
              aria-label="Reviewed tags"
              class="mt-2 flex flex-wrap gap-x-2 font-mono text-[9px] text-ink-3"
            >
              <li v-for="tag in detailMeeting.tags" :key="tag">{{ tag }}</li>
            </ul>

            <div
              v-if="meetingNeedsRecovery(detailMeeting)"
              class="scribe-inline-notice mt-5"
              role="status"
            >
              <IconAlertTriangle :size="13" class="mt-px shrink-0" />
              <span>{{ recoveryStatus(detailMeeting) }}</span>
            </div>

            <div class="mt-6 flex border-b border-rule" role="tablist" aria-label="Meeting review">
              <button
                v-for="tab in detailTabs"
                :id="`scribe-detail-tab-${tab.id}`"
                :key="tab.id"
                type="button"
                role="tab"
                class="scribe-tab"
                :class="detailTab === tab.id ? 'border-accent text-ink' : 'border-transparent text-ink-3'"
                :aria-selected="detailTab === tab.id"
                :aria-controls="`scribe-detail-panel-${tab.id}`"
                :tabindex="detailTab === tab.id ? 0 : -1"
                @click="detailTab = tab.id"
                @keydown="onDetailTabKeydown"
              >
                {{ tab.label }}
              </button>
            </div>

            <section
              v-if="detailTab === 'transcript'"
              id="scribe-detail-panel-transcript"
              role="tabpanel"
              aria-labelledby="scribe-detail-tab-transcript"
              class="py-3"
            >
              <p v-if="!detailLedger.length" class="py-12 text-center text-[11px] text-ink-3">
                No transcript text is available yet.
              </p>
              <ol v-else data-scribe-transcript-ledger class="divide-y divide-rule-light">
                <li
                  v-for="entry in detailLedger"
                  :key="entry.key"
                  data-scribe-ledger-kind
                  :data-kind="entry.kind"
                  class="grid grid-cols-[52px_70px_1fr] gap-3 py-3 text-[11px] leading-relaxed"
                >
                  <time class="font-mono text-[9px] text-ink-3">{{ timestamp(entry.startMs) }}</time>
                  <span class="text-[10px] font-medium">{{ entrySpeaker(entry) }}</span>
                  <span v-if="entry.kind === 'gap'" class="text-rem">Capture gap · {{ gapDuration(entry) }}</span>
                  <span v-else>{{ entry.text }}<em v-if="!entry.final" class="ml-1 text-[9px] not-italic text-ink-3">wording may change</em></span>
                </li>
              </ol>
              <button
                v-if="detailMeeting.transcriptHasMore"
                type="button"
                class="scribe-quiet-button mt-3"
                :disabled="Boolean(meetings.pending[`transcript:${detailMeeting.id}:older`])"
                @click="meetings.loadOlderTranscript(detailMeeting.id)"
              >
                Load earlier transcript
              </button>
            </section>

            <section
              v-else
              id="scribe-detail-panel-summary"
              role="tabpanel"
              aria-labelledby="scribe-detail-tab-summary"
              class="py-5"
            >
              <p v-if="detailMeeting.summary" class="whitespace-pre-wrap text-[12px] leading-7 text-ink-2">
                {{ detailMeeting.summary }}
              </p>
              <p v-else class="text-[11px] leading-relaxed text-ink-3">
                {{ summaryStatus(detailMeeting) }}
              </p>
              <div
                v-if="detailMeeting.transcriptFinal && detailMeeting.segmentCount > 0"
                data-scribe-summary-recipe
                class="mt-6 border-y border-rule py-4"
              >
                <p class="text-[10px] font-semibold">Create summary again</p>
                <p class="mt-1 text-[9px] leading-relaxed text-ink-3">
                  Choose the format and CLI agent for this run. The new result remains editable.
                </p>
                <div class="mt-3 grid gap-3 sm:grid-cols-2">
                  <label class="block">
                    <span class="scribe-field-label">Summary format</span>
                    <ScribeSelect
                      :model-value="meetings.config.summaryTemplate || 'standard'"
                      :options="summaryTemplateOptions"
                      :disabled="Boolean(meetings.pending.config)"
                      aria-label="Summary format for create again"
                      @update:model-value="saveConfig({ summaryTemplate: $event })"
                    />
                  </label>
                  <label class="block">
                    <span class="scribe-field-label">CLI agent</span>
                    <ScribeSelect
                      :model-value="meetings.config.summaryPreset || ''"
                      :options="summaryAgentOptions"
                      :disabled="Boolean(meetings.pending.config)"
                      aria-label="Summary CLI agent for create again"
                      @update:model-value="saveConfig({ summaryPreset: $event })"
                    />
                  </label>
                </div>
                <button
                  type="button"
                  data-scribe-regenerate-summary
                  class="scribe-primary-button mt-3"
                  :disabled="Boolean(meetings.pending.config)
                    || Boolean(meetings.pending[`retry:${detailMeeting.id}:title-summary`])
                    || ['queued', 'running'].includes(detailMeeting.summaryState)"
                  @click="regenerateSummary"
                >
                  {{ ['queued', 'running'].includes(detailMeeting.summaryState)
                    ? 'Summary in progress…'
                    : 'Create again' }}
                </button>
              </div>
              <div
                v-if="meetings.kgOffer?.id === detailMeeting.id"
                data-scribe-kg-offer
                class="mt-6 border-y border-rule py-4"
              >
                <p class="text-[11px] leading-relaxed text-ink-2">
                  Create reviewable knowledge-graph entries from this meeting?
                </p>
                <div class="mt-3 flex flex-wrap gap-2">
                  <button type="button" class="scribe-quiet-button" @click="decideKg(detailMeeting.id, 'not-now')">Not now</button>
                  <button type="button" class="scribe-primary-button" @click="decideKg(detailMeeting.id, 'create-draft')">Create KG draft</button>
                </div>
              </div>
            </section>

            <details class="mt-8 border-t border-rule pt-3">
              <summary class="cursor-pointer text-[10px] text-ink-3 hover:text-ink">More actions</summary>
              <div class="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  class="scribe-quiet-button"
                  :disabled="meetingActionPending('export:audio')"
                  @click="exportSelected('audio')"
                >
                  Export audio
                </button>
                <button
                  type="button"
                  data-scribe-delete-meeting
                  class="scribe-quiet-button text-rem"
                  :disabled="meetingActionPending('delete')"
                  @click="deleteSelected"
                >
                  <IconTrash :size="13" />
                  Delete meeting
                </button>
              </div>
            </details>
          </template>
        </div>
      </article>
    </template>

    <template v-else>
      <main class="min-h-0 flex-1 overflow-y-auto">
        <div class="mx-auto max-w-3xl px-5 py-8">
          <section class="border-b border-rule pb-7">
            <div class="flex items-start gap-3">
              <h1 class="min-w-0 flex-1 text-[20px] font-semibold leading-tight">
                Record this meeting
              </h1>
              <button
                type="button"
                data-scribe-settings
                class="scribe-icon-button shrink-0"
                aria-label="Scribe settings"
                @click="openSettings"
              >
                <IconSettings :size="14" />
              </button>
            </div>
            <p class="mt-2 max-w-xl text-[11px] leading-relaxed text-ink-3">
              Mimir records your microphone and system audio, transcribes while you talk,
              and prepares a title and summary when you stop.
            </p>
            <p data-scribe-route-disclosure class="mt-2 text-[10px] leading-relaxed text-ink-3">
              {{ routeDisclosure }}
            </p>
            <p class="mt-1 font-mono text-[9px] text-ink-3">{{ readyLabel }}</p>
            <button
              type="button"
              data-scribe-new
              class="scribe-record-button mt-5"
              :disabled="Boolean(meetings.pending.start) || !canStart"
              @click="start(null)"
            >
              <IconMicrophone :size="15" />
              {{ meetings.pending.start ? 'Starting recording…' : primaryActionLabel }}
            </button>
            <button
              v-if="!canStart"
              type="button"
              class="ml-2 text-[10px] text-ink-3 underline underline-offset-2 hover:text-ink"
              @click="openSettings"
            >
              Finish setup
            </button>
            <p v-if="homeNotice" data-scribe-error role="status" class="mt-3 text-[10px] leading-relaxed text-rem">
              {{ homeNotice }}
            </p>
          </section>

          <section v-if="meetings.candidates.length" data-scribe-candidates class="border-b border-rule py-4">
            <div
              v-for="candidate in meetings.candidates"
              :key="candidate.id"
              class="flex w-full min-w-0 items-center gap-3 py-1 pr-1"
            >
              <IconPhone :size="14" class="shrink-0 text-ink-2" />
              <p class="min-w-0 flex-1 truncate text-[11px]">
                {{ candidate.appName }} may be a meeting
              </p>
              <button type="button" class="scribe-quiet-button shrink-0" @click="start(candidate)">Record</button>
              <button
                type="button"
                class="scribe-icon-button"
                :aria-label="`Dismiss ${candidate.appName} suggestion`"
                @click="dismissCandidate(candidate.id)"
              >
                <IconX :size="13" />
              </button>
            </div>
          </section>

          <section class="pt-6" aria-labelledby="scribe-recent-title">
            <div class="flex items-center">
              <h2 id="scribe-recent-title" class="min-w-0 flex-1 text-[12px] font-semibold">Recent meetings</h2>
              <button
                type="button"
                class="scribe-quiet-button"
                :disabled="meetings.loading"
                @click="refresh"
              >
                <IconRefresh :size="13" />
                Refresh
              </button>
            </div>
            <p v-if="meetings.loading && !meetings.loaded" class="py-5 text-[10px] text-ink-3" role="status">
              Finding recent meetings…
            </p>
            <p v-else-if="!meetings.meetings.length" class="py-5 text-[10px] text-ink-3">
              Your completed meetings will appear here.
            </p>
            <div v-else class="mt-2 divide-y divide-rule-light border-t border-rule-light">
              <button
                v-for="meeting in meetings.meetings"
                :key="meeting.id"
                type="button"
                data-scribe-meeting-row
                class="scribe-meeting-row"
                @click="openMeeting(meeting.id)"
              >
                <span class="min-w-0 flex-1 text-left">
                  <span class="block truncate text-[11px] font-medium">{{ meeting.title }}</span>
                  <span class="mt-0.5 block font-mono text-[9px] text-ink-3">
                    {{ meetingDate(meeting) }} · {{ formatDuration(meeting.durationMs) }}
                  </span>
                </span>
                <span v-if="meetingNeedsRecovery(meeting)" class="text-[9px] text-rem">Needs attention</span>
                <IconChevronRight :size="13" class="shrink-0 text-ink-3" />
              </button>
            </div>
          </section>
        </div>
      </main>
    </template>

    <p class="sr-only" aria-live="polite">{{ liveAnnouncement }}</p>
  </section>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  IconAlertTriangle,
  IconChevronLeft,
  IconChevronRight,
  IconDownload,
  IconEdit,
  IconMicrophone,
  IconMicrophoneOff,
  IconPhone,
  IconPlayerStopFilled,
  IconRefresh,
  IconSettings,
  IconTrash,
  IconX,
} from '@tabler/icons-vue'
import { confirm } from '@tauri-apps/plugin-dialog'
import { useMeetingsStore } from '../../stores/meetings.js'
import { useLaunchersStore } from '../../stores/launchers.js'
import ScribeSettings from './scribe/ScribeSettings.vue'
import ScribeSelect from './scribe/ScribeSelect.vue'
import { SUMMARY_TEMPLATE_OPTIONS, summaryAgentOptions as buildSummaryAgentOptions } from './scribe/summaryRecipes.js'

const MAX_REVIEWED_TAGS = 64
const MAX_REVIEWED_TAG_CHARS = 80
const MAX_REVIEWED_TAG_BYTES = 160

const props = defineProps({
  workspacePath: { type: String, default: '' },
  active: { type: Boolean, default: false },
})
const emit = defineEmits(['openFile', 'openActivity', 'diagnostic'])
const meetings = useMeetingsStore()
const launchers = useLaunchersStore()
const scribeRoot = ref(null)
const settingsPanel = ref(null)
const settingsOpen = ref(false)
const detailMeetingId = ref(null)
const detailTab = ref('transcript')
const editingMeeting = ref(false)
const editedTitle = ref('')
const editedSummary = ref('')
const editedTags = ref('')
const actionError = ref('')
const dismissedNativeNotice = ref('')
const now = ref(Date.now())
const liveAnnouncement = ref('')
const credentialNotice = ref('')
const credentialError = ref('')
const detailTabs = [
  { id: 'transcript', label: 'Transcript' },
  { id: 'summary', label: 'Summary' },
]
const summaryTemplateOptions = SUMMARY_TEMPLATE_OPTIONS
const availableSummaryAgents = computed(() => launchers.availablePresets.filter(
  preset => preset.kind === 'agent',
))
const summaryAgentOptions = computed(() => buildSummaryAgentOptions(
  availableSummaryAgents.value,
  meetings.config.summaryPreset,
))
let timer = null
let lastActiveMeetingId = null

const detailMeeting = computed(() => {
  if (!detailMeetingId.value) return null
  // Library snapshots deliberately omit transcript text so opening Scribe is
  // independent of meeting history size. The selected-meeting projection is
  // the same record enriched with its separately paged transcript window.
  // Reading the raw library row here made a successfully persisted transcript
  // disappear from Review even though it remained visible during recording.
  if (meetings.selectedMeeting?.id === detailMeetingId.value) {
    return meetings.selectedMeeting
  }
  return meetings.meetings.find(meeting => meeting.id === detailMeetingId.value) || null
})
const formattedElapsed = computed(() => formatDuration(Math.max(
  meetings.elapsedMs,
  now.value - Date.parse(meetings.activeMeeting?.startedAt || new Date(now.value).toISOString()),
)))
const liveLedger = computed(() => transcriptLedgerEntries(meetings.activeMeeting))
const detailLedger = computed(() => transcriptLedgerEntries(detailMeeting.value))
const reviewedTags = computed(() => parseReviewedTags(editedTags.value))
const reviewedTagsError = computed(() => reviewedTags.value.error)
const isHosted = computed(() => meetings.config.transcriptionMode === 'custom')
const hostedProviderName = computed(() => {
  try {
    const host = new URL(meetings.config.customUrl).hostname
    return host === 'api.openai.com' ? 'OpenAI' : host || 'hosted service'
  } catch {
    return 'hosted service'
  }
})
const canStart = computed(() => {
  if (isHosted.value) return Boolean(meetings.config.apiKeyConfigured)
  return meetings.models.some(model => (
    model.id === meetings.config.localModel && model.status === 'installed'
  ))
})
const primaryActionLabel = computed(() => (
  canStart.value ? 'Start recording' : isHosted.value ? 'API key required' : 'Local model required'
))
const readyLabel = computed(() => (
  isHosted.value
    ? meetings.config.apiKeyConfigured
      ? `Ready · ${hostedProviderName.value}`
      : `Setup needed · ${hostedProviderName.value} API key`
    : canStart.value ? 'Ready · On this Mac' : 'Setup needed · Local model'
))
const routeDisclosure = computed(() => {
  if (!isHosted.value) return 'Audio and transcription stay on this Mac.'
  return `Microphone and system audio are sent to ${hostedProviderName.value} for live transcription.`
})
const captureStatus = computed(() => {
  const channels = meetings.activeMeeting?.channels || []
  if (channels.includes('microphone') && channels.includes('system')) {
    return meetings.activeMeeting?.micMuted
      ? 'Recording system audio · microphone muted'
      : 'Recording microphone + system audio'
  }
  return channels.includes('microphone') ? 'Recording microphone only' : 'Recording audio'
})
const transcriptionStatus = computed(() => {
  const value = meetings.activeMeeting?.transcription
  // A durable transcript segment is stronger evidence than a lagging worker
  // readiness projection. Never tell the user transcription is still being
  // prepared while words are already arriving on screen.
  if (meetings.recording && liveLedger.value.some(entry => entry.kind === 'segment')) {
    return isHosted.value
      ? `Transcribing live with ${hostedProviderName.value}`
      : 'Transcribing live on this Mac'
  }
  if (value === 'live') {
    return isHosted.value
      ? `Transcribing live with ${hostedProviderName.value}`
      : 'Transcribing live on this Mac'
  }
  if (value === 'initializing' || value === 'connecting') return 'Preparing transcription · audio is safe'
  if (value === 'delayed' || value === 'failed') return 'Transcript will be repaired after Stop'
  if (value === 'final') return 'Transcript complete'
  return 'Recording is safe'
})
const recordingNotice = computed(() => {
  const notice = actionError.value || meetings.activeMeeting?.error || meetings.error
  if (!notice || notice === dismissedNativeNotice.value) return ''
  if (/transcri|worker|provider|model/i.test(notice)) {
    return 'Recording is safe. Live transcription is unavailable; Mimir will retry from stored audio after you stop.'
  }
  return notice
})
const homeNotice = computed(() => actionError.value || (
  meetings.error === dismissedNativeNotice.value ? '' : meetings.error
))
const emptyLiveTranscript = computed(() => {
  const state = meetings.activeMeeting?.transcription
  if (state === 'initializing' || state === 'connecting') return 'Preparing transcription. Recording has already started.'
  if (state === 'delayed' || state === 'failed') return 'Recording continues. The transcript will be repaired after you stop.'
  return 'Listening… transcript text will appear here.'
})

watch(() => meetings.activeMeeting?.id, id => {
  if (id) lastActiveMeetingId = id
  if (!id && lastActiveMeetingId) {
    detailMeetingId.value = lastActiveMeetingId
    lastActiveMeetingId = null
  }
})

onMounted(async () => {
  timer = window.setInterval(() => {
    if (meetings.recording) now.value = Date.now()
  }, 1000)
  try {
    await meetings.initialize()
  } catch (error) {
    actionError.value = message(error)
  }
})

onUnmounted(() => {
  if (timer) window.clearInterval(timer)
})

function focusEntry() {
  scribeRoot.value?.querySelector('[data-scribe-stop], [data-scribe-new]')?.focus()
}

defineExpose({ focusEntry })

async function start(candidate) {
  actionError.value = ''
  dismissedNativeNotice.value = ''
  try {
    await meetings.start({
      title: candidate?.appName ? `${candidate.appName} meeting` : '',
      candidateId: candidate?.id || null,
      workspacePath: props.workspacePath,
    })
    liveAnnouncement.value = 'Recording started'
  } catch (error) {
    actionError.value = message(error)
  }
}

async function stop() {
  actionError.value = ''
  try {
    await meetings.stop()
    liveAnnouncement.value = 'Recording stopped. Finalizing transcript.'
  } catch (error) {
    actionError.value = message(error)
  }
}

async function toggleMute() {
  try {
    await meetings.setMicMuted(!meetings.activeMeeting?.micMuted)
  } catch (error) {
    actionError.value = message(error)
  }
}

function dismissNotice() {
  dismissedNativeNotice.value = actionError.value || meetings.activeMeeting?.error || meetings.error
  actionError.value = ''
  meetings.dismissError?.()
}

function openMeeting(id) {
  meetings.select(id)
  detailMeetingId.value = id
  detailTab.value = 'transcript'
  editingMeeting.value = false
}

function closeDetail() {
  detailMeetingId.value = null
  editingMeeting.value = false
}

function openSettings() {
  settingsOpen.value = true
  nextTick(() => settingsPanel.value?.focusEntry?.())
}

function closeSettings() {
  settingsOpen.value = false
  nextTick(focusEntry)
}

async function refresh() {
  try {
    await meetings.refresh()
  } catch (error) {
    actionError.value = message(error)
  }
}

async function dismissCandidate(id) {
  try {
    await meetings.dismissCandidate(id)
  } catch (error) {
    actionError.value = message(error)
  }
}

function beginEdit() {
  if (!detailMeeting.value) return
  editedTitle.value = detailMeeting.value.title
  editedSummary.value = detailMeeting.value.summary || ''
  editedTags.value = (detailMeeting.value.tags || []).join(', ')
  editingMeeting.value = true
}

async function saveMeetingEdits() {
  if (!detailMeeting.value || reviewedTagsError.value) return
  try {
    await meetings.saveMeeting(detailMeeting.value.id, {
      title: editedTitle.value,
      summary: editedSummary.value,
      tags: reviewedTags.value.tags,
    })
    editingMeeting.value = false
    liveAnnouncement.value = 'Meeting review saved'
  } catch (error) {
    actionError.value = message(error)
  }
}

async function exportSelected(format) {
  if (!detailMeeting.value) return
  try {
    const result = await meetings.exportRecord(detailMeeting.value.id, format)
    const path = typeof result === 'string' ? result : result?.path
    if (path) emit('openFile', path)
  } catch (error) {
    actionError.value = message(error)
  }
}

async function deleteSelected() {
  if (!detailMeeting.value) return
  const accepted = await confirm(
    `Permanently delete “${detailMeeting.value.title}” and its transcript, summary, and source audio?`,
    {
      title: 'Delete meeting?',
      kind: 'warning',
      okLabel: 'Delete meeting',
      cancelLabel: 'Cancel',
    },
  )
  if (!accepted) return
  try {
    await meetings.remove(detailMeeting.value.id, 'all')
    closeDetail()
  } catch (error) {
    actionError.value = message(error)
  }
}

async function decideKg(id, decision) {
  try {
    const meeting = await meetings.decideKg(id, decision)
    const activityId = meeting?.jobs?.find(job => job.kind === 'kg-proposal')?.activityId
    if (activityId) emit('openActivity', activityId)
  } catch (error) {
    actionError.value = message(error)
  }
}

async function saveConfig(patch) {
  try {
    await meetings.saveConfig(patch)
  } catch (error) {
    actionError.value = message(error)
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
    liveAnnouncement.value = credentialNotice.value
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
    liveAnnouncement.value = credentialNotice.value
  } catch (error) {
    credentialError.value = message(error)
  }
}

async function regenerateSummary() {
  if (!detailMeeting.value) return
  actionError.value = ''
  try {
    await meetings.retryJob(detailMeeting.value.id, 'title-summary')
    liveAnnouncement.value = 'A new title and summary run is queued.'
  } catch (error) {
    actionError.value = message(error)
  }
}

async function installModel(id) {
  try {
    await meetings.installModel(id)
  } catch (error) {
    actionError.value = message(error)
  }
}

async function deleteModel(id) {
  try {
    await meetings.deleteModel(id)
  } catch (error) {
    actionError.value = message(error)
  }
}

async function requestMicrophonePermission() {
  try {
    await meetings.requestMicrophonePermission()
  } catch (error) {
    actionError.value = message(error)
  }
}

async function openSystemAudioSettings() {
  try {
    await meetings.openSystemAudioSettings()
  } catch (error) {
    actionError.value = message(error)
  }
}

async function checkAudio() {
  try {
    await meetings.checkAudio()
  } catch (error) {
    actionError.value = message(error)
  }
}

function onDetailTabKeydown(event) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  const current = detailTabs.findIndex(tab => tab.id === detailTab.value)
  let next = current
  if (event.key === 'Home') next = 0
  if (event.key === 'End') next = detailTabs.length - 1
  if (event.key === 'ArrowLeft') next = (current - 1 + detailTabs.length) % detailTabs.length
  if (event.key === 'ArrowRight') next = (current + 1) % detailTabs.length
  detailTab.value = detailTabs[next].id
  event.preventDefault()
  nextTick(() => scribeRoot.value?.querySelector(`#scribe-detail-tab-${detailTabs[next].id}`)?.focus())
}

function transcriptLedgerEntries(meeting) {
  const segments = (meeting?.segments || []).map(segment => ({
    ...segment,
    kind: 'segment',
    key: `segment:${segment.id}:${segment.revision}`,
  }))
  const gaps = (meeting?.gaps || []).map((gap, index) => ({
    ...gap,
    kind: 'gap',
    key: `gap:${gap.channel}:${gap.startMs}:${gap.endMs}:${index}`,
  }))
  return [...segments, ...gaps].sort((left, right) => (
    left.startMs - right.startMs || (left.kind === 'gap' ? -1 : 1) || left.key.localeCompare(right.key)
  ))
}

function entrySpeaker(entry) {
  if (entry.kind === 'gap') return `${channelSpeaker(entry.channel)} gap`
  return entry.speaker || channelSpeaker(entry.channel)
}

function channelSpeaker(channel) {
  return channel === 'microphone' ? 'You' : channel === 'system' ? 'Others' : 'Speaker'
}

function gapDuration(gap) {
  return `${formatDuration(Math.max(0, gap.endMs - gap.startMs))} unavailable`
}

function meetingNeedsRecovery(meeting) {
  return ['interrupted', 'needs_repair', 'failed'].includes(meeting?.lifecycle) || Boolean(meeting?.error)
}

function recoveryStatus(meeting) {
  const job = meeting.jobs?.find(candidate => candidate.kind === 'transcription')
  if (job?.status === 'failed') return 'Stored audio is safe, but transcript recovery needs another attempt.'
  if (['queued', 'running'].includes(job?.status)) return `Stored audio is safe. Transcript recovery is ${job.status}.`
  return 'Capture ended unexpectedly. Stored audio is safe.'
}

function summaryStatus(meeting) {
  return ({
    'not-started': meeting.transcriptFinal ? 'The title and summary have not started.' : 'The summary starts after the transcript is final.',
    queued: 'The title and summary are queued.',
    running: 'Mimir is creating the title and summary.',
    failed: 'The summary failed. The transcript is safe.',
  })[meeting.summaryState] || 'No summary is available.'
}

function meetingActionPending(action) {
  const id = detailMeeting.value?.id
  if (!id) return false
  if (action === 'export') return Object.keys(meetings.pending).some(key => key.startsWith(`export:${id}:`))
  if (action.startsWith('export:')) return Boolean(meetings.pending[`export:${id}:${action.slice(7)}`])
  if (action === 'delete') return Boolean(meetings.pending[`delete:${id}`])
  return false
}

function parseReviewedTags(value) {
  const candidates = String(value || '').split(',').map(tag => tag.trim()).filter(Boolean)
  if (candidates.length > MAX_REVIEWED_TAGS) return { tags: [], error: `Use at most ${MAX_REVIEWED_TAGS} reviewed tags.` }
  const tags = []
  const seen = new Set()
  for (const tag of candidates) {
    if (tag.length > MAX_REVIEWED_TAG_CHARS) return { tags: [], error: `Each reviewed tag must be at most ${MAX_REVIEWED_TAG_CHARS} characters.` }
    if (new TextEncoder().encode(tag).byteLength > MAX_REVIEWED_TAG_BYTES) return { tags: [], error: `Each reviewed tag must be at most ${MAX_REVIEWED_TAG_BYTES} UTF-8 bytes.` }
    if (/[\u0000-\u001f\u007f]/u.test(tag)) return { tags: [], error: 'Reviewed tags cannot contain control characters.' }
    if (!seen.has(tag)) {
      seen.add(tag)
      tags.push(tag)
    }
  }
  return { tags, error: '' }
}

function timestamp(milliseconds) {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function formatDuration(milliseconds) {
  const seconds = Math.floor(Math.max(0, Number(milliseconds) || 0) / 1000)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainder = seconds % 60
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`
}

function meetingDate(meeting) {
  const date = new Date(meeting.startedAt || meeting.updatedAt || '')
  if (Number.isNaN(date.getTime())) return 'No date'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date)
}

function message(error) {
  return error instanceof Error ? error.message : String(error || 'Meeting operation failed.')
}
</script>

<style scoped>
.scribe-bar,
.scribe-transport {
  display: flex;
  min-height: 44px;
  flex-shrink: 0;
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid var(--color-rule);
  padding: 0 12px;
}

.scribe-transport {
  min-height: 50px;
  background: var(--color-chrome);
}

.scribe-capture-status {
  display: flex;
  min-height: 34px;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  border-bottom: 1px solid var(--color-rule-light);
  padding: 0 14px;
  font-size: 10px;
}

.scribe-inline-notice {
  display: flex;
  flex-shrink: 0;
  align-items: flex-start;
  gap: 8px;
  border-bottom: 1px solid color-mix(in srgb, var(--color-rem) 30%, transparent);
  background: var(--color-surface);
  padding: 8px 14px;
  color: var(--color-rem);
  font-size: 10px;
  line-height: 1.5;
}

.scribe-quiet-button,
.scribe-primary-button,
.scribe-record-button,
.scribe-stop-button,
.scribe-icon-button {
  display: inline-flex;
  min-height: 30px;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 1px solid var(--color-rule);
  padding: 0 9px;
  font-size: 10px;
  font-weight: 600;
}

.scribe-icon-button {
  width: 30px;
  padding: 0;
}

.scribe-quiet-button:hover:not(:disabled),
.scribe-icon-button:hover:not(:disabled) {
  background: var(--color-chrome-mid);
}

.scribe-primary-button,
.scribe-record-button {
  border-color: var(--color-accent);
  background: var(--color-accent);
  color: var(--color-surface);
}

.scribe-record-button {
  min-height: 36px;
  padding: 0 14px;
  font-size: 11px;
}

.scribe-stop-button {
  border-color: var(--color-rem);
  background: var(--color-rem);
  color: var(--color-surface);
}

.scribe-quiet-button:focus-visible,
.scribe-primary-button:focus-visible,
.scribe-record-button:focus-visible,
.scribe-stop-button:focus-visible,
.scribe-icon-button:focus-visible,
.scribe-meeting-row:focus-visible,
.scribe-tab:focus-visible,
.scribe-input:focus-visible {
  outline: 1px solid var(--color-accent);
  outline-offset: 1px;
}

button:disabled {
  cursor: default;
  opacity: 0.5;
}

.scribe-meeting-row {
  display: flex;
  min-height: 50px;
  width: 100%;
  align-items: center;
  gap: 10px;
  padding: 7px 2px;
}

.scribe-meeting-row:hover {
  background: var(--color-chrome-mid);
}

.scribe-tab {
  min-height: 34px;
  border-bottom-width: 1px;
  padding: 0 12px;
  font-size: 10px;
  font-weight: 600;
}

.scribe-field-label {
  display: block;
  margin-bottom: 5px;
  color: var(--color-ink-3);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 9px;
}

.scribe-input {
  height: 34px;
  width: 100%;
  border: 1px solid var(--color-rule);
  background: var(--color-surface);
  padding: 0 9px;
  color: var(--color-ink);
  font-size: 11px;
  outline: none;
}

@media (max-width: 620px) {
  .scribe-transport {
    flex-wrap: wrap;
    padding-bottom: 7px;
    padding-top: 7px;
  }

  .scribe-capture-status {
    align-items: flex-start;
    flex-direction: column;
    gap: 2px;
    padding-bottom: 6px;
    padding-top: 6px;
  }
}
</style>
