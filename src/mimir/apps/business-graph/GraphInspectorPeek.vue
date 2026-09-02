<template>
<header class="peek-header">
  <div class="object-history-controls" aria-label="Object history">
    <button
      type="button"
      data-inspector-history-back
      data-graph-control="peek-history-back"
      class="object-icon-button"
      :disabled="!historyBack"
      :title="historyBack ? `Back to ${historyBack.title}` : 'No previous object'"
      :aria-label="historyBack ? `Back to ${historyBack.title}` : 'No previous object'"
      @click="emit('navigateHistory', -1)"
    >
      <IconChevronLeft :size="15" />
    </button>
    <button
      type="button"
      data-inspector-history-forward
      data-graph-control="peek-history-forward"
      class="object-icon-button"
      :disabled="!historyForward"
      :title="historyForward ? `Forward to ${historyForward.title}` : 'No next object'"
      :aria-label="historyForward ? `Forward to ${historyForward.title}` : 'No next object'"
      @click="emit('navigateHistory', 1)"
    >
      <IconChevronRight :size="15" />
    </button>
  </div>
  <span class="object-header-spacer" />
  <span class="peek-save-state" :class="saveStateClass" aria-live="polite">
    {{ saveStateLabel }}
  </span>
  <button
    type="button"
    data-inspector-focus
    data-graph-control="peek-focus"
    class="object-secondary-action peek-focus-action"
    title="Open Focus"
    @click="emit('focus')"
  >
    <IconMaximize :size="13" />
    Focus
  </button>
  <button
    type="button"
    data-inspector-source
    data-graph-control="peek-source"
    class="object-icon-button"
    title="Open Markdown source"
    aria-label="Open Markdown source"
    @click="openSource(node.provenance?.sourcePath)"
  >
    <IconFileCode :size="15" />
  </button>
  <div class="object-more-wrap" data-object-more-root>
    <button
      type="button"
      data-graph-control="peek-more"
      class="object-icon-button"
      title="More actions"
      aria-label="More actions"
      :aria-expanded="moreOpen"
      @click="moreOpen = !moreOpen"
    >
      <IconDots :size="16" />
    </button>
    <div v-if="moreOpen" class="object-more-menu">
      <button
        v-if="node.kind === 'issue'"
        type="button"
        data-inspector-next-action
        data-graph-control="peek-next-action"
        @click="moreAction(() => quickCreate('issue'))"
      >
        <IconArrowForwardUp :size="14" />
        Create next action
      </button>
      <button
        v-if="node.kind === 'project'"
        type="button"
        data-inspector-record-decision
        data-graph-control="peek-record-decision"
        @click="moreAction(() => quickCreate('decision'))"
      >
        <IconScale :size="14" />
        Record decision
      </button>
      <button
        type="button"
        data-inspector-file-history
        data-graph-control="peek-file-history"
        @click="toggleHistory"
      >
        <IconHistory :size="14" />
        History
      </button>
      <button
        type="button"
        data-inspector-delete
        data-graph-control="peek-delete"
        class="danger"
        @click="moreAction(remove)"
      >
        <IconTrash :size="14" />
        Move to Trash
      </button>
    </div>
  </div>
  <button
    type="button"
    data-inspector-close
    data-graph-control="peek-close"
    class="object-icon-button"
    title="Close Peek"
    aria-label="Close Peek"
    @click="requestExit('close')"
  >
    <IconX :size="15" />
  </button>
</header>

<div v-if="conflict" data-graph-conflict role="alert" class="object-conflict">
  <IconAlertTriangle :size="15" />
  <span>The Markdown source changed elsewhere. Review the current source before applying another edit.</span>
</div>
<div v-else-if="error" data-graph-save-error role="alert" class="object-conflict">
  <IconAlertTriangle :size="15" />
  <span>{{ error }}</span>
</div>

<section v-if="historyOpen" data-inspector-file-history-panel class="object-file-history">
  <p v-if="historyLoading">Loading History…</p>
  <p v-else-if="historyError" role="alert" class="object-file-history-error">{{ historyError }}</p>
  <p v-else-if="!historyEntries.length">No saved versions yet.</p>
  <template v-else>
    <button
      v-for="entry in historyEntries"
      :key="entry.hash"
      type="button"
      :data-file-history-version="entry.hash"
      :data-graph-control="`peek-history-${entry.hash}`"
      @click="openHistoryVersion(entry)"
    >
      <span>{{ entry.message }}</span>
      <small>{{ entry.shortHash }} · {{ readableDateTime(entry.authoredAt) }}</small>
    </button>
  </template>
</section>

<div
  class="peek-scroll"
  :class="{ 'peek-scroll-fill-note': !activities.length && !deliverableItems.length && !resourceItems.length }"
>
  <section v-if="lookupFacts.length" class="peek-lookup-facts" aria-label="Contact facts">
    <button
      v-for="fact in lookupFacts"
      :key="fact.label"
      type="button"
      :data-peek-fact="fact.label.toLowerCase()"
      class="peek-fact"
      @click="copyFact(fact)"
    >
      <span>{{ fact.label }}</span>
      <strong>{{ copiedFact === fact.label ? 'Copied' : fact.value }}</strong>
    </button>
  </section>

  <section class="peek-hero">
    <textarea
      ref="titleInput"
      v-model="draft.title"
      data-inspector-title
      data-graph-control="peek-title"
      class="peek-title-input"
      rows="1"
      autocorrect="off"
      autocapitalize="off"
      aria-label="Object title"
      @input="changedAndGrow"
    />

    <textarea
      v-if="node.kind !== 'issue'"
      ref="summaryInput"
      v-model="draft.summary"
      data-inspector-summary
      data-graph-control="peek-summary"
      class="peek-summary-text"
      rows="1"
      autocorrect="off"
      autocapitalize="off"
      aria-label="Retrieval summary"
      placeholder="One sentence an agent can retrieve this by."
      @input="changedAndGrow"
    />

    <div
      v-if="node.kind === 'issue'"
      class="object-metadata-grid object-metadata-grid-peek"
      aria-label="Issue details"
    >
      <div class="object-metadata-field">
        <span>Status</span>
        <GraphSelect
          :model-value="draft.status"
          data-inspector-status
          data-graph-control="peek-status"
          variant="quiet"
          aria-label="Issue status"
          :options="statuses"
          @update:model-value="quickUpdate('status', $event)"
        />
      </div>
      <div class="object-metadata-field">
        <span>Priority</span>
        <GraphSelect
          :model-value="draft.priority"
          data-inspector-priority
          data-graph-control="peek-priority"
          variant="quiet"
          aria-label="Issue priority"
          :options="priorities"
          @update:model-value="quickUpdate('priority', $event)"
        />
      </div>
      <div class="object-metadata-field">
        <span>Project</span>
        <GraphSelect
          :model-value="draft.projectId"
          data-inspector-project
          data-graph-control="peek-project"
          variant="quiet"
          aria-label="Issue project"
          placeholder="No project"
          :options="projectOptions"
          :menu-min-width="260"
          searchable
          search-placeholder="Find a project"
          @update:model-value="updateDraft('projectId', $event)"
        />
      </div>
      <div class="object-metadata-field">
        <span>Owner</span>
        <GraphSelect
          :model-value="draft.assigneeId"
          data-inspector-assignee
          data-graph-control="peek-assignee"
          variant="quiet"
          aria-label="Issue assignee"
          placeholder="Unassigned"
          :options="personOptions"
          :menu-min-width="260"
          searchable
          search-placeholder="Find a person"
          @update:model-value="updateDraft('assigneeId', $event)"
        />
      </div>
      <div class="object-metadata-field">
        <span>Due date</span>
        <GraphDatePicker
          :model-value="draft.dueDate"
          data-inspector-due
          data-graph-control="peek-due"
          variant="quiet"
          aria-label="Issue due date"
          placeholder="No due date"
          :class="{ attention: isOverdue(draft.dueDate) }"
          @update:model-value="updateDraft('dueDate', $event)"
        />
      </div>
      <label class="object-metadata-field">
        <span>Waiting for</span>
        <input
          v-model="draft.waitingFor"
          data-inspector-waiting
          data-graph-control="peek-waiting"
          autocorrect="off"
          autocapitalize="off"
          spellcheck="false"
          placeholder="Nobody"
          @input="changed"
        />
      </label>
      <div class="object-metadata-field object-metadata-date">
        <span>Created</span>
        <strong data-inspector-created>{{ readableDateTime(node.createdAt) || 'Unknown' }}</strong>
      </div>
      <div class="object-metadata-field object-metadata-date">
        <span>Last updated</span>
        <strong data-inspector-updated>{{ readableDateTime(node.updatedAt) || 'Unknown' }}</strong>
      </div>
    </div>
    <p
      v-if="node.kind === 'issue' && attentionLabel !== 'Clear'"
      class="peek-attention"
    >
      {{ attentionLabel }}
    </p>

    <div
      v-if="node.kind !== 'issue'"
      class="object-metadata-grid object-metadata-grid-peek"
      aria-label="Object details"
    >
      <template v-if="node.kind === 'project'">
        <div class="object-metadata-field">
          <span>Type</span>
          <GraphSelect
            :model-value="draft.projectType"
            variant="quiet"
            aria-label="Project type"
            :options="projectTypes"
            @update:model-value="updateDraft('projectType', $event)"
          />
        </div>
        <div class="object-metadata-field">
          <span>Status</span>
          <GraphSelect
            :model-value="draft.projectStatus"
            variant="quiet"
            aria-label="Project status"
            :options="projectStatuses"
            @update:model-value="updateDraft('projectStatus', $event)"
          />
        </div>
      </template>
      <template v-else-if="node.kind === 'meeting'">
        <div class="object-metadata-field">
          <span>Project</span>
          <GraphSelect
            :model-value="draft.projectId"
            data-inspector-meeting-project
            variant="quiet"
            aria-label="Meeting project"
            placeholder="No project"
            :options="projectOptions"
            :menu-min-width="260"
            searchable
            search-placeholder="Find a project"
            @update:model-value="updateDraft('projectId', $event)"
          />
        </div>
        <div class="object-metadata-field">
          <span>Scope</span>
          <GraphSelect
            :model-value="draft.scopeId"
            data-inspector-meeting-scope
            variant="quiet"
            aria-label="Meeting scope"
            :options="scopeOptions"
            @update:model-value="updateDraft('scopeId', $event)"
          />
        </div>
        <div class="object-metadata-field object-metadata-date">
          <span>Date</span>
          <strong>{{ readableDateTime(node.properties?.occurredAt) || 'Unknown' }}</strong>
        </div>
        <div class="object-metadata-field object-metadata-date">
          <span>Duration</span>
          <strong>{{ readableDuration(node.properties?.durationMs) }}</strong>
        </div>
        <div class="object-metadata-field meeting-people-field">
          <span>People</span>
          <div v-if="meetingAttendees.length" class="meeting-attendees">
            <button
              v-for="person in meetingAttendees"
              :key="person.id"
              type="button"
              :data-graph-control="`peek-meeting-person-remove-${person.id}`"
              :aria-label="`Remove ${displayTitle(person)}`"
              @click="removeMeetingAttendee(person.id)"
            >
              {{ displayTitle(person) }}
              <IconX :size="11" />
            </button>
          </div>
          <GraphSelect
            v-if="meetingPersonOptions.length"
            :model-value="attendeeToAdd"
            variant="quiet"
            aria-label="Add meeting person"
            placeholder="Add a person…"
            :options="meetingPersonOptions"
            :menu-min-width="260"
            searchable
            search-placeholder="Find a person"
            @update:model-value="addMeetingAttendee"
          />
        </div>
        <div v-if="node.properties?.sourceMeetingId" class="object-metadata-field">
          <span>Transcript</span>
          <button
            type="button"
            data-graph-control="peek-meeting-transcript"
            class="meeting-transcript-action"
            @click="emit('openMeeting', node.properties.sourceMeetingId)"
          >
            Open in Scribe
          </button>
        </div>
      </template>
      <template v-else-if="node.kind === 'company'">
        <label class="object-metadata-field">
          <span>Relationships</span>
          <input
            v-model="draft.companyRoles"
            data-graph-control="peek-company-roles"
            autocorrect="off"
            autocapitalize="off"
            spellcheck="false"
            aria-label="Company relationships"
            placeholder="client, partner"
            @input="changed"
          />
        </label>
        <div class="object-metadata-field">
          <span>Status</span>
          <GraphSelect
            :model-value="draft.entityStatus"
            variant="quiet"
            aria-label="Company status"
            :options="entityStatuses"
            @update:model-value="updateDraft('entityStatus', $event)"
          />
        </div>
      </template>
      <template v-else-if="node.kind === 'person'">
        <div class="object-metadata-field">
          <span>Status</span>
          <GraphSelect
            :model-value="draft.entityStatus"
            variant="quiet"
            aria-label="Person status"
            :options="entityStatuses"
            @update:model-value="updateDraft('entityStatus', $event)"
          />
        </div>
        <div class="object-metadata-field object-metadata-checkbox">
          <span>Assignment</span>
          <GraphCheckbox
            :model-value="draft.teamMember"
            @update:model-value="updateDraft('teamMember', $event)"
          >
            Team member
          </GraphCheckbox>
        </div>
      </template>
      <div class="object-metadata-field object-metadata-date">
        <span>Created</span>
        <strong data-inspector-created>{{ readableDateTime(node.createdAt) || 'Unknown' }}</strong>
      </div>
      <div class="object-metadata-field object-metadata-date">
        <span>Last updated</span>
        <strong data-inspector-updated>{{ readableDateTime(node.updatedAt) || 'Unknown' }}</strong>
      </div>
    </div>
  </section>

  <section class="peek-section peek-note-section">
    <GraphMarkdownEditor
      v-model="draft.body"
      data-inspector-body
      data-graph-control="peek-working-note"
      :disabled="saving"
      :min-height="150"
      :framed="false"
      :open-links="true"
      control-id="peek-working-note"
      aria-label="Working note in Markdown"
      @change="changed"
      @save="save"
      @open-file="openSource"
      @open-url="openUrl"
    />
  </section>

  <section v-if="activities.length" class="peek-section">
    <div class="object-section-heading">
      <span class="object-section-label">Recent Activity</span>
      <span class="object-section-count">{{ activities.length }}</span>
    </div>
    <button
      v-for="activity in activities.slice(0, 5)"
      :key="activity.id"
      type="button"
      :data-related-activity="activity.id"
      :data-graph-control="`peek-activity-${activity.id}`"
      class="object-link-row"
      @click="openActivity(activity.id)"
    >
      <span class="activity-dot" :class="activityStatusClass(activity.status)" />
      <span>
        <strong>{{ activity.title }}</strong>
        <small>{{ human(activity.status) }}</small>
      </span>
      <IconChevronRight :size="14" />
    </button>
  </section>

  <section v-if="deliverableItems.length" class="peek-section">
    <div class="object-section-heading">
      <span class="object-section-label">Deliverables</span>
      <span class="object-section-count">{{ deliverableItems.length }}</span>
    </div>
    <button
      v-for="deliverable in deliverableItems"
      :key="deliverable.path"
      type="button"
      :data-deliverable-path="deliverable.path"
      :data-graph-control="`peek-deliverable-${deliverable.path}`"
      class="object-link-row"
      @click="openSource(deliverable.path)"
    >
      <span class="file-mark">{{ fileExtension(deliverable.path) }}</span>
      <span>
        <strong>{{ deliverable.label || fileName(deliverable.path) }}</strong>
        <small>{{ deliverable.path }}</small>
      </span>
      <IconArrowUpRight :size="14" />
    </button>
  </section>

  <section v-if="resourceItems.length" class="peek-section">
    <div class="object-section-heading">
      <span class="object-section-label">Files</span>
      <span class="object-section-count">{{ resourceItems.length }}</span>
    </div>
    <button
      v-for="resource in resourceItems"
      :key="resource.path"
      type="button"
      :data-resource-path="resource.path"
      :data-graph-control="`peek-resource-${resource.path}`"
      class="object-link-row"
      @click="openSource(resource.path)"
    >
      <span class="file-mark">{{ fileExtension(resource.path) }}</span>
      <span>
        <strong>{{ resource.label || fileName(resource.path) }}</strong>
        <small>{{ resource.path }}</small>
      </span>
      <IconArrowUpRight :size="14" />
    </button>
  </section>

  <details class="peek-details">
    <summary data-graph-control="peek-details">
      <span>Details</span>
      <small v-if="neighbors.length">
        {{ neighbors.length }} {{ neighbors.length === 1 ? 'connection' : 'connections' }}
      </small>
    </summary>
    <div class="peek-details-content">
      <section class="peek-details-group">
        <span class="object-section-label">Connections</span>
        <GraphRelationshipLine
          :node="node"
          :neighbors="neighbors"
          :limit="6"
          @open="openRelated"
        />
      </section>
    </div>
  </details>
</div>
</template>

<script setup>
import { inject } from 'vue'
import {
  IconAlertTriangle,
  IconArrowForwardUp,
  IconArrowUpRight,
  IconChevronLeft,
  IconChevronRight,
  IconDots,
  IconFileCode,
  IconHistory,
  IconMaximize,
  IconScale,
  IconTrash,
  IconX,
} from '@tabler/icons-vue'
import GraphCheckbox from './GraphCheckbox.vue'
import GraphDatePicker from './GraphDatePicker.vue'
import GraphMarkdownEditor from './GraphMarkdownEditor.vue'
import GraphRelationshipLine from './GraphRelationshipLine.vue'
import GraphSelect from './GraphSelect.vue'
import { GRAPH_INSPECTOR_CONTEXT } from './graphInspectorContext.js'

const {
  node,
  neighbors,
  conflict,
  error,
  saving,
  activities,
  historyBack,
  historyForward,
  titleInput,
  summaryInput,
  deliverablesInput,
  filesInput,
  dirty,
  copiedFact,
  moreOpen,
  historyOpen,
  historyLoading,
  historyError,
  historyEntries,
  connectionRelation,
  connectionTarget,
  attendeeToAdd,
  draft,
  statuses,
  priorities,
  projectTypes,
  projectStatuses,
  entityStatuses,
  projectOptions,
  personOptions,
  scopeOptions,
  meetingAttendees,
  meetingPersonOptions,
  relationOptions,
  connectionTargetOptions,
  connectionRows,
  canAddConnection,
  deliverableItems,
  resourceItems,
  attentionLabel,
  saveStateLabel,
  saveStateClass,
  editableTags,
  lookupFacts,
  emit,
  save,
  addMeetingAttendee,
  removeMeetingAttendee,
  requestExit,
  openRelated,
  openSource,
  openUrl,
  openActivity,
  quickCreate,
  copyFact,
  changed,
  changedAndGrow,
  updateDraft,
  selectConnectionRelation,
  addConnection,
  removeConnection,
  quickUpdate,
  connectionTitle,
  displayTitle,
  remove,
  moreAction,
  toggleHistory,
  openHistoryVersion,
  readableDate,
  readableDateTime,
  readableDuration,
  isOverdue,
  activityStatusClass,
  fileName,
  fileExtension,
  human
} = inject(GRAPH_INSPECTOR_CONTEXT)
</script>
