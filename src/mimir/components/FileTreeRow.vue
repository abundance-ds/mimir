<template>
  <div
    :data-file-row="entry.path"
    :data-file-depth="row.depth"
    :data-file-drop-target="dropTarget ? '' : undefined"
    role="treeitem"
    :aria-level="row.depth + 1"
    :aria-expanded="entry.isDirectory ? String(row.expanded) : undefined"
    :aria-selected="selected"
    class="group relative flex min-w-max items-center"
    :class="[
      row.secondary ? 'h-9' : 'h-7',
      selected ? 'bg-accent-soft text-ink' : 'text-ink-2 hover:bg-chrome-high',
      dropTarget ? 'bg-accent-soft ring-1 ring-inset ring-accent' : '',
    ]"
    @contextmenu.prevent="$emit('context', row, $event)"
  >
    <span
      v-for="guide in row.depth"
      :key="guide"
      aria-hidden="true"
      class="pointer-events-none absolute inset-y-0 w-px bg-rule-light"
      :style="{ left: `${10 + (guide - 1) * 17}px` }"
    />
    <span
      v-if="ancestry"
      aria-hidden="true"
      class="pointer-events-none absolute inset-y-0 w-px bg-accent/55"
      :style="{ left: `${10 + Math.max(row.depth - 1, 0) * 17}px` }"
    />

    <form
      v-if="editing"
      class="flex h-full min-w-0 flex-1 items-center"
      :style="{ paddingLeft: `${7 + row.depth * 17}px` }"
      @submit.prevent="$emit('commit-edit')"
    >
      <span class="grid size-5 shrink-0 place-items-center text-ink-3">
        <IconFolderPlus v-if="editKind === 'folder'" :size="14" :stroke-width="1.7" />
        <IconFilePlus v-else :size="14" :stroke-width="1.7" />
      </span>
      <input
        data-files-inline-name
        :value="editDraft"
        :placeholder="editKind === 'folder' ? 'folder-name' : 'file-name.md'"
        class="mr-2 h-6 min-w-28 flex-1 border border-accent bg-surface px-1.5 font-mono text-[12px] text-ink outline-none"
        autocomplete="off"
        spellcheck="false"
        @input="$emit('update:editDraft', $event.target.value)"
        @keydown.esc.prevent="$emit('cancel-edit')"
        @blur="$emit('commit-edit')"
      />
    </form>

    <button
      v-else
      type="button"
      class="flex h-full min-w-0 flex-1 items-center pr-12 text-left outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
      :style="{ paddingLeft: `${4 + row.depth * 17}px` }"
      :title="entry.relativePath || entry.name"
      @click="select"
      @dblclick.prevent="activate"
    >
      <span class="grid size-5 shrink-0 place-items-center text-ink-4">
        <IconLoader2
          v-if="row.loading"
          :size="12"
          :stroke-width="1.8"
          class="motion-safe:animate-spin"
        />
        <IconChevronDown
          v-else-if="entry.isDirectory && row.expanded"
          :size="12"
          :stroke-width="2"
        />
        <IconChevronRight
          v-else-if="entry.isDirectory"
          :size="12"
          :stroke-width="2"
        />
      </span>
      <component
        :is="entryIcon"
        :size="15"
        :stroke-width="1.65"
        class="mr-1.5 shrink-0"
        :class="iconClass"
      />
      <span class="min-w-0 flex-1">
        <span
          class="block truncate text-[12px]"
          :class="[
            entry.isDirectory ? 'font-medium' : '',
            active ? 'font-semibold text-ink' : '',
          ]"
        >
          {{ entry.name }}
        </span>
        <span
          v-if="row.secondary"
          class="block truncate font-mono text-[9px] leading-3 text-ink-4"
        >
          {{ secondaryPath }}
        </span>
      </span>
      <span
        v-if="row.missing"
        class="ml-2 shrink-0 font-mono text-[9px] uppercase tracking-[0.08em] text-rem"
      >
        Missing
      </span>
      <span
        v-else-if="row.gitStatus"
        class="ml-2 shrink-0 font-mono text-[9px] font-semibold uppercase"
        :class="gitClass"
      >
        {{ gitMark }}
      </span>
    </button>

    <button
      v-if="!editing"
      type="button"
      data-file-favorite
      :aria-label="favorite ? `Remove ${entry.name} from Favorites` : `Add ${entry.name} to Favorites`"
      :title="favorite ? 'Remove from Favorites' : 'Add to Favorites'"
      class="absolute right-1 grid size-6 place-items-center outline-none focus-visible:ring-1 focus-visible:ring-accent"
      :class="favorite ? 'text-accent' : 'text-ink-4 opacity-0 hover:text-ink group-hover:opacity-100 focus-visible:opacity-100'"
      @click.stop="$emit('favorite', row)"
    >
      <IconStarFilled v-if="favorite" :size="12" />
      <IconStar v-else :size="13" :stroke-width="1.7" />
    </button>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import {
  IconBraces,
  IconChevronDown,
  IconChevronRight,
  IconCode,
  IconFile,
  IconFileCode,
  IconFilePlus,
  IconFileText,
  IconFileTypePdf,
  IconFolder,
  IconFolderPlus,
  IconJson,
  IconLoader2,
  IconMarkdown,
  IconPhoto,
  IconStar,
  IconStarFilled,
} from '@tabler/icons-vue'

const props = defineProps({
  row: { type: Object, required: true },
  selected: { type: Boolean, default: false },
  active: { type: Boolean, default: false },
  ancestry: { type: Boolean, default: false },
  favorite: { type: Boolean, default: false },
  dropTarget: { type: Boolean, default: false },
  editing: { type: Boolean, default: false },
  editKind: { type: String, default: 'file' },
  editDraft: { type: String, default: '' },
})

const emit = defineEmits([
  'select',
  'activate',
  'toggle',
  'favorite',
  'context',
  'commit-edit',
  'cancel-edit',
  'update:editDraft',
])

const entry = computed(() => props.row.entry)
const extension = computed(() => (
  String(entry.value.name || '').split('.').at(-1)?.toLowerCase() || ''
))
const entryIcon = computed(() => {
  if (entry.value.isDirectory) return IconFolder
  if (entry.value.openBehavior === 'pdf' || extension.value === 'pdf') return IconFileTypePdf
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(extension.value)) return IconPhoto
  if (['md', 'markdown', 'mdown', 'mkd'].includes(extension.value)) return IconMarkdown
  if (['json', 'jsonc'].includes(extension.value)) return IconJson
  if (['js', 'jsx', 'ts', 'tsx', 'vue', 'rs', 'py', 'go', 'java', 'c', 'cpp'].includes(extension.value)) return IconFileCode
  if (['css', 'scss', 'html', 'xml', 'yaml', 'yml', 'toml', 'sql'].includes(extension.value)) return IconCode
  if (entry.value.textReadable !== false) return IconFileText
  if (['lock', 'map'].includes(extension.value)) return IconBraces
  return IconFile
})
const iconClass = computed(() => {
  if (entry.value.isDirectory) return props.row.expanded ? 'text-accent' : 'text-ink-3'
  if (entry.value.openBehavior === 'pdf' || extension.value === 'pdf') return 'text-rem'
  return props.active ? 'text-accent' : 'text-ink-3'
})
const secondaryPath = computed(() => {
  const value = String(entry.value.relativePath || '')
  const index = value.lastIndexOf('/')
  return index < 0 ? 'workspace' : value.slice(0, index)
})
const gitMark = computed(() => ({
  new: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
}[props.row.gitStatus] || ''))
const gitClass = computed(() => ({
  new: 'text-add',
  modified: 'text-accent',
  deleted: 'text-rem',
  renamed: 'text-ink-3',
}[props.row.gitStatus] || 'text-ink-3'))

function select(event) {
  if (entry.value.isDirectory) emit('toggle', props.row)
  else emit('select', event)
}

function activate() {
  if (entry.value.isDirectory) emit('toggle', props.row)
  else emit('activate', props.row)
}
</script>
