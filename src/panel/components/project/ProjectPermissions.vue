<template>
  <section class="ph-section">
    <label class="ph-label">Permissions</label>

    <!-- Approval mode -->
    <div class="ph-field">
      <span class="ph-field-label">Approval mode</span>
      <div class="ph-segmented">
        <button
          v-for="m in approvalModes"
          :key="m.value"
          class="ph-seg-btn"
          :class="{ active: effectiveApprovalMode === m.value, selected: projectApprovalMode === m.value, 'ph-seg-danger': m.value === 'bypass' }"
          @click="setApprovalMode(m.value)"
        >{{ m.label }}</button>
      </div>
      <p class="ph-hint ph-hint--inline">{{ approvalModeHint }}</p>
    </div>

    <!-- Tool access -->
    <div class="ph-field">
      <button class="ph-tool-header" @click="toolsExpanded = !toolsExpanded">
        <span class="ph-field-label">Tool access</span>
        <span class="ph-tool-count">{{ enabledToolCount }} / {{ totalToolCount }}</span>
        <IconChevronRight
          class="ph-chevron"
          :class="{ expanded: toolsExpanded }"
          :size="11"
        />
      </button>

      <div v-if="toolsExpanded" class="ph-tool-list">
        <div v-for="cat in toolCategories" :key="cat.id" class="ph-tool-cat">
          <button class="ph-tool-cat-header" @click="toggleCatExpanded(cat.id)">
            <span class="ph-tool-cat-name">{{ cat.label }}</span>
            <span v-if="catHasOverrides(cat)" class="ph-override-dot" />
            <span class="ph-tool-cat-count">{{ catEnabledCount(cat) }}/{{ cat.tools.length }}</span>
            <IconChevronRight
              class="ph-chevron"
              :class="{ expanded: catExpanded[cat.id] }"
              :size="10"
            />
          </button>
          <div v-if="catExpanded[cat.id]" class="ph-tool-cat-body">
            <div v-for="t in cat.tools" :key="t.name" class="ph-tool-row">
              <div class="ph-tool-info">
                <span class="ph-tool-name">{{ t.label }}</span>
                <span class="ph-tool-desc">{{ t.description }}</span>
              </div>
              <button
                class="toggle-switch"
                :class="{ 'toggle-on': isToolEnabled(t.name), 'toggle-global-off': isGloballyDisabled(t.name) }"
                :disabled="isGloballyDisabled(t.name)"
                :title="isGloballyDisabled(t.name) ? 'Disabled globally in Settings → Tools' : ''"
                @click="toggleTool(t.name)"
              >
                <span class="toggle-knob" />
              </button>
            </div>
          </div>
        </div>
        <button
          v-if="hasToolOverrides"
          class="ph-reset-btn"
          @click="resetToolOverrides"
        >Reset to global defaults</button>
      </div>
    </div>

    <!-- Skill access -->
    <div v-if="skillsStore.skills.length" class="ph-field">
      <span class="ph-field-label">Skill access</span>
      <div class="ph-tool-list">
        <div v-for="skill in skillsStore.skills" :key="skill.id" class="ph-tool-row">
          <div class="ph-tool-info">
            <span class="ph-tool-name">
              {{ skill.name }}
              <span v-if="isSkillOverridden(skill.id)" class="ph-override-dot" />
            </span>
            <span class="ph-tool-desc">{{ skill.description }}</span>
          </div>
          <button
            class="toggle-switch"
            :class="{ 'toggle-on': !isSkillDisabled(skill.id) }"
            @click="toggleProjectSkill(skill.id)"
          >
            <span class="toggle-knob" />
          </button>
        </div>
      </div>
    </div>

    <!-- Session approvals -->
    <div class="ph-field">
      <span class="ph-field-label">Session approvals</span>
      <div v-if="activeApprovals.length" class="ph-approvals">
        <div v-for="a in activeApprovals" :key="a.key" class="ph-approval-chip">
          <span class="ph-approval-text">{{ a.label }}</span>
          <button class="ph-approval-x" @click="revokeApproval(a)" title="Revoke">&times;</button>
        </div>
        <p class="ph-hint ph-hint--inline">Scoped to this session &middot; resets on session end</p>
      </div>
      <p v-else class="ph-hint ph-hint--inline">No active approvals</p>
    </div>
  </section>
</template>

<script setup>
import { ref, reactive, computed } from 'vue'
import { useProjectStore } from '../../../stores/panel/projects.js'
import { useSessionStore } from '../../../stores/panel/sessions.js'
import { useSettingsStore } from '../../../stores/settings.js'
import { useSkillsStore } from '../../../stores/panel/skills.js'
import { schedulePersist } from '../../../stores/panel/persistence.js'
import { getToolCategories, getSessionToolAllows, revokeSessionToolAllow } from '../../../services/ai/tools/gate.js'
import { getSessionPathAllows, revokeSessionPathAllow } from '../../../services/ai/tools/pathPermission.js'
import { IconChevronRight } from '@tabler/icons-vue'

const props = defineProps({
  projectId: { type: String, required: true },
})

const projStore = useProjectStore()
const sessionStore = useSessionStore()
const settingsStore = useSettingsStore()
const skillsStore = useSkillsStore()

const toolsExpanded = ref(false)
const catExpanded = reactive({})

const project = computed(() => projStore.projects.find(p => p.id === props.projectId) || {})

// ---- Approval mode ----

const approvalModes = [
  { value: 'default', label: 'Default' },
  { value: 'normal', label: 'Normal' },
  { value: 'strict', label: 'Strict' },
  { value: 'bypass', label: 'Bypass Approval' },
]

const projectApprovalMode = computed(() => project.value.approvalMode || 'default')

const effectiveApprovalMode = computed(() => {
  const pm = projectApprovalMode.value
  if (pm && pm !== 'default') return pm
  return settingsStore.aiApprovalMode || 'normal'
})

const approvalModeHint = computed(() => {
  const pm = projectApprovalMode.value
  if (pm === 'default' || !pm) return `Using global setting: ${capitalize(settingsStore.aiApprovalMode || 'normal')}`
  if (pm === 'strict') return 'Every tool call requires approval'
  if (pm === 'bypass') return 'No approval prompts — you are responsible'
  return 'Reads are silent, writes and shell ask once'
})

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1) }

function setApprovalMode(mode) {
  const proj = projStore.projects.find(p => p.id === props.projectId)
  if (!proj) return
  proj.approvalMode = mode
  schedulePersist()
}

// ---- Tool access ----

const toolCategories = computed(() => getToolCategories())

const projectDisabledTools = computed(() => {
  return Array.isArray(project.value.disabledTools) ? project.value.disabledTools : []
})

const allDisabled = computed(() => {
  const global = settingsStore.disabledTools || []
  return new Set([...global, ...projectDisabledTools.value])
})

const totalToolCount = computed(() =>
  toolCategories.value.reduce((sum, cat) => sum + cat.tools.length, 0),
)

const enabledToolCount = computed(() =>
  totalToolCount.value - allDisabled.value.size,
)

function isToolEnabled(toolName) {
  return !allDisabled.value.has(toolName)
}

function catEnabledCount(cat) {
  return cat.tools.filter(t => isToolEnabled(t.name)).length
}

function catHasOverrides(cat) {
  return cat.tools.some(t => projectDisabledTools.value.includes(t.name))
}

const hasToolOverrides = computed(() => projectDisabledTools.value.length > 0)

function isGloballyDisabled(toolName) {
  return (settingsStore.disabledTools || []).includes(toolName)
}

function toggleTool(toolName) {
  const proj = projStore.projects.find(p => p.id === props.projectId)
  if (!proj) return
  const arr = Array.isArray(proj.disabledTools) ? [...proj.disabledTools] : []
  const idx = arr.indexOf(toolName)
  if (idx >= 0) arr.splice(idx, 1)
  else arr.push(toolName)
  proj.disabledTools = arr
  schedulePersist()
}

function toggleCatExpanded(catId) {
  catExpanded[catId] = !catExpanded[catId]
}

function resetToolOverrides() {
  const proj = projStore.projects.find(p => p.id === props.projectId)
  if (!proj) return
  proj.disabledTools = []
  schedulePersist()
}

// ---- Skill access ----

const projectDisabledSkills = computed(() =>
  Array.isArray(project.value.disabledSkills) ? project.value.disabledSkills : []
)

const allDisabledSkills = computed(() => {
  const global = settingsStore.disabledSkills || []
  return new Set([...global, ...projectDisabledSkills.value])
})

function isSkillDisabled(skillId) {
  return allDisabledSkills.value.has(skillId)
}

function isSkillOverridden(skillId) {
  return projectDisabledSkills.value.includes(skillId)
}

function toggleProjectSkill(skillId) {
  const proj = projStore.projects.find(p => p.id === props.projectId)
  if (!proj) return
  const arr = Array.isArray(proj.disabledSkills) ? [...proj.disabledSkills] : []
  const idx = arr.indexOf(skillId)
  if (idx >= 0) arr.splice(idx, 1)
  else arr.push(skillId)
  proj.disabledSkills = arr
  schedulePersist()
}

// ---- Session approvals ----

const activeSession = computed(() => sessionStore.activeSession)

const activeApprovals = computed(() => {
  const items = []
  const sid = activeSession.value?.id
  for (const name of getSessionToolAllows()) {
    items.push({ type: 'tool', key: `tool:${name}`, label: name })
  }
  if (sid) {
    for (const dir of getSessionPathAllows(sid)) {
      items.push({ type: 'path', key: `path:${dir}`, label: dir, dir })
    }
  }
  return items
})

function revokeApproval(a) {
  if (a.type === 'tool') revokeSessionToolAllow(a.label)
  else if (a.type === 'path') revokeSessionPathAllow(activeSession.value?.id, a.dir)
}
</script>

<style scoped>
/* Permissions */
.ph-section {
  padding: 14px 2px; border-top: 1px solid var(--color-rule-light);
}
.ph-label {
  display: block;
  font-family: var(--font-sans); font-size: 11px; font-weight: 500;
  color: var(--color-ink-3); text-transform: uppercase; letter-spacing: 0.03em;
  margin-bottom: 6px;
}
.ph-hint {
  font-family: var(--font-mono); font-size: 10px; color: var(--color-ink-3);
  margin: 0 0 6px;
}
.ph-field {
  margin-bottom: 14px;
}
.ph-field:last-child { margin-bottom: 0; }
.ph-field-label {
  font-family: var(--font-sans); font-size: 11.5px; font-weight: 500;
  color: var(--color-ink-2); display: block; margin-bottom: 5px;
}
.ph-hint--inline {
  margin-top: 4px;
}

/* Segmented control */
.ph-segmented {
  display: inline-flex; border: 1px solid var(--color-rule); border-radius: 6px;
  overflow: hidden;
}
.ph-seg-btn {
  font-family: var(--font-sans); font-size: 10.5px; font-weight: 500;
  color: var(--color-ink-3); padding: 5px 12px;
  border-right: 1px solid var(--color-rule); background: var(--color-chrome-mid);
}
.ph-seg-btn:last-child { border-right: none; }
.ph-seg-btn:hover { background: var(--color-chrome-high); color: var(--color-ink-2); }
.ph-seg-btn.selected {
  background: var(--color-accent-soft); color: var(--color-accent); font-weight: 600;
}
.ph-seg-btn.active:not(.selected) {
  color: var(--color-ink-2);
}
.ph-seg-btn.ph-seg-danger { color: var(--color-rem); }
.ph-seg-btn.ph-seg-danger:hover { color: var(--color-rem); }
.ph-seg-btn.ph-seg-danger.selected { background: color-mix(in srgb, var(--color-rem) 8%, transparent); color: var(--color-rem); }

/* Tool access */
.ph-tool-header {
  display: flex; align-items: center; gap: 8px;
  width: 100%; padding: 0; background: none;
  margin-bottom: 2px;
}
.ph-tool-header:hover {
  background: var(--color-chrome-mid);
  border-radius: 3px;
}
.ph-tool-header .ph-field-label { margin-bottom: 0; }
.ph-tool-count {
  font-family: var(--font-mono); font-size: 9px; color: var(--color-ink-3);
  background: var(--color-chrome); padding: 1px 6px; border-radius: 100px;
  margin-left: auto;
}
.ph-chevron {
  color: var(--color-ink-3); transition: transform 150ms ease; flex-shrink: 0;
}
.ph-chevron.expanded { transform: rotate(90deg); }

.ph-tool-list {
  margin-top: 6px; border: 1px solid var(--color-rule-light); border-radius: 6px;
  overflow: hidden;
}
.ph-tool-cat {}
.ph-tool-cat + .ph-tool-cat { border-top: 1px solid var(--color-rule-light); }
.ph-tool-cat-header {
  display: flex; align-items: center; gap: 6px;
  width: 100%; padding: 7px 10px; background: var(--color-surface);
}
.ph-tool-cat-header:hover { background: var(--color-chrome-high); }
.ph-tool-cat-name {
  font-family: var(--font-sans); font-size: 10.5px; font-weight: 600; color: var(--color-ink-2);
}
.ph-override-dot {
  width: 5px; height: 5px; border-radius: 50%; background: var(--color-accent); flex-shrink: 0;
}
.ph-tool-cat-count {
  font-family: var(--font-mono); font-size: 9px; color: var(--color-ink-3); margin-left: auto;
}
.ph-tool-cat-body {
  border-top: 1px solid var(--color-rule-light);
}
.ph-tool-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 6px 10px 6px 18px;
  border-bottom: 1px solid var(--color-rule-light);
}
.ph-tool-row:last-child { border-bottom: none; }
.ph-tool-info {
  display: flex; flex-direction: column; gap: 1px; min-width: 0;
}
.ph-tool-name {
  font-family: var(--font-sans); font-size: 11px; color: var(--color-ink-2);
}
.ph-tool-desc {
  font-family: var(--font-sans); font-size: 9.5px; color: var(--color-ink-3);
}
.ph-reset-btn {
  display: block; width: 100%; padding: 6px 10px;
  font-family: var(--font-sans); font-size: 10px; color: var(--color-accent);
  background: var(--color-surface); border-top: 1px solid var(--color-rule-light);
  text-align: center;
}
.ph-reset-btn:hover { background: var(--color-accent-soft); }

/* Session approvals */
.ph-approvals {
  display: flex; flex-direction: column; gap: 4px;
}
.ph-approval-chip {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 8px; border-radius: 4px;
  background: var(--color-chrome); border: 1px solid var(--color-rule-light);
  font-family: var(--font-mono); font-size: 10.5px; color: var(--color-ink-2);
}
.ph-approval-text {
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ph-approval-x {
  flex-shrink: 0; width: 16px; height: 16px; border-radius: 3px;
  display: flex; align-items: center; justify-content: center;
  font-size: 13px; color: var(--color-ink-3);
  line-height: 1;
}
.ph-approval-x:hover { background: var(--color-chrome-high); color: var(--color-ink); }

/* Toggle switch (scoped) */
.ph-tool-row .toggle-switch {
  position: relative; width: 34px; height: 20px; border-radius: 10px;
  background: var(--color-chrome); border: 1px solid var(--color-rule);
  transition: background 150ms, border-color 150ms;
  flex-shrink: 0; padding: 0;
}
.ph-tool-row .toggle-switch.toggle-on {
  background: var(--color-accent); border-color: var(--color-accent);
}
.ph-tool-row .toggle-knob {
  position: absolute; top: 2px; left: 2px; width: 14px; height: 14px;
  border-radius: 7px; background: white; transition: transform 150ms;
}
.ph-tool-row .toggle-on .toggle-knob { transform: translateX(14px); }
.ph-tool-row .toggle-switch.toggle-global-off { opacity: 0.4; pointer-events: none; }
.ph-tool-row .toggle-switch:disabled { pointer-events: none; }
</style>
