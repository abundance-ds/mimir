<template>
  <section class="agent-instructions" aria-labelledby="agents-template-label">
    <div class="template-heading">
      <label id="agents-template-label" for="agents-template">Default AGENTS.md</label>
      <button type="button" data-agents-reset :disabled="busy" @click="reset">Reset to default</button>
    </div>
    <p id="agents-template-help">
      Mimir creates this file when you create or open a project that has no AGENTS.md.
      Existing files stay unchanged.
    </p>
    <textarea
      id="agents-template"
      v-model="draft"
      data-agents-template
      aria-describedby="agents-template-help"
      rows="10"
      autocomplete="off"
      autocorrect="off"
      autocapitalize="off"
      spellcheck="false"
      writingsuggestions="false"
      :disabled="busy"
      @input="message = ''; error = ''"
    />
    <div class="template-actions">
      <button type="button" data-agents-copy :disabled="busy" @click="copy">Copy template</button>
      <button type="button" data-agents-save class="primary" :disabled="busy || !dirty || !draft.trim()" @click="save">
        {{ saving ? 'Saving…' : 'Save template' }}
      </button>
    </div>
    <p v-if="error" role="alert" class="template-error">{{ error }}</p>
    <p v-else-if="message" role="status">{{ message }}</p>
    <p v-else-if="dirty" role="status">Unsaved template changes</p>
  </section>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { AGENTS_STARTER } from '../../agentInstructions.js'
import { useSettingsStore } from '../../../stores/settings.js'

const settings = useSettingsStore()
const draft = ref(settings.agentsTemplate)
const saving = ref(false)
const message = ref('')
const error = ref('')
const busy = computed(() => saving.value || !settings.settingsReady)
const dirty = computed(() => draft.value !== settings.agentsTemplate)

// Accept hydration and external changes only when there are no local edits.
watch(() => settings.agentsTemplate, (value, previous) => {
  if (!saving.value && draft.value === previous) draft.value = value
}, { flush: 'sync' })

function reset() {
  draft.value = AGENTS_STARTER
  message.value = ''
  error.value = ''
}

async function save() {
  if (busy.value || !dirty.value || !draft.value.trim()) return
  const previous = settings.agentsTemplate
  saving.value = true
  error.value = ''
  message.value = ''
  try {
    settings.set('agentsTemplate', draft.value)
    if (!await settings.flush()) throw new Error('The template could not be saved. Try again.')
    message.value = 'Template saved. Existing project files stay unchanged.'
  } catch (cause) {
    settings.set('agentsTemplate', previous)
    error.value = cause?.message || String(cause)
  } finally {
    saving.value = false
  }
}

async function copy() {
  error.value = ''
  message.value = ''
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable.')
    await navigator.clipboard.writeText(draft.value)
    message.value = 'Template copied.'
  } catch (cause) {
    error.value = cause?.message || String(cause)
  }
}
</script>

<style scoped>
.agent-instructions {
  margin-top: 24px;
  padding-top: 16px;
  border-top: 1px solid var(--color-rule-light);
}

.template-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

label {
  font-size: 11px;
  font-weight: 600;
  color: var(--color-ink-2);
}

p {
  margin: 6px 0;
  font-size: 10px;
  line-height: 1.5;
  color: var(--color-ink-3);
}

textarea {
  display: block;
  box-sizing: border-box;
  width: 100%;
  margin-top: 10px;
  resize: vertical;
  padding: 10px;
  border: 1px solid var(--color-rule);
  background: var(--color-surface);
  color: var(--color-ink);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.5;
  user-select: text;
}

.template-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}

button {
  min-height: 28px;
  padding: 0 10px;
  border: 1px solid var(--color-rule);
  background: var(--color-chrome-mid);
  color: var(--color-ink-2);
  font-size: 10px;
}

button:hover:not(:disabled) {
  border-color: var(--color-accent);
  color: var(--color-ink);
}

button:disabled, textarea:disabled {
  opacity: 0.5;
}

button:focus-visible, textarea:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

.primary {
  background: var(--color-accent);
  border-color: var(--color-accent);
  color: var(--color-accent-ink);
}

.primary:hover:not(:disabled) {
  background: var(--color-accent-2);
  color: var(--color-accent-ink);
}

.template-error {
  color: var(--color-rem);
}
</style>
