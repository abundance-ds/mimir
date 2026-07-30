<template>
  <section
    data-scribe-app
    class="flex h-full min-h-0 flex-col overflow-hidden bg-chrome-high text-ink"
    @keydown="onKeydown"
  >
    <header class="flex h-11 shrink-0 items-center border-b border-rule px-3">
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <IconMicrophone :size="15" :stroke-width="1.8" class="text-ink-2" />
          <h1 class="truncate text-[12px] font-semibold">Scribe</h1>
          <span
            v-if="meetings.recording"
            data-scribe-recording-label
            role="status"
            class="font-mono text-[9px] uppercase tracking-[0.12em] text-rem"
          >
            Recording {{ formattedElapsed }}
          </span>
          <span
            v-else-if="meetings.stopping"
            role="status"
            class="font-mono text-[9px] uppercase tracking-[0.12em] text-ink-3"
          >
            Finalizing
          </span>
        </div>
      </div>

      <div class="flex items-center gap-1">
        <button
          v-if="meetings.recording"
          type="button"
          data-scribe-mute
          class="scribe-button"
          :aria-pressed="meetings.activeMeeting?.micMuted"
          :disabled="Boolean(meetings.pending.mic)"
          @click="toggleMute"
        >
          <IconMicrophoneOff v-if="meetings.activeMeeting?.micMuted" :size="14" />
          <IconMicrophone v-else :size="14" />
          {{ meetings.activeMeeting?.micMuted ? 'Unmute' : 'Mute' }}
        </button>
        <button
          v-if="meetings.activeMeeting"
          type="button"
          data-scribe-stop
          class="scribe-stop"
          :disabled="!meetings.recording || Boolean(meetings.pending.stop)"
          @click="stop"
        >
          <IconPlayerStopFilled :size="13" />
          {{ meetings.pending.stop ? 'Stopping…' : 'Stop' }}
        </button>
        <button
          type="button"
          data-scribe-settings
          class="scribe-icon-button"
          :aria-expanded="settingsOpen"
          title="Scribe settings"
          aria-label="Scribe settings"
          @click="settingsOpen = !settingsOpen"
        >
          <IconSettings :size="14" />
        </button>
      </div>
    </header>

    <div
      v-if="meetings.activeMeeting"
      data-scribe-ledger
      class="grid min-h-9 shrink-0 grid-cols-[auto_auto_auto_1fr] items-center gap-x-4 border-b border-rule-light px-3 font-mono text-[9px]"
    >
      <span class="text-ink-2">
        {{ lifecycleLabel(meetings.activeMeeting.lifecycle) }}
      </span>
      <span class="text-ink-3">
        Mic {{ channelLabel('microphone') }}
      </span>
      <span class="text-ink-3">
        System {{ channelLabel('system') }}
      </span>
      <span class="truncate text-right text-ink-3">
        Transcript {{ transcriptionLabel(meetings.activeMeeting.transcription) }}
        <template v-if="meetings.activeMeeting.gaps.length">
          · {{ meetings.activeMeeting.gaps.length }}
          {{ meetings.activeMeeting.gaps.length === 1 ? 'gap' : 'gaps' }}
        </template>
      </span>
    </div>

    <div v-if="meetings.error" data-scribe-error role="alert" class="scribe-alert">
      <IconAlertTriangle :size="14" class="shrink-0" />
      <span class="min-w-0 flex-1">{{ meetings.error }}</span>
      <button type="button" @click="refresh">Retry</button>
    </div>

    <div
      v-if="meetings.kgOffer"
      data-scribe-kg-offer
      class="flex shrink-0 items-center gap-3 border-b border-rule bg-surface px-3 py-2"
    >
      <IconTopologyStar3 :size="15" class="shrink-0 text-ink-2" />
      <p class="min-w-0 flex-1 text-[11px] text-ink-2">
        <strong class="font-semibold text-ink">{{ meetings.kgOffer.title }}</strong>
        has a title and summary. Create reviewable knowledge-graph entries?
      </p>
      <button
        type="button"
        class="scribe-button"
        :disabled="Boolean(meetings.pending[`kg:${meetings.kgOffer.id}`])"
        @click="decideKg(meetings.kgOffer.id, 'not-now')"
      >
        Not now
      </button>
      <button
        type="button"
        class="scribe-primary-button"
        :disabled="Boolean(meetings.pending[`kg:${meetings.kgOffer.id}`])"
        @click="decideKg(meetings.kgOffer.id, 'create-draft')"
      >
        Create KG draft
      </button>
    </div>

    <div class="flex min-h-0 flex-1">
      <aside
        class="flex w-[224px] shrink-0 flex-col border-r border-rule bg-chrome"
        aria-label="Meeting library"
      >
        <div class="flex h-9 shrink-0 items-center border-b border-rule-light px-2">
          <span class="flex-1 font-mono text-[9px] uppercase tracking-[0.12em] text-ink-3">
            Meetings
          </span>
          <button
            type="button"
            class="scribe-icon-button"
            title="Refresh meetings"
            aria-label="Refresh meetings"
            :disabled="meetings.loading"
            @click="refresh"
          >
            <IconRefresh :size="13" :class="{ 'motion-safe:animate-spin': meetings.loading }" />
          </button>
        </div>

        <div
          v-if="meetings.candidates.length"
          data-scribe-candidates
          class="border-b border-rule"
        >
          <p class="px-2 pb-1 pt-2 font-mono text-[9px] uppercase tracking-[0.1em] text-ink-3">
            Detected
          </p>
          <div
            v-for="candidate in meetings.candidates"
            :key="candidate.id"
            class="flex min-w-0 items-center"
          >
            <button
              type="button"
              class="scribe-library-row min-w-0 flex-1"
              @click="beginStart(candidate)"
            >
              <IconPhone :size="13" class="shrink-0 text-ink-2" />
              <span class="min-w-0 flex-1 truncate">{{ candidate.appName }}</span>
              <span class="font-mono text-[9px] text-ink-3">Record?</span>
            </button>
            <button
              type="button"
              class="scribe-icon-button mr-1 shrink-0"
              :aria-label="`Dismiss ${candidate.appName} suggestion`"
              :disabled="Boolean(meetings.pending[`candidate:${candidate.id}`])"
              @click="dismissCandidate(candidate.id)"
            >
              <IconX :size="12" />
            </button>
          </div>
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto">
          <button
            v-for="meeting in meetings.meetings"
            :key="meeting.id"
            type="button"
            class="scribe-library-row min-h-12"
            :class="{ 'bg-accent-soft': meeting.id === meetings.selectedId }"
            :aria-current="meeting.id === meetings.selectedId ? 'true' : undefined"
            @click="meetings.select(meeting.id)"
          >
            <span class="min-w-0 flex-1 text-left">
              <span class="block truncate text-[11px] font-medium">{{ meeting.title }}</span>
              <span class="mt-0.5 block truncate font-mono text-[9px] text-ink-3">
                {{ meetingDate(meeting) }} · {{ lifecycleLabel(meeting.lifecycle) }}
              </span>
            </span>
            <IconPlayerRecordFilled
              v-if="meeting.lifecycle === 'capturing'"
              :size="10"
              class="shrink-0 text-rem"
              aria-label="Recording"
            />
            <IconAlertTriangle
              v-else-if="meeting.lifecycle === 'interrupted' || meeting.error"
              :size="12"
              class="shrink-0 text-rem"
              aria-label="Needs attention"
            />
          </button>

          <div
            v-if="meetings.loaded && !meetings.meetings.length"
            class="px-3 py-6 text-center text-[10px] leading-relaxed text-ink-3"
          >
            Recorded meetings will appear here.
          </div>
        </div>

        <button
          type="button"
          data-scribe-new
          class="m-2 flex h-8 items-center justify-center gap-1.5 border border-rule bg-chrome-high text-[10px] font-semibold hover:bg-chrome-mid focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-50"
          :disabled="Boolean(meetings.activeMeeting)"
          @click="beginStart()"
        >
          <IconMicrophone :size="13" />
          Record meeting
        </button>
      </aside>

      <main class="min-w-0 flex-1 overflow-hidden bg-chrome-high">
        <ScribeSettings
          v-if="settingsOpen"
          :config="meetings.config"
          :permissions="meetings.permissions"
          :models="meetings.models"
          :pending="meetings.pending"
          @close="settingsOpen = false"
          @save="saveConfig"
          @save-api-key="saveApiKey"
          @clear-api-key="clearApiKey"
          @install-model="installModel"
          @delete-model="deleteModel"
          @request-microphone-permission="requestMicrophonePermission"
        />

        <div
          v-else-if="confirmingStart"
          data-scribe-consent
          class="mx-auto flex h-full max-w-xl flex-col justify-center px-8"
        >
          <p class="font-mono text-[9px] uppercase tracking-[0.12em] text-ink-3">
            Before recording
          </p>
          <h2 class="mt-2 text-[17px] font-semibold">Confirm everyone is informed</h2>
          <p class="mt-2 max-w-lg text-[11px] leading-relaxed text-ink-2">
            Scribe records microphone and system audio. You are responsible for obtaining
            any consent or giving any notice required for this meeting.
          </p>
          <div
            v-if="meetings.config.transcriptionMode === 'custom'"
            data-scribe-hosted-disclosure
            class="mt-3 max-w-lg border-l-2 border-accent bg-accent-soft px-3 py-2 text-[10px] leading-relaxed text-ink-2"
          >
            Both audio channels and transcript timing will be sent to
            <strong class="font-semibold text-ink">{{ customDestination }}</strong>
            for transcription. Mimir will not silently switch to another provider.
          </div>
          <p v-else class="mt-3 max-w-lg text-[10px] leading-relaxed text-ink-3">
            Local transcription stays on this Mac and does not send meeting audio to a provider.
          </p>
          <label class="mt-5 flex items-start gap-2 text-[11px] leading-relaxed text-ink-2">
            <input
              v-model="consentConfirmed"
              data-scribe-consent-checkbox
              type="checkbox"
              class="mt-0.5 accent-accent"
            />
            <span>I have informed the participants and may record this meeting.</span>
          </label>
          <label class="mt-4 block">
            <span class="font-mono text-[9px] uppercase tracking-[0.1em] text-ink-3">
              Working title
            </span>
            <input
              v-model="startTitle"
              data-scribe-title
              class="mt-1 h-8 w-full border border-rule bg-surface px-2 text-[11px] outline-none focus:border-accent"
              placeholder="Mimir will refine this after the meeting"
            />
          </label>
          <div class="mt-5 flex items-center gap-2">
            <button type="button" class="scribe-button" @click="cancelStart">Cancel</button>
            <button
              type="button"
              data-scribe-confirm-start
              class="scribe-primary-button"
              :disabled="!consentConfirmed || Boolean(meetings.pending.start)"
              @click="start"
            >
              <IconMicrophone :size="13" />
              {{ meetings.pending.start ? 'Starting…' : 'Start recording' }}
            </button>
          </div>
        </div>

        <div
          v-else-if="!meetings.selectedMeeting"
          class="mx-auto flex h-full max-w-lg flex-col justify-center px-8"
        >
          <IconMicrophone :size="25" :stroke-width="1.4" class="text-ink-3" />
          <h2 class="mt-3 text-[15px] font-semibold">Ready when the meeting starts</h2>
          <p class="mt-1.5 text-[11px] leading-relaxed text-ink-3">
            Capture both sides, follow the transcript, then let Mimir prepare a title,
            summary, and optional knowledge-graph draft.
          </p>
          <button
            type="button"
            class="scribe-primary-button mt-4 self-start"
            @click="beginStart()"
          >
            Record meeting
          </button>
        </div>

        <article
          v-else
          data-scribe-meeting
          class="flex h-full min-h-0 flex-col"
        >
          <header class="shrink-0 border-b border-rule px-4 py-3">
            <div class="flex items-start gap-3">
              <div class="min-w-0 flex-1">
                <h2 class="truncate text-[15px] font-semibold">
                  {{ meetings.selectedMeeting.title }}
                </h2>
                <p class="mt-1 font-mono text-[9px] text-ink-3">
                  {{ meetingDate(meetings.selectedMeeting) }}
                  · {{ formatDuration(meetings.selectedMeeting.durationMs) }}
                  · transcript r{{ meetings.selectedMeeting.transcriptRevision }}
                </p>
              </div>
              <button
                type="button"
                class="scribe-button"
                @click="exportSelected('markdown')"
              >
                <IconDownload :size="13" />
                Export
              </button>
              <button
                v-if="meetings.selectedMeeting.lifecycle === 'ready'"
                type="button"
                class="scribe-button"
                @click="beginEdit"
              >
                <IconEdit :size="13" />
                Edit
              </button>
            </div>
            <nav class="mt-3 flex gap-4" aria-label="Meeting detail">
              <button
                v-for="tab in detailTabs"
                :key="tab.id"
                type="button"
                class="border-b pb-1 text-[10px]"
                :class="detailTab === tab.id
                  ? 'border-accent text-ink'
                  : 'border-transparent text-ink-3 hover:text-ink'"
                :aria-current="detailTab === tab.id ? 'page' : undefined"
                @click="detailTab = tab.id"
              >
                {{ tab.label }}
              </button>
            </nav>
          </header>

          <div class="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            <section v-if="detailTab === 'transcript'" aria-label="Transcript">
              <div
                v-if="!meetings.selectedMeeting.segments.length"
                class="py-12 text-center text-[11px] text-ink-3"
              >
                {{
                  meetings.selectedMeeting.lifecycle === 'capturing'
                    ? 'Listening for speech…'
                    : 'No transcript is available.'
                }}
              </div>
              <ol v-else class="divide-y divide-rule-light">
                <li
                  v-for="segment in meetings.selectedMeeting.segments"
                  :key="`${segment.id}:${segment.revision}`"
                  class="grid grid-cols-[72px_minmax(0,1fr)] gap-3 py-2"
                  :class="{ 'opacity-60': !segment.final }"
                >
                  <span class="font-mono text-[9px] text-ink-3">
                    {{ segment.speaker || channelSpeaker(segment.channel) }}
                    <br />
                    {{ timestamp(segment.startMs) }}
                  </span>
                  <p class="select-text text-[12px] leading-[1.55] text-ink">
                    {{ segment.text }}
                  </p>
                </li>
              </ol>
            </section>

            <section v-else-if="detailTab === 'summary'" aria-label="Summary">
              <form
                v-if="editingMeeting"
                class="max-w-3xl space-y-4"
                @submit.prevent="saveMeetingEdits"
              >
                <label class="block">
                  <span class="scribe-settings-label">Reviewed title</span>
                  <input
                    v-model="editedTitle"
                    data-scribe-edit-title
                    class="scribe-settings-input"
                    maxlength="200"
                    required
                  />
                </label>
                <label class="block">
                  <span class="scribe-settings-label">Reviewed summary</span>
                  <textarea
                    v-model="editedSummary"
                    data-scribe-edit-summary
                    class="scribe-settings-input min-h-64 resize-y py-2 leading-relaxed"
                    maxlength="100000"
                  />
                </label>
                <div class="flex gap-2">
                  <button type="button" class="scribe-button" @click="cancelEdit">
                    Cancel
                  </button>
                  <button
                    type="submit"
                    data-scribe-save-review
                    class="scribe-primary-button"
                    :disabled="!editedTitle.trim() || Boolean(
                      meetings.pending[`update:${meetings.selectedMeeting.id}`],
                    )"
                  >
                    Save review
                  </button>
                </div>
              </form>
              <div
                v-else-if="meetings.selectedMeeting.summary"
                class="max-w-3xl select-text whitespace-pre-wrap text-[12px] leading-[1.6]"
              >
                {{ meetings.selectedMeeting.summary }}
              </div>
              <div v-else class="py-10">
                <p class="text-[11px] text-ink-2">
                  {{ summaryStatus(meetings.selectedMeeting) }}
                </p>
                <button
                  v-if="meetings.selectedMeeting.summaryState === 'failed'"
                  type="button"
                  class="scribe-button mt-3"
                  @click="retryJob(meetings.selectedMeeting.id, 'title-summary')"
                >
                  Retry title and summary
                </button>
              </div>
            </section>

            <section v-else aria-label="Meeting diagnostics">
              <dl class="grid max-w-2xl grid-cols-[150px_1fr] border-t border-rule text-[10px]">
                <template
                  v-for="[label, value] in diagnosticRows(meetings.selectedMeeting)"
                  :key="label"
                >
                  <dt class="border-b border-rule-light py-2 font-mono text-ink-3">
                    {{ label }}
                  </dt>
                  <dd class="border-b border-rule-light py-2 text-ink-2">{{ value }}</dd>
                </template>
              </dl>
              <div class="mt-6 max-w-2xl border-t border-rule pt-4">
                <h3 class="text-[11px] font-semibold">Data and privacy</h3>
                <p class="mt-1 text-[10px] leading-relaxed text-ink-3">
                  Exports create a user-owned copy. Deletion cannot remove prior exports,
                  backups, or audio already processed by a custom provider.
                </p>
                <div class="mt-3 flex flex-wrap gap-2">
                  <button type="button" class="scribe-button" @click="exportSelected('json')">
                    Export JSON
                  </button>
                  <button type="button" class="scribe-button" @click="exportSelected('audio')">
                    Export audio
                  </button>
                  <button
                    type="button"
                    class="scribe-button text-rem"
                    @click="deleteSelected('audio')"
                  >
                    Delete source audio
                  </button>
                  <button
                    type="button"
                    data-scribe-delete-meeting
                    class="scribe-button text-rem"
                    @click="deleteSelected('all')"
                  >
                    <IconTrash :size="13" />
                    Delete meeting
                  </button>
                </div>
              </div>
            </section>
          </div>
        </article>
      </main>
    </div>

    <p class="sr-only" aria-live="polite">{{ liveAnnouncement }}</p>
  </section>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  IconAlertTriangle,
  IconDownload,
  IconEdit,
  IconMicrophone,
  IconMicrophoneOff,
  IconPhone,
  IconPlayerRecordFilled,
  IconPlayerStopFilled,
  IconRefresh,
  IconSettings,
  IconTopologyStar3,
  IconTrash,
  IconX,
} from '@tabler/icons-vue'
import { confirm } from '@tauri-apps/plugin-dialog'
import { useMeetingsStore } from '../../stores/meetings.js'
import ScribeSettings from './scribe/ScribeSettings.vue'

const props = defineProps({
  workspacePath: { type: String, default: '' },
  active: { type: Boolean, default: false },
})
const emit = defineEmits(['openFile', 'openActivity', 'diagnostic'])

const meetings = useMeetingsStore()
const settingsOpen = ref(false)
const confirmingStart = ref(false)
const consentConfirmed = ref(false)
const startTitle = ref('')
const candidateId = ref(null)
const detailTab = ref('transcript')
const editingMeeting = ref(false)
const editedTitle = ref('')
const editedSummary = ref('')
const now = ref(Date.now())
const liveAnnouncement = ref('')
const detailTabs = [
  { id: 'transcript', label: 'Transcript' },
  { id: 'summary', label: 'Summary' },
  { id: 'details', label: 'Details' },
]
let timer = null

const formattedElapsed = computed(() => (
  formatDuration(Math.max(meetings.elapsedMs, now.value - Date.parse(
    meetings.activeMeeting?.startedAt || new Date(now.value).toISOString(),
  )))
))
const customDestination = computed(() => {
  try {
    return new URL(meetings.config.customUrl).host || 'the configured transcription service'
  } catch {
    return 'the configured transcription service'
  }
})

watch(
  () => meetings.activeMeeting?.lifecycle,
  lifecycle => {
    if (!lifecycle) return
    liveAnnouncement.value = lifecycleLabel(lifecycle)
  },
)
watch(
  () => meetings.selectedMeeting?.id,
  () => {
    editingMeeting.value = false
  },
)
watch(
  () => meetings.error,
  error => {
    if (error) emit('diagnostic', error)
  },
)

onMounted(async () => {
  timer = window.setInterval(() => {
    if (meetings.recording) now.value = Date.now()
  }, 1000)
  try {
    await meetings.initialize()
  } catch (error) {
    emit('diagnostic', message(error))
  }
})

onUnmounted(() => {
  if (timer) window.clearInterval(timer)
})

function focusEntry() {
  document.querySelector('[data-scribe-stop], [data-scribe-new]')?.focus()
}

defineExpose({ focusEntry })

function beginStart(candidate = null) {
  candidateId.value = candidate?.id || null
  startTitle.value = candidate?.appName ? `${candidate.appName} meeting` : ''
  consentConfirmed.value = false
  settingsOpen.value = false
  confirmingStart.value = true
}

function cancelStart() {
  confirmingStart.value = false
  candidateId.value = null
  consentConfirmed.value = false
}

async function start() {
  try {
    await meetings.start({
      title: startTitle.value,
      candidateId: candidateId.value,
      workspacePath: props.workspacePath,
      consentConfirmed: consentConfirmed.value,
    })
    cancelStart()
    liveAnnouncement.value = 'Recording started'
  } catch (error) {
    emit('diagnostic', message(error))
  }
}

async function stop() {
  try {
    await meetings.stop()
    liveAnnouncement.value = 'Recording stopped. Finalizing transcript.'
  } catch (error) {
    emit('diagnostic', message(error))
  }
}

async function toggleMute() {
  try {
    await meetings.setMicMuted(!meetings.activeMeeting?.micMuted)
  } catch (error) {
    emit('diagnostic', message(error))
  }
}

async function decideKg(id, decision) {
  try {
    const meeting = await meetings.decideKg(id, decision)
    if (meeting?.jobs?.length) {
      const activityId = meeting.jobs.find(job => job.kind === 'kg-proposal')?.activityId
      if (activityId) emit('openActivity', activityId)
    }
  } catch (error) {
    emit('diagnostic', message(error))
  }
}

async function retryJob(id, kind) {
  try {
    await meetings.retryJob(id, kind)
  } catch (error) {
    emit('diagnostic', message(error))
  }
}

async function refresh() {
  try {
    await meetings.refresh()
  } catch (error) {
    emit('diagnostic', message(error))
  }
}

async function exportSelected(format = 'markdown') {
  const selected = meetings.selectedMeeting
  if (!selected) return
  try {
    const result = await meetings.exportRecord(selected.id, format)
    const path = typeof result === 'string' ? result : result?.path
    if (path) emit('openFile', path)
  } catch (error) {
    emit('diagnostic', message(error))
  }
}

function beginEdit() {
  const selected = meetings.selectedMeeting
  if (!selected) return
  editedTitle.value = selected.title
  editedSummary.value = selected.summary || ''
  detailTab.value = 'summary'
  editingMeeting.value = true
}

function cancelEdit() {
  editingMeeting.value = false
}

async function saveMeetingEdits() {
  const selected = meetings.selectedMeeting
  if (!selected) return
  try {
    await meetings.saveMeeting(selected.id, {
      title: editedTitle.value,
      summary: editedSummary.value,
    })
    editingMeeting.value = false
    liveAnnouncement.value = 'Meeting review saved'
  } catch (error) {
    emit('diagnostic', message(error))
  }
}

async function deleteSelected(mode) {
  const selected = meetings.selectedMeeting
  if (!selected) return
  const deletingAll = mode === 'all'
  const accepted = await confirm(
    deletingAll
      ? `Permanently delete “${selected.title}” and its transcript, summary, and source audio?`
      : `Permanently delete the source audio for “${selected.title}”? The transcript and summary will remain.`,
    {
      title: deletingAll ? 'Delete meeting?' : 'Delete source audio?',
      kind: 'warning',
      okLabel: deletingAll ? 'Delete meeting' : 'Delete audio',
      cancelLabel: 'Cancel',
    },
  )
  if (!accepted) return
  try {
    await meetings.remove(selected.id, mode)
    liveAnnouncement.value = deletingAll
      ? 'Meeting deleted'
      : 'Meeting source audio deleted'
  } catch (error) {
    emit('diagnostic', message(error))
  }
}

async function saveConfig(patch) {
  try {
    await meetings.saveConfig(patch)
  } catch (error) {
    emit('diagnostic', message(error))
  }
}

async function saveApiKey(value) {
  try {
    await meetings.saveApiKey(value)
  } catch (error) {
    emit('diagnostic', message(error))
  }
}

async function clearApiKey() {
  try {
    await meetings.clearApiKey()
  } catch (error) {
    emit('diagnostic', message(error))
  }
}

async function installModel(id) {
  try {
    await meetings.installModel(id)
  } catch (error) {
    emit('diagnostic', message(error))
  }
}

async function deleteModel(id) {
  try {
    await meetings.deleteModel(id)
  } catch (error) {
    emit('diagnostic', message(error))
  }
}

async function requestMicrophonePermission() {
  try {
    await meetings.requestMicrophonePermission()
  } catch {
    // The store owns the actionable native permission diagnostic.
  }
}

async function dismissCandidate(id) {
  try {
    await meetings.dismissCandidate(id)
  } catch (error) {
    emit('diagnostic', message(error))
  }
}

function onKeydown(event) {
  if (event.key === 'Escape' && confirmingStart.value) {
    cancelStart()
    event.preventDefault()
  }
}

function channelLabel(channel) {
  const active = meetings.activeMeeting
  if (!active?.channels.includes(channel)) return 'unavailable'
  if (channel === 'microphone' && active.micMuted) return 'muted'
  return 'active'
}

function channelSpeaker(channel) {
  if (channel === 'microphone') return 'You'
  if (channel === 'system') return 'Others'
  return 'Speaker'
}

function lifecycleLabel(value) {
  return ({
    arming: 'Starting capture',
    capturing: 'Recording',
    stopping: 'Stopping capture',
    finalizing: 'Finalizing transcript',
    ready: 'Ready',
    interrupted: 'Interrupted',
    needs_repair: 'Needs repair',
    failed: 'Failed',
  })[value] || String(value || 'Ready').replaceAll('-', ' ')
}

function transcriptionLabel(value) {
  return ({
    idle: 'not started',
    connecting: 'connecting',
    live: 'live',
    delayed: 'delayed',
    batch: 'repairing',
    final: 'final',
    failed: 'failed',
  })[value] || String(value || 'idle')
}

function summaryStatus(meeting) {
  return ({
    'not-started': meeting.transcriptFinal
      ? 'Title and summary have not started.'
      : 'The summary starts after the transcript is final.',
    queued: 'Title and summary are queued.',
    running: 'Mimir is creating the title and summary.',
    failed: 'Title and summary failed. The transcript is safe.',
  })[meeting.summaryState] || 'No summary is available.'
}

function diagnosticRows(meeting) {
  return [
    ['Status', lifecycleLabel(meeting.lifecycle)],
    ['Transcription', transcriptionLabel(meeting.transcription)],
    ['Channels', meeting.channels.join(', ') || 'None'],
    ['Transcript revision', String(meeting.transcriptRevision)],
    ['Transcript final', meeting.transcriptFinal ? 'Yes' : 'No'],
    ['Capture gaps', String(meeting.gaps.length)],
    ['Summary', meeting.summaryState.replaceAll('-', ' ')],
    ['Knowledge graph', meeting.kgState.replaceAll('-', ' ')],
    ['Source app', meeting.sourceApp || 'Manual'],
  ]
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
  const value = meeting.startedAt || meeting.updatedAt
  if (!value) return 'No date'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'No date'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function message(error) {
  return error instanceof Error ? error.message : String(error || 'Meeting operation failed.')
}
</script>

<style scoped>
.scribe-button,
.scribe-primary-button,
.scribe-stop {
  display: inline-flex;
  min-height: 28px;
  align-items: center;
  justify-content: center;
  gap: 5px;
  border: 1px solid var(--color-rule);
  padding: 0 9px;
  font-size: 10px;
  font-weight: 600;
}

.scribe-button {
  background: var(--color-chrome-high);
  color: var(--color-ink-2);
}

.scribe-button:hover:not(:disabled) {
  background: var(--color-chrome-mid);
  color: var(--color-ink);
}

.scribe-primary-button {
  border-color: var(--color-accent);
  background: var(--color-accent);
  color: var(--color-surface);
}

.scribe-primary-button:hover:not(:disabled) {
  filter: brightness(1.05);
}

.scribe-stop {
  border-color: var(--color-rem);
  background: transparent;
  color: var(--color-rem);
}

.scribe-stop:hover:not(:disabled) {
  background: color-mix(in srgb, var(--color-rem) 10%, transparent);
}

.scribe-button:focus-visible,
.scribe-primary-button:focus-visible,
.scribe-stop:focus-visible,
.scribe-icon-button:focus-visible,
.scribe-library-row:focus-visible {
  outline: 1px solid var(--color-accent);
  outline-offset: -1px;
}

.scribe-button:disabled,
.scribe-primary-button:disabled,
.scribe-stop:disabled,
.scribe-icon-button:disabled {
  cursor: default;
  opacity: 0.45;
}

.scribe-icon-button {
  display: grid;
  width: 28px;
  height: 28px;
  place-items: center;
  color: var(--color-ink-3);
}

.scribe-icon-button:hover:not(:disabled) {
  background: var(--color-chrome-mid);
  color: var(--color-ink);
}

.scribe-library-row {
  display: flex;
  width: 100%;
  min-height: 34px;
  align-items: center;
  gap: 7px;
  border-bottom: 1px solid var(--color-rule-light);
  padding: 6px 8px;
  color: var(--color-ink-2);
}

.scribe-library-row:hover {
  background: var(--color-chrome-mid);
  color: var(--color-ink);
}

.scribe-alert {
  display: flex;
  min-height: 34px;
  flex-shrink: 0;
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid var(--color-rule);
  padding: 6px 12px;
  color: var(--color-rem);
  font-size: 10px;
}

.scribe-alert button {
  text-decoration: underline;
  text-underline-offset: 2px;
}
</style>
