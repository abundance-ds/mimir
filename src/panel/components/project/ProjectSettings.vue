<template>
  <main class="ph-main">
    <div class="ph-scroll">
      <div class="ph-inner">
        <header class="ph-header">
          <h2 class="ph-title">{{ project.name }}</h2>
          <div v-if="project.workspacePath" class="ph-path">
            <span class="ph-path-text">{{ project.workspacePath }}</span>
            <button class="ph-path-btn" title="Open folder" @click="reveal">
              <IconFolderOpen :size="13" />
            </button>
          </div>
        </header>

        <!-- About -->
        <section class="ph-section">
          <label class="ph-label">About</label>
          <textarea
            v-model="description"
            class="ph-textarea ph-textarea--sans"
            placeholder="A short note about this project..."
            rows="2"
            autocorrect="off"
            autocapitalize="off"
            @blur="saveDescription"
          />
        </section>

        <!-- AI Instructions (AGENTS.md) -->
        <section class="ph-section">
          <label class="ph-label">AI Instructions</label>
          <template v-if="hasWorkspace">
            <p class="ph-hint">Sent to the AI at the start of every session in this project</p>
            <textarea
              v-model="systemPrompt"
              class="ph-textarea ph-textarea--mono"
              placeholder="Instructions the AI should follow in this project..."
              rows="4"
              autocorrect="off"
              autocapitalize="off"
              @blur="saveSystemPrompt"
            />
          </template>
          <p v-else class="ph-hint">Link a folder to set AI instructions</p>
        </section>

        <!-- Personal Instructions -->
        <section class="ph-section">
          <label class="ph-label">Personal Instructions</label>
          <template v-if="hasWorkspace">
            <p class="ph-hint">Private to you</p>
            <textarea
              v-model="instructions"
              class="ph-textarea ph-textarea--mono"
              placeholder="Your personal instructions for this project..."
              rows="4"
              autocorrect="off"
              autocapitalize="off"
              @blur="saveInstructions"
            />
          </template>
          <p v-else class="ph-hint">Link a folder to add personal instructions</p>
        </section>

        <!-- Permissions -->
        <ProjectPermissions :project-id="projectId" />

        <!-- Stats -->
        <section class="ph-section">
          <label class="ph-label">Stats</label>
          <div class="ph-stats">
            <span>{{ sessionCount }} session{{ sessionCount === 1 ? '' : 's' }}</span>
            <span v-if="totalCost">&middot; {{ totalCost }}</span>
            <span v-if="fileCount">&middot; {{ fileCount }} files</span>
            <span>&middot; Created {{ formatDate(project.createdAt) }}</span>
          </div>
        </section>

        <!-- Activity -->
        <ProjectActivity :project-id="projectId" />

        <!-- Danger Zone -->
        <section v-if="!project.system" class="ph-section ph-danger">
          <button class="ph-remove-btn" @click="handleRemove">
            <IconTrash :size="12" />
            Remove from Sidebar
          </button>
          <small class="ph-remove-hint">Sessions will be moved to General. The folder will not be deleted.</small>
        </section>
      </div>
    </div>
  </main>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useProjectStore } from '../../../stores/panel/projects.js'
import { useSessionStore } from '../../../stores/panel/sessions.js'
import { usePanelUIStore } from '../../../stores/panel/ui.js'
import { removeProject } from '../../../stores/panel/actions.js'
import { formatCost } from '../../../stores/panel/helpers.js'
import { schedulePersist } from '../../../stores/panel/persistence.js'
import { IconFolderOpen, IconTrash } from '@tabler/icons-vue'
import { useSkillsStore } from '../../../stores/panel/skills.js'
import ProjectPermissions from './ProjectPermissions.vue'
import ProjectActivity from './ProjectActivity.vue'

const isTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__

const props = defineProps({
  projectId: { type: String, required: true },
})



const projStore = useProjectStore()
const sessionStore = useSessionStore()
const panelUI = usePanelUIStore()
const skillsStore = useSkillsStore()

const description = ref('')
const systemPrompt = ref('')
const instructions = ref('')

const project = computed(() => projStore.projects.find(p => p.id === props.projectId) || {})
const hasWorkspace = computed(() => Boolean(project.value.workspacePath))

const sessionCount = computed(() => sessionStore.projectSessionCount(props.projectId))

const totalCost = computed(() => {
  const sessions = sessionStore.sessions.filter(s => !s.archived && s.projectId === props.projectId)
  const total = sessions.reduce((sum, s) => sum + (s.usage?.estimatedCost || 0), 0)
  if (total <= 0) return ''
  return formatCost(total)
})

const fileCount = computed(() => projStore.projectFileIndex?.length || 0)

// ---- Mount / persistence ----

onMounted(async () => {
  description.value = project.value.description || ''

  skillsStore.refreshSkills()

  if (!hasWorkspace.value || !isTauri) return

  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const basePath = project.value.workspacePath

    // Load project prompt (AGENTS.md)
    try {
      if (await invoke('path_exists', { path: `${basePath}/AGENTS.md` })) {
        const { content } = await invoke('read_text_file', { path: `${basePath}/AGENTS.md` })
        if (content) systemPrompt.value = content
      }
    } catch {}

    // Load personal instructions (~/.shoulders-v3/projects/{id}/instructions.md)
    try {
      const { projectDir } = await import('../../../services/dataDir')
      const personalPath = `${await projectDir(props.projectId)}/instructions.md`
      if (await invoke('path_exists', { path: personalPath })) {
        const { content } = await invoke('read_text_file', { path: personalPath })
        if (content) instructions.value = content
      }
    } catch {}
  } catch {}
})

function saveDescription() {
  const trimmed = description.value.trim()
  const proj = projStore.projects.find(p => p.id === props.projectId)
  if (proj) {
    proj.description = trimmed
    schedulePersist()
  }
}

async function saveSystemPrompt() {
  if (!hasWorkspace.value || !isTauri) return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const basePath = project.value.workspacePath
    await invoke('write_text_file', { path: `${basePath}/AGENTS.md`, content: systemPrompt.value })
  } catch (e) {
    console.warn('[ProjectSettings] Failed to save project prompt:', e)
  }
}

async function saveInstructions() {
  if (!isTauri) return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const { projectDir, ensureProject } = await import('../../../services/dataDir')
    await ensureProject(props.projectId)
    const personalPath = `${await projectDir(props.projectId)}/instructions.md`
    await invoke('write_text_file', { path: personalPath, content: instructions.value })
  } catch (e) {
    console.warn('[ProjectSettings] Failed to save personal instructions:', e)
  }
}

async function reveal() {
  if (!project.value.workspacePath || !isTauri) return
  try {
    const { open } = await import('@tauri-apps/plugin-shell')
    await open(project.value.workspacePath)
  } catch {}
}

async function handleRemove() {
  if (isTauri) {
    const { ask } = await import('@tauri-apps/plugin-dialog')
    const confirmed = await ask(
      `Remove "${project.value.name}" from the sidebar? Sessions will be moved to Personal. The folder will not be deleted.`,
      { title: 'Remove Project', kind: 'warning', okLabel: 'Remove', cancelLabel: 'Cancel' }
    )
    if (!confirmed) return
  } else if (!window.confirm(`Remove "${project.value.name}" from the sidebar?`)) {
    return
  }
  await removeProject(props.projectId)
  panelUI.closeProjectHome()
}

function formatDate(iso) {
  if (!iso) return '--'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
</script>

<style scoped>
.ph-main {
  position: relative;
  flex: 1; display: flex; flex-direction: column;
  min-width: 0; background: transparent;
  overflow: hidden;
}
.ph-scroll {
  flex: 1; overflow-y: auto; padding: 0 24px;
}
.ph-scroll::-webkit-scrollbar { width: 4px; }
.ph-scroll::-webkit-scrollbar-track { background: transparent; }
.ph-scroll::-webkit-scrollbar-thumb { background: var(--color-rule); border-radius: 2px; }

.ph-inner {
  max-width: 620px; width: 100%; margin: 0 auto;
  padding: 44px 0 40px; display: flex; flex-direction: column; gap: 0;
}

/* Header */
.ph-header {
  margin-bottom: 20px; padding: 0 2px;
}
.ph-title {
  font-family: var(--font-sans); font-size: 17px; font-weight: 400;
  color: var(--color-ink); margin: 0; line-height: 1.3;
}
.ph-path {
  display: flex; align-items: center; gap: 6px; margin-top: 4px;
}
.ph-path-text {
  font-family: var(--font-mono); font-size: 10px; color: var(--color-ink-3);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  direction: rtl; text-align: left; min-width: 0;
}
.ph-path-btn {
  width: 22px; height: 22px; border-radius: 4px; flex-shrink: 0;
  display: inline-flex; align-items: center; justify-content: center;
  color: var(--color-ink-3);
}
.ph-path-btn:hover { background: var(--color-chrome-high); color: var(--color-ink); }

/* Sections */
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

/* Textareas */
.ph-textarea {
  display: block; width: 100%; resize: vertical;
  padding: 8px 10px; border-radius: 6px;
  border: 1px solid var(--color-rule); background: var(--color-chrome-mid);
  color: var(--color-ink); font-size: 12px; line-height: 1.5;
  outline: none; min-height: 48px;
}
.ph-textarea:focus { border-color: var(--color-accent); }
.ph-textarea::placeholder { color: var(--color-ink-3); }
.ph-textarea--sans { font-family: var(--font-sans); }
.ph-textarea--mono { font-family: var(--font-mono); font-size: 11.5px; }

/* Stats */
.ph-stats {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  font-family: var(--font-mono); font-size: 11px; color: var(--color-ink-2);
}

/* Danger zone */
.ph-danger {
  margin-top: 8px; border-top: 1px solid var(--color-rule-light);
}
.ph-remove-btn {
  display: inline-flex; align-items: center; gap: 6px;
  font-family: var(--font-sans); font-size: 11px; font-weight: 500;
  color: var(--color-accent); padding: 0 10px; height: 28px; border-radius: 4px;
  border: 1px solid var(--color-accent); background: transparent;
}
.ph-remove-btn:hover { background: var(--color-accent-tint); }
.ph-remove-hint {
  display: block; margin-top: 6px;
  font-family: var(--font-sans); font-size: 10px; color: var(--color-ink-3);
}
</style>
