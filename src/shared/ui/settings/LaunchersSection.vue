<template>
  <div class="launchers-settings">
    <div class="flex items-start justify-between gap-4">
      <div>
        <div class="section-title">Launcher presets</div>
        <p class="mt-1 text-[10px] leading-relaxed text-ink-3">
          One click starts an exact argv array. No shell parsing, escaping, or hidden wrapper.
        </p>
      </div>
      <button
        type="button"
        class="launcher-button shrink-0"
        :disabled="busy"
        @click="addPreset"
      >
        <IconPlus :size="13" />
        Add
      </button>
    </div>

    <div class="mt-4 border-y border-rule-light py-2">
      <div class="flex min-w-0 items-center gap-2">
        <IconFileCode :size="13" class="shrink-0 text-ink-3" />
        <code class="min-w-0 flex-1 truncate font-mono text-[9px] text-ink-3">
          {{ launchers.configPath || '~/.mim/launchers.json' }}
        </code>
        <button
          type="button"
          class="launcher-icon-button"
          title="Reload launcher file"
          :disabled="busy"
          @click="reload"
        >
          <IconRefresh :size="13" />
        </button>
      </div>
      <p
        v-if="launchers.diagnostic"
        class="mt-2 border-l-2 border-accent px-2 text-[9px] leading-relaxed text-ink-2"
      >
        {{ launchers.diagnostic }}
      </p>
    </div>

    <div v-if="loading" class="grid min-h-32 place-items-center text-[10px] text-ink-3">
      Detecting local agents…
    </div>

    <div v-else class="mt-4 space-y-3">
      <article
        v-for="(preset, index) in draft"
        :key="preset.key"
        data-launcher-preset
        class="border border-rule bg-chrome-low"
      >
        <header class="flex h-9 items-center gap-2 border-b border-rule-light px-3">
          <span
            aria-hidden="true"
            class="size-1.5 rounded-full"
            :class="availabilityClass(preset)"
          />
          <strong class="min-w-0 flex-1 truncate text-[10px] font-semibold text-ink-2">
            {{ preset.title.trim() || 'Untitled launcher' }}
          </strong>
          <span class="font-mono text-[8px] uppercase tracking-[0.12em] text-ink-4">
            {{ availabilityLabel(preset) }}
          </span>
          <button
            type="button"
            class="launcher-icon-button text-rem"
            title="Remove launcher"
            @click="removePreset(index)"
          >
            <IconTrash :size="12" />
          </button>
        </header>

        <div class="grid gap-3 p-3 md:grid-cols-2">
          <label class="launcher-field">
            <span>Title</span>
            <input v-model="preset.title" type="text" autocomplete="off" />
          </label>
          <label class="launcher-field">
            <span>Stable id</span>
            <input
              v-model="preset.id"
              type="text"
              autocomplete="off"
              spellcheck="false"
              class="font-mono"
            />
          </label>

          <label class="launcher-field">
            <span>Kind</span>
            <select v-model="preset.kind" @change="changeKind(preset)">
              <option value="agent">Agent</option>
              <option value="terminal">Terminal</option>
            </select>
          </label>
          <label v-if="preset.kind === 'agent'" class="launcher-field">
            <span>Agent</span>
            <select v-model="preset.agentId">
              <option v-for="agent in launchers.agents" :key="agent.id" :value="agent.id">
                {{ agent.title }}{{ agent.installed ? '' : ' · not found' }}
              </option>
            </select>
          </label>

          <label class="launcher-field md:col-span-2">
            <span>Binary override</span>
            <input
              v-model="preset.binary"
              data-launcher-binary
              type="text"
              autocomplete="off"
              spellcheck="false"
              :placeholder="preset.kind === 'agent' ? 'Use detected agent binary' : 'Default login shell'"
              class="font-mono"
            />
          </label>

          <label class="launcher-field">
            <span>Working directory</span>
            <select v-model="preset.cwdMode">
              <option value="workspace">Current workspace</option>
              <option value="home">Home</option>
              <option value="custom">Custom path</option>
            </select>
          </label>
          <label v-if="preset.cwdMode === 'custom'" class="launcher-field">
            <span>Custom path</span>
            <input
              v-model="preset.cwdPath"
              type="text"
              autocomplete="off"
              spellcheck="false"
              placeholder="/absolute/path"
              class="font-mono"
            />
          </label>

          <label class="launcher-field md:col-span-2">
            <span>Arguments <em>one argv entry per line; JSON-quote empty or padded values</em></span>
            <textarea
              v-model="preset.argsText"
              data-launcher-args
              rows="3"
              spellcheck="false"
              placeholder="--model&#10;claude-sonnet-4-5"
              class="font-mono"
            />
          </label>
          <label class="launcher-field md:col-span-2">
            <span>Environment <em>KEY=value, one per line</em></span>
            <textarea
              v-model="preset.envText"
              data-launcher-env
              rows="2"
              spellcheck="false"
              placeholder="PI_OFFLINE=1"
              class="font-mono"
            />
          </label>
        </div>
      </article>

      <div
        v-if="!draft.length"
        class="grid min-h-32 place-items-center border border-dashed border-rule px-6 text-center"
      >
        <div>
          <p class="text-[11px] font-semibold text-ink-2">No launchers configured</p>
          <p class="mt-1 text-[9px] text-ink-3">Add an agent or terminal preset.</p>
        </div>
      </div>
    </div>

    <p v-if="error" role="alert" class="mt-3 text-[10px] leading-relaxed text-rem">
      {{ error }}
    </p>
    <p v-else-if="saved" role="status" class="mt-3 text-[10px] text-add">
      Launcher file saved. New launches use it immediately.
    </p>

    <footer class="sticky -bottom-6 mt-5 flex items-center justify-between border-t border-rule bg-surface py-3">
      <span class="text-[9px] text-ink-3">
        {{ dirty ? 'Unsaved launcher changes' : 'Launcher file is current' }}
      </span>
      <button
        type="button"
        data-launcher-save
        class="launcher-button launcher-button-primary"
        :disabled="busy || !dirty"
        @click="save"
      >
        <IconDeviceFloppy :size="13" />
        {{ saving ? 'Saving…' : 'Save launchers' }}
      </button>
    </footer>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import {
  IconDeviceFloppy,
  IconFileCode,
  IconPlus,
  IconRefresh,
  IconTrash,
} from '@tabler/icons-vue'
import { useLaunchersStore } from '../../../stores/launchers.js'

const launchers = useLaunchersStore()
const draft = ref([])
const baseline = ref('[]')
const loading = ref(false)
const saving = ref(false)
const saved = ref(false)
const error = ref('')
const busy = computed(() => loading.value || saving.value)
const serializedDraft = computed(() => JSON.stringify(toPresets(draft.value)))
const dirty = computed(() => serializedDraft.value !== baseline.value)

onMounted(reload)

async function reload() {
  loading.value = true
  error.value = ''
  saved.value = false
  try {
    await launchers.load()
    resetDraft(launchers.presets)
  } catch (cause) {
    error.value = errorMessage(cause)
  } finally {
    loading.value = false
  }
}

async function save() {
  error.value = ''
  saved.value = false
  try {
    const presets = toPresets(draft.value)
    validatePresets(presets)
    saving.value = true
    await launchers.save(presets)
    resetDraft(presets)
    saved.value = true
  } catch (cause) {
    error.value = errorMessage(cause)
  } finally {
    saving.value = false
  }
}

function addPreset() {
  const id = uniqueId('launcher')
  draft.value.push({
    key: crypto.randomUUID(),
    id,
    title: 'New launcher',
    kind: 'terminal',
    agentId: '',
    binary: '',
    argsText: '',
    envText: '',
    cwdMode: 'workspace',
    cwdPath: '',
  })
  saved.value = false
}

function removePreset(index) {
  draft.value.splice(index, 1)
  saved.value = false
}

function changeKind(preset) {
  if (preset.kind === 'agent' && !preset.agentId) {
    preset.agentId = launchers.agents[0]?.id || 'codex'
  }
}

function resetDraft(presets) {
  draft.value = (presets || []).map(toDraft)
  baseline.value = JSON.stringify(toPresets(draft.value))
}

function toDraft(preset) {
  return {
    key: crypto.randomUUID(),
    id: String(preset.id || ''),
    title: String(preset.title || ''),
    kind: preset.kind === 'agent' ? 'agent' : 'terminal',
    agentId: String(preset.agentId || ''),
    binary: String(preset.binary || ''),
    argsText: (preset.args || []).map(formatArgument).join('\n'),
    envText: Object.entries(preset.env || {}).map(([key, value]) => `${key}=${value}`).join('\n'),
    cwdMode: preset.cwd?.mode || 'workspace',
    cwdPath: preset.cwd?.path || '',
  }
}

function toPresets(rows) {
  return rows.map((row) => {
    const preset = {
      id: row.id.trim(),
      title: row.title.trim(),
      kind: row.kind,
      args: argumentLines(row.argsText),
      env: environment(row.envText),
      cwd: row.cwdMode === 'custom'
        ? { mode: 'custom', path: row.cwdPath.trim() }
        : { mode: row.cwdMode },
    }
    if (row.agentId && row.kind === 'agent') preset.agentId = row.agentId
    if (row.binary.trim()) preset.binary = row.binary.trim()
    return preset
  })
}

function validatePresets(presets) {
  const ids = new Set()
  for (const preset of presets) {
    if (!/^[a-z0-9_-]+$/.test(preset.id)) {
      throw new Error(`Launcher id '${preset.id || '(empty)'}' must use lowercase letters, digits, - or _.`)
    }
    if (ids.has(preset.id)) throw new Error(`Launcher id '${preset.id}' is duplicated.`)
    ids.add(preset.id)
    if (!preset.title) throw new Error(`Launcher '${preset.id}' needs a title.`)
    if (preset.kind === 'agent' && !preset.agentId) {
      throw new Error(`Agent launcher '${preset.id}' needs an agent.`)
    }
    if (preset.cwd.mode === 'custom' && !preset.cwd.path) {
      throw new Error(`Launcher '${preset.id}' needs a custom working directory.`)
    }
  }
}

function lines(value) {
  return String(value || '').split('\n').map(line => line.trim()).filter(Boolean)
}

function argumentLines(value) {
  return String(value || '')
    .split('\n')
    .filter(line => line.length > 0)
    .map((line) => {
      const candidate = line.trim()
      if (!candidate.startsWith('"')) return line
      let parsed
      try {
        parsed = JSON.parse(candidate)
      } catch {
        throw new Error(`Argument ${line} is not a valid JSON string.`)
      }
      if (typeof parsed !== 'string') throw new Error(`Argument ${line} must decode to a string.`)
      return parsed
    })
}

function environment(value) {
  return Object.fromEntries(String(value || '').split('\n').filter(line => line.trim()).map((line) => {
    const separator = line.indexOf('=')
    if (separator < 1) throw new Error(`Environment entry '${line}' must be KEY=value.`)
    return [line.slice(0, separator).trim(), line.slice(separator + 1)]
  }))
}

function formatArgument(value) {
  const argument = String(value)
  return argument === ''
    || argument.trim() !== argument
    || argument.includes('\n')
    || argument.startsWith('"')
    ? JSON.stringify(argument)
    : argument
}

function uniqueId(prefix) {
  const ids = new Set(draft.value.map(preset => preset.id))
  if (!ids.has(prefix)) return prefix
  let suffix = 2
  while (ids.has(`${prefix}-${suffix}`)) suffix += 1
  return `${prefix}-${suffix}`
}

function availabilityLabel(preset) {
  if (preset.kind !== 'agent') return 'Ready'
  const agent = launchers.agents.find(candidate => candidate.id === preset.agentId)
  return agent?.installed || preset.binary.trim() ? 'Ready' : 'Not found'
}

function availabilityClass(preset) {
  return availabilityLabel(preset) === 'Ready' ? 'bg-add' : 'bg-rem'
}

function errorMessage(cause) {
  return cause instanceof Error ? cause.message : String(cause || 'Launcher settings failed.')
}
</script>

<style scoped>
.launcher-button {
  display: inline-flex;
  height: 28px;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--color-rule);
  background: var(--color-chrome-mid);
  padding: 0 10px;
  font-family: var(--font-sans);
  font-size: 10px;
  font-weight: 600;
  color: var(--color-ink-2);
}
.launcher-button:hover:not(:disabled),
.launcher-icon-button:hover:not(:disabled) {
  background: var(--color-chrome);
  color: var(--color-ink);
}
.launcher-button:disabled,
.launcher-icon-button:disabled {
  opacity: 0.4;
}
.launcher-button-primary {
  border-color: var(--color-accent);
  background: var(--color-accent);
  color: white;
}
.launcher-button-primary:hover:not(:disabled) {
  background: var(--color-accent-hover);
  color: white;
}
.launcher-icon-button {
  display: grid;
  width: 24px;
  height: 24px;
  flex-shrink: 0;
  place-items: center;
  color: var(--color-ink-3);
}
.launcher-field {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 5px;
  font-family: var(--font-sans);
  font-size: 9px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--color-ink-3);
}
.launcher-field em {
  font-size: 8px;
  font-style: normal;
  font-weight: 400;
  letter-spacing: 0;
  text-transform: none;
}
.launcher-field input,
.launcher-field select,
.launcher-field textarea {
  width: 100%;
  border: 1px solid var(--color-rule-light);
  border-radius: 0;
  background: var(--color-surface);
  padding: 6px 8px;
  font-family: var(--font-sans);
  font-size: 10px;
  font-weight: 400;
  letter-spacing: 0;
  line-height: 1.45;
  text-transform: none;
  color: var(--color-ink);
  outline: none;
}
.launcher-field input,
.launcher-field select {
  height: 30px;
}
.launcher-field textarea {
  resize: vertical;
}
.launcher-field input:focus,
.launcher-field select:focus,
.launcher-field textarea:focus {
  border-color: var(--color-accent);
  box-shadow: inset 0 0 0 1px var(--color-accent-soft);
}
</style>
