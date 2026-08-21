<template>
  <Teleport to="body">
    <div
      v-if="open"
      data-workspace-setup
      class="workspace-setup-overlay"
      @click.self="cancel"
    >
      <form
        ref="dialog"
        class="workspace-setup-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-setup-title"
        @submit.prevent="submit"
        @keydown.esc.prevent.stop="cancel"
        @keydown.tab="trapFocus"
      >
        <header class="workspace-setup-header">
          <div class="min-w-0">
            <h2 id="workspace-setup-title">Set up workspace</h2>
            <p :title="workspacePath">{{ workspaceName }}</p>
          </div>
          <button type="button" aria-label="Cancel workspace setup" @click="cancel">
            <IconX :size="15" />
          </button>
        </header>

        <div v-if="error" class="workspace-setup-error" role="alert">
          <IconAlertTriangle :size="14" />
          <span>{{ error }}</span>
        </div>

        <div class="workspace-setup-fields">
          <label class="workspace-setup-row">
            <span class="workspace-setup-label">
              <strong>Project</strong>
              <small>Business context for agents and new work</small>
            </span>
            <GraphSelect
              v-model="projectChoice"
              data-workspace-project
              variant="field"
              aria-label="Workspace Project"
              :options="projectOptions"
              :menu-min-width="300"
              searchable
              search-placeholder="Find a Project"
            />
          </label>

          <label v-if="projectChoice === NEW_PROJECT" class="workspace-new-project">
            <span>New Project name</span>
            <input
              ref="newProjectInput"
              v-model="newProjectTitle"
              data-workspace-new-project
              type="text"
              autocomplete="off"
              placeholder="Project name"
            />
          </label>

          <div class="workspace-setup-row">
            <span class="workspace-setup-label">
              <strong>Graph scope</strong>
              <small>Where new graph items from this workspace are stored</small>
            </span>
            <div
              class="workspace-scope-options"
              role="radiogroup"
              aria-label="Workspace graph scope"
              @keydown="onScopeKeydown"
            >
              <button
                v-for="option in scopeOptions"
                :key="option.value"
                type="button"
                role="radio"
                :aria-checked="graphScope === option.value"
                :tabindex="graphScope === option.value ? 0 : -1"
                :data-workspace-scope="option.value"
                class="workspace-scope-option"
                :class="{ 'workspace-scope-option-active': graphScope === option.value }"
                @click="graphScope = option.value"
              >
                <span class="workspace-radio" aria-hidden="true">
                  <i v-if="graphScope === option.value" />
                </span>
                {{ option.label }}
              </button>
            </div>
          </div>
        </div>

        <footer class="workspace-setup-footer">
          <code>{{ workspacePath }}</code>
          <button type="button" class="workspace-setup-cancel" @click="cancel">Cancel</button>
          <button
            type="submit"
            data-workspace-setup-continue
            class="workspace-setup-submit"
            :disabled="saving || (projectChoice === NEW_PROJECT && !newProjectTitle.trim())"
          >
            {{ saving ? 'Saving…' : 'Continue' }}
          </button>
        </footer>
      </form>
    </div>
  </Teleport>
</template>

<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { IconAlertTriangle, IconX } from '@tabler/icons-vue'
import GraphSelect from '../apps/business-graph/GraphSelect.vue'

const NEW_PROJECT = '__new_project__'

const props = defineProps({
  open: { type: Boolean, default: false },
  workspacePath: { type: String, default: '' },
  projects: { type: Array, default: () => [] },
  initialConfig: { type: Object, default: null },
  saving: { type: Boolean, default: false },
  error: { type: String, default: '' },
})

const emit = defineEmits(['cancel', 'save'])
const dialog = ref(null)
const newProjectInput = ref(null)
const projectChoice = ref('')
const newProjectTitle = ref('')
const graphScope = ref('team')

const workspaceName = computed(() => basename(props.workspacePath) || 'Workspace')
const projectOptions = computed(() => [
  { value: '', label: 'None' },
  { value: NEW_PROJECT, label: 'New Project…', separatorAfter: props.projects.length > 0 },
  ...[...props.projects].sort(compareProjects).map(project => ({
    value: project.id,
    label: project.title || project.id,
  })),
])
const scopeOptions = Object.freeze([
  { value: 'team', label: 'Team' },
  { value: 'workspace', label: 'Workspace' },
])

watch(() => props.open, async open => {
  if (!open) return
  projectChoice.value = String(props.initialConfig?.project || '')
  graphScope.value = props.initialConfig?.graphScope === 'workspace' ? 'workspace' : 'team'
  newProjectTitle.value = ''
  await nextTick()
  dialog.value?.querySelector('[data-workspace-project]')?.focus()
}, { immediate: true })

watch(projectChoice, async value => {
  if (value !== NEW_PROJECT) return
  await nextTick()
  newProjectInput.value?.focus()
})

function submit() {
  if (props.saving) return
  const newTitle = newProjectTitle.value.trim()
  if (projectChoice.value === NEW_PROJECT && !newTitle) return
  emit('save', {
    project: projectChoice.value === NEW_PROJECT ? '' : projectChoice.value,
    newProjectTitle: projectChoice.value === NEW_PROJECT ? newTitle : '',
    graphScope: graphScope.value,
  })
}

function cancel() {
  if (!props.saving) emit('cancel')
}

function onScopeKeydown(event) {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
  event.preventDefault()
  graphScope.value = ['ArrowLeft', 'ArrowUp'].includes(event.key) ? 'team' : 'workspace'
  nextTick(() => dialog.value
    ?.querySelector(`[data-workspace-scope="${graphScope.value}"]`)
    ?.focus())
}

function trapFocus(event) {
  const focusable = Array.from(dialog.value?.querySelectorAll(
    'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
  ) || []).filter(element => !element.closest('[aria-hidden="true"]'))
  if (!focusable.length) return
  const first = focusable[0]
  const last = focusable.at(-1)
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

function basename(path) {
  return String(path || '').replaceAll('\\', '/').split('/').filter(Boolean).at(-1) || ''
}

function compareProjects(left, right) {
  return String(left.title || left.id).localeCompare(
    String(right.title || right.id),
    undefined,
    { sensitivity: 'base' },
  )
}
</script>

<style scoped>
.workspace-setup-overlay {
  position: fixed;
  inset: 0;
  z-index: 240;
  display: grid;
  place-items: center;
  padding: 12px;
  background: rgb(0 0 0 / 34%);
}

.workspace-setup-dialog {
  width: min(520px, calc(100vw - 24px));
  overflow: hidden;
  border: 1px solid var(--color-rule);
  border-radius: 8px;
  background: var(--color-surface);
  box-shadow: 0 18px 50px rgb(0 0 0 / 22%);
  color: var(--color-ink);
}

.workspace-setup-header {
  display: flex;
  min-height: 58px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border-bottom: 1px solid var(--color-rule);
  padding: 10px 12px 9px 16px;
}

.workspace-setup-header h2 {
  font-size: 13px;
  font-weight: 650;
}

.workspace-setup-header p {
  margin-top: 2px;
  overflow: hidden;
  color: var(--color-ink-3);
  font-family: var(--font-mono);
  font-size: 9px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-setup-header button {
  display: grid;
  width: 28px;
  height: 28px;
  flex: 0 0 auto;
  place-items: center;
  color: var(--color-ink-3);
}

.workspace-setup-header button:hover,
.workspace-setup-header button:focus-visible {
  background: var(--color-chrome-mid);
  color: var(--color-ink);
}

.workspace-setup-error {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  border-bottom: 1px solid color-mix(in srgb, var(--color-rem) 28%, var(--color-rule));
  padding: 9px 16px;
  color: var(--color-rem);
  font-size: 10px;
  line-height: 1.45;
}

.workspace-setup-fields {
  padding: 6px 16px;
}

.workspace-setup-row {
  display: grid;
  min-height: 66px;
  grid-template-columns: minmax(0, 1fr) 220px;
  align-items: center;
  gap: 20px;
  border-bottom: 1px solid var(--color-rule-light);
}

.workspace-setup-row:last-child {
  border-bottom: 0;
}

.workspace-setup-label strong,
.workspace-new-project > span {
  display: block;
  color: var(--color-ink-2);
  font-size: 11px;
  font-weight: 600;
}

.workspace-setup-label small {
  display: block;
  margin-top: 2px;
  color: var(--color-ink-3);
  font-size: 9.5px;
  line-height: 1.35;
}

.workspace-new-project {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 220px;
  align-items: center;
  gap: 20px;
  border-bottom: 1px solid var(--color-rule-light);
  padding: 10px 0;
}

.workspace-new-project input {
  height: 32px;
  border: 1px solid var(--color-rule);
  border-radius: 3px;
  background: var(--color-surface);
  padding: 0 9px;
  color: var(--color-ink);
  font-size: 11px;
  outline: none;
}

.workspace-new-project input:focus {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 1px var(--color-accent);
}

.workspace-scope-options {
  display: grid;
  grid-template-columns: 1fr 1fr;
  overflow: hidden;
  border: 1px solid var(--color-rule);
  border-radius: 3px;
}

.workspace-scope-option {
  display: flex;
  height: 32px;
  align-items: center;
  gap: 7px;
  padding: 0 9px;
  color: var(--color-ink-3);
  font-size: 10px;
  font-weight: 550;
}

.workspace-scope-option + .workspace-scope-option {
  border-left: 1px solid var(--color-rule);
}

.workspace-scope-option:hover,
.workspace-scope-option:focus-visible {
  background: var(--color-chrome-mid);
  color: var(--color-ink);
}

.workspace-scope-option-active {
  background: var(--color-accent-soft);
  color: var(--color-ink);
}

.workspace-radio {
  display: grid;
  width: 11px;
  height: 11px;
  place-items: center;
  border: 1px solid currentColor;
  border-radius: 50%;
}

.workspace-radio i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--color-accent);
}

.workspace-setup-footer {
  display: grid;
  min-height: 52px;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 8px;
  border-top: 1px solid var(--color-rule);
  padding: 9px 12px 9px 16px;
  background: var(--color-chrome-high);
}

.workspace-setup-footer code {
  overflow: hidden;
  color: var(--color-ink-4);
  font-family: var(--font-mono);
  font-size: 8.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-setup-cancel,
.workspace-setup-submit {
  height: 30px;
  border-radius: 3px;
  padding: 0 11px;
  font-size: 10px;
  font-weight: 600;
}

.workspace-setup-cancel {
  color: var(--color-ink-2);
}

.workspace-setup-cancel:hover,
.workspace-setup-cancel:focus-visible {
  background: var(--color-chrome-mid);
}

.workspace-setup-submit {
  background: var(--color-accent);
  color: var(--color-accent-ink);
}

.workspace-setup-submit:disabled {
  opacity: 0.45;
}

@media (max-width: 560px) {
  .workspace-setup-row,
  .workspace-new-project {
    grid-template-columns: 1fr;
    gap: 8px;
    padding: 11px 0;
  }

  .workspace-setup-footer {
    grid-template-columns: 1fr auto auto;
  }
}
</style>
