<template>
  <Teleport to="body">
    <div
      v-if="open"
      data-scribe-follow-up-dialog
      :data-mode="mode"
      class="follow-up-overlay"
      @click.self="$emit('close')"
    >
      <form
        ref="dialog"
        class="follow-up-dialog"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        :aria-busy="busy"
        @submit.prevent="$emit('submit')"
        @keydown.esc.prevent.stop="$emit('close')"
        @keydown.tab="trapFocus"
      >
        <header class="follow-up-header">
          <h2 :id="titleId">{{ title }}</h2>
          <button type="button" aria-label="Close" @click="$emit('close')">
            <IconX :size="15" />
          </button>
        </header>

        <div class="follow-up-body">
          <div v-if="mode === 'summary'" class="follow-up-routing">
            <label>
              <span>Format</span>
              <ScribeSelect
                :model-value="format"
                :options="formats"
                :disabled="busy"
                aria-label="Summary format"
                @update:model-value="$emit('update:format', $event)"
              />
            </label>
            <label>
              <span>Agent</span>
              <ScribeSelect
                :model-value="agent"
                :options="agents"
                :disabled="busy"
                aria-label="Summary agent"
                @update:model-value="$emit('update:agent', $event)"
              />
            </label>
          </div>

          <label v-else class="follow-up-field">
            <span>Agent</span>
            <ScribeSelect
              :model-value="agent"
              :options="agents"
              :disabled="busy"
              aria-label="Custom task agent"
              @update:model-value="$emit('update:agent', $event)"
            />
          </label>

          <button
            v-if="mode === 'summary'"
            type="button"
            data-scribe-prompt-toggle
            class="follow-up-disclosure"
            :aria-expanded="promptOpen"
            @click="promptOpen = !promptOpen"
          >
            <span>{{ promptOpen ? 'Hide prompt' : 'Edit prompt' }}</span>
            <IconChevronDown :size="13" :class="{ 'rotate-180': promptOpen }" />
          </button>

          <label v-if="mode === 'agent' || promptOpen" class="follow-up-field follow-up-prompt">
            <span>{{ mode === 'agent' ? 'Task' : 'Prompt' }}</span>
            <textarea
              :value="prompt"
              :data-scribe-summary-prompt="mode === 'summary' ? '' : undefined"
              :data-scribe-custom-task-prompt="mode === 'agent' ? '' : undefined"
              :rows="mode === 'agent' ? 4 : 9"
              autocorrect="off"
              autocapitalize="off"
              :placeholder="mode === 'agent' ? 'What should the agent do?' : ''"
              :disabled="busy"
              @input="$emit('update:prompt', $event.target.value)"
            />
          </label>

          <p v-if="mode === 'agent' && !agentAvailable" class="follow-up-error" role="status">
            Configure a CLI agent before you open a follow-up Activity.
          </p>
        </div>

        <footer class="follow-up-footer">
          <button type="button" class="follow-up-cancel" @click="$emit('close')">Cancel</button>
          <button
            type="submit"
            data-scribe-follow-up-submit
            class="follow-up-submit"
            :disabled="busy || (mode === 'agent' && !agentAvailable)"
          >
            {{ actionLabel }}
          </button>
        </footer>
      </form>
    </div>
  </Teleport>
</template>

<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { IconChevronDown, IconX } from '@tabler/icons-vue'
import ScribeSelect from './ScribeSelect.vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  mode: { type: String, default: 'summary' },
  format: { type: String, default: 'standard' },
  formats: { type: Array, default: () => [] },
  agent: { type: String, default: '' },
  agents: { type: Array, default: () => [] },
  prompt: { type: String, default: '' },
  busy: { type: Boolean, default: false },
  agentAvailable: { type: Boolean, default: true },
  actionLabel: { type: String, default: 'Create' },
})

defineEmits(['close', 'submit', 'update:format', 'update:agent', 'update:prompt'])
const dialog = ref(null)
const promptOpen = ref(false)
const titleId = 'scribe-follow-up-title'
const title = computed(() => (
  props.mode === 'agent'
    ? 'Ask agent'
    : props.actionLabel === 'Create summary' ? 'Create summary' : 'Regenerate summary'
))

watch(() => props.open, async open => {
  if (!open) return
  promptOpen.value = false
  await nextTick()
  dialog.value?.querySelector('[role="combobox"], textarea, button')?.focus()
})

function trapFocus(event) {
  const focusable = [...(dialog.value?.querySelectorAll(
    'button:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
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
.follow-up-overlay {
  position: fixed;
  inset: 0;
  z-index: 210;
  display: grid;
  place-items: center;
  background: color-mix(in srgb, var(--color-ink) 24%, transparent);
  padding: 16px;
}

.follow-up-dialog {
  width: min(460px, calc(100vw - 24px));
  overflow: hidden;
  border: 1px solid var(--color-rule);
  border-radius: 5px;
  background: var(--color-surface);
  color: var(--color-ink);
  box-shadow: 0 16px 48px color-mix(in srgb, var(--color-ink) 22%, transparent);
}

.follow-up-header,
.follow-up-footer {
  display: flex;
  align-items: center;
  border-color: var(--color-rule);
}

.follow-up-header {
  min-height: 44px;
  justify-content: space-between;
  border-bottom-width: 1px;
  padding: 7px 10px 7px 13px;
}

.follow-up-header h2 {
  font-size: 13px;
  font-weight: 650;
}

.follow-up-header button {
  display: grid;
  width: 28px;
  height: 28px;
  place-items: center;
  border-radius: 2px;
  color: var(--color-ink-3);
}

.follow-up-header button:hover,
.follow-up-header button:focus-visible,
.follow-up-cancel:hover,
.follow-up-cancel:focus-visible {
  background: var(--color-chrome-mid);
  color: var(--color-ink);
  outline: none;
}

.follow-up-body {
  padding: 13px;
}

.follow-up-routing {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 10px;
}

.follow-up-field {
  display: block;
}

.follow-up-routing label > span,
.follow-up-field > span {
  display: block;
  margin-bottom: 5px;
  color: var(--color-ink-4);
  font-family: var(--font-mono);
  font-size: 9px;
}

.follow-up-disclosure {
  display: flex;
  min-height: 28px;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  margin-top: 10px;
  border-top: 1px solid var(--color-rule-light);
  color: var(--color-ink-3);
  font-size: 10px;
}

.follow-up-disclosure:hover,
.follow-up-disclosure:focus-visible {
  color: var(--color-ink);
  outline: none;
}

.follow-up-prompt {
  margin-top: 9px;
}

.follow-up-prompt textarea {
  width: 100%;
  min-height: 86px;
  resize: vertical;
  border: 1px solid var(--color-rule);
  background: var(--color-surface);
  padding: 8px;
  color: var(--color-ink);
  font-size: 10px;
  line-height: 1.5;
  outline: none;
}

.follow-up-prompt textarea:focus-visible {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 1px var(--color-accent);
}

.follow-up-error {
  margin-top: 8px;
  color: var(--color-rem);
  font-size: 10px;
}

.follow-up-footer {
  min-height: 46px;
  justify-content: flex-end;
  gap: 6px;
  border-top-width: 1px;
  padding: 7px 10px;
}

.follow-up-cancel,
.follow-up-submit {
  min-height: 28px;
  padding: 0 9px;
  font-size: 10px;
  font-weight: 600;
}

.follow-up-submit {
  border: 1px solid var(--color-accent);
  background: var(--color-accent);
  color: var(--color-surface);
}

.follow-up-submit:focus-visible {
  outline: 1px solid var(--color-accent);
  outline-offset: 2px;
}

.follow-up-submit:disabled {
  opacity: 0.5;
}

@media (max-width: 480px) {
  .follow-up-routing {
    grid-template-columns: 1fr;
  }
}
</style>
