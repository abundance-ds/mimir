<template>
  <ImagePreview
    v-if="imageMimeType(file.path)"
    :file="file"
    :source-mode="sourceMode"
    :action-error="actionError"
    :opening="opening"
    @open-native="openNative"
    @source-mode="$emit('sourceMode', $event)"
    @view-change="$emit('viewChange', $event)"
  />
  <PdfPreview
    v-else-if="file?.kind === 'pdf'"
    :path="file.path"
    :revision="file.previewRevision || 0"
    :action-error="actionError"
    @open-native="openNative"
  />

  <section
    v-else
    data-external-file-preview
    class="grid h-full min-h-0 w-full min-w-0 flex-1 place-items-center overflow-auto bg-surface px-8 py-12 text-ink"
  >
    <div class="w-full max-w-md">
      <div class="flex items-start gap-4">
        <span class="grid size-12 shrink-0 place-items-center border border-rule bg-chrome-high text-ink-3">
          <IconFileUnknown :size="24" :stroke-width="1.4" />
        </span>
        <div class="min-w-0 pt-0.5">
          <h1 class="truncate text-[16px] font-semibold">{{ name }}</h1>
          <p class="mt-1 font-mono text-[9px] uppercase tracking-[0.09em] text-ink-4">
            {{ fileType }} · {{ sizeLabel }}
          </p>
        </div>
      </div>

      <p class="mt-8 text-[11px] leading-relaxed text-ink-2">
        Mimir does not edit this file type yet. Open it with its default application, or manage the file from this workspace.
      </p>

      <div class="mt-5 flex flex-wrap gap-2">
        <button
          type="button"
          data-preview-open-native
          class="flex h-8 items-center gap-2 bg-accent px-3 text-[10px] font-semibold text-accent-ink hover:opacity-90"
          @click="openNative"
        >
          <IconExternalLink :size="14" :stroke-width="1.8" />
          Open in default app
        </button>
        <button
          type="button"
          data-preview-reveal
          class="flex h-8 items-center gap-2 border border-rule px-3 text-[10px] font-medium text-ink-2 hover:bg-chrome"
          @click="reveal"
        >
          <IconFolderSymlink :size="14" :stroke-width="1.8" />
          Reveal in file manager
        </button>
      </div>
      <p v-if="actionError" role="alert" class="mt-3 text-[10px] leading-relaxed text-rem">
        {{ actionError }}
      </p>

      <dl class="mt-8 border-t border-rule-light pt-4 text-[10px]">
        <div class="grid grid-cols-[72px_minmax(0,1fr)] gap-3 py-1.5">
          <dt class="text-ink-4">Path</dt>
          <dd class="break-all font-mono text-ink-2">{{ file.path }}</dd>
        </div>
        <div v-if="modifiedLabel" class="grid grid-cols-[72px_minmax(0,1fr)] gap-3 py-1.5">
          <dt class="text-ink-4">Modified</dt>
          <dd class="text-ink-2">{{ modifiedLabel }}</dd>
        </div>
      </dl>
    </div>
  </section>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import {
  IconExternalLink,
  IconFileUnknown,
  IconFolderSymlink,
} from '@tabler/icons-vue'
import PdfPreview from './PdfPreview.vue'
import ImagePreview from './ImagePreview.vue'
import { imageMimeType } from '../../../shared/utils/filePreview.js'
import { openPreviewInDefaultApp } from '../../../services/fileSystem.js'
import {
  openWorkspaceEntryNative,
  revealWorkspaceEntry,
} from '../../../services/workspaceFileOperations.js'
import { basename } from '../../../shared/utils/path.js'

const props = defineProps({
  file: { type: Object, required: true },
  sourceMode: Boolean,
  prepareOpen: { type: Function, default: async () => {} },
})

const emit = defineEmits(['sourceMode', 'viewChange', 'refresh'])
const refreshOnFocus = () => emit('refresh')
onMounted(() => window.addEventListener('focus', refreshOnFocus))
onUnmounted(() => window.removeEventListener('focus', refreshOnFocus))
const actionError = ref('')
const opening = ref(false)
const name = computed(() => basename(props.file?.path))
const extension = computed(() => name.value.split('.').at(-1)?.toUpperCase() || 'FILE')
const fileType = computed(() => props.file?.kind === 'pdf' ? 'PDF document' : `${extension.value} file`)
const sizeLabel = computed(() => formatBytes(props.file?.meta?.size))
const modifiedLabel = computed(() => {
  const value = Number(props.file?.meta?.mtime || 0)
  return value ? new Date(value).toLocaleString() : ''
})

async function openNative() {
  if (opening.value) return
  const file = props.file
  const path = file.path
  const open = imageMimeType(path) || file.kind === 'pdf' ? openPreviewInDefaultApp : openWorkspaceEntryNative
  opening.value = true
  await run(async () => {
    await props.prepareOpen(file)
    await open(path)
  }, 'The default application could not open this file.')
  opening.value = false
}

async function reveal() {
  await run(() => revealWorkspaceEntry(props.file.path), 'The file could not be revealed.')
}

async function run(action, fallback) {
  actionError.value = ''
  try {
    await action()
  } catch (cause) {
    actionError.value = cause instanceof Error ? cause.message : String(cause || fallback)
  }
}

function formatBytes(value) {
  const bytes = Number(value || 0)
  if (!bytes) return 'Unknown size'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}
</script>
