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
        type="button"
        data-graph-control="entry-work-with-agent"
        @click="moreAction(() => emit('startWork'))"
      >
        <IconArrowForwardUp :size="14" />
        Work with agent
      </button>
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
        @input="changed"
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
          <div class="entry-primary-relation">
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
            <button v-if="relatedTarget(draft.projectId)" type="button" class="object-icon-button"
              data-graph-control="entry-open-project" :aria-label="`Open project: ${displayTitle(relatedTarget(draft.projectId))}`"
              @click="openRelated(draft.projectId)"><IconArrowUpRight :size="13" /></button>
          </div>
        </div>
        <div class="object-metadata-field">
          <span>Owner</span>
          <div class="entry-primary-relation">
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
            <button v-if="relatedTarget(draft.assigneeId)" type="button" class="object-icon-button"
              data-graph-control="entry-open-owner" :aria-label="`Open owner: ${displayTitle(relatedTarget(draft.assigneeId))}`"
              @click="openRelated(draft.assigneeId)"><IconArrowUpRight :size="13" /></button>
          </div>
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
        <label v-if="draft.status === 'waiting' || draft.waitingFor || waitingFocused" class="object-metadata-field">
          <span>Waiting for</span>
          <input
            v-model="draft.waitingFor"
            data-inspector-waiting
            data-graph-control="focus-waiting"
            autocorrect="off"
            autocapitalize="off"
            spellcheck="false"
            placeholder="Nobody"
            @focus="waitingFocused = true"
            @blur="waitingFocused = false"
            @input="changed"
          />
        </label>
      </div>

      <textarea
        v-else-if="node.kind !== 'timesheet'"
        ref="summaryInput"
        v-model="draft.summary"
        data-inspector-summary
        data-graph-control="focus-summary"
        class="focus-summary-text"
        autocorrect="off"
        autocapitalize="off"
        aria-label="Description"
        placeholder="Add a short description…"
        @input="changed"
      />

      <div
        v-if="['project', 'meeting'].includes(node.kind)"
        class="object-metadata-grid object-metadata-grid-focus"
        aria-label="Object details"
      >
        <div v-if="node.kind === 'project'" class="object-metadata-field">
          <span>Status</span>
          <GraphSelect :model-value="draft.projectStatus" variant="quiet" aria-label="Project status"
            :options="projectStatuses" @update:model-value="updateDraft('projectStatus', $event)" />
        </div>
        <template v-else-if="node.kind === 'meeting'">
          <div class="object-metadata-field">
            <span>Project</span>
            <div class="entry-primary-relation">
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
              <button v-if="relatedTarget(draft.projectId)" type="button" class="object-icon-button"
                data-graph-control="entry-open-project" :aria-label="`Open project: ${displayTitle(relatedTarget(draft.projectId))}`"
                @click="openRelated(draft.projectId)"><IconArrowUpRight :size="13" /></button>
            </div>
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
              <span
                v-for="person in meetingAttendees"
                :key="person.id"
                class="entry-attendee"
              >
                <button type="button" :data-graph-control="`entry-open-person-${person.id}`"
                  @click="openRelated(person.id)">{{ displayTitle(person) }}</button>
                <button type="button" :data-graph-control="`focus-meeting-person-remove-${person.id}`"
                  :aria-label="`Remove ${displayTitle(person)}`" @click="removeMeetingAttendee(person.id)"><IconX :size="11" /></button>
              </span>
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

    <TimesheetDetails v-if="node.kind === 'timesheet'" :key="node.id" />

    <section class="focus-note">
      <GraphMarkdownEditor
        :key="node.id"
        ref="noteEditor"
        :view-state="viewState"
        :scope-ids="scopeIds"
        :graph-revision="graphRevision"
        v-model="draft.body"
        data-inspector-body
        data-graph-control="focus-working-note"
        :min-height="128"
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

    <section v-if="connectionRows.length || incomingConnections.length || connectionOpen" class="entry-related" aria-label="Related entries">
      <div class="entry-section-heading">
        <h3>Related</h3>
        <button type="button" data-graph-control="entry-add-relation" class="entry-quiet-action" :aria-expanded="connectionOpen" @click="connectionOpen = !connectionOpen">Add relation</button>
      </div>
      <div v-if="connectionOpen" class="connection-composer">
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
          placeholder="Choose an entry…"
          :options="connectionTargetOptions"
          :menu-min-width="320"
          searchable
          search-placeholder="Find an entry"
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
        <button type="button" data-graph-control="entry-cancel-relation" class="entry-quiet-action" @click="connectionOpen = false">Cancel</button>
      </div>

      <div v-for="connection in connectionRows" :key="`${connection.index}:${connection.edge.relation}:${connection.edge.target}`" class="entry-relation-row">
        <button type="button" class="object-link-row" :data-related-node="connection.edge.target"
          :data-graph-control="`focus-related-${connection.edge.target}`" :disabled="!connection.target" @click="openRelated(connection.edge.target)">
          <span><strong>{{ connectionTitle(connection) }}</strong><small>{{ human(connection.edge.relation) }}</small></span>
          <IconChevronRight :size="14" />
        </button>
        <button type="button" class="object-icon-button" :data-graph-control="`focus-connection-remove-${connection.index}`"
          :aria-label="`Remove ${human(connection.edge.relation)} connection to ${connectionTitle(connection)}`" @click="removeConnection(connection.index)"><IconX :size="14" /></button>
      </div>
      <button v-for="neighbor in incomingConnections" :key="`${neighbor.relation}:${neighbor.node.id}`" type="button"
        :data-related-node="neighbor.node.id" :data-graph-control="`focus-related-${neighbor.node.id}`" class="object-link-row entry-relation-link" @click="openRelated(neighbor.node.id)">
        <span><strong>{{ displayTitle(neighbor.node) }}</strong><small>{{ human(neighbor.relation) }} this entry</small></span>
        <IconChevronRight :size="14" />
      </button>
    </section>

    <section v-if="attachmentItems.length" class="entry-related" aria-label="Files">
      <h3 class="entry-section-heading">Files</h3>
      <button v-for="item in attachmentItems" :key="item.path" type="button" class="object-link-row"
        :data-deliverable-path="item.output ? item.path : undefined" :data-resource-path="item.output ? undefined : item.path"
        :data-graph-control="`focus-file-${item.path}`" @click="openSource(item.path)">
        <span class="file-mark">{{ fileExtension(item.path) }}</span>
        <span><strong>{{ item.label || fileName(item.path) }}</strong><small>{{ item.path }}</small></span>
        <IconArrowUpRight :size="14" />
      </button>
    </section>

    <section v-if="activities.length" class="entry-related" aria-label="Activities">
      <h3 class="entry-section-heading">Activities</h3>
      <button v-for="activity in activities" :key="activity.id" type="button" :data-related-activity="activity.id"
        :data-graph-control="`focus-activity-${activity.id}`" class="object-link-row" @click="openActivity(activity.id)">
        <span class="activity-dot" :class="activityStatusClass(activity.status)" />
        <span><strong>{{ activity.title }}</strong><small>{{ human(activity.status) }}</small></span>
        <IconChevronRight :size="14" />
      </button>
    </section>

    <div class="entry-secondary-actions">
      <button v-if="!connectionRows.length && !incomingConnections.length && !connectionOpen" type="button"
        data-graph-control="entry-add-relation" class="entry-quiet-action" :aria-expanded="connectionOpen" @click="connectionOpen = true">Add relation</button>
      <button type="button" data-graph-control="entry-properties" class="entry-disclosure" :aria-expanded="propertiesOpen"
        :aria-controls="`entry-properties-${node.id}`" @click="propertiesOpen = !propertiesOpen">
        <IconChevronRight :size="13" :class="{ 'is-open': propertiesOpen }" />More properties
      </button>
      <span v-if="draft.remindAt" class="entry-active-property">Reminder {{ readableDateTime(draft.remindAt) }}</span>
      <span v-if="draft.snoozeUntil" class="entry-active-property">Snoozed until {{ readableDate(draft.snoozeUntil) }}</span>
      <span v-if="editableTags" class="entry-active-property">{{ editableTags }}</span>
    </div>
    <section v-if="propertiesOpen" :id="`entry-properties-${node.id}`" class="entry-extra-properties" aria-label="More properties">
      <div v-if="node.kind === 'issue'" class="focus-property-grid">
        <label class="object-metadata-field">
          <span>Waiting for</span>
          <input v-model="draft.waitingFor" data-inspector-waiting-extra data-graph-control="entry-waiting-extra"
            autocorrect="off" autocapitalize="off" spellcheck="false" aria-label="Waiting for" placeholder="Nobody" @input="changed" />
        </label>
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
        <span>Outputs</span>
        <small>One path per line. Optional label after “|”.</small>
        <textarea
          ref="deliverablesInput"
          v-model="draft.deliverables"
          data-inspector-deliverables
          data-graph-control="focus-deliverables"
          autocorrect="off"
          autocapitalize="off"
          spellcheck="false"
          placeholder="outputs/evidence-map.xlsx | Evidence map"
          @input="changed"
        />
      </label>

      <label class="focus-deliverables-field">
        <span>Files</span>
        <small>One path per line. Optional label after “|”.</small>
        <textarea
          ref="filesInput"
          v-model="draft.files"
          data-inspector-files
          data-graph-control="focus-files"
          autocorrect="off"
          autocapitalize="off"
          spellcheck="false"
          placeholder="resources/proposal-template.html | Proposal template"
          @input="changed"
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
      <div class="object-metadata-grid object-metadata-grid-focus">
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
        </template>
        <template v-if="node.kind === 'company'">
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

        <template v-if="node.kind === 'meeting'">
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

    <section v-if="node.kind === 'project'" class="entry-related" aria-label="Project time sheets">
      <div class="entry-section-heading">
        <h3>Time sheets</h3>
        <button type="button" data-graph-control="time-create-related" class="entry-quiet-action" @click="quickCreate('timesheet')">Add time sheet</button>
      </div>
      <button v-for="sheet in projectTimeSheets" :key="sheet.id" type="button" class="object-link-row entry-relation-link"
        :data-graph-control="`time-open-sheet-${sheet.id}`" @click="openRelated(sheet.id)">
        <span><strong>{{ displayTitle(sheet) }}</strong></span><IconChevronRight :size="14" />
      </button>
    </section>
  </article>
</main>
</template>

<script setup>
import { computed, inject, ref, watch } from 'vue'
import {
  IconAlertTriangle,
  IconArrowForwardUp,
  IconArrowUpRight,
  IconChevronRight,
  IconDots,
  IconHistory,
  IconPaperclip,
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
import TimesheetDetails from './TimesheetDetails.vue'
import { GRAPH_INSPECTOR_CONTEXT } from './graphInspectorContext.js'

const {
  node,
  nodes,
  neighbors,
  viewState,
  noteEditor,
  scopeIds,
  graphRevision,
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
  propertiesOpen,
  connectionOpen,
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
  incomingConnections,
  canAddConnection,
  attachmentItems,
  canAddTeamResource,
  canRecoverTeamResource,
  unlinkedResourceItems,
  saveStateLabel,
  saveStateClass,
  editableTags,
  lookupFacts,
  emit,
  save,
  addMeetingAttendee,
  removeMeetingAttendee,
  openRelated,
  relatedTarget,
  openSource,
  openUrl,
  openActivity,
  quickCreate,
  copyFact,
  changed,
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

const projectTimeSheets = computed(() => {
  const sheets = new Map(nodes.value.filter(sheet => sheet.kind === 'timesheet'
    && (sheet.projectId === node.value.id || sheet.relations?.some(edge => edge.relation === 'part_of' && edge.target === node.value.id)))
    .map(sheet => [sheet.id, sheet]))
  for (const neighbor of neighbors.value) {
    if (neighbor.direction === 'incoming' && neighbor.relation === 'part_of' && neighbor.node.kind === 'timesheet') sheets.set(neighbor.node.id, neighbor.node)
  }
  return [...sheets.values()].sort((left, right) => displayTitle(left).localeCompare(displayTitle(right)))
})
const waitingFocused = ref(false)
watch(() => node.value?.id, () => {
  waitingFocused.value = false
})
</script>
