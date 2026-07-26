<template>
  <section class="flex h-full min-h-0 flex-col bg-chrome-high text-ink">
    <header class="flex h-10 shrink-0 items-center gap-1 border-b border-rule bg-chrome-high px-2">
      <button
        type="button"
        title="Previous page"
        aria-label="Previous page"
        :disabled="pageNumber <= 1 || loading"
        class="grid size-7 place-items-center text-ink-3 hover:bg-chrome hover:text-ink disabled:opacity-30"
        @click="pageNumber--"
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
          class="w-7 bg-transparent text-right text-ink outline-none"
          @change="setPage($event.target.value)"
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
        @click="pageNumber++"
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
      class="min-h-0 flex-1 overflow-auto bg-chrome p-6"
      @keydown.left.prevent="pageNumber = Math.max(1, pageNumber - 1)"
      @keydown.right.prevent="pageNumber = Math.min(pageCount, pageNumber + 1)"
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
      <div v-else class="mx-auto flex min-h-full w-max items-start justify-center">
        <canvas
          ref="canvas"
          class="bg-white shadow-[0_10px_35px_rgba(0,0,0,0.16)]"
          :aria-label="`PDF page ${pageNumber} of ${pageCount}`"
        />
      </div>
    </div>
  </section>
</template>

<script setup>
import { nextTick, onUnmounted, ref, watch } from 'vue'
import {
  IconAlertTriangle,
  IconChevronLeft,
  IconChevronRight,
  IconExternalLink,
  IconLoader2,
  IconZoomIn,
  IconZoomOut,
} from '@tabler/icons-vue'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { readBinaryFile } from '../../../services/fileSystem.js'

const props = defineProps({
  path: { type: String, required: true },
})

defineEmits(['openNative'])

const scroller = ref(null)
const canvas = ref(null)
const loading = ref(true)
const error = ref('')
const pageNumber = ref(1)
const pageCount = ref(0)
const zoom = ref(1)
let documentTask = null
let pdfDocument = null
let renderTask = null
let generation = 0

watch(() => props.path, load, { immediate: true })
watch([pageNumber, zoom], () => {
  if (pdfDocument) void renderPage()
})

async function load() {
  const current = ++generation
  loading.value = true
  error.value = ''
  pageNumber.value = 1
  pageCount.value = 0
  renderTask?.cancel?.()
  await documentTask?.destroy?.()
  documentTask = null
  pdfDocument = null
  try {
    const [{ getDocument, GlobalWorkerOptions }, bytes] = await Promise.all([
      import('pdfjs-dist'),
      readBinaryFile(props.path),
    ])
    if (current !== generation) return
    GlobalWorkerOptions.workerSrc = workerUrl
    documentTask = getDocument({ data: bytes })
    pdfDocument = await documentTask.promise
    if (current !== generation) return
    pageCount.value = pdfDocument.numPages
    loading.value = false
    await nextTick()
    await renderPage()
  } catch (cause) {
    if (current !== generation) return
    error.value = cause instanceof Error ? cause.message : String(cause || 'The PDF could not be rendered.')
  } finally {
    if (current === generation) loading.value = false
  }
}

async function renderPage() {
  if (!pdfDocument || !canvas.value || !scroller.value) return
  const current = generation
  renderTask?.cancel?.()
  const page = await pdfDocument.getPage(pageNumber.value)
  if (current !== generation) return
  const base = page.getViewport({ scale: 1 })
  const availableWidth = Math.max(scroller.value.clientWidth - 48, 240)
  const fitScale = Math.min(1.6, availableWidth / base.width)
  const viewport = page.getViewport({ scale: fitScale * zoom.value })
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
  const target = canvas.value
  target.width = Math.floor(viewport.width * pixelRatio)
  target.height = Math.floor(viewport.height * pixelRatio)
  target.style.width = `${Math.floor(viewport.width)}px`
  target.style.height = `${Math.floor(viewport.height)}px`
  renderTask = page.render({
    canvas: target,
    viewport,
    transform: pixelRatio === 1 ? null : [pixelRatio, 0, 0, pixelRatio, 0, 0],
  })
  try {
    await renderTask.promise
  } catch (cause) {
    if (cause?.name !== 'RenderingCancelledException') throw cause
  }
}

function setPage(value) {
  const page = Math.round(Number(value) || 1)
  pageNumber.value = Math.min(Math.max(page, 1), Math.max(pageCount.value, 1))
}

function setZoom(value) {
  zoom.value = Math.min(Math.max(Number(value.toFixed(1)), 0.5), 2.5)
}

onUnmounted(() => {
  generation++
  renderTask?.cancel?.()
  void documentTask?.destroy?.()
})
</script>
