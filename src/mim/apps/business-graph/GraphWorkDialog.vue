<template>
  <Teleport to="body">
    <div
      v-if="open && node"
      data-graph-work-dialog
      class="work-overlay"
      @click.self="$emit('close')"
    >
      <form
        ref="dialog"
        class="work-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="graph-work-title"
        @submit.prevent="submit"
        @keydown.esc.prevent.stop="close"
        @keydown.tab="trapFocus"
      >
        <header class="work-header">
          <span class="work-signal"><IconSparkles :size="16" /></span>
          <div>
            <span>Graph-grounded Activity</span>
            <h2 id="graph-work-title">Start AI work</h2>
          </div>
          <button
            type="button"
            data-graph-control="work-close"
            aria-label="Close start work dialog"
            @click="close"
          >
            <IconX :size="16" />
          </button>
        </header>

        <div v-if="error" data-graph-work-error role="alert" class="work-error">
          <IconAlertTriangle :size="15" />
          <span>{{ error }}</span>
        </div>

        <div class="work-body">
          <div class="work-object">
            <span>{{ human(node.kind) }}</span>
            <strong>{{ node.title || node.id }}</strong>
            <small>{{ node.id }}</small>
          </div>

          <label class="work-intent">
            <span>Objective</span>
            <textarea
              ref="intentInput"
              v-model="intent"
              data-graph-control="work-intent"
              placeholder="What should the agent achieve?"
              @input="grow"
            />
          </label>

          <div class="work-suggestions">
            <span>Useful starting points</span>
            <button
              v-for="suggestion in suggestions"
              :key="suggestion"
              type="button"
              :class="{ selected: intent === suggestion }"
              :data-graph-control="`work-suggestion-${slug(suggestion)}`"
              @click="choose(suggestion)"
            >
              {{ suggestion }}
            </button>
          </div>

          <section class="work-context">
            <div class="work-context-heading">
              <span>Prepared context</span>
              <strong>{{ scopes.length }} {{ scopes.length === 1 ? 'scope' : 'scopes' }}</strong>
            </div>
            <p>
              Mim will assemble a bounded snapshot of this object and up to 16 related
              objects. Graph text is marked as untrusted data before the Activity starts.
            </p>
            <div class="work-scopes">
              <span v-for="scope in scopes" :key="scope.id">
                <i :class="`scope-${scope.kind}`" />
                {{ human(scope.kind) }}
              </span>
            </div>
          </section>

          <div class="work-commit-note">
            <IconActivity :size="14" />
            <span>
              This creates a durable agent Activity. You remain in control of the
              resulting source changes and graph updates.
            </span>
          </div>
        </div>

        <footer class="work-footer">
          <button
            type="button"
            data-graph-control="work-cancel"
            class="work-cancel"
            @click="close"
          >
            Cancel
          </button>
          <button
            type="submit"
            data-graph-control="work-start"
            class="work-start"
            :disabled="starting || !intent.trim()"
          >
            <IconSparkles :size="14" />
            {{ starting ? 'Preparing context…' : 'Start Activity' }}
          </button>
        </footer>
      </form>
    </div>
  </Teleport>
</template>

<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { IconActivity, IconAlertTriangle, IconSparkles, IconX } from '@tabler/icons-vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  node: { type: Object, default: null },
  scopes: { type: Array, default: () => [] },
  starting: { type: Boolean, default: false },
  error: { type: String, default: '' },
})

const emit = defineEmits(['close', 'start'])
const dialog = ref(null)
const intentInput = ref(null)
const intent = ref('')
const suggestions = computed(() => suggestionsFor(props.node?.kind))
let restoreFocusTo = null

watch(
  [() => props.open, () => props.node?.id],
  async ([open]) => {
    if (!open) {
      restoreDialogFocus()
      return
    }
    rememberDialogFocus()
    intent.value = suggestions.value[0] || 'Advance this work using the graph context.'
    await nextTick()
    grow()
    intentInput.value?.focus()
    intentInput.value?.select()
  },
  { immediate: true },
)

function submit() {
  if (props.starting || !intent.value.trim()) return
  emit('start', {
    node: props.node,
    intent: intent.value.trim(),
  })
}

function rememberDialogFocus() {
  restoreFocusTo = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null
}

function restoreDialogFocus() {
  const target = restoreFocusTo
  restoreFocusTo = null
  void nextTick(() => target?.isConnected && target.focus())
}

function close() {
  emit('close')
}

function trapFocus(event) {
  const focusable = [...(dialog.value?.querySelectorAll(
    'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
  ) || [])]
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

function choose(suggestion) {
  intent.value = suggestion
  void nextTick(() => {
    grow()
    intentInput.value?.focus()
  })
}

function grow() {
  const input = intentInput.value
  if (!input) return
  input.style.height = '0px'
  input.style.height = `${Math.max(112, input.scrollHeight)}px`
}

function suggestionsFor(kind) {
  if (kind === 'issue') {
    return [
      'Advance this issue and leave a durable next action.',
      'Review the evidence and identify the most important gap.',
      'Prepare a concise progress update with risks and decisions needed.',
    ]
  }
  if (kind === 'project') {
    return [
      'Synthesize project status, risks, decisions, and next actions.',
      'Prepare a client-ready progress update grounded in the graph.',
      'Find disconnected work or evidence that should be related to this project.',
    ]
  }
  if (['study', 'evidence', 'publication', 'dataset'].includes(kind)) {
    return [
      'Extract the decision-relevant evidence and record its limitations.',
      'Connect this source to the research questions and claims it informs.',
      'Identify evidence gaps and propose the next rigorous analysis.',
    ]
  }
  if (['person', 'company'].includes(kind)) {
    return [
      'Summarize the current relationship, active work, and next useful action.',
      'Identify open commitments, risks, and missing context.',
      'Prepare a concise relationship brief for the team.',
    ]
  }
  return [
    'Synthesize this object and leave durable graph updates.',
    'Identify gaps, contradictions, and the most useful next action.',
    'Connect this knowledge to the projects and decisions it should inform.',
  ]
}

function slug(value) {
  return String(value || '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-|-$/g, '')
    .slice(0, 42)
}

function human(value) {
  return String(value || '').replaceAll('-', ' ')
}
</script>

<style scoped>
.work-overlay {
  position: fixed;
  z-index: 155;
  inset: 0;
  display: grid;
  place-items: center;
  background: color-mix(in srgb, var(--color-ink) 36%, transparent);
  padding: 18px;
}

.work-dialog {
  display: flex;
  width: min(620px, 100%);
  max-height: min(820px, calc(100vh - 36px));
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--color-rule);
  border-radius: 3px;
  background: var(--color-surface);
  color: var(--color-ink);
  box-shadow: 0 16px 48px color-mix(in srgb, var(--color-ink) 22%, transparent);
}

.work-header {
  display: flex;
  min-height: 68px;
  flex: 0 0 auto;
  align-items: center;
  gap: 11px;
  border-bottom: 1px solid var(--color-rule-light);
  padding: 10px 15px 10px 18px;
}

.work-signal {
  display: grid;
  width: 35px;
  height: 35px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 2px;
  background: var(--color-accent-soft);
  color: var(--color-accent);
}

.work-header > div {
  min-width: 0;
  flex: 1 1 auto;
}

.work-header > div > span {
  display: block;
  color: var(--color-accent);
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 680;
  letter-spacing: 0.07em;
  text-transform: uppercase;
}

.work-header h2 {
  margin-top: 3px;
  color: var(--color-ink);
  font-size: 15px;
  font-weight: 670;
}

.work-header > button {
  display: grid;
  width: 34px;
  height: 34px;
  place-items: center;
  border-radius: 5px;
  color: var(--color-ink-4);
}

.work-header > button:hover {
  background: var(--color-chrome-mid);
  color: var(--color-ink);
}

.work-header > button:focus-visible,
.work-suggestions button:focus-visible,
.work-cancel:focus-visible,
.work-start:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--color-accent) 26%, transparent);
  outline-offset: 1px;
}

.work-body {
  min-height: 0;
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 20px;
}

.work-error {
  display: flex;
  min-height: 42px;
  flex: 0 0 auto;
  align-items: flex-start;
  gap: 8px;
  border-bottom: 1px solid color-mix(in srgb, var(--color-rem) 25%, var(--color-rule));
  background: color-mix(in srgb, var(--color-rem) 5%, var(--color-surface));
  padding: 9px 18px;
  color: var(--color-rem);
  font-size: 11px;
  line-height: 1.45;
}

.work-error svg {
  flex: 0 0 auto;
}

.work-object {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: baseline;
  gap: 5px 10px;
  border-radius: 2px;
  background: var(--color-chrome-high);
  padding: 12px 14px;
}

.work-object > span {
  grid-row: 1 / 3;
  align-self: center;
  padding: 0;
  color: var(--color-accent);
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 650;
  text-transform: capitalize;
}

.work-object strong {
  overflow: hidden;
  color: var(--color-ink);
  font-size: 12px;
  font-weight: 640;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.work-object small {
  overflow: hidden;
  color: var(--color-ink-4);
  font-family: var(--font-mono);
  font-size: 9px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.work-intent {
  display: block;
  margin-top: 18px;
}

.work-intent > span,
.work-suggestions > span,
.work-context-heading > span {
  display: block;
  margin: 0 0 7px 2px;
  color: var(--color-ink-4);
  font-size: 10px;
  font-weight: 680;
  letter-spacing: 0.065em;
  text-transform: uppercase;
}

.work-intent textarea {
  width: 100%;
  min-height: 112px;
  overflow: hidden;
  resize: none;
  border: 1px solid var(--color-rule);
  border-radius: 2px;
  background: var(--color-chrome-high);
  padding: 13px 14px;
  color: var(--color-ink);
  font-size: 13px;
  line-height: 1.55;
}

.work-intent textarea:focus-visible {
  border-color: var(--color-accent);
  outline: 2px solid color-mix(in srgb, var(--color-accent) 22%, transparent);
  outline-offset: 1px;
}

.work-suggestions {
  margin-top: 16px;
}

.work-suggestions button {
  display: block;
  width: 100%;
  min-height: 38px;
  border-radius: 5px;
  padding: 7px 10px;
  color: var(--color-ink-3);
  font-size: 10px;
  line-height: 1.35;
  text-align: left;
}

.work-suggestions button:hover {
  background: var(--color-chrome-mid);
  color: var(--color-ink);
}

.work-suggestions button.selected {
  background: var(--color-accent-soft);
  color: var(--color-accent);
  font-weight: 610;
}

.work-context {
  margin-top: 19px;
  border: 1px solid var(--color-rule-light);
  border-radius: 2px;
  padding: 14px;
}

.work-context-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.work-context-heading > span {
  margin: 0;
}

.work-context-heading strong {
  color: var(--color-ink-3);
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 500;
}

.work-context p {
  margin-top: 9px;
  color: var(--color-ink-3);
  font-size: 10px;
  line-height: 1.55;
}

.work-scopes {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  margin-top: 12px;
}

.work-scopes span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--color-rule-light);
  border-radius: 2px;
  background: transparent;
  padding: 4px 8px;
  color: var(--color-ink-3);
  font-size: 9px;
  text-transform: capitalize;
}

.work-scopes i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-ink-3);
}

.work-scopes .scope-project {
  background: var(--color-accent);
}

.work-scopes .scope-team {
  background: var(--color-add);
}

.work-commit-note {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 14px;
  color: var(--color-ink-4);
  font-size: 9px;
  line-height: 1.5;
}

.work-commit-note svg {
  flex: 0 0 auto;
  margin-top: 1px;
  color: var(--color-accent);
}

.work-footer {
  display: flex;
  min-height: 59px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  border-top: 1px solid var(--color-rule);
  background: var(--color-chrome-high);
  padding: 9px 14px;
}

.work-cancel,
.work-start {
  min-height: 35px;
  border-radius: 5px;
  padding: 0 12px;
  font-size: 11px;
  font-weight: 650;
}

.work-cancel {
  color: var(--color-ink-3);
}

.work-cancel:hover {
  background: var(--color-chrome-mid);
  color: var(--color-ink);
}

.work-start {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  background: var(--color-accent);
  color: var(--color-accent-ink, white);
}

.work-start:hover {
  background: color-mix(in srgb, var(--color-accent) 88%, var(--color-ink));
}

.work-start:disabled {
  cursor: default;
  opacity: 0.42;
  filter: none;
}

@media (max-width: 560px) {
  .work-overlay {
    padding: 0;
  }

  .work-dialog {
    width: 100%;
    height: 100%;
    max-height: none;
    border: 0;
    border-radius: 0;
  }
}
</style>
