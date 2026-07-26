<template>
  <Teleport to="body">
    <div
      v-if="open"
      data-graph-create-dialog
      class="fixed inset-0 z-[120] grid place-items-center bg-black/30 p-3"
      @click.self="$emit('close')"
    >
      <form
        class="w-full max-w-[470px] border border-rule bg-surface text-ink shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="graph-create-title"
        @submit.prevent="submit"
        @keydown.esc.prevent="$emit('close')"
      >
        <header class="flex h-10 items-center border-b border-rule-light px-3">
          <IconSquareRoundedPlus :size="14" class="mr-2 text-accent" />
          <h2 id="graph-create-title" class="text-[11px] font-semibold">Add to the business graph</h2>
          <button
            type="button"
            class="ml-auto grid size-7 place-items-center text-ink-4 hover:bg-chrome-mid hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            aria-label="Close"
            @click="$emit('close')"
          >
            <IconX :size="13" />
          </button>
        </header>

        <div class="grid gap-3 p-4">
          <div class="grid grid-cols-2 gap-3">
            <div>
              <span class="create-label">Kind</span>
              <GraphSelect
                v-model="draft.kind"
                data-create-kind
                variant="field"
                aria-label="Graph item kind"
                :options="kinds"
                :menu-min-width="220"
                searchable
                search-placeholder="Find an entity kind"
              />
            </div>
            <div>
              <span class="create-label">Scope</span>
              <GraphSelect
                v-model="draft.scopeId"
                data-create-scope
                variant="field"
                aria-label="Physical graph scope"
                :options="scopeOptions"
                :menu-min-width="240"
              />
            </div>
          </div>

          <label>
            <span class="create-label">Title</span>
            <input
              ref="titleInput"
              v-model="draft.title"
              data-create-title
              class="create-control"
              type="text"
              autocomplete="off"
              placeholder="What should the team recognize this as?"
              required
            />
          </label>

          <div v-if="draft.kind === 'issue'" class="grid grid-cols-2 gap-3">
            <div>
              <span class="create-label">Status</span>
              <GraphSelect
                v-model="draft.status"
                data-create-status
                variant="field"
                aria-label="Initial issue status"
                :options="statuses"
              />
            </div>
            <div>
              <span class="create-label">Priority</span>
              <GraphSelect
                v-model="draft.priority"
                data-create-priority
                variant="field"
                aria-label="Initial issue priority"
                :options="priorities"
              />
            </div>
          </div>

          <label v-else>
            <span class="create-label">Summary <span class="normal-case tracking-normal text-ink-4">optional</span></span>
            <input
              v-model="draft.summary"
              data-create-summary
              class="create-control"
              type="text"
              placeholder="One retrieval hint for people and agents"
            />
          </label>

          <label>
            <span class="create-label">Tags <span class="normal-case tracking-normal text-ink-4">comma separated</span></span>
            <input
              v-model="draft.tags"
              data-create-tags
              class="create-control"
              type="text"
              placeholder="heor, evidence, client"
            />
          </label>

          <label>
            <span class="create-label">Working note <span class="normal-case tracking-normal text-ink-4">Markdown</span></span>
            <textarea
              v-model="draft.body"
              data-create-body
              class="create-control min-h-28 resize-y py-2"
              placeholder="Context, acceptance criteria, rationale, or notes"
            />
          </label>
        </div>

        <footer class="flex h-12 items-center gap-3 border-t border-rule bg-chrome-high px-4">
          <label class="flex items-center gap-2 text-[9px] text-ink-3">
            <input v-model="createAnother" data-create-another type="checkbox" class="accent-[var(--color-accent)]" />
            Create another
          </label>
          <button
            type="button"
            class="ml-auto h-7 px-3 text-[9px] font-semibold text-ink-3 hover:bg-chrome-mid hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            @click="$emit('close')"
          >
            Cancel
          </button>
          <button
            type="submit"
            data-create-submit
            class="h-7 border border-accent bg-accent px-3 text-[9px] font-semibold text-white hover:brightness-95 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-40"
            :disabled="saving || !draft.title.trim() || !draft.scopeId"
          >
            {{ saving ? 'Creating…' : `Create ${human(draft.kind)}` }}
          </button>
        </footer>
      </form>
    </div>
  </Teleport>
</template>

<script setup>
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { IconSquareRoundedPlus, IconX } from '@tabler/icons-vue'
import GraphSelect from './GraphSelect.vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  scopes: { type: Array, default: () => [] },
  initialKind: { type: String, default: 'issue' },
  initialStatus: { type: String, default: 'backlog' },
  saving: { type: Boolean, default: false },
})

const emit = defineEmits(['close', 'create'])
const titleInput = ref(null)
const createAnother = ref(false)
const kinds = [
  { id: 'issue', label: 'Issue' },
  { id: 'project', label: 'Project' },
  { id: 'person', label: 'Person' },
  { id: 'company', label: 'Company' },
  { id: 'note', label: 'Knowledge note' },
  { id: 'decision', label: 'Decision' },
  { id: 'record', label: 'Record' },
  { id: 'research-question', label: 'Research question' },
  { id: 'study', label: 'Study' },
  { id: 'evidence', label: 'Evidence' },
  { id: 'dataset', label: 'Dataset' },
  { id: 'analysis', label: 'Analysis' },
  { id: 'model', label: 'Model' },
  { id: 'endpoint', label: 'Endpoint' },
  { id: 'publication', label: 'Publication' },
  { id: 'submission', label: 'Submission' },
  { id: 'method', label: 'Method' },
  { id: 'client-request', label: 'Client request' },
]
const statuses = ['backlog', 'plan', 'in-progress', 'waiting', 'review', 'done']
const priorities = ['low', 'normal', 'high', 'urgent']
const draft = reactive(emptyDraft())
const scopeOptions = computed(() => props.scopes.map(scope => ({
  value: scope.id,
  label: human(scope.kind),
  hint: scope.root,
})))

watch(() => props.open, async (open) => {
  if (!open) return
  Object.assign(draft, emptyDraft())
  await nextTick()
  titleInput.value?.focus()
})

watch(() => props.initialKind, kind => {
  if (props.open && kinds.some(option => option.id === kind)) draft.kind = kind
})

watch(() => props.initialStatus, status => {
  if (props.open && statuses.includes(status)) draft.status = status
})

watch(() => props.scopes, applyDefaultScope, { immediate: true, deep: true })

function emptyDraft() {
  return {
    kind: props.initialKind || 'issue',
    scopeId: defaultScope(),
    title: '',
    summary: '',
    tags: '',
    body: '',
    status: props.initialStatus || 'backlog',
    priority: 'normal',
  }
}

function applyDefaultScope() {
  if (!props.scopes.some(scope => scope.id === draft.scopeId)) {
    draft.scopeId = defaultScope()
  }
}

function defaultScope() {
  return props.scopes.find(scope => scope.kind === 'project')?.id
    || props.scopes.find(scope => scope.kind === 'private')?.id
    || props.scopes[0]?.id
    || ''
}

function submit() {
  if (!draft.title.trim() || !draft.scopeId || props.saving) return
  const properties = draft.kind === 'issue'
    ? { status: draft.status, priority: draft.priority }
    : {}
  emit('create', {
    kind: draft.kind,
    scopeId: draft.scopeId,
    title: draft.title.trim(),
    summary: draft.summary.trim(),
    body: draft.body,
    tags: draft.tags.split(',').map(tag => tag.trim()).filter(Boolean),
    properties,
  }, {
    another: createAnother.value,
    reset() {
      const { kind, scopeId, status, priority } = draft
      Object.assign(draft, emptyDraft(), { kind, scopeId, status, priority })
      void nextTick(() => titleInput.value?.focus())
    },
  })
}

function human(value) {
  return String(value || '').replaceAll('-', ' ')
}
</script>

<style scoped>
.create-label {
  display: block;
  margin-bottom: 4px;
  font-family: var(--font-mono);
  font-size: 7px;
  font-weight: 600;
  letter-spacing: 0.11em;
  color: var(--color-ink-4);
  text-transform: uppercase;
}

.create-control {
  width: 100%;
  min-height: 29px;
  border: 1px solid var(--color-rule);
  border-radius: 0;
  background: var(--color-chrome-high);
  padding-inline: 8px;
  font-size: 10px;
  color: var(--color-ink-2);
}

.create-control:focus-visible {
  border-color: var(--color-accent);
  outline: 1px solid var(--color-accent);
  outline-offset: 0;
}

@media (prefers-reduced-motion: reduce) {
  * {
    scroll-behavior: auto !important;
  }
}
</style>
