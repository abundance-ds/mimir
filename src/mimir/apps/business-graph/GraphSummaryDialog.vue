<template>
  <Teleport to="body">
    <div
      v-if="open"
      data-graph-summary-dialog
      class="summary-overlay"
      @click.self="$emit('close')"
    >
      <form
        ref="dialog"
        class="summary-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="graph-summary-title"
        :aria-busy="busy"
        @submit.prevent="submit"
        @keydown.esc.prevent.stop="$emit('close')"
        @keydown.tab="trapFocus"
      >
        <header class="summary-header">
          <h2 id="graph-summary-title">Summarise changes</h2>
          <button
            type="button"
            data-graph-control="summary-close"
            aria-label="Close summary dialog"
            @click="$emit('close')"
          >
            <IconX :size="16" />
          </button>
        </header>

        <div class="summary-body">
          <div class="summary-routing">
            <label>
              <span>CLI agent</span>
              <GraphSelect
                v-model="draft.presetId"
                data-graph-control="summary-agent"
                variant="field"
                aria-label="CLI agent for change summary"
                :options="agentOptions"
                :menu-min-width="280"
                placeholder="Choose an agent"
              />
            </label>
            <label>
              <span>Since</span>
              <GraphDatePicker
                v-model="draft.since"
                data-graph-control="summary-since"
                variant="field"
                aria-label="Summarise changes since"
                placeholder="Choose a date"
              />
            </label>
          </div>

          <p v-if="!agents.length" class="summary-agent-empty" role="status">
            No CLI agent is available. Configure Codex, Claude, Pi, or Gemini in Settings.
          </p>

          <label class="summary-instructions">
            <span>
              Additional instructions
              <small>optional</small>
            </span>
            <textarea
              v-model="draft.instructions"
              data-graph-control="summary-instructions"
              rows="5"
              maxlength="4000"
              placeholder="For example: focus on client decisions, delivery risks, and work that needs my attention."
            />
          </label>

        </div>

        <footer class="summary-footer">
          <button
            type="button"
            data-graph-control="summary-cancel"
            class="summary-cancel"
            @click="$emit('close')"
          >
            Cancel
          </button>
          <button
            type="submit"
            data-graph-control="summary-start"
            class="summary-start"
            :disabled="busy || !draft.presetId || !draft.since || !agents.length"
          >
            <IconNotes :size="14" />
            {{ busy ? 'Preparing…' : 'Start summary' }}
          </button>
        </footer>
      </form>
    </div>
  </Teleport>
</template>

<script setup>
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { IconNotes, IconX } from '@tabler/icons-vue'
import GraphDatePicker from './GraphDatePicker.vue'
import GraphSelect from './GraphSelect.vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  agents: { type: Array, default: () => [] },
  busy: { type: Boolean, default: false },
})

const emit = defineEmits(['close', 'launch'])
const dialog = ref(null)
const draft = reactive({
  presetId: '',
  since: dateDaysAgo(7),
  instructions: '',
})
const agentOptions = computed(() => props.agents.map(agent => ({
  value: agent.id,
  label: agent.title || agent.id,
})))

watch(() => props.open, async (open) => {
  if (!open) return
  if (!props.agents.some(agent => agent.id === draft.presetId)) {
    draft.presetId = props.agents[0]?.id || ''
  }
  await nextTick()
  dialog.value?.querySelector('[data-graph-control="summary-agent"]')?.focus()
})

function submit() {
  if (props.busy || !draft.presetId || !draft.since || !props.agents.length) return
  emit('launch', {
    presetId: draft.presetId,
    since: draft.since,
    instructions: draft.instructions.trim(),
  })
}

function dateDaysAgo(days) {
  const date = new Date()
  date.setDate(date.getDate() - days)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
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
</script>

<style scoped>
.summary-overlay {
  position: fixed;
  inset: 0;
  z-index: 210;
  display: grid;
  place-items: center;
  background: color-mix(in srgb, var(--color-ink) 24%, transparent);
  padding: 20px;
}

.summary-dialog {
  width: min(520px, calc(100vw - 28px));
  overflow: hidden;
  border: 1px solid var(--color-rule);
  border-radius: 6px;
  background: var(--color-surface);
  color: var(--color-ink);
  box-shadow: 0 18px 54px color-mix(in srgb, var(--color-ink) 24%, transparent);
}

.summary-header {
  display: flex;
  min-height: 50px;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--color-rule);
  padding: 10px 14px;
}

.summary-routing label > span,
.summary-instructions > span {
  display: block;
  color: var(--color-ink-4);
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.summary-header h2 {
  color: var(--color-ink);
  font-size: 15px;
  font-weight: 670;
}

.summary-header button {
  display: grid;
  width: 30px;
  height: 30px;
  place-items: center;
  border-radius: 4px;
  color: var(--color-ink-3);
}

.summary-header button:hover,
.summary-header button:focus-visible {
  background: var(--color-chrome-mid);
  color: var(--color-ink);
}

.summary-body {
  padding: 14px 14px 18px;
}

.summary-routing {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(160px, 0.65fr);
  gap: 10px;
}

.summary-routing label > span,
.summary-instructions > span {
  margin-bottom: 6px;
}

.summary-agent-empty {
  margin-top: 9px;
  color: var(--color-rem);
  font-size: 10px;
  line-height: 1.45;
}

.summary-instructions {
  display: block;
  margin-top: 16px;
}

.summary-instructions small {
  margin-left: 5px;
  color: var(--color-ink-4);
  font-family: var(--font-sans);
  font-size: 9px;
  font-weight: 400;
  letter-spacing: 0;
  text-transform: none;
}

.summary-instructions textarea {
  width: 100%;
  min-height: 104px;
  resize: vertical;
  border: 1px solid var(--color-rule-light);
  border-radius: 5px;
  outline: none;
  background: var(--color-chrome-high);
  padding: 9px 10px;
  color: var(--color-ink-2);
  font-family: var(--font-sans);
  font-size: 11px;
  line-height: 1.5;
}

.summary-instructions textarea:focus {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 2px var(--color-accent-soft);
}

.summary-instructions textarea::placeholder {
  color: var(--color-ink-4);
}

.summary-footer {
  display: flex;
  min-height: 54px;
  align-items: center;
  justify-content: flex-end;
  gap: 7px;
  border-top: 1px solid var(--color-rule);
  background: var(--color-chrome-high);
  padding: 8px 14px;
}

.summary-cancel,
.summary-start {
  min-height: 34px;
  border-radius: 5px;
  padding: 0 11px;
  font-size: 11px;
  font-weight: 650;
}

.summary-cancel {
  color: var(--color-ink-3);
}

.summary-cancel:hover {
  background: var(--color-chrome-mid);
  color: var(--color-ink);
}

.summary-start {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--color-accent);
  color: var(--color-accent-ink, white);
}

.summary-start:hover {
  background: color-mix(in srgb, var(--color-accent) 88%, var(--color-ink));
}

.summary-start:disabled {
  cursor: default;
  opacity: 0.42;
}

@media (max-width: 560px) {
  .summary-overlay {
    padding: 0;
  }

  .summary-dialog {
    width: 100%;
    height: 100%;
    border: 0;
    border-radius: 0;
  }

  .summary-routing {
    grid-template-columns: 1fr;
  }
}
</style>
