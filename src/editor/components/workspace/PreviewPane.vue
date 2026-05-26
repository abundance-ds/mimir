<template>
  <div
    ref="rootEl"
    class="preview-content flex-1 min-w-0 py-8 px-9 bg-surface overflow-y-auto overflow-x-hidden font-sans text-ink preview-scroll"
    v-html="content"
  ></div>
</template>

<script setup>
import { ref } from 'vue'

defineProps({
  content: { type: String, default: '' },
})

const rootEl = ref(null)
defineExpose({ rootEl })
</script>

<style scoped>
.preview-scroll::-webkit-scrollbar { width: 4px; }
.preview-scroll::-webkit-scrollbar-thumb { background: var(--color-rule); border-radius: 2px; }
</style>
