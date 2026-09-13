<template>
<header class="focus-header">
  <div class="graph-document-views" aria-label="Entry view">
    <button type="button" data-graph-control="entry-details" aria-pressed="true" class="is-active">Details</button>
    <button type="button" data-graph-control="entry-source" @click="emit('source')">Source</button>
  </div>
  <span class="object-header-spacer" />
  <span class="focus-save-state" :class="saveStateClass" aria-live="polite">
    {{ saveStateLabel }}
  </span>
  <button
    type="button"
    data-inspector-save
    data-graph-control="focus-save"
    class="object-primary-action focus-save-button"
    :disabled="!dirty || saving || !draft.title.trim()"
    @click="save"
  >
    {{ saving ? 'Saving…' : 'Save' }}
  </button>
  <div class="object-more-wrap" data-object-more-root>
    <button
      type="button"
      data-graph-control="focus-more"
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
        data-graph-control="focus-next-action"
        @click="moreAction(() => quickCreate('issue'))"
      >
        <IconArrowForwardUp :size="14" />
        Create next action
      </button>
      <button
        v-else-if="node.kind === 'project'"
        type="button"
        data-inspector-record-decision
        data-graph-control="focus-record-decision"
        @click="moreAction(() => quickCreate('decision'))"
      >
        <IconScale :size="14" />
        Record decision
      </button>
      <button
        v-if="fileHistoryAvailable"
        type="button"
        data-inspector-file-history
        data-graph-control="focus-file-history"
        @click="toggleHistory"
      >
        <IconHistory :size="14" />
        History
      </button>
      <button
        type="button"
        data-inspector-delete
        data-graph-control="focus-delete"
        class="danger"
        @click="moreAction(remove)"
      >
        <IconTrash :size="14" />
        Move to Trash
      </button>
    </div>
  </div>
</header>

<div v-if="error" data-graph-save-error role="alert" class="object-conflict">
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
      :data-graph-control="`focus-history-${entry.hash}`"
      @click="openHistoryVersion(entry)"
    >
      <span>{{ entry.message }}</span>
      <small>{{ entry.shortHash }} · {{ readableDateTime(entry.authoredAt) }}</small>
    </button>
  </template>
</section>

<main class="focus-scroll">
  <article class="focus-document">
    <header class="focus-hero">
      <p class="graph-entry-context">{{ human(node.kind) }} · {{ human(node.provenance?.scopeKind || node.provenance?.scopeId?.split(':')[0] || 'Graph') }}</p>
      <textarea
        ref="titleInput"
        v-model="draft.title"
        data-inspector-title
        data-graph-control="focus-title"
        class="focus-title-input"
        rows="1"
        autocorrect="off"
        autocapitalize="off"
        aria-label="Entry title"
        @input="changedAndGrow"
      />

      <div
        v-if="node.kind === 'issue'"
        class="object-metadata-grid object-metadata-grid-focus"
        aria-label="Issue details"
      >
        <div class="object-metadata-field">
          <span>Status</span>
          <GraphSelect
            :model-value="draft.status"
            data-inspector-status
            data-graph-control="focus-status"
            variant="quiet"
            aria-label="Issue status"
            :options="statuses"
            @update:model-value="updateDraft('status', $event)"
          />
        </div>
        <div class="object-metadata-field">
          <span>Priority</span>
          <GraphSelect
            :model-value="draft.priority"
            data-inspector-priority
            data-graph-control="focus-priority"
            variant="quiet"
            aria-label="Issue priority"
            :options="priorities"
            @update:model-value="updateDraft('priority', $event)"
          />
        </div>
        <div class="object-metadata-field">
          <span>Project</span>
          <GraphSelect
            :model-value="draft.projectId"
            data-inspector-project
            data-graph-control="focus-project"
            variant="quiet"
            aria-label="Issue project"
            placeholder="No project"
            :options="projectOptions"
            :menu-min-width="280"
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
            data-graph-control="focus-assignee"
            variant="quiet"
            aria-label="Issue assignee"
            placeholder="Unassigned"
            :options="personOptions"
            :menu-min-width="280"
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
            data-graph-control="focus-due"
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
            data-graph-control="focus-waiting"
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

      <textarea
        v-else
        ref="summaryInput"
        v-model="draft.summary"
        data-inspector-summary
        data-graph-control="focus-summary"
        class="focus-summary-text"
        autocorrect="off"
        autocapitalize="off"
        aria-label="Retrieval summary"
        placeholder="A concise retrieval hint for people and agents"
        @input="changedAndGrow"
      />

      <div
        v-if="node.kind !== 'issue'"
        class="object-metadata-grid object-metadata-grid-focus"
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
              :menu-min-width="280"
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
                :data-graph-control="`focus-meeting-person-remove-${person.id}`"
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
              :menu-min-width="280"
              searchable
              search-placeholder="Find a person"
              @update:model-value="addMeetingAttendee"
            />
          </div>
          <div v-if="node.properties?.sourceMeetingId" class="object-metadata-field">
            <span>Transcript</span>
            <button
              type="button"
              data-graph-control="focus-meeting-transcript"
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
              data-graph-control="focus-company-roles"
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
      <div v-if="lookupFacts.length" class="graph-entry-facts">
        <button v-for="fact in lookupFacts" :key="fact.label" type="button"
          :data-graph-control="`entry-fact-${fact.label.toLowerCase()}`"
          :title="`Copy ${fact.label.toLowerCase()}`" @click="copyFact(fact)">
          <span>{{ copiedFact === fact.label ? 'Copied' : fact.label }}</span>
          <strong>{{ fact.value }}</strong>
        </button>
      </div>
    </header>

    <ProjectStanding
      v-if="node.kind === 'project'"
      :project="node"
      :nodes="nodes"
      @open-node="openRelated"
      @open-file="openSource"
    />

    <section class="focus-note">
      <span class="object-section-label">Working note</span>
      <GraphMarkdownEditor
        :key="node.id"
        ref="noteEditor"
        :view-state="viewState"
        :scope-ids="scopeIds"
        :graph-revision="graphRevision"
        v-model="draft.body"
        data-inspector-body
        data-graph-control="focus-working-note"
        :min-height="240"
        :framed="false"
        :open-links="true"
        control-id="focus-working-note"
        aria-label="Working note in Markdown"
        @change="changed"
        @save="save"
        @open-file="openSource"
        @open-url="openUrl"
        @open-graph="openRelated"
      />
    </section>

    <GraphReferences
      :node="node"
      :scope-ids="scopeIds"
      :graph-revision="graphRevision"
      :dirty="dirty"
      @open="openRelated"
    />

    <section class="focus-connections-section">
      <span class="object-section-label">Connections</span>

      <div class="connection-composer">
        <GraphSelect
          :model-value="connectionRelation"
          data-inspector-connection-relation
          data-graph-control="focus-connection-relation"
          variant="field"
          aria-label="Relationship type"
          :options="relationOptions"
          :menu-min-width="230"
          @update:model-value="selectConnectionRelation"
        />
        <GraphSelect
          :model-value="connectionTarget"
          data-inspector-connection-target
          data-graph-control="focus-connection-target"
          variant="field"
          aria-label="Connected object"
          placeholder="Choose an object…"
          :options="connectionTargetOptions"
          :menu-min-width="320"
          searchable
          search-placeholder="Find a visible graph object"
          @update:model-value="connectionTarget = $event"
        />
        <button
          type="button"
          data-graph-control="focus-connection-add"
          class="connection-add"
          :disabled="!canAddConnection"
          @click="addConnection"
        >
          <IconPlus :size="14" />
          Add
        </button>
      </div>

      <div v-if="connectionRows.length" class="connection-list">
        <div
          v-for="connection in connectionRows"
          :key="`${connection.index}:${connection.edge.relation}:${connection.edge.target}`"
          class="connection-row"
        >
          <IconLink :size="14" />
          <span>
            <strong>{{ human(connection.edge.relation) }}</strong>
            <small>{{ connectionTitle(connection) }}</small>
          </span>
          <span>{{ human(connection.target?.kind || 'unresolved') }}</span>
          <button
            type="button"
            :data-graph-control="`focus-connection-remove-${connection.index}`"
            :aria-label="`Remove ${human(connection.edge.relation)} connection to ${connectionTitle(connection)}`"
            @click="removeConnection(connection.index)"
          >
            <IconX :size="14" />
          </button>
        </div>
      </div>
      <p v-else class="connection-empty">
        No outgoing connections yet. Incoming links appear under Connected work.
      </p>
    </section>

    <section class="focus-details-section">
      <span class="object-section-label">
        {{ node.kind === 'issue' ? 'Planning' : 'Properties' }}
      </span>

      <div v-if="node.kind === 'issue'" class="focus-property-grid">
        <div class="object-metadata-field">
          <span>Reminder</span>
          <GraphDateTimeField
            :model-value="draft.remindAt"
            data-inspector-reminder
            data-graph-control="focus-reminder"
            variant="quiet"
            aria-label="Issue reminder"
            control-id="focus-reminder"
            @update:model-value="updateDraft('remindAt', $event)"
          />
        </div>
        <div class="object-metadata-field">
          <span>Snooze until</span>
          <GraphDatePicker
            :model-value="draft.snoozeUntil"
            data-inspector-snooze
            data-graph-control="focus-snooze"
            variant="quiet"
            aria-label="Snooze until"
            placeholder="Not snoozed"
            @update:model-value="updateDraft('snoozeUntil', $event)"
          />
        </div>
      </div>

      <div class="focus-property-grid focus-classification-grid">
        <label class="object-metadata-field">
          <span>Tags</span>
          <input
            v-model="editableTags"
            data-inspector-tags
            data-graph-control="focus-tags"
            autocorrect="off"
            autocapitalize="off"
            spellcheck="false"
            placeholder="strategy, evidence, client"
            @input="changed"
          />
          <small>Comma separated</small>
        </label>
      </div>

      <label v-if="node.kind === 'issue'" class="focus-deliverables-field">
        <span>Deliverables</span>
        <small>One path per line; add an optional label after “|”.</small>
        <textarea
          ref="deliverablesInput"
          v-model="draft.deliverables"
          data-inspector-deliverables
          data-graph-control="focus-deliverables"
          autocorrect="off"
          autocapitalize="off"
          spellcheck="false"
          placeholder="outputs/evidence-map.xlsx | Evidence map"
          @input="changedAndGrow"
        />
      </label>

      <label class="focus-deliverables-field">
        <span>Files</span>
        <small>One path per line; add an optional label after “|”.</small>
        <textarea
          ref="filesInput"
          v-model="draft.files"
          data-inspector-files
          data-graph-control="focus-files"
          autocorrect="off"
          autocapitalize="off"
          spellcheck="false"
          placeholder="resources/proposal-template.html | Proposal template"
          @input="changedAndGrow"
        />
        <button
          v-if="canAddTeamResource"
          type="button"
          data-inspector-add-resource
          data-graph-control="focus-add-resource"
          class="object-secondary-action self-start"
          @click.prevent="addResourceFile"
        >
          <IconPaperclip :size="13" />
          Add Team file
        </button>
        <small v-if="resourceError" role="alert" class="text-rem">{{ resourceError }}</small>
      </label>
      <div
        v-if="canRecoverTeamResource && unlinkedResourceItems.length"
        data-inspector-unlinked-resources
        class="focus-unlinked-resources"
      >
        <span>Unlinked Team files</span>
        <small>Attach a file that is already in Team resources.</small>
        <button
          v-for="resource in unlinkedResourceItems"
          :key="resource.path"
          type="button"
          :data-unlinked-resource="resource.path"
          :data-graph-control="`focus-unlinked-${resource.path}`"
          class="object-link-row"
          @click="attachTeamResource(resource)"
        >
          <span class="file-mark">{{ fileExtension(resource.path) }}</span>
          <span>
            <strong>{{ fileName(resource.path) }}</strong>
            <small>{{ resource.path }}</small>
          </span>
          <IconPaperclip :size="14" />
        </button>
      </div>
    </section>

    <section
      v-if="neighbors.length || activities.length || deliverableItems.length || resourceItems.length"
      class="focus-connected-section"
    >
      <span class="object-section-label">Connected work</span>
      <div class="focus-connected-grid">
        <div v-if="neighbors.length">
          <h3>Related objects</h3>
          <button
            v-for="neighbor in neighbors"
            :key="`${neighbor.direction}:${neighbor.relation}:${neighbor.node.id}`"
            type="button"
            :data-related-node="neighbor.node.id"
            :data-graph-control="`focus-related-${neighbor.node.id}`"
            class="object-link-row"
            @click="openRelated(neighbor.node.id)"
          >
            <span class="relation-mark">
              {{ neighbor.direction === 'incoming' ? '←' : '→' }}
            </span>
            <span>
              <strong>{{ displayTitle(neighbor.node) }}</strong>
              <small>{{ human(neighbor.relation) }} · {{ human(neighbor.node.kind) }}</small>
            </span>
            <IconChevronRight :size="14" />
          </button>
        </div>

        <div v-if="activities.length">
          <h3>Activities</h3>
          <button
            v-for="activity in activities"
            :key="activity.id"
            type="button"
            :data-related-activity="activity.id"
            :data-graph-control="`focus-activity-${activity.id}`"
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
        </div>

        <div v-if="deliverableItems.length">
          <h3>Deliverables</h3>
          <button
            v-for="deliverable in deliverableItems"
            :key="deliverable.path"
            type="button"
            :data-deliverable-path="deliverable.path"
            :data-graph-control="`focus-deliverable-${deliverable.path}`"
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
        </div>
        <div v-if="resourceItems.length">
          <h3>Files</h3>
          <button
            v-for="resource in resourceItems"
            :key="resource.path"
            type="button"
            :data-resource-path="resource.path"
            :data-graph-control="`focus-resource-${resource.path}`"
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
        </div>
      </div>
    </section>

  </article>
</main>
</template>

<script setup>
import { inject } from 'vue'
import {
  IconAlertTriangle,
  IconArrowForwardUp,
  IconArrowUpRight,
  IconChevronRight,
  IconDots,
  IconHistory,
  IconPaperclip,
  IconLink,
  IconPlus,
  IconScale,
  IconTrash,
  IconX,
} from '@tabler/icons-vue'
import GraphCheckbox from './GraphCheckbox.vue'
import GraphDatePicker from './GraphDatePicker.vue'
import GraphDateTimeField from './GraphDateTimeField.vue'
import GraphMarkdownEditor from './GraphMarkdownEditor.vue'
import GraphReferences from './GraphReferences.vue'
import GraphSelect from './GraphSelect.vue'
import ProjectStanding from './ProjectStanding.vue'
import { GRAPH_INSPECTOR_CONTEXT } from './graphInspectorContext.js'

const {
  node,
  nodes,
  viewState,
  noteEditor,
  scopeIds,
  graphRevision,
  neighbors,
  error,
  saving,
  activities,
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
  fileHistoryAvailable,
  resourceError,
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
  canAddTeamResource,
  canRecoverTeamResource,
  unlinkedResourceItems,
  attentionLabel,
  saveStateLabel,
  saveStateClass,
  editableTags,
  lookupFacts,
  emit,
  save,
  addMeetingAttendee,
  removeMeetingAttendee,
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
  connectionTitle,
  displayTitle,
  remove,
  moreAction,
  toggleHistory,
  openHistoryVersion,
  addResourceFile,
  attachTeamResource,
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
