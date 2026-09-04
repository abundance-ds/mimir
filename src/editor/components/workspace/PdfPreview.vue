<template>
  <section class="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col bg-chrome-high text-ink">
    <header data-pdf-toolbar class="pane-bar gap-1">
      <button
        type="button"
        title="Previous page"
        aria-label="Previous page"
        :disabled="pageNumber <= 1 || loading"
        class="grid size-7 place-items-center text-ink-3 hover:bg-chrome hover:text-ink disabled:opacity-30"
        @click="goToPage(pageNumber - 1)"
      >
        <IconChevronLeft :size="15" :stroke-width="1.8" />
      </button>
      <label class="flex h-7 items-center border border-rule-light bg-surface px-2 font-mono text-[9px] text-ink-3">
        <span class="sr-only">PDF page</span>
        <input
          :value="pageNumber"
          type="number"
          min="1"
          :max="pageCount || 1"
          class="w-7 appearance-none bg-transparent text-right text-ink outline-none focus-visible:ring-1 focus-visible:ring-accent [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          @change="onPageInput($event)"
        />
        <span class="mx-1 text-ink-4">/</span>
        <span>{{ pageCount || '—' }}</span>
      </label>
      <button
        type="button"
        title="Next page"
        aria-label="Next page"
        :disabled="pageNumber >= pageCount || loading"
        class="grid size-7 place-items-center text-ink-3 hover:bg-chrome hover:text-ink disabled:opacity-30"
        @click="goToPage(pageNumber + 1)"
      >
        <IconChevronRight :size="15" :stroke-width="1.8" />
      </button>

      <span class="mx-1 h-4 w-px bg-rule" />
      <button
        type="button"
        title="Zoom out"
        aria-label="Zoom out"
        class="grid size-7 place-items-center text-ink-3 hover:bg-chrome hover:text-ink"
        @click="setZoom(zoom - 0.1)"
      >
        <IconZoomOut :size="14" :stroke-width="1.8" />
      </button>
      <button
        type="button"
        title="Fit page width"
        class="h-7 min-w-12 px-1 font-mono text-[9px] text-ink-3 hover:bg-chrome hover:text-ink"
        @click="zoom = 1"
      >
        {{ Math.round(zoom * 100) }}%
      </button>
      <button
        type="button"
        title="Zoom in"
        aria-label="Zoom in"
        class="grid size-7 place-items-center text-ink-3 hover:bg-chrome hover:text-ink"
        @click="setZoom(zoom + 0.1)"
      >
        <IconZoomIn :size="14" :stroke-width="1.8" />
      </button>

      <button
        type="button"
        class="ml-auto flex h-7 items-center gap-1.5 px-2 text-[9px] font-medium text-ink-3 hover:bg-chrome hover:text-ink"
        @click="$emit('openNative')"
      >
        <IconExternalLink :size="13" :stroke-width="1.8" />
        Open in default app
      </button>
    </header>

    <div
      ref="scroller"
      tabindex="0"
      class="min-h-0 flex-1 overflow-auto bg-chrome p-6 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
      @scroll="onScroll"
      @wheel="onWheel"
      @keydown.left.prevent="goToPage(pageNumber - 1)"
      @keydown.right.prevent="goToPage(pageNumber + 1)"
    >
      <div v-if="loading" class="grid h-full min-h-48 place-items-center text-center">
        <div>
          <IconLoader2 :size="20" :stroke-width="1.6" class="mx-auto animate-spin text-accent" />
          <p class="mt-3 font-mono text-[9px] uppercase tracking-[0.12em] text-ink-3">Rendering PDF</p>
        </div>
      </div>
      <div v-else-if="error" class="grid h-full min-h-48 place-items-center px-8 text-center">
        <div class="max-w-sm">
          <IconAlertTriangle :size="22" :stroke-width="1.5" class="mx-auto text-rem" />
          <p class="mt-3 text-[12px] font-semibold">PDF preview unavailable</p>
          <p class="mt-1 text-[10px] leading-relaxed text-ink-3">{{ error }}</p>
          <button
            type="button"
            class="mt-4 h-8 bg-accent px-3 text-[10px] font-semibold text-accent-ink"
            @click="$emit('openNative')"
          >
            Open in default app
          </button>
        </div>
      </div>
      <div v-else class="mx-auto flex w-max min-w-full flex-col items-center gap-6">
        <div
          v-for="page in pages"
          :key="page.index"
          :ref="el => setPageEl(page.index, el)"
          class="relative shrink-0 bg-white shadow-[0_10px_35px_rgba(0,0,0,0.16)]"
          :style="pageStyle(page)"
        >
          <canvas
            class="absolute inset-0 h-full w-full"
            :aria-label="`PDF page ${page.index} of ${pageCount}`"
          />
          <div class="pdf-text-layer" />
        </div>
      </div>
    </div>
  </section>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  IconAlertTriangle,
  IconChevronLeft,
  IconChevronRight,
  IconExternalLink,
  IconLoader2,
  IconZoomIn,
  IconZoomOut,
} from '@tabler/icons-vue'
// Legacy build required: WKWebView lacks Map.prototype.getOrInsertComputed,
// which the modern pdf.js build calls without a polyfill.
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import { readBinaryFile } from '../../../services/fileSystem.js'

const props = defineProps({
  path: { type: String, required: true },
})

defineEmits(['openNative'])

const PADDING = 24
const PAGE_GAP = 24
const MAX_CANVAS_DIM = 8192

const scroller = ref(null)
const loading = ref(true)
const error = ref('')
const pageNumber = ref(1)
const pageCount = ref(0)
const zoom = ref(1)
const fitScale = ref(1)
const pages = ref([])

const scale = computed(() => fitScale.value * zoom.value)

let pdfLib = null
let documentTask = null
let pdfDocument = null
let generation = 0
let resizeObserver = null
let resizeTimer = 0
let scrollQueued = false
let suppressScrollSync = false
const pageEls = new Map()
const rendered = new Map()

watch(() => props.path, load, { immediate: true })

watch(scale, async (next, prev) => {
  if (!pdfDocument || !prev || next === prev) return
  const el = scroller.value
  if (el && el.scrollTop) el.scrollTop = el.scrollTop * (next / prev)
  await nextTick()
  renderVisible()
})

onMounted(() => {
  if (typeof ResizeObserver === 'undefined' || !scroller.value) return
  resizeObserver = new ResizeObserver(() => {
    if (!pdfDocument) return
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(measureFit, 150)
  })
  resizeObserver.observe(scroller.value)
})

async function load() {
  const current = ++generation
  loading.value = true
  error.value = ''
  pageNumber.value = 1
  pageCount.value = 0
  pages.value = []
  clearRendered()
  await documentTask?.destroy?.()
  documentTask = null
  pdfDocument = null
  try {
    const [lib, bytes] = await Promise.all([
      import('pdfjs-dist/legacy/build/pdf.mjs'),
      readBinaryFile(props.path),
    ])
    if (current !== generation) return
    pdfLib = lib
    lib.GlobalWorkerOptions.workerSrc = workerUrl
    documentTask = lib.getDocument({ data: bytes })
    pdfDocument = await documentTask.promise
    if (current !== generation) return
    pageCount.value = pdfDocument.numPages
    const first = await pdfDocument.getPage(1)
    if (current !== generation) return
    const base = first.getViewport({ scale: 1 })
    pages.value = Array.from({ length: pdfDocument.numPages }, (_, i) => ({
      index: i + 1,
      width: base.width,
      height: base.height,
      measured: i === 0,
    }))
    loading.value = false
    await nextTick()
    if (current !== generation) return
    measureFit()
    if (scroller.value) scroller.value.scrollTop = 0
    renderVisible()
  } catch (cause) {
    if (current !== generation) return
    error.value = cause instanceof Error ? cause.message : String(cause || 'The PDF could not be rendered.')
  } finally {
    if (current === generation) loading.value = false
  }
}

function measureFit() {
  const baseWidth = pages.value[0]?.width || 612
  const available = Math.max((scroller.value?.clientWidth || 0) - PADDING * 2, 240)
  fitScale.value = Math.min(1.6, available / baseWidth)
}

function pageStyle(page) {
  return {
    width: `${Math.floor(page.width * scale.value)}px`,
    height: `${Math.floor(page.height * scale.value)}px`,
    '--scale-factor': String(scale.value),
  }
}

function pageHeight(page) {
  return Math.floor(page.height * scale.value) + PAGE_GAP
}

function pageOffset(index) {
  let y = 0
  for (let i = 0; i < index - 1; i++) y += pageHeight(pages.value[i])
  return y
}

function currentPageFromScroll() {
  const el = scroller.value
  if (!el || !pages.value.length) return 1
  const focal = el.scrollTop - PADDING + el.clientHeight * 0.35
  let y = 0
  for (const page of pages.value) {
    y += pageHeight(page)
    if (focal < y) return page.index
  }
  return pages.value.length
}

function visibleRange() {
  const el = scroller.value
  if (!el || !pages.value.length) return [1, 1]
  const top = el.scrollTop - PADDING
  const bottom = top + el.clientHeight
  let y = 0
  let first = 0
  let last = 1
  for (const page of pages.value) {
    const next = y + pageHeight(page)
    if (!first && top < next) first = page.index
    if (y <= bottom) last = page.index
    y = next
  }
  first = first || pages.value.length
  return [first, Math.max(first, last)]
}

function onScroll() {
  if (scrollQueued) return
  scrollQueued = true
  const run = () => {
    scrollQueued = false
    if (suppressScrollSync) suppressScrollSync = false
    else pageNumber.value = currentPageFromScroll()
    renderVisible()
  }
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
  else run()
}

function onWheel(event) {
  if (!event.ctrlKey && !event.metaKey) return
  event.preventDefault()
  setZoom(zoom.value - Math.sign(event.deltaY || 0) * 0.1)
}

function renderVisible() {
  if (!pdfDocument) return
  const [first, last] = visibleRange()
  for (let i = Math.max(1, first - 1); i <= Math.min(pageCount.value, last + 1); i++) {
    void renderPage(i)
  }
  for (const index of Array.from(rendered.keys())) {
    if (index < first - 2 || index > last + 2) evict(index)
  }
}

async function renderPage(index) {
  const host = pageEls.get(index)
  if (!pdfDocument || !host) return
  const targetScale = scale.value
  const existing = rendered.get(index)
  if (existing && existing.scale === targetScale) return
  if (existing) evict(index)
  const entry = { scale: targetScale, task: null, textLayer: null }
  rendered.set(index, entry)
  const current = generation
  try {
    const page = await pdfDocument.getPage(index)
    if (current !== generation || rendered.get(index) !== entry) return
    measurePage(index, page)
    const canvas = host.querySelector('canvas')
    if (!canvas) return
    const viewport = page.getViewport({ scale: targetScale })
    let ratio = Math.min(window.devicePixelRatio || 1, 2)
    ratio *= Math.min(1, MAX_CANVAS_DIM / (viewport.width * ratio), MAX_CANVAS_DIM / (viewport.height * ratio))
    canvas.width = Math.floor(viewport.width * ratio)
    canvas.height = Math.floor(viewport.height * ratio)
    entry.task = page.render({
      canvas,
      viewport,
      transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0],
    })
    renderTextLayer(entry, page, host, viewport)
    await entry.task.promise
  } catch (cause) {
    if (cause?.name !== 'RenderingCancelledException') rendered.delete(index)
  }
}

function measurePage(index, page) {
  const record = pages.value[index - 1]
  if (!record || record.measured) return
  const base = page.getViewport({ scale: 1 })
  pages.value[index - 1] = { ...record, width: base.width, height: base.height, measured: true }
}

function renderTextLayer(entry, page, host, viewport) {
  const container = host.querySelector('.pdf-text-layer')
  if (!container || !pdfLib?.TextLayer || typeof page.streamTextContent !== 'function') return
  container.replaceChildren()
  try {
    entry.textLayer = new pdfLib.TextLayer({
      textContentSource: page.streamTextContent(),
      container,
      viewport,
    })
    void entry.textLayer.render().catch(() => {})
  } catch {
    entry.textLayer = null
  }
}

function evict(index) {
  const entry = rendered.get(index)
  if (!entry) return
  rendered.delete(index)
  entry.task?.cancel?.()
  entry.textLayer?.cancel?.()
  const host = pageEls.get(index)
  const canvas = host?.querySelector('canvas')
  if (canvas) {
    canvas.width = 0
    canvas.height = 0
  }
  host?.querySelector('.pdf-text-layer')?.replaceChildren()
}

function clearRendered() {
  for (const index of Array.from(rendered.keys())) evict(index)
}

function setPageEl(index, el) {
  if (el) pageEls.set(index, el)
  else pageEls.delete(index)
}

function goToPage(value) {
  const target = Math.min(Math.max(Math.round(Number(value) || 1), 1), Math.max(pageCount.value, 1))
  pageNumber.value = target
  const el = scroller.value
  if (el) {
    suppressScrollSync = true
    el.scrollTop = Math.max(0, PADDING + pageOffset(target) - 12)
  }
  renderVisible()
}

function onPageInput(event) {
  goToPage(event.target.value)
  event.target.value = String(pageNumber.value)
}

function setZoom(value) {
  zoom.value = Math.min(Math.max(Number(value.toFixed(1)), 0.5), 2.5)
}

onUnmounted(() => {
  generation++
  clearTimeout(resizeTimer)
  resizeObserver?.disconnect()
  clearRendered()
  void documentTask?.destroy?.()
})
</script>

<style>
/* pdf.js TextLayer injects absolutely positioned spans; component CSS because
   the DOM is created outside Vue templates. */
.pdf-text-layer {
  position: absolute;
  inset: 0;
  overflow: hidden;
  line-height: 1;
  transform-origin: 0 0;
  caret-color: transparent;
  user-select: text;
  -webkit-user-select: text;
}

.pdf-text-layer span,
.pdf-text-layer br {
  position: absolute;
  color: transparent;
  white-space: pre;
  cursor: text;
  transform-origin: 0 0;
}

.pdf-text-layer ::selection {
  background: color-mix(in srgb, var(--color-accent) 30%, transparent);
}

.pdf-text-layer .endOfContent {
  display: block;
  position: absolute;
  inset: 100% 0 0;
  z-index: -1;
  cursor: default;
  user-select: none;
  -webkit-user-select: none;
}
</style>
