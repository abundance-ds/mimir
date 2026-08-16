<template>
  <section class="font-sans text-ink" aria-label="Scope settings">
    <div>
      <h2 class="section-title mb-0">Information scopes</h2>
      <p class="mt-1 text-[10px] leading-relaxed text-ink-3">
        Three physical locations keep sharing legible for a small team. No account or policy setup is required.
      </p>
    </div>

    <div class="mt-5 divide-y divide-rule-light border-y border-rule-light">
      <div class="scope-row">
        <div class="scope-mark scope-private"><IconLock :size="13" /></div>
        <div class="min-w-0 flex-1">
          <div class="scope-title">Private</div>
          <p class="scope-copy">Local graph, skills, and agents for this machine.</p>
          <p class="scope-components">{{ componentLabel('private') }}</p>
        </div>
        <code class="scope-path">~/.mimir/private</code>
      </div>

      <div class="scope-row">
        <div class="scope-mark scope-project"><IconFolder :size="13" /></div>
        <div class="min-w-0 flex-1">
          <div class="scope-title">Project</div>
          <p class="scope-copy">Graph, skills, and agents that travel with the open repository.</p>
          <p class="scope-components">{{ componentLabel('project') }}</p>
        </div>
        <span class="scope-badge">automatic</span>
      </div>

      <div class="scope-row scope-row-team">
        <div class="scope-mark scope-team"><IconUsersGroup :size="13" /></div>
        <div class="min-w-0 flex-1">
          <div class="scope-title">Team</div>
          <p class="scope-copy">Optional Git folder for shared graph, skills, and agents.</p>
          <p class="scope-components">{{ componentLabel('team') }}</p>
          <div class="mt-3 flex min-w-0 items-center gap-1.5">
            <input
              v-model="teamRoot"
              data-graph-team-root
              class="scope-input"
              type="text"
              aria-label="Team folder"
              placeholder="/path/to/team"
              spellcheck="false"
              @change="save"
              @keydown.enter.prevent="save"
            />
            <button
              type="button"
              data-graph-team-choose
              class="scope-button"
              @click="choose"
            >
              <IconFolderOpen :size="13" />
              Choose
            </button>
            <button
              v-if="teamRoot"
              type="button"
              data-graph-team-clear
              class="scope-icon-button"
              title="Stop mounting the Team folder"
              aria-label="Stop mounting the Team folder"
              @click="clear"
            >
              <IconX :size="13" />
            </button>
          </div>
          <p class="mt-1.5 text-[9px] leading-relaxed text-ink-4">
            The folder can contain <code>graph/</code>, <code>skills/</code>, and <code>agents/</code>.
          </p>
        </div>
      </div>
    </div>

    <p v-if="notice" role="status" class="mt-3 text-[10px] text-add">{{ notice }}</p>
    <p v-if="error" role="alert" class="mt-3 text-[10px] text-rem">{{ error }}</p>
  </section>
</template>

<script setup>
import { onMounted, ref, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import {
  IconFolder,
  IconFolderOpen,
  IconLock,
  IconUsersGroup,
  IconX,
} from '@tabler/icons-vue'
import { useSettingsStore } from '../../../stores/settings.js'

const settings = useSettingsStore()
const teamRoot = ref(settings.mimirTeamFolder || '')
const inventory = ref([])
const notice = ref('')
const error = ref('')

watch(() => settings.mimirTeamFolder, (value) => {
  if (String(value || '') !== teamRoot.value) teamRoot.value = String(value || '')
})

async function save() {
  const path = teamRoot.value.trim()
  teamRoot.value = path
  settings.set('mimirTeamFolder', path)
  error.value = ''
  notice.value = path
    ? 'Team folder saved. Graph, skills, and agents now compose automatically.'
    : 'Team folder disabled. Private and Project remain available.'
  if (!await settings.flush()) {
    notice.value = ''
    error.value = 'Could not save the Team folder.'
    return
  }
  await refreshInventory()
}

async function choose() {
  error.value = ''
  try {
    const selection = await open({
      directory: true,
      multiple: false,
      title: 'Choose Team folder',
    })
    const path = Array.isArray(selection) ? selection[0] : selection
    if (!path) return
    teamRoot.value = typeof path === 'string' ? path : path.path
    await save()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  }
}

function clear() {
  teamRoot.value = ''
  void save()
}

function componentLabel(scope) {
  const entry = inventory.value.find(item => item.scope === scope)
  if (!entry?.mounted) return scope === 'team' ? 'not mounted' : 'empty'
  return entry.components?.length ? entry.components.join(' · ') : 'empty'
}

async function refreshInventory() {
  try {
    const value = await invoke('scope_inventory', {
      workspace: settings.mimirWorkspaceFolder || '.',
    })
    inventory.value = Array.isArray(value) ? value : []
  } catch { /* inventory is informative; the saved path remains authoritative */ }
}

onMounted(refreshInventory)
</script>

<style scoped>
.scope-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 0;
}

.scope-row-team {
  padding-bottom: 14px;
}

.scope-mark {
  display: grid;
  width: 25px;
  height: 25px;
  flex: 0 0 auto;
  place-items: center;
  border: 1px solid var(--color-rule-light);
  border-radius: 5px;
}

.scope-private {
  color: var(--color-ink-3);
  background: var(--color-chrome-mid);
}

.scope-project {
  color: var(--color-accent);
  background: var(--color-accent-soft);
}

.scope-team {
  color: var(--color-add);
  background: color-mix(in srgb, var(--color-add) 9%, transparent);
}

.scope-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--color-ink-2);
}

.scope-copy {
  margin-top: 2px;
  font-size: 9.5px;
  line-height: 1.45;
  color: var(--color-ink-3);
}

.scope-components {
  margin-top: 3px;
  font-family: var(--font-mono);
  font-size: 8px;
  color: var(--color-ink-4);
}

.scope-path {
  max-width: 160px;
  flex: 0 0 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: var(--font-mono);
  font-size: 8.5px;
  color: var(--color-ink-4);
  white-space: nowrap;
}

.scope-badge {
  flex: 0 0 auto;
  border: 1px solid var(--color-rule-light);
  border-radius: 999px;
  padding: 1px 6px;
  font-size: 8px;
  color: var(--color-ink-3);
}

.scope-input {
  min-width: 0;
  height: 28px;
  flex: 1 1 auto;
  border: 1px solid var(--color-rule);
  border-radius: 4px;
  background: var(--color-surface);
  padding: 0 8px;
  font-family: var(--font-mono);
  font-size: 9px;
  color: var(--color-ink-2);
}

.scope-input:focus-visible,
.scope-button:focus-visible,
.scope-icon-button:focus-visible {
  outline: 1px solid var(--color-accent);
  outline-offset: 1px;
}

.scope-button {
  display: inline-flex;
  height: 28px;
  flex: 0 0 auto;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--color-rule);
  border-radius: 4px;
  background: var(--color-chrome-mid);
  padding: 0 8px;
  font-size: 9px;
  color: var(--color-ink-2);
}

.scope-button:hover,
.scope-icon-button:hover {
  border-color: var(--color-accent);
  color: var(--color-accent);
}

.scope-icon-button {
  display: grid;
  width: 28px;
  height: 28px;
  flex: 0 0 auto;
  place-items: center;
  border: 1px solid var(--color-rule-light);
  border-radius: 4px;
  color: var(--color-ink-3);
}
</style>
