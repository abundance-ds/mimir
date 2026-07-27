<template>
  <footer
    ref="shell"
    data-graph-dispatch
    class="dispatch-bar"
    :class="{ 'dispatch-bar-focused': focused }"
  >
    <div
      v-if="overlayKind"
      data-dispatch-overlay
      class="dispatch-overlay"
      :data-dispatch-overlay-kind="overlayKind"
    >
      <div
        v-if="overlayKind === 'results'"
        class="dispatch-results"
        role="listbox"
        aria-label="Graph lookup results"
      >
        <button
          v-for="(item, index) in suggestions"
          :key="item.id"
          type="button"
          role="option"
          :aria-selected="index === selection"
          :data-dispatch-result="item.id"
          class="dispatch-result"
          :class="{ selected: index === selection }"
          @mousedown.prevent="openResult(item)"
          @mouseenter="selection = index"
        >
          <span class="dispatch-result-kind">{{ human(item.kind) }}</span>
          <strong>{{ item.title || item.id }}</strong>
          <span class="dispatch-result-context">{{ resultContext(item) }}</span>
        </button>
        <p class="dispatch-hint">
          {{ delegateMode ? 'Enter arms the context pack' : 'Enter dispatch · Tab open' }}
        </p>
      </div>

      <div v-else-if="overlayKind === 'pack'" class="dispatch-pack">
        <header>
          <span>What the agent will see · {{ packScopes }} scopes · ≤16 nodes</span>
          <strong>{{ armedNode?.title || armedNode?.id }}</strong>
        </header>
        <pre data-dispatch-pack>{{ packPreview }}</pre>
        <p class="dispatch-hint">Enter launches · Esc steps back</p>
      </div>

      <div v-else-if="overlayKind === 'scrollback'" class="dispatch-scrollback">
        <p
          v-for="entry in recentEchoes"
          :key="entry.id"
          :class="`echo-${entry.kind}`"
        >
          <code>{{ entry.text }}</code>
          <time>{{ compactTime(entry.at) }}</time>
        </p>
      </div>
    </div>

    <div class="dispatch-line">
      <span class="dispatch-prompt" aria-hidden="true">›</span>
      <input
        ref="input"
        v-model="value"
        data-dispatch-input
        data-graph-control="dispatch"
        type="text"
        autocomplete="off"
        spellcheck="false"
        aria-label="Dispatch work, look up graph objects, or run a power command"
        :placeholder="placeholder"
        @focus="focused = true"
        @blur="onBlur"
        @keydown="onKeydown"
      />
      <span v-if="lookingUp" class="dispatch-pulse" aria-label="Looking up" />
      <span v-if="queued" class="dispatch-queue">{{ queued }} queued</span>
      <span v-if="running" class="dispatch-runner">
        <i aria-hidden="true" /> filing
      </span>
      <span class="dispatch-nodes">{{ nodeCount }} nodes</span>
    </div>
  </footer>
</template>

<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { graphContext, searchGraph } from '../../../services/businessGraph.js'

const props = defineProps({
  scopeIds: { type: Array, default: () => [] },
  nodes: { type: Array, default: () => [] },
  nodeCount: { type: Number, default: 0 },
  echoes: { type: Array, default: () => [] },
  running: { type: Number, default: 0 },
  queued: { type: Number, default: 0 },
})

const emit = defineEmits(['open-node', 'dispatch', 'delegate', 'power'])
const shell = ref(null)
const input = ref(null)
const value = ref('')
const focused = ref(false)
const suggestions = ref([])
const selection = ref(0)
const lookingUp = ref(false)
const armedNode = ref(null)
const packPreview = ref('')
const packScopes = ref(0)
let lookupTimer = null
let lookupGeneration = 0

const trimmed = computed(() => value.value.trim())
const powerMode = computed(() => trimmed.value.startsWith('/'))
const delegateMode = computed(() => (
  trimmed.value === '!'
  || trimmed.value.startsWith('! ')
  || /^work(?:\s|$)/i.test(trimmed.value)
))
const delegateTerms = computed(() => {
  if (!delegateMode.value) return ''
  return trimmed.value.replace(/^!\s?|^work\s?/i, '')
})
const lookupTerms = computed(() => (
  delegateMode.value ? delegateTerms.value : trimmed.value
))
const recentEchoes = computed(() => props.echoes.slice(-5))
const overlayKind = computed(() => {
  if (!focused.value) return ''
  if (armedNode.value) return 'pack'
  if (!powerMode.value && suggestions.value.length) return 'results'
  if (recentEchoes.value.length) return 'scrollback'
  return ''
})
const placeholder = computed(() => {
  if (powerMode.value) return '/board waiting · /open <id> · /find <terms> · /clear'
  if (delegateMode.value) return 'name the work target — Enter arms the context pack'
  return 'Dispatch a line, look anything up, or / for commands'
})

watch(lookupTerms, terms => {
  clearTimeout(lookupTimer)
  if (armedNode.value) return
  if (powerMode.value || terms.trim().length < (delegateMode.value ? 1 : 2)) {
    suggestions.value = []
    lookingUp.value = false
    return
  }
  lookingUp.value = true
  lookupTimer = setTimeout(() => void lookup(terms.trim()), 120)
})

async function lookup(terms) {
  const generation = ++lookupGeneration
  try {
    const results = await searchGraph(terms, { scopeIds: props.scopeIds, limit: 7 })
    if (generation !== lookupGeneration) return
    suggestions.value = (Array.isArray(results) ? results : [])
      .map(result => result.node || result)
    selection.value = 0
  } catch {
    if (generation === lookupGeneration) suggestions.value = []
  } finally {
    if (generation === lookupGeneration) lookingUp.value = false
  }
}

function onKeydown(event) {
  if (event.key === 'ArrowDown' && suggestions.value.length) {
    event.preventDefault()
    selection.value = (selection.value + 1) % suggestions.value.length
    return
  }
  if (event.key === 'ArrowUp' && suggestions.value.length) {
    event.preventDefault()
    selection.value = (selection.value - 1 + suggestions.value.length) % suggestions.value.length
    return
  }
  if (event.key === 'Tab') {
    const target = suggestions.value[selection.value]
    if (target) {
      event.preventDefault()
      openResult(target)
    }
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    if (armedNode.value) disarm()
    else if (value.value) {
      value.value = ''
      suggestions.value = []
    } else {
      input.value?.blur()
    }
    return
  }
  if (event.key === 'Enter' && !event.isComposing) {
    event.preventDefault()
    submit()
  }
}

async function submit() {
  const line = trimmed.value
  if (!line) return
  if (armedNode.value) {
    const node = armedNode.value
    disarm()
    value.value = ''
    suggestions.value = []
    emit('delegate', { node })
    return
  }
  if (powerMode.value) {
    value.value = ''
    suggestions.value = []
    emit('power', line)
    return
  }
  if (delegateMode.value) {
    const target = suggestions.value[selection.value]
    if (target) {
      await arm(target)
      return
    }
  }
  value.value = ''
  suggestions.value = []
  emit('dispatch', line)
}

async function arm(node) {
  armedNode.value = node
  packPreview.value = 'Assembling context…'
  try {
    const context = await graphContext({
      focusId: node.id,
      scopeIds: props.scopeIds,
      maxNodes: 16,
    })
    if (armedNode.value?.id !== node.id) return
    packScopes.value = props.scopeIds.length
    packPreview.value = String(context?.markdown || '').split('\n').slice(0, 14).join('\n')
  } catch (cause) {
    if (armedNode.value?.id !== node.id) return
    packPreview.value = `Context could not be assembled: ${cause?.message || cause}`
  }
}

function disarm() {
  armedNode.value = null
  packPreview.value = ''
}

function openResult(node) {
  disarm()
  value.value = ''
  suggestions.value = []
  input.value?.blur()
  emit('open-node', node.id)
}

function onBlur() {
  setTimeout(() => {
    focused.value = shell.value?.contains(document.activeElement) ?? false
  }, 0)
}

function focusInput() {
  input.value?.focus()
  input.value?.select()
}

function resultContext(item) {
  if (item.kind === 'issue') {
    return [
      human(item.status || 'backlog'),
      projectLabel(item),
      item.dueDate || '',
    ].filter(Boolean).join(' · ')
  }
  if (item.kind === 'person') {
    return [item.role, item.email, item.phone].filter(Boolean).join(' · ')
      || human(item.kind)
  }
  return [item.summary].filter(Boolean).join('') || human(item.kind)
}

function projectLabel(item) {
  if (!item.projectId) return ''
  const project = props.nodes.find(node => node.id === item.projectId)
  return project?.slug || project?.properties?.slug || project?.title || ''
}

function compactTime(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function human(value) {
  return String(value || '').replaceAll('-', ' ')
}

defineExpose({ focusInput })
</script>

<style scoped>
.dispatch-bar {
  position: relative;
  flex: 0 0 auto;
  border-top: 1px solid var(--color-rule);
  background: var(--color-surface);
}

.dispatch-line {
  display: flex;
  min-height: 34px;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
}

.dispatch-prompt {
  color: var(--color-ink-4);
  font-family: var(--font-mono);
  font-size: 11px;
}

.dispatch-line input {
  width: 100%;
  min-width: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--color-ink);
  font-family: var(--font-mono);
  font-size: 11px;
}

.dispatch-line input::placeholder {
  color: var(--color-ink-4);
}

.dispatch-pulse {
  width: 7px;
  height: 7px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--color-accent);
  animation: dispatch-pulse 900ms ease-in-out infinite alternate;
}

.dispatch-runner,
.dispatch-queue,
.dispatch-nodes {
  flex: 0 0 auto;
  color: var(--color-ink-4);
  font-family: var(--font-mono);
  font-size: 9px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.dispatch-runner {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--color-accent);
}

.dispatch-runner i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-accent);
}

.dispatch-overlay {
  position: absolute;
  z-index: 80;
  right: 0;
  bottom: 34px;
  left: 0;
  border-top: 1px solid var(--color-rule);
  background: var(--color-surface);
  box-shadow: 0 -8px 24px color-mix(in srgb, var(--color-ink) 10%, transparent);
}

.dispatch-result {
  display: grid;
  width: 100%;
  min-height: 30px;
  grid-template-columns: 76px minmax(180px, 1fr) minmax(120px, 0.6fr);
  align-items: center;
  gap: 10px;
  border-bottom: 1px solid var(--color-rule-light);
  padding: 3px 12px;
  text-align: left;
}

.dispatch-result:hover,
.dispatch-result.selected {
  background: var(--color-chrome-mid);
}

.dispatch-result.selected {
  box-shadow: inset 0 0 0 1px var(--color-accent-soft);
}

.dispatch-result-kind {
  color: var(--color-ink-4);
  font-family: var(--font-mono);
  font-size: 9px;
}

.dispatch-result strong {
  overflow: hidden;
  color: var(--color-ink);
  font-family: var(--font-sans);
  font-size: 11px;
  font-weight: 560;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dispatch-result-context {
  overflow: hidden;
  color: var(--color-ink-3);
  font-family: var(--font-mono);
  font-size: 9px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dispatch-hint {
  padding: 5px 12px;
  color: var(--color-ink-4);
  font-family: var(--font-mono);
  font-size: 9px;
}

.dispatch-pack {
  padding: 8px 12px;
}

.dispatch-pack header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  color: var(--color-ink-4);
  font-family: var(--font-mono);
  font-size: 9px;
}

.dispatch-pack header strong {
  color: var(--color-ink-2);
  font-size: 10px;
}

.dispatch-pack pre {
  max-height: 180px;
  margin: 7px 0 4px;
  overflow-y: auto;
  border: 1px solid var(--color-rule-light);
  background: var(--color-chrome-high);
  padding: 8px 10px;
  color: var(--color-ink-3);
  font-family: var(--font-mono);
  font-size: 9px;
  line-height: 1.5;
  white-space: pre-wrap;
}

.dispatch-scrollback {
  padding: 4px 0;
}

.dispatch-scrollback p {
  display: flex;
  min-height: 22px;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 1px 12px;
}

.dispatch-scrollback code {
  overflow: hidden;
  color: var(--color-ink-4);
  font-family: var(--font-mono);
  font-size: 9px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dispatch-scrollback time {
  flex: 0 0 auto;
  color: var(--color-ink-4);
  font-family: var(--font-mono);
  font-size: 9px;
  font-variant-numeric: tabular-nums;
}

.dispatch-scrollback .echo-job code {
  color: var(--color-ink-2);
}

.dispatch-scrollback .echo-error code {
  color: var(--color-rem);
}

@keyframes dispatch-pulse {
  to {
    opacity: 0.35;
    transform: scale(0.8);
  }
}

@media (prefers-reduced-motion: reduce) {
  .dispatch-pulse {
    animation: none;
  }
}
</style>
