<template>
  <button
    class="rounded border border-rule-light bg-surface hover:bg-chrome-high text-left flex flex-col p-3"
  >
    <span class="font-sans text-[12px] font-medium text-ink line-clamp-2 leading-snug">
      {{ entry.meta.title || '(untitled)' }}
    </span>

    <p
      v-if="excerpt"
      class="font-sans text-[11px] text-ink-2 leading-relaxed line-clamp-3 mt-1.5"
    >{{ excerpt }}</p>

    <span class="font-mono text-[10px] text-ink-3 mt-auto pt-2">{{ shortDate }}</span>
  </button>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  entry: { type: Object, required: true },
})

const excerpt = computed(() => {
  const body = (props.entry.body || '').trim()
  if (!body) return ''
  return body.replace(/^#+\s+/gm, '').slice(0, 200)
})

const shortDate = computed(() => {
  const d = props.entry.meta.updated || props.entry.meta.created
  if (!d) return ''
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
})
</script>
