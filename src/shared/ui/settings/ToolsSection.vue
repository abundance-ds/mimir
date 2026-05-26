<template>
  <div>
    <!-- ─── Tool Access ─── -->
    <div class="section-title">Tool Access</div>

    <div class="setting-row">
      <div class="setting-label">
        Enable all tools
        <span class="setting-desc">Allow the AI to use all available tools</span>
      </div>
      <button
        class="toggle-switch"
        :class="{ 'toggle-on': !allDisabled }"
        @click="toggleAllTools"
      >
        <span class="toggle-knob"></span>
      </button>
    </div>

    <div
      v-for="cat in categories"
      :key="cat.id"
      class="tool-category"
    >
      <button class="tool-category-header" @click="toggleCategory(cat.id)">
        <div class="tool-category-left">
          <IconChevronRight
            :size="12"
            class="tool-chevron"
            :class="{ expanded: expanded[cat.id] }"
          />
          <span class="tool-category-name">{{ cat.label }}</span>
        </div>
        <span class="tool-badge">{{ enabledCount(cat) }}/{{ cat.tools.length }} enabled</span>
      </button>

      <div v-if="expanded[cat.id]" class="tool-category-body">
        <div
          v-for="(tool, i) in cat.tools"
          :key="tool.name"
          class="tool-row"
          :class="{ last: i === cat.tools.length - 1 }"
        >
          <div class="tool-info">
            <div class="setting-label">
              {{ tool.label }}
              <span class="setting-desc">{{ tool.description }}</span>
              <span v-if="tool.risk === 'high'" class="badge badge-muted">System</span>
              <span v-else-if="tool.risk === 'medium'" class="badge badge-muted">Edits files</span>
            </div>
            <div v-if="tool.risk === 'high'" class="tool-risk-note">Can execute any command on your computer.</div>
          </div>
          <button
            class="toggle-switch"
            :class="{ 'toggle-on': !isDisabled(tool.name) }"
            @click="toggleTool(tool.name)"
          >
            <span class="toggle-knob"></span>
          </button>
        </div>
      </div>
    </div>

    <!-- ─── Skills ─── -->
    <div class="section-title mt">Skills</div>

    <div v-if="!skillsStore.skills.length" class="wf-empty">
      <span class="wf-empty-label">No skills installed</span>
    </div>
    <div v-else class="wf-list">
      <div v-for="skill in skillsStore.skills" :key="skill.id" class="wf-row">
        <span class="wf-icon">⚡</span>
        <div class="wf-info">
          <span class="wf-name">{{ skill.name }}</span>
          <span class="wf-desc">{{ skill.description }}</span>
        </div>
        <button
          class="toggle-switch"
          :class="{ 'toggle-on': !isSkillDisabled(skill.id) }"
          @click="toggleSkill(skill.id)"
        >
          <span class="toggle-knob" />
        </button>
        <button class="wf-remove-btn" title="Remove skill" @click="confirmRemoveSkill(skill)">
          <IconTrash :size="13" />
        </button>
      </div>
    </div>
    <div class="wf-actions">
      <button class="wf-import-btn" @click="skillsStore.importSkill()">Import Folder</button>
      <button class="wf-import-btn" @click="skillsStore.importSkillFile()">Import File</button>
      <button class="wf-import-btn" @click="onCreateSkill">Create New</button>
    </div>

  </div>
</template>

<script setup>
import { reactive, computed, onMounted } from 'vue'
import { useSettingsStore } from '../../../stores/settings.js'
import { getToolCategories } from '../../../services/ai/tools/gate.js'
import { useSkillsStore } from '../../../stores/panel/skills.js'
import { IconChevronRight, IconTrash } from '@tabler/icons-vue'

const settings = useSettingsStore()
const skillsStore = useSkillsStore()

// ─── Tool categories ───

const categories = reactive([])
const expanded = reactive({})

function toggleCategory(id) {
  expanded[id] = !expanded[id]
}

function isDisabled(toolName) {
  return (settings.disabledTools || []).includes(toolName)
}

function enabledCount(cat) {
  return cat.tools.filter(t => !isDisabled(t.name)).length
}

function toggleTool(toolName) {
  const current = [...(settings.disabledTools || [])]
  const idx = current.indexOf(toolName)
  if (idx >= 0) {
    current.splice(idx, 1)
  } else {
    current.push(toolName)
  }
  settings.set('disabledTools', current)
}

const allDisabled = computed(() => {
  const allToolNames = categories.flatMap(c => c.tools.map(t => t.name))
  return allToolNames.length > 0 && allToolNames.every(name => isDisabled(name))
})

function toggleAllTools() {
  const allToolNames = categories.flatMap(c => c.tools.map(t => t.name))
  if (allDisabled.value) {
    settings.set('disabledTools', [])
  } else {
    settings.set('disabledTools', allToolNames)
  }
}

// ─── Skills ───

function isSkillDisabled(skillId) {
  return (settings.disabledSkills || []).includes(skillId)
}

function toggleSkill(skillId) {
  const current = [...(settings.disabledSkills || [])]
  const idx = current.indexOf(skillId)
  if (idx >= 0) current.splice(idx, 1)
  else current.push(skillId)
  settings.set('disabledSkills', current)
}

function confirmRemoveSkill(skill) {
  if (!confirm(`Remove skill "${skill.name}"?`)) return
  skillsStore.removeSkill(skill.id)
}

async function onCreateSkill() {
  const path = await skillsStore.createSkill()
  if (path) {
    try {
      const { openOrFocusEditorWindow } = await import('../../../panel/agentsWindow.js')
      openOrFocusEditorWindow(`${path}/SKILL.md`)
    } catch { /* not in panel context */ }
  }
}

// ─── Lifecycle ───

onMounted(() => {
  const cats = getToolCategories()
  categories.splice(0, categories.length, ...cats)
  skillsStore.refreshSkills()
})
</script>

<style scoped>
.mt {
  margin-top: 24px;
}

/* ─── Tool categories ─── */

.tool-category {
  border: 1px solid var(--color-rule-light);
  border-radius: 6px;
  margin-bottom: 8px;
  overflow: hidden;
}

.tool-category-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 10px 12px;
  border: none;
  background: none;
}
.tool-category-header:hover {
  background: var(--color-chrome-mid);
}

.tool-category-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.tool-chevron {
  color: var(--color-ink-3);
  transition: transform 150ms ease;
  flex-shrink: 0;
}
.tool-chevron.expanded {
  transform: rotate(90deg);
}

.tool-category-name {
  font-family: var(--font-sans);
  font-size: 11.5px;
  font-weight: 600;
  color: var(--color-ink-2);
}

.tool-badge {
  font-family: var(--font-mono);
  font-size: 9px;
  color: var(--color-ink-3);
  background: var(--color-chrome-mid);
  border-radius: 9999px;
  padding: 2px 8px;
  white-space: nowrap;
}

.tool-category-body {
  border-top: 1px solid var(--color-rule-light);
  padding: 0 12px;
}

.tool-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 9px 0;
  border-bottom: 1px solid var(--color-rule-light);
}
.tool-row.last {
  border-bottom: none;
}

.tool-info {
  flex: 1;
  min-width: 0;
}

.tool-row .setting-label {
  font-family: var(--font-mono);
  font-size: 11px;
}

.tool-risk-note {
  font-family: var(--font-sans);
  font-size: 9.5px;
  color: var(--color-ink-3);
  padding-left: 2px;
  margin-top: 2px;
  font-style: italic;
}

/* ─── Skills / list items ─── */

.wf-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 24px 0;
}

.wf-empty-label {
  font-family: var(--font-sans);
  font-size: 11px;
  color: var(--color-ink-3);
}

.wf-list {
  border: 1px solid var(--color-rule-light);
  border-radius: 6px;
  overflow: hidden;
}

.wf-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--color-rule-light);
  position: relative;
}
.wf-row:last-child {
  border-bottom: none;
}
.wf-row:hover .wf-remove-btn {
  opacity: 1;
}

.wf-icon {
  font-size: 16px;
  flex-shrink: 0;
  line-height: 1;
}

.wf-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.wf-name {
  font-family: var(--font-sans);
  font-size: 11.5px;
  font-weight: 600;
  color: var(--color-ink-2);
}

.wf-desc {
  font-family: var(--font-sans);
  font-size: 10px;
  color: var(--color-ink-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.wf-remove-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  background: none;
  color: var(--color-ink-3);
  border-radius: 4px;
  opacity: 0;
  flex-shrink: 0;
}
.wf-remove-btn:hover {
  color: #c55;
}

.wf-import-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: var(--font-sans);
  font-size: 11px;
  font-weight: 500;
  color: var(--color-ink-2);
  background: var(--color-chrome-mid);
  border: 1px solid var(--color-rule-light);
  border-radius: 6px;
  height: 30px;
  padding: 0 14px;
}
.wf-import-btn:hover {
  border-color: var(--color-rule);
}

.wf-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}

/* Toggle switch (shared for skills) */
.toggle-switch {
  position: relative; width: 34px; height: 20px; border-radius: 10px;
  background: var(--color-chrome); border: 1px solid var(--color-rule);
  transition: background 150ms, border-color 150ms;
  flex-shrink: 0; padding: 0;
}
.toggle-switch.toggle-on {
  background: var(--color-accent); border-color: var(--color-accent);
}
.toggle-knob {
  position: absolute; top: 2px; left: 2px; width: 14px; height: 14px;
  border-radius: 7px; background: white; transition: transform 150ms;
}
.toggle-on .toggle-knob { transform: translateX(14px); }
</style>
