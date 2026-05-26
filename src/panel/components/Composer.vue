<template>
  <div ref="wrapEl" class="composer-wrap">
    <div v-if="chat.isContextBlocked" class="budget-bar blocked">
      <IconAlertCircle :size="12" />
      <span>Conversation too long for this model. Start a new one to continue.</span>
    </div>
    <div v-else-if="chat.isBudgetBlocked" class="budget-bar blocked">
      <IconAlertCircle :size="12" />
      <span>Monthly budget reached. <button class="budget-link" @click="panelUI.showSettingsDialog = true">Adjust in Settings</button></span>
    </div>
    <div v-else-if="chat.isBudgetWarning" class="budget-bar warning">
      <IconAlertTriangle :size="12" />
      <span>Approaching monthly budget limit.</span>
    </div>
    <div class="composer" :class="{ 'drop-active': dropActive }">
      <Transition name="drop-fade">
        <div v-if="dropActive" class="drop-overlay absolute inset-0 z-10 flex items-center justify-center gap-1.5 rounded-[13px] font-sans text-xs font-medium text-accent pointer-events-none">
          <IconPlus :size="16" />
          <span>Drop to attach</span>
        </div>
      </Transition>
      <!-- Unified chip area: context chips + attachment chips -->
      <div v-if="contextChips.length || visibleAttachments.length" class="flex flex-wrap gap-1 mb-1.5">
        <!-- Context chips -->
        <span v-for="(chip, idx) in contextChips" :key="'ctx-' + chip.type + '-' + chip.id" class="inline-flex items-center gap-1 h-[22px] px-1.5 bg-chrome rounded font-sans text-[11px] text-ink-2">
          <IconBolt v-if="chip.type === 'skill'" :size="11" class="text-ink-3" />
          <IconFile v-else-if="chip.type === 'project-file'" :size="11" class="text-ink-3" />
          <IconFileText v-else-if="chip.type === 'document'" :size="11" class="text-ink-3" />
          <IconLayoutKanban v-else-if="chip.type === 'board-entry' && chip.entryType === 'issue'" :size="11" class="text-ink-3" />
          <IconBook v-else-if="chip.type === 'board-entry'" :size="11" class="text-ink-3" />
          <span class="max-w-[140px] overflow-hidden text-ellipsis whitespace-nowrap">{{ chip.label }}</span>
          <button class="inline-flex items-center justify-center w-3.5 h-3.5 rounded-[3px] text-[12px] leading-none text-ink-3 hover:bg-rule hover:text-ink" @click="removeContextChip(idx)">&times;</button>
        </span>
        <!-- Attachment chips (hide board-entry attachments already shown as context chips) -->
        <span v-for="(att, idx) in visibleAttachments" :key="'att-' + att._idx" class="inline-flex items-center gap-1 h-[22px] px-1.5 bg-chrome-high rounded font-sans text-[11px] text-ink-2">
          <IconPhoto v-if="isImageType(att.mediaType)" :size="11" />
          <IconFileText v-else :size="11" />
          <span class="max-w-[140px] overflow-hidden text-ellipsis whitespace-nowrap">{{ att.filename }}</span>
          <button class="inline-flex items-center justify-center w-3.5 h-3.5 rounded-[3px] text-[12px] leading-none text-ink-3 hover:bg-rule hover:text-ink" @click="removeAttachment(att._idx)">&times;</button>
        </span>
      </div>
      <div v-if="attachError" class="attach-error">{{ attachError }}</div>
      <textarea
        ref="inputEl"
        v-model="draft"
        class="composer-input"
        rows="1"
        placeholder="Ask anything. Use @ to mention skills or files"
        autocomplete="off"
        autocorrect="off"
        autocapitalize="off"
        spellcheck="false"
        :disabled="disabled"
        @keydown="onKeydown"
        @input="onInput"
        @click="updateCursor"
        @keyup="updateCursor"
      />
      <div class="composer-row">
        <div class="composer-left">
          <div ref="attachPickerRef" class="attach-picker">
            <button class="cmp-icon" title="Attach" @click="attachMenuOpen = !attachMenuOpen">
              <IconPlus :size="14" />
            </button>
            <div v-if="attachMenuOpen" class="bg-surface border border-rule rounded-[10px] shadow-[0_8px_30px_rgba(0,0,0,0.15)] absolute bottom-[calc(100%+4px)] left-0 min-w-[200px] z-20 p-1">
              <button v-if="supportsVision" class="flex items-center gap-2 w-full px-2.5 py-[7px] rounded-[6px] text-left font-sans text-xs text-ink hover:bg-chrome-high" @click="pickAttach('image')">
                <IconPhoto :size="13" class="text-ink-3" />
                <span>Image</span>
              </button>
              <button class="flex items-center gap-2 w-full px-2.5 py-[7px] rounded-[6px] text-left font-sans text-xs text-ink hover:bg-chrome-high" @click="pickAttach('file')">
                <IconFileText :size="13" class="text-ink-3" />
                <span>Attach file...</span>
              </button>
              <button class="flex items-center gap-2 w-full px-2.5 py-[7px] rounded-[6px] text-left font-sans text-xs text-ink hover:bg-chrome-high" :class="{ 'text-ink-3 pointer-events-none': !hasDocument }" @click="pickDocument">
                <IconFile :size="13" class="text-ink-3" />
                <span>Current document</span>
              </button>
              <template v-if="activeBoardEntries.length">
                <div class="border-t border-rule my-1"></div>
                <div class="text-[10px] font-semibold uppercase text-ink-3 px-2.5 py-1">Board</div>
                <button v-for="entry in activeBoardEntries" :key="'menu-board-' + entry.id" class="flex items-center gap-2 w-full px-2.5 py-[7px] rounded-[6px] text-left font-sans text-xs text-ink hover:bg-chrome-high" @click="pickBoardEntryFromMenu(entry)">
                  <IconLayoutKanban v-if="entry.type === 'issue'" :size="13" class="text-ink-3" />
                  <IconBook v-else :size="13" class="text-ink-3" />
                  <span class="truncate">{{ entry.title }}</span>
                </button>
              </template>
              <template v-if="skills.length">
                <div class="border-t border-rule my-1"></div>
                <div class="text-[10px] font-semibold uppercase text-ink-3 px-2.5 py-1">Skills</div>
                <button v-for="s in skills" :key="'menu-skill-' + s.id" class="flex items-center gap-2 w-full px-2.5 py-[7px] rounded-[6px] text-left font-sans text-xs text-ink hover:bg-chrome-high" @click="pickSkillFromMenu(s)">
                  <IconBolt :size="13" class="text-ink-3" />
                  <span>{{ s.name }}</span>
                </button>
              </template>
            </div>
          </div>
        </div>
        <div class="composer-right">
          <ContextDonut v-if="showUsageIndicators && contextPercent > 0" :percent="contextPercent" :token-count="contextTokens" :context-window="contextWindow" :cost-label="costLabel" :size="16" />
          <span v-else-if="showUsageIndicators && costLabel !== '$0.00'" class="composer-cost">{{ costLabel }}</span>
          <ModelPicker
            :model-id="modelId"
            :models="models"
            :disabled="disabled"
            @update:model-id="$emit('update:modelId', $event)"
          />
          <ControlPicker
            :control-id="controlId"
            :label="controlLabel"
            :options="controlOptions"
            :disabled="disabled || controlOptions.length === 0"
            @update:control-id="$emit('update:controlId', $event)"
          />
          <button
            v-if="busy"
            class="cmp-stop"
            type="button"
            @click="$emit('stop')"
          >
            <IconPlayerStop :size="13" />
          </button>
          <button
            v-else
            class="cmp-send"
            :disabled="!localCanSend"
            @click="send"
          >
            <IconArrowUp :size="14" />
          </button>
        </div>
      </div>
    </div>
  </div>
    <!-- @ dropdown — teleported to escape overflow:hidden ancestors -->
    <Teleport to="body">
      <div v-if="showAtDropdown" ref="atDropdownRef" class="fixed z-[9999] bg-surface border border-rule rounded-[10px] shadow-[0_8px_30px_rgba(0,0,0,0.15)] max-h-[340px] overflow-y-auto p-1" :style="atDropdownPos">
        <template v-if="atFilteredSkills.length">
          <div class="text-[10px] font-semibold uppercase text-ink-3 px-2.5 py-0.5">Skills</div>
          <button v-for="(s, i) in atFilteredSkills" :key="'at-skill-' + s.id" class="flex items-center gap-2 w-full px-2.5 py-[5px] rounded-[6px] text-left hover:bg-chrome-high" :class="{ 'bg-chrome-high': atHighlight === i }" @click="selectAtSkill(s)" @pointerenter="atHighlight = i">
            <span class="flex items-center text-ink-3"><IconBolt :size="13" /></span>
            <div class="flex-1 min-w-0">
              <div class="font-sans text-[12px] font-medium text-ink leading-tight">{{ s.name }}</div>
              <div class="font-sans text-[10.5px] text-ink-3 truncate">{{ s.desc }}</div>
            </div>
          </button>
        </template>
        <template v-if="atFilteredFiles.length">
          <div class="text-[10px] font-semibold uppercase text-ink-3 px-2.5 py-0.5" :class="{ 'mt-0.5': atFilteredSkills.length }">Files</div>
          <button v-for="(file, i) in atFilteredFiles" :key="'at-file-' + file.path" class="flex items-center gap-2 w-full px-2.5 py-[5px] rounded-[6px] text-left hover:bg-chrome-high" :class="{ 'bg-chrome-high': atHighlight === (atFilteredSkills.length + i) }" @click="selectAtFile(file)" @pointerenter="atHighlight = atFilteredSkills.length + i">
            <span class="flex items-center text-ink-3"><IconFileText :size="13" /></span>
            <div class="flex-1 min-w-0">
              <div class="font-sans text-[12px] font-medium text-ink leading-tight">{{ file.name }}</div>
              <div class="font-sans text-[10.5px] text-ink-3 truncate">{{ file.path }}</div>
            </div>
          </button>
        </template>
        <template v-if="atFilteredBoard.length">
          <div class="text-[10px] font-semibold uppercase text-ink-3 px-2.5 py-0.5" :class="{ 'mt-0.5': atFilteredSkills.length || atFilteredFiles.length }">Board</div>
          <button v-for="(entry, i) in atFilteredBoard" :key="'at-board-' + entry.id" class="flex items-center gap-2 w-full px-2.5 py-[5px] rounded-[6px] text-left hover:bg-chrome-high" :class="{ 'bg-chrome-high': atHighlight === (atFilteredSkills.length + atFilteredFiles.length + i) }" @click="selectAtBoardEntry(entry)" @pointerenter="atHighlight = atFilteredSkills.length + atFilteredFiles.length + i">
            <span class="flex items-center text-ink-3">
              <IconLayoutKanban v-if="entry.type === 'issue'" :size="13" />
              <IconBook v-else :size="13" />
            </span>
            <div class="flex-1 min-w-0">
              <div class="font-sans text-[12px] font-medium text-ink leading-tight">{{ entry.title }}</div>
              <div v-if="entry.status" class="font-sans text-[10.5px] text-ink-3 truncate">{{ entry.type }} · {{ entry.status }}</div>
              <div v-else class="font-sans text-[10.5px] text-ink-3 truncate">{{ entry.type }}</div>
            </div>
          </button>
        </template>
      </div>
    </Teleport>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'

import ModelPicker from './ModelPicker.vue'
import ControlPicker from './ControlPicker.vue'
import ContextDonut from './ContextDonut.vue'
import { usePanelUIStore } from '../../stores/panel/ui.js'
import { useChatStore } from '../../stores/panel/chat.js'
import { validateFileSize, isImageType, isTextType, mediaTypeFromFilename, toDataUrl } from '../../services/attachments.js'
import { IconAlertCircle, IconAlertTriangle, IconPlus, IconPlayerStop, IconArrowUp, IconPhoto, IconFileText, IconFile, IconBolt, IconLayoutKanban, IconBook } from '@tabler/icons-vue'

const panelUI = usePanelUIStore()
const chat = useChatStore()

const props = defineProps({
  modelId: String,
  models: { type: Array, default: () => [] },
  controlId: String,
  controlLabel: { type: String, default: 'Control' },
  controlOptions: { type: Array, default: () => [] },
  disabled: Boolean,
  busy: Boolean,
  canSend: Boolean,
  costLabel: { type: String, default: '$0.00' },
  contextPercent: { type: Number, default: 0 },
  contextTokens: { type: Number, default: 0 },
  contextWindow: { type: Number, default: 0 },
  showUsageIndicators: { type: Boolean, default: false },
  supportsVision: { type: Boolean, default: true },
  skills: { type: Array, default: () => [] },
  projectFiles: { type: Array, default: () => [] },
  hasDocument: { type: Boolean, default: false },
  documentName: { type: String, default: '' },
  boardEntries: { type: Array, default: () => [] },
})
const emit = defineEmits(['send', 'stop', 'update:modelId', 'update:controlId', 'attach', 'pick-skill', 'pick-project-file', 'pick-document', 'pick-board-entry'])

const draft = ref('')
const inputEl = ref(null)
const wrapEl = ref(null)
const attachments = ref([])
const attachError = ref('')
const attachMenuOpen = ref(false)
const attachPickerRef = ref(null)
const dropActive = ref(false)
const contextChips = ref([])

let errorTimer = null

const localCanSend = computed(() => {
  if (showAtDropdown.value) return false
  return props.canSend && (draft.value.trim().length > 0 || attachments.value.length > 0 || contextChips.value.length > 0)
})

const visibleAttachments = computed(() => {
  const boardChipIds = new Set(contextChips.value.filter(c => c.type === 'board-entry').map(c => c.id))
  return attachments.value
    .map((a, i) => ({ ...a, _idx: i }))
    .filter(a => !a._entryId || !boardChipIds.has(a._entryId))
})

// --- @ detection ---
const cursorPos = ref(0)
const atHighlight = ref(-1)
const atDropdownRef = ref(null)

function updateCursor() {
  cursorPos.value = inputEl.value?.selectionStart ?? 0
}

const atQuery = computed(() => {
  const text = draft.value
  const pos = cursorPos.value
  const before = text.slice(0, pos)
  const atIdx = before.lastIndexOf('@')
  if (atIdx < 0) return ''
  // The @ must be at start of text or preceded by whitespace
  if (atIdx > 0 && !/\s/.test(before[atIdx - 1])) return ''
  const query = before.slice(atIdx + 1)
  // If query contains whitespace or newline, it's not an active mention
  if (/\s/.test(query)) return ''
  return query.toLowerCase()
})

const atActive = computed(() => {
  const text = draft.value
  const pos = cursorPos.value
  const before = text.slice(0, pos)
  const atIdx = before.lastIndexOf('@')
  if (atIdx < 0) return false
  if (atIdx > 0 && !/\s/.test(before[atIdx - 1])) return false
  const query = before.slice(atIdx + 1)
  if (/\s/.test(query)) return false
  return true
})

const atFilteredSkills = computed(() => {
  if (!atActive.value) return []
  const q = atQuery.value
  if (!q) return props.skills.slice(0, 4)
  return props.skills.filter(s =>
    s.name.toLowerCase().includes(q) || (s.desc && s.desc.toLowerCase().includes(q))
  ).slice(0, 4)
})

const atFilteredFiles = computed(() => {
  if (!atActive.value) return []
  const q = atQuery.value
  if (!q) return props.projectFiles.slice(0, 8)
  return props.projectFiles
    .filter(f => f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q))
    .slice(0, 8)
})

const atFilteredBoard = computed(() => {
  if (!atActive.value) return []
  const q = atQuery.value
  const items = props.boardEntries
  if (!q) return items.slice(0, 6)
  return items.filter(e =>
    e.title.toLowerCase().includes(q) ||
    (e.tags || []).some(t => t.toLowerCase().includes(q))
  ).slice(0, 6)
})

const showAtDropdown = computed(() => {
  if (!atActive.value) return false
  return atFilteredSkills.value.length + atFilteredFiles.value.length + atFilteredBoard.value.length > 0
})

const atDropdownPos = ref({})

function updateAtDropdownPos() {
  if (!wrapEl.value) return
  const rect = wrapEl.value.getBoundingClientRect()
  atDropdownPos.value = {
    left: rect.left + 'px',
    width: rect.width + 'px',
    bottom: (window.innerHeight - rect.top + 6) + 'px',
  }
}

// Reset highlight when dropdown opens/closes or results change
watch(showAtDropdown, (val) => {
  if (val) nextTick(updateAtDropdownPos)
  if (!val) atHighlight.value = -1
})

watch(atHighlight, (idx) => {
  if (idx < 0 || !atDropdownRef.value) return
  nextTick(() => {
    const items = atDropdownRef.value?.querySelectorAll('button')
    items?.[idx]?.scrollIntoView({ block: 'nearest' })
  })
})

function selectAtItem(type, item) {
  // Find the @ position and remove @query from draft
  const text = draft.value
  const pos = cursorPos.value
  const before = text.slice(0, pos)
  const atIdx = before.lastIndexOf('@')
  if (atIdx >= 0) {
    draft.value = text.slice(0, atIdx) + text.slice(pos)
    nextTick(() => {
      const newPos = atIdx
      inputEl.value?.setSelectionRange(newPos, newPos)
      cursorPos.value = newPos
      autoResize()
    })
  }

  if (type === 'skill') {
    const existing = contextChips.value.findIndex(c => c.type === 'skill')
    const chip = { type: 'skill', id: item.id, label: item.name }
    if (existing >= 0) contextChips.value.splice(existing, 1, chip)
    else contextChips.value.push(chip)
    emit('pick-skill', item)
  } else if (type === 'file') {
    if (!contextChips.value.some(c => c.type === 'project-file' && c.id === item.path)) {
      contextChips.value.push({ type: 'project-file', id: item.path, label: item.name })
    }
    emit('pick-project-file', item)
  } else if (type === 'board-entry') {
    if (!contextChips.value.some(c => c.type === 'board-entry' && c.id === item.id)) {
      contextChips.value.push({ type: 'board-entry', id: item.id, label: item.title, entryType: item.type })
    }
    emit('pick-board-entry', item)
  }

  inputEl.value?.focus()
}

function selectAtSkill(skill) { selectAtItem('skill', skill) }
function selectAtFile(file) { selectAtItem('file', file) }
function selectAtBoardEntry(entry) { selectAtItem('board-entry', entry) }

const activeBoardEntries = computed(() =>
  props.boardEntries.filter(e => e.status !== 'done').slice(0, 5)
)

// --- + menu actions ---
function pickBoardEntryFromMenu(entry) {
  attachMenuOpen.value = false
  if (!contextChips.value.some(c => c.type === 'board-entry' && c.id === entry.id)) {
    contextChips.value.push({ type: 'board-entry', id: entry.id, label: entry.title, entryType: entry.type })
  }
  emit('pick-board-entry', entry)
  inputEl.value?.focus()
}

function pickSkillFromMenu(skill) {
  attachMenuOpen.value = false
  const existing = contextChips.value.findIndex(c => c.type === 'skill')
  const chip = { type: 'skill', id: skill.id, label: skill.name }
  if (existing >= 0) {
    contextChips.value.splice(existing, 1, chip)
  } else {
    contextChips.value.push(chip)
  }
  emit('pick-skill', skill)
  inputEl.value?.focus()
}

function pickDocument() {
  attachMenuOpen.value = false
  if (!props.hasDocument) return
  if (contextChips.value.some(c => c.type === 'document')) return
  const docName = props.documentName || 'Untitled'
  contextChips.value.push({ type: 'document', id: 'current-doc', label: docName })
  emit('pick-document')
  inputEl.value?.focus()
}

// --- Context chips management ---
function addContextChip(chip) {
  if (chip.type === 'skill') {
    const existing = contextChips.value.findIndex(c => c.type === 'skill')
    if (existing >= 0) {
      contextChips.value.splice(existing, 1, chip)
      return
    }
  }
  if (chip.type === 'document' && contextChips.value.some(c => c.type === 'document')) return
  if (chip.type === 'project-file' && contextChips.value.some(c => c.type === 'project-file' && c.id === chip.id)) return
  if (chip.type === 'board-entry' && contextChips.value.some(c => c.type === 'board-entry' && c.id === chip.id)) return
  contextChips.value.push(chip)
}

function removeContextChip(idx) {
  const chip = contextChips.value[idx]
  if (chip?.type === 'board-entry') {
    const attIdx = attachments.value.findIndex(a => a._entryId === chip.id)
    if (attIdx >= 0) attachments.value.splice(attIdx, 1)
  }
  contextChips.value.splice(idx, 1)
}

function clearContextChips() {
  contextChips.value = []
}

function autoResize() {
  const el = inputEl.value
  if (!el) return
  el.style.height = 'auto'
  const scrollH = el.scrollHeight
  el.style.height = Math.min(scrollH, 180) + 'px'
  el.style.overflowY = scrollH > 180 ? 'auto' : 'hidden'
}

function onInput() {
  autoResize()
  updateCursor()
}

function onKeydown(e) {
  if (showAtDropdown.value) {
    const totalItems = atFilteredSkills.value.length + atFilteredFiles.value.length + atFilteredBoard.value.length
    if (e.key === 'ArrowDown' && totalItems > 0) {
      e.preventDefault()
      atHighlight.value = (atHighlight.value + 1) % totalItems
      return
    }
    if (e.key === 'ArrowUp' && totalItems > 0) {
      e.preventDefault()
      atHighlight.value = (atHighlight.value - 1 + totalItems) % totalItems
      return
    }
    if (e.key === 'Enter') {
      if (atHighlight.value >= 0) {
        e.preventDefault()
        e.stopPropagation()
        const skillCount = atFilteredSkills.value.length
        const fileCount = atFilteredFiles.value.length
        if (atHighlight.value < skillCount) {
          selectAtSkill(atFilteredSkills.value[atHighlight.value])
        } else if (atHighlight.value < skillCount + fileCount) {
          selectAtFile(atFilteredFiles.value[atHighlight.value - skillCount])
        } else {
          selectAtBoardEntry(atFilteredBoard.value[atHighlight.value - skillCount - fileCount])
        }
      } else {
        // Dropdown visible but nothing highlighted — block send
        e.preventDefault()
      }
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      // Remove the @query to dismiss dropdown
      const text = draft.value
      const pos = cursorPos.value
      const before = text.slice(0, pos)
      const atIdx = before.lastIndexOf('@')
      if (atIdx >= 0) {
        draft.value = text.slice(0, atIdx) + text.slice(pos)
        nextTick(() => {
          inputEl.value?.setSelectionRange(atIdx, atIdx)
          cursorPos.value = atIdx
          autoResize()
        })
      }
      return
    }
  }

  // Normal Enter to send (replaces @keydown.enter.exact.prevent="send")
  if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault()
    send()
  }
}

function addAttachment(att) {
  if (att.type !== 'text' && !validateFileSize(att.size)) {
    const msg = 'File too large (max 20 MB)'
    attachError.value = msg
    scheduleErrorClear()
    return msg
  }
  attachments.value.push(att)
  return null
}

function removeAttachment(idx) {
  attachments.value.splice(idx, 1)
}

function clearAttachments() {
  attachments.value = []
}

function scheduleErrorClear() {
  if (errorTimer) clearTimeout(errorTimer)
  errorTimer = setTimeout(() => { attachError.value = '' }, 3000)
}

const isTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__
let unlistenDrop = null

async function setupTauriDrop() {
  if (!isTauri) return
  try {
    const { getCurrentWebview } = await import('@tauri-apps/api/webview')
    const { invoke } = await import('@tauri-apps/api/core')
    unlistenDrop = await getCurrentWebview().onDragDropEvent(async (event) => {
      const { type } = event.payload
      if (panelUI.sidebarDragging) return
      if (type === 'enter' || type === 'over') {
        dropActive.value = true
      } else if (type === 'leave') {
        dropActive.value = false
      } else if (type === 'drop') {
        dropActive.value = false
        for (const path of event.payload.paths) {
          const filename = path.split('/').pop()
          const mediaType = mediaTypeFromFilename(filename)
          if (!mediaType) continue
          try {
            if (isTextType(mediaType)) {
              const resp = await invoke('read_text_file', { path })
              const content = resp.content
              const size = new Blob([content]).size
              if (!validateFileSize(size)) {
                attachError.value = `${filename}: too large (max 20 MB)`
                scheduleErrorClear()
                continue
              }
              attachments.value.push({ filename, mediaType, content, type: 'text', size })
            } else {
              const base64 = await invoke('read_binary_file', { path })
              const size = Math.ceil(base64.length * 3 / 4)
              if (!validateFileSize(size)) {
                attachError.value = `${filename}: too large (max 20 MB)`
                scheduleErrorClear()
                continue
              }
              const dataUrl = toDataUrl(mediaType, base64)
              attachments.value.push({ filename, mediaType, dataUrl, size })
            }
          } catch { /* skip unreadable files */ }
        }
      }
    })
  } catch { /* not in Tauri */ }
}

onMounted(setupTauriDrop)
onUnmounted(() => { unlistenDrop?.() })

function onPointerDown(event) {
  if (attachPickerRef.value && !attachPickerRef.value.contains(event.target)) {
    attachMenuOpen.value = false
  }
}
onMounted(() => document.addEventListener('pointerdown', onPointerDown, true))
onUnmounted(() => document.removeEventListener('pointerdown', onPointerDown, true))

function pickAttach(type) {
  attachMenuOpen.value = false
  emit('attach', type)
}

function send() {
  const text = draft.value.trim()
  if (showAtDropdown.value) return
  if ((!text && attachments.value.length === 0) || props.disabled || props.busy) return
  emit('send', { text, attachments: [...attachments.value] })
  draft.value = ''
  attachments.value = []
  // Note: contextChips are NOT cleared here — parent reads them after send and clears manually
  nextTick(autoResize)
}

defineExpose({
  focus: () => inputEl.value?.focus(),
  draft,
  attachments,
  addAttachment,
  removeAttachment,
  clearAttachments,
  contextChips,
  addContextChip,
  removeContextChip,
  clearContextChips,
  // @ mention internals (used by tests)
  cursorPos,
  atQuery,
  atActive,
  atHighlight,
  atFilteredSkills,
  atFilteredFiles,
  atFilteredBoard,
  showAtDropdown,
  selectAtItem,
})
</script>

<style scoped>
.composer-wrap {
  position: relative;
  width: 100%; padding: 0 40px 4px;
  max-width: calc(720px + 80px); margin: 0 auto;
}
.composer {
  position: relative; /* for drop-overlay */
  background: var(--color-surface); border: 1px solid var(--color-rule); border-radius: 14px;
  padding: 12px 14px 10px;
  box-shadow: 0 1px 0 rgba(0,0,0,0.03), 0 12px 30px -22px rgba(0,0,0,0.15);
  transition: border-color 0.15s;
}
.composer.drop-active {
  border-color: var(--color-accent);
}
.drop-overlay {
  background: color-mix(in srgb, var(--color-surface) 92%, var(--color-accent));
}
.drop-fade-enter-active { transition: opacity 0.12s ease; }
.drop-fade-leave-active { transition: opacity 0.08s ease; }
.drop-fade-enter-from, .drop-fade-leave-to { opacity: 0; }
.composer-input {
  width: 100%; border: 0; background: transparent;
  font-family: var(--font-sans); font-size: 15px; color: var(--color-ink);
  outline: none; line-height: 1.5;
  resize: none; overflow-y: hidden; min-height: 30px; max-height: 180px;
}
.composer-input::placeholder { color: var(--color-ink-3); font-style: italic; }
.composer-row {
  display: flex; align-items: center; justify-content: space-between;
  margin-top: 6px; padding-top: 6px;
}
.composer-left, .composer-right { display: flex; align-items: center; gap: 8px; }
.composer-cost { font-size: 11px; color: var(--color-ink-3); font-family: var(--font-mono); }
.attach-picker { position: relative; }
.cmp-icon {
  width: 30px; height: 30px; border-radius: 8px;
  border: 1px solid var(--color-rule); background: var(--color-surface);
  color: var(--color-ink-2); display: inline-flex; align-items: center; justify-content: center;
}
.cmp-icon:hover { background: var(--color-chrome-high); color: var(--color-ink); }
.cmp-icon:disabled { opacity: 0.3; pointer-events: none; }
.cmp-send, .cmp-stop {
  width: 30px; height: 30px; border-radius: 8px;
  display: inline-flex; align-items: center; justify-content: center;
}
.cmp-send { background: var(--color-ink); color: var(--color-chrome-mid); }
.cmp-send:hover { background: var(--color-accent); }
.cmp-send:disabled { opacity: 0.3; pointer-events: none; }
.cmp-stop { background: var(--color-accent); color: var(--color-chrome-mid); }
.cmp-stop:hover { background: var(--color-accent-2); }
.budget-bar {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 14px; font-family: var(--font-sans); font-size: 11px;
  border-radius: 6px; margin: 0 40px 6px;
  max-width: calc(720px + 80px - 80px); margin-left: auto; margin-right: auto;
}
.budget-bar.warning { background: var(--color-accent-tint); color: var(--color-ink-2); }
.budget-bar.blocked { background: var(--color-accent-tint); color: var(--color-rem); }
.budget-link {
  color: inherit; text-decoration: underline;
  font-size: inherit; font-family: inherit;
  background: none; border: none; padding: 0;
}
.budget-link:hover {
  background: var(--color-chrome-mid);
  border-radius: 3px;
}
.attach-error {
  font-family: var(--font-sans); font-size: 11px; color: var(--color-accent-2); margin: 4px 0;
}
</style>
