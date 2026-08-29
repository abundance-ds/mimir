<template>
  <section data-meeting-inbox class="meeting-inbox">
    <template v-if="selectedMeeting">
      <header class="meeting-detail-bar">
        <button
          type="button"
          data-graph-control="meeting-inbox-back"
          class="meeting-secondary"
          @click="selectedId = ''"
        >
          <IconChevronLeft :size="14" />
          Meeting inbox
        </button>
        <span class="flex-1" />
        <button
          type="button"
          data-meeting-open-transcript
          data-graph-control="meeting-inbox-transcript"
          class="meeting-secondary"
          @click="$emit('openMeeting', selectedMeeting.id)"
        >
          <IconFileText :size="14" />
          Open transcript
        </button>
      </header>

      <div class="meeting-detail-scroll">
        <article class="meeting-detail">
          <header>
            <p class="meeting-kicker">Pending meeting</p>
            <h1>{{ selectedMeeting.title }}</h1>
            <p class="meeting-time">
              {{ readableDateTime(selectedMeeting.startedAt || selectedMeeting.updatedAt) }}
              · {{ formatDuration(selectedMeeting.durationMs) }}
            </p>
          </header>

          <section class="meeting-summary" aria-label="Meeting summary">
            <pre>{{ selectedMeeting.summary }}</pre>
          </section>

          <section class="meeting-filing" aria-label="Meeting filing details">
            <h2>File this meeting</h2>
            <div class="meeting-fields">
              <label>
                <span>Project</span>
                <GraphSelect
                  :model-value="projectChoice"
                  data-meeting-project
                  variant="field"
                  aria-label="Meeting project"
                  :options="projectOptions"
                  :menu-min-width="280"
                  searchable
                  search-placeholder="Find a project"
                  @update:model-value="setProjectChoice"
                />
              </label>
              <label>
                <span>Scope</span>
                <GraphSelect
                  :model-value="scopeId"
                  data-meeting-scope
                  variant="field"
                  aria-label="Meeting scope"
                  :options="scopeOptions"
                  :menu-min-width="220"
                  @update:model-value="setScope"
                />
              </label>
            </div>

            <div class="meeting-people">
              <span>People</span>
              <div v-if="selectedPeople.length" class="meeting-person-list">
                <button
                  v-for="person in selectedPeople"
                  :key="person.id"
                  type="button"
                  :data-graph-control="`meeting-inbox-person-remove-${person.id}`"
                  :aria-label="`Remove ${person.title || person.id}`"
                  @click="removePerson(person.id)"
                >
                  {{ person.title || person.id }}
                  <IconX :size="12" />
                </button>
              </div>
              <GraphSelect
                v-if="availablePeopleOptions.length"
                :model-value="personToAdd"
                data-meeting-person-add
                variant="field"
                aria-label="Add meeting person"
                placeholder="Add a person…"
                :options="availablePeopleOptions"
                :menu-min-width="280"
                searchable
                search-placeholder="Find a person"
                @update:model-value="addPerson"
              />
              <p v-else-if="!people.length" class="meeting-help">No person nodes are available.</p>
            </div>

            <p v-if="projectChoice === '__choose__'" class="meeting-help">
              Choose a project or select None.
            </p>
            <p v-if="error" role="alert" class="meeting-error">{{ error }}</p>
            <button
              type="button"
              data-meeting-file
              data-graph-control="meeting-inbox-file"
              class="meeting-primary"
              :disabled="!canFile"
              @click="file"
            >
              {{ filing ? 'Filing…' : 'File to Graph' }}
            </button>
          </section>
        </article>
      </div>
    </template>

    <template v-else>
      <header class="meeting-inbox-header">
        <div>
          <h1>Meeting inbox</h1>
          <p>File completed Scribe summaries into the Graph.</p>
        </div>
        <strong>{{ meetings.length }}</strong>
      </header>

      <div v-if="meetings.length" class="meeting-list" role="list">
        <button
          v-for="meeting in meetings"
          :key="meeting.id"
          type="button"
          role="listitem"
          :data-meeting-inbox-row="meeting.id"
          :data-graph-control="`meeting-inbox-open-${meeting.id}`"
          @click="open(meeting)"
        >
          <span>
            <strong>{{ meeting.title }}</strong>
            <small>{{ readableDateTime(meeting.startedAt || meeting.updatedAt) }}</small>
          </span>
          <span class="meeting-row-meta">{{ formatDuration(meeting.durationMs) }}</span>
          <IconChevronRight :size="14" />
        </button>
      </div>
      <div v-else class="meeting-empty">
        <h2>Inbox clear</h2>
        <p>Completed summaries appear here until you file them.</p>
      </div>
      <button
        v-if="hasMore"
        type="button"
        data-graph-control="meeting-inbox-load-more"
        class="meeting-load-more"
        :disabled="loadingMore"
        @click="$emit('loadMore')"
      >
        {{ loadingMore ? 'Loading…' : 'Load older meetings' }}
      </button>
    </template>
  </section>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { IconChevronLeft, IconChevronRight, IconFileText, IconX } from '@tabler/icons-vue'
import GraphSelect from './GraphSelect.vue'

const props = defineProps({
  meetings: { type: Array, default: () => [] },
  projects: { type: Array, default: () => [] },
  people: { type: Array, default: () => [] },
  scopes: { type: Array, default: () => [] },
  defaultProjectId: { type: String, default: '' },
  filingId: { type: String, default: '' },
  error: { type: String, default: '' },
  hasMore: { type: Boolean, default: false },
  loadingMore: { type: Boolean, default: false },
})

const emit = defineEmits(['file', 'openMeeting', 'loadMore', 'select', 'change'])
const selectedId = ref('')
const projectChoice = ref('__choose__')
const scopeId = ref('')
const peopleIds = ref([])
const personToAdd = ref('')

const selectedMeeting = computed(() => (
  props.meetings.find(meeting => meeting.id === selectedId.value) || null
))
const filing = computed(() => props.filingId === selectedId.value)
const canFile = computed(() => (
  selectedMeeting.value
  && projectChoice.value !== '__choose__'
  && scopeId.value
  && !filing.value
))
const projectOptions = computed(() => [
  { value: '__choose__', label: 'Choose…', disabled: true, separatorAfter: true },
  { value: '__none__', label: 'None', hint: 'This meeting has no project' },
  ...props.projects
    .map(project => ({
      value: project.id,
      label: project.title || project.id,
      hint: project.properties?.slug || project.slug || '',
    }))
    .sort((left, right) => left.label.localeCompare(right.label)),
])
const scopeOptions = computed(() => props.scopes.map(scope => ({
  value: scope.id,
  label: scopeLabel(scope.kind),
  hint: scope.kind === 'project' ? 'Current workspace' : '',
})))
const selectedPeople = computed(() => peopleIds.value
  .map(id => props.people.find(person => person.id === id))
  .filter(Boolean))
const availablePeopleOptions = computed(() => props.people
  .filter(person => !peopleIds.value.includes(person.id))
  .map(person => ({ value: person.id, label: person.title || person.id }))
  .sort((left, right) => left.label.localeCompare(right.label)))

watch(
  () => props.meetings.map(meeting => meeting.id),
  ids => {
    if (selectedId.value && !ids.includes(selectedId.value)) selectedId.value = ''
  },
)

function open(meeting) {
  selectedId.value = meeting.id
  const saved = meeting.graphDraft || {}
  projectChoice.value = saved.projectResolved
    ? saved.projectId || '__none__'
    : props.defaultProjectId && props.projects.some(project => project.id === props.defaultProjectId)
      ? props.defaultProjectId
      : '__choose__'
  scopeId.value = saved.scopeId || preferredScope(props.scopes)
  peopleIds.value = Array.isArray(saved.peopleIds) ? [...new Set(saved.peopleIds)] : []
  personToAdd.value = ''
  emit('select', meeting.id)
}

function setProjectChoice(value) {
  projectChoice.value = value
  persistDraft()
}

function setScope(value) {
  scopeId.value = value
  persistDraft()
}

function addPerson(id) {
  if (id && !peopleIds.value.includes(id)) peopleIds.value = [...peopleIds.value, id]
  personToAdd.value = ''
  persistDraft()
}

function removePerson(id) {
  peopleIds.value = peopleIds.value.filter(personId => personId !== id)
  persistDraft()
}

function persistDraft() {
  if (!selectedMeeting.value) return
  emit('change', {
    meetingId: selectedMeeting.value.id,
    graphDraft: {
      projectResolved: projectChoice.value !== '__choose__',
      projectId: !['__choose__', '__none__'].includes(projectChoice.value)
        ? projectChoice.value
        : null,
      peopleIds: [...peopleIds.value],
      scopeId: scopeId.value || null,
    },
  })
}

function file() {
  if (!canFile.value) return
  emit('file', {
    meetingId: selectedMeeting.value.id,
    scopeId: scopeId.value,
    projectId: projectChoice.value === '__none__' ? null : projectChoice.value,
    peopleIds: [...peopleIds.value],
  })
}

function preferredScope(scopes) {
  return scopes.find(scope => scope.kind === 'team')?.id
    || scopes.find(scope => scope.kind === 'project')?.id
    || scopes.find(scope => scope.kind === 'private')?.id
    || ''
}

function scopeLabel(kind) {
  return { team: 'Team', project: 'Project', private: 'Private' }[kind] || String(kind || '')
}

function readableDateTime(value) {
  const date = new Date(value || '')
  if (Number.isNaN(date.getTime())) return 'Date unavailable'
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

function formatDuration(milliseconds) {
  const totalMinutes = Math.max(0, Math.round((Number(milliseconds) || 0) / 60_000))
  if (totalMinutes < 60) return `${totalMinutes} min`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes ? `${hours} h ${minutes} min` : `${hours} h`
}
</script>

<style scoped>
.meeting-inbox {
  min-height: 0;
  flex: 1;
  overflow: hidden;
  background: var(--color-chrome-high);
}

.meeting-inbox-header,
.meeting-detail-bar {
  display: flex;
  min-height: 54px;
  align-items: center;
  gap: 12px;
  border-bottom: 1px solid var(--color-rule);
  padding: 0 18px;
}

.meeting-inbox-header h1 {
  font-size: 13px;
  font-weight: 650;
}

.meeting-inbox-header p {
  margin-top: 2px;
  color: var(--color-ink-3);
  font-size: 10px;
}

.meeting-inbox-header strong {
  margin-left: auto;
  color: var(--color-ink-3);
  font-family: var(--font-mono);
  font-size: 10px;
}

.meeting-list {
  overflow-y: auto;
}

.meeting-list > button {
  display: grid;
  min-height: 54px;
  width: 100%;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 14px;
  border-bottom: 1px solid var(--color-rule-light);
  padding: 8px 18px;
  text-align: left;
}

.meeting-list > button:hover,
.meeting-list > button:focus-visible {
  background: var(--color-chrome-mid);
  outline: none;
}

.meeting-list strong,
.meeting-list small {
  display: block;
}

.meeting-list strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
}

.meeting-list small,
.meeting-row-meta {
  margin-top: 3px;
  color: var(--color-ink-3);
  font-family: var(--font-mono);
  font-size: 9px;
}

.meeting-detail-scroll {
  height: calc(100% - 54px);
  overflow-y: auto;
}

.meeting-detail {
  width: min(760px, calc(100% - 40px));
  margin: 0 auto;
  padding: 30px 0 60px;
}

.meeting-kicker {
  color: var(--color-ink-3);
  font-family: var(--font-mono);
  font-size: 9px;
}

.meeting-detail h1 {
  margin-top: 5px;
  font-size: 22px;
  font-weight: 650;
  line-height: 1.25;
}

.meeting-time {
  margin-top: 7px;
  color: var(--color-ink-3);
  font-family: var(--font-mono);
  font-size: 9px;
}

.meeting-summary {
  margin-top: 26px;
  border-top: 1px solid var(--color-rule-light);
  padding-top: 20px;
}

.meeting-summary pre {
  white-space: pre-wrap;
  color: var(--color-ink-2);
  font-family: var(--font-sans);
  font-size: 12px;
  line-height: 1.75;
}

.meeting-filing {
  margin-top: 28px;
  border-top: 1px solid var(--color-rule);
  padding-top: 20px;
}

.meeting-filing h2 {
  font-size: 12px;
  font-weight: 650;
}

.meeting-fields {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(180px, 0.55fr);
  gap: 14px;
  margin-top: 14px;
}

.meeting-fields label > span,
.meeting-people > span {
  display: block;
  margin-bottom: 5px;
  color: var(--color-ink-3);
  font-size: 9px;
}

.meeting-people {
  margin-top: 14px;
}

.meeting-person-list {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-bottom: 7px;
}

.meeting-person-list button {
  display: inline-flex;
  min-height: 26px;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--color-rule-light);
  border-radius: 2px;
  padding: 0 7px;
  color: var(--color-ink-2);
  font-size: 10px;
}

.meeting-person-list button:hover {
  background: var(--color-chrome-mid);
}

.meeting-primary,
.meeting-secondary,
.meeting-load-more {
  display: inline-flex;
  min-height: 30px;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 1px solid var(--color-rule);
  padding: 0 10px;
  font-size: 10px;
  font-weight: 620;
}

.meeting-primary {
  margin-top: 16px;
  border-color: var(--color-accent);
  background: var(--color-accent);
  color: var(--color-surface);
}

.meeting-secondary:hover,
.meeting-load-more:hover {
  background: var(--color-chrome-mid);
}

.meeting-primary:disabled,
.meeting-load-more:disabled {
  opacity: 0.5;
}

.meeting-help,
.meeting-error {
  margin-top: 8px;
  font-size: 10px;
}

.meeting-help {
  color: var(--color-ink-3);
}

.meeting-error {
  color: var(--color-rem);
}

.meeting-empty {
  padding: 70px 24px;
  text-align: center;
}

.meeting-empty h2 {
  font-size: 13px;
  font-weight: 650;
}

.meeting-empty p {
  margin-top: 5px;
  color: var(--color-ink-3);
  font-size: 11px;
}

.meeting-load-more {
  margin: 14px 18px;
}

@media (max-width: 680px) {
  .meeting-fields {
    grid-template-columns: 1fr;
  }
}
</style>
