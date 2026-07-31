<template>
  <section
    ref="scribeRoot"
    data-scribe-app
    class="scribe-root flex h-full min-h-0 flex-col overflow-hidden bg-chrome-high text-ink"
    :aria-busy="meetings.loading || undefined"
    @keydown="onKeydown"
  >
    <header class="scribe-app-header flex min-h-11 shrink-0 items-center border-b border-rule px-3">
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
          ref="settingsButton"
          class="scribe-icon-button"
          :aria-expanded="settingsOpen"
          aria-controls="scribe-settings-panel"
          title="Scribe settings"
          aria-label="Scribe settings"
          @click="toggleSettings"
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
        <template v-if="meetings.activeMeeting.gapCount">
          · {{ meetings.activeMeeting.gapCount }}
          {{ meetings.activeMeeting.gapCount === 1 ? 'gap' : 'gaps' }}
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
      role="region"
      aria-labelledby="scribe-kg-offer-title"
      class="scribe-kg-offer flex shrink-0 items-center gap-3 border-b border-rule bg-surface px-3 py-2"
    >
      <IconTopologyStar3 :size="15" class="shrink-0 text-ink-2" />
      <p class="min-w-0 flex-1 text-[11px] text-ink-2">
        <strong id="scribe-kg-offer-title" class="font-semibold text-ink">
          {{ meetings.kgOffer.title }}
        </strong>
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
        class="scribe-button"
        :disabled="Boolean(meetings.pending[`kg:${meetings.kgOffer.id}`])"
        @click="decideKg(meetings.kgOffer.id, 'never')"
      >
        Never ask
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

    <div class="scribe-workspace flex min-h-0 flex-1">
      <aside
        class="scribe-library flex w-[224px] shrink-0 flex-col border-r border-rule bg-chrome"
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
              @click="beginStart(candidate, $event)"
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

        <div
          class="min-h-0 flex-1 overflow-y-auto"
          role="listbox"
          aria-label="Recorded meetings"
          :aria-busy="meetings.loading || undefined"
        >
          <button
            v-for="meeting in meetings.meetings"
            :key="meeting.id"
            type="button"
            data-scribe-meeting-row
            role="option"
            class="scribe-library-row min-h-12"
            :class="{ 'bg-accent-soft': meeting.id === meetings.selectedId }"
            :aria-selected="meeting.id === meetings.selectedId"
            :aria-label="meetingRowLabel(meeting)"
            :tabindex="meeting.id === meetings.selectedId ? 0 : -1"
            @click="meetings.select(meeting.id)"
            @keydown="onLibraryKeydown($event, meeting.id)"
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
            v-if="meetings.loading && !meetings.loaded"
            data-scribe-library-loading
            role="status"
            class="px-3 py-6 text-center text-[10px] leading-relaxed text-ink-3"
          >
            Loading meetings…
          </div>
          <div
            v-else-if="meetings.loaded && !meetings.meetings.length"
            class="px-3 py-6 text-center text-[10px] leading-relaxed text-ink-3"
          >
            No recordings yet. Choose Record meeting when everyone is informed.
          </div>
          <button
            v-else-if="meetings.meetingsTruncated"
            type="button"
            data-scribe-load-older
            class="w-full border-t border-rule-light px-3 py-2 text-left text-[9px] leading-relaxed text-ink-3 hover:text-ink"
            :disabled="Boolean(meetings.pending['library-page'])"
            @click="meetings.loadOlderMeetings()"
          >
            {{
              meetings.pending['library-page']
                ? 'Loading older meetings…'
                : 'Load older meetings'
            }}
          </button>
        </div>

        <button
          type="button"
          data-scribe-new
          class="m-2 flex h-8 items-center justify-center gap-1.5 border border-rule bg-chrome-high text-[10px] font-semibold hover:bg-chrome-mid focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-50"
          :disabled="Boolean(meetings.activeMeeting)"
          @click="beginStart(null, $event)"
        >
          <IconMicrophone :size="13" />
          Record meeting
        </button>
      </aside>

      <main class="scribe-main min-w-0 flex-1 overflow-hidden bg-chrome-high">
        <ScribeSettings
          v-if="settingsOpen"
          id="scribe-settings-panel"
          ref="settingsPanel"
          :config="meetings.config"
          :permissions="meetings.permissions"
          :models="meetings.models"
          :pending="meetings.pending"
          @close="closeSettings"
          @save="saveConfig"
          @save-api-key="saveApiKey"
          @clear-api-key="clearApiKey"
          @install-model="installModel"
          @delete-model="deleteModel"
          @request-microphone-permission="requestMicrophonePermission"
        />

        <div
          v-else-if="confirmingStart"
          ref="consentPanel"
          data-scribe-consent
          role="region"
          aria-labelledby="scribe-consent-title"
          :aria-describedby="consentDescriptionIds"
          tabindex="-1"
          class="mx-auto flex h-full max-w-xl flex-col justify-center px-8"
        >
          <p class="font-mono text-[9px] uppercase tracking-[0.12em] text-ink-3">
            Before recording
          </p>
          <h2 id="scribe-consent-title" class="mt-2 text-[17px] font-semibold">
            Confirm everyone is informed
          </h2>
          <p
            id="scribe-consent-scope"
            class="mt-2 max-w-lg text-[11px] leading-relaxed text-ink-2"
          >
            Scribe records microphone and system audio. You are responsible for obtaining
            any consent or giving any notice required for this meeting.
          </p>
          <div
            v-if="meetings.config.transcriptionMode === 'custom'"
            id="scribe-consent-route"
            data-scribe-hosted-disclosure
            class="mt-3 max-w-lg border-y border-rule bg-accent-soft px-3 py-2 text-[10px] leading-relaxed text-ink-2"
          >
            Both audio channels and transcript timing will be sent to
            <strong class="font-semibold text-ink">{{ customDestination }}</strong>
            using model <strong class="font-semibold text-ink">{{ meetings.config.customModel }}</strong>
            for transcription. Mimir will not silently switch to another provider.
          </div>
          <p
            v-else
            id="scribe-consent-route"
            class="mt-3 max-w-lg text-[10px] leading-relaxed text-ink-3"
          >
            Local transcription with {{ meetings.config.localModel }} stays on this Mac and does
            not send meeting audio to a provider.
          </p>
          <p
            v-if="candidateAppName"
            id="scribe-consent-candidate"
            data-scribe-candidate-disclosure
            class="mt-2 text-[10px] leading-relaxed text-ink-3"
          >
            This recording was suggested because {{ candidateAppName }} is using the microphone.
          </p>
          <label class="mt-5 flex items-start gap-2 text-[11px] leading-relaxed text-ink-2">
            <input
              v-model="consentConfirmed"
              ref="consentCheckbox"
              data-scribe-consent-checkbox
              type="checkbox"
              class="mt-0.5 accent-accent"
              :aria-describedby="consentDescriptionIds"
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
            <button
              type="button"
              class="scribe-button"
              :disabled="Boolean(meetings.pending.start)"
              @click="cancelStart"
            >
              Cancel
            </button>
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
          <p
            v-if="consentError"
            data-scribe-consent-error
            role="alert"
            class="mt-3 text-[10px] leading-relaxed text-rem"
          >
            {{ consentError }}
          </p>
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
            @click="beginStart(null, $event)"
          >
            Record meeting
          </button>
        </div>

        <article
          v-else
          data-scribe-meeting
          class="flex h-full min-h-0 flex-col"
          :aria-labelledby="`scribe-meeting-title-${meetings.selectedMeeting.id}`"
        >
          <header class="shrink-0 border-b border-rule px-4 py-3">
            <div class="flex items-start gap-3">
              <div class="min-w-0 flex-1">
                <h2
                  :id="`scribe-meeting-title-${meetings.selectedMeeting.id}`"
                  class="truncate text-[15px] font-semibold"
                >
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
                :disabled="meetingActionPending('export')"
                @click="exportSelected('markdown')"
              >
                <IconDownload :size="13" />
                {{
                  meetingActionPending('export:markdown')
                    ? 'Exporting…'
                    : 'Export'
                }}
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
            <div
              v-if="meetingNeedsRecovery(meetings.selectedMeeting)"
              data-scribe-recovery
              role="status"
              class="mt-3 flex items-center gap-2 border-y border-rule-light py-2 text-[10px]"
            >
              <IconAlertTriangle :size="13" class="shrink-0 text-rem" />
              <span class="min-w-0 flex-1 text-ink-2">
                {{ recoveryStatus(meetings.selectedMeeting) }}
              </span>
              <button
                v-if="failedJob(meetings.selectedMeeting, 'transcription')"
                type="button"
                class="scribe-button"
                :disabled="Boolean(
                  meetings.pending[`retry:${meetings.selectedMeeting.id}:transcription`],
                )"
                @click="retryJob(meetings.selectedMeeting.id, 'transcription')"
              >
                Retry transcription
              </button>
            </div>
            <nav
              class="mt-3 flex gap-4"
              role="tablist"
              aria-label="Meeting detail"
              @keydown="onDetailTabKeydown"
            >
              <button
                v-for="tab in detailTabs"
                :key="tab.id"
                type="button"
                :id="`scribe-detail-tab-${tab.id}`"
                role="tab"
                class="border-b pb-1 text-[10px]"
                :class="detailTab === tab.id
                  ? 'border-accent text-ink'
                  : 'border-transparent text-ink-3 hover:text-ink'"
                :aria-selected="detailTab === tab.id"
                :aria-controls="`scribe-detail-panel-${tab.id}`"
                :tabindex="detailTab === tab.id ? 0 : -1"
                @click="detailTab = tab.id"
              >
                {{ tab.label }}
              </button>
            </nav>
          </header>

          <div class="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            <section
              v-if="detailTab === 'transcript'"
              id="scribe-detail-panel-transcript"
              role="tabpanel"
              aria-labelledby="scribe-detail-tab-transcript"
              tabindex="0"
            >
              <div
                v-if="
                  meetings.selectedMeeting.transcriptTotalSegments
                    > meetings.selectedMeeting.segments.length
                "
                class="mb-2 flex items-center gap-2 border-b border-rule-light pb-2"
              >
                <span class="flex-1 font-mono text-[9px] text-ink-3">
                  Showing {{ meetings.selectedMeeting.segments.length }} of
                  {{ meetings.selectedMeeting.transcriptTotalSegments }} segments
                </span>
                <button
                  v-if="
                    !meetings.selectedMeeting.transcriptShowingLatest
                    || meetings.selectedMeeting.transcriptNewerAvailable
                  "
                  type="button"
                  data-scribe-transcript-latest
                  class="scribe-button"
                  :disabled="meetings.selectedMeeting.transcriptLoading"
                  @click="meetings.loadLatestTranscript()"
                >
                  Latest
                </button>
                <button
                  v-if="meetings.selectedMeeting.transcriptHasEarlier"
                  type="button"
                  data-scribe-transcript-earlier
                  class="scribe-button"
                  :disabled="meetings.selectedMeeting.transcriptLoading"
                  @click="meetings.loadEarlierTranscript()"
                >
                  Earlier
                </button>
              </div>
              <div
                v-if="meetings.selectedMeeting.transcriptError"
                data-scribe-transcript-error
                role="alert"
                class="scribe-inline-alert mb-3"
              >
                <IconAlertTriangle :size="13" class="shrink-0 text-rem" />
                <span class="min-w-0 flex-1">
                  Transcript could not be loaded: {{ meetings.selectedMeeting.transcriptError }}
                </span>
                <button
                  type="button"
                  class="scribe-button"
                  :disabled="meetings.selectedMeeting.transcriptLoading"
                  @click="meetings.loadLatestTranscript()"
                >
                  Retry transcript
                </button>
              </div>
              <div
                v-if="
                  meetings.selectedMeeting.transcriptLoading
                  && !transcriptLedgerEntries(meetings.selectedMeeting).length
                "
                role="status"
                class="py-12 text-center text-[11px] text-ink-3"
              >
                Loading transcript…
              </div>
              <div
                v-else-if="!transcriptLedgerEntries(meetings.selectedMeeting).length"
                class="py-12 text-center text-[11px] text-ink-3"
              >
                {{
                  meetings.selectedMeeting.lifecycle === 'capturing'
                    ? 'Listening for speech…'
                    : 'No transcript is available.'
                }}
              </div>
              <ol
                v-else
                data-scribe-transcript-ledger
                class="scribe-transcript-ledger"
                aria-label="Transcript time ledger"
              >
                <li
                  v-for="entry in transcriptLedgerEntries(meetings.selectedMeeting)"
                  :key="entry.key"
                  :data-scribe-ledger-kind="entry.kind"
                  :data-scribe-ledger-channel="entry.channel"
                  class="scribe-transcript-entry"
                >
                  <div class="scribe-transcript-time">
                    <time :datetime="durationDateTime(entry.startMs)">
                      {{ timestamp(entry.startMs) }}
                    </time>
                    <span class="scribe-transcript-marker" aria-hidden="true" />
                    <span>{{ entrySpeaker(entry) }}</span>
                  </div>
                  <div v-if="entry.kind === 'segment'" class="min-w-0 py-2">
                    <p class="select-text text-[12px] leading-[1.55] text-ink">
                      {{ entry.text }}
                    </p>
                    <span
                      v-if="!entry.final"
                      class="mt-1 block font-mono text-[9px] text-ink-3"
                    >
                      Live partial · wording may change
                    </span>
                  </div>
                  <div
                    v-else
                    class="scribe-gap-notice"
                    role="note"
                    :aria-label="gapLabel(entry)"
                  >
                    <IconAlertTriangle :size="13" class="shrink-0 text-rem" />
                    <span>
                      <strong class="font-medium text-ink-2">Capture gap</strong>
                      · {{ gapDuration(entry) }} · {{ humanize(entry.reason) }}
                    </span>
                  </div>
                </li>
              </ol>
            </section>

            <section
              v-else-if="detailTab === 'summary'"
              id="scribe-detail-panel-summary"
              role="tabpanel"
              aria-labelledby="scribe-detail-tab-summary"
              tabindex="0"
            >
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
                  :disabled="Boolean(
                    meetings.pending[`retry:${meetings.selectedMeeting.id}:title-summary`],
                  )"
                  @click="retryJob(meetings.selectedMeeting.id, 'title-summary')"
                >
                  {{
                    meetings.pending[`retry:${meetings.selectedMeeting.id}:title-summary`]
                      ? 'Retrying…'
                      : 'Retry title and summary'
                  }}
                </button>
              </div>
            </section>

            <section
              v-else
              id="scribe-detail-panel-details"
              role="tabpanel"
              aria-labelledby="scribe-detail-tab-details"
              tabindex="0"
            >
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
              <div
                v-if="meetings.selectedMeeting.jobs.length"
                class="mt-6 max-w-2xl border-t border-rule"
              >
                <h3 class="py-3 text-[11px] font-semibold">Follow-up work</h3>
                <ul class="border-t border-rule-light" aria-label="Meeting follow-up jobs">
                  <li
                    v-for="job in meetings.selectedMeeting.jobs"
                    :key="job.id"
                    class="flex min-h-10 items-center gap-3 border-b border-rule-light py-2 text-[10px]"
                  >
                    <span class="min-w-0 flex-1">
                      <strong class="block font-medium text-ink-2">
                        {{ jobLabel(job.kind) }}
                      </strong>
                      <span class="mt-0.5 block font-mono text-[9px] text-ink-3">
                        {{ humanize(job.status) }} · attempt {{ job.attempt }}
                        <template v-if="job.error"> · {{ job.error }}</template>
                      </span>
                    </span>
                    <button
                      v-if="job.activityId"
                      type="button"
                      class="scribe-button"
                      @click="$emit('openActivity', job.activityId)"
                    >
                      Open Activity
                    </button>
                    <button
                      v-if="job.status === 'failed'"
                      type="button"
                      class="scribe-button"
                      :disabled="Boolean(
                        meetings.pending[`retry:${meetings.selectedMeeting.id}:${job.kind}`],
                      )"
                      @click="retryJob(meetings.selectedMeeting.id, job.kind)"
                    >
                      Retry
                    </button>
                  </li>
                </ul>
              </div>
              <div class="mt-6 max-w-2xl border-t border-rule pt-4">
                <h3 class="text-[11px] font-semibold">Data and privacy</h3>
                <p class="mt-1 text-[10px] leading-relaxed text-ink-3">
                  Exports create a user-owned copy. Deletion cannot remove prior exports,
                  backups, or audio already processed by a custom provider.
                </p>
                <div class="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    class="scribe-button"
                    :disabled="meetingActionPending('export')"
                    @click="exportSelected('json')"
                  >
                    {{ meetingActionPending('export:json') ? 'Exporting…' : 'Export JSON' }}
                  </button>
                  <button
                    type="button"
                    class="scribe-button"
                    :disabled="meetingActionPending('export')"
                    @click="exportSelected('audio')"
                  >
                    {{ meetingActionPending('export:audio') ? 'Exporting…' : 'Export audio' }}
                  </button>
                  <button
                    type="button"
                    class="scribe-button text-rem"
                    :disabled="meetingActionPending('delete')"
                    @click="deleteSelected('audio')"
                  >
                    {{
                      meetingActionPending('delete')
                        ? 'Deleting…'
                        : 'Delete source audio'
                    }}
                  </button>
                  <button
                    type="button"
                    data-scribe-delete-meeting
                    class="scribe-button text-rem"
                    :disabled="meetingActionPending('delete')"
                    @click="deleteSelected('all')"
                  >
                    <IconTrash :size="13" />
                    {{ meetingActionPending('delete') ? 'Deleting…' : 'Delete meeting' }}
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
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
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
const scribeRoot = ref(null)
const settingsButton = ref(null)
const settingsPanel = ref(null)
const consentPanel = ref(null)
const consentCheckbox = ref(null)
const settingsOpen = ref(false)
const confirmingStart = ref(false)
const consentConfirmed = ref(false)
const consentError = ref('')
const startTitle = ref('')
const candidateId = ref(null)
const candidateAppName = ref('')
const detailTab = ref('transcript')
const editingMeeting = ref(false)
const editedTitle = ref('')
const editedSummary = ref('')
const now = ref(Date.now())
const liveAnnouncement = ref('')
let startOpener = null
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
    const destination = new URL(meetings.config.customUrl)
    return destination.protocol === 'https:'
      ? destination.toString()
      : 'the configured transcription service'
  } catch {
    return 'the configured transcription service'
  }
})
const consentDescriptionIds = computed(() => [
  'scribe-consent-scope',
  'scribe-consent-route',
  candidateAppName.value ? 'scribe-consent-candidate' : null,
].filter(Boolean).join(' '))

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
  scribeRoot.value?.querySelector('[data-scribe-stop], [data-scribe-new]')?.focus()
}

defineExpose({ focusEntry })

function beginStart(candidate = null, event = null) {
  startOpener = event?.currentTarget instanceof HTMLElement
    ? event.currentTarget
    : document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
  candidateId.value = candidate?.id || null
  candidateAppName.value = candidate?.appName || ''
  startTitle.value = candidate?.appName ? `${candidate.appName} meeting` : ''
  consentConfirmed.value = false
  consentError.value = ''
  settingsOpen.value = false
  confirmingStart.value = true
  nextTick(() => consentPanel.value?.focus())
}

function cancelStart() {
  if (meetings.pending.start) return
  confirmingStart.value = false
  candidateId.value = null
  candidateAppName.value = ''
  consentConfirmed.value = false
  consentError.value = ''
  nextTick(() => {
    if (startOpener?.isConnected) startOpener.focus()
    else focusEntry()
    startOpener = null
  })
}

async function start() {
  consentError.value = ''
  try {
    await meetings.start({
      title: startTitle.value,
      candidateId: candidateId.value,
      workspacePath: props.workspacePath,
    })
    cancelStart()
    liveAnnouncement.value = 'Recording started'
  } catch (error) {
    const detail = message(error)
    const requiresReconfirmation = /consent|disclosure|suggestion changed/i.test(detail)
    consentError.value = requiresReconfirmation
      ? 'Recording confirmation expired or changed. Review the disclosure and confirm again.'
      : detail
    if (requiresReconfirmation) {
      consentConfirmed.value = false
      nextTick(() => consentCheckbox.value?.focus())
    }
    emit('diagnostic', detail)
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
    liveAnnouncement.value = ({
      'create-draft': 'Knowledge-graph draft queued for review',
      'not-now': 'Knowledge-graph draft deferred',
      never: 'Knowledge-graph follow-up dismissed',
    })[decision]
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
    liveAnnouncement.value = `${jobLabel(kind)} retry queued`
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
    liveAnnouncement.value = `${exportLabel(format)} exported`
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
    liveAnnouncement.value = 'Scribe setting saved'
  } catch (error) {
    emit('diagnostic', message(error))
  }
}

async function saveApiKey(value) {
  try {
    await meetings.saveApiKey(value)
    liveAnnouncement.value = 'Custom transcription key saved in Keychain'
  } catch (error) {
    emit('diagnostic', message(error))
  }
}

async function clearApiKey() {
  try {
    await meetings.clearApiKey()
    liveAnnouncement.value = 'Custom transcription key removed'
  } catch (error) {
    emit('diagnostic', message(error))
  }
}

async function installModel(id) {
  try {
    await meetings.installModel(id)
    liveAnnouncement.value = 'Local model installation started'
  } catch (error) {
    emit('diagnostic', message(error))
  }
}

async function deleteModel(id) {
  try {
    await meetings.deleteModel(id)
    liveAnnouncement.value = 'Local model removed'
  } catch (error) {
    emit('diagnostic', message(error))
  }
}

async function requestMicrophonePermission() {
  try {
    const permission = await meetings.requestMicrophonePermission()
    liveAnnouncement.value = `Microphone permission ${permissionLabel(permission)}`
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
  if (event.key === 'Escape' && confirmingStart.value && !meetings.pending.start) {
    cancelStart()
    event.preventDefault()
  }
}

function toggleSettings() {
  if (settingsOpen.value) {
    closeSettings()
    return
  }
  confirmingStart.value = false
  settingsOpen.value = true
  nextTick(() => settingsPanel.value?.focusEntry?.())
}

function closeSettings() {
  settingsOpen.value = false
  nextTick(() => settingsButton.value?.focus())
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
  nextTick(() => scribeRoot.value
    ?.querySelector(`#scribe-detail-tab-${detailTabs[next].id}`)
    ?.focus())
}

function onLibraryKeydown(event, id) {
  if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
  const rows = [...scribeRoot.value?.querySelectorAll('[data-scribe-meeting-row]') || []]
  const current = rows.findIndex(row => row === event.currentTarget)
  if (current < 0 || !rows.length) return
  let next = current
  if (event.key === 'Home') next = 0
  if (event.key === 'End') next = rows.length - 1
  if (event.key === 'ArrowUp') next = Math.max(0, current - 1)
  if (event.key === 'ArrowDown') next = Math.min(rows.length - 1, current + 1)
  const target = rows[next]
  if (!(target instanceof HTMLElement)) return
  event.preventDefault()
  target.focus()
  const nextId = meetings.meetings[next]?.id
  if (nextId && nextId !== id) meetings.select(nextId)
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
    ['Capture gaps', String(meeting.gapCount)],
    ['Summary', meeting.summaryState.replaceAll('-', ' ')],
    ['Knowledge graph', meeting.kgState.replaceAll('-', ' ')],
    ['Source app', meeting.sourceApp || 'Manual'],
  ]
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
    left.startMs - right.startMs
    || (left.kind === 'gap' ? -1 : 1)
    || left.key.localeCompare(right.key)
  ))
}

function entrySpeaker(entry) {
  if (entry.kind === 'gap') return `${channelSpeaker(entry.channel)} gap`
  return entry.speaker || channelSpeaker(entry.channel)
}

function gapDuration(gap) {
  return `${formatDuration(Math.max(0, gap.endMs - gap.startMs))} unavailable`
}

function gapLabel(gap) {
  return `Capture gap for ${channelSpeaker(gap.channel)} at ${timestamp(gap.startMs)}; ${
    gapDuration(gap)
  }; ${humanize(gap.reason)}`
}

function meetingRowLabel(meeting) {
  return [
    meeting.title,
    meetingDate(meeting),
    lifecycleLabel(meeting.lifecycle),
    meeting.lifecycle === 'capturing' ? formatDuration(meeting.durationMs) : null,
  ].filter(Boolean).join(', ')
}

function meetingNeedsRecovery(meeting) {
  return ['interrupted', 'needs_repair', 'failed'].includes(meeting?.lifecycle)
    || Boolean(meeting?.error)
}

function recoveryStatus(meeting) {
  const transcriptionJob = meeting.jobs.find(job => job.kind === 'transcription')
  if (transcriptionJob?.status === 'failed') {
    return 'Stored audio is safe, but transcript recovery failed. Retry when the transcription route is available.'
  }
  if (['queued', 'running'].includes(transcriptionJob?.status)) {
    return `Stored audio is safe. Transcript recovery is ${transcriptionJob.status}.`
  }
  if (meeting.error) return `Stored audio needs attention: ${meeting.error}`
  return 'Capture ended unexpectedly. Stored audio is safe and recovery will resume after restart.'
}

function failedJob(meeting, kind) {
  return meeting?.jobs?.find(job => job.kind === kind && job.status === 'failed') || null
}

function jobLabel(kind) {
  return ({
    'title-summary': 'Title and summary',
    'kg-proposal': 'Knowledge-graph draft',
    transcription: 'Transcript recovery',
  })[kind] || humanize(kind)
}

function meetingActionPending(action) {
  const id = meetings.selectedMeeting?.id
  if (!id) return false
  if (action === 'export') {
    return Object.keys(meetings.pending).some(key => key.startsWith(`export:${id}:`))
  }
  if (action.startsWith('export:')) {
    return Boolean(meetings.pending[`export:${id}:${action.slice('export:'.length)}`])
  }
  if (action === 'delete') return Boolean(meetings.pending[`delete:${id}`])
  return false
}

function exportLabel(format) {
  return ({
    markdown: 'Markdown meeting',
    json: 'JSON meeting',
    audio: 'Meeting audio',
  })[format] || 'Meeting'
}

function permissionLabel(value) {
  return ({
    granted: 'granted',
    denied: 'denied',
    'prompt-on-start': 'requested when capture starts',
    unknown: 'not determined',
  })[value] || humanize(value)
}

function humanize(value) {
  return String(value || 'unknown').replaceAll(/[-_]/g, ' ')
}

function timestamp(milliseconds) {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function durationDateTime(milliseconds) {
  const seconds = Math.max(0, Number(milliseconds) || 0) / 1000
  return `PT${seconds}S`
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
.scribe-root {
  container: scribe / inline-size;
}

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

.scribe-inline-alert {
  display: flex;
  min-height: 36px;
  align-items: center;
  gap: 8px;
  border-block: 1px solid var(--color-rule-light);
  padding: 6px 0;
  color: var(--color-rem);
  font-size: 10px;
}

.scribe-transcript-ledger {
  border-top: 1px solid var(--color-rule);
}

.scribe-transcript-entry {
  display: grid;
  min-height: 52px;
  grid-template-columns: 84px minmax(0, 1fr);
  column-gap: 16px;
  border-bottom: 1px solid var(--color-rule-light);
}

.scribe-transcript-time {
  position: relative;
  display: grid;
  align-content: center;
  align-self: stretch;
  border-right: 1px solid var(--color-rule);
  padding-right: 13px;
  color: var(--color-ink-3);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 9px;
  font-variant-numeric: tabular-nums;
  line-height: 1.45;
  text-align: right;
}

.scribe-transcript-time > span:last-child {
  overflow: hidden;
  color: var(--color-ink-2);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.scribe-transcript-marker {
  position: absolute;
  top: 50%;
  right: -4px;
  width: 7px;
  height: 1px;
  background: var(--color-rule);
}

.scribe-transcript-entry[data-scribe-ledger-kind='segment']
  .scribe-transcript-time > span:last-child {
  font-weight: 600;
}

.scribe-transcript-entry[data-scribe-ledger-kind='gap'] {
  background: var(--color-chrome-mid);
}

.scribe-gap-notice {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 7px;
  padding-block: 8px;
  color: var(--color-ink-3);
  font-size: 10px;
}

[role='tabpanel']:focus-visible,
[data-scribe-consent]:focus-visible {
  outline: 1px solid var(--color-accent);
  outline-offset: -1px;
}

@container scribe (max-width: 620px) {
  .scribe-workspace {
    flex-direction: column;
  }

  .scribe-library {
    width: 100%;
    max-height: 172px;
    border-right: 0;
    border-bottom: 1px solid var(--color-rule);
  }

  .scribe-main {
    min-height: 240px;
  }

  .scribe-kg-offer {
    flex-wrap: wrap;
  }

  .scribe-kg-offer p {
    flex-basis: calc(100% - 30px);
  }
}

@container scribe (max-width: 440px) {
  .scribe-app-header {
    min-height: 52px;
    flex-wrap: wrap;
    gap: 3px;
    padding-block: 4px;
  }

  [data-scribe-ledger] {
    grid-template-columns: repeat(3, auto);
    gap: 2px 12px;
    padding-block: 5px;
  }

  [data-scribe-ledger] > :last-child {
    grid-column: 1 / -1;
    text-align: left;
  }

  .scribe-transcript-entry {
    grid-template-columns: 66px minmax(0, 1fr);
    column-gap: 10px;
  }

  .scribe-transcript-time {
    padding-right: 9px;
  }
}
</style>
