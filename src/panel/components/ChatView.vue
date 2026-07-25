<template>
  <section class="chat-view" aria-label="Active chat">
    <div class="relative flex-1 overflow-hidden min-h-0">
      <div ref="scrollEl" class="absolute inset-0 overflow-y-auto px-10 pt-6.5 pb-32 flex flex-col gap-5.5 [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-rule [&::-webkit-scrollbar-thumb]:rounded-sm" @scroll="onScroll">

        <div class="chat-inner">
          <template v-for="(msg, idx) in chat.activeMessages" :key="msg.id">
            <ChatMessage
              :message="msg"
              :is-last-assistant="msg.role === 'assistant' && isLastAssistantIndex(idx)"
              @fork="onFork(idx)"
            />

          </template>

          <p v-if="chat.activeError" class="chat-error">{{ chat.activeError }}</p>
        </div>
      </div>

      <Transition name="jump-fade">
        <button v-if="showJumpBottom" class="jump-bottom absolute bottom-1.5 size-13 rounded-full flex items-center justify-center text-ink-3 bg-transparent hover:text-ink-2" title="Jump to bottom" @click="scrollToBottom(true)">
          <IconArrowBarToDown :size="22" />
        </button>
      </Transition>
    </div>

    <div class="chat-composer-wrap" ref="composerWrapRef">
      <ProposalActionBar
        v-if="hasPendingProposals"
        :proposals="session.proposals"
        @review="openBatchReview"
        @accept-all="acceptAllProposals"
        @reject-all="rejectAllProposals"
        @accept-file="applyProposal"
        @reject-file="rejectProposal"
        @open-file="reviewProposal"
        class="mb-0"
      />
      <Composer
        ref="composerRef"
        :model-id="session.modelId"
        :models="sessionStore.selectableModels"
        :control-id="control.id"
        :control-label="control.label"
        :control-options="control.options"
        :disabled="chat.isActiveBusy"
        :busy="chat.isActiveBusy"
        :can-send="chat.canSend"
        :cost-label="costLabel"
        :context-percent="contextPercent"
        :context-tokens="session.lastInputTokens || 0"
        :context-window="contextWindow"
        :show-usage-indicators="showUsageIndicators"
        :supports-vision="supportsVision"
        :skills="chatSkills"
        :project-files="projectFiles"
        :has-document="hasDocument"
        :document-name="documentName"
        :board-entries="boardEntries"
        @send="onSend"
        @attach="onAttach"
        @stop="chat.stopActiveSession()"
        @update:model-id="sessionStore.setSessionModel(session, $event)"
        @update:control-id="sessionStore.setSessionControl(session, $event)"
        @pick-skill="onPickSkill"
        @pick-project-file="onPickProjectFile"
        @pick-document="onPickDocument"
        @pick-board-entry="onPickBoardEntry"
      />
    </div>
    <div class="chat-below-row">
      <div class="chat-below-left">
        <span class="chat-project-name">
          <IconUser v-if="isSystemProject" :size="12" />
          <IconFolder v-else :size="12" />
          <span>{{ projectName }}</span>
        </span>
        <span v-if="isArchived" class="archived-indicator">
          <IconArchive :size="11" />
          <span>Archived</span>
        </span>
        <span v-if="session.skill" class="skill-chip">
          <IconBolt :size="11" />
          <span>{{ activeSkillName }}</span>
          <button class="skill-chip-x" @click="detachSkill"><IconX :size="9" /></button>
        </span>
        <div ref="approvalPickerRef" class="approval-picker">
          <button class="approval-trigger" :class="{ 'approval-trigger--danger': effectiveApprovalMode === 'bypass' }" @click="approvalMenuOpen = !approvalMenuOpen">
            <IconShield :size="11" />
            <span>{{ effectiveApprovalMode }}</span>
            <IconChevronDown :size="9" />
          </button>
          <div v-if="approvalMenuOpen" class="approval-menu">
            <button
              v-for="mode in approvalModes"
              :key="mode.id"
              class="approval-option"
              :class="{ selected: mode.id === effectiveApprovalMode, 'approval-danger': mode.id === 'bypass' }"
              @click="setApprovalMode(mode.id)"
            >
              <span class="approval-option-name">{{ mode.label }}</span>
              <span class="approval-option-desc">{{ mode.desc }}</span>
            </button>
          </div>
        </div>
      </div>
      <div class="chat-below-right">
        <button v-if="isArchived" class="chat-unarchive-btn" title="Unarchive this session (⌘⇧D)" @click="onUnarchive">
          <IconArchiveOff :size="11" />
          <span>Unarchive</span>
        </button>
        <button v-else-if="canMarkDone" class="chat-done-btn" title="Archive this session (⌘⇧D)" @click="onDone">
          <IconCheck :size="11" />
          <span>Done</span>
        </button>
      </div>
    </div>
  </section>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'

import { useSessionStore } from '../../stores/panel/sessions.js'
import { useProjectStore } from '../../stores/panel/projects.js'
import { useChatStore } from '../../stores/panel/chat.js'
import { useSettingsStore } from '../../stores/settings.js'
import { doneSession, unarchiveSession, forkFromMessage } from '../../stores/panel/actions.js'
import { countToolCalls, formatCost, sessionStatusKind } from '../../stores/panel/helpers.js'
import { pickAndReadAttachment } from '../../services/attachmentPicker.js'
import { IconArchive, IconArchiveOff, IconArrowBarToDown, IconBolt, IconCheck, IconFolder, IconUser, IconShield, IconChevronDown, IconX } from '@tabler/icons-vue'
import { useSkillsStore } from '../../stores/panel/skills.js'
import { useBoardStore } from '../../stores/panel/board.js'
import { usePanelUIStore } from '../../stores/panel/ui.js'
import ChatMessage from './ChatMessage.vue'
import ProposalActionBar from './ProposalActionBar.vue'
import Composer from './Composer.vue'

const sessionStore = useSessionStore()
const projStore = useProjectStore()
const chat = useChatStore()
const panelUI = usePanelUIStore()
const settingsStore = useSettingsStore()
const skillsStore = useSkillsStore()
const boardStore = useBoardStore()
const scrollEl = ref(null)
const composerRef = ref(null)
const composerWrapRef = ref(null)
const showJumpBottom = ref(false)
const userScrolledUp = ref(false)
const approvalMenuOpen = ref(false)
const approvalPickerRef = ref(null)

const session = computed(() => sessionStore.activeSession)
const toolCount = computed(() => countToolCalls(session.value))
const costLabel = computed(() => formatCost(session.value?.usage?.estimatedCost))
const control = computed(() => sessionStore.currentControl(session.value))

const supportsVision = computed(() => sessionStore.modelSupportsVision(session.value))
const concreteModel = computed(() => sessionStore.concreteModelForSession(session.value))
const contextWindow = computed(() => concreteModel.value?.contextWindow || 0)
const contextPercent = computed(() => {
  if (!contextWindow.value || !session.value?.lastInputTokens) return 0
  return Math.min(1, session.value.lastInputTokens / contextWindow.value)
})
const showUsageIndicators = computed(() => chat.activeMessages.length > 0)

const activeSkillName = computed(() => {
  if (!session.value?.skill) return ''
  const meta = skillsStore.getSkillMeta(session.value.skill)
  return meta?.name || session.value.skill
})

const chatSkills = computed(() =>
  skillsStore.enabledSkills.map(s => ({ id: s.id, name: s.name, desc: s.description }))
)

const projectFiles = computed(() =>
  projStore.projectFileIndex.map(f => ({ path: f, name: f.split('/').pop() }))
)

const boardEntries = computed(() =>
  boardStore.entries.map(e => ({ id: e.id, title: e.meta.title, type: e.meta.type, status: e.meta.status, tags: e.meta.tags || [] }))
)

const hasDocument = computed(() => {
  try { return Boolean(localStorage.getItem('mim:doc')) }
  catch { return false }
})

const documentName = computed(() => {
  try {
    const path = localStorage.getItem('mim:doc:path') || ''
    return path.split('/').pop() || 'Untitled'
  } catch { return 'Untitled' }
})

function onPickSkill(skill) {
  // Skill will be read from contextChips on send
}

async function onPickProjectFile(file) {
  if (composerRef.value?.attachments?.some(a => a.filename === file.name && a.type === 'text')) return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const project = projStore.projects.find(p => p.id === session.value?.projectId)
    const absPath = project?.workspacePath ? `${project.workspacePath}/${file.path}` : file.path
    const resp = await invoke('read_text_file', { path: absPath })
    composerRef.value?.addAttachment({
      filename: file.name,
      mediaType: 'text/plain',
      content: resp.content,
      type: 'text',
      size: new Blob([resp.content]).size,
    })
  } catch (e) {
    console.warn('Failed to read project file:', e)
  }
}

function onPickDocument() {
  // Content is resolved at send time — the context chip is the only visual indicator
}

async function onPickBoardEntry(entry) {
  const boardEntry = boardStore.entries.find(e => e.id === entry.id)
  if (!boardEntry) return
  if (composerRef.value?.attachments?.some(a => a._entryId === entry.id)) return
  const prefix = boardEntry.meta.type === 'issue' ? '@issues' : '@knowledge'
  const atPath = `${prefix}/${entry.id}.md`
  const content = `Path: ${atPath}\n# ${boardEntry.meta.title}\n\n${boardEntry.body || ''}`
  composerRef.value?.addAttachment({
    filename: `${entry.id}.md`,
    mediaType: 'text/markdown',
    content,
    type: 'text',
    size: content.length,
    _entryId: entry.id,
  })
}

function detachSkill() {
  if (session.value) session.value.skill = null
}

const isArchived = computed(() => Boolean(session.value?.archived))

const canMarkDone = computed(() => {
  const s = session.value
  if (!s || s.archived) return false
  const kind = sessionStatusKind(s)
  return kind !== 'ready' && kind !== 'working'
})

const activeProject = computed(() => sessionStore.activeProject)
const projectName = computed(() => activeProject.value?.name || 'Personal')
const isSystemProject = computed(() => activeProject.value?.system ?? true)

const approvalModes = [
  { id: 'strict', label: 'Strict', desc: 'Approve every tool use' },
  { id: 'normal', label: 'Normal', desc: 'Approve sensitive actions' },
  { id: 'bypass', label: 'Bypass Approval', desc: 'No approval prompts' },
]

const effectiveApprovalMode = computed(() => {
  const project = projStore.projects.find(p => p.id === session.value?.projectId)
  const projectMode = project?.approvalMode
  if (projectMode && projectMode !== 'default') return projectMode
  return settingsStore.aiApprovalMode || 'normal'
})

function setApprovalMode(mode) {
  const project = projStore.projects.find(p => p.id === session.value?.projectId)
  if (project) {
    project.approvalMode = mode
  } else {
    settingsStore.aiApprovalMode = mode
  }
  approvalMenuOpen.value = false
}

function onFork(idx) {
  if (session.value) forkFromMessage(session.value.id, idx)
}

function isLastAssistantIndex(idx) {
  const msgs = chat.activeMessages
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'assistant') return i === idx
  }
  return false
}

function scrollToBottom(smooth = false) {
  if (!scrollEl.value) return
  userScrolledUp.value = false
  scrollEl.value.scrollTo({ top: scrollEl.value.scrollHeight, behavior: smooth ? 'smooth' : 'instant' })
}

function isNearBottom() {
  if (!scrollEl.value) return true
  const { scrollTop, scrollHeight, clientHeight } = scrollEl.value
  return scrollHeight - scrollTop - clientHeight < 80
}

function onScroll() {
  if (!scrollEl.value) return
  const { scrollTop, scrollHeight, clientHeight } = scrollEl.value
  const distFromBottom = scrollHeight - scrollTop - clientHeight
  showJumpBottom.value = distFromBottom > 120
  userScrolledUp.value = distFromBottom > 80
}

watch(() => session.value?.id, () => {
  userScrolledUp.value = false
  nextTick(() => {
    scrollToBottom()
    consumePendingComposerPrefill()
    populateLinkedEntryChips()
  })
}, { immediate: true })

watch(() => chat._pendingComposerPrefill, () => {
  nextTick(() => consumePendingComposerPrefill())
})

watch(() => chat.activeMessages, () => {
  if (!userScrolledUp.value) nextTick(() => scrollToBottom())
}, { deep: true })

function onSend({ text, attachments }) {
  userScrolledUp.value = false
  const chips = composerRef.value?.contextChips || []
  const skillChip = chips.find(c => c.type === 'skill')
  if (skillChip && session.value) {
    session.value.skill = skillChip.id
  }
  const docChip = chips.find(c => c.type === 'document')
  if (docChip) {
    try {
      const content = localStorage.getItem('mim:doc') || ''
      if (content) {
        const name = documentName.value || 'document.md'
        attachments = [...attachments, { filename: name, mediaType: 'text/markdown', content, type: 'text', size: content.length }]
      }
    } catch { /* no document content */ }
  }
  const entryIds = (attachments || []).filter(a => a._entryId).map(a => a._entryId)
  if (entryIds.length && session.value) {
    if (!session.value.linkedEntries) session.value.linkedEntries = []
    for (const id of entryIds) {
      if (!session.value.linkedEntries.includes(id)) {
        session.value.linkedEntries.push(id)
      }
    }
  }
  chat.sendMessage(text, attachments)
  composerRef.value?.clearContextChips()
}

function consumePendingComposerPrefill() {
  if (!chat._pendingComposerPrefill || !composerRef.value) return
  composerRef.value.draft = chat._pendingComposerPrefill
  chat._pendingComposerPrefill = ''
  composerRef.value.focus()
}

async function populateLinkedEntryChips() {
  if (!session.value?.linkedEntries?.length) return
  if (chat.activeMessages.length > 0) return
  const composer = composerRef.value
  if (!composer) return
  const projectId = session.value.projectId
  if (projectId && !boardStore.entries.length) {
    await boardStore.loadBoard(projectId)
  }
  for (const entryId of session.value.linkedEntries) {
    const entry = boardStore.entries.find(e => e.id === entryId)
    if (!entry) continue
    composer.addContextChip({ type: 'board-entry', id: entryId, label: entry.meta.title, entryType: entry.meta.type })
    onPickBoardEntry({ id: entryId })
  }
}

async function onAttach(type) {
  const result = await pickAndReadAttachment(type)
  if (!result || result.error) return
  composerRef.value?.addAttachment(result)
}

function onDone() {
  doneSession()
}

function onUnarchive() {
  if (session.value) unarchiveSession(session.value.id)
}

function onChatKeydown(e) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'ArrowDown') {
    e.preventDefault()
    scrollToBottom(true)
  }
}

function onPointerDown(event) {
  if (approvalPickerRef.value && !approvalPickerRef.value.contains(event.target)) {
    approvalMenuOpen.value = false
  }
}
onMounted(() => {
  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('keydown', onChatKeydown)
  skillsStore.refreshSkills()
})
onUnmounted(() => {
  document.removeEventListener('pointerdown', onPointerDown, true)
  document.removeEventListener('keydown', onChatKeydown)
})

async function sendDiffOpen(invoke, payload) {
  for (let i = 0; i < 15; i++) {
    const result = await invoke('diff_open', { payload })
    if (result.delivered) return true
    await new Promise(r => setTimeout(r, 200))
  }
  return false
}

async function reviewProposal(proposal) {
  try {
    const { invoke } = await import('@tauri-apps/api/core')

    if (proposal.absolutePath && (proposal.type === 'edit' || proposal.type === 'create')) {
      let original = ''
      let modified = proposal.replacement || ''

      if (proposal.type === 'edit') {
        const resp = await invoke('read_text_file', { path: proposal.absolutePath })
        original = resp.content
        const { findTargetText } = await import('../../services/ai/tools/textMatch.js')
        const match = findTargetText(original, proposal.targetText)
        modified = match
          ? original.slice(0, match.from) + proposal.replacement + original.slice(match.to)
          : original
      }

      await sendDiffOpen(invoke, {
        id: proposal.id,
        path: proposal.absolutePath,
        original, modified,
        sessionId: session.value.id,
        targetText: proposal.targetText,
        replacement: proposal.replacement,
        proposalType: proposal.type,
      })
      return
    }

    await sendDiffOpen(invoke, {
      id: proposal.id,
      targetText: proposal.targetText,
      replacement: proposal.replacement,
      rationale: proposal.rationale || '',
      sessionId: session.value.id,
      path: proposal.path || 'current-document.md',
    })
  } catch (e) {
    console.warn('reviewProposal failed', e)
  }
}


const hasPendingProposals = computed(() =>
  session.value?.proposals?.some(p => p.status === 'pending') ?? false
)

async function acceptAllProposals() {
  const pending = session.value.proposals.filter(p => p.status === 'pending')
  await Promise.allSettled(pending.map(p => applyProposal(p)))
}

async function rejectProposal(proposal) {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('proposal_create', { proposal })
    await invoke('proposal_reject', { id: proposal.id })
  } catch {
    sessionStore.setProposalStatus(proposal, 'rejected')
  }
}

function rejectAllProposals() {
  for (const p of session.value.proposals) {
    if (p.status === 'pending') rejectProposal(p)
  }
}

async function openBatchReview() {
  const pending = session.value.proposals.filter(p => p.status === 'pending')
  if (pending.length === 0) return

  const distinctFiles = new Set(pending.map(p => p.absolutePath || p.path || 'document.md'))
  if (distinctFiles.size === 1) {
    return reviewProposal(pending[0])
  }

  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const { findTargetText } = await import('../../services/ai/tools/textMatch.js')

    const files = []
    for (const p of pending) {
      if (p.absolutePath && p.type === 'edit') {
        const resp = await invoke('read_text_file', { path: p.absolutePath })
        const match = findTargetText(resp.content, p.targetText)
        files.push({
          id: p.id, path: p.absolutePath,
          original: resp.content,
          modified: match
            ? resp.content.slice(0, match.from) + p.replacement + resp.content.slice(match.to)
            : resp.content,
        })
      } else if (p.absolutePath && p.type === 'create') {
        files.push({ id: p.id, path: p.absolutePath, original: '', modified: p.replacement || '' })
      } else {
        files.push({
          id: p.id, path: p.path || 'current-document.md',
          targetText: p.targetText, replacement: p.replacement,
        })
      }
    }
    await sendDiffOpen(invoke, { batch: true, sessionId: session.value.id, files })
  } catch (e) {
    console.warn('openBatchReview failed', e)
  }
}

async function applyProposal(proposal) {
  if (proposal.status === 'applying') return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('proposal_create', { proposal })
    await invoke('proposal_apply', { id: proposal.id })
  } catch (err) {
    sessionStore.setProposalStatus(proposal, 'failed', err?.message || 'Failed to apply change')
  }
}
</script>

<style scoped>
/* DO NOT ADD MORE CSS HERE, USE TAILWIND CLASSES; UNLESS ABSOLUTELY NECESSARY */
.chat-view {
  flex: 1; display: flex; flex-direction: column;
  min-width: 0; background: var(--color-chrome-high);
  overflow: hidden;
}

.chat-inner {
  max-width: 720px; width: 100%; margin: 0 auto;
  display: flex; flex-direction: column; gap: 22px;
}

.chat-error {
  padding: 8px 12px; border-radius: 6px;
  background: var(--color-accent-tint); color: var(--color-accent-2); font-size: 12px;
}

.jump-bottom { right: max(12px, calc(50% - 360px - 12px)); }
.jump-fade-enter-active, .jump-fade-leave-active { transition: opacity 0.2s ease; }
.jump-fade-enter-from, .jump-fade-leave-to { opacity: 0; }

.chat-below-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 4px 54px 12px;
  max-width: calc(720px + 80px); margin: 0 auto; width: 100%;
}
.chat-below-left, .chat-below-right { display: flex; align-items: center; gap: 2px; }
.chat-project-name {
  display: inline-flex; align-items: center; gap: 5px;
  font-family: var(--font-sans); font-size: 11px; color: var(--color-ink-3);
  padding: 2px 6px;
}
.approval-picker { position: relative; }
.approval-trigger {
  display: inline-flex; align-items: center; gap: 4px;
  font-family: var(--font-sans); font-size: 10.5px; color: var(--color-ink-3);
  padding: 2px 7px; border-radius: 4px;
  text-transform: capitalize;
}
.approval-trigger:hover { color: var(--color-ink-2); background: var(--color-chrome-high); }
.approval-menu {
  position: absolute; bottom: calc(100% + 4px); right: 0;
  background: var(--color-surface); border: 1px solid var(--color-rule); border-radius: 6px;
  padding: 4px; min-width: 180px; z-index: 20;
  box-shadow: 0 8px 30px rgba(0,0,0,.18);
}
.approval-option {
  display: flex; flex-direction: column; gap: 1px; width: 100%;
  padding: 6px 10px; border-radius: 4px; text-align: left;
}
.approval-option:hover { background: var(--color-chrome-high); }
.approval-option.selected { background: var(--color-accent-tint); }
.approval-option-name {
  font-family: var(--font-sans); font-size: 11.5px; font-weight: 500;
  color: var(--color-ink-2); text-transform: capitalize;
}
.approval-option.selected .approval-option-name { color: var(--color-accent); font-weight: 600; }
.approval-danger .approval-option-name { color: var(--color-rem); }
.approval-option.approval-danger.selected { background: color-mix(in srgb, var(--color-rem) 8%, transparent); }
.approval-option.approval-danger.selected .approval-option-name { color: var(--color-rem); }
.approval-trigger--danger { color: var(--color-rem); }
.approval-trigger--danger:hover { color: var(--color-rem); }
.approval-option-desc {
  font-family: var(--font-sans); font-size: 10px; color: var(--color-ink-3);
}
.chat-done-btn {
  display: inline-flex; align-items: center; gap: 4px;
  font-family: var(--font-sans); font-size: 10.5px; color: var(--color-ink-3);
  padding: 2px 7px; border-radius: 4px;
}
.chat-done-btn:hover { color: var(--color-ink-2); background: var(--color-chrome-mid); }
.chat-unarchive-btn {
  display: inline-flex; align-items: center; gap: 4px;
  font-family: var(--font-sans); font-size: 11px; font-weight: 500;
  color: var(--color-accent);
  padding: 2px 8px; border-radius: 4px;
}
.chat-unarchive-btn:hover { background: var(--color-accent-tint); }
.archived-indicator {
  display: inline-flex; align-items: center; gap: 4px;
  font-family: var(--font-sans); font-size: 10.5px; color: var(--color-ink-3);
}

/* Skill chip */
.skill-chip {
  display: inline-flex; align-items: center; gap: 4px;
  height: 20px; padding: 0 6px 0 7px;
  background: var(--color-chrome); border-radius: 4px;
  font-family: var(--font-sans); font-size: 11px; font-weight: 500;
  color: var(--color-ink-2);
}
.skill-chip-x {
  display: inline-flex; align-items: center; justify-content: center;
  width: 14px; height: 14px; border-radius: 3px;
  color: var(--color-ink-3);
}
.skill-chip-x:hover { background: var(--color-rule); color: var(--color-ink); }

.chat-composer-wrap { position: relative; }
</style>
