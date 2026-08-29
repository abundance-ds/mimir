<template>
  <section data-scribe-meeting-context class="meeting-context" aria-label="Meeting context">
    <label>
      <span>Project</span>
      <GraphSelect
        :model-value="projectChoice"
        data-scribe-meeting-project
        variant="quiet"
        aria-label="Meeting project"
        placeholder="Not set"
        :options="projectOptions"
        :disabled="disabled || loading"
        :menu-min-width="280"
        searchable
        search-placeholder="Find a project"
        create-label="Create project"
        @update:model-value="setProject"
        @create="$emit('createEntity', { kind: 'project', title: $event })"
      />
    </label>

    <div class="meeting-context-people">
      <span>People</span>
      <div class="meeting-people-value">
        <button
          v-for="person in selectedPeople"
          :key="person.id"
          type="button"
          data-scribe-meeting-person-value
          :disabled="disabled"
          :aria-label="`Remove ${person.title || person.id}`"
          @click="removePerson(person.id)"
        >
          {{ person.title || person.id }}
          <IconX :size="11" />
        </button>
        <GraphSelect
          :model-value="''"
          data-scribe-meeting-person
          variant="quiet"
          aria-label="Add meeting person"
          placeholder="Add…"
          :options="availablePeopleOptions"
          :disabled="disabled || loading"
          :menu-min-width="280"
          searchable
          search-placeholder="Find a person"
          create-label="Create person"
          @update:model-value="addPerson"
          @create="$emit('createEntity', { kind: 'person', title: $event })"
        />
      </div>
    </div>

    <label>
      <span>Scope</span>
      <GraphSelect
        :model-value="draft.scopeId || ''"
        data-scribe-meeting-scope
        variant="quiet"
        aria-label="Meeting scope"
        placeholder="Not set"
        :options="scopeOptions"
        :disabled="disabled || loading"
        :menu-min-width="200"
        @update:model-value="update({ scopeId: $event || null })"
      />
    </label>

    <p v-if="creating" class="meeting-context-state" role="status">Creating…</p>
    <p v-else-if="error" class="meeting-context-error" role="alert">{{ error }}</p>
  </section>
</template>

<script setup>
import { computed } from 'vue'
import { IconX } from '@tabler/icons-vue'
import GraphSelect from '../business-graph/GraphSelect.vue'

const props = defineProps({
  modelValue: { type: Object, default: () => ({}) },
  projects: { type: Array, default: () => [] },
  people: { type: Array, default: () => [] },
  scopes: { type: Array, default: () => [] },
  workspaceProjectId: { type: String, default: '' },
  disabled: { type: Boolean, default: false },
  loading: { type: Boolean, default: false },
  creating: { type: Boolean, default: false },
  error: { type: String, default: '' },
})

const emit = defineEmits(['update:modelValue', 'change', 'createEntity'])
const draft = computed(() => normalizeDraft(props.modelValue))
const projectChoice = computed(() => {
  if (!draft.value.projectResolved) return '__blank__'
  return draft.value.projectId || '__none__'
})
const projectOptions = computed(() => [
  { value: '__blank__', label: 'Not set', hint: 'Decide later' },
  { value: '__none__', label: 'None', hint: 'No Project', separatorAfter: true },
  ...[...props.projects]
    .sort((left, right) => {
      if (left.id === props.workspaceProjectId) return -1
      if (right.id === props.workspaceProjectId) return 1
      return title(left).localeCompare(title(right))
    })
    .map(project => ({
      value: project.id,
      label: title(project),
      hint: project.id === props.workspaceProjectId ? 'Current workspace' : '',
    })),
])
const scopeOptions = computed(() => props.scopes.map(scope => ({
  value: scope.id,
  label: { team: 'Team', project: 'Workspace', private: 'Private' }[scope.kind]
    || String(scope.kind || ''),
})))
const selectedPeople = computed(() => draft.value.peopleIds.map(id => (
  props.people.find(person => person.id === id) || { id, title: id }
)))
const availablePeopleOptions = computed(() => props.people
  .filter(person => !draft.value.peopleIds.includes(person.id))
  .map(person => ({ value: person.id, label: title(person) }))
  .sort((left, right) => left.label.localeCompare(right.label)))

function setProject(value) {
  if (value === '__blank__') {
    update({ projectResolved: false, projectId: null })
  } else if (value === '__none__') {
    update({ projectResolved: true, projectId: null })
  } else {
    update({ projectResolved: true, projectId: value })
  }
}

function addPerson(id) {
  if (!id || draft.value.peopleIds.includes(id)) return
  update({ peopleIds: [...draft.value.peopleIds, id] })
}

function removePerson(id) {
  update({ peopleIds: draft.value.peopleIds.filter(personId => personId !== id) })
}

function update(patch) {
  const value = normalizeDraft({ ...draft.value, ...patch })
  emit('update:modelValue', value)
  emit('change', value)
}

function normalizeDraft(value = {}) {
  return {
    projectResolved: Boolean(value.projectResolved),
    projectId: value.projectResolved && value.projectId ? String(value.projectId) : null,
    peopleIds: [...new Set((Array.isArray(value.peopleIds) ? value.peopleIds : [])
      .map(String)
      .filter(Boolean))],
    scopeId: value.scopeId ? String(value.scopeId) : null,
  }
}

function title(node) {
  return String(node?.title || node?.id || '')
}
</script>

<style scoped>
.meeting-context {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 4px 12px;
  padding: 4px 0 8px;
}

.meeting-context > label,
.meeting-context-people {
  display: grid;
  min-width: 104px;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 5px;
}

.meeting-context > label > span,
.meeting-context-people > span {
  color: var(--color-ink-4);
  font-size: 9px;
}

.meeting-people-value {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  gap: 3px;
}

.meeting-people-value > button {
  display: inline-flex;
  min-height: 22px;
  align-items: center;
  gap: 4px;
  border-radius: 2px;
  padding: 0 5px;
  color: var(--color-ink-2);
  font-size: 10px;
}

.meeting-people-value > button:hover {
  background: var(--color-chrome-mid);
}

.meeting-context-state,
.meeting-context-error {
  width: 100%;
  font-size: 9px;
}

.meeting-context-state {
  color: var(--color-ink-3);
}

.meeting-context-error {
  color: var(--color-rem);
}

@media (max-width: 560px) {
  .meeting-context {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .meeting-context-people {
    grid-column: 1 / -1;
  }
}
</style>
