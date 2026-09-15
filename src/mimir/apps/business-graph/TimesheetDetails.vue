<template>
  <section ref="sheetRoot" class="time-sheet" aria-label="Time sheet" @keydown="onKeydown">
    <div class="time-properties">
      <div>
        <span class="time-label">Project</span>
        <div class="time-relation">
          <GraphSelect :model-value="draft.projectId" :options="projectOptions" variant="quiet"
            aria-label="Time sheet project" searchable search-placeholder="Find a project"
            @update:model-value="updateDraft('projectId', $event)" />
          <button v-if="relatedTarget(draft.projectId)" type="button" data-graph-control="time-open-project"
            :aria-label="`Open project: ${displayTitle(relatedTarget(draft.projectId))}`" @click="openRelated(draft.projectId)"><IconArrowUpRight :size="14" /></button>
        </div>
      </div>
      <div>
        <span class="time-label">Person</span>
        <div class="time-relation">
          <GraphSelect :model-value="draft.assigneeId" :options="personOptions" variant="quiet"
            aria-label="Time sheet person" searchable search-placeholder="Find a person"
            @update:model-value="updateDraft('assigneeId', $event)" />
          <button v-if="relatedTarget(draft.assigneeId)" type="button" data-graph-control="time-open-person"
            :aria-label="`Open person: ${displayTitle(relatedTarget(draft.assigneeId))}`" @click="openRelated(draft.assigneeId)"><IconArrowUpRight :size="14" /></button>
        </div>
      </div>
      <label>
        <span class="time-label">Month</span>
        <input :value="draft.timePeriod" data-graph-control="time-period" aria-label="Time sheet month"
          placeholder="YYYY-MM" maxlength="7" autocorrect="off" autocapitalize="off" spellcheck="false"
          :aria-invalid="problems.some(problem => problem.field === 'period')"
          @input="updateDraft('timePeriod', $event.target.value)" />
      </label>
    </div>

    <div class="time-totals" aria-label="Month totals" aria-live="polite">
      <span>Open <strong data-time-open>{{ formatMinutes(totals.open) }}</strong></span>
      <span>Invoiced <strong data-time-invoiced>{{ formatMinutes(totals.invoiced) }}</strong></span>
      <span>Total <strong data-time-total>{{ formatMinutes(totals.total) }}</strong></span>
      <span v-if="totals.incomplete" class="time-error">Incomplete</span>
    </div>
    <p v-if="problems.length" class="time-error" role="status" data-time-errors>
      {{ problems.length }} {{ problems.length === 1 ? 'field needs' : 'fields need' }} correction. Totals exclude invalid rows.
      <template v-for="problem in generalProblems" :key="problem.field"> {{ problem.message }}</template>
    </p>
    <p v-if="!editableRows" class="time-error">
      Repair the row structure in <button type="button" data-graph-control="time-repair-source" @click="emit('source')">Source</button>.
    </p>

    <div class="time-tools">
      <span class="time-label">Show</span>
      <GraphSelect v-model="state.filter" :options="filterOptions" variant="quiet" aria-label="Time row filter" />
      <button v-if="state.filter" type="button" data-graph-control="time-clear-filter" @click="state.filter = ''">Clear filter</button>
      <span class="time-spacer" />
      <button type="button" data-graph-control="time-undo" :disabled="!state.undo.length" @click="undo">Undo</button>
      <button type="button" data-graph-control="time-redo" :disabled="!state.redo.length" @click="redo">Redo</button>
    </div>

    <div v-if="editableRows" class="time-table-scroll" tabindex="0" aria-label="Time rows">
      <table>
        <caption class="sr-only">Work recorded for {{ draft.timePeriod }}</caption>
        <colgroup><col class="time-check-col" /><col class="time-date-col" /><col /><col class="time-duration-col" /><col class="time-invoice-col" /><col class="time-actions-col" /></colgroup>
        <thead><tr>
          <th scope="col"><button type="button" role="checkbox" :aria-checked="allSelected ? 'true' : selectedRows.length ? 'mixed' : 'false'"
            aria-label="Select all shown rows" data-graph-control="time-select-all" class="time-check" :disabled="!visibleRows.length" @click="selectAll">
            <IconCheck v-if="allSelected" :size="13" /><IconMinus v-else-if="selectedRows.length" :size="13" />
          </button></th>
          <th scope="col">Date</th><th scope="col">Work</th><th scope="col">Duration</th><th scope="col">Invoice</th><th scope="col"><span class="sr-only">Row actions</span></th>
        </tr></thead>
        <tbody>
          <tr v-for="item in visibleRows" :key="item.row.entry.id" :data-time-row="item.row.entry.id" :class="{ 'is-selected': state.selected.includes(item.row.entry.id) }">
            <td><button type="button" role="checkbox" :aria-checked="state.selected.includes(item.row.entry.id)" class="time-check"
              :aria-label="`Select row ${item.index + 1}`" :data-graph-control="`time-select-${item.row.entry.id}`" @click="selectRow(item.row.entry.id, $event.shiftKey)">
              <IconCheck v-if="state.selected.includes(item.row.entry.id)" :size="13" />
            </button></td>
            <td>
              <GraphDatePicker :model-value="typeof item.row.entry.date === 'string' ? item.row.entry.date : ''" variant="quiet"
                :aria-label="`Date for row ${item.index + 1}`" placeholder="Choose date" :aria-invalid="Boolean(problemFor(item.index, 'date'))"
                @update:model-value="edit(item, 'date', $event)">
                <template #trigger><span class="time-short-date">{{ shortDate(item.row.entry.date) }}</span></template>
              </GraphDatePicker>
              <small v-if="problemFor(item.index, 'date')" class="time-error">{{ problemFor(item.index, 'date') }}</small>
            </td>
            <td>
              <input :value="item.row.entry.description" :data-graph-control="`time-work-${item.row.entry.id}`" :aria-label="`Work for row ${item.index + 1}`"
                :aria-invalid="Boolean(problemFor(item.index, 'description'))" placeholder="Describe the work" @input="edit(item, 'description', $event.target.value)" @blur="endEdit" />
              <small v-if="problemFor(item.index, 'description')" class="time-error">{{ problemFor(item.index, 'description') }}</small>
            </td>
            <td>
              <input :value="item.row.duration" :data-graph-control="`time-duration-${item.row.entry.id}`" :aria-label="`Duration for row ${item.index + 1}`"
                :aria-invalid="Boolean(problemFor(item.index, 'minutes'))" placeholder="1h 30m" autocorrect="off" autocapitalize="off" spellcheck="false"
                @input="edit(item, 'duration', $event.target.value)" @blur="endEdit" />
              <small v-if="problemFor(item.index, 'minutes')" class="time-error">{{ problemFor(item.index, 'minutes') }}</small>
            </td>
            <td>
              <input :value="item.row.entry.invoice || ''" :data-graph-control="`time-invoice-${item.row.entry.id}`" :aria-label="`Invoice for row ${item.index + 1}`"
                :aria-invalid="Boolean(problemFor(item.index, 'invoice'))" placeholder="Open" autocorrect="off" autocapitalize="off" spellcheck="false"
                @input="edit(item, 'invoice', $event.target.value)" @blur="endEdit" />
              <small v-if="problemFor(item.index, 'invoice')" class="time-error">{{ problemFor(item.index, 'invoice') }}</small>
            </td>
            <td class="time-row-actions">
              <button type="button" :data-graph-control="`time-duplicate-${item.row.entry.id}`" :aria-label="`Duplicate row ${item.index + 1}`" title="Duplicate row" @click="duplicate(item)"><IconCopy :size="14" /></button>
              <button type="button" :data-graph-control="`time-delete-${item.row.entry.id}`" :aria-label="`Delete row ${item.index + 1}`" title="Delete row" @click="remove(item)"><IconTrash :size="14" /></button>
            </td>
          </tr>
          <tr v-if="!visibleRows.length"><td colspan="6" class="time-empty">{{ state.filter ? 'No rows match this filter.' : 'Add a row to record your work.' }}</td></tr>
        </tbody>
      </table>
    </div>
    <div class="time-tools">
      <button type="button" data-graph-control="time-add" :disabled="!editableRows || !validPeriod(draft.timePeriod) || entries.length >= MAX_TIME_ROWS" @click="add"><IconPlus :size="14" />Add row</button>
      <span class="time-spacer" />
      <button type="button" data-graph-control="time-export" :disabled="Boolean(problems.length) || exporting" @click="exportCsv">{{ selectedRows.length ? 'Export selected CSV' : 'Export shown CSV' }}</button>
    </div>
    <div v-if="selectedRows.length" class="time-selection" aria-live="polite">
      <strong data-time-selected>Selected: {{ selectedRows.length }} {{ selectedRows.length === 1 ? 'row' : 'rows' }} · {{ formatMinutes(selectedTotal.total) }}{{ selectedTotal.incomplete ? ' · Incomplete' : '' }}</strong>
      <div class="time-tools">
        <button type="button" data-graph-control="time-clear-selection" @click="clearSelection">Clear selection</button>
        <button type="button" data-graph-control="time-mark-invoiced" :disabled="selectedTotal.incomplete || !selectedOpen.length" @click="startInvoice">Mark invoiced…</button>
        <button type="button" data-graph-control="time-mark-open" :disabled="selectedTotal.incomplete || !selectedInvoiced.length" @click="markOpen">Mark open</button>
      </div>
      <form v-if="invoiceOpen" class="time-invoice-form" @submit.prevent="markInvoiced" @keydown.esc.stop.prevent="invoiceOpen = false">
        <label>Invoice reference<input ref="invoiceInput" v-model="invoiceReference" data-graph-control="time-invoice-reference" aria-label="Invoice reference" placeholder="INV-014" autocorrect="off" autocapitalize="off" spellcheck="false" /></label>
        <button type="submit" data-graph-control="time-apply-invoice" :disabled="!invoiceReference.trim() || selectedTotal.incomplete">Apply to {{ selectedOpen.length }} open {{ selectedOpen.length === 1 ? 'row' : 'rows' }}</button>
        <button type="button" data-graph-control="time-cancel-invoice" @click="invoiceOpen = false">Cancel</button>
      </form>
    </div>
    <p v-if="notice" role="status" class="time-notice">{{ notice }}</p>
    <p v-if="exportError" role="alert" class="time-error">{{ exportError }}</p>
  </section>
</template>

<script setup>
import { computed, inject, nextTick, reactive, ref, watch } from 'vue'
import { IconArrowUpRight, IconCheck, IconCopy, IconMinus, IconPlus, IconTrash } from '@tabler/icons-vue'
import GraphDatePicker from './GraphDatePicker.vue'
import GraphSelect from './GraphSelect.vue'
import { GRAPH_INSPECTOR_CONTEXT } from './graphInspectorContext.js'
import { exportTimesheetCsv } from '../../../services/timesheetExport.js'
import { MAX_TIME_ROWS, formatMinutes, hydrateTimeRows, isTimeRow, localTimeDate, timeEntries, timeProblems, timeTotals, timesheetCsv, validPeriod, validTimeDate } from './timesheet.js'

const { draft, viewState, projectOptions, personOptions, relatedTarget, displayTitle, openRelated, changed, updateDraft, emit } = inject(GRAPH_INSPECTOR_CONTEXT)
const sheetRoot = ref(null)
const clone = value => JSON.parse(JSON.stringify(value))
const state = reactive(viewState.value?.timesheet || { filter: '', selected: [], anchor: '', undo: [], redo: [], expected: null })
if (viewState.value) viewState.value.timesheet = state
const invoiceOpen = ref(false), invoiceReference = ref(''), invoiceInput = ref(null)
const exporting = ref(false), exportError = ref(''), notice = ref('')
let editKey = ''
const entries = computed(() => timeEntries(draft.value.timeRows))
const problems = computed(() => timeProblems(draft.value.timePeriod, entries.value))
const generalProblems = computed(() => problems.value.filter(problem => problem.row === null))
const editableRows = computed(() => Array.isArray(draft.value.timeRows) && !problems.value.some(problem => ['id', 'entry'].includes(problem.field)))
const totals = computed(() => timeTotals(entries.value, problems.value))
const filterOptions = computed(() => [
  { value: '', label: 'All' }, { value: 'open', label: 'Open' }, { value: 'invoiced', label: 'Invoiced' },
  ...[...new Set((Array.isArray(entries.value) ? entries.value : []).filter(isTimeRow).map(row => row.invoice).filter(value => typeof value === 'string' && value.trim()))]
    .sort().map(invoice => ({ value: `invoice:${invoice}`, label: `Invoice ${invoice}` })),
])
const visibleRows = computed(() => !editableRows.value ? [] : draft.value.timeRows.map((row, index) => ({ row, index })).filter(({ row }) => {
  if (state.filter === 'open') return !row.entry.invoice
  if (state.filter === 'invoiced') return Boolean(row.entry.invoice)
  if (state.filter.startsWith('invoice:')) return row.entry.invoice === state.filter.slice(8)
  return true
}))
const selectedRows = computed(() => visibleRows.value.filter(item => state.selected.includes(item.row.entry.id)))
const selectedOpen = computed(() => selectedRows.value.filter(item => !item.row.entry.invoice))
const selectedInvoiced = computed(() => selectedRows.value.filter(item => item.row.entry.invoice))
const selectedTotal = computed(() => {
  const selected = timeEntries(selectedRows.value.map(item => item.row))
  return timeTotals(selected, timeProblems(draft.value.timePeriod, selected))
})
const allSelected = computed(() => visibleRows.value.length > 0 && selectedRows.value.length === visibleRows.value.length)
const fingerprint = () => JSON.stringify([draft.value.timePeriod, entries.value])

// Undo belongs to this tab. Source and external replacements invalidate it.
watch(() => JSON.stringify([draft.value.timePeriod, entries.value]), value => {
  if (state.expected !== null && state.expected !== value) { state.undo = []; state.redo = []; editKey = '' }
  state.expected = value
}, { immediate: true, flush: 'post' })
watch(() => state.filter, clearSelection)
watch(() => visibleRows.value.map(item => item.row.entry.id), ids => {
  state.selected = state.selected.filter(id => ids.includes(id))
  if (!state.selected.length) invoiceOpen.value = false
})

function problemFor(index, field) { return problems.value.find(problem => problem.row === index && problem.field === field)?.message || '' }
function shortDate(value) { return validTimeDate(value) ? new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(new Date(`${value}T12:00:00`)) : 'Choose date' }
function remember(key = '') {
  if (!key || key !== editKey) {
    state.undo.push(clone(draft.value.timeRows))
    if (state.undo.length > 50) state.undo.shift()
  }
  state.redo = []
  editKey = key
}
function finish() { state.expected = fingerprint(); changed() }
function endEdit() { editKey = '' }
function edit(item, field, value) {
  remember(`${item.row.entry.id}:${field}`)
  if (field === 'duration') { item.row.duration = value; item.row.editedDuration = true }
  else if (field === 'invoice') {
    if (value.trim()) item.row.entry.invoice = value
    else delete item.row.entry.invoice
  } else item.row.entry[field] = value
  finish()
}
async function add() {
  remember()
  state.filter = ''
  const today = localTimeDate()
  const id = `time-${crypto.randomUUID()}`
  draft.value.timeRows.push(...hydrateTimeRows([{ id, date: today.startsWith(draft.value.timePeriod) ? today : `${draft.value.timePeriod}-01`, minutes: null, description: '' }]))
  finish()
  await nextTick()
  sheetRoot.value?.querySelector(`[data-graph-control="time-work-${id}"]`)?.focus()
}
function duplicate(item) {
  if (draft.value.timeRows.length >= MAX_TIME_ROWS) return
  remember()
  const row = clone(item.row)
  row.entry.id = `time-${crypto.randomUUID()}`
  delete row.entry.invoice
  draft.value.timeRows.splice(item.index + 1, 0, row)
  state.filter = ''
  notice.value = 'Row duplicated as Open.'
  finish()
}
function remove(item) { remember(); draft.value.timeRows.splice(item.index, 1); notice.value = 'Row deleted. Undo is available.'; finish() }
function undo() {
  if (!state.undo.length) return
  state.redo.push(clone(draft.value.timeRows)); draft.value.timeRows = state.undo.pop(); editKey = ''; finish()
}
function redo() {
  if (!state.redo.length) return
  state.undo.push(clone(draft.value.timeRows)); draft.value.timeRows = state.redo.pop(); editKey = ''; finish()
}
function clearSelection() { state.selected = []; state.anchor = ''; invoiceOpen.value = false }
function selectAll() { state.selected = allSelected.value ? [] : visibleRows.value.map(item => item.row.entry.id); state.anchor = '' }
function selectRow(id, range) {
  const ids = visibleRows.value.map(item => item.row.entry.id)
  const next = new Set(state.selected), checked = !next.has(id)
  const anchor = ids.indexOf(state.anchor), current = ids.indexOf(id)
  const targets = range && anchor >= 0 ? ids.slice(Math.min(anchor, current), Math.max(anchor, current) + 1) : [id]
  for (const target of targets) { if (checked) next.add(target); else next.delete(target) }
  state.selected = [...next]; state.anchor = id
}
async function startInvoice() { invoiceOpen.value = true; invoiceReference.value = ''; await nextTick(); invoiceInput.value?.focus() }
function markInvoiced() {
  if (!invoiceReference.value.trim() || selectedTotal.value.incomplete || !selectedOpen.value.length) return
  remember()
  const rows = [...selectedOpen.value]
  for (const item of rows) item.row.entry.invoice = invoiceReference.value.trim()
  notice.value = `${rows.length} ${rows.length === 1 ? 'row marked' : 'rows marked'} invoiced.`
  invoiceOpen.value = false
  finish()
  focusAfterAction('time-mark-open')
}
function markOpen() {
  if (selectedTotal.value.incomplete || !selectedInvoiced.value.length) return
  remember()
  for (const item of [...selectedInvoiced.value]) delete item.row.entry.invoice
  notice.value = 'Selected invoiced rows marked Open.'
  finish()
  focusAfterAction('time-mark-invoiced')
}
async function focusAfterAction(control) {
  await nextTick()
  const target = sheetRoot.value?.querySelector(`[data-graph-control="${control}"]:not(:disabled)`)
    || sheetRoot.value?.querySelector('[data-graph-control="time-add"]')
  target?.focus()
}
async function exportCsv() {
  if (problems.value.length || exporting.value) return
  exporting.value = true; exportError.value = ''
  try {
    // Freeze the reviewed rows before opening the native file dialog.
    const content = timesheetCsv({ title: draft.value.title, period: draft.value.timePeriod,
      project: relatedTarget(draft.value.projectId)?.title || '', person: relatedTarget(draft.value.assigneeId)?.title || '',
      entries: timeEntries((selectedRows.value.length ? selectedRows.value : visibleRows.value).map(item => item.row)) })
    if (await exportTimesheetCsv(`${draft.value.title}-${draft.value.timePeriod}`, content)) notice.value = 'CSV exported.'
  } catch (cause) { exportError.value = String(cause?.message || cause) }
  finally { exporting.value = false }
}
function onKeydown(event) {
  if (event.isComposing || event.keyCode === 229) return
  if (['time-period', 'time-invoice-reference'].includes(event.target?.getAttribute?.('data-graph-control'))) return
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && !event.altKey) {
    event.preventDefault(); event.stopPropagation(); if (event.shiftKey) redo(); else undo()
  }
}
</script>

<style scoped>
.time-sheet { margin-top: 14px; color: var(--color-ink-2); font-size: 12px; }
.time-properties { display: grid; grid-template-columns: 1fr 1fr 104px; gap: 12px; align-items: start; }
.time-properties > *, .time-relation > :first-child { min-width: 0; }
.time-label { color: var(--color-ink-3); font-size: 11px; }
.time-properties .time-label { display: block; margin-bottom: 3px; }
.time-relation { display: flex; align-items: center; }
.time-relation > :first-child { flex: 1; }
.time-sheet input { display: block; width: 100%; min-width: 0; min-height: 30px; border: 1px solid transparent; background: transparent; padding: 4px; color: var(--color-ink); font: inherit; user-select: text; }
.time-sheet input:hover { background: var(--color-chrome-mid); }
.time-sheet input::placeholder { color: var(--color-ink-4); }
.time-sheet input[aria-invalid="true"] { border-bottom-color: var(--color-rem); }
.time-sheet button { display: inline-flex; min-height: 28px; align-items: center; justify-content: center; gap: 5px; padding: 3px 5px; color: var(--color-ink-3); font-size: 11px; }
.time-sheet button:hover { background: var(--color-chrome-mid); color: var(--color-ink); }
.time-sheet :is(button, input):focus-visible, .time-table-scroll:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 1px; }
.time-sheet input:focus-visible { border-color: var(--color-rule); background: var(--color-surface); }
.time-sheet button:disabled { opacity: 0.45; cursor: default; }
.time-totals { display: flex; flex-wrap: wrap; gap: 8px 20px; margin-top: 14px; padding: 10px 0; border-block: 1px solid var(--color-rule); font-size: 11px; }
.time-totals strong { margin-inline-start: 5px; color: var(--color-ink); font-variant-numeric: tabular-nums; font-size: 13px; }
.time-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 5px 0; }
.time-tools > :deep(.graph-select-trigger) { min-width: 100px; max-width: 230px; }
.time-spacer { flex: 1; }
.time-table-scroll { overflow-x: auto; }
table { width: 100%; min-width: 530px; border-collapse: collapse; table-layout: fixed; }
.time-check-col { width: 28px; }.time-date-col { width: 94px; }.time-duration-col { width: 88px; }.time-invoice-col { width: 96px; }.time-actions-col { width: 52px; }
th { height: 30px; color: var(--color-ink-3); font-size: 11px; font-weight: 600; text-align: left; }
td { padding: 3px 1px; border-top: 1px solid var(--color-rule-light); vertical-align: top; }
td small { display: block; padding: 2px 4px; font-size: 10px; }
tbody tr:hover { background: var(--color-chrome-mid); }
tbody tr.is-selected { background: var(--color-accent-soft); }
.time-sheet .time-check { width: 18px; min-height: 18px; height: 18px; margin: 6px 4px; padding: 0; border: 1px solid var(--color-rule); }
.time-check[aria-checked="true"], .time-check[aria-checked="mixed"] { color: var(--color-accent); border-color: var(--color-accent); }
.time-row-actions { white-space: nowrap; }
.time-short-date { white-space: nowrap; font-weight: 400; }
.time-row-actions button { padding: 3px 4px; }
.time-empty { padding: 18px 4px; color: var(--color-ink-3); }
.time-selection { margin-top: 4px; padding: 10px 0; border-top: 1px solid var(--color-rule); }
.time-selection > strong { font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
.time-invoice-form { display: flex; flex-wrap: wrap; align-items: end; gap: 8px; padding-top: 8px; }
.time-invoice-form label { font-size: 11px; }
.time-invoice-form input { width: 160px; border-color: var(--color-rule); }
.time-invoice-form button[type="submit"] { background: var(--color-accent); color: var(--color-accent-ink); }
.time-error { color: var(--color-rem); font-size: 11px; line-height: 1.5; margin: 5px 0; overflow-wrap: anywhere; }
.time-notice { color: var(--color-ink-3); font-size: 11px; margin: 5px 0; }
@container graph-document (max-width: 420px) { .time-properties { grid-template-columns: 1fr 1fr; } .time-properties > label { grid-column: 1 / -1; max-width: 120px; } }
</style>
