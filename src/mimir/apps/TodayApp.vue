<template>
  <section
    data-today-app
    class="flex h-full min-h-0 w-full flex-col bg-surface text-ink"
  >
    <section
      v-if="showRollover"
      data-today-rollover
      class="shrink-0 border-b border-rule bg-chrome-high px-4 py-3"
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

    <PaneBand as="footer" kind="footer"
      data-today-statusbar
      class="px-2"
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
    </PaneBand>
  </section>
</template>

<script setup>
import PaneBand from '../../shared/ui/chrome/PaneBand.vue'

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
import { storeToRefs } from 'pinia'
import { useTodayStore } from '../../stores/today.js'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, drawSelection, keymap, placeholder } from '@codemirror/view'
import {
  defaultKeymap,
  history,
  isolateHistory,
  historyKeymap,
  indentWithTab,
  selectAll as selectAllCommand,
} from '@codemirror/commands'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { tags } from '@lezer/highlight'
import { Strikethrough } from '@lezer/markdown'
import { livePreviewExtension } from '../../editor/codemirror/livePreview.js'
import { taskCheckboxExtension } from '../../editor/codemirror/taskCheckboxes.js'
import { markdownListKeymap } from '../../editor/codemirror/markdownLists.js'
import DatePicker from '../../shared/ui/DatePicker.vue'
import {
  appendMarkdownBelow,
  carrySource,
  shiftDateKey,
  stripCheckedTasks,
  uncheckedTaskBlocks,
} from './todayModel.js'
import {
  loadTodayEntry,
  loadTodayMonthDates,
} from './todayJournal.js'

const props = defineProps({
  app: { type: Object, required: true },
  instanceId: { type: String, required: true },
  active: { type: Boolean, default: false },
})

const emit = defineEmits(['diagnostic'])
const today = useTodayStore()
const {
  text, documentDate, updatedAt, previous, archiveQueue, tomorrow,
  loading, saving, dirty, todayDirty, tomorrowDirty, savedOnce, savedDate,
  error, errorAction, journalIssue, archiving,
} = storeToRefs(today)
const { markDirty, saveNow, flushSave, settlePrevious } = today
const editorHost = ref(null)
const viewDate = ref(documentDate.value)
const historyLoading = ref(false)
const notice = ref('')
const carryReview = ref(false)
const carrySelection = ref(new Set())
const calendarDatesByMonth = ref(new Map())
const calendarMonthsLoading = new Set()
let noticeTimer = null
let historyRequest = 0
let disposed = false
let editorView = null
let applyingExternalText = false
const readOnlyCompartment = new Compartment()
const contextCompartment = new Compartment()
const historyCompartment = new Compartment()

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
  try {
    await today.restore()
    if (disposed) return
    viewDate.value = documentDate.value
    prepareCarrySelection()
    syncEditorText(text.value)
    await ensureCurrentDay()
  } catch (cause) {
    reportError(`Today could not be restored: ${errorMessage(cause)}`, 'restore')
  } finally {
    updateEditorContext()
    if (props.active) await nextTick(() => editorView?.focus())
    void archivePendingEntries()
  }
}

const detachEditor = today.attachEditor(({ date, from, insert }) => {
  if (!editorView || viewDate.value !== date) return
  applyingExternalText = true
  try {
    editorView.dispatch({ changes: { from, insert }, annotations: isolateHistory.of('full') })
  } finally {
    applyingExternalText = false
  }
})

watch(documentDate, () => {
  viewDate.value = documentDate.value
  cancelHistoryLoad()
  carryReview.value = false
  prepareCarrySelection()
  syncEditorText(text.value)
  updateEditorContext()
})

watch(error, value => { if (value) emit('diagnostic', value) })

function createMarkdownEditor() {
  if (!editorHost.value || editorView) return
  const state = EditorState.create({
    doc: text.value,
    extensions: [
      EditorView.lineWrapping,
      contextCompartment.of(editorContextExtensions()),
      readOnlyCompartment.of(readOnlyExtensions(true)),
      historyCompartment.of(history()),
      drawSelection(),
      markdown({ base: markdownLanguage, extensions: [Strikethrough] }),
      markdownListKeymap,
      syntaxHighlighting(todayHighlightStyle),
      livePreviewExtension(() => true, null),
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
      spellcheck: 'false',
      autocomplete: 'off',
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
      readOnlyCompartment.reconfigure(readOnlyExtensions(loading.value || errorAction.value === 'restore' || !isEditableDate.value)),
      contextCompartment.reconfigure(editorContextExtensions()),
    ],
  })
}

function syncEditorText(value) {
  if (!editorView) return
  applyingExternalText = true
  try {
    // Date navigation is not an edit. Discard the previous document's undo stack.
    editorView.dispatch({
      changes: { from: 0, to: editorView.state.doc.length, insert: value },
      effects: historyCompartment.reconfigure([]),
    })
    editorView.dispatch({ effects: historyCompartment.reconfigure(history()) })
  } finally {
    applyingExternalText = false
  }
}

async function handleActivation() {
  if (!props.active || loading.value) return
  await ensureCurrentDay()
  void archivePendingEntries()
}

function handleVisibilityChange() {
  if (document.visibilityState === 'visible') void handleActivation()
}

async function ensureCurrentDay() {
  await today.ensureCurrentDay()
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
  const carried = stripCheckedTasks(carrySource(previous.value))
  if (carried) {
    const next = appendMarkdownBelow(text.value, carried)
    editorView?.dispatch({
      changes: { from: 0, to: editorView.state.doc.length, insert: next },
    })
    showNotice('Unfinished content carried into Today. Undo is available.')
  } else {
    showNotice('No content to carry into Today.')
  }
  resolveCarry()
}

function toggleCarry(id) {
  const next = new Set(carrySelection.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  carrySelection.value = next
}

function applySelectedCarry() {
  const source = carrySource(previous.value)
  const deselected = carryCandidates.value
    .filter(candidate => !carrySelection.value.has(candidate.id))
    .map(candidate => {
      const [start, end] = candidate.id.split(':').map(Number)
      return { start: start - 1, end }
    })
  const carried = stripCheckedTasks(source, deselected)
  if (carried) {
    const next = appendMarkdownBelow(text.value, carried)
    editorView?.dispatch({
      changes: { from: 0, to: editorView.state.doc.length, insert: next },
    })
    const count = carryCandidates.value.length - deselected.length
    showNotice(`${count} ${count === 1 ? 'item' : 'items'} carried into Today. Undo is available.`)
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
  const dates = await today.archivePendingEntries()
  for (const date of dates) markCalendarDate(date, true)
  if (dates.length && !showRollover.value) {
    showNotice(`${formatDayReference(dates.at(-1))} was filed in your Personal Journal.`)
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

function pendingEntry(date) {
  if (previous.value?.date === date) return previous.value
  return archiveQueue.value.find(entry => entry.date === date) || null
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
  detachEditor()
  clearTimeout(noticeTimer)
  window.removeEventListener('focus', handleActivation)
  document.removeEventListener('visibilitychange', handleVisibilityChange)
  if (dirty.value) void flushSave()
  editorView?.destroy()
  editorView = null
})
</script>
