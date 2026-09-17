<template>
  <Teleport to="body">
    <div v-if="request" class="entity-overlay" data-scribe-create-dialog @click.self="close">
      <form ref="dialog" class="entity-dialog" role="dialog" aria-modal="true"
        aria-labelledby="scribe-create-title" :aria-busy="busy"
        @submit.prevent="submit" @keydown.esc.prevent.stop="close" @keydown.tab="trapFocus">
        <h2 id="scribe-create-title">New {{ request.kind }}</h2>
        <label>
          <span>Name</span>
          <input ref="nameInput" v-model="name" aria-label="Name" required :disabled="busy"
            autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" />
        </label>
        <label v-if="request.kind === 'person'">
          <span>Company <span class="entity-optional">(optional)</span></span>
          <GraphSelect v-model="companyId" :options="companyOptions" aria-label="Company"
            :disabled="busy" searchable search-placeholder="Find a company" placeholder="None" />
        </label>
        <label>
          <span>Save in</span>
          <GraphSelect v-model="scopeId" :options="scopeOptions" aria-label="Save in"
            :disabled="busy" placeholder="Choose a location" />
        </label>
        <p v-if="error" role="alert" class="entity-error">{{ error }}</p>
        <footer>
          <button type="button" :disabled="busy" @click="close">Cancel</button>
          <button type="submit" class="entity-submit" :disabled="busy || !name.trim() || !validScope">
            {{ busy ? 'Creating…' : 'Create and add' }}
          </button>
        </footer>
      </form>
    </div>
  </Teleport>
</template>

<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import GraphSelect from '../business-graph/GraphSelect.vue'

const props = defineProps({
  request: { type: Object, default: null },
  scopes: { type: Array, default: () => [] },
  companies: { type: Array, default: () => [] },
  busy: Boolean,
  error: { type: String, default: '' },
})
const emit = defineEmits(['close', 'submit'])
const dialog = ref(null)
const nameInput = ref(null)
const name = ref('')
const scopeId = ref('')
const companyId = ref('')
const companyOptions = computed(() => [
  { value: '', label: 'None' },
  ...[...props.companies].sort((a, b) => a.title.localeCompare(b.title))
    .map(company => ({ value: company.id, label: company.title })),
])
let returnFocus = null
const scopeOptions = computed(() => props.scopes.map(scope => ({
  value: scope.id,
  label: { team: 'Team', project: 'Workspace', private: 'Private' }[scope.kind] || scope.kind,
})))
const validScope = computed(() => props.scopes.some(scope => scope.id === scopeId.value))

watch(() => props.request, async request => {
  if (!request) {
    await nextTick()
    if (returnFocus?.isConnected) returnFocus.focus()
    return
  }
  returnFocus = document.activeElement
  name.value = request.title || ''
  companyId.value = ''
  scopeId.value = request.scopeId || ''
  await nextTick()
  nameInput.value?.focus()
}, { immediate: true })

function close() {
  if (!props.busy) emit('close')
}

function submit() {
  if (props.busy || !name.value.trim() || !validScope.value) return
  emit('submit', {
    kind: props.request.kind, title: name.value.trim(), scopeId: scopeId.value,
    ...(props.request.kind === 'person' && companyId.value ? { companyId: companyId.value } : {}),
  })
}

function trapFocus(event) {
  const fields = [...dialog.value.querySelectorAll('input:not(:disabled), button:not(:disabled)')]
  const first = fields[0]
  const last = fields.at(-1)
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last?.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first?.focus()
  }
}
</script>

<style scoped>
.entity-overlay {
  position: fixed;
  inset: 0;
  z-index: 210;
  display: grid;
  place-items: center;
  padding: 16px;
  background: color-mix(in srgb, var(--color-ink) 24%, transparent);
}
.entity-dialog {
  width: min(360px, 100%);
  max-height: calc(100dvh - 32px);
  overflow: auto;
  border: 1px solid var(--color-rule);
  border-radius: 5px;
  background: var(--color-surface);
  color: var(--color-ink);
  box-shadow: 0 16px 48px color-mix(in srgb, var(--color-ink) 22%, transparent);
  padding: 16px;
}
h2 { margin-bottom: 16px; font-size: 13px; font-weight: 650; }
label { display: grid; gap: 5px; margin-bottom: 12px; }
label > span { color: var(--color-ink-3); font-size: 11px; }
input {
  width: 100%;
  min-height: 32px;
  border: 1px solid var(--color-rule);
  background: var(--color-surface);
  padding: 0 9px;
  color: var(--color-ink);
  font-size: 12px;
}
footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
button { min-height: 30px; padding: 0 10px; font-size: 11px; }
button:hover { background: var(--color-chrome-mid); }
.entity-submit, .entity-submit:hover { background: var(--color-accent); color: var(--color-surface); }
input:focus-visible, button:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
button:disabled, input:disabled { opacity: 0.5; }
.entity-optional { color: var(--color-ink-4); }
.entity-error { color: var(--color-rem); font-size: 11px; }
</style>
