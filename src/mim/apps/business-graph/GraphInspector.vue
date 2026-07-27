<template>
  <aside
    v-if="node"
    ref="inspectorRoot"
    data-graph-inspector
    :data-inspector-mode="mode"
    class="graph-object"
    :class="mode === 'focus' ? 'graph-object-focus' : 'graph-object-peek'"
    @keydown="onKeydown"
  >
    <template v-if="mode === 'peek'">
      <header class="peek-header">
        <span class="peek-identity">
          <span>{{ human(node.kind) }} · {{ scopeLabel }}</span>
          <small>{{ node.id }}</small>
        </span>
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

      <div class="peek-scroll">
        <section class="peek-hero">
          <h1 data-inspector-title>{{ node.title || node.id }}</h1>
          <p v-if="node.summary" class="peek-summary">{{ node.summary }}</p>

          <div v-if="node.kind === 'issue'" class="peek-quick-properties">
            <label>
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
            </label>
            <label>
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
            </label>
          </div>
        </section>

        <section class="peek-section relationship-section">
          <span class="object-section-label">In context</span>
          <GraphRelationshipLine
            :node="node"
            :neighbors="neighbors"
            @open="openRelated"
          />
        </section>

        <section v-if="node.body" class="peek-section">
          <div class="object-section-heading">
            <span class="object-section-label">Working note</span>
            <button
              type="button"
              data-inspector-body-edit
              data-graph-control="peek-edit-note"
              @click="$emit('focus')"
            >
              Edit in Focus
            </button>
          </div>
          <GraphMarkdownPreview
            data-inspector-body-preview
            :value="node.body"
            compact
            :max-blocks="6"
          />
        </section>

        <section v-if="node.kind === 'issue'" class="peek-section">
          <span class="object-section-label">Operational context</span>
          <dl class="peek-facts">
            <div>
              <dt>Project</dt>
              <dd>{{ projectTitle || 'No project' }}</dd>
            </div>
            <div>
              <dt>Owner</dt>
              <dd>{{ assigneeTitle || 'Unassigned' }}</dd>
            </div>
            <div>
              <dt>Due</dt>
              <dd :class="{ attention: isOverdue(draft.dueDate) }">
                {{ readableDate(draft.dueDate) || 'No due date' }}
              </dd>
            </div>
            <div>
              <dt>Attention</dt>
              <dd :class="{ attention: draft.waitingFor || draft.snoozeUntil }">
                {{ attentionLabel }}
              </dd>
            </div>
          </dl>
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

        <details class="peek-provenance">
          <summary data-graph-control="peek-source-details">Source details</summary>
          <dl>
            <dt>scope</dt>
            <dd>{{ node.provenance?.scopeId }}</dd>
            <dt>updated</dt>
            <dd>{{ readableDateTime(node.updatedAt) || 'Unknown' }}</dd>
            <dt>revision</dt>
            <dd>{{ shortRevision }}</dd>
            <dt>path</dt>
            <dd>{{ node.provenance?.sourcePath }}</dd>
          </dl>
        </details>
      </div>

      <footer class="peek-footer">
        <button
          type="button"
          data-inspector-focus
          data-graph-control="peek-focus"
          class="object-primary-action"
          @click="$emit('focus')"
        >
          <IconMaximize :size="14" />
          Focus
          <kbd>F</kbd>
        </button>
        <button
          type="button"
          data-inspector-start-work
          data-graph-control="peek-start-work"
          class="object-secondary-action"
          @click="startWork"
        >
          <IconSparkles :size="14" />
          Start work
        </button>
        <div class="peek-more-wrap" data-peek-more-root>
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
          <div v-if="moreOpen" class="peek-more-menu">
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
              data-graph-control="peek-open-source"
              @click="moreAction(() => openSource(node.provenance?.sourcePath))"
            >
              <IconFileCode :size="14" />
              Open Markdown source
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
      </footer>
    </template>

    <template v-else>
      <header class="focus-header">
        <button
          type="button"
          data-graph-control="focus-back"
          class="object-secondary-action"
          @click="requestExit('back')"
        >
          <IconArrowLeft :size="14" />
          Back to projection
        </button>
        <span class="focus-header-identity">
          {{ human(node.kind) }}
          <small>{{ scopeLabel }}</small>
        </span>
        <span class="focus-save-state" :class="saveStateClass" aria-live="polite">
          {{ saveStateLabel }}
        </span>
        <button
          type="button"
          data-graph-control="focus-source"
          class="object-icon-button"
          title="Open Markdown source"
          aria-label="Open Markdown source"
          @click="openSource(node.provenance?.sourcePath)"
        >
          <IconFileCode :size="15" />
        </button>
        <button
          type="button"
          data-graph-control="focus-close"
          class="object-icon-button"
          title="Close object"
          aria-label="Close object"
          @click="requestExit('close')"
        >
          <IconX :size="15" />
        </button>
      </header>

      <div v-if="conflict" data-graph-conflict role="alert" class="object-conflict">
        <IconAlertTriangle :size="15" />
        <span>
          The source changed elsewhere. Mim kept this draft; compare it with the Markdown source before saving again.
        </span>
      </div>
      <div v-else-if="error" data-graph-save-error role="alert" class="object-conflict">
        <IconAlertTriangle :size="15" />
        <span>{{ error }}</span>
      </div>

      <main class="focus-scroll">
        <article class="focus-document">
          <header class="focus-hero">
            <span class="focus-object-id">{{ node.id }}</span>
            <textarea
              ref="titleInput"
              v-model="draft.title"
              data-inspector-title
              data-graph-control="focus-title"
              class="focus-title-input"
              rows="1"
              aria-label="Object title"
              @input="changedAndGrow"
            />

            <div v-if="node.kind === 'issue'" class="focus-primary-properties">
              <label>
                <span>Status</span>
                <GraphSelect
                  :model-value="draft.status"
                  data-inspector-status
                  data-graph-control="focus-status"
                  variant="property"
                  aria-label="Issue status"
                  :options="statuses"
                  @update:model-value="updateDraft('status', $event)"
                />
              </label>
              <label>
                <span>Priority</span>
                <GraphSelect
                  :model-value="draft.priority"
                  data-inspector-priority
                  data-graph-control="focus-priority"
                  variant="property"
                  aria-label="Issue priority"
                  :options="priorities"
                  @update:model-value="updateDraft('priority', $event)"
                />
              </label>
              <label>
                <span>Project</span>
                <GraphSelect
                  :model-value="draft.projectId"
                  data-inspector-project
                  data-graph-control="focus-project"
                  variant="property"
                  aria-label="Issue project"
                  placeholder="No project"
                  :options="projectOptions"
                  :menu-min-width="280"
                  searchable
                  search-placeholder="Find a project"
                  @update:model-value="updateDraft('projectId', $event)"
                />
              </label>
              <label>
                <span>Owner</span>
                <GraphSelect
                  :model-value="draft.assigneeId"
                  data-inspector-assignee
                  data-graph-control="focus-assignee"
                  variant="property"
                  aria-label="Issue assignee"
                  placeholder="Unassigned"
                  :options="personOptions"
                  :menu-min-width="280"
                  searchable
                  search-placeholder="Find a person"
                  @update:model-value="updateDraft('assigneeId', $event)"
                />
              </label>
            </div>

            <label v-else class="focus-summary-field">
              <span>Retrieval summary</span>
              <textarea
                ref="summaryInput"
                v-model="draft.summary"
                data-inspector-summary
                data-graph-control="focus-summary"
                placeholder="A concise retrieval hint for people and agents"
                @input="changedAndGrow"
              />
            </label>
          </header>

          <section class="focus-relationship">
            <span class="focus-section-kicker">Relational context</span>
            <GraphRelationshipLine
              :node="node"
              :neighbors="neighbors"
              :limit="8"
              @open="openRelated"
            />
          </section>

          <section class="focus-connections-section">
            <div class="focus-section-heading">
              <div>
                <span class="focus-section-kicker">Connections</span>
                <h2>Place this object in the business graph</h2>
              </div>
              <span>Outgoing relationships</span>
            </div>

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
                  <small>{{ connection.target?.title || connection.edge.target }}</small>
                </span>
                <span>{{ human(connection.target?.kind || 'unresolved') }}</span>
                <button
                  type="button"
                  :data-graph-control="`focus-connection-remove-${connection.index}`"
                  :aria-label="`Remove ${human(connection.edge.relation)} connection to ${connection.target?.title || connection.edge.target}`"
                  @click="removeConnection(connection.index)"
                >
                  <IconX :size="14" />
                </button>
              </div>
            </div>
            <p v-else class="connection-empty">
              No editable outgoing connections yet. Incoming links remain visible in the relationship sentence.
            </p>
          </section>

          <section class="focus-note">
            <div class="focus-section-heading">
              <div>
                <span class="focus-section-kicker">Working note</span>
                <h2>Context, reasoning, and decisions</h2>
              </div>
              <span>{{ draft.body.length.toLocaleString() }} characters</span>
            </div>
            <GraphMarkdownEditor
              v-model="draft.body"
              data-inspector-body
              data-graph-control="focus-working-note"
              :disabled="saving"
              :min-height="380"
              control-id="focus-working-note"
              aria-label="Working note in Markdown"
              @change="changed"
              @save="save"
            />
          </section>

          <section class="focus-details-section">
            <div class="focus-section-heading">
              <div>
                <span class="focus-section-kicker">Properties</span>
                <h2>{{ node.kind === 'issue' ? 'Planning and attention' : 'Classification' }}</h2>
              </div>
            </div>

            <div v-if="node.kind === 'issue'" class="focus-property-grid">
              <div class="focus-field">
                <span>Due date</span>
                <GraphDatePicker
                  :model-value="draft.dueDate"
                  data-inspector-due
                  data-graph-control="focus-due"
                  aria-label="Issue due date"
                  placeholder="No due date"
                  @update:model-value="updateDraft('dueDate', $event)"
                />
              </div>
              <div class="focus-field">
                <span>Reminder</span>
                <GraphDateTimeField
                  :model-value="draft.remindAt"
                  data-inspector-reminder
                  data-graph-control="focus-reminder"
                  aria-label="Issue reminder"
                  control-id="focus-reminder"
                  @update:model-value="updateDraft('remindAt', $event)"
                />
              </div>
              <label class="focus-field">
                <span>Waiting for</span>
                <input
                  v-model="draft.waitingFor"
                  data-inspector-waiting
                  data-graph-control="focus-waiting"
                  placeholder="External dependency or response"
                  @input="changed"
                />
              </label>
              <div class="focus-field">
                <span>Snooze until</span>
                <GraphDatePicker
                  :model-value="draft.snoozeUntil"
                  data-inspector-snooze
                  data-graph-control="focus-snooze"
                  aria-label="Snooze until"
                  placeholder="Not snoozed"
                  @update:model-value="updateDraft('snoozeUntil', $event)"
                />
              </div>
            </div>

            <div class="focus-property-grid focus-classification-grid">
              <label class="focus-field">
                <span>Tags</span>
                <input
                  v-model="draft.tags"
                  data-inspector-tags
                  data-graph-control="focus-tags"
                  placeholder="heor, evidence, client"
                  @input="changed"
                />
                <small>Comma separated</small>
              </label>
              <label v-if="node.kind === 'issue'" class="focus-field">
                <span>Labels</span>
                <input
                  v-model="draft.labels"
                  data-inspector-labels
                  data-graph-control="focus-labels"
                  placeholder="strategy, extraction, review"
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
                placeholder="outputs/evidence-map.xlsx | Evidence map"
                @input="changedAndGrow"
              />
            </label>
          </section>

          <section
            v-if="neighbors.length || activities.length || deliverableItems.length"
            class="focus-connected-section"
          >
            <div class="focus-section-heading">
              <div>
                <span class="focus-section-kicker">Connected work</span>
                <h2>Objects, Activities, and outputs</h2>
              </div>
            </div>
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
                    <strong>{{ neighbor.node.title || neighbor.node.id }}</strong>
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
            </div>
          </section>

          <section class="focus-source-section">
            <div>
              <span class="focus-section-kicker">Source of truth</span>
              <h2>Markdown provenance</h2>
              <p>{{ node.provenance?.sourcePath }}</p>
            </div>
            <dl>
              <div>
                <dt>Scope</dt>
                <dd>{{ node.provenance?.scopeId }}</dd>
              </div>
              <div>
                <dt>Updated</dt>
                <dd>{{ readableDateTime(node.updatedAt) || 'Unknown' }}</dd>
              </div>
              <div>
                <dt>Revision</dt>
                <dd>{{ shortRevision }}</dd>
              </div>
            </dl>
          </section>
        </article>
      </main>

      <footer class="focus-footer">
        <button
          type="button"
          data-inspector-delete
          data-graph-control="focus-delete"
          class="focus-danger-action"
          title="Move to Trash"
          aria-label="Move to Trash"
          @click="remove"
        >
          <IconTrash :size="15" />
        </button>
        <button
          type="button"
          data-inspector-start-work
          data-graph-control="focus-start-work"
          class="object-secondary-action"
          @click="startWork"
        >
          <IconSparkles :size="14" />
          Start work
        </button>
        <button
          v-if="node.kind === 'issue'"
          type="button"
          data-inspector-next-action
          data-graph-control="focus-next-action"
          class="object-secondary-action"
          @click="quickCreate('issue')"
        >
          <IconArrowForwardUp :size="14" />
          Next action
        </button>
        <button
          v-else-if="node.kind === 'project'"
          type="button"
          data-inspector-record-decision
          data-graph-control="focus-record-decision"
          class="object-secondary-action"
          @click="quickCreate('decision')"
        >
          <IconScale :size="14" />
          Record decision
        </button>
        <span class="focus-footer-state" :class="saveStateClass">{{ saveStateLabel }}</span>
        <button
          type="button"
          data-inspector-save
          data-graph-control="focus-save"
          class="object-primary-action focus-save-button"
          :disabled="!dirty || saving || !draft.title.trim()"
          @click="save"
        >
          {{ saving ? 'Saving…' : 'Save changes' }}
          <kbd>⌘S</kbd>
        </button>
      </footer>
    </template>
  </aside>
</template>

<script setup>
import {
  computed,
  nextTick,
  onMounted,
  onUnmounted,
  reactive,
  ref,
  watch,
} from 'vue'
import {
  IconAlertTriangle,
  IconArrowForwardUp,
  IconArrowLeft,
  IconArrowUpRight,
  IconChevronRight,
  IconDots,
  IconFileCode,
  IconLink,
  IconMaximize,
  IconPlus,
  IconScale,
  IconSparkles,
  IconTrash,
  IconX,
} from '@tabler/icons-vue'
import GraphMarkdownEditor from './GraphMarkdownEditor.vue'
import GraphMarkdownPreview from './GraphMarkdownPreview.vue'
import GraphRelationshipLine from './GraphRelationshipLine.vue'
import GraphSelect from './GraphSelect.vue'
import GraphDatePicker from './GraphDatePicker.vue'
import GraphDateTimeField from './GraphDateTimeField.vue'

const props = defineProps({
  mode: {
    type: String,
    default: 'peek',
    validator: value => ['peek', 'focus'].includes(value),
  },
  node: { type: Object, default: null },
  neighbors: { type: Array, default: () => [] },
  scopes: { type: Array, default: () => [] },
  nodes: { type: Array, default: () => [] },
  conflict: { type: Object, default: null },
  error: { type: String, default: '' },
  saving: { type: Boolean, default: false },
  activities: { type: Array, default: () => [] },
})

const emit = defineEmits([
  'back',
  'close',
  'focus',
  'save',
  'openNode',
  'openFile',
  'openActivity',
  'quickCreate',
  'delete',
  'startWork',
])
const titleInput = ref(null)
const inspectorRoot = ref(null)
const summaryInput = ref(null)
const deliverablesInput = ref(null)
const dirty = ref(false)
const saved = ref(false)
const moreOpen = ref(false)
const connectionRelation = ref('')
const connectionTarget = ref('')
let autosaveTimer = null
let savedTimer = null
let editVersion = 0
let currentNodeId = ''
let pendingAction = null

const draft = reactive({
  title: '',
  summary: '',
  body: '',
  tags: '',
  status: 'backlog',
  priority: 'normal',
  dueDate: '',
  remindAt: '',
  projectId: '',
  assigneeId: '',
  waitingFor: '',
  snoozeUntil: '',
  labels: '',
  deliverables: '',
  relations: [],
})

const statuses = Object.freeze([
  { id: 'backlog', label: 'Backlog' },
  { id: 'plan', label: 'Plan' },
  { id: 'in-progress', label: 'In progress' },
  { id: 'waiting', label: 'Waiting' },
  { id: 'review', label: 'Review' },
  { id: 'done', label: 'Done' },
  { id: 'cancelled', label: 'Cancelled' },
])
const priorities = Object.freeze([
  { id: 'urgent', label: 'Urgent' },
  { id: 'high', label: 'High' },
  { id: 'normal', label: 'Normal' },
  { id: 'low', label: 'Low' },
])
const RELATION_DEFINITIONS = Object.freeze([
  {
    value: 'works_at',
    label: 'Works at',
    hint: 'Connect a person to a company',
    from: ['person'],
    to: ['company'],
  },
  {
    value: 'for_company',
    label: 'For company',
    hint: 'Connect a project to its client',
    from: ['project'],
    to: ['company'],
  },
  {
    value: 'has_contact',
    label: 'Has contact',
    hint: 'Connect a project to a key person',
    from: ['project'],
    to: ['person'],
  },
  {
    value: 'blocked_by',
    label: 'Blocked by',
    hint: 'Connect an issue to blocking work',
    from: ['issue'],
    to: ['issue'],
  },
  {
    value: 'depends_on',
    label: 'Depends on',
    hint: 'A work or project dependency',
    from: ['issue', 'project'],
    to: ['issue', 'project'],
  },
  {
    value: 'introduced_by',
    label: 'Introduced by',
    hint: 'Record who introduced this relationship',
    from: ['person', 'project'],
    to: ['person'],
  },
  {
    value: 'references',
    label: 'References',
    hint: 'Cite another graph object',
    from: ['any'],
    to: ['any'],
  },
  {
    value: 'related_to',
    label: 'Related to',
    hint: 'A general business connection',
    from: ['any'],
    to: ['any'],
  },
])
const scopeLabel = computed(() => (
  props.scopes.find(scope => scope.id === props.node?.provenance?.scopeId)?.kind || 'source'
))
const shortRevision = computed(() => (
  String(props.node?.provenance?.sourceRevision || '').slice(0, 12) || 'unknown'
))
const projects = computed(() => props.nodes.filter(node => node.kind === 'project'))
const people = computed(() => props.nodes.filter(node => node.kind === 'person'))
const projectOptions = computed(() => [
  { value: '', label: 'No project', hint: 'Remove project relation' },
  ...projects.value.map(project => ({
    value: project.id,
    label: project.title || project.id,
    hint: `${project.provenance?.scopeKind || project.scopeId || 'project'} · ${project.id}`,
  })),
])
const personOptions = computed(() => [
  { value: '', label: 'Unassigned', hint: 'Remove assignee relation' },
  ...people.value.map(person => ({
    value: person.id,
    label: person.title || person.id,
    hint: `${person.provenance?.scopeKind || person.scopeId || 'person'} · ${person.id}`,
  })),
])
const relationOptions = computed(() => (
  RELATION_DEFINITIONS
    .filter(definition => (
      definition.from.includes('any') || definition.from.includes(props.node?.kind)
    ))
    .map(definition => ({
      value: definition.value,
      label: definition.label,
      hint: definition.hint,
    }))
))
const activeRelationDefinition = computed(() => (
  RELATION_DEFINITIONS.find(definition => definition.value === connectionRelation.value)
))
const connectionTargetOptions = computed(() => {
  const targetKinds = activeRelationDefinition.value?.to || ['any']
  return props.nodes
    .filter(candidate => (
      candidate.id !== props.node?.id
      && (targetKinds.includes('any') || targetKinds.includes(candidate.kind))
      && !draft.relations.some(edge => (
        edge.relation === connectionRelation.value && edge.target === candidate.id
      ))
    ))
    .map(candidate => ({
      value: candidate.id,
      label: candidate.title || candidate.id,
      hint: `${human(candidate.kind)} · ${scopeFor(candidate)}`,
    }))
})
const connectionRows = computed(() => (
  draft.relations
    .map((edge, index) => ({
      edge,
      index,
      target: props.nodes.find(candidate => candidate.id === edge.target),
    }))
    .filter(connection => !(
      props.node?.kind === 'issue'
      && ['part_of', 'assigned_to'].includes(connection.edge.relation)
    ))
))
const canAddConnection = computed(() => (
  Boolean(connectionRelation.value && connectionTarget.value)
  && !draft.relations.some(edge => (
    edge.relation === connectionRelation.value && edge.target === connectionTarget.value
  ))
))
const projectTitle = computed(() => (
  projects.value.find(project => project.id === draft.projectId)?.title
  || draft.projectId
))
const assigneeTitle = computed(() => (
  people.value.find(person => person.id === draft.assigneeId)?.title
  || draft.assigneeId
))
const deliverableItems = computed(() => (
  (props.node?.properties?.deliverables || [])
    .map(item => (
      typeof item === 'string'
        ? { path: item, label: '' }
        : { path: item?.path || '', label: item?.label || '' }
    ))
    .filter(item => item.path)
))
const attentionLabel = computed(() => {
  if (draft.waitingFor) return `Waiting for ${draft.waitingFor}`
  if (draft.snoozeUntil) return `Snoozed until ${readableDate(draft.snoozeUntil)}`
  if (isOverdue(draft.dueDate)) return 'Overdue'
  return 'Clear'
})
const saveStateLabel = computed(() => {
  if (props.conflict) return 'Conflict'
  if (props.saving) return 'Saving'
  if (dirty.value) return 'Unsaved changes'
  if (saved.value) return 'Saved'
  return 'Up to date'
})
const saveStateClass = computed(() => ({
  'save-state-conflict': Boolean(props.conflict),
  'save-state-dirty': dirty.value && !props.conflict,
  'save-state-saved': saved.value && !dirty.value && !props.conflict,
}))

watch(
  () => props.node,
  (node) => {
    if (!node) return
    if (node.id !== currentNodeId || !dirty.value) resetDraft(node)
  },
  { immediate: true },
)

watch(() => props.mode, async mode => {
  moreOpen.value = false
  if (mode !== 'focus') return
  await nextTick()
  growAll()
})

watch(() => props.saving, (saving, wasSaving) => {
  if (saving || !wasSaving || dirty.value || !pendingAction) return
  const action = pendingAction
  pendingAction = null
  action()
})

function resetDraft(node) {
  clearTimeout(autosaveTimer)
  currentNodeId = node.id
  draft.title = node.title || ''
  draft.summary = node.summary || ''
  draft.body = node.body || ''
  draft.tags = (node.tags || []).join(', ')
  draft.status = node.properties?.status || 'backlog'
  draft.priority = node.properties?.priority || 'normal'
  draft.dueDate = node.properties?.dueDate || ''
  draft.remindAt = localDateTime(node.properties?.remindAt)
  draft.projectId = relationTarget(node, 'part_of') || node.properties?.legacyProject || ''
  draft.assigneeId = relationTarget(node, 'assigned_to') || node.properties?.legacyAssignee || ''
  draft.waitingFor = node.properties?.waitingFor || ''
  draft.snoozeUntil = node.properties?.snoozeUntil || ''
  draft.labels = (node.properties?.labels || [])
    .map(label => typeof label === 'string' ? label : label.name)
    .filter(Boolean)
    .join(', ')
  draft.deliverables = (node.properties?.deliverables || [])
    .map(item => (
      typeof item === 'string'
        ? item
        : `${item.path}${item.label ? ` | ${item.label}` : ''}`
    ))
    .join('\n')
  draft.relations = (node.relations || []).map(edge => ({ ...edge }))
  connectionRelation.value = defaultRelationFor(node.kind)
  connectionTarget.value = ''
  dirty.value = false
  saved.value = false
  editVersion = 0
  pendingAction = null
  void nextTick(growAll)
}

function save(afterSave = null) {
  if (typeof afterSave !== 'function') afterSave = null
  clearTimeout(autosaveTimer)
  if (!dirty.value || props.saving || !draft.title.trim()) return
  const version = editVersion
  const setProperties = {}
  const removeProperties = []
  if (props.node.kind === 'issue') {
    setProperties.status = draft.status
    setProperties.priority = draft.priority
    for (const [key, value] of [
      ['dueDate', draft.dueDate],
      ['remindAt', utcDateTime(draft.remindAt)],
      ['waitingFor', draft.waitingFor.trim()],
      ['snoozeUntil', draft.snoozeUntil],
      ['legacyProject', draft.projectId.trim()],
      ['legacyAssignee', draft.assigneeId.trim()],
    ]) {
      if (value) setProperties[key] = value
      else removeProperties.push(key)
    }
    const labels = splitValues(draft.labels)
    setProperties.labels = labels.map(name => ({ name, color: labelColor(name) }))
    setProperties.deliverables = draft.deliverables
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        const [path, ...label] = line.split('|').map(value => value.trim())
        return { path, ...(label.join(' | ') ? { label: label.join(' | ') } : {}) }
      })
  }
  const relations = props.node.kind === 'issue'
    ? [
        ...draft.relations.filter(edge => !['part_of', 'assigned_to'].includes(edge.relation)),
        ...(draft.projectId.trim()
          ? [{ relation: 'part_of', target: draft.projectId.trim(), legacy: false }]
          : []),
        ...(draft.assigneeId.trim()
          ? [{ relation: 'assigned_to', target: draft.assigneeId.trim(), legacy: false }]
          : []),
      ]
    : draft.relations.map(edge => ({ ...edge }))
  emit('save', {
    id: props.node.id,
    expectedRevision: props.node.provenance?.sourceRevision,
    title: draft.title.trim(),
    summary: props.node.kind === 'issue' ? undefined : draft.summary.trim(),
    body: draft.body,
    tags: splitValues(draft.tags),
    relations,
    setProperties,
    removeProperties,
  }, {
    done() {
      if (editVersion === version) {
        dirty.value = false
        saved.value = true
        clearTimeout(savedTimer)
        savedTimer = setTimeout(() => { saved.value = false }, 1600)
        const action = pendingAction
        pendingAction = null
        afterSave?.()
        action?.()
      } else {
        scheduleSave()
      }
    },
  })
}

function requestExit(eventName) {
  moreOpen.value = false
  commitThen(() => emit(eventName))
}

function requestClose() {
  requestExit('close')
}

function requestBack() {
  requestExit('back')
}

function openRelated(id) {
  commitThen(() => emit('openNode', id))
}

function openSource(path) {
  if (!path) return
  commitThen(() => emit('openFile', path))
}

function openActivity(id) {
  commitThen(() => emit('openActivity', id))
}

function quickCreate(kind) {
  commitThen(() => emit('quickCreate', { kind, parent: props.node }))
}

function startWork() {
  commitThen(() => emit('startWork', props.node))
}

function commitThen(action) {
  if (!dirty.value && !props.saving) {
    action()
    return
  }
  pendingAction = action
  if (!props.saving) save()
}

function changed() {
  editVersion += 1
  dirty.value = true
  saved.value = false
  scheduleSave()
}

function changedAndGrow(event) {
  changed()
  grow(event.target)
}

function updateDraft(field, value) {
  draft[field] = value
  changed()
}

function selectConnectionRelation(value) {
  connectionRelation.value = value
  connectionTarget.value = ''
}

function addConnection() {
  if (!canAddConnection.value) return
  draft.relations.push({
    relation: connectionRelation.value,
    target: connectionTarget.value,
    legacy: false,
  })
  connectionTarget.value = ''
  changed()
}

function removeConnection(index) {
  if (index < 0 || index >= draft.relations.length) return
  draft.relations.splice(index, 1)
  changed()
}

function quickUpdate(field, value) {
  draft[field] = value
  changed()
  clearTimeout(autosaveTimer)
  autosaveTimer = setTimeout(save, 0)
}

function scheduleSave() {
  clearTimeout(autosaveTimer)
  autosaveTimer = setTimeout(save, 900)
}

function growAll() {
  for (const input of [titleInput.value, summaryInput.value, deliverablesInput.value]) grow(input)
}

function grow(input) {
  if (!input) return
  input.style.height = '0px'
  input.style.height = `${Math.max(input.scrollHeight, input === titleInput.value ? 48 : 88)}px`
}

function relationTarget(node, relation) {
  return node.relations?.find(edge => edge.relation === relation)?.target || ''
}

function defaultRelationFor(kind) {
  if (kind === 'person') return 'works_at'
  if (kind === 'project') return 'for_company'
  if (kind === 'issue') return 'blocked_by'
  return 'related_to'
}

function scopeFor(node) {
  const scopeId = node.provenance?.scopeId || node.scopeId
  const scope = props.scopes.find(candidate => candidate.id === scopeId)
  return scope?.kind || scopeId || 'visible'
}

function labelColor(name) {
  const colors = ['gray', 'green', 'yellow', 'blue', 'purple', 'red', 'orange']
  let hash = 0
  for (const character of name.toLowerCase()) {
    hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0
  }
  return colors[Math.abs(hash) % colors.length]
}

function splitValues(value) {
  return String(value || '').split(',').map(item => item.trim()).filter(Boolean)
}

function remove() {
  commitThen(() => {
    emit('delete', {
      id: props.node.id,
      expectedRevision: props.node.provenance?.sourceRevision,
      title: props.node.title,
    })
  })
}

function moreAction(action) {
  moreOpen.value = false
  action()
}

function onKeydown(event) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
    event.preventDefault()
    save()
    return
  }
  if (event.key === 'Escape' && moreOpen.value) {
    event.preventDefault()
    event.stopPropagation()
    moreOpen.value = false
  }
}

function onDocumentPointerDown(event) {
  if (
    moreOpen.value
    && !inspectorRoot.value?.querySelector('[data-peek-more-root]')?.contains(event.target)
  ) {
    moreOpen.value = false
  }
}

defineExpose({ requestClose, requestBack, commitThen })

function localDateTime(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value.slice(0, 16)
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

function utcDateTime(value) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toISOString()
}

function readableDate(value) {
  if (!value) return ''
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00`)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' }).format(date)
}

function readableDateTime(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function isOverdue(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || '')
    && value < new Date().toISOString().slice(0, 10)
}

function activityStatusClass(status) {
  if (['working', 'starting', 'ready'].includes(status)) return 'activity-active'
  if (status === 'needs-input') return 'activity-attention'
  if (['done', 'idle'].includes(status)) return 'activity-done'
  return ''
}

function fileName(path) {
  return String(path || '').split(/[\\/]/).pop() || path
}

function fileExtension(path) {
  const name = fileName(path)
  const extension = name.includes('.') ? name.split('.').pop() : 'file'
  return String(extension || 'file').slice(0, 4).toUpperCase()
}

function human(value) {
  return String(value || '').replaceAll('_', ' ').replaceAll('-', ' ')
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown)
})

onUnmounted(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown)
  clearTimeout(autosaveTimer)
  clearTimeout(savedTimer)
})
</script>

<style scoped>
.graph-object {
  min-height: 0;
  background: var(--color-surface);
  color: var(--color-ink);
}

.graph-object-peek {
  position: relative;
  display: flex;
  width: min(410px, 92cqw);
  flex: 0 0 auto;
  flex-direction: column;
}

.graph-object-focus {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  flex-direction: column;
  background: var(--color-chrome-high);
}

.peek-header,
.focus-header {
  display: flex;
  min-height: 48px;
  flex: 0 0 auto;
  align-items: center;
  gap: 9px;
  border-bottom: 1px solid var(--color-rule-light);
  background: var(--color-surface);
  padding: 7px 9px 7px 13px;
}

.peek-identity {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  flex-direction: column;
}

.peek-identity > span {
  color: var(--color-ink-2);
  font-size: 10px;
  font-weight: 620;
  text-transform: capitalize;
}

.peek-identity small {
  overflow: hidden;
  margin-top: 2px;
  color: var(--color-ink-4);
  font-family: var(--font-mono);
  font-size: 9px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.object-icon-button {
  display: grid;
  width: 32px;
  height: 32px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 5px;
  color: var(--color-ink-4);
}

.object-icon-button:hover {
  background: var(--color-chrome-mid);
  color: var(--color-ink);
}

.object-icon-button:focus-visible,
.object-primary-action:focus-visible,
.object-secondary-action:focus-visible,
.focus-danger-action:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--color-accent) 26%, transparent);
  outline-offset: 1px;
}

.object-conflict {
  display: flex;
  min-height: 46px;
  flex: 0 0 auto;
  align-items: flex-start;
  gap: 9px;
  border-bottom: 1px solid color-mix(in srgb, var(--color-rem) 26%, var(--color-rule));
  background: color-mix(in srgb, var(--color-rem) 5%, var(--color-surface));
  padding: 9px 13px;
  color: var(--color-rem);
  font-size: 10px;
  line-height: 1.45;
}

.object-conflict svg {
  flex: 0 0 auto;
  margin-top: 1px;
}

.peek-scroll,
.focus-scroll {
  min-height: 0;
  flex: 1 1 auto;
  overflow-y: auto;
}

.peek-hero {
  padding: 22px 20px 18px;
}

.peek-hero h1 {
  color: var(--color-ink);
  font-size: 19px;
  font-weight: 670;
  letter-spacing: -0.025em;
  line-height: 1.25;
}

.peek-summary {
  margin-top: 8px;
  color: var(--color-ink-3);
  font-size: 11px;
  line-height: 1.55;
}

.peek-quick-properties {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-top: 17px;
}

.peek-quick-properties label {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 3px;
  border-radius: 6px;
  background: var(--color-chrome-high);
  padding: 2px 3px 2px 9px;
}

.peek-quick-properties label > span {
  color: var(--color-ink-4);
  font-size: 9px;
  font-weight: 620;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.peek-quick-properties :deep(.graph-select-trigger) {
  flex: 1 1 auto;
}

.peek-section {
  border-top: 1px solid var(--color-rule-light);
  padding: 17px 20px;
}

.relationship-section {
  background: var(--color-chrome-high);
}

.object-section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}

.object-section-label {
  display: block;
  margin-bottom: 10px;
  color: var(--color-ink-4);
  font-size: 9px;
  font-weight: 680;
  letter-spacing: 0.07em;
  text-transform: uppercase;
}

.object-section-heading .object-section-label {
  margin-bottom: 0;
}

.object-section-heading > button {
  min-height: 27px;
  border-radius: 4px;
  padding: 0 7px;
  color: var(--color-accent);
  font-size: 9px;
  font-weight: 620;
}

.object-section-heading > button:hover {
  background: var(--color-accent-soft);
}

.object-section-count {
  color: var(--color-ink-4);
  font-family: var(--font-mono);
  font-size: 9px;
}

.peek-facts {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 13px 16px;
}

.peek-facts dt {
  color: var(--color-ink-4);
  font-size: 9px;
  font-weight: 620;
  text-transform: uppercase;
}

.peek-facts dd {
  overflow: hidden;
  margin-top: 4px;
  color: var(--color-ink-2);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.peek-facts dd.attention {
  color: var(--color-rem);
}

.object-link-row {
  display: grid;
  width: 100%;
  min-height: 45px;
  grid-template-columns: 26px minmax(0, 1fr) 16px;
  align-items: center;
  gap: 9px;
  border-radius: 5px;
  padding: 5px 7px;
  text-align: left;
}

.object-link-row:hover {
  background: var(--color-chrome-mid);
}

.object-link-row:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--color-accent) 24%, transparent);
  outline-offset: 1px;
}

.object-link-row > span:nth-child(2) {
  min-width: 0;
}

.object-link-row strong,
.object-link-row small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.object-link-row strong {
  color: var(--color-ink-2);
  font-size: 10px;
  font-weight: 610;
}

.object-link-row small {
  margin-top: 2px;
  color: var(--color-ink-4);
  font-family: var(--font-mono);
  font-size: 9px;
}

.object-link-row > svg {
  color: var(--color-ink-4);
}

.activity-dot {
  width: 7px;
  height: 7px;
  margin-left: 9px;
  border-radius: 50%;
  background: var(--color-ink-4);
}

.activity-active {
  background: var(--color-accent);
}

.activity-attention {
  background: var(--color-rem);
}

.activity-done {
  background: var(--color-add);
}

.file-mark,
.relation-mark {
  display: grid;
  width: 26px;
  height: 26px;
  place-items: center;
  border-radius: 5px;
  background: var(--color-chrome-mid);
  color: var(--color-ink-3);
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 680;
}

.relation-mark {
  color: var(--color-accent);
  font-size: 11px;
}

.peek-provenance {
  border-top: 1px solid var(--color-rule-light);
  padding: 12px 20px 19px;
}

.peek-provenance summary {
  display: flex;
  min-height: 28px;
  align-items: center;
  justify-content: space-between;
  cursor: pointer;
  list-style: none;
  color: var(--color-ink-4);
  font-size: 9px;
  font-weight: 620;
}

.peek-provenance summary::-webkit-details-marker {
  display: none;
}

.peek-provenance summary::after {
  display: grid;
  width: 22px;
  height: 22px;
  place-items: center;
  border-radius: 4px;
  color: var(--color-ink-4);
  content: "+";
  font-family: var(--font-mono);
  font-size: 12px;
}

.peek-provenance[open] summary::after {
  content: "−";
}

.peek-provenance summary:hover::after {
  background: var(--color-chrome-mid);
  color: var(--color-ink);
}

.peek-provenance summary:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--color-accent) 25%, transparent);
  outline-offset: 2px;
}

.peek-provenance dl {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr);
  gap: 6px 10px;
  padding-top: 6px;
  font-family: var(--font-mono);
  font-size: 9px;
  line-height: 1.4;
}

.peek-provenance dt {
  color: var(--color-ink-4);
}

.peek-provenance dd {
  overflow-wrap: anywhere;
  color: var(--color-ink-3);
}

.peek-footer,
.focus-footer {
  display: flex;
  min-height: 53px;
  flex: 0 0 auto;
  align-items: center;
  gap: 7px;
  border-top: 1px solid var(--color-rule);
  background: var(--color-surface);
  padding: 8px 10px;
}

.object-primary-action,
.object-secondary-action,
.focus-danger-action {
  display: inline-flex;
  min-height: 34px;
  align-items: center;
  justify-content: center;
  gap: 7px;
  border-radius: 5px;
  padding: 0 10px;
  font-size: 10px;
  font-weight: 650;
}

.object-primary-action {
  background: var(--color-accent);
  color: var(--color-accent-ink, white);
}

.object-primary-action:hover {
  background: color-mix(in srgb, var(--color-accent) 88%, var(--color-ink));
}

.object-secondary-action {
  border: 1px solid var(--color-rule-light);
  background: var(--color-surface);
  color: var(--color-ink-2);
}

.object-secondary-action:hover {
  background: var(--color-chrome-mid);
  color: var(--color-ink);
}

.object-primary-action kbd,
.focus-save-button kbd {
  margin-left: 2px;
  font-family: var(--font-mono);
  font-size: 9px;
  opacity: 0.65;
}

.peek-more-wrap {
  position: relative;
  margin-left: auto;
}

.peek-more-menu {
  position: absolute;
  z-index: 90;
  right: 0;
  bottom: 40px;
  width: 210px;
  border: 1px solid var(--color-rule);
  border-radius: 3px;
  background: var(--color-surface);
  padding: 5px;
  box-shadow: 0 10px 30px color-mix(in srgb, var(--color-ink) 15%, transparent);
}

.peek-more-menu button {
  display: flex;
  width: 100%;
  min-height: 38px;
  align-items: center;
  gap: 9px;
  border-radius: 4px;
  padding: 0 9px;
  color: var(--color-ink-2);
  font-size: 11px;
  text-align: left;
}

.peek-more-menu button:hover {
  background: var(--color-chrome-mid);
}

.peek-more-menu button.danger {
  color: var(--color-rem);
}

.focus-header {
  min-height: 50px;
  padding-inline: 14px;
}

.focus-header-identity {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 7px;
  color: var(--color-ink-2);
  font-size: 10px;
  font-weight: 620;
  text-transform: capitalize;
}

.focus-header-identity small {
  color: var(--color-ink-4);
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 400;
}

.focus-save-state {
  margin-left: auto;
  color: var(--color-ink-4);
  font-size: 9px;
  font-weight: 600;
}

.save-state-conflict {
  color: var(--color-rem) !important;
}

.save-state-dirty {
  color: var(--color-accent) !important;
}

.save-state-saved {
  color: var(--color-add) !important;
}

.focus-document {
  width: min(1080px, 100%);
  margin: 0 auto;
  padding: 36px clamp(22px, 4cqw, 56px) 100px;
}

.focus-hero {
  border-bottom: 1px solid var(--color-rule-light);
  padding-bottom: 29px;
}

.focus-object-id {
  color: var(--color-ink-4);
  font-family: var(--font-mono);
  font-size: 9px;
}

.focus-title-input {
  display: block;
  width: 100%;
  min-height: 48px;
  overflow: hidden;
  resize: none;
  border: 0;
  background: transparent;
  padding: 9px 0 5px;
  color: var(--color-ink);
  font-size: clamp(24px, 3.1cqw, 34px);
  font-weight: 690;
  letter-spacing: -0.035em;
  line-height: 1.18;
}

.focus-title-input:focus-visible {
  outline: none;
}

.focus-title-input::selection {
  background: var(--selection);
}

.focus-primary-properties {
  display: grid;
  grid-template-columns: repeat(4, minmax(120px, 1fr));
  gap: 8px;
  margin-top: 18px;
}

.focus-primary-properties label > span,
.focus-summary-field > span,
.focus-field > span,
.focus-deliverables-field > span {
  display: block;
  margin: 0 0 5px 2px;
  color: var(--color-ink-4);
  font-size: 10px;
  font-weight: 670;
  letter-spacing: 0.055em;
  text-transform: uppercase;
}

.focus-summary-field {
  display: block;
  margin-top: 18px;
}

.focus-summary-field textarea {
  width: 100%;
  min-height: 88px;
  overflow: hidden;
  resize: none;
  border: 0;
  border-radius: 6px;
  background: var(--color-surface);
  padding: 12px 14px;
  color: var(--color-ink-2);
  font-size: 13px;
  line-height: 1.55;
}

.focus-summary-field textarea:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--color-accent) 25%, transparent);
  outline-offset: 1px;
}

.focus-relationship,
.focus-connections-section,
.focus-note,
.focus-details-section,
.focus-connected-section,
.focus-source-section {
  margin-top: 34px;
}

.focus-relationship {
  border-block: 1px solid var(--color-rule-light);
  background: var(--color-surface);
  padding: 15px 2px;
}

.focus-connections-section {
  border-bottom: 1px solid var(--color-rule-light);
  padding-bottom: 28px;
}

.connection-composer {
  display: grid;
  grid-template-columns: minmax(150px, 0.72fr) minmax(220px, 1.55fr) auto;
  gap: 8px;
  align-items: stretch;
}

.connection-add {
  display: inline-flex;
  min-width: 76px;
  min-height: 37px;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border-radius: 6px;
  background: var(--color-accent);
  padding: 0 11px;
  color: var(--color-accent-ink, white);
  font-size: 10px;
  font-weight: 650;
}

.connection-add:hover {
  background: color-mix(in srgb, var(--color-accent) 88%, var(--color-ink));
}

.connection-add:disabled {
  cursor: default;
  opacity: 0.42;
  filter: none;
}

.connection-add:focus-visible,
.connection-row > button:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--color-accent) 25%, transparent);
  outline-offset: 1px;
}

.connection-list {
  margin-top: 10px;
  border: 1px solid var(--color-rule-light);
  border-radius: 2px;
  background: var(--color-surface);
}

.connection-row {
  display: grid;
  min-height: 44px;
  grid-template-columns: 18px minmax(0, 1fr) auto 32px;
  align-items: center;
  gap: 9px;
  padding: 5px 6px 5px 11px;
}

.connection-row + .connection-row {
  border-top: 1px solid var(--color-rule-light);
}

.connection-row > svg {
  color: var(--color-accent);
}

.connection-row > span:nth-of-type(1) {
  min-width: 0;
}

.connection-row strong,
.connection-row small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.connection-row strong {
  color: var(--color-ink-2);
  font-size: 10px;
  font-weight: 630;
  text-transform: capitalize;
}

.connection-row small {
  margin-top: 2px;
  color: var(--color-ink-4);
  font-size: 9px;
}

.connection-row > span:nth-of-type(2) {
  padding: 0;
  color: var(--color-ink-3);
  font-family: var(--font-mono);
  font-size: 9px;
  text-transform: capitalize;
}

.connection-row > button {
  display: grid;
  width: 32px;
  height: 32px;
  place-items: center;
  border-radius: 5px;
  color: var(--color-ink-4);
}

.connection-row > button:hover {
  background: color-mix(in srgb, var(--color-rem) 8%, transparent);
  color: var(--color-rem);
}

.connection-empty {
  margin-top: 10px;
  border: 1px dashed var(--color-rule);
  border-radius: 2px;
  padding: 11px 12px;
  color: var(--color-ink-4);
  font-size: 10px;
  line-height: 1.45;
}

.focus-section-kicker {
  display: block;
  margin-bottom: 7px;
  color: var(--color-ink-4);
  font-size: 9px;
  font-weight: 680;
  letter-spacing: 0.07em;
  text-transform: uppercase;
}

.focus-section-heading {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 18px;
  margin-bottom: 14px;
}

.focus-section-heading h2,
.focus-source-section h2 {
  color: var(--color-ink);
  font-size: 15px;
  font-weight: 660;
  letter-spacing: -0.015em;
}

.focus-section-heading > span {
  color: var(--color-ink-4);
  font-family: var(--font-mono);
  font-size: 9px;
}

.focus-property-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.focus-classification-grid {
  margin-top: 14px;
}

.focus-field input,
.focus-deliverables-field textarea {
  width: 100%;
  border: 1px solid var(--color-rule-light);
  border-radius: 6px;
  background: var(--color-surface);
  color: var(--color-ink-2);
  font-size: 12px;
}

.focus-field input {
  height: 37px;
  padding: 0 10px;
}

.focus-field input:focus-visible,
.focus-deliverables-field textarea:focus-visible {
  border-color: var(--color-accent);
  outline: 2px solid color-mix(in srgb, var(--color-accent) 21%, transparent);
  outline-offset: 1px;
}

.focus-field small {
  display: block;
  margin: 5px 0 0 2px;
  color: var(--color-ink-4);
  font-size: 9px;
}

.focus-deliverables-field {
  display: block;
  margin-top: 18px;
}

.focus-deliverables-field > small {
  display: block;
  margin: -2px 0 7px 2px;
  color: var(--color-ink-4);
  font-size: 9px;
}

.focus-deliverables-field textarea {
  min-height: 104px;
  overflow: hidden;
  resize: none;
  padding: 12px;
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 1.55;
}

.focus-connected-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 20px;
}

.focus-connected-grid h3 {
  margin-bottom: 7px;
  color: var(--color-ink-3);
  font-size: 10px;
  font-weight: 650;
}

.focus-source-section {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(260px, 0.75fr);
  gap: 28px;
  border-top: 1px solid var(--color-rule-light);
  padding-top: 25px;
}

.focus-source-section p {
  overflow-wrap: anywhere;
  margin-top: 8px;
  color: var(--color-ink-4);
  font-family: var(--font-mono);
  font-size: 9px;
  line-height: 1.5;
}

.focus-source-section dl {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.focus-source-section dt {
  color: var(--color-ink-4);
  font-size: 9px;
  font-weight: 650;
  text-transform: uppercase;
}

.focus-source-section dd {
  overflow: hidden;
  margin-top: 5px;
  color: var(--color-ink-3);
  font-family: var(--font-mono);
  font-size: 9px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.focus-footer {
  min-height: 57px;
  padding-inline: 14px;
}

.focus-danger-action {
  width: 34px;
  padding: 0;
  color: var(--color-ink-4);
}

.focus-danger-action:hover {
  background: color-mix(in srgb, var(--color-rem) 8%, transparent);
  color: var(--color-rem);
}

.focus-footer-state {
  margin-left: auto;
  color: var(--color-ink-4);
  font-size: 9px;
}

.focus-save-button {
  min-width: 130px;
}

.focus-save-button:disabled {
  cursor: default;
  opacity: 0.42;
  filter: none;
}

@container business-graph (max-width: 840px) {
  .graph-object-peek {
    position: absolute;
    z-index: 70;
    inset: 0 0 0 auto;
    width: min(430px, 100%);
  }

  .focus-primary-properties {
    grid-template-columns: repeat(2, minmax(120px, 1fr));
  }

  .focus-source-section {
    grid-template-columns: 1fr;
  }

  .connection-composer {
    grid-template-columns: 1fr 1.4fr auto;
  }
}

@container business-graph (max-width: 560px) {
  .focus-header .object-secondary-action {
    width: 34px;
    padding: 0;
    font-size: 0;
  }

  .focus-header-identity small,
  .focus-save-state {
    display: none;
  }

  .focus-document {
    padding: 34px 16px 100px;
  }

  .focus-primary-properties,
  .focus-property-grid,
  .connection-composer {
    grid-template-columns: 1fr;
  }

  .connection-add {
    justify-self: start;
  }

  .focus-footer .object-secondary-action {
    width: 34px;
    padding: 0;
    font-size: 0;
  }

  .focus-footer-state {
    display: none;
  }

  .focus-save-button {
    margin-left: auto;
  }
}
</style>
