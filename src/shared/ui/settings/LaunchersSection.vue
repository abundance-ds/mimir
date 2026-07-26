<template>
  <section class="flex flex-col font-sans text-ink" aria-label="CLI tools">
    <div class="mb-4 flex items-start justify-between gap-4">
      <div>
        <h2 class="section-title mb-0">Coding agents</h2>
        <p class="mt-1 text-[10px] leading-relaxed text-ink-3">
          Choose what appears in Launch. Custom flags are passed as exact arguments.
        </p>
      </div>
      <div class="relative shrink-0" data-launcher-add-root>
        <button
          ref="addButtonRef"
          type="button"
          data-launcher-add
          class="launcher-button"
          :aria-expanded="addMenuOpen"
          aria-haspopup="menu"
          :disabled="busy"
          @click="addMenuOpen = !addMenuOpen"
          @keydown.down.prevent="openAddMenu"
        >
          <IconPlus :size="13" />
          Add preset
          <IconChevronDown :size="11" />
        </button>
        <div
          v-if="addMenuOpen"
          data-launcher-add-menu
          role="menu"
          class="absolute right-0 top-8 z-20 w-52 border border-rule bg-surface p-1 shadow-lg"
          @keydown="onAddMenuKeydown"
        >
          <div class="px-2 pb-1 pt-1 font-sans text-[9px] font-semibold uppercase tracking-[0.12em] text-ink-4">
            Agent preset
          </div>
          <button
            v-for="agent in launchers.agents"
            :key="agent.id"
            type="button"
            data-launcher-add-option
            role="menuitem"
            class="launcher-menu-item"
            @click="addAgentPreset(agent)"
          >
            <component :is="iconForAgent(agent.id)" :size="14" :stroke-width="1.8" :monochrome="true" />
            <span class="min-w-0 flex-1 truncate">{{ agent.title }}</span>
            <span class="font-mono text-[8px] text-ink-4">{{ agent.installed ? 'detected' : 'not found' }}</span>
          </button>
          <div class="my-1 border-t border-rule-light" />
          <button
            type="button"
            data-launcher-add-option
            role="menuitem"
            class="launcher-menu-item"
            @click="addTerminalPreset"
          >
            <IconTerminal2 :size="14" :stroke-width="1.8" />
            <span>Terminal preset</span>
          </button>
        </div>
      </div>
    </div>

    <div v-if="loading" class="grid min-h-32 place-items-center text-[10px] text-ink-3">
      Detecting local CLI tools…
    </div>

    <template v-else>
      <LauncherGroup
        title="Agents"
        :rows="agentDrafts"
        :open-id="openId"
        :advanced-id="advancedId"
        :agents="launchers.agents"
        @toggle-open="toggleOpen"
        @toggle-advanced="toggleAdvanced"
        @toggle-enabled="toggleEnabled"
        @remove="removePreset"
      />

      <LauncherGroup
        v-if="terminalDrafts.length"
        class="mt-4"
        title="Terminals"
        :rows="terminalDrafts"
        :open-id="openId"
        :advanced-id="advancedId"
        :agents="launchers.agents"
        @toggle-open="toggleOpen"
        @toggle-advanced="toggleAdvanced"
        @toggle-enabled="toggleEnabled"
        @remove="removePreset"
      />

      <div
        v-if="!draft.length"
        class="grid min-h-28 place-items-center border border-dashed border-rule px-6 text-center"
      >
        <div>
          <p class="text-[11px] font-semibold text-ink-2">No CLI presets</p>
          <p class="mt-1 text-[9px] text-ink-3">Add Codex, Claude, Pi, or a terminal.</p>
        </div>
      </div>
    </template>

    <div class="mt-5 border-y border-rule-light py-2">
      <div class="flex min-w-0 items-center gap-2">
        <IconFileCode :size="13" class="shrink-0 text-ink-3" />
        <span class="text-[9px] text-ink-3">Configuration</span>
        <code class="min-w-0 flex-1 truncate text-right font-mono text-[9px] text-ink-4">
          {{ launchers.configPath || '~/.mim/launchers.json' }}
        </code>
        <button
          type="button"
          class="launcher-icon-button"
          title="Reload launcher configuration"
          aria-label="Reload launcher configuration"
          :disabled="busy"
          @click="reload({ confirmDirty: true })"
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

    <p v-if="error" role="alert" class="mt-3 text-[10px] leading-relaxed text-rem">
      {{ error }}
    </p>
    <p v-else-if="saved" role="status" class="mt-3 text-[10px] text-add">
      CLI presets saved. New launches use them immediately.
    </p>

    <footer
      v-if="dirty || saving"
      class="sticky -bottom-6 mt-4 flex items-center justify-between border-t border-rule bg-surface py-3"
    >
      <span class="text-[9px] text-ink-3">Unsaved CLI changes</span>
      <button
        type="button"
        data-launcher-save
        class="launcher-button launcher-button-primary"
        :disabled="busy || !dirty"
        @click="save"
      >
        <IconDeviceFloppy :size="13" />
        {{ saving ? 'Saving…' : 'Save changes' }}
      </button>
    </footer>
  </section>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import {
  IconChevronDown,
  IconDeviceFloppy,
  IconFileCode,
  IconMathPi,
  IconPlus,
  IconRefresh,
  IconRobot,
  IconTerminal2,
} from '@tabler/icons-vue'
import IconProviderAnthropic from '../../../shared/icons/IconProviderAnthropic.vue'
import IconProviderOpenAI from '../../../shared/icons/IconProviderOpenAI.vue'
import { useLaunchersStore } from '../../../stores/launchers.js'
import { formatLauncherFlags, parseLauncherFlags } from './launcherFlags.js'
import LauncherGroup from './LauncherGroup.vue'

const launchers = useLaunchersStore()
const draft = ref([])
const baseline = ref('[]')
const loading = ref(false)
const saving = ref(false)
const saved = ref(false)
const error = ref('')
const openId = ref('')
const advancedId = ref('')
const addMenuOpen = ref(false)
const addButtonRef = ref(null)
const busy = computed(() => loading.value || saving.value)
const dirty = computed(() => draftSignature(draft.value) !== baseline.value)
const agentDrafts = computed(() => draft.value.filter(preset => preset.kind === 'agent'))
const terminalDrafts = computed(() => draft.value.filter(preset => preset.kind === 'terminal'))

onMounted(() => {
  document.addEventListener('pointerdown', closeAddMenu)
  void reload()
})
onUnmounted(() => document.removeEventListener('pointerdown', closeAddMenu))

async function reload({ confirmDirty = false } = {}) {
  if (confirmDirty && dirty.value && !window.confirm('Discard unsaved CLI preset changes?')) return
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

function addAgentPreset(agent) {
  const id = uniqueId(agent.id)
  const sequence = draft.value.filter(preset => preset.agentId === agent.id).length + 1
  const row = toDraft({
    id,
    title: sequence === 1 ? agent.title : `${agent.title} ${sequence}`,
    kind: 'agent',
    agentId: agent.id,
    enabled: true,
    args: [],
    env: {},
    cwd: { mode: 'workspace' },
  })
  draft.value.push(row)
  addMenuOpen.value = false
  openId.value = row.key
}

function addTerminalPreset() {
  const id = uniqueId('terminal')
  const sequence = draft.value.filter(preset => preset.kind === 'terminal').length + 1
  const row = toDraft({
    id,
    title: sequence === 1 ? 'Terminal' : `Terminal ${sequence}`,
    kind: 'terminal',
    enabled: true,
    args: [],
    env: {},
    cwd: { mode: 'workspace' },
  })
  draft.value.push(row)
  addMenuOpen.value = false
  openId.value = row.key
}

function removePreset(key) {
  const index = draft.value.findIndex(preset => preset.key === key)
  if (index >= 0) draft.value.splice(index, 1)
  if (openId.value === key) openId.value = ''
  if (advancedId.value === key) advancedId.value = ''
}

function toggleOpen(key) {
  openId.value = openId.value === key ? '' : key
  if (openId.value !== key && advancedId.value === key) advancedId.value = ''
}

function toggleAdvanced(key) {
  advancedId.value = advancedId.value === key ? '' : key
}

function toggleEnabled(key, enabled) {
  const preset = draft.value.find(candidate => candidate.key === key)
  if (preset) preset.enabled = enabled
}

function resetDraft(presets) {
  draft.value = (presets || []).map(toDraft)
  baseline.value = draftSignature(draft.value)
  openId.value = ''
  advancedId.value = ''
}

function toDraft(preset) {
  return {
    key: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
    id: String(preset.id || ''),
    title: String(preset.title || ''),
    kind: preset.kind === 'agent' ? 'agent' : 'terminal',
    agentId: String(preset.agentId || ''),
    enabled: preset.enabled !== false,
    binary: String(preset.binary || ''),
    flagsText: formatLauncherFlags(preset.args || []),
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
      enabled: row.enabled !== false,
      args: parseLauncherFlags(row.flagsText),
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

function draftSignature(rows) {
  return JSON.stringify(rows.map(({ key, ...row }) => row))
}

function validatePresets(presets) {
  const ids = new Set()
  for (const preset of presets) {
    if (!/^[a-z0-9_-]+$/.test(preset.id)) {
      throw new Error(`Preset id '${preset.id || '(empty)'}' must use lowercase letters, digits, - or _.`)
    }
    if (ids.has(preset.id)) throw new Error(`Preset id '${preset.id}' is duplicated.`)
    ids.add(preset.id)
    if (!preset.title) throw new Error(`Preset '${preset.id}' needs a title.`)
    if (preset.kind === 'agent' && !preset.agentId) {
      throw new Error(`Agent preset '${preset.id}' needs an agent.`)
    }
    if (preset.cwd.mode === 'custom' && !preset.cwd.path) {
      throw new Error(`Preset '${preset.id}' needs a custom working directory.`)
    }
  }
}

function environment(value) {
  return Object.fromEntries(String(value || '').split('\n').filter(line => line.trim()).map((line) => {
    const separator = line.indexOf('=')
    if (separator < 1) throw new Error(`Environment entry '${line}' must be KEY=value.`)
    return [line.slice(0, separator).trim(), line.slice(separator + 1)]
  }))
}

function uniqueId(prefix) {
  const ids = new Set(draft.value.map(preset => preset.id))
  if (!ids.has(prefix)) return prefix
  let suffix = 2
  while (ids.has(`${prefix}-${suffix}`)) suffix += 1
  return `${prefix}-${suffix}`
}

function iconForAgent(agentId) {
  if (agentId === 'codex') return IconProviderOpenAI
  if (agentId === 'claude') return IconProviderAnthropic
  if (agentId === 'pi') return IconMathPi
  return IconRobot
}

function closeAddMenu(event) {
  if (event?.target?.closest?.('[data-launcher-add-root]')) return
  addMenuOpen.value = false
}

async function openAddMenu() {
  addMenuOpen.value = true
  await nextTick()
  document.querySelector('[data-launcher-add-menu] [data-launcher-add-option]')?.focus()
}

async function onAddMenuKeydown(event) {
  if (event.key === 'Escape') {
    addMenuOpen.value = false
    await nextTick()
    addButtonRef.value?.focus()
    return
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const items = Array.from(event.currentTarget.querySelectorAll('[data-launcher-add-option]'))
  let index = items.indexOf(document.activeElement)
  if (event.key === 'Home') index = 0
  else if (event.key === 'End') index = items.length - 1
  else index = (Math.max(index, 0) + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
  await nextTick()
  items[index]?.focus()
}

function errorMessage(cause) {
  return cause instanceof Error ? cause.message : String(cause || 'CLI tool settings failed.')
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
.launcher-menu-item {
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  text-align: left;
  font-size: 11px;
  color: var(--color-ink-2);
}
.launcher-menu-item:hover,
.launcher-menu-item:focus {
  background: var(--color-chrome-high);
  color: var(--color-ink);
  outline: none;
}
</style>
