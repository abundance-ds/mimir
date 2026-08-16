<template>
  <section
    data-today-app
    class="flex h-full min-h-0 w-full flex-col bg-surface text-ink"
  >
    <section
      v-if="showRollover"
      data-today-rollover
      class="shrink-0 border-b border-rule bg-chrome-low px-4 py-3"
    >
      <div class="flex items-center gap-3">
        <IconHistory :size="15" :stroke-width="1.6" class="shrink-0 text-ink-3" />
        <div class="min-w-0 flex-1">
          <p class="text-[10px] font-semibold text-ink">
            {{ carryCandidates.length }} unfinished {{ carryCandidates.length === 1 ? 'item' : 'items' }} from {{ previousDayLabel }}
          </p>
          <p class="mt-0.5 text-[9px] text-ink-3">The full day stays in your Personal Journal.</p>
        </div>
        <button
          type="button"
          class="h-7 shrink-0 bg-accent px-3 text-[9px] font-semibold text-white hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          @click="carryAll"
        >
          Carry all {{ carryCandidates.length }}
        </button>
        <button
          type="button"
          class="h-7 shrink-0 border border-rule px-3 text-[9px] font-semibold text-ink-2 hover:bg-chrome-mid focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          @click="carryReview = !carryReview"
        >
          {{ carryReview ? 'Close review' : 'Review' }}
        </button>
        <button
          type="button"
          class="h-7 shrink-0 px-2 text-[9px] text-ink-3 hover:bg-chrome-mid hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          @click="skipCarry"
        >
          {{ text.trim() ? 'Do not carry' : 'Start empty' }}
        </button>
      </div>

      <div v-if="carryReview" class="mt-3 border-t border-rule pt-2">
        <button
          v-for="candidate in carryCandidates"
          :key="candidate.id"
          type="button"
          :aria-pressed="carrySelection.has(candidate.id)"
          class="grid w-full grid-cols-[50px_minmax(0,1fr)] gap-3 border-b border-rule-light px-2 py-2 text-left hover:bg-chrome-mid focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
          @click="toggleCarry(candidate.id)"
        >
          <span
            class="pt-0.5 font-mono text-[8px] uppercase tracking-[0.08em]"
            :class="carrySelection.has(candidate.id) ? 'text-accent' : 'text-ink-4'"
          >
            {{ carrySelection.has(candidate.id) ? 'Carry' : 'Skip' }}
          </span>
          <span class="whitespace-pre-wrap font-mono text-[10px] leading-[1.45] text-ink-2">{{ candidate.markdown }}</span>
        </button>
        <div class="mt-2 flex justify-end">
          <button
            type="button"
            class="h-7 bg-accent px-3 text-[9px] font-semibold text-white hover:bg-accent/90 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            @click="applySelectedCarry"
          >
            {{ selectedCarryCount ? `Append ${selectedCarryCount} to Today` : 'Keep all in Journal' }}
          </button>
        </div>
      </div>
    </section>

    <div
      v-if="notice"
      data-today-notice
      aria-live="polite"
      class="shrink-0 border-b border-rule-light px-4 py-1.5 text-[9px] text-ink-3"
    >
      {{ notice }}
    </div>

    <div
      v-if="journalIssue"
      data-today-journal-issue
      class="flex shrink-0 items-center gap-2 border-b border-rule-light px-4 py-1.5 text-[9px] text-ink-3"
    >
      <span class="min-w-0 flex-1">{{ journalIssue }}</span>
      <button
        type="button"
        class="h-6 px-2 font-semibold text-ink-2 hover:bg-chrome-mid focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        @click="archivePendingEntries"
      >
        Retry
      </button>
    </div>

    <div
      ref="editorHost"
      data-today-editor
      :aria-busy="loading || historyLoading"
      class="min-h-0 w-full flex-1 overflow-hidden bg-surface"
    ></div>

    <div
      v-if="error"
      data-today-error
      role="alert"
      class="flex min-h-9 shrink-0 items-center gap-2 border-t border-rem/30 bg-surface px-4 py-1.5 text-[9px] text-rem"
    >
      <IconAlertTriangle :size="13" :stroke-width="1.7" class="shrink-0" />
      <span class="min-w-0 flex-1">{{ error }}</span>
      <button
        type="button"
        class="h-6 shrink-0 px-2 font-semibold hover:bg-rem/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-rem"
        @click="resolveError"
      >
        {{ errorAction ? 'Retry' : 'Dismiss' }}
      </button>
    </div>

    <footer
      data-today-statusbar
      class="flex h-7 shrink-0 items-center border-t border-rule bg-chrome-high px-2"
    >
      <nav
        data-today-date-nav
        aria-label="Journal date navigation"
        class="ml-auto flex h-full items-center"
      >
        <span
          data-today-save-state
          aria-live="polite"
          class="w-14 pr-1 text-right font-mono text-[9px] uppercase tracking-[0.08em]"
          :class="saveStateClass"
        >
          {{ saveStateLabel || (historyLoading ? 'Loading' : '') }}
        </span>
        <button
          type="button"
          aria-label="Return to current day"
          title="Return to current day"
          :disabled="isViewingToday"
          class="flex size-6 items-center justify-center focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:cursor-default disabled:opacity-30"
          :class="isViewingToday ? 'text-ink-3' : 'text-accent hover:bg-chrome-mid'"
          @click="showToday"
        >
          <IconCalendar :size="13" :stroke-width="1.7" />
        </button>
        <button
          type="button"
          aria-label="View previous day"
          class="flex size-6 items-center justify-center text-ink-3 hover:bg-chrome-mid hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          @click="navigateDate(-1)"
        >
          <IconChevronLeft :size="14" :stroke-width="1.7" />
        </button>
        <DatePicker
          :model-value="viewDate"
          data-today-date-picker
          aria-label="Choose Journal date"
          variant="custom"
          :max="tomorrowDate"
          :show-footer="false"
          placement="top-end"
          :day-state="calendarDayState"
          :describe-day="calendarDayDescription"
          class="h-full w-[104px] hover:bg-chrome-mid focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          @change="showDate"
          @month-change="loadCalendarMonth"
        >
          <template #trigger>
            <time
              :datetime="viewDate"
              class="block min-w-0 truncate px-1 text-center font-mono text-[10px] font-medium tabular-nums text-ink-2"
            >
              {{ navigationDateLabel }}
            </time>
          </template>
        </DatePicker>
        <button
          type="button"
          aria-label="View next day"
          :disabled="!canMoveForward"
          class="flex size-6 items-center justify-center text-ink-3 hover:bg-chrome-mid hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:cursor-default disabled:opacity-25"
          @click="navigateDate(1)"
        >
          <IconChevronRight :size="14" :stroke-width="1.7" />
        </button>
      </nav>
    </footer>
  </section>
</template>

<script setup>
import {
  computed,
  nextTick,
  onMounted,
  onUnmounted,
  ref,
  watch,
} from 'vue'
import {
  IconAlertTriangle,
  IconCalendar,
  IconChevronLeft,
  IconChevronRight,
  IconHistory,
} from '@tabler/icons-vue'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, drawSelection, keymap, placeholder } from '@codemirror/view'
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  selectAll as selectAllCommand,
} from '@codemirror/commands'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { tags } from '@lezer/highlight'
import { Strikethrough } from '@lezer/markdown'
import { taskCheckboxExtension } from '../../editor/codemirror/taskCheckboxes.js'
import { markdownListKeymap } from '../../editor/codemirror/markdownLists.js'
import { loadAppData, saveAppData } from '../../services/appsCatalog.js'
import DatePicker from '../../shared/ui/DatePicker.vue'
import {
  appendMarkdownBelow,
  carrySource,
  localDateKey,
  parseTodayStorage,
  serializeTodayStorage,
  shiftDateKey,
  uncheckedTaskBlocks,
} from './todayModel.js'
import {
  archiveTodayEntry,
  loadTodayEntry,
  loadTodayMonthDates,
} from './todayJournal.js'

const props = defineProps({
  app: { type: Object, required: true },
  instanceId: { type: String, required: true },
  active: { type: Boolean, default: false },
})

const emit = defineEmits(['diagnostic'])
const editorHost = ref(null)
const text = ref('')
const documentDate = ref(localDateKey())
const viewDate = ref(documentDate.value)
const todayKey = ref(documentDate.value)
const updatedAt = ref(null)
const previous = ref(null)
const archiveQueue = ref([])
const tomorrow = ref(null)
const loading = ref(true)
const historyLoading = ref(false)
const saving = ref(false)
const dirty = ref(false)
const todayDirty = ref(false)
const tomorrowDirty = ref(false)
const savedOnce = ref(false)
const savedDate = ref('')
const error = ref('')
const errorAction = ref('')
const journalIssue = ref('')
const notice = ref('')
const carryReview = ref(false)
const carrySelection = ref(new Set())
const archiving = ref(false)
const calendarDatesByMonth = ref(new Map())
const calendarMonthsLoading = new Set()
let saveTimer = null
let savedTimer = null
let noticeTimer = null
let activeSave = null
let historyRequest = 0
let editRevision = 0
let disposed = false
let editorView = null
let applyingExternalText = false
const readOnlyCompartment = new Compartment()
const contextCompartment = new Compartment()

const carryCandidates = computed(() => (
  previous.value?.carryPending
    ? uncheckedTaskBlocks(carrySource(previous.value))
    : []
))
const selectedCarryCount = computed(() => (
  carryCandidates.value.filter(candidate => carrySelection.value.has(candidate.id)).length
))
const isViewingToday = computed(() => viewDate.value === documentDate.value)
const tomorrowDate = computed(() => shiftDateKey(documentDate.value, 1))
const isViewingTomorrow = computed(() => viewDate.value === tomorrowDate.value)
const isEditableDate = computed(() => isViewingToday.value || isViewingTomorrow.value)
const canMoveForward = computed(() => viewDate.value < tomorrowDate.value)
const visibleDirty = computed(() => (
  isViewingToday.value ? todayDirty.value : isViewingTomorrow.value && tomorrowDirty.value
))
const showRollover = computed(() => (
  isViewingToday.value && previous.value?.carryPending && carryCandidates.value.length > 0
))
const previousDayLabel = computed(() => (
  previous.value?.carryDates?.length > 1
    ? 'recent days'
    : formatDayReference(previous.value?.carryDates?.[0] || previous.value?.date)
))
const navigationDateLabel = computed(() => {
  return compactDateLabel(viewDate.value)
})
const saveStateLabel = computed(() => {
  if (!isEditableDate.value) return ''
  if (loading.value) return 'Restoring'
  if (saving.value) return 'Saving'
  if (visibleDirty.value) return 'Unsaved'
  return savedOnce.value && savedDate.value === viewDate.value ? 'Saved' : ''
})
const saveStateClass = computed(() => {
  if (error.value) return 'text-rem'
  if (visibleDirty.value) return 'text-accent'
  return 'text-ink-4'
})

const todayHighlightStyle = HighlightStyle.define([
  {
    tag: [
      tags.heading1,
      tags.heading2,
      tags.heading3,
      tags.heading4,
      tags.heading5,
      tags.heading6,
    ],
    color: 'var(--color-ink)',
    fontWeight: '600',
  },
  { tag: tags.strong, color: 'var(--color-ink)', fontWeight: '650' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: [tags.link, tags.url], color: 'var(--color-accent)' },
  { tag: tags.monospace, color: 'var(--color-ink-2)' },
  { tag: tags.quote, color: 'var(--color-ink-3)' },
  { tag: tags.contentSeparator, color: 'var(--color-ink-4)' },
])

const todayEditorTheme = EditorView.theme({
  '&': {
    width: '100%',
    height: '100%',
    color: 'var(--color-ink)',
    backgroundColor: 'var(--color-surface)',
    fontSize: '15px',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily: 'var(--font-mono)',
    fontWeight: 'var(--editor-font-weight, 450)',
    lineHeight: '1.4',
  },
  '.cm-content': {
    boxSizing: 'border-box',
    minHeight: '100%',
    padding: '16px 20px',
    caretColor: 'var(--color-accent)',
  },
  '.cm-line': { padding: '0' },
  '.cm-cursor': { borderLeftColor: 'var(--color-accent)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'var(--selection) !important',
  },
  '.cm-placeholder': {
    color: 'var(--color-ink-4)',
    fontStyle: 'normal',
  },
})

onMounted(async () => {
  createMarkdownEditor()
  window.addEventListener('focus', handleActivation)
  document.addEventListener('visibilitychange', handleVisibilityChange)
  await restore()
})

watch(() => props.active, async (active) => {
  if (!active || loading.value) return
  await handleActivation()
  await nextTick()
  editorView?.focus()
}, { immediate: true })

async function restore() {
  loading.value = true
  try {
    const raw = await loadAppData(props.app.id, 'scratch')
    if (disposed) return
    const saved = parseTodayStorage(raw, todayKey.value)
    documentDate.value = saved.date
    viewDate.value = saved.date
    text.value = saved.text
    updatedAt.value = saved.updatedAt
    previous.value = saved.previous
    archiveQueue.value = saved.archiveQueue
    tomorrow.value = saved.tomorrow
    prepareCarrySelection()
    syncEditorText(text.value)
    await ensureCurrentDay()
  } catch (cause) {
    reportError(`Today could not be restored: ${errorMessage(cause)}`, 'restore')
  } finally {
    loading.value = false
    updateEditorContext()
    if (props.active) await nextTick(() => editorView?.focus())
    void archivePendingEntries()
  }
}

function createMarkdownEditor() {
  if (!editorHost.value || editorView) return
  const state = EditorState.create({
    doc: text.value,
    extensions: [
      EditorView.lineWrapping,
      contextCompartment.of(editorContextExtensions()),
      readOnlyCompartment.of(readOnlyExtensions(true)),
      history(),
      drawSelection(),
      markdown({ base: markdownLanguage, extensions: [Strikethrough] }),
      markdownListKeymap,
      syntaxHighlighting(todayHighlightStyle),
      taskCheckboxExtension(() => isEditableDate.value),
      todayEditorTheme,
      keymap.of([
        indentWithTab,
        { key: 'Meta-a', run: view => selectAllCommand(view) },
        { key: 'Ctrl-a', run: view => selectAllCommand(view) },
        {
          key: 'Meta-s',
          run() {
            void saveNow()
            return true
          },
        },
        {
          key: 'Ctrl-s',
          run() {
            void saveNow()
            return true
          },
        },
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged || applyingExternalText || !isEditableDate.value) return
        const value = update.state.doc.toString()
        if (isViewingToday.value) {
          text.value = value
          todayDirty.value = true
        } else {
          tomorrow.value = {
            date: tomorrowDate.value,
            text: value,
            updatedAt: new Date().toISOString(),
          }
          tomorrowDirty.value = true
        }
        markDirty()
      }),
    ],
  })
  editorView = new EditorView({ state, parent: editorHost.value })
}

function readOnlyExtensions(readOnly) {
  return [
    EditorState.readOnly.of(readOnly),
    EditorView.editable.of(!readOnly),
  ]
}

function editorContextExtensions() {
  const historical = !isEditableDate.value
  const label = historical
    ? `Journal entry for ${viewDate.value}`
    : isViewingTomorrow.value
      ? `Tomorrow Markdown draft for ${viewDate.value}`
      : 'Today Markdown artifact'
  const emptyText = historical
    ? 'No Journal entry for this day.'
    : isViewingTomorrow.value
      ? 'Add notes for tomorrow…'
      : 'Write anything…'
  return [
    EditorView.contentAttributes.of({
      'aria-label': label,
      spellcheck: historical ? 'false' : 'true',
      autocorrect: 'off',
      autocapitalize: 'off',
    }),
    placeholder(emptyText),
  ]
}

function updateEditorContext() {
  if (!editorView) return
  editorView.dispatch({
    effects: [
      readOnlyCompartment.reconfigure(readOnlyExtensions(loading.value || !isEditableDate.value)),
      contextCompartment.reconfigure(editorContextExtensions()),
    ],
  })
}

function syncEditorText(value) {
  if (!editorView || editorView.state.doc.toString() === value) return
  applyingExternalText = true
  editorView.dispatch({
    changes: {
      from: 0,
      to: editorView.state.doc.length,
      insert: value,
    },
  })
  applyingExternalText = false
}

async function handleActivation() {
  if (!props.active || loading.value) return
  todayKey.value = localDateKey()
  await ensureCurrentDay()
  void archivePendingEntries()
}

function handleVisibilityChange() {
  if (document.visibilityState === 'visible') void handleActivation()
}

async function ensureCurrentDay() {
  todayKey.value = localDateKey()
  if (documentDate.value >= todayKey.value) return

  const oldDate = documentDate.value
  const oldText = text.value
  const scheduled = tomorrow.value
  if (previous.value?.archivePending && previous.value.text.trim()) {
    archiveQueue.value = mergeArchiveQueue(archiveQueue.value, previous.value)
  }

  const missedTomorrow = scheduled?.date < todayKey.value ? scheduled : null
  if (missedTomorrow?.text.trim()) {
    archiveQueue.value = mergeArchiveQueue(archiveQueue.value, missedTomorrow)
  }

  const carrySources = []
  if (previous.value?.carryPending) {
    const earlierCarry = uncheckedTaskBlocks(carrySource(previous.value))
      .map(block => block.markdown)
      .join('\n\n')
    if (earlierCarry) {
      carrySources.push({
        dates: previous.value.carryDates || [previous.value.date],
        text: earlierCarry,
      })
    }
  }
  if (uncheckedTaskBlocks(oldText).length) {
    carrySources.push({ dates: [oldDate], text: oldText })
  }
  if (missedTomorrow && uncheckedTaskBlocks(missedTomorrow.text).length) {
    carrySources.push({ dates: [missedTomorrow.date], text: missedTomorrow.text })
  }
  const carryText = carrySources.map(source => source.text).join('\n\n')
  const carryDates = carrySources.flatMap(source => source.dates)
  const candidates = uncheckedTaskBlocks(carryText)
  previous.value = {
    date: oldDate,
    text: oldText,
    carryText,
    carryDates: [...new Set(carryDates)].sort(),
    archivePending: Boolean(oldText.trim()),
    carryPending: candidates.length > 0,
  }
  documentDate.value = todayKey.value
  viewDate.value = todayKey.value
  cancelHistoryLoad()
  const promotedTomorrow = scheduled?.date === todayKey.value ? scheduled : null
  text.value = promotedTomorrow?.text || ''
  updatedAt.value = promotedTomorrow?.updatedAt || null
  todayDirty.value = true
  tomorrow.value = scheduled?.date > todayKey.value ? scheduled : null
  carryReview.value = false
  prepareCarrySelection()
  settlePrevious()
  syncEditorText(text.value)
  updateEditorContext()
  markDirty({ schedule: false })
  await flushSave()

  if (!candidates.length && (oldText.trim() || missedTomorrow?.text.trim())) {
    showNotice(`${formatDayReference(oldDate)} was filed in your Personal Journal.`)
  }
}

async function navigateDate(offset) {
  await ensureCurrentDay()
  const target = shiftDateKey(viewDate.value, offset)
  if (!target || target > tomorrowDate.value) return
  if (target === documentDate.value) {
    showToday()
    return
  }
  if (target === tomorrowDate.value) {
    showTomorrow()
    return
  }
  await showHistoryDate(target)
}

async function showHistoryDate(date) {
  const request = ++historyRequest
  viewDate.value = date
  historyLoading.value = true
  updateEditorContext()
  try {
    let entry = null
    try {
      entry = await loadTodayEntry(date)
    } catch (cause) {
      const pending = pendingEntry(date)
      if (!pending) throw cause
      entry = pending.text
    }
    if (entry == null) entry = pendingEntry(date)?.text || ''
    if (request !== historyRequest || viewDate.value !== date) return
    markCalendarDate(date, Boolean(String(entry).trim()))
    syncEditorText(entry)
    error.value = ''
    errorAction.value = ''
  } catch (cause) {
    if (request !== historyRequest || viewDate.value !== date) return
    syncEditorText('')
    reportError(`Journal entry could not be loaded: ${errorMessage(cause)}`, 'history')
  } finally {
    if (request === historyRequest && viewDate.value === date) {
      historyLoading.value = false
      updateEditorContext()
    }
  }
}

async function showDate(date) {
  await ensureCurrentDay()
  if (!date || date > tomorrowDate.value) return
  if (date === documentDate.value) {
    showToday()
    return
  }
  if (date === tomorrowDate.value) {
    showTomorrow()
    return
  }
  await showHistoryDate(date)
}

function showToday() {
  cancelHistoryLoad()
  viewDate.value = documentDate.value
  syncEditorText(text.value)
  updateEditorContext()
  nextTick(() => editorView?.focus())
}

function showTomorrow() {
  cancelHistoryLoad()
  viewDate.value = tomorrowDate.value
  const draft = tomorrow.value?.date === tomorrowDate.value ? tomorrow.value.text : ''
  syncEditorText(draft)
  updateEditorContext()
  nextTick(() => editorView?.focus())
}

function cancelHistoryLoad() {
  historyRequest += 1
  historyLoading.value = false
}

function carryAll() {
  carrySelection.value = new Set(carryCandidates.value.map(candidate => candidate.id))
  applySelectedCarry()
}

function toggleCarry(id) {
  const next = new Set(carrySelection.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  carrySelection.value = next
}

function applySelectedCarry() {
  const blocks = carryCandidates.value
    .filter(candidate => carrySelection.value.has(candidate.id))
    .map(candidate => candidate.markdown)
  if (blocks.length) {
    const carried = blocks.join('\n\n')
    const next = appendMarkdownBelow(text.value, carried)
    editorView?.dispatch({
      changes: {
        from: 0,
        to: editorView.state.doc.length,
        insert: next,
      },
    })
    showNotice(`${blocks.length} ${blocks.length === 1 ? 'item' : 'items'} appended to Today. Undo is available.`)
  } else {
    showNotice('No items were carried into Today.')
  }
  resolveCarry()
}

function skipCarry() {
  showNotice('Unfinished items stayed in your Personal Journal.')
  resolveCarry()
}

function resolveCarry() {
  if (!previous.value) return
  previous.value = { ...previous.value, carryPending: false }
  carryReview.value = false
  markDirty()
  settlePrevious()
}

function prepareCarrySelection() {
  const candidates = previous.value?.carryPending
    ? uncheckedTaskBlocks(carrySource(previous.value))
    : []
  carrySelection.value = new Set(candidates.map(candidate => candidate.id))
}

async function archivePendingEntries() {
  if (archiving.value) return
  const entries = pendingArchiveEntries()
  if (!entries.length) {
    journalIssue.value = ''
    return
  }

  archiving.value = true
  let changed = false
  let archivedDate = ''
  try {
    for (const entry of entries) {
      await archiveTodayEntry(entry)
      markCalendarDate(entry.date, true)
      archivedDate = entry.date
      archiveQueue.value = archiveQueue.value.filter(item => item.date !== entry.date)
      if (previous.value?.date === entry.date) {
        previous.value = { ...previous.value, archivePending: false }
      }
      changed = true
    }
    journalIssue.value = ''
    if (archivedDate && !showRollover.value) {
      showNotice(`${formatDayReference(archivedDate)} was filed in your Personal Journal.`)
    }
  } catch (cause) {
    journalIssue.value = `Journal archive is waiting: ${errorMessage(cause)}`
  } finally {
    archiving.value = false
    if (changed) {
      settlePrevious()
      markDirty({ schedule: false })
      void flushSave()
    }
  }
}

async function loadCalendarMonth(monthKey) {
  if (!/^\d{4}-\d{2}$/.test(String(monthKey || ''))) return
  if (calendarDatesByMonth.value.has(monthKey) || calendarMonthsLoading.has(monthKey)) return
  calendarMonthsLoading.add(monthKey)
  try {
    const dates = await loadTodayMonthDates(monthKey)
    const next = new Map(calendarDatesByMonth.value)
    next.set(monthKey, new Set(dates))
    calendarDatesByMonth.value = next
  } catch {
    // Date selection remains available when the optional entry markers cannot load.
  } finally {
    calendarMonthsLoading.delete(monthKey)
  }
}

function calendarDayState(date) {
  if (date === documentDate.value) return text.value.trim() ? 'entry' : 'empty'
  if (date === tomorrowDate.value) {
    return tomorrow.value?.date === date && tomorrow.value.text.trim() ? 'entry' : 'empty'
  }
  if (pendingEntry(date)?.text?.trim()) return 'entry'
  const dates = calendarDatesByMonth.value.get(date.slice(0, 7))
  if (!dates) return ''
  return dates.has(date) ? 'entry' : 'empty'
}

function calendarDayDescription(_date, state) {
  if (state === 'entry') return 'has content'
  if (state === 'empty') return 'no entry'
  return ''
}

function markCalendarDate(date, present) {
  const monthKey = String(date || '').slice(0, 7)
  const dates = calendarDatesByMonth.value.get(monthKey)
  if (!dates) return
  const nextDates = new Set(dates)
  if (present) nextDates.add(date)
  else nextDates.delete(date)
  const next = new Map(calendarDatesByMonth.value)
  next.set(monthKey, nextDates)
  calendarDatesByMonth.value = next
}

function pendingArchiveEntries() {
  const entries = [...archiveQueue.value]
  if (previous.value?.archivePending && previous.value.text.trim()) {
    entries.push({ date: previous.value.date, text: previous.value.text })
  }
  return [...new Map(entries.map(entry => [entry.date, entry])).values()]
    .sort((left, right) => left.date.localeCompare(right.date))
}

function pendingEntry(date) {
  if (previous.value?.date === date) return previous.value
  return archiveQueue.value.find(entry => entry.date === date) || null
}

function mergeArchiveQueue(queue, entry) {
  const entries = new Map(queue.map(item => [item.date, item]))
  const existing = entries.get(entry.date)
  entries.set(entry.date, {
    date: entry.date,
    text: existing ? appendMarkdownBelow(existing.text, entry.text) : entry.text,
  })
  return [...entries.values()].sort((left, right) => left.date.localeCompare(right.date))
}

function settlePrevious() {
  if (previous.value && !previous.value.archivePending && !previous.value.carryPending) {
    previous.value = null
  }
}

function markDirty({ schedule = true } = {}) {
  editRevision += 1
  dirty.value = true
  savedOnce.value = false
  if (errorAction.value === 'save') {
    error.value = ''
    errorAction.value = ''
  }
  clearTimeout(saveTimer)
  if (schedule && !disposed) saveTimer = setTimeout(() => void persist(), 350)
}

function saveNow() {
  clearTimeout(saveTimer)
  return flushSave()
}

async function flushSave() {
  clearTimeout(saveTimer)
  while (dirty.value) {
    const saved = await persist()
    if (!saved) return false
  }
  return true
}

function persist() {
  if (activeSave) return activeSave
  if (!dirty.value) return Promise.resolve(true)

  const revision = editRevision
  const savedAt = new Date().toISOString()
  const savedViewDate = isEditableDate.value ? viewDate.value : ''
  const todaySavedAt = todayDirty.value ? savedAt : updatedAt.value
  const raw = serializeTodayStorage({
    date: documentDate.value,
    text: text.value,
    updatedAt: todaySavedAt,
    previous: previous.value,
    archiveQueue: archiveQueue.value,
    tomorrow: tomorrow.value,
  })
  saving.value = true
  activeSave = (async () => {
    try {
      await saveAppData(props.app.id, 'scratch', raw)
      error.value = ''
      errorAction.value = ''
      if (editRevision === revision) {
        updatedAt.value = todaySavedAt
        todayDirty.value = false
        tomorrowDirty.value = false
        dirty.value = false
        savedOnce.value = true
        savedDate.value = savedViewDate
        clearTimeout(savedTimer)
        savedTimer = setTimeout(() => { savedOnce.value = false }, 1_500)
      }
      return true
    } catch (cause) {
      reportError(`Today could not be saved: ${errorMessage(cause)}`, 'save')
      return false
    } finally {
      saving.value = false
      activeSave = null
    }
  })()
  return activeSave
}

function showNotice(message) {
  notice.value = message
  clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => { notice.value = '' }, 4_000)
}

function reportError(message, action = '') {
  error.value = message
  errorAction.value = action
  emit('diagnostic', message)
}

function resolveError() {
  const action = errorAction.value
  error.value = ''
  errorAction.value = ''
  if (action === 'restore') return restore()
  if (action === 'save') return saveNow()
  if (action === 'history') return showHistoryDate(viewDate.value)
}

function formatDayReference(date) {
  if (!date) return 'the previous day'
  if (date === shiftDateKey(documentDate.value, -1)) return 'yesterday'
  return formatDate(date, { weekday: 'long' })
}

function formatDate(dateKey, options) {
  const [year, month, day] = String(dateKey || '').split('-').map(Number)
  const date = new Date(year, month - 1, day, 12)
  if (Number.isNaN(date.getTime())) return String(dateKey || '')
  return new Intl.DateTimeFormat(undefined, options).format(date)
}

function compactDateLabel(dateKey) {
  const [year, month, day] = String(dateKey || '').split('-').map(Number)
  const date = new Date(year, month - 1, day, 12)
  if (Number.isNaN(date.getTime())) return String(dateKey || '')
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat(undefined, {
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    }).formatToParts(date).map(part => [part.type, part.value]),
  )
  const yearLabel = String(year) === documentDate.value.slice(0, 4) ? '' : ` ${parts.year}`
  return `${parts.weekday} ${parts.day} ${parts.month}${yearLabel}`
}

function errorMessage(cause) {
  return cause instanceof Error ? cause.message : String(cause || 'Unknown failure')
}

defineExpose({
  focus: () => editorView?.focus(),
  getContent: () => editorView?.state.doc.toString() || '',
  getEditorView: () => editorView,
  todayState: () => ({
    artifactType: 'today',
    date: documentDate.value,
    mediaType: 'text/markdown',
    content: text.value,
    updatedAt: updatedAt.value,
    loading: loading.value,
    dirty: todayDirty.value,
    live: true,
  }),
})

onUnmounted(() => {
  disposed = true
  clearTimeout(saveTimer)
  clearTimeout(savedTimer)
  clearTimeout(noticeTimer)
  window.removeEventListener('focus', handleActivation)
  document.removeEventListener('visibilitychange', handleVisibilityChange)
  if (dirty.value) void flushSave()
  editorView?.destroy()
  editorView = null
})
</script>
