<template>
  <div
    data-graph-markdown-preview
    class="markdown-preview"
    :class="{ 'markdown-preview-compact': compact }"
  >
    <template v-if="blocks.length">
      <component
        v-for="(block, index) in visibleBlocks"
        :is="tagFor(block)"
        :key="`${index}:${block.type}`"
        :class="`markdown-${block.type}`"
      >
        <code v-if="block.type === 'code'">{{ block.text }}</code>
        <template v-else>{{ block.text }}</template>
      </component>
      <p v-if="hiddenBlocks" class="markdown-more">+{{ hiddenBlocks }} more lines</p>
    </template>
    <p v-else class="markdown-empty">{{ emptyText }}</p>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  value: { type: String, default: '' },
  compact: { type: Boolean, default: false },
  maxBlocks: { type: Number, default: 0 },
  emptyText: { type: String, default: 'No working note yet.' },
})

const blocks = computed(() => parseBlocks(props.value))
const visibleBlocks = computed(() => (
  props.maxBlocks > 0 ? blocks.value.slice(0, props.maxBlocks) : blocks.value
))
const hiddenBlocks = computed(() => Math.max(0, blocks.value.length - visibleBlocks.value.length))

function parseBlocks(value) {
  const lines = String(value || '').replaceAll('\r\n', '\n').split('\n')
  const result = []
  let paragraph = []
  let code = []
  let inCode = false
  const flushParagraph = () => {
    if (!paragraph.length) return
    result.push({ type: 'paragraph', text: paragraph.join(' ').trim() })
    paragraph = []
  }
  const flushCode = () => {
    result.push({ type: 'code', text: code.join('\n') })
    code = []
  }
  for (const line of lines) {
    if (/^```/.test(line)) {
      flushParagraph()
      if (inCode) flushCode()
      inCode = !inCode
      continue
    }
    if (inCode) {
      code.push(line)
      continue
    }
    if (!line.trim()) {
      flushParagraph()
      continue
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line)
    if (heading) {
      flushParagraph()
      result.push({ type: `heading${heading[1].length}`, text: heading[2] })
      continue
    }
    const quote = /^>\s?(.*)$/.exec(line)
    if (quote) {
      flushParagraph()
      result.push({ type: 'quote', text: quote[1] })
      continue
    }
    const list = /^\s*[-*+]\s+(.+)$/.exec(line)
    if (list) {
      flushParagraph()
      result.push({ type: 'list', text: list[1] })
      continue
    }
    paragraph.push(line.trim())
  }
  flushParagraph()
  if (inCode && code.length) flushCode()
  return result.filter(block => block.text)
}

function tagFor(block) {
  return {
    heading1: 'h2',
    heading2: 'h3',
    heading3: 'h4',
    quote: 'blockquote',
    list: 'li',
    code: 'pre',
  }[block.type] || 'p'
}
</script>

<style scoped>
.markdown-preview {
  color: var(--color-ink-2);
  font-size: 12px;
  line-height: 1.68;
}

.markdown-preview > * + * {
  margin-top: 10px;
}

.markdown-heading1,
.markdown-heading2,
.markdown-heading3 {
  color: var(--color-ink);
  font-weight: 660;
  letter-spacing: -0.015em;
}

.markdown-heading1 {
  font-size: 17px;
}

.markdown-heading2 {
  font-size: 15px;
}

.markdown-heading3 {
  font-size: 13px;
}

.markdown-quote {
  border-block: 1px solid var(--color-rule-light);
  background: var(--color-chrome-high);
  padding: 8px 10px;
  color: var(--color-ink-3);
}

.markdown-list {
  position: relative;
  list-style: none;
  padding-left: 15px;
}

.markdown-list::before {
  position: absolute;
  top: 0.72em;
  left: 1px;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--color-accent);
  content: "";
}

.markdown-code {
  overflow-x: auto;
  border-radius: 6px;
  background: var(--color-chrome-high);
  padding: 10px 12px;
  color: var(--code, var(--color-ink-2));
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 1.55;
  white-space: pre-wrap;
}

.markdown-empty,
.markdown-more {
  color: var(--color-ink-4);
}

.markdown-empty {
  font-style: italic;
}

.markdown-more {
  font-family: var(--font-mono);
  font-size: 9px;
}

.markdown-preview-compact {
  font-size: 11px;
  line-height: 1.58;
}

.markdown-preview-compact > * + * {
  margin-top: 7px;
}

.markdown-preview-compact .markdown-heading1 {
  font-size: 14px;
}

.markdown-preview-compact .markdown-heading2 {
  font-size: 13px;
}

.markdown-preview-compact .markdown-heading3 {
  font-size: 12px;
}
</style>
