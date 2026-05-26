<template>
  <div class="flex flex-col flex-1 min-h-0">
    <div class="flex-1 overflow-y-auto">
      <div class="max-w-[620px] mx-auto pt-4 pb-4 px-4">
        <!-- Search -->
        <div class="hv-search max-w-[320px] ml-auto">
          <IconSearch :size="12" class="text-ink-3 shrink-0" />
          <input
            v-model="search"
            type="search"
            placeholder="Search sessions..."
            class="flex-1 min-w-0 bg-transparent font-sans text-[11px] text-ink outline-none placeholder:text-ink-3"
            autocorrect="off"
            autocapitalize="off"
          />
        </div>
        <!-- Empty state -->
        <div v-if="activeSessions.length === 0 && archivedSessions.length === 0" class="flex items-center justify-center py-16">
          <div class="text-center">
            <p class="font-sans text-[11px] text-ink-3">No sessions yet</p>
            <p class="font-mono text-[10px] text-ink-3 mt-1">Sessions for this project will appear here.</p>
          </div>
        </div>

        <template v-else>
          <!-- Active sessions -->
          <div v-if="filteredActive.length > 0" class="flex flex-col gap-px">
            <button
              v-for="session in filteredActive"
              :key="session.id"
              class="hv-row group"
              @click="goToSession(session)"
            >
              <div class="flex-1 min-w-0">
                <div class="font-sans text-[12px] text-ink truncate">{{ session.label }}</div>
                <div class="font-mono text-[10px] text-ink-3 mt-0.5">{{ formatTime(session.updatedAt || session.createdAt) }}</div>
              </div>
              <span
                class="shrink-0 opacity-0 group-hover:opacity-100 text-ink-3 hover:text-ink-2 hover:bg-chrome-mid rounded p-1 transition-opacity"
                @click.stop="handleExport(session.id)"
              >
                <IconDownload :size="12" />
              </span>
              <span v-if="session.id === activeSessionId" class="font-mono text-[9px] text-accent shrink-0">active</span>
            </button>
          </div>

          <!-- Archived divider -->
          <div v-if="filteredArchived.length > 0 && filteredActive.length > 0" class="flex items-center gap-2 py-3 mt-2">
            <span class="font-sans text-[10px] text-ink-3 uppercase tracking-wide">Archived</span>
            <div class="flex-1 h-px bg-rule-light" />
          </div>

          <!-- Archived sessions (collapsed after INITIAL_SHOW) -->
          <div v-if="filteredArchived.length > 0" class="flex flex-col gap-px">
            <div
              v-for="session in visibleArchived"
              :key="session.id"
              class="hv-row hv-archived group"
              @click="viewArchived(session)"
            >
              <div class="flex-1 min-w-0">
                <div class="font-sans text-[12px] text-ink truncate">{{ session.label }}</div>
                <div class="font-mono text-[10px] text-ink-3 mt-0.5">{{ formatTime(session.updatedAt || session.createdAt) }}</div>
              </div>
              <span
                class="shrink-0 opacity-0 group-hover:opacity-100 text-ink-3 hover:text-ink-2 hover:bg-chrome-mid rounded p-1 transition-opacity"
                @click.stop="handleExportArchived(session)"
              >
                <IconDownload :size="12" />
              </span>
              <button
                class="shrink-0 font-sans text-[10px] text-ink-3 hover:text-accent hover:bg-accent-soft rounded px-2 h-5"
                @click.stop="restoreArchived(session)"
              >
                Restore
              </button>
            </div>

            <button
              v-if="filteredArchived.length > INITIAL_SHOW && !showAllArchived"
              class="font-sans text-[10.5px] text-ink-3 hover:text-ink-2 hover:bg-chrome-mid rounded px-3 py-2 mt-1 text-left"
              @click="showAllArchived = true"
            >
              Show {{ filteredArchived.length - INITIAL_SHOW }} more
            </button>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { IconSearch, IconDownload } from '@tabler/icons-vue'
import { useSessionStore } from '../../../stores/panel/sessions.js'
import { usePanelUIStore } from '../../../stores/panel/ui.js'
import * as actions from '../../../stores/panel/actions.js'

const sessionStore = useSessionStore()
const panelUI = usePanelUIStore()

const search = ref('')
const showAllArchived = ref(false)
const INITIAL_SHOW = 5

const projectId = computed(() => panelUI.projectHomeId)
const activeSessionId = computed(() => sessionStore.activeSessionId)

const activeSessions = computed(() =>
  sessionStore.sessions
    .filter(s => !s.archived && s.projectId === projectId.value)
    .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt)),
)

const archivedSessions = computed(() =>
  sessionStore.archivedMetas
    .filter(m => m.projectId === projectId.value)
    .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0)),
)

const filteredActive = computed(() => {
  if (!search.value.trim()) return activeSessions.value
  const q = search.value.toLowerCase()
  return activeSessions.value.filter(s => s.label?.toLowerCase().includes(q))
})

const filteredArchived = computed(() => {
  if (!search.value.trim()) return archivedSessions.value
  const q = search.value.toLowerCase()
  return archivedSessions.value.filter(s => s.label?.toLowerCase().includes(q))
})

const visibleArchived = computed(() => {
  if (showAllArchived.value || search.value.trim()) return filteredArchived.value
  return filteredArchived.value.slice(0, INITIAL_SHOW)
})

function formatTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const now = new Date()
  const diffMs = now - d
  const diffDays = Math.floor(diffMs / 86400000)
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return `${diffDays}d ago`
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

function goToSession(session) {
  actions.selectSession(session.id)
}

async function viewArchived(meta) {
  await actions.viewArchivedSession(meta.projectId, meta.id)
}

async function restoreArchived(meta) {
  await actions.restoreArchivedSession(meta.projectId, meta.id)
}

async function handleExport(sessionId) {
  await sessionStore.exportSession(sessionId)
}

async function handleExportArchived(meta) {
  await actions.viewArchivedSession(meta.projectId, meta.id)
  await sessionStore.exportSession(meta.id)
}
</script>

<style scoped>
.hv-search {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 10px;
  margin-bottom: 12px;
  border-radius: 6px;
  background: var(--color-chrome-mid);
  border: 1px solid var(--color-rule-light);
}
.hv-search:focus-within {
  border-color: var(--color-accent);
}

.hv-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 10px;
  border-radius: 6px;
  text-align: left;
}
.hv-row:hover {
  background: var(--color-chrome-mid);
}
.hv-archived {
  opacity: 0.6;
}
.hv-archived:hover {
  opacity: 0.85;
}
</style>
