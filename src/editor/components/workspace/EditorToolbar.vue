<template>
  <div
    ref="toolbarRef"
    data-editor-toolbar
    class="editor-toolbar h-[30px] shrink-0 border-b border-rule-light flex items-center gap-1.5 px-[14px] whitespace-nowrap overflow-hidden"
  >
    <div class="flex shrink-0 gap-0.5 items-center">
      <button class="toolbar-btn" title="Heading 1" :class="isActive('heading-1')" @mousedown.prevent @click="emit('format', 'heading-1')">H1</button>
      <button class="toolbar-btn" title="Heading 2" :class="isActive('heading-2')" @mousedown.prevent @click="emit('format', 'heading-2')">H2</button>
      <button class="toolbar-btn" title="Heading 3" :class="isActive('heading-3')" @mousedown.prevent @click="emit('format', 'heading-3')">H3</button>
      <button class="toolbar-btn font-bold" title="Bold (⇧⌘B)" :class="isActive('bold')" @mousedown.prevent @click="emit('format', 'bold')">B</button>
      <button class="toolbar-btn italic" title="Italic (⌘I)" :class="isActive('italic')" @mousedown.prevent @click="emit('format', 'italic')">I</button>
      <button class="toolbar-btn" title="Strikethrough (⇧⌘X)" style="text-decoration: line-through" :class="isActive('strikethrough')" @mousedown.prevent @click="emit('format', 'strikethrough')">S</button>
    </div>
    <span class="toolbar-sep"></span>
    <div class="flex shrink-0 gap-0.5 items-center">
      <button class="toolbar-btn" title="Bullet List (⇧⌘8)" :class="isActive('bullet-list')" @mousedown.prevent @click="emit('format', 'bullet-list')"><IconList :size="14" /></button>
      <button class="toolbar-btn" title="Numbered List (⇧⌘7)" :class="isActive('numbered-list')" @mousedown.prevent @click="emit('format', 'numbered-list')"><IconListNumbers :size="14" /></button>
      <button class="toolbar-btn" title="Checkbox" :class="isActive('checkbox')" @mousedown.prevent @click="emit('format', 'checkbox')"><IconListCheck :size="14" /></button>
      <button class="toolbar-btn" title="Blockquote (⇧⌘.)" :class="isActive('blockquote')" @mousedown.prevent @click="emit('format', 'blockquote')"><IconQuote :size="14" /></button>
      <button class="toolbar-btn" title="Horizontal Rule" :class="isActive('horizontal-rule')" @mousedown.prevent @click="emit('format', 'horizontal-rule')"><IconLineDashed :size="14" /></button>
      <button class="toolbar-btn" title="Link" :class="isActive('link')" @mousedown.prevent @click="emit('format', 'link')"><IconLink :size="14" /></button>
      <button class="toolbar-btn" title="Image" :class="isActive('image')" @mousedown.prevent @click="emit('format', 'image')"><IconPhoto :size="14" /></button>
      <button class="toolbar-btn" title="Inline Code" :class="isActive('code')" @mousedown.prevent @click="emit('format', 'code')"><IconCode :size="14" /></button>
    </div>
    <span class="toolbar-sep"></span>
    <button
      class="toolbar-btn shrink-0 gap-1 px-2 text-[11px]"
      :class="props.hasSelection ? '' : 'toolbar-disabled'"
      :disabled="!props.hasSelection"
      :aria-disabled="!props.hasSelection"
      data-toolbar-action="comment"
      :title="props.hasSelection ? 'Add Comment (⇧⌘M)' : 'Select text to add a comment'"
      @mousedown.prevent
      @click="onComment"
    >
      <IconMessagePlus :size="13" />
      <span v-show="!compact">Comment</span>
      <span v-if="commentCount" class="font-mono text-[9px] text-accent">{{ commentCount }}</span>
    </button>
    <div class="min-w-2 flex-1"></div>
  </div>
</template>

<script setup>
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { IconList, IconListNumbers, IconListCheck, IconQuote, IconLineDashed, IconLink, IconPhoto, IconCode, IconMessagePlus } from '@tabler/icons-vue'

const props = defineProps({
  activeFormats: { type: Array, default: () => [] },
  hasSelection: { type: Boolean, default: false },
  commentCount: { type: Number, default: 0 },
})

const emit = defineEmits(['format', 'comment'])
const toolbarRef = ref(null)
const compact = ref(false)
let fullContentWidth = 0
let observer = null

function isActive(action) {
  return props.activeFormats.includes(action) ? 'toolbar-active' : ''
}

function onComment() {
  if (!props.hasSelection) return
  emit('comment')
}

function checkOverflow() {
  const toolbar = toolbarRef.value
  if (!toolbar) return
  if (!compact.value && toolbar.scrollWidth > toolbar.clientWidth) {
    fullContentWidth = toolbar.scrollWidth
    compact.value = true
    return
  }
  if (compact.value && toolbar.clientWidth >= fullContentWidth) {
    compact.value = false
    requestAnimationFrame(() => {
      if (toolbar.scrollWidth > toolbar.clientWidth) {
        fullContentWidth = toolbar.scrollWidth
        compact.value = true
      }
    })
  }
}

onMounted(() => {
  if (typeof ResizeObserver === 'undefined') return
  observer = new ResizeObserver(checkOverflow)
  if (toolbarRef.value) observer.observe(toolbarRef.value)
})
onUnmounted(() => observer?.disconnect())
watch(() => props.commentCount, () => nextTick(checkOverflow))
</script>

<style scoped>
.editor-toolbar {
  background: var(--color-chrome-mid);
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}

.editor-toolbar::-webkit-scrollbar {
  display: none;
}

.toolbar-btn {
  height: 22px;
  min-width: 22px;
  padding: 0 6px;
  border: none;
  border-radius: 0;
  background: none;
  font-family: var(--font-sans);
  font-size: 12px;
  font-weight: 400;
  color: var(--color-ink-3);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.toolbar-btn:hover {
  color: var(--color-ink);
  background: var(--color-chrome-high);
  border-radius: 3px;
}
.toolbar-active {
  color: var(--color-accent);
  font-weight: 600;
  background: var(--color-accent-soft);
  border-radius: 3px;
}
.toolbar-disabled {
  opacity: 0.35;
  cursor: default;
}
.toolbar-sep {
  width: 1px;
  align-self: stretch;
  background: var(--color-rule);
  margin: 6px 0;
}

@media (max-width: 640px) {
  .editor-toolbar {
    gap: 6px;
    padding-left: 10px;
    padding-right: 10px;
  }
}

@media (max-width: 430px) {
  .editor-toolbar {
    gap: 4px;
    padding-left: 8px;
    padding-right: 8px;
  }

  .toolbar-btn {
    padding-left: 5px;
    padding-right: 5px;
  }
}
</style>
