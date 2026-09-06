<template>
  <section class="image-preview flex min-h-0 min-w-0 flex-col text-ink" :class="sourceMode ? 'shrink-0' : 'flex-1'">
    <header data-image-toolbar class="pane-bar gap-1 overflow-x-auto">
      <div v-if="isSvg" class="flex shrink-0 items-center gap-0.5" role="group" aria-label="SVG view">
        <button type="button" :aria-pressed="!sourceMode" @click="$emit('sourceMode', false)">Preview</button>
        <button type="button" :aria-pressed="sourceMode" @click="$emit('sourceMode', true)">Source</button>
        <span class="mx-1 h-4 w-px bg-rule" />
      </div>
      <template v-if="!sourceMode">
        <button type="button" title="Fit image (F)" :aria-pressed="fit" :disabled="!ready" @click="fitImage">Fit</button>
        <button type="button" title="Actual size (0)" :aria-pressed="!fit && scale === 1" :disabled="!ready" @click="setScale(1)">100%</button>
        <button type="button" title="Zoom out (−)" aria-label="Zoom out" :disabled="!ready || scale <= minScale" @click="setScale(scale / 1.25)"><IconZoomOut :size="14" /></button>
        <output class="min-w-10 shrink-0 text-center font-mono text-[10px]" aria-label="Image zoom">{{ Math.round(scale * 100) }}%</output>
        <button type="button" title="Zoom in (+)" aria-label="Zoom in" :disabled="!ready || scale >= 16" @click="setScale(scale * 1.25)"><IconZoomIn :size="14" /></button>
      </template>
      <button type="button" data-preview-open-native class="ml-auto" title="Open in default app" aria-label="Open in default app" :disabled="opening" @click="$emit('openNative')">
        <IconExternalLink :size="14" /><span class="image-open-label">Open in default app</span>
      </button>
    </header>
    <p v-if="actionError" role="alert" class="border-b border-rule px-3 py-2 text-[11px] text-rem">{{ actionError }}</p>
    <div
      v-show="!sourceMode"
      ref="viewport"
      class="image-viewport relative min-h-0 flex-1 overflow-hidden bg-chrome outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
      :class="{ 'cursor-grab': ready, 'cursor-grabbing': dragging }"
      tabindex="0"
      role="region"
      :aria-label="`${name} image preview. Use plus and minus to zoom, F to fit, and arrow keys to pan.`"
      @wheel="onWheel"
      @keydown="onKeydown"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="endDrag"
      @pointercancel="endDrag"
      @lostpointercapture="endDrag"
      @gesturestart="onGestureStart"
      @gesturechange="onGestureChange"
      @gestureend.prevent="gestureScale = null"
      @blur="resetInteraction"
    >
      <div v-if="loading && !url" role="status" class="grid h-full place-items-center text-[11px] text-ink-3">Loading image…</div>
      <div v-else-if="error" role="alert" class="grid h-full place-items-center p-6 text-center">
        <div><p class="text-[12px] font-semibold">Image preview unavailable</p><p class="mt-2 text-[11px] text-ink-3">{{ error }}</p></div>
      </div>
      <img
        v-if="url"
        v-show="!error"
        :src="url"
        :alt="name"
        draggable="false"
        class="preview-image absolute max-w-none select-none"
        :style="imageStyle"
      />
      <span v-if="loading && url" role="status" class="absolute bottom-2 left-3 bg-chrome px-1 text-[10px] text-ink-3">Updating image…</span>
    </div>
  </section>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { IconExternalLink, IconZoomIn, IconZoomOut } from '@tabler/icons-vue'
import { readBinaryFile } from '../../../services/fileSystem.js'
import { basename } from '../../../shared/utils/path.js'
import { imageMimeType, isSvgPath } from '../../../shared/utils/filePreview.js'

const props = defineProps({
  file: { type: Object, required: true },
  sourceMode: Boolean,
  opening: Boolean,
  actionError: { type: String, default: '' },
})
const emit = defineEmits(['openNative', 'sourceMode', 'viewChange'])
const viewport = ref(null)
const url = ref('')
const loading = ref(true)
const error = ref('')
const width = ref(0)
const height = ref(0)
const viewportWidth = ref(0)
const viewportHeight = ref(0)
const fit = ref(props.file.previewView?.fit ?? true)
const scale = ref(props.file.previewView?.scale || 1)
const x = ref(props.file.previewView?.x || 0)
const y = ref(props.file.previewView?.y || 0)
const dragging = ref(false)
const isSvg = computed(() => isSvgPath(props.file.path))
const name = computed(() => basename(props.file.path))
const ready = computed(() => Boolean(url.value && !error.value))
const fitScale = computed(() => Math.min(1, Math.max(1, viewportWidth.value - 48) / width.value, Math.max(1, viewportHeight.value - 48) / height.value))
const minScale = computed(() => Math.min(0.05, fitScale.value))
const imageStyle = computed(() => ({
  width: `${width.value * scale.value}px`,
  height: `${height.value * scale.value}px`,
  left: `calc(50% + ${x.value}px)`,
  top: `calc(50% + ${y.value}px)`,
  transform: 'translate(-50%, -50%)',
}))
let generation = 0
let observer
let drag = null
let gestureScale = null
let loadTimer
const pendingUrls = new Set()

watch(() => [props.file.path, props.file.content, props.file.previewRevision], () => {
  clearTimeout(loadTimer)
  const current = ++generation
  // Source typing and atomic file replacements can emit bursts of updates.
  loadTimer = setTimeout(() => { void load(current) }, url.value ? 100 : 0)
}, { immediate: true })
watch(() => props.sourceMode, () => {
  resetInteraction()
  void nextTick(measure)
})

async function load(current) {
  loading.value = true
  error.value = ''
  let nextUrl
  try {
    const data = isSvg.value ? props.file.content : await readBinaryFile(props.file.path, { maxBytes: 64 * 1024 * 1024 })
    if (current !== generation) return
    const blob = new Blob([data], { type: imageMimeType(props.file.path) })
    if (blob.size > 64 * 1024 * 1024) throw new Error('This image is too large to preview. Open it in the default app.')
    nextUrl = URL.createObjectURL(blob)
    pendingUrls.add(nextUrl)
    const img = new Image()
    img.src = nextUrl
    await img.decode()
    if (current !== generation) return
    if (!img.naturalWidth || !img.naturalHeight) throw new Error('The image has no visible size.')
    if (img.naturalWidth * img.naturalHeight > 100_000_000) throw new Error('This image is too large to preview. Open it in the default app.')
    const previousUrl = url.value
    width.value = img.naturalWidth
    height.value = img.naturalHeight
    url.value = nextUrl
    pendingUrls.delete(nextUrl)
    nextUrl = null
    measure()
    await nextTick()
    if (previousUrl) URL.revokeObjectURL(previousUrl)
  } catch (cause) {
    if (current === generation) error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (nextUrl && pendingUrls.delete(nextUrl)) URL.revokeObjectURL(nextUrl)
    if (current === generation) loading.value = false
  }
}

function remember() {
  emit('viewChange', { fit: fit.value, scale: scale.value, x: x.value, y: y.value })
}

function clampPan() {
  const maxX = Math.max(0, (width.value * scale.value - viewportWidth.value) / 2)
  const maxY = Math.max(0, (height.value * scale.value - viewportHeight.value) / 2)
  x.value = Math.max(-maxX, Math.min(maxX, x.value))
  y.value = Math.max(-maxY, Math.min(maxY, y.value))
}

function measure() {
  if (!viewport.value || props.sourceMode) return
  viewportWidth.value = viewport.value.clientWidth
  viewportHeight.value = viewport.value.clientHeight
  if (!width.value || !viewportWidth.value || !viewportHeight.value) return
  if (fit.value) {
    scale.value = fitScale.value
    x.value = 0
    y.value = 0
  } else clampPan()
  remember()
}

function fitImage() {
  fit.value = true
  measure()
}

function setScale(value, clientX, clientY) {
  if (!ready.value || !Number.isFinite(value)) return
  const rect = viewport.value.getBoundingClientRect()
  const anchorX = clientX == null ? 0 : clientX - rect.left - rect.width / 2
  const anchorY = clientY == null ? 0 : clientY - rect.top - rect.height / 2
  const next = Math.max(minScale.value, Math.min(16, value))
  const ratio = next / scale.value
  x.value = anchorX - (anchorX - x.value) * ratio
  y.value = anchorY - (anchorY - y.value) * ratio
  scale.value = next
  fit.value = false
  clampPan()
  remember()
}

function pan(dx, dy) {
  x.value += dx
  y.value += dy
  clampPan()
  remember()
}

function onWheel(event) {
  if (!ready.value) return
  event.preventDefault()
  event.stopPropagation()
  if (gestureScale !== null) return
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewportHeight.value : 1
  if (event.ctrlKey || event.metaKey) setScale(scale.value * Math.exp(-event.deltaY * unit * 0.01), event.clientX, event.clientY)
  else pan(-event.deltaX * unit, -event.deltaY * unit)
}

function onGestureStart(event) {
  event.preventDefault()
  gestureScale = scale.value
}

function onGestureChange(event) {
  event.preventDefault()
  if (gestureScale !== null) setScale(gestureScale * event.scale, event.clientX, event.clientY)
}

function onKeydown(event) {
  if (event.target !== viewport.value || event.isComposing || event.metaKey || event.ctrlKey || event.altKey || !ready.value) return
  const actions = {
    '+': () => setScale(scale.value * 1.25), '=': () => setScale(scale.value * 1.25),
    '-': () => setScale(scale.value / 1.25), '0': () => setScale(1), f: fitImage,
    ArrowLeft: () => pan(40, 0), ArrowRight: () => pan(-40, 0),
    ArrowUp: () => pan(0, 40), ArrowDown: () => pan(0, -40),
  }
  const action = actions[event.key]
  if (!action) return
  event.preventDefault()
  event.stopPropagation()
  action()
}

function onPointerDown(event) {
  if (event.button !== 0 || !ready.value) return
  viewport.value.focus({ preventScroll: true })
  viewport.value.setPointerCapture(event.pointerId)
  drag = { id: event.pointerId, x: event.clientX, y: event.clientY }
  dragging.value = true
  event.preventDefault()
}

function onPointerMove(event) {
  if (!drag || drag.id !== event.pointerId) return
  pan(event.clientX - drag.x, event.clientY - drag.y)
  drag.x = event.clientX
  drag.y = event.clientY
}

function endDrag(event) {
  if (!drag || drag.id !== event.pointerId) return
  drag = null
  dragging.value = false
  if (viewport.value?.hasPointerCapture?.(event.pointerId)) viewport.value.releasePointerCapture(event.pointerId)
}

function resetInteraction() {
  gestureScale = null
  if (drag) endDrag({ pointerId: drag.id })
}

onMounted(() => {
  window.addEventListener('blur', resetInteraction)
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(measure)
    observer.observe(viewport.value)
  }
  measure()
})
onUnmounted(() => {
  window.removeEventListener('blur', resetInteraction)
  resetInteraction()
  generation++
  clearTimeout(loadTimer)
  observer?.disconnect()
  if (url.value) URL.revokeObjectURL(url.value)
  for (const pending of pendingUrls) URL.revokeObjectURL(pending)
  pendingUrls.clear()
})
</script>

<style scoped>
.image-preview { container-type: inline-size; }
.image-preview header button {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-width: 24px;
  height: 26px;
  padding: 0 5px;
  font-size: 11px;
  color: var(--color-ink-3);
  white-space: nowrap;
}
.image-preview header button:hover { background: var(--color-chrome-mid); color: var(--color-ink); }
.image-preview header button[aria-pressed='true'] { background: var(--color-accent-soft); color: var(--color-accent); }
.image-preview header button:focus-visible { outline: 1px solid var(--color-accent); outline-offset: -1px; }
.image-preview header button:disabled { opacity: 0.35; }
.image-viewport { touch-action: none; }
.preview-image {
  background-color: var(--color-surface);
  background-image: conic-gradient(var(--color-rule-light) 25%, transparent 0 50%, var(--color-rule-light) 0 75%, transparent 0);
  background-size: 16px 16px;
  pointer-events: none;
}
@container (max-width: 560px) { .image-open-label { display: none; } }
</style>
