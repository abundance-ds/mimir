<template>
  <main class="ed-main">
    <div class="ed-scroll">
      <div class="ed-inner">
        <div class="ed-back-row">
          <button class="ed-back-btn" @click="$emit('close')">
            <IconArrowLeft :size="13" />
            {{ backLabel }}
          </button>
        </div>

        <header class="ed-header">
          <input
            ref="titleInput"
            v-model="title"
            class="ed-title"
            placeholder="Entry title..."
            autocorrect="off"
            autocapitalize="off"
            @blur="save"
            @keydown.enter.prevent="startBodyEdit"
          />
        </header>

        <div v-if="entry.meta.type === 'issue'" class="ed-props">
          <div ref="statusRowRef" class="ed-prop-pill" @click="statusMenuOpen = !statusMenuOpen">
            <span class="ed-status-dot" :class="'ed-status--' + status" />
            <span>{{ statusLabels[status] }}</span>
            <IconChevronDown :size="9" class="text-ink-3" />
            <div v-if="statusMenuOpen" class="ed-dropdown ed-dropdown--pill">
              <button
                v-for="s in statuses"
                :key="s"
                class="ed-dropdown-item"
                :class="s === status && 'is-active'"
                @click.stop="setStatus(s)"
              >
                <span class="ed-status-dot" :class="'ed-status--' + s" />
                {{ statusLabels[s] }}
              </button>
            </div>
          </div>
          <div ref="priorityRowRef" class="ed-prop-pill" @click="priorityMenuOpen = !priorityMenuOpen">
            <PriorityIcon :priority="priority" />
            <span>{{ priorityLabels[priority] }}</span>
            <IconChevronDown :size="9" class="text-ink-3" />
            <div v-if="priorityMenuOpen" class="ed-dropdown ed-dropdown--pill">
              <button
                v-for="p in priorities"
                :key="p"
                class="ed-dropdown-item"
                :class="p === priority && 'is-active'"
                @click.stop="setPriority(p)"
              >
                <PriorityIcon :priority="p" />
                {{ priorityLabels[p] }}
              </button>
            </div>
          </div>
          <div class="ed-prop-pill ed-prop-due">
            <input type="date" v-model="dueDate" class="ed-date-input" @change="save()" />
            <button v-if="dueDate" class="ed-date-clear" @click="clearDueDate">&times;</button>
          </div>
        </div>

        <section class="ed-section">
          <label class="ed-label">{{ entry.meta.type === 'knowledge' ? 'Content' : 'Description' }}</label>
          <textarea
            v-if="bodyEditing"
            ref="bodyTextarea"
            v-model="body"
            class="ed-body"
            placeholder="Write here..."
            autocorrect="off"
            autocapitalize="off"
            @input="autoGrow"
            @blur="finishBodyEdit"
            @keydown.escape.prevent="finishBodyEdit"
          />
          <div
            v-else
            class="ed-body-rendered"
            :class="{ 'ed-body-empty': !body }"
            @click="startBodyEdit"
          >
            <div v-if="body" class="ed-md" v-html="renderedBody" />
            <span v-else class="ed-body-placeholder">Write here...</span>
          </div>
        </section>

        <section class="ed-section">
          <label class="ed-label">Sessions</label>
          <div v-if="linkedSessions.length" class="ed-sessions">
            <button v-for="s in linkedSessions" :key="s.id" class="ed-session-row" @click="goToLinkedSession(s.id)">
              <span class="ed-session-dot" :class="s.archived && 'opacity-40'" />
              <span class="ed-session-label">{{ s.label }}</span>
              <span class="ed-session-time">{{ relativeTime(s.updatedAt) }}</span>
            </button>
          </div>
          <button class="ed-add-btn" @click="startLinkedSession">
            <IconPlus :size="11" />
            Start session
          </button>
        </section>

        <section v-if="entry.meta.type === 'issue' || sources.length" class="ed-section">
          <label class="ed-label">Sources</label>
          <div v-if="sources.length" class="ed-sources">
            <div v-for="(src, idx) in sources" :key="'src-' + idx" class="ed-source-row">
              <IconFileText :size="12" class="text-ink-3 shrink-0" />
              <span class="ed-source-name" @click="revealSource(src)">{{ src.label || src.path.split('/').pop() }}</span>
              <span class="ed-source-path">{{ shortenPath(src.path) }}</span>
              <button class="ed-source-x" @click="removeSource(idx)">&times;</button>
            </div>
          </div>
          <button class="ed-add-btn" @click="addSource">
            <IconPlus :size="11" />
            Add source
          </button>
        </section>

        <section v-if="deliverables.length" class="ed-section">
          <label class="ed-label">Deliverables</label>
          <div class="ed-sources">
            <div v-for="(d, idx) in deliverables" :key="'del-' + idx" class="ed-source-row">
              <IconFileText :size="12" class="text-ink-3 shrink-0" />
              <span class="ed-source-name" @click="revealSource(d)">{{ d.label || d.path.split('/').pop() }}</span>
              <span class="ed-source-path">{{ shortenPath(d.path) }}</span>
            </div>
          </div>
        </section>

        <section class="ed-section ed-danger">
          <button class="ed-remove-btn" @click="confirmDelete">
            <IconTrash :size="12" />
            Delete Entry
          </button>
          <small class="ed-remove-hint">This action cannot be undone.</small>
        </section>
      </div>
    </div>
  </main>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { marked } from 'marked'
import { IconChevronDown, IconArrowLeft, IconTrash, IconPlus, IconFileText } from '@tabler/icons-vue'
import PriorityIcon from './PriorityIcon.vue'
import { ISSUE_STATUSES, PRIORITIES, STATUS_LABELS, PRIORITY_LABELS } from '../../../services/board/loader.js'
import { useBoardStore } from '../../../stores/panel/board.js'
import { useSessionStore } from '../../../stores/panel/sessions.js'
import { selectSession, startProjectChat } from '../../../stores/panel/actions.js'

marked.setOptions({ breaks: true, gfm: true })

const props = defineProps({
  entry: { type: Object, required: true },
  backLabel: { type: String, default: 'Back' },
})

const emit = defineEmits(['close', 'save', 'delete'])

const boardStore = useBoardStore()
const sessionStore = useSessionStore()

const linkedSessions = computed(() =>
  sessionStore.sessions
    .filter(s => (s.linkedEntries || []).includes(props.entry.id))
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .slice(0, 10)
)

function relativeTime(iso) {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'yesterday'
  return `${days}d ago`
}

function goToLinkedSession(id) {
  selectSession(id)
}

async function startLinkedSession() {
  const projectId = boardStore.activeProjectId
  if (!projectId) return
  await startProjectChat(projectId, {
    label: props.entry.meta.title || 'New chat',
    linkedEntries: [props.entry.id],
  })
}

const statuses = ISSUE_STATUSES
const priorities = PRIORITIES
const statusLabels = STATUS_LABELS
const priorityLabels = PRIORITY_LABELS

const titleInput = ref(null)
const bodyTextarea = ref(null)
const statusRowRef = ref(null)
const priorityRowRef = ref(null)

const title = ref(props.entry.meta.title || '')
const status = ref(props.entry.meta.status || 'backlog')
const priority = ref(props.entry.meta.priority || 'normal')
const tags = ref([...(props.entry.meta.tags || [])])
const dueDate = ref(props.entry.meta.dueDate || '')
const body = ref(props.entry.body || '')
const sources = ref([...(props.entry.meta.sources || [])])

const statusMenuOpen = ref(false)
const priorityMenuOpen = ref(false)
const bodyEditing = ref(false)

const renderedBody = computed(() => body.value ? marked.parse(body.value) : '')
const deliverables = computed(() => props.entry.meta.deliverables || [])

watch(() => props.entry.id, () => {
  title.value = props.entry.meta.title || ''
  status.value = props.entry.meta.status || 'backlog'
  priority.value = props.entry.meta.priority || 'normal'
  tags.value = [...(props.entry.meta.tags || [])]
  dueDate.value = props.entry.meta.dueDate || ''
  body.value = props.entry.body || ''
  sources.value = [...(props.entry.meta.sources || [])]
  statusMenuOpen.value = false
  priorityMenuOpen.value = false
  bodyEditing.value = false
})

function startBodyEdit() {
  bodyEditing.value = true
  nextTick(() => {
    autoGrow()
    bodyTextarea.value?.focus()
  })
}

function finishBodyEdit() {
  bodyEditing.value = false
  save()
}

function setStatus(s) {
  status.value = s
  statusMenuOpen.value = false
  save()
}

function setPriority(p) {
  priority.value = p
  priorityMenuOpen.value = false
  save()
}

function clearDueDate() {
  dueDate.value = ''
  save()
}

function save() {
  const meta = { ...props.entry.meta, title: title.value, tags: [...tags.value] }
  if (props.entry.meta.type === 'issue') {
    meta.status = status.value
    meta.priority = priority.value
    meta.dueDate = dueDate.value || undefined
  }
  meta.sources = [...sources.value]
  emit('save', { entryId: props.entry.id, meta, body: body.value })
}

function confirmDelete() {
  emit('delete', props.entry.id)
}

function shortenPath(path) {
  if (!path) return ''
  const parts = path.split('/')
  return parts.length > 3 ? `.../${parts.slice(-2).join('/')}` : path
}

async function addSource() {
  try {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const selected = await open({ multiple: true, title: 'Select source files' })
    if (!selected) return
    const paths = Array.isArray(selected) ? selected : [selected]
    for (const raw of paths) {
      const path = typeof raw === 'string' ? raw : raw.path
      if (!sources.value.some(s => s.path === path)) {
        sources.value.push({ path })
      }
    }
    save()
  } catch {}
}

function removeSource(idx) {
  sources.value.splice(idx, 1)
  save()
}

async function revealSource(src) {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('reveal_in_finder', { path: src.path })
  } catch {}
}

function autoGrow() {
  const el = bodyTextarea.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = el.scrollHeight + 'px'
}

function onPointerDown(e) {
  if (statusMenuOpen.value && statusRowRef.value && !statusRowRef.value.contains(e.target)) {
    statusMenuOpen.value = false
  }
  if (priorityMenuOpen.value && priorityRowRef.value && !priorityRowRef.value.contains(e.target)) {
    priorityMenuOpen.value = false
  }
}

function onEscKey(e) {
  if (e.key === 'Escape') {
    if (bodyEditing.value) {
      return
    }
    if (statusMenuOpen.value || priorityMenuOpen.value) {
      statusMenuOpen.value = false
      priorityMenuOpen.value = false
    } else {
      emit('close')
    }
  }
}

onMounted(() => {
  document.addEventListener('keydown', onEscKey)
  document.addEventListener('pointerdown', onPointerDown)
  if (!title.value) nextTick(() => titleInput.value?.focus())
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onEscKey)
  document.removeEventListener('pointerdown', onPointerDown)
})
</script>

<style scoped>
.ed-main {
  position: relative;
  flex: 1; display: flex; flex-direction: column;
  min-width: 0; background: transparent;
  overflow: hidden;
}
.ed-scroll {
  flex: 1; overflow-y: auto; padding: 0 24px;
}
.ed-scroll::-webkit-scrollbar { width: 4px; }
.ed-scroll::-webkit-scrollbar-track { background: transparent; }
.ed-scroll::-webkit-scrollbar-thumb { background: var(--color-rule); border-radius: 2px; }
.ed-inner {
  max-width: 620px; width: 100%; margin: 0 auto;
  padding: 24px 0 40px; display: flex; flex-direction: column; gap: 0;
}

.ed-back-row { margin-bottom: 8px; padding: 0 2px; }
.ed-back-btn {
  display: inline-flex; align-items: center; gap: 5px;
  font-family: var(--font-sans); font-size: 11px; font-weight: 500;
  color: var(--color-ink-3);
  padding: 0 8px; height: 26px; border-radius: 4px;
}
.ed-back-btn:hover { background: var(--color-chrome-mid); color: var(--color-ink-2); }

.ed-header { margin-bottom: 4px; padding: 0 2px; }
.ed-title {
  display: block; width: 100%;
  background: transparent; border: none; outline: none;
  font-family: var(--font-sans); font-size: 18px; font-weight: 400;
  color: var(--color-ink); line-height: 1.3;
}
.ed-title::placeholder { color: var(--color-ink-3); }

.ed-section { padding: 14px 2px; border-top: 1px solid var(--color-rule-light); }
.ed-label {
  display: block;
  font-family: var(--font-sans); font-size: 11px; font-weight: 500;
  color: var(--color-ink-3); text-transform: uppercase; letter-spacing: 0.03em;
  margin-bottom: 6px;
}

/* Property pills */
.ed-props {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  padding: 8px 2px 4px; margin-bottom: 4px;
}
.ed-prop-pill {
  position: relative;
  display: inline-flex; align-items: center; gap: 5px;
  height: 26px; padding: 0 8px;
  border-radius: 4px; border: 1px solid var(--color-rule-light);
  font-family: var(--font-sans); font-size: 11px;
  color: var(--color-ink-2);
}
.ed-prop-pill:hover { background: var(--color-chrome-mid); }
.ed-dropdown--pill { left: 0; top: calc(100% + 4px); }

.ed-status-dot {
  width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
}
.ed-status--backlog { background: var(--color-ink-4); }
.ed-status--plan { background: var(--color-ink-3); }
.ed-status--in-progress { background: var(--color-accent); }
.ed-status--review { background: color-mix(in srgb, var(--color-accent) 60%, var(--color-ink-3)); }
.ed-status--done { background: var(--color-add); }

.ed-date-input {
  border: none; background: transparent; outline: none;
  font-family: var(--font-sans); font-size: 11px;
  color: var(--color-ink-2);
}
.ed-date-input::-webkit-calendar-picker-indicator { opacity: 0.4; }
.ed-date-clear {
  width: 16px; height: 16px; border-radius: 3px;
  display: flex; align-items: center; justify-content: center;
  font-size: 13px; color: var(--color-ink-3); line-height: 1;
}
.ed-date-clear:hover { background: var(--color-chrome-high); color: var(--color-ink-2); }

.ed-dropdown {
  position: absolute; z-index: 50;
  top: 100%; left: 0;
  min-width: 150px; padding: 4px;
  background: var(--color-surface);
  border: 1px solid var(--color-rule);
  border-radius: 6px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.18);
}
.ed-dropdown-item {
  display: flex; align-items: center; gap: 8px;
  width: 100%; height: 28px; padding: 0 8px;
  border-radius: 4px;
  color: var(--color-ink-2);
  font-family: var(--font-sans); font-size: 11.5px;
  text-align: left;
}
.ed-dropdown-item:hover { background: var(--color-chrome-mid); color: var(--color-ink); }
.ed-dropdown-item.is-active { background: var(--color-accent-soft); color: var(--color-accent); }

/* Body */
.ed-body {
  display: block; width: 100%; resize: none;
  padding: 0 2px; border: none; background: transparent;
  color: var(--color-ink); outline: none;
  font-family: var(--font-sans); font-size: 13px;
  line-height: 1.75; min-height: 80px;
  overflow: hidden;
}
.ed-body::placeholder { color: var(--color-ink-3); }

.ed-body-rendered {
  min-height: 60px; padding: 2px; border-radius: 4px;
  font-family: var(--font-sans); font-size: 13px; line-height: 1.75;
  color: var(--color-ink);
}
.ed-body-rendered:hover { background: var(--color-chrome-mid); }
.ed-body-empty { min-height: 40px; }
.ed-body-placeholder { color: var(--color-ink-3); font-style: italic; }

/* Rendered markdown */
.ed-md :deep(p) { margin: 0 0 8px; }
.ed-md :deep(p:last-child) { margin-bottom: 0; }
.ed-md :deep(ul), .ed-md :deep(ol) { margin: 4px 0 8px; padding-left: 20px; }
.ed-md :deep(li) { margin: 2px 0; }
.ed-md :deep(code) {
  background: var(--color-chrome-mid); padding: 1px 4px; border-radius: 3px;
  font-family: var(--font-mono); font-size: 0.9em;
}
.ed-md :deep(pre) {
  background: var(--color-chrome); padding: 10px 12px; border-radius: 6px;
  margin: 8px 0; overflow-x: auto;
}
.ed-md :deep(pre code) { background: none; padding: 0; }
.ed-md :deep(strong) { font-weight: 600; color: var(--color-ink); }
.ed-md :deep(em) { font-style: italic; }
.ed-md :deep(h1), .ed-md :deep(h2), .ed-md :deep(h3) {
  font-weight: 600; margin: 12px 0 4px; color: var(--color-ink);
}
.ed-md :deep(h1) { font-size: 15px; }
.ed-md :deep(h2) { font-size: 13.5px; }
.ed-md :deep(h3) { font-size: 12.5px; font-weight: 500; }
.ed-md :deep(blockquote) {
  border-left: 2px solid var(--color-rule); padding-left: 12px;
  margin: 8px 0; color: var(--color-ink-3); font-style: italic;
}
.ed-md :deep(hr) { border: none; border-top: 1px solid var(--color-rule-light); margin: 12px 0; }
.ed-md :deep(a) { color: var(--color-accent); }

/* Sessions */
.ed-sessions { display: flex; flex-direction: column; gap: 1px; margin-bottom: 8px; }
.ed-session-row {
  display: flex; align-items: center; gap: 8px;
  padding: 5px 6px; border-radius: 4px; width: 100%; text-align: left;
}
.ed-session-row:hover { background: var(--color-chrome-mid); }
.ed-session-dot {
  width: 5px; height: 5px; border-radius: 50%; flex-shrink: 0;
  background: var(--color-accent);
}
.ed-session-label {
  flex: 1; min-width: 0;
  font-family: var(--font-sans); font-size: 11.5px; color: var(--color-ink-2);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ed-session-time {
  flex-shrink: 0;
  font-family: var(--font-mono); font-size: 10px; color: var(--color-ink-3);
}

/* Sources & Deliverables */
.ed-sources { display: flex; flex-direction: column; gap: 1px; margin-bottom: 6px; }
.ed-source-row {
  display: flex; align-items: center; gap: 6px;
  padding: 4px 6px; border-radius: 4px;
}
.ed-source-row:hover { background: var(--color-chrome-mid); }
.ed-source-name {
  font-family: var(--font-sans); font-size: 11.5px; color: var(--color-ink-2);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ed-source-name:hover { color: var(--color-accent); }
.ed-source-path {
  flex: 1; min-width: 0;
  font-family: var(--font-mono); font-size: 10px; color: var(--color-ink-3);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ed-source-x {
  width: 16px; height: 16px; border-radius: 3px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  font-size: 13px; color: var(--color-ink-3); line-height: 1;
  opacity: 0;
}
.ed-source-row:hover .ed-source-x { opacity: 1; }
.ed-source-x:hover { background: var(--color-chrome-high); color: var(--color-ink-2); }

/* Add button */
.ed-add-btn {
  display: inline-flex; align-items: center; gap: 5px;
  font-family: var(--font-sans); font-size: 11px; font-weight: 500;
  color: var(--color-ink-3); padding: 0 8px; height: 26px; border-radius: 4px;
}
.ed-add-btn:hover { background: var(--color-chrome-mid); color: var(--color-ink-2); }

/* Danger zone */
.ed-danger { margin-top: 8px; border-top: 1px solid var(--color-rule-light); }
.ed-remove-btn {
  display: inline-flex; align-items: center; gap: 6px;
  font-family: var(--font-sans); font-size: 11px; font-weight: 500;
  color: var(--color-accent); padding: 0 10px; height: 28px; border-radius: 4px;
  border: 1px solid var(--color-accent); background: transparent;
}
.ed-remove-btn:hover { background: var(--color-accent-soft); }
.ed-remove-hint {
  display: block; margin-top: 6px;
  font-family: var(--font-sans); font-size: 10px; color: var(--color-ink-3);
}
</style>
