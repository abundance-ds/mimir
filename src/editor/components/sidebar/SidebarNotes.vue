<template>
  <div class="flex flex-col flex-1 min-h-0">
    <div class="shrink-0 flex items-center gap-0.5 px-2.5 pt-2 pb-1.5">
      <template v-if="confirmingClearAll">
        <span class="font-sans text-[11px] text-ink-2">Remove all?</span>
        <div class="flex-1"></div>
        <button
          class="h-5 rounded px-1.5 font-sans text-[11px] font-medium text-rem hover:bg-rem/10"
          @click="doClearAll"
        >Remove</button>
        <button
          class="h-5 rounded px-1.5 font-sans text-[11px] text-ink-3 hover:bg-chrome-mid hover:text-ink"
          @click="confirmingClearAll = false"
        >Cancel</button>
      </template>
      <template v-else>
        <div class="flex-1"></div>
        <button
          v-if="commentsStore.comments.length > 0"
          class="flex size-5 items-center justify-center rounded-full text-ink-3 hover:bg-chrome-mid hover:text-ink"
          title="Remove all comments from file"
          @click="confirmingClearAll = true"
        ><IconEraser :size="13" /></button>
        <button
          class="flex size-5 items-center justify-center rounded-full text-[13px] leading-none text-ink-3 hover:bg-chrome-mid hover:text-ink disabled:opacity-30"
          :disabled="!hasEditorSelection"
          title="Add Comment (⇧⌘M)"
          @click="onAddClick"
        >+</button>
      </template>
    </div>

    <div ref="columnRef" class="flex-1 overflow-hidden relative" @click.self="commentsStore.setActiveComment(null)">
      <!-- Glass float -->
      <div
        v-if="openCount > 0"
        class="glass-card absolute bottom-3 left-3 right-3 z-50 rounded-lg px-3 py-3 backdrop-blur-xl"
        @click.stop
      >
        <div class="flex items-center mb-2">
          <button
            v-if="selectionMode"
            class="font-sans text-[10.5px] text-ink font-medium"
            @click="cancelSelection"
          >{{ selectedCount }} selected <span class="text-ink-3 ml-0.5">✕</span></button>
          <button
            v-else-if="openCount > 1"
            class="font-sans text-[10.5px] text-ink-3 hover:text-ink"
            @click="startSelectionWithOpen"
          >Select</button>
          <div class="flex-1"></div>
          <button
            ref="targetPickerRef"
            class="flex items-center gap-1 font-sans text-[10.5px] text-ink-3 hover:text-ink min-w-0 max-w-[50%]"
            @click="toggleTargetMenu"
          >
            <span class="truncate">{{ selectedTarget?.label || 'New session' }}</span>
            <IconChevronDown :size="8" class="shrink-0" />
          </button>
        </div>
        <button
          class="flex w-full h-[34px] items-center justify-center gap-1.5 rounded-[8px] bg-ink text-chrome-mid font-sans text-[12px] font-medium hover:bg-accent disabled:opacity-30"
          :disabled="submitDisabled"
          title="Send annotations to agent"
          @click="submitComments"
        >
          Send review
          <IconArrowUp :size="13" />
        </button>
      </div>
      <div v-if="filteredComments.length === 0" class="absolute inset-0 flex items-start justify-center pt-12">
        <span class="font-sans text-[12px] text-ink-3 leading-relaxed text-center px-6 py-8">
          Select text in the document to add a comment.
        </span>
      </div>

      <div ref="innerListRef" class="absolute w-full top-0 left-0 will-change-transform" :style="{ transform: `translateY(-${scrollTop}px)` }" @click.self="commentsStore.setActiveComment(null)">
        <div class="relative w-full" :style="{ height: (editorScrollInfo?.scrollHeight ?? 5000) + 'px' }" @click.self="commentsStore.setActiveComment(null)">
          <CommentCard
            v-for="comment in filteredComments"
            :key="comment.id"
            :ref="el => registerCard(el, comment.id)"
            :comment="comment"
            :active="comment.id === commentsStore.activeCommentId"
            :autoEdit="autoEditId === comment.id && !comment.text"
            :selectable="selectionMode"
            :selected="selectedIds.has(comment.id)"
            :style="{
              top: (positions[comment.id] ?? -9999) + 'px',
              opacity: positions[comment.id] !== undefined ? 1 : 0,
              zIndex: comment.id === commentsStore.activeCommentId ? 50 : 10,
            }"
            @click="selectionMode ? toggleSelect(comment.id) : commentsStore.setActiveComment(comment.id)"
            @toggle-select="toggleSelect"
            @add-reply="(id, text) => mutations.addReply?.(id, text)"
            @delete="onCommentDone"
            @update-text="(id, text) => mutations.updateText?.(id, text)"
            @update-reply="onUpdateReply"
            @delete-reply="onDeleteReply"
          />
        </div>
      </div>
    </div>

    <div class="h-[26px] shrink-0"></div>

    <Transition name="toast">
      <div
        v-if="undoToast"
        class="absolute bottom-8 left-2.5 right-2.5 z-[100] flex items-center gap-2 rounded-lg border border-rule-light bg-surface px-3 py-2"
        style="box-shadow: 0 4px 16px rgba(0,0,0,.1)"
      >
        <span class="font-sans text-[11.5px] text-ink-2">Comment removed</span>
        <div class="flex-1"></div>
        <button
          class="font-sans text-[11.5px] font-medium text-accent hover:text-ink"
          @click="onUndo"
        >Undo</button>
      </div>
    </Transition>

    <Teleport to="body">
      <template v-if="targetMenuOpen">
        <div class="fixed inset-0 z-[200]" @click="targetMenuOpen = false" @contextmenu.prevent="targetMenuOpen = false" />
        <div
          class="fixed z-[201] max-h-56 overflow-y-auto rounded-[6px] border border-rule bg-surface p-1"
          :style="targetMenuStyle"
          style="box-shadow: 0 8px 30px rgba(0,0,0,.18)"
        >
          <button
            v-for="target in targetOptions"
            :key="target.id"
            class="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left font-sans text-[11px] hover:bg-chrome-high"
            :class="target.id === selectedTargetId ? 'bg-accent-soft font-semibold text-ink' : 'text-ink-2'"
            @click="selectTarget(target.id)"
          >
            <IconPlus v-if="target.type === 'new'" :size="11" class="shrink-0 text-accent" />
            <span class="min-w-0 flex-1 truncate">{{ target.label }}</span>
            <IconCheck v-if="target.id === selectedTargetId" :size="12" class="shrink-0 text-accent" />
          </button>
        </div>
      </template>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, computed, watch, inject, onMounted, onUnmounted } from 'vue'
import { IconArrowUp, IconCheck, IconChevronDown, IconEraser, IconPlus } from '@tabler/icons-vue'
import CommentCard from './CommentCard.vue'
import { useCommentPositions } from '../../composables/useCommentPositions.js'
import { useCommentsStore } from '../../../stores/comments.js'

const commentsStore = useCommentsStore()
const editorSurfaceRef = inject('editorSurfaceRef')
const editorScrollInfo = inject('editorScrollInfo')
const editorGeometryVersion = inject('editorGeometryVersion')
const hasEditorSelection = inject('hasEditorSelection', ref(false))
const onAddComment = inject('onAddComment', () => {})
const mutations = inject('commentMutations', {})
const currentFilePath = inject('currentFilePath', ref(''))

const autoEditId = ref(null)
const columnRef = ref(null)
const innerListRef = ref(null)
const targetPickerRef = ref(null)
const selectionMode = ref(false)
const selectedIds = ref(new Set())
const targetOptions = ref([{ id: 'new:general', type: 'new', projectId: 'general', label: 'New session' }])
const selectedTargetId = ref('new:general')
const targetMenuOpen = ref(false)
const targetMenuStyle = ref({})
const confirmingClearAll = ref(false)
const undoToast = ref(false)
let undoTimer = null

const scrollTop = computed(() => editorScrollInfo.value?.scrollTop ?? 0)

const filteredComments = computed(() => {
  return [...commentsStore.comments].sort((a, b) => (a.contentFrom ?? a.range?.from ?? 0) - (b.contentFrom ?? b.range?.from ?? 0))
})

const openCount = computed(() => commentsStore.comments.length)
const selectedCount = computed(() => selectedIds.value.size)
const submitCount = computed(() => selectionMode.value ? selectedCount.value : openCount.value)
const commentsFilePath = computed(() => currentFilePath.value || '')
const submitDisabled = computed(() => submitCount.value === 0 || !selectedTarget.value)
const selectedTarget = computed(() => targetOptions.value.find(t => t.id === selectedTargetId.value) || targetOptions.value[0] || null)

const { positions, registerCardRef, recalculate } = useCommentPositions({
  comments: filteredComments,
  activeCommentId: computed(() => commentsStore.activeCommentId),
  editorSurfaceRef: editorSurfaceRef,
})

function registerCard(el, id) {
  const domEl = el?.$el || el
  registerCardRef(domEl, id)
}

watch(editorGeometryVersion, () => {
  requestAnimationFrame(recalculate)
})

function onWheel(e) {
  const view = editorSurfaceRef.value?.getView?.()
  if (!view) return
  view.scrollDOM.scrollTop += e.deltaY
  e.preventDefault()
}

onMounted(() => {
  columnRef.value?.addEventListener('wheel', onWheel, { passive: false })
  document.addEventListener('keydown', onDocumentKeydown)
})

onUnmounted(() => {
  columnRef.value?.removeEventListener('wheel', onWheel)
  document.removeEventListener('keydown', onDocumentKeydown)
  clearTimeout(undoTimer)
})

function onAddClick() {
  if (hasEditorSelection.value) onAddComment()
}

function doClearAll() {
  confirmingClearAll.value = false
  mutations.clearAll?.()
}

function onCommentDone(id) {
  if (autoEditId.value === id) autoEditId.value = null
  mutations.delete?.(id)
  showUndoToast()
}

function showUndoToast() {
  undoToast.value = true
  clearTimeout(undoTimer)
  undoTimer = setTimeout(() => { undoToast.value = false }, 4000)
}

async function onUndo() {
  undoToast.value = false
  clearTimeout(undoTimer)
  const view = editorSurfaceRef.value?.getView?.()
  if (view) {
    const { undo } = await import('@codemirror/commands')
    undo(view)
  }
}

function onUpdateReply(commentId, replyId, text) {
  mutations.updateReply?.(commentId, replyId, text)
}

function onDeleteReply(commentId, replyId) {
  mutations.deleteReply?.(commentId, replyId)
}

function toggleSelect(id) {
  const next = new Set(selectedIds.value)
  next.has(id) ? next.delete(id) : next.add(id)
  selectedIds.value = next
}

function cancelSelection() {
  selectionMode.value = false
  selectedIds.value = new Set()
}

function toggleTargetMenu() {
  targetMenuOpen.value = !targetMenuOpen.value
  if (targetMenuOpen.value) {
    refreshTargetOptions()
    const rect = targetPickerRef.value?.getBoundingClientRect()
    if (rect) {
      const right = window.innerWidth - rect.right
      targetMenuStyle.value = {
        right: `${Math.max(8, right)}px`,
        bottom: `${window.innerHeight - rect.top + 6}px`,
        minWidth: '180px',
        maxWidth: '240px',
      }
    }
  }
}

function selectTarget(id) {
  selectedTargetId.value = id
  targetMenuOpen.value = false
}

function onDocumentKeydown(e) {
  if (e.key === 'Escape') targetMenuOpen.value = false
}

function selectAllOpen() {
  selectedIds.value = new Set(filteredComments.value.map(c => c.id))
}

async function submitComments() {
  const selected = selectionMode.value
    ? filteredComments.value.filter(c => selectedIds.value.has(c.id))
    : [...commentsStore.comments]
  if (!selected.length || !selectedTarget.value) return

  const filePath = selected[0]?.filePath || commentsFilePath.value
  const view = editorSurfaceRef.value?.getView?.()

  const { submitReview } = await import('../../composables/useSubmitReview.js')
  await submitReview({
    filePath,
    editorView: view,
    comments: selected,
    target: serializeTarget(selectedTarget.value),
  })

  targetMenuOpen.value = false
  selectionMode.value = false
  selectedIds.value = new Set()
}

function startSelectionWithOpen() {
  selectionMode.value = true
  selectedIds.value = new Set()
  refreshTargetOptions()
}

function serializeTarget(target) {
  if (!target) return null
  if (target.type === 'session') {
    return { type: 'session', projectId: target.projectId, sessionId: target.sessionId }
  }
  return { type: 'new', projectId: target.projectId || 'general' }
}

function basename(path) {
  return (path || '').split('/').filter(Boolean).pop() || ''
}

function findProjectForFile(projects, filePath, dataDir) {
  if (!filePath) return null
  return projects
    .filter(p => {
      const projectPath = p.workspacePath || p.path
      const workspaceMatch = projectPath && projectPath.startsWith('/') && filePath.startsWith(`${projectPath}/`)
      const dataMatch = dataDir && filePath.startsWith(`${dataDir}/projects/${p.id}/`)
      return workspaceMatch || dataMatch
    })
    .sort((a, b) => ((b.workspacePath || b.path)?.length || 0) - ((a.workspacePath || a.path)?.length || 0))[0] || null
}

function targetIdForNew(projectId) {
  return `new:${projectId || 'general'}`
}

function targetIdForSession(projectId, sessionId) {
  return `session:${projectId || 'general'}:${sessionId}`
}

async function refreshTargetOptions() {
  const filePath = commentsFilePath.value
  const fallback = [{ id: 'new:general', type: 'new', projectId: 'general', label: 'New session' }]
  if (!window.__TAURI_INTERNALS__) {
    targetOptions.value = fallback
    selectedTargetId.value = fallback[0].id
    return
  }
  try {
    const { listProjects, listSessionMetas, getDataDir } = await import('../../../services/dataDir.js')
    const [projects, dataDir] = await Promise.all([listProjects(), getDataDir()])
    const matchedProject = findProjectForFile(projects, filePath, dataDir)
    const project = matchedProject || projects.find(p => p.id === 'general') || { id: 'general', name: 'Personal' }
    const projectName = project.name || basename(project.workspacePath || project.path) || 'Personal'

    const options = []
    options.push({
      id: targetIdForNew(project.id),
      type: 'new',
      projectId: project.id,
      label: 'New session',
    })

    const metas = await listSessionMetas(project.id)
    metas
      .filter(m => !m.archived)
      .slice(0, 8)
      .forEach((meta) => {
        options.push({
          id: targetIdForSession(project.id, meta.id),
          type: 'session',
          projectId: project.id,
          sessionId: meta.id,
          label: meta.label || 'Untitled',
        })
      })

    targetOptions.value = options.length ? options : fallback
    if (!targetOptions.value.some(t => t.id === selectedTargetId.value)) {
      selectedTargetId.value = targetOptions.value[0].id
    }
  } catch {
    targetOptions.value = fallback
    selectedTargetId.value = fallback[0].id
  }
}

watch(() => commentsStore.comments.length, (newLen, oldLen) => {
  if (newLen > oldLen) {
    const newest = commentsStore.comments[commentsStore.comments.length - 1]
    if (newest && !newest.text) {
      commentsStore.setActiveComment(newest.id)
      autoEditId.value = newest.id
    }
  }
})

watch(commentsFilePath, () => {
  refreshTargetOptions()
}, { immediate: true })
</script>

<style scoped>
.glass-card {
  background: color-mix(in srgb, var(--color-surface) 65%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-chrome-high) 50%, transparent);
  box-shadow: 0 8px 32px rgba(0,0,0,.12), inset 0 1px 0 color-mix(in srgb, var(--color-chrome-high) 40%, transparent);
}
.toast-enter-active, .toast-leave-active { transition: opacity .15s ease, transform .15s ease; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateY(4px); }
</style>
