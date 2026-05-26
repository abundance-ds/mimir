<template>
  <div class="flex flex-col flex-1 min-h-0">
    <!-- Format segmented control -->
    <div class="h-[26px] shrink-0 border-b border-rule-light flex items-center px-3">
      <div class="flex h-5 bg-chrome border border-rule rounded-full p-px">
        <button
          v-for="fmt in formats"
          :key="fmt"
          class="px-3 font-sans text-[9px] font-medium tracking-wide rounded-full"
          :class="settings.exportFormat === fmt ? 'bg-surface text-ink font-semibold' : 'text-ink-3 hover:text-ink-2 hover:bg-chrome-mid'"
          @click="settings.set('exportFormat', fmt)"
        >{{ fmt.toUpperCase() }}</button>
      </div>
    </div>

    <div class="flex-1 overflow-y-auto overflow-x-hidden">
      <!-- Empty document state -->
      <div v-if="!currentContent" class="text-[11px] font-sans text-ink-3 text-center py-8">
        Open or write a document to export
      </div>

      <template v-else>
        <!-- PDF settings -->
        <template v-if="settings.exportFormat === 'pdf'">
          <ExportRow label="Template">
            <ExportDropdown :value="settings.exportPdfTemplate" :options="templateOptions" @select="settings.set('exportPdfTemplate', $event)" />
          </ExportRow>
          <ExportRow label="Citation style">
            <ExportDropdown :value="settings.exportCitationStyle" :options="citationOptions" @select="settings.set('exportCitationStyle', $event)" />
          </ExportRow>
          <ExportRow label="Bibliography">
            <button
              class="font-mono text-[10px] hover:bg-chrome-mid rounded"
              :class="settings.exportBibliography ? 'text-ink-2' : 'text-ink-3'"
              @click="settings.set('exportBibliography', !settings.exportBibliography)"
            >{{ settings.exportBibliography ? 'Include' : 'Exclude' }}</button>
          </ExportRow>
          <ExportRow label="Page size">
            <SegControl :value="settings.exportPdfPageSize" :options="pageSizeOptions" @select="settings.set('exportPdfPageSize', $event)" />
          </ExportRow>
        </template>

        <!-- DOCX settings -->
        <template v-if="settings.exportFormat === 'docx'">
          <ExportRow label="Font">
            <ExportDropdown :value="settings.exportDocxFont" :options="fontOptions" @select="settings.set('exportDocxFont', $event)" />
          </ExportRow>
          <ExportRow label="Page size">
            <SegControl :value="settings.exportDocxPageSize" :options="pageSizeOptions" @select="settings.set('exportDocxPageSize', $event)" />
          </ExportRow>
        </template>

        <!-- Unresolved citations -->
        <div v-if="unresolvedCitationKeys.length > 0" class="px-3 pt-2">
          <p class="font-mono text-[10px] text-ink-3">Unresolved citations: {{ unresolvedCitationKeys.join(', ') }}</p>
        </div>

        <!-- Export button + result -->
        <div class="p-3 flex flex-col gap-2">
          <button
            class="w-full h-[28px] rounded-[4px] font-sans text-[10.5px] font-semibold flex items-center justify-center border"
            :class="exporting
              ? 'bg-accent text-accent-ink border-accent opacity-80 cursor-wait'
              : 'bg-accent text-accent-ink border-accent hover:opacity-90'"
            :disabled="exporting"
            @click="doExport"
          >
            <template v-if="exporting">Exporting...</template>
            <template v-else>Export {{ settings.exportFormat.toUpperCase() }}</template>
          </button>

          <p v-if="exportResult" class="font-sans text-[10px] leading-tight" :class="exportResult.ok ? 'text-ink-3' : 'text-accent'">
            {{ exportResult.message }}
          </p>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, h, onMounted, onBeforeUnmount } from 'vue'
import { exportPdf } from '../../../services/export/pdf.js'
import { exportDocx } from '../../../services/export/docx.js'
import { saveExportDialog, writeBinaryFile } from '../../../services/fileSystem.js'
import { extractCitedKeys } from '../../../services/references.js'
import { logAudit } from '../../../services/audit.js'
import { useFileStore } from '../../../stores/files.js'
import { useSettingsStore } from '../../../stores/settings.js'

const fileStore = useFileStore()
const settings = useSettingsStore()

const props = defineProps({
  references: { type: Array, default: () => [] },
})

const formats = ['pdf', 'docx']

const currentContent = computed(() => fileStore.currentFile?.content ?? '')
const currentPath = computed(() => fileStore.currentFile?.path ?? '')

const documentBaseName = computed(() => {
  if (!currentPath.value) return 'Untitled'
  const parts = currentPath.value.split(/[/\\]/)
  const name = parts[parts.length - 1] || 'Untitled'
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.substring(0, dot) : name
})

// --- Options ---

const templateOptions = [
  { value: 'clean', label: 'Clean' },
  { value: 'academic', label: 'Academic' },
  { value: 'report', label: 'Report' },
  { value: 'letter', label: 'Letter' },
  { value: 'compact', label: 'Compact' },
]

const citationOptions = [
  { value: 'apa', label: 'APA 7th' },
  { value: 'chicago', label: 'Chicago' },
  { value: 'ieee', label: 'IEEE' },
  { value: 'vancouver', label: 'Vancouver' },
  { value: 'mla', label: 'MLA 9th' },
]

const fontOptions = [
  { value: 'Calibri', label: 'Calibri' },
  { value: 'Times New Roman', label: 'Times New Roman' },
  { value: 'Arial', label: 'Arial' },
  { value: 'Georgia', label: 'Georgia' },
  { value: 'Helvetica', label: 'Helvetica' },
  { value: 'Garamond', label: 'Garamond' },
]

const pageSizeOptions = [
  { value: 'a4', label: 'A4' },
  { value: 'us-letter', label: 'US Letter' },
]

// --- Unresolved citations ---

const unresolvedCitationKeys = computed(() => {
  if (!currentContent.value) return []
  const citedKeys = extractCitedKeys(currentContent.value)
  if (citedKeys.length === 0) return []
  const refKeys = new Set(props.references.map(r => r._key || r.id))
  return citedKeys.filter(k => !refKeys.has(k))
})

// --- Export state ---

const exporting = ref(false)
const exportResult = ref(null)
let resultTimer = null

function showResult(ok, message) {
  exportResult.value = { ok, message }
  clearTimeout(resultTimer)
  resultTimer = setTimeout(() => { exportResult.value = null }, ok ? 5000 : 15000)
}

// --- BibTeX generation from CSL-JSON ---

function cslToBibtex(refs) {
  return refs.map(ref => {
    const key = ref._key || ref.id || 'unknown'
    const type = cslTypeToBibtex(ref.type)
    const fields = []
    if (ref.title) fields.push(`  title = {${ref.title}}`)
    if (ref.author?.length) {
      const authors = ref.author.map(a => {
        if (a.family && a.given) return `${a.family}, ${a.given}`
        return a.family || a.given || ''
      }).filter(Boolean).join(' and ')
      fields.push(`  author = {${authors}}`)
    }
    if (ref.issued?.['date-parts']?.[0]) {
      const dp = ref.issued['date-parts'][0]
      if (dp[0]) fields.push(`  year = {${dp[0]}}`)
    }
    if (ref['container-title']) fields.push(`  journal = {${ref['container-title']}}`)
    if (ref.volume) fields.push(`  volume = {${ref.volume}}`)
    if (ref.issue) fields.push(`  number = {${ref.issue}}`)
    if (ref.page) fields.push(`  pages = {${ref.page.replace('-', '--')}}`)
    if (ref.DOI) fields.push(`  doi = {${ref.DOI}}`)
    if (ref.URL) fields.push(`  url = {${ref.URL}}`)
    if (ref.publisher) fields.push(`  publisher = {${ref.publisher}}`)
    return `@${type}{${key},\n${fields.join(',\n')}\n}`
  }).join('\n\n')
}

function cslTypeToBibtex(cslType) {
  const map = {
    'article-journal': 'article',
    'paper-conference': 'inproceedings',
    book: 'book',
    chapter: 'incollection',
    thesis: 'phdthesis',
    report: 'techreport',
    manuscript: 'unpublished',
  }
  return map[cslType] || 'misc'
}

// --- Export ---

async function doExport() {
  if (exporting.value || !currentContent.value) return
  exporting.value = true
  exportResult.value = null
  try {
    if (settings.exportFormat === 'pdf') await doExportPdf()
    else if (settings.exportFormat === 'docx') await doExportDocx()
    logAudit('export.run', {
      format: settings.exportFormat,
      template: settings.exportFormat === 'pdf' ? settings.exportPdfTemplate : undefined,
      fileName: documentBaseName.value,
    })
  } catch (err) {
    showResult(false, err?.message || String(err))
  } finally {
    exporting.value = false
  }
}

async function doExportPdf() {
  const defaultName = documentBaseName.value + '.pdf'
  const defaultDir = currentPath.value ? currentPath.value.replace(/[/\\][^/\\]*$/, '/') : ''
  const outputPath = await saveExportDialog(defaultDir + defaultName, [
    { name: 'PDF', extensions: ['pdf'] },
  ])
  if (!outputPath) return

  let bibContent = null
  const citedKeys = extractCitedKeys(currentContent.value)
  if (citedKeys.length > 0 && props.references.length > 0) {
    const citedRefs = props.references.filter(r => citedKeys.includes(r._key || r.id))
    if (citedRefs.length > 0) bibContent = cslToBibtex(citedRefs)
  }

  const result = await exportPdf({
    markdown: currentContent.value,
    outputPath,
    template: settings.exportPdfTemplate,
    fontFamily: null,
    fontSize: null,
    pageSize: settings.exportPdfPageSize,
    bibContent,
    bibStyle: settings.exportCitationStyle,
  })
  if (result) showResult(true, `Saved to ${result}`)
}

async function doExportDocx() {
  const isTauri = !!window.__TAURI_INTERNALS__
  const { blob, fileName } = await exportDocx(currentContent.value, {
    font: settings.exportDocxFont,
    fontSize: 11,
    pageSize: settings.exportDocxPageSize,
    margins: 'normal',
    title: documentBaseName.value,
  })

  if (isTauri) {
    const defaultDir = currentPath.value ? currentPath.value.replace(/[/\\][^/\\]*$/, '/') : ''
    const outputPath = await saveExportDialog(defaultDir + fileName, [
      { name: 'Word Document', extensions: ['docx'] },
    ])
    if (!outputPath) return
    const arrayBuffer = await blob.arrayBuffer()
    const bytes = new Uint8Array(arrayBuffer)
    let binary = ''
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
    await writeBinaryFile(outputPath, btoa(binary))
    showResult(true, `Saved to ${outputPath}`)
  } else {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    showResult(true, `Downloaded ${fileName}`)
  }
}

// --- Sub-components ---

const ExportRow = (props, { slots }) => h(
  'div',
  { class: 'h-8 flex items-center justify-between px-3 border-b border-rule-light font-sans text-[11px]' },
  [h('span', { class: 'text-ink-2' }, props.label), slots.default?.()],
)
ExportRow.props = ['label']

const SegControl = (props, { emit }) => h(
  'div',
  { class: 'flex h-5 bg-chrome border border-rule rounded-full p-px' },
  props.options.map(opt => h('button', {
    class: [
      'px-2.5 font-mono text-[9px] rounded-full',
      props.value === opt.value ? 'bg-surface text-ink font-semibold' : 'text-ink-3 hover:text-ink-2',
    ],
    onClick: () => emit('select', opt.value),
  }, opt.label)),
)
SegControl.props = ['value', 'options']
SegControl.emits = ['select']

// --- Dropdown sub-component ---

const openDropdown = ref(null)

function onDocumentClick() { openDropdown.value = null }
onMounted(() => document.addEventListener('click', onDocumentClick))
onBeforeUnmount(() => document.removeEventListener('click', onDocumentClick))

const ExportDropdown = {
  props: ['value', 'options'],
  emits: ['select'],
  setup(props, { emit }) {
    const id = Math.random().toString(36).slice(2, 8)
    const isOpen = computed(() => openDropdown.value === id)
    const displayLabel = computed(() => props.options.find(o => o.value === props.value)?.label ?? props.value)

    return () => h('div', { class: 'relative' }, [
      h('button', {
        class: 'flex items-center gap-1.5 bg-surface border border-rule rounded-[4px] px-2 h-[22px] font-sans text-[11px] text-ink-2',
        onClick: (e) => { e.stopPropagation(); openDropdown.value = isOpen.value ? null : id },
      }, [
        h('span', null, displayLabel.value),
        h('svg', { class: 'w-2.5 h-2.5 text-ink-3 shrink-0', viewBox: '0 0 10 6', fill: 'none', innerHTML: '<path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>' }),
      ]),
      isOpen.value ? h('div', {
        class: 'absolute right-0 top-[calc(100%+4px)] z-50 min-w-[140px] bg-surface border border-rule rounded-[6px] py-1 overflow-hidden',
      }, props.options.map(opt => h('button', {
        class: [
          'w-full flex items-center justify-between px-2 py-[5px] font-sans text-[11px] text-ink-2 hover:bg-chrome-high',
        ],
        onClick: () => { emit('select', opt.value); openDropdown.value = null },
      }, [
        h('span', null, opt.label),
        props.value === opt.value ? h('svg', { class: 'w-3 h-3 text-accent shrink-0', viewBox: '0 0 12 12', fill: 'none', innerHTML: '<path d="M2 6l3 3 5-6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' }) : null,
      ]))) : null,
    ])
  },
}
</script>
